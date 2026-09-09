// src/routes/suiteCentralControlPlane.ts
//
// HTTP surface for the SuiteCentral control plane (PR-A6), mounted on two
// namespaces from one factory:
//
//   /api/suitecentral/prod                      — accessMode 'tenant_admin'
//   /api/admin/tenants/:tenantId/suitecentral   — accessMode 'platform_admin'
//
// plus a separate platform-global allowlist router at
// /api/admin/suitecentral/allowed-hosts.
//
// One factory rather than two files because the namespaces differ in exactly
// one thing — where the target tenant comes from — and duplicating ~26 handlers
// to vary that would let the two drift.
//
// This module is the TRUST BOUNDARY. The service and repository beneath it
// accept typed inputs and do not re-check them at runtime: `createEnvironment`
// hands `input.name` straight to an INSERT. So every request body is narrowed
// here, field by field, and anything unrecognized is dropped rather than
// forwarded — an unparsed body reaching the service is an unvalidated row.
//
// Mount AFTER authMiddleware and the matching verifiedAdmin guard. The tenant
// and actor are read ONLY from verified claims (`req.user`) and the mount path;
// no header, query, or body may name either.

import { Router, type NextFunction, type Request, type Response } from 'express';
import { domainToASCII } from 'url';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { asyncHandler } from '../middleware/asyncHandler';
import { uuidv4 } from '../utils/uuid';
import { logger } from '../utils/Logger';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import {
  INVALID_CORRELATION_ID,
  safeCorrelationId,
} from '../services/suitecentral/controlPlane/correlation';
import {
  SuiteCentralControlPlaneError,
  SuiteCentralValidationError,
  stableErrorCode,
} from '../services/suitecentral/controlPlane/errors';
import type { SuiteCentralControlPlaneService } from '../services/suitecentral/controlPlane/SuiteCentralControlPlaneService';
import type {
  CreateAllowedHostInput,
  CreateEnvironmentInput,
  CreateTemplateInput,
  SuiteCentralAccessMode,
  SuiteCentralControlPlaneContext,
  SuiteCentralEnvironmentTier,
  UpdateEnvironmentPatch,
  UpsertMonitoringInput,
} from '../services/suitecentral/controlPlane/domain';

/** The resolved correlation id, stashed so the context and the error body agree. */
interface CorrelatedRequest extends Request {
  suiteCentralCorrelationId?: string;
}

const ENVIRONMENT_TIERS = new Set<SuiteCentralEnvironmentTier>(['sandbox', 'production']);
const MAX_HEALTH_HISTORY_LIMIT = 500;
/**
 * Records accepted by one bulk import.
 *
 * Larger than the default array bound because this endpoint exists for volume,
 * but bounded all the same: the batch is forwarded upstream, so "as many as fit
 * in 10mb" is a contract with the body parser, not with the caller. A bigger job
 * is more calls, each with its own audit row and its own operationId.
 */
const MAX_BULK_IMPORT_RECORDS = 1000;

// ── Input narrowing ─────────────────────────────────────────────────────────
//
// Every helper throws SuiteCentralValidationError, which the router's error
// middleware maps to 400. Messages name the FIELD but never echo the VALUE: a
// rejected credential body would otherwise reflect the client secret back in
// the error, and validation errors are logged.

type JsonObject = Record<string, unknown>;

function bodyObject(value: unknown): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new SuiteCentralValidationError('invalid_body', 'Request body must be a JSON object.');
  }
  return value as JsonObject;
}

function has(object: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Reject a value that is padded with whitespace — for KEYS only.
 *
 * A key is a value this system compares exactly: `name` and `hostname` have
 * unique indexes on the raw value, so `'Prod'` and `'Prod '` are two
 * environments an operator cannot tell apart and the 409 conflict never fires;
 * `sourceSystem` is filtered with `where source_system = ?`, so `' NetSuite '`
 * answers "no templates". For those, padding is a defect with a demonstrable
 * failure, and refusing beats trimming — trimming stores something the caller
 * did not send, which is the accept-and-transform this layer exists to refuse.
 *
 * It does NOT apply to values that are not ours to judge. A provider-issued
 * `clientId`/`clientSecret` is opaque bytes forwarded verbatim to the upstream
 * API, and no provider contract forbids surrounding whitespace: rejecting one is
 * the same overreach as trimming it, just louder — it makes a credential the
 * operator legitimately holds impossible to store. Free prose (`description`,
 * `justification`) has no lookup and no ambiguity, so padding there is content,
 * not a defect. Clients may normalize their own input; this page does.
 *
 * The rule, then, is not "no whitespace anywhere". It is: we refuse to guess
 * about values we match on, and we refuse to edit values we merely carry.
 */
function rejectPadded(value: string, key: string): string {
  if (value !== value.trim()) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      `${key} must not have leading or trailing whitespace.`,
    );
  }
  return value;
}

/**
 * @param carried - true for values this system only carries (provider
 *   credentials, free prose): blank is still refused, but surrounding
 *   whitespace is preserved byte-for-byte rather than judged.
 */
function requireString(object: JsonObject, key: string, max = 512, carried = false): string {
  // Own properties only, like every other reader here: a required field
  // satisfied via the prototype chain would let a body that never carried
  // `name` or `clientSecret` as its own key pass the trust boundary anyway.
  const value = has(object, key) ? object[key] : undefined;
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a non-empty string.`);
  }
  if (value.length > max) {
    throw new SuiteCentralValidationError('invalid_field', `${key} exceeds ${max} characters.`);
  }
  return carried ? value : rejectPadded(value, key);
}

/**
 * An optional string, or an explicit `null` for a field whose type is nullable.
 *
 * Blank is rejected either way: `companyId: '   '` was persisted and then handed
 * verbatim to `connector.initialize()`, where it becomes an auth failure nobody
 * can trace back to a form. "None" already has a spelling here — omit the key,
 * or send `null`.
 *
 * @param carried - see requireString: preserves surrounding whitespace on values
 *   this system only carries.
 */
function optionalString(object: JsonObject, key: string, max = 512, carried = false): string | null | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      `${key} must be a non-empty string of at most ${max} characters, or null.`,
    );
  }
  return carried ? value : rejectPadded(value, key);
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'boolean') {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a boolean.`);
  }
  return value;
}

function requireBoolean(object: JsonObject, key: string): boolean {
  const value = optionalBoolean(object, key);
  if (value === undefined) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a boolean.`);
  }
  return value;
}

/** A safe integer within bounds. Rejects floats, NaN, and out-of-range values. */
function optionalInteger(object: JsonObject, key: string, min: number, max: number): number | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

/** A JSON object, or an explicit `null` for a field whose type permits clearing. */
function optionalJsonObject(object: JsonObject, key: string): Record<string, unknown> | null | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a JSON object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * A JSON object for a field whose type is NOT nullable.
 *
 * Rejects an explicit `null` rather than folding it to "absent". Coalescing it
 * would silently persist `{}` for a caller who asked for something else — the
 * quiet accept-and-transform this layer exists to refuse. Omitting the key is
 * still fine; that genuinely means "unset".
 */
function optionalJsonObjectNotNull(object: JsonObject, key: string): Record<string, unknown> | undefined {
  const value = optionalJsonObject(object, key);
  if (value === null) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a JSON object; null is not accepted.`);
  }
  return value;
}

/**
 * A bounded array.
 *
 * The count bound is the array equivalent of every string's `max` here: without
 * it, `targetEntities` with 1,001 entries is serialized straight into a durable
 * template row, and a bulk import forwards an unbounded batch upstream. The
 * global `express.json({ limit: '10mb' })` is an aggregate body bound, not a
 * per-field one, so it permits exactly that.
 */
function optionalArray(object: JsonObject, key: string, maxItems = 100): unknown[] | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (!Array.isArray(value)) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be an array.`);
  }
  if (value.length > maxItems) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must contain at most ${maxItems} entries.`);
  }
  return value;
}

/**
 * An array of non-blank, bounded strings.
 *
 * Blank entries are rejected for the same reason blank query ids are: an empty
 * or whitespace-only entry is not a value the caller meant, and nothing below
 * re-checks it. `events: ['']` reached `setupWebhook` and registered a
 * meaningless subscription against the upstream API; `scopes: ['  ']` was
 * persisted onto a credential profile.
 *
 * The bounds close the matching hole: every other string on this surface is
 * capped (`name` 200, `clientId` 512, `hostname` 253), but array entries were
 * not, so `scopes: ['x'.repeat(9_000_000)]` was persisted and the equivalent
 * `events` forwarded upstream. The global `express.json({ limit: '10mb' })` is
 * an aggregate body bound, not a per-field one.
 */
function optionalStringArray(
  object: JsonObject,
  key: string,
  maxItems = 100,
  maxLength = 256,
): string[] | undefined {
  const value = optionalArray(object, key, maxItems);
  if (value === undefined) return undefined;
  const usable = (item: unknown): item is string =>
    typeof item === 'string' && item.trim().length > 0 && item.length <= maxLength && item === item.trim();
  if (!value.every(usable)) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      `${key} must be an array of non-empty, unpadded strings of at most ${maxLength} characters.`,
    );
  }
  return value;
}

function requireStringArray(object: JsonObject, key: string): string[] {
  const value = optionalStringArray(object, key);
  if (value === undefined || value.length === 0) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be a non-empty array of strings.`);
  }
  return value;
}

function environmentTier(object: JsonObject, key: string): SuiteCentralEnvironmentTier | undefined {
  if (!has(object, key)) return undefined;
  const value = object[key];
  if (typeof value !== 'string' || !ENVIRONMENT_TIERS.has(value as SuiteCentralEnvironmentTier)) {
    throw new SuiteCentralValidationError('invalid_field', `${key} must be one of: sandbox, production.`);
  }
  return value as SuiteCentralEnvironmentTier;
}

/**
 * A single query parameter as a string.
 *
 * Express types `req.query` values as `string | string[] | ParsedQs | ...`. A
 * repeated parameter (`?limit=1&limit=2`) arrives as an array; treating that as
 * a scalar is how a validated value becomes `'1,2'` further down. Arrays and
 * nested objects are rejected outright.
 */
function queryScalar(req: Request, key: string): string | undefined {
  const value = req.query[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new SuiteCentralValidationError('invalid_query', `${key} must be supplied at most once.`);
  }
  return value;
}

/**
 * An optional filter value from the query string.
 *
 * Absent means "no filter". An empty or whitespace-only value is neither: it is
 * a malformed filter, and the two ways of tolerating it are both wrong.
 * Forwarding it filters on the empty string, and `listTemplates` applies
 * `where source_system = ''` for any value that is not `undefined` — so
 * `?sourceSystem=` answers "this tenant has no templates" when the truth is
 * "your filter was junk". Coalescing it to absent silently widens the request
 * instead, returning everything for a caller that asked for one thing. Both
 * hand back a confident answer to a question that was never asked, which is the
 * failure this whole surface is built to refuse — so it is a 400.
 */
function optionalFilterQuery(req: Request, key: string): string | undefined {
  const value = queryScalar(req, key);
  if (value === undefined) return undefined;
  if (value.trim().length === 0) {
    throw new SuiteCentralValidationError('invalid_query', `${key} must be a non-empty value when supplied.`);
  }
  // A padded filter is the same lie as a blank one, one step along:
  // `?sourceSystem=%20NetSuite%20` filters on the literal `' NetSuite '`, which
  // the exact `where source_system = ?` never matches, so a real tenant with
  // real templates is told it has none.
  if (value !== value.trim()) {
    throw new SuiteCentralValidationError(
      'invalid_query',
      `${key} must not have leading or trailing whitespace.`,
    );
  }
  return value;
}

/**
 * The `(environmentId, credentialProfileId)` pair from the query string.
 *
 * The GET/DELETE connector routes have no body to carry the pair, so it rides
 * the query — but the truthiness test they used (`!environmentId`) only catches
 * the empty string. A whitespace-only `?environmentId=%20%20` is truthy, so it
 * passed the guard and reached the service as a real id, which is the class of
 * thing this layer exists to stop: the service does not re-check it, and these
 * routes drive outbound calls. Blank is missing, not a value — same rule as
 * `requireString` applies to bodies.
 */
function connectorTargetQuery(req: Request): { environmentId: string; credentialProfileId: string } {
  const environmentId = optionalFilterQuery(req, 'environmentId');
  const credentialProfileId = optionalFilterQuery(req, 'credentialProfileId');
  if (environmentId === undefined || credentialProfileId === undefined) {
    throw new SuiteCentralValidationError(
      'invalid_query',
      'environmentId and credentialProfileId are required.',
    );
  }
  return { environmentId, credentialProfileId };
}

/**
 * A path segment that is about to be sent upstream verbatim.
 *
 * Express will not route an empty segment, but it happily routes `%20%20`, and
 * these two ids are pasted straight into an outbound URL rather than looked up
 * in a tenant-scoped table first. A blank one therefore spends a real
 * authenticated request on a URL that cannot mean anything —
 * `GET /api/v1/bulk/operations/  ` — and reports the upstream 404 back as a
 * successful empty answer.
 *
 * Only these two need it: every other path id (`:profileId`, `:templateId`,
 * `:alertId`, `:hostId`, `:environmentId`) resolves through an exact,
 * tenant-scoped lookup that fails closed with a 404, and `:tenantId` is trimmed
 * and sentinel-checked in buildContext.
 */
function upstreamPathId(req: Request, key: string): string {
  const value = req.params[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value !== value.trim()) {
    throw new SuiteCentralValidationError('invalid_path', `${key} must be a non-empty, unpadded value.`);
  }
  return value;
}

/** A positive integer from a query string — strict, so `1.5`, `1e3`, and `0` all fail. */
function positiveIntegerQuery(req: Request, key: string, max: number): number | undefined {
  const raw = queryScalar(req, key);
  if (raw === undefined) return undefined;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new SuiteCentralValidationError('invalid_query', `${key} must be a positive integer.`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed > max) {
    throw new SuiteCentralValidationError('invalid_query', `${key} must be a positive integer of at most ${max}.`);
  }
  return parsed;
}

function requirePositiveIntegerQuery(req: Request, key: string, max: number): number {
  const value = positiveIntegerQuery(req, key, max);
  if (value === undefined) {
    throw new SuiteCentralValidationError('invalid_query', `${key} is required.`);
  }
  return value;
}

/**
 * Reject a `decrypt` query on credential reads.
 *
 * Secrets are write-only: no read path can return one, whatever the query says.
 * A silent ignore would let a client believe it had asked for plaintext and
 * received a complete answer, so the incompatibility is explicit.
 */
function rejectDecryptQuery(req: Request): void {
  if (has(req.query as JsonObject, 'decrypt')) {
    throw new SuiteCentralValidationError(
      'decrypt_not_supported',
      'Credential secrets are write-only and can never be read back.',
    );
  }
}

/**
 * Reject an inline `authConfig` on connector bodies.
 *
 * The legacy router accepted credentials inline on every connector call, which
 * is the bypass this redesign exists to close: credentials must come from a
 * stored profile resolved through SecretManager. Own-property only — an
 * inherited `authConfig` (e.g. via a `__proto__` key in JSON) is not something
 * the caller can read back out of the parsed body either.
 */
function rejectInlineAuthConfig(body: JsonObject): void {
  if (has(body, 'authConfig')) {
    throw new SuiteCentralValidationError(
      'inline_auth_config_not_supported',
      'Inline authConfig is not accepted; reference a stored credentialProfileId instead.',
    );
  }
}

/** The `(environmentId, credentialProfileId)` pair every connector operation needs. */
function connectorTarget(body: JsonObject): { environmentId: string; credentialProfileId: string } {
  rejectInlineAuthConfig(body);
  return {
    environmentId: requireString(body, 'environmentId'),
    credentialProfileId: requireString(body, 'credentialProfileId'),
  };
}

// ── Per-route body parsers ──────────────────────────────────────────────────
//
// Each returns ONLY the fields its input type declares. Unknown keys are
// dropped, which is what stops `{ tenantId: 'other' }` in a body from reaching
// a layer that might read it.

function parseCreateEnvironment(raw: unknown): CreateEnvironmentInput {
  const body = bodyObject(raw);
  return {
    name: requireString(body, 'name', 200),
    baseUrl: requireString(body, 'baseUrl', 2048),
    ...pick('environmentTier', environmentTier(body, 'environmentTier')),
    ...pick('apiVersion', optionalString(body, 'apiVersion', 64)),
    ...pick('timeoutMs', optionalInteger(body, 'timeoutMs', 1, 600_000)),
    ...pick('retryAttempts', optionalInteger(body, 'retryAttempts', 0, 10)),
    ...pick('rateLimitConfig', optionalJsonObject(body, 'rateLimitConfig')),
    ...pick('securityConfig', optionalJsonObject(body, 'securityConfig')),
    ...pick('featureConfig', optionalJsonObject(body, 'featureConfig')),
  };
}

function parseUpdateEnvironment(raw: unknown): { expectedVersion: number; patch: UpdateEnvironmentPatch } {
  const body = bodyObject(raw);
  const expectedVersion = optionalInteger(body, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === undefined) {
    throw new SuiteCentralValidationError('invalid_field', 'expectedVersion must be a positive integer.');
  }
  const patch: UpdateEnvironmentPatch = {
    ...pick('name', has(body, 'name') ? requireString(body, 'name', 200) : undefined),
    ...pick('baseUrl', has(body, 'baseUrl') ? requireString(body, 'baseUrl', 2048) : undefined),
    ...pick('environmentTier', environmentTier(body, 'environmentTier')),
    ...pick('apiVersion', optionalString(body, 'apiVersion', 64)),
    ...pick('timeoutMs', optionalInteger(body, 'timeoutMs', 1, 600_000)),
    ...pick('retryAttempts', optionalInteger(body, 'retryAttempts', 0, 10)),
    ...pick('rateLimitConfig', optionalJsonObject(body, 'rateLimitConfig')),
    ...pick('securityConfig', optionalJsonObject(body, 'securityConfig')),
    ...pick('featureConfig', optionalJsonObject(body, 'featureConfig')),
  };
  return { expectedVersion, patch };
}

function parseCreateTemplate(raw: unknown): CreateTemplateInput {
  const body = bodyObject(raw);
  return {
    name: requireString(body, 'name', 200),
    sourceSystem: requireString(body, 'sourceSystem', 100),
    // Free prose: no lookup, no ambiguity, so padding is content, not a defect.
    ...pick('description', optionalString(body, 'description', 2000, true)),
    ...pick('targetEntities', optionalArray(body, 'targetEntities')),
    // Not nullable in CreateTemplateInput (unlike `description`), so an explicit
    // null is a 400 rather than a silent `{}`.
    ...pick('fieldMappings', optionalJsonObjectNotNull(body, 'fieldMappings')),
    ...pick('businessRules', optionalArray(body, 'businessRules')),
    ...pick('syncSettings', optionalJsonObjectNotNull(body, 'syncSettings')),
  };
}

function parseUpsertMonitoring(raw: unknown): { input: UpsertMonitoringInput; expectedVersion: number } {
  const body = bodyObject(raw);
  // Floor is 0, not 1: `upsertMonitoringConfig` uses 0 to mean "create" and a
  // positive version to mean "compare-and-swap this row". Rejecting 0 here made
  // the create case unreachable, so monitoring could never be enabled for an
  // environment that had no config row — the first write is the only one that
  // matters and it was the one that could not happen. Every other
  // expectedVersion in this API guards an existing row, so those stay >= 1.
  const expectedVersion = optionalInteger(body, 'expectedVersion', 0, Number.MAX_SAFE_INTEGER);
  if (expectedVersion === undefined) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      'expectedVersion must be an integer (0 to create, or the current version to update).',
    );
  }
  return {
    expectedVersion,
    input: {
      enabled: requireBoolean(body, 'enabled'),
      ...pick('intervalMs', optionalInteger(body, 'intervalMs', 1, Number.MAX_SAFE_INTEGER)),
      ...pick('thresholds', optionalJsonObject(body, 'thresholds')),
    },
  };
}

/**
 * The allowlist hostname, in exactly the form the outbound check will look up.
 *
 * `SuiteCentralOutboundPolicy.validateBaseUrl` canonicalizes a destination with
 * `domainToASCII(url.hostname).toLowerCase()` and then matches the allowlist
 * EXACTLY. Storing what the admin typed therefore produces a row that reads
 * `active` in the UI and can never authorize anything: `EXAMPLE.COM` never
 * equals `example.com`, and a Unicode host never equals its punycode. The admin
 * sees an allowed host; the connector sees a blocked one, and nothing says why.
 *
 * So the same canonicalization runs here, and the stored value is what comes
 * back in the response — the admin sees the host as it will actually be
 * matched. This is not the accept-and-transform the rest of this file refuses:
 * a canonical hostname is the same host, whereas a trimmed name is a different
 * string. Anything that is not a bare host — a scheme, port, path, or userinfo —
 * is rejected rather than salvaged, because guessing which part was meant is how
 * an allowlist entry ends up authorizing something nobody asked for.
 */
function allowedHostname(body: JsonObject): string {
  const supplied = requireString(body, 'hostname', 253);
  if (/[/:@?#\\]/.test(supplied)) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      'hostname must be a bare host, without a scheme, port, path, or credentials.',
    );
  }
  // `domainToASCII` is a canonicalizer, not a validator, and it silently
  // REPAIRS: it percent-decodes, so `%65xample.com` becomes example.com, and it
  // drops characters that are invisible — not only ASCII controls but Unicode
  // FORMAT characters, so a hostname that reads `foobar.com` with a zero-width
  // space hidden inside it canonicalizes to the real foobar.com. That is an
  // entry which survives review by looking like a host the reviewer trusts. On
  // an allowlist the input has to be recognizable as what it authorizes, so
  // these are refused BEFORE canonicalization rather than fixed up by it.
  //
  // Unicode categories rather than an ASCII range, because that is where the
  // boundary actually is: \p{Cc} control, \p{Cf} format (U+200B, U+200D,
  // U+FEFF, soft hyphen…), \p{Z} any separator.
  //
  // \p{Cf} also catches ZWNJ/ZWJ (U+200C/U+200D), which UTS #46 permits in
  // limited contextual Arabic/Indic labels — a DELIBERATE restriction, not an
  // oversight. Two labels that render identically but differ by an invisible
  // joiner are two different punycode hosts, and an allowlist entry whose
  // identity turns on a character no reviewer can see cannot be reviewed. The
  // host is not blocked: its already-canonical punycode (`xn--…`) spelling is
  // plain ASCII, passes this guard, and canonicalizes to itself.
  if (/%/.test(supplied) || /[\p{Cc}\p{Cf}\p{Z}]/u.test(supplied)) {
    throw new SuiteCentralValidationError(
      'invalid_field',
      'hostname must not contain percent-encoding, spaces, or control or invisible characters.',
    );
  }
  const canonical = domainToASCII(supplied).toLowerCase();
  if (canonical.length === 0) {
    throw new SuiteCentralValidationError('invalid_field', 'hostname is not a valid domain name.');
  }
  if (canonical.length > 253) {
    throw new SuiteCentralValidationError('invalid_field', 'hostname exceeds 253 characters once encoded.');
  }
  // Labels are validated after canonicalization, against the punycode that will
  // actually be matched. `foo..bar.com`, an overlong label, and a label with a
  // leading or trailing hyphen (`-example.com`) all survive domainToASCII
  // untouched, so an allowlist row can otherwise name something DNS will never
  // resolve — an entry that reads active and is inert.
  const labels = canonical.replace(/\.$/, '').split('.');
  if (labels.some((label) => label.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new SuiteCentralValidationError('invalid_field', 'hostname must be a valid dotted domain name.');
  }
  return canonical;
}

function parseCreateAllowedHost(raw: unknown): CreateAllowedHostInput {
  const body = bodyObject(raw);
  const ports = optionalArray(body, 'allowedPorts');
  if (ports !== undefined) {
    // An explicit `[]` is rejected rather than folded to "absent". The
    // repository reads an empty list as "use the default", so `[]` — which any
    // caller would read as "no ports at all" — silently BROADENS the allowlist
    // to 443. Same refusal as optionalJsonObjectNotNull makes for an explicit
    // null, and it matters more here: this list is what an egress check
    // consults. Omit the field to get the default.
    if (ports.length === 0) {
      throw new SuiteCentralValidationError(
        'invalid_field',
        'allowedPorts must not be empty; omit it to accept the default of 443.',
      );
    }
    if (!ports.every((p) => typeof p === 'number' && Number.isSafeInteger(p) && p >= 1 && p <= 65535)) {
      throw new SuiteCentralValidationError('invalid_field', 'allowedPorts must be an array of integers between 1 and 65535.');
    }
  }
  return {
    hostname: allowedHostname(body),
    ...pick('allowedPorts', ports as number[] | undefined),
    // Free prose, like `description`.
    ...pick('justification', optionalString(body, 'justification', 2000, true)),
  };
}

/**
 * Spread-in a key only when the value was supplied.
 *
 * `{ ...pick('x', undefined) }` yields `{}`, so an absent optional field stays
 * absent instead of becoming an explicit `undefined` — which matters because
 * `has(patch, 'baseUrl')` decides whether the service re-validates a
 * destination, and `{ baseUrl: undefined }` would answer yes.
 */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ── Request context ─────────────────────────────────────────────────────────

interface VerifiedClaims {
  id?: string | number;
  tenantId?: unknown;
}

/**
 * The verified actor id, or `''` when none is usable.
 *
 * Trimmed for the same reason the tenant claim is: an unusable actor that
 * reached the service would be written to `audit_logs.user_id`, attributing a
 * real mutation to nobody. The guard rejects one first, but this is the trust
 * boundary and does not defer that check to its caller.
 */
function actorUserId(req: Request): string {
  const raw = (req.user as VerifiedClaims | undefined)?.id;
  return typeof raw === 'string' ? raw.trim() : typeof raw === 'number' ? String(raw) : '';
}

/**
 * The correlation id for this request: the caller's if it looks like a
 * generated handle, otherwise a fresh one.
 *
 * Resolved once per request and stashed, so the id in an error body is the same
 * id that went to the service and onto the audit row. Recomputing it per read
 * would mint a second uuid and hand the client a trace handle matching nothing.
 */
function resolveCorrelationId(req: Request): string {
  const supplied = (req as Request & { correlationId?: string }).correlationId ?? req.get('x-correlation-id');
  const safe = safeCorrelationId(supplied);
  return safe === INVALID_CORRELATION_ID ? uuidv4() : safe;
}

function correlationIdOf(req: Request): string {
  return (req as CorrelatedRequest).suiteCentralCorrelationId ?? INVALID_CORRELATION_ID;
}

/**
 * Build the service context for a request.
 *
 * The two access modes differ here and nowhere else:
 *   - tenant_admin  → target is the caller's own verified `tenantId` claim.
 *   - platform_admin → target is the `:tenantId` mount parameter.
 *
 * Neither reads a header, a query, or a body. A missing actor or tenant claim
 * on the tenant path is a 500, not a 401: `requireSuiteCentralTenantAdmin` has
 * already proved both are present, so their absence here is a wiring defect and
 * must not be reported as an authentication problem.
 */
function buildContext(req: Request, accessMode: SuiteCentralAccessMode): SuiteCentralControlPlaneContext {
  const actor = actorUserId(req);
  if (actor.length === 0) throw new RouterWiringError('actor_unidentified');

  let targetTenantId: string;
  if (accessMode === 'tenant_admin') {
    const claim = (req.user as VerifiedClaims | undefined)?.tenantId;
    targetTenantId = typeof claim === 'string' ? claim.trim() : '';
    // The sentinel is rejected on BOTH paths. `requireSuiteCentralTenantAdmin`
    // already refuses it, so reaching here with it means the router was mounted
    // without its guard — which is exactly the case a trust boundary exists to
    // survive. A 500 rather than a 400 for the same reason a missing claim is:
    // the guard proved this cannot happen, so it is a wiring defect, not input.
    if (targetTenantId.length === 0 || targetTenantId === SYSTEM_IDENTITY.tenantId) {
      throw new RouterWiringError('tenant_unidentified');
    }
  } else {
    // Caller-supplied here (a path segment), so this one IS input: 400, and it
    // is NOT normalized. Trimming it silently pointed
    // `/api/admin/tenants/%20tenant-a%20/suitecentral` at tenant-a — this
    // module's own rule against accept-and-transform, broken in the one place
    // where the value being quietly rewritten decides WHOSE data is served. The
    // verified claim above is trimmed instead, and the difference is the point:
    // that one is a token this system signed, so padding there is our issuance
    // bug to normalize, not a caller's ambiguity to resolve.
    targetTenantId = typeof req.params.tenantId === 'string' ? req.params.tenantId : '';
    if (targetTenantId.trim().length === 0) {
      throw new SuiteCentralValidationError('invalid_tenant', 'A target tenant is required.');
    }
    if (targetTenantId !== targetTenantId.trim()) {
      throw new SuiteCentralValidationError(
        'invalid_tenant',
        'The target tenant must not have leading or trailing whitespace.',
      );
    }
    if (targetTenantId === SYSTEM_IDENTITY.tenantId) {
      throw new SuiteCentralValidationError('invalid_tenant', 'The system identity is not an administrable tenant.');
    }
  }

  return { actorUserId: actor, targetTenantId, accessMode, correlationId: correlationIdOf(req) };
}

/**
 * The platform-global context used by the allowlist router.
 *
 * The allowlist is not tenant-scoped, so its audit rows are attributed to the
 * system tenant. Using the acting admin's own `tenantId` claim instead would
 * write rows implying a tenant-scoped change that never happened, and would
 * surface a global act in one tenant's audit view but no other's.
 */
function buildPlatformContext(req: Request): SuiteCentralControlPlaneContext {
  const actor = actorUserId(req);
  if (actor.length === 0) throw new RouterWiringError('actor_unidentified');
  return {
    actorUserId: actor,
    targetTenantId: SYSTEM_IDENTITY.tenantId,
    accessMode: 'platform_admin',
    correlationId: correlationIdOf(req),
  };
}

/**
 * A guard proved something that turns out not to hold — a mount-order defect,
 * never a caller's doing. Separate from the domain errors so it maps to 500
 * and cannot be mistaken for input validation.
 */
class RouterWiringError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'RouterWiringError';
  }
}

// ── Error mapping ───────────────────────────────────────────────────────────

/**
 * Map thrown values to responses. Domain errors carry a stable code and a
 * message authored in this repo, so both are safe to surface. Everything else
 * collapses to a bare 500: an unmodelled error is third-party text that can
 * quote the request that produced it — including a client secret — and can name
 * internal hosts and addresses.
 */
function errorMiddleware(error: unknown, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) {
    next(error);
    return;
  }
  const correlationId = correlationIdOf(req);

  if (error instanceof SuiteCentralControlPlaneError) {
    res.status(error.status).json({ error: error.code, message: error.message, correlationId });
    return;
  }

  logger.error('SuiteCentral control-plane route failed', {
    correlationId,
    code: error instanceof RouterWiringError ? error.code : stableErrorCode(error, 'internal_error'),
  });
  res.status(500).json({
    error: error instanceof RouterWiringError ? error.code : 'internal_error',
    message: 'The request could not be completed.',
    correlationId,
  });
}

// ── Routers ─────────────────────────────────────────────────────────────────

async function resolveService(injected?: SuiteCentralControlPlaneService): Promise<SuiteCentralControlPlaneService> {
  return injected ?? container.getAsync<SuiteCentralControlPlaneService>(TYPES.SuiteCentralControlPlaneService);
}

/** Resolve the correlation id once, before any handler builds a context. */
const stampCorrelationId = (req: Request, _res: Response, next: NextFunction): void => {
  (req as CorrelatedRequest).suiteCentralCorrelationId = resolveCorrelationId(req);
  next();
};

/**
 * The tenant-scoped control-plane router, shared by both namespaces.
 *
 * `mergeParams` is required: the platform mount carries `:tenantId` in the
 * parent path, and without it `req.params.tenantId` is undefined and every
 * platform request fails closed.
 */
export async function createSuiteCentralControlPlaneRouter(options: {
  accessMode: SuiteCentralAccessMode;
  service?: SuiteCentralControlPlaneService;
}): Promise<Router> {
  const service = await resolveService(options.service);
  const { accessMode } = options;
  const router = Router({ mergeParams: true });
  const ctx = (req: Request) => buildContext(req, accessMode);

  router.use(stampCorrelationId);

  // ── Environments ──────────────────────────────────────────────────────────

  router.get('/environments', asyncHandler(async (req, res) => {
    res.json(await service.listEnvironments(ctx(req)));
  }));

  router.post('/environments', asyncHandler(async (req, res) => {
    const input = parseCreateEnvironment(req.body);
    res.status(201).json(await service.createEnvironment(ctx(req), input));
  }));

  router.get('/environments/:environmentId', asyncHandler(async (req, res) => {
    res.json(await service.getEnvironment(ctx(req), req.params.environmentId));
  }));

  router.put('/environments/:environmentId', asyncHandler(async (req, res) => {
    const { expectedVersion, patch } = parseUpdateEnvironment(req.body);
    res.json(await service.updateEnvironment(ctx(req), req.params.environmentId, expectedVersion, patch));
  }));

  router.get('/environments/:environmentId/credentials', asyncHandler(async (req, res) => {
    rejectDecryptQuery(req);
    res.json(await service.listCredentials(ctx(req), req.params.environmentId));
  }));

  // ── Credentials (secrets are write-only) ──────────────────────────────────

  router.post('/credentials', asyncHandler(async (req, res) => {
    const body = bodyObject(req.body);
    const input = {
      environmentId: requireString(body, 'environmentId'),
      name: requireString(body, 'name', 200),
      // Provider-issued, forwarded verbatim upstream: carried, not judged.
      clientId: requireString(body, 'clientId', 512, true),
      clientSecret: requireString(body, 'clientSecret', 4096, true),
      ...pick('companyId', optionalString(body, 'companyId', 128, true)),
      ...pick('scopes', optionalStringArray(body, 'scopes')),
    };
    res.status(201).json(await service.createCredential(ctx(req), input));
  }));

  router.get('/credentials/:profileId', asyncHandler(async (req, res) => {
    rejectDecryptQuery(req);
    res.json(await service.getCredential(ctx(req), req.params.profileId));
  }));

  router.post('/credentials/:profileId/rotate', asyncHandler(async (req, res) => {
    const body = bodyObject(req.body);
    const expectedVersion = optionalInteger(body, 'expectedVersion', 1, Number.MAX_SAFE_INTEGER);
    if (expectedVersion === undefined) {
      throw new SuiteCentralValidationError('invalid_field', 'expectedVersion must be a positive integer.');
    }
    const clientSecret = requireString(body, 'clientSecret', 4096, true);
    res.json(await service.rotateCredential(ctx(req), req.params.profileId, expectedVersion, clientSecret));
  }));

  // expectedVersion rides the query here: DELETE bodies are not reliably sent
  // by intermediaries, and this is a compare-and-swap — losing it silently would
  // turn a guarded delete into an unguarded one.
  router.delete('/credentials/:profileId', asyncHandler(async (req, res) => {
    const expectedVersion = requirePositiveIntegerQuery(req, 'expectedVersion', Number.MAX_SAFE_INTEGER);
    await service.deleteCredential(ctx(req), req.params.profileId, expectedVersion);
    res.status(204).end();
  }));

  // ── Templates ─────────────────────────────────────────────────────────────

  router.get('/templates', asyncHandler(async (req, res) => {
    res.json(await service.listTemplates(ctx(req), optionalFilterQuery(req, 'sourceSystem')));
  }));

  router.post('/templates', asyncHandler(async (req, res) => {
    const input = parseCreateTemplate(req.body);
    res.status(201).json(await service.createTemplate(ctx(req), input));
  }));

  router.get('/templates/:templateId', asyncHandler(async (req, res) => {
    res.json(await service.getTemplate(ctx(req), req.params.templateId));
  }));

  // ── Monitoring ────────────────────────────────────────────────────────────

  router.get('/monitoring/config/:environmentId', asyncHandler(async (req, res) => {
    res.json(await service.getMonitoringConfig(ctx(req), req.params.environmentId));
  }));

  router.put('/monitoring/config/:environmentId', asyncHandler(async (req, res) => {
    const { input, expectedVersion } = parseUpsertMonitoring(req.body);
    res.json(await service.setMonitoringConfig(ctx(req), req.params.environmentId, input, expectedVersion));
  }));

  // Answers from the monitoring runtime's stored samples. The legacy route ran a
  // live outbound probe on every GET, which made an unauthenticated-cost read
  // into authenticated egress: each refresh spent a real upstream request, and a
  // loop of GETs was a free amplifier. Probing is the monitoring runtime's job,
  // on its own interval and with its own audit trail.
  router.get('/monitoring/health/:environmentId', asyncHandler(async (req, res) => {
    const samples = await service.getHealthHistory(ctx(req), req.params.environmentId, 1);
    res.json(samples[0] ?? null);
  }));

  router.get('/monitoring/health/:environmentId/history', asyncHandler(async (req, res) => {
    const limit = positiveIntegerQuery(req, 'limit', MAX_HEALTH_HISTORY_LIMIT);
    res.json(await service.getHealthHistory(ctx(req), req.params.environmentId, limit));
  }));

  // Same rule as /templates, and the mirror-image bug: `getAlerts` tests the id
  // for truthiness, so an empty `?environmentId=` skipped the ownership check
  // and answered with EVERY environment's alerts — the opposite of what the
  // caller asked for, rather than the empty answer /templates gave.
  router.get('/monitoring/alerts', asyncHandler(async (req, res) => {
    res.json(await service.getAlerts(ctx(req), optionalFilterQuery(req, 'environmentId')));
  }));

  router.post('/monitoring/alerts/:alertId/resolve', asyncHandler(async (req, res) => {
    await service.resolveAlert(ctx(req), req.params.alertId);
    res.json({ success: true });
  }));

  router.get('/monitoring/usage/:environmentId', asyncHandler(async (req, res) => {
    res.json(await service.getPerformance(ctx(req), req.params.environmentId));
  }));

  router.get('/monitoring/dashboard/:environmentId', asyncHandler(async (req, res) => {
    res.json(await service.getDashboard(ctx(req), req.params.environmentId));
  }));

  router.post('/monitoring/:environmentId/start', asyncHandler(async (req, res) => {
    await service.startMonitoring(ctx(req), req.params.environmentId);
    res.json({ success: true });
  }));

  router.post('/monitoring/:environmentId/stop', asyncHandler(async (req, res) => {
    await service.stopMonitoring(ctx(req), req.params.environmentId);
    res.json({ success: true });
  }));

  // ── Connector operations (all cross governance in the service) ────────────

  router.post('/connector/test-connection', asyncHandler(async (req, res) => {
    const { environmentId, credentialProfileId } = connectorTarget(bodyObject(req.body));
    res.json(await service.testConnection(ctx(req), environmentId, credentialProfileId));
  }));

  router.post('/connector/bulk-import', asyncHandler(async (req, res) => {
    const body = bodyObject(req.body);
    const { environmentId, credentialProfileId } = connectorTarget(body);
    const entityType = requireString(body, 'entityType', 100);
    const records = optionalArray(body, 'records', MAX_BULK_IMPORT_RECORDS);
    if (records === undefined || records.length === 0) {
      throw new SuiteCentralValidationError('invalid_field', 'records must be a non-empty array.');
    }
    if (!records.every((r) => typeof r === 'object' && r !== null && !Array.isArray(r))) {
      throw new SuiteCentralValidationError('invalid_field', 'records must be an array of JSON objects.');
    }
    const operationId = await service.bulkImport(
      ctx(req),
      environmentId,
      credentialProfileId,
      entityType,
      records as Record<string, unknown>[],
    );
    res.status(202).json({ operationId });
  }));

  // The connector target rides the query: this is a GET, so there is no body to
  // carry the environment/credential pair the operation must be resolved under.
  router.get('/connector/bulk-operations/:operationId', asyncHandler(async (req, res) => {
    const { environmentId, credentialProfileId } = connectorTargetQuery(req);
    const operationId = upstreamPathId(req, 'operationId');
    res.json(await service.getBulkOperation(ctx(req), environmentId, credentialProfileId, operationId));
  }));

  router.post('/connector/webhooks', asyncHandler(async (req, res) => {
    const body = bodyObject(req.body);
    const { environmentId, credentialProfileId } = connectorTarget(body);
    const targetUrl = requireString(body, 'targetUrl', 2048);
    const events = requireStringArray(body, 'events');
    const webhookId = await service.createWebhook(ctx(req), environmentId, credentialProfileId, targetUrl, events);
    res.status(201).json({ webhookId });
  }));

  router.delete('/connector/webhooks/:webhookId', asyncHandler(async (req, res) => {
    const { environmentId, credentialProfileId } = connectorTargetQuery(req);
    const webhookId = upstreamPathId(req, 'webhookId');
    const removed = await service.deleteWebhook(ctx(req), environmentId, credentialProfileId, webhookId);
    res.json({ removed });
  }));

  // ── System ────────────────────────────────────────────────────────────────

  router.get('/system/health-report', asyncHandler(async (req, res) => {
    res.json(await service.getHealthReport(ctx(req)));
  }));

  router.get('/system/info', asyncHandler(async (req, res) => {
    const { environmentId, credentialProfileId } = connectorTargetQuery(req);
    res.json(await service.getSystemInfo(ctx(req), environmentId, credentialProfileId));
  }));

  router.get('/performance/:environmentId', asyncHandler(async (req, res) => {
    res.json(await service.getPerformance(ctx(req), req.params.environmentId));
  }));

  router.use(errorMiddleware);
  return router;
}

/**
 * The platform-global allowed-host registry.
 *
 * Separate from the tenant router because it is not tenant-scoped at all: there
 * is no `:tenantId` to accept and none is read. Mount behind
 * `authMiddleware` + `requirePlatformAdmin`; the service re-checks the access
 * mode, so authorization does not depend on the mount alone.
 */
export async function createSuiteCentralAllowedHostsRouter(options: {
  service?: SuiteCentralControlPlaneService;
} = {}): Promise<Router> {
  const service = await resolveService(options.service);
  const router = Router();

  router.use(stampCorrelationId);

  router.get('/', asyncHandler(async (req, res) => {
    res.json(await service.listAllowedHosts(buildPlatformContext(req)));
  }));

  router.post('/', asyncHandler(async (req, res) => {
    const input = parseCreateAllowedHost(req.body);
    res.status(201).json(await service.createAllowedHost(buildPlatformContext(req), input));
  }));

  router.post('/:hostId/revoke', asyncHandler(async (req, res) => {
    res.json(await service.revokeAllowedHost(buildPlatformContext(req), req.params.hostId));
  }));

  router.use(errorMiddleware);
  return router;
}
