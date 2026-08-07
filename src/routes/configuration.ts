import { Router } from 'express';
import type { RequestHandler, Response } from 'express';
import type { z } from 'zod';
import type { ConfigurationService } from '../services/ConfigurationService';
import type { Logger } from '../utils/Logger';
import { asyncHandler } from '../middleware/asyncHandler';
import { createSerializedAssetReadinessRateLimit } from '../middleware/rateLimit';
import { NotFoundError } from '../errors/NotFoundError';
import { ServiceUnavailableAppError } from '../errors/AppError';
import { requireTenantId, requireConfigurationCommandContext } from './tenantGuard';
import type {
  CardinalityAuthorizationInput,
  CardinalityPlanInput,
  CardinalityPreflight,
  ConfigurationCommandContext,
} from '../types/cardinality';
import {
  CardinalityPreflightRequestSchema,
  CardinalitySaveEnvelopeSchema,
} from '../schemas/cardinalityTransportSchemas';
import { validateSampleSafety } from '../services/cardinality/sampleSafety';
import { sanitizeCardinalityReport } from '../errors/CardinalityViolationError';
import type { SerializedAssetReadinessEvaluator } from '../services/serializedAsset/SerializedAssetReadinessService';
import { SerializedAssetActivationBlockedError } from '../services/serializedAsset/SerializedAssetActivationGuard';
import { toExternalIntegrationConfig } from '../services/configurationRedaction';
import type { IntegrationConfig } from '../types';
import { getSystemType } from '../connectors/connectorIdentity';

type CreateConfigRouterOpts = {
  configurationService: ConfigurationService;
  /**
   * The trusted preflight coordinator (Task 5). Optional at the type level so
   * legacy single-argument call sites keep compiling, but the preflight route
   * fails CLOSED with 503 when it is absent — a missing gate is never silently
   * treated as "nothing to check".
   */
  cardinalityPreflight?: CardinalityPreflight;
  /**
   * Live activation-readiness evaluator for the `netsuite_serialized_asset`
   * execution profile (Task 6). Optional at the type level so legacy
   * single-argument call sites keep compiling, but the readiness route fails
   * CLOSED with 503 when it is absent — an unwired evaluator is never treated
   * as "nothing to check". The production composition root
   * (`createProductionConfigurationRouter` in `src/middleware/setup/RouteSetup.ts`)
   * always supplies it.
   */
  serializedAssetReadiness?: SerializedAssetReadinessEvaluator;
  logger?: Logger;
};

/**
 * ONE bounded-sample gate shared by the preflight route and the `_cardinality`
 * save envelope, so the two sample-bearing surfaces can never drift (design
 * "Preflight API" request limits).
 *
 * Responds and returns `false` when the payload is unsafe:
 *   - `413 payload_too_large` for the size limits (UTF-8 byte cap, row cap);
 *   - `400 invalid_samples` for every structural limit (depth, field count,
 *     non-JSON values, prototype-pollution keys, credential-like keys).
 *
 * The response body carries only the violation code and a row/field PATH —
 * never a sample value.
 */
function enforceSampleSafety(res: Response, samples: unknown): boolean {
  const safety = validateSampleSafety(samples);
  if (safety.ok) return true;
  const oversize = safety.violations.some(
    (violation) => violation.code === 'payload_too_large' || violation.code === 'too_many_rows',
  );
  res.status(oversize ? 413 : 400).json({
    error: oversize ? 'payload_too_large' : 'invalid_samples',
    violations: safety.violations,
  });
  return false;
}

/**
 * True only for a plain JSON object. Arrays, `null`, strings, and numbers all
 * fail — `Object.keys([])` is empty, so a keys-only "no extra fields" check
 * silently accepts an array body.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Zod failure → `400 invalid_request` carrying issue paths/messages only. */
function respondInvalidRequest(res: Response, error: z.ZodError): void {
  res.status(400).json({
    error: 'invalid_request',
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/**
 * Removes the transport-only `_cardinality` envelope from an incoming
 * configuration body and returns it as the server-side authorization input.
 *
 * The delete happens FIRST and unconditionally: the canonical configuration
 * schema declares `_cardinality: z.never()`, so a body that still carries it
 * would be rejected by validation/persistence rather than silently stripped.
 * The envelope is transport, never canonical configuration (non-negotiable #2).
 *
 * Returns `undefined` after responding when the envelope is unsafe or invalid;
 * callers MUST `return` immediately in that case.
 */
function takeCardinalityEnvelope(
  res: Response,
  body: Record<string, unknown>,
): { authorization?: CardinalityAuthorizationInput } | undefined {
  const raw = body._cardinality;
  delete body._cardinality;
  if (raw === undefined) return {};

  const rawSamples = (raw as { samples?: unknown } | null)?.samples;
  if (!enforceSampleSafety(res, rawSamples)) return undefined;

  const parsed = CardinalitySaveEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    respondInvalidRequest(res, parsed.error);
    return undefined;
  }
  if (parsed.data.override === undefined && parsed.data.samples === undefined) {
    return {};
  }
  return { authorization: parsed.data };
}

/**
 * The route handlers historically interacted with `ConfigurationService` via
 * `as any`, which masked two facts:
 *   1. Tests inject a mock that exposes additional methods that are not on
 *      `ConfigurationService` (`duplicateConfiguration`, `getConfigurationHistory`).
 *   2. Several call sites pass arguments / read return shapes that do not match
 *      the concrete service signatures (e.g. `validateConfiguration(id)` rather
 *      than `validateConfiguration(config)`, `saveConfiguration` returning a
 *      saved record rather than `void`).
 *
 * Pattern 5 of the routes-recipe makes the loose contract explicit so the
 * casts can be removed: declare every optionally-present alias method on
 * `ExtendedConfigurationService` and resolve handlers via bound references at
 * the route boundary. This preserves the original "best-effort" semantics
 * (silently no-op when the service does not implement an alias) while letting
 * the rest of the file drop `as any`.
 */
type ExtendedConfigurationService = ConfigurationService & {
  validateConfiguration?: (configOrId: unknown) => unknown | Promise<unknown>;
  saveConfiguration: (
    config: unknown,
    context?: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ) => Promise<unknown>;
  deleteConfiguration: (id: string) => Promise<unknown>;
  importConfiguration: (
    data: unknown,
    context?: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ) => Promise<IntegrationConfig>;
  activateConfigurationForTenant: (
    tenantId: string,
    configurationId: string,
    context: ConfigurationCommandContext,
    authorization?: CardinalityAuthorizationInput,
  ) => Promise<unknown>;
  duplicateConfiguration?: (id: string, newName: string) => Promise<IntegrationConfig>;
  getConfigurationHistory?: (id: string) => Promise<unknown>;
};

interface ValidationShape {
  valid?: boolean;
  isValid?: boolean;
  errors?: unknown[];
}

interface SavedConfigShape {
  id?: string;
  [k: string]: unknown;
}

/**
 * Stand-in used ONLY for the create route's optional pre-save validation when
 * the client omits `id` (the normal create case — clients must never mint
 * configuration ids). The canonical schema requires a segment-safe id, but the
 * real id is generated inside `ConfigurationService.saveConfiguration`, so this
 * value never reaches persistence, the response, or the Location header.
 */
const SERVER_GENERATED_ID_PLACEHOLDER = 'pending-server-generated-id';

export const createConfigurationRouter = (optsOrService: ConfigurationService | CreateConfigRouterOpts): Router => {
  const configService: ExtendedConfigurationService =
    ((optsOrService as CreateConfigRouterOpts)?.configurationService || (optsOrService as ConfigurationService)) as ExtendedConfigurationService;
  const cardinalityPreflight = (optsOrService as CreateConfigRouterOpts)?.cardinalityPreflight;
  const serializedAssetReadiness = (optsOrService as CreateConfigRouterOpts)?.serializedAssetReadiness;
  // ONE limiter instance shared by the two routes that can trigger live
  // Salesforce discovery (readiness directly; activation through the
  // specialized activation guard), so the (IP, user) budget is genuinely
  // shared and a caller cannot get a fresh allowance by alternating routes.
  // Deliberately NOT applied to the rest of the configuration router — ordinary
  // CRUD does no outbound I/O and must not be throttled by this budget. The
  // router mounts behind authMiddleware + the tenant kill switch
  // (mountConfigurationRoutes), so the limiter runs AFTER auth/authz and
  // rejected traffic never consumes budget.
  const serializedAssetExpensiveRouteRateLimit = createSerializedAssetReadinessRateLimit();
  /**
   * Runs the tenant check BEFORE the limiter so the repo convention holds
   * exactly: rejected traffic never consumes budget. `authMiddleware` already
   * sits in front of the router, but a token that authenticates without a
   * tenant claim would otherwise burn a legitimate tenant's allowance on its
   * way to a 401. `requireTenantId` responds itself, so a falsy result means
   * the response is already sent; the handler calls it again (idempotent) to
   * obtain the value.
   */
  const rateLimitAfterTenantCheck: RequestHandler[] = [
    (req, res, next) => {
      if (!requireTenantId(req, res)) return;
      next();
    },
    serializedAssetExpensiveRouteRateLimit,
  ];
  const router = Router();
  // Route-registration prefix becomes router-relative ('' = mount-point root).
  // The router is mounted at `/api/configurations` (with authMiddleware) in
  // RouteSetup.ts, so registrations use bare router-relative paths.
  const base = '';
  // Public-facing prefix retained for Location headers and other absolute-URL
  // emissions. publicBase is the SINGLE source of truth for what
  // /api/configurations means to clients; route registration uses `base`
  // (router-relative), response URLs use `publicBase`. They stay
  // equal-but-separate so a future re-mount changes one line.
  const publicBase = '/api/configurations';

  /**
   * @swagger
   * /api/configurations:
   *   get:
   *     summary: Get all integration configurations
   *     description: Retrieves a list of all configured integrations in the system
   *     tags: [Configurations]
   *     responses:
   *       200:
   *         description: List of integration configurations
   *         content:
   *           application/json:
   *             schema:
   *               type: array
   *               items:
   *                 $ref: '#/components/schemas/IntegrationConfig'
   *             example:
   *               - id: "sf_to_ns_customers"
   *                 name: "Salesforce to NetSuite Customer Sync"
   *                 sourceSystem: "Salesforce"
   *                 targetSystem: "NetSuite"
   *                 syncDirection: "source_to_target"
   *                 syncMode: "realtime"
   *                 isActive: true
   */
  // Support absolute path (for unit tests inspecting router) and relative path (when mounted under base)
  const getAllHandler = asyncHandler(async (req, res) => {
    const acceptHeaderRaw = req.headers?.accept;
    const acceptHeader = Array.isArray(acceptHeaderRaw)
      ? acceptHeaderRaw.join(',').toLowerCase()
      : (acceptHeaderRaw ?? '').toLowerCase();
    const wantsHtml = acceptHeader.includes('text/html') && !acceptHeader.includes('application/json');

    // Fail-closed BEFORE the HTML convenience redirect (Copilot review): a Bearer
    // token that passes authMiddleware but lacks the tenantId claim must get the
    // 401 tenant_required contract uniformly, regardless of Accept header — not a
    // 302 to the dashboard.
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    if (wantsHtml) {
      res.redirect(302, '/integration-dashboard.html');
      return;
    }

    try {
      let configs = await Promise.resolve(configService.getAllConfigurationsForTenant(tenantId));

      // Filter by sourceSystem if provided
      const sourceSystem = req.query.sourceSystem as string;
      if (sourceSystem) {
        configs = configs.filter(c => getSystemType(c.sourceSystem) === sourceSystem);
      }

      // Filter by targetSystem if provided
      const targetSystem = req.query.targetSystem as string;
      if (targetSystem) {
        configs = configs.filter(c => getSystemType(c.targetSystem) === targetSystem);
      }

      res.status(200).json(configs.map((config) => toExternalIntegrationConfig(config)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve configurations';
      res.status(500).json({ error: message });
    }
  });
  router.get('/', getAllHandler);

  /**
   * @swagger
   * /api/configurations/cardinality-preflight:
   *   post:
   *     summary: Analyze a mapping plan for record-grain/cardinality hazards
   *     description: >
   *       Runs the trusted preflight coordinator against a safe mapping-plan
   *       projection plus optional bounded samples and returns the completed
   *       report. A report that contains blocking findings still returns 200 —
   *       the 422 contract belongs to activation, not to advisory preflight.
   *     tags: [Configurations]
   *     responses:
   *       200:
   *         description: Completed cardinality report (may contain blocking findings)
   *       400:
   *         description: Malformed plan projection or unsafe sample payload
   *       401:
   *         description: Missing tenant claim
   *       413:
   *         description: Sample payload exceeds the row or byte cap
   *       503:
   *         description: The coordinator could not determine evidence availability
   */
  // Registered BEFORE the `/:id` routes so the literal path can never be
  // shadowed by the parameterized ones.
  const cardinalityPreflightHandler = asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    // Fail closed when the coordinator is not wired: an unavailable gate is an
    // INABILITY TO DECIDE (503), never an implicit "clean" answer.
    if (!cardinalityPreflight) {
      res.status(503).json({
        error: 'cardinality_preflight_unavailable',
        reason: 'coordinator_not_configured',
      });
      return;
    }

    const body = (req.body ?? {}) as Record<string, unknown>;
    // Sample bounds run BEFORE schema parsing so an oversized payload gets the
    // 413 contract rather than a generic validation 400.
    if (!enforceSampleSafety(res, body.samples)) return;

    const parsed = CardinalityPreflightRequestSchema.safeParse(body);
    if (!parsed.success) {
      respondInvalidRequest(res, parsed.error);
      return;
    }

    // Build the plan as an explicit projection — the request is NEVER cast to an
    // IntegrationConfig, and `samples` travel separately (they are analyzed, never
    // persisted).
    const { samples, ...plan } = parsed.data;
    try {
      const result = await cardinalityPreflight.runForPlan(plan as CardinalityPlanInput, tenantId, samples);
      res.status(200).json({
        blocking: result.blocking,
        combinedFingerprint: result.combinedFingerprint,
        reports: result.reports.map(sanitizeCardinalityReport),
      });
    } catch (error) {
      // A trustworthy `status: unavailable` inside a completed report is a 200
      // (and a blocking finding at activation). This branch is the OTHER case:
      // the coordinator could not decide at all.
      if (error instanceof ServiceUnavailableAppError) {
        res.status(503).json({
          error: 'cardinality_preflight_unavailable',
          reason: 'evidence_undetermined',
        });
        return;
      }
      throw error;
    }
  });
  router.post(`${base}/cardinality-preflight`, cardinalityPreflightHandler);

  /**
   * @swagger
   * /api/configurations/{id}/serialized-asset-readiness:
   *   post:
   *     summary: Evaluate live activation readiness for a stored serialized-asset draft
   *     description: >
   *       Resolves the tenant-owned configuration stored under `id` and runs the
   *       non-overrideable activation-readiness sequence against it: rollout
   *       flags, managed credential references, Salesforce Product2/Asset
   *       describe metadata, field External-ID/uniqueness, the Product2
   *       relationship, and principal permissions. The body MUST be empty —
   *       credentials, systems, mappings, and hosts are never read from the
   *       request, because initializing a Salesforce connector from
   *       request-supplied data would let a caller aim the server's outbound
   *       HTTP (and its OAuth credential post) at an arbitrary host. The
   *       response carries sanitized blockers and field-NAME choices only, and
   *       the endpoint neither saves nor activates anything. Unknown and
   *       cross-tenant ids return the identical 404.
   *     tags: [Configurations]
   *     responses:
   *       200:
   *         description: Readiness result (may be `ready: false` with blockers)
   *       400:
   *         description: Non-empty body, or a configuration that is not on the specialized profile
   *       401:
   *         description: Missing tenant claim
   *       404:
   *         description: Unknown or cross-tenant configuration id
   *       503:
   *         description: Readiness could not be determined
   */
  // Registered BEFORE the `/:id` routes so the literal suffix can never be
  // shadowed by a parameterized registration.
  const serializedAssetReadinessHandler = asyncHandler(async (req, res) => {
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    // Tenant ownership precheck: an unknown id and a cross-tenant id both
    // resolve to undefined, so both surface the identical 404. No silent
    // tenant correction, no existence leak.
    const stored = configService.getConfigurationForTenant(tenantId, id);
    if (!stored) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    // Empty body ONLY. This is the security boundary of the endpoint: any
    // accepted field would become an input to connector initialization.
    //
    // The shape check comes FIRST because `Object.keys` is empty for `[]` too —
    // an array (or any other non-plain-object JSON value) would otherwise sail
    // through a keys-only allowlist and make "empty body only" a lie.
    const rawBody: unknown = req.body ?? {};
    if (!isPlainObject(rawBody)) {
      res.status(400).json({
        error: 'invalid_request',
        details: [{ path: '', message: 'Request body must be an empty JSON object' }],
      });
      return;
    }
    const disallowedKeys = Object.keys(rawBody);
    if (disallowedKeys.length > 0) {
      res.status(400).json({
        error: 'invalid_request',
        details: disallowedKeys.map((key) => ({
          path: key,
          message: 'Field is not accepted by the readiness route; the body must be empty',
        })),
      });
      return;
    }

    if (stored.executionProfile !== 'netsuite_serialized_asset') {
      res.status(400).json({
        error: 'invalid_request',
        details: [{
          path: 'executionProfile',
          message: 'Configuration does not use the netsuite_serialized_asset execution profile',
        }],
      });
      return;
    }

    // Fail closed when the evaluator is not wired: an unavailable readiness
    // gate is an INABILITY TO DECIDE (503), never an implicit "ready".
    if (!serializedAssetReadiness) {
      res.status(503).json({
        error: 'serialized_asset_readiness_unavailable',
        reason: 'service_not_configured',
      });
      return;
    }

    try {
      const result = await serializedAssetReadiness.evaluate(stored);
      res.status(200).json(result);
    } catch (error) {
      if (error instanceof ServiceUnavailableAppError) {
        res.status(503).json({
          error: 'serialized_asset_readiness_unavailable',
          reason: 'readiness_undetermined',
        });
        return;
      }
      throw error;
    }
  });
  router.post(
    `${base}/:id/serialized-asset-readiness`,
    ...rateLimitAfterTenantCheck,
    serializedAssetReadinessHandler,
  );

  /**
   * @swagger
   * /api/configurations/{id}:
   *   get:
   *     summary: Get integration configuration by ID
   *     description: Retrieves a specific integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *         example: "sf_to_ns_customers"
   *     responses:
   *       200:
   *         description: Integration configuration details
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/IntegrationConfig'
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const getByIdHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const config = await Promise.resolve(configService.getConfigurationForTenant(tenantId, id));
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    res.status(200).json(toExternalIntegrationConfig(config));
  });
  router.get(`${base}/:id`, getByIdHandler);

  /**
   * @swagger
   * /api/configurations:
   *   post:
   *     summary: Create new integration configuration
   *     description: Creates a new integration configuration with validation
   *     tags: [Configurations]
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConfig'
   *           example:
   *             id: "new_integration"
   *             name: "New Integration"
   *             sourceSystem: "Salesforce"
   *             targetSystem: "NetSuite"
   *             syncDirection: "bidirectional"
   *             syncMode: "batch"
   *             isActive: true
   *             authentication:
   *               type: "oauth2"
   *               credentials:
   *                 clientId: "your_client_id"
   *                 clientSecret: "your_client_secret"
   *                 tokenUrl: "https://login.salesforce.com/services/oauth2/token"
   *     responses:
   *       201:
   *         description: Configuration created successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration saved successfully"
   *                 id:
   *                   type: string
   *                   example: "new_integration"
   *       400:
   *         description: Invalid configuration data
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // Create configuration with minimal inline validation (single handler for test harness)
  const createHandler = asyncHandler(async (req, res) => {
    const body = req.body || {};

    // Auth gate FIRST (fail-closed, Codex review): a Bearer-authenticated caller
    // with no tenant claim must get 401 tenant_required BEFORE body validation,
    // consistent with the tenant enforcement the rest of this PR applies — a
    // tenantless request should never receive a payload 400 that masks the auth
    // failure. req.user.tenantId is authoritative (spec §9); a body naming a
    // different tenant is rejected (403) before binding the caller's tenant.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;

    // Operator identity BEFORE the existence precheck below — same load-bearing
    // ordering as the activation route (Codex R4: the activation fix closed one
    // of four handlers carrying this shape). A caller holding a JWT with a
    // tenantId claim but no usable `req.user.id` would otherwise get 404 for an
    // id belonging to another tenant and 401 for anything else, which
    // distinguishes which configuration IDs exist — from a credential not
    // authorized to create anything at all. Body validation sits behind identity
    // for the same reason: an unauthorized caller should not learn whether their
    // payload would have been accepted.
    const context = requireConfigurationCommandContext(req, res, 'create', requesterTenantId);
    if (!context) return;

    if (typeof body.tenantId === 'string' && body.tenantId !== requesterTenantId) {
      res.status(403).json({ error: 'forbidden', reason: 'tenant_mismatch' });
      return;
    }

    // Strip the transport-only `_cardinality` envelope BEFORE any canonical
    // validation/persistence and carry it as the server-side authorization input.
    const envelope = takeCardinalityEnvelope(res, body);
    if (!envelope) return;

    const missing: string[] = [];
    if (!body.name) missing.push('name');
    if (!body.sourceSystem) missing.push('sourceSystem');
    if (!body.targetSystem) missing.push('targetSystem');
    if (missing.length) {
      res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
      return;
    }

    // Force tenant binding from authenticated identity BEFORE validation
    // (Copilot R0+R1). Cross-tenant id-collision precheck (Copilot R2):
    // refuse 404 if body.id already belongs to a different tenant.
    body.tenantId = requesterTenantId;
    if (typeof body.id === 'string' && body.id.length > 0) {
      const existing = configService.getConfigurationForTenant(requesterTenantId, body.id);
      const collidesOtherTenant =
        !existing && configService.getAllConfigurations().some(c => c.id === body.id);
      if (collidesOtherTenant) {
        res.status(404).json({ error: 'Configuration not found' });
        return;
      }
    }

    // Optional pre-save validation via service if available.
    // typeof-guard BEFORE bind: validateConfiguration could be a truthy
    // non-function (e.g. mis-wired DI mock) — `validateConfiguration?.bind`
    // would throw synchronously in that case, turning the best-effort
    // no-op path into a 500.
    const rawValidateFn = configService.validateConfiguration;
    const validateFn = typeof rawValidateFn === 'function'
      ? rawValidateFn.bind(configService)
      : undefined;
    if (validateFn) {
      try {
        // A create legitimately omits `id` — the service generates one on its
        // own sanitized clone before IT validates. Pre-validating the RAW body
        // therefore 400'd ("id: expected string, received undefined") on every
        // legitimate id-less create, which is the second half of why the
        // editor's "create a new inactive draft" step was dead. Validate the
        // shape that will actually be persisted: the body plus a stand-in for
        // the id the service is about to generate. The stand-in is never
        // persisted and never returned — `body` itself is left untouched.
        const validationTarget = typeof body.id === 'string' && body.id.length > 0
          ? body
          : { ...body, id: SERVER_GENERATED_ID_PLACEHOLDER };
        const validation = (await validateFn(validationTarget)) as ValidationShape | undefined;
        // Support either {valid:boolean, errors:string[]} or {isValid:boolean, errors:string[]}
        const valid = validation?.valid ?? validation?.isValid;
        if (valid === false && Array.isArray(validation?.errors) && validation.errors.length) {
          res.status(400).json({ error: String(validation.errors[0]) });
          return;
        }
      } catch (e) {
        // If validation throws, treat as server error
        const msg = e instanceof Error ? e.message : 'Validation failed';
        res.status(500).json({ error: msg });
        return;
      }
    }

    // The trusted command context for the cardinality activation gate (Task 8)
    // was built above, ahead of the existence precheck. Every active save must
    // carry a concrete operation/tenant/actor/correlation id; draft saves are
    // unaffected (the gate is bypassed for them downstream), but the context is
    // always built so an edit that flips a config active never silently loses
    // attribution.

    // Only pass the third argument when an envelope was actually supplied, so a
    // plain save keeps its two-argument call shape.
    const saved = (envelope.authorization
      ? await configService.saveConfiguration(body, context, envelope.authorization)
      : await configService.saveConfiguration(body, context)) as SavedConfigShape | undefined;
    // For create semantics return 201 + Location + message (tests expect message containing 'successfully')
    res.status(201);
    // The PERSISTED record's id is authoritative. A create request legitimately
    // carries no `id` — the service generates one on its internal sanitized
    // clone — so `body.id` is only a fallback for a service impl that returns
    // nothing. Keying off `body.id` alone (or off a returned record that the
    // concrete service never produced) is exactly how the create path shipped
    // `id: undefined` and no Location header to production while mocked tests
    // stayed green.
    const persistedId =
      saved && typeof saved === 'object' && typeof saved.id === 'string' && saved.id.length > 0
        ? saved.id
        : undefined;
    const createdId = persistedId ?? (typeof body.id === 'string' && body.id.length > 0 ? body.id : undefined);
    try {
      if (createdId) {
        res.setHeader('Location', `${publicBase}/${createdId}`);
      }
    } catch {/* ignore header errors */}
    // Deliberately NOT the whole persisted record: the create response stays
    // {message, id} so a stored configuration's system/credential-reference
    // block is never echoed back by a write endpoint (GET /:id is the read
    // surface). This is also the production shape the previous
    // `Object.assign(payload, saved)` never actually produced.
    res.json({
      message: 'Configuration saved successfully',
      id: createdId,
    });
  });
  router.post('/', createHandler);

  /**
   * @swagger
   * /api/configurations/{id}:
   *   put:
   *     summary: Update integration configuration
   *     description: Updates an existing integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/IntegrationConfig'
   *     responses:
   *       200:
   *         description: Configuration updated successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration updated successfully"
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  // Update configuration with minimal inline validation (single handler)
  const updateHandler = asyncHandler(async (req, res) => {
    const body = req.body || {};
    const id = req.params.id;
    // Auth gate: req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    // Operator identity BEFORE the existence precheck below (Codex R4) — see the
    // create handler for why the ordering is load-bearing.
    const context = requireConfigurationCommandContext(req, res, 'update', requesterTenantId);
    if (!context) return;
    // Reject a body that names a different tenant (403) before binding.
    if (typeof body.tenantId === 'string' && body.tenantId !== requesterTenantId) {
      res.status(403).json({ error: 'forbidden', reason: 'tenant_mismatch' });
      return;
    }
    // Cross-tenant id-collision precheck (Copilot R2): refuse 404 if the path
    // id belongs to a different tenant.
    const ownedByRequester = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!ownedByRequester && configService.getAllConfigurations().some(c => c.id === id)) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    // Strip the transport-only `_cardinality` envelope before the config is built.
    const envelope = takeCardinalityEnvelope(res, body);
    if (!envelope) return;
    const config = { ...body, id, tenantId: requesterTenantId };
    if (envelope.authorization) {
      await configService.saveConfiguration(config, context, envelope.authorization);
    } else {
      await configService.saveConfiguration(config, context);
    }
    res.status(200);
    res.json({ message: 'Configuration updated successfully' });
  });
  router.put(`${base}/:id`, updateHandler);

  /**
   * @swagger
   * /api/configurations/{id}:
   *   delete:
   *     summary: Delete integration configuration
   *     description: Permanently deletes an integration configuration
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     responses:
   *       200:
   *         description: Configuration deleted successfully
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 message:
   *                   type: string
   *                   example: "Configuration deleted successfully"
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const deleteHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    // Auth gate: req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    // Tenant ownership precheck (Copilot R1): refuse 404 on cross-tenant
    // delete attempts to avoid existence leak.
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    try {
      const result: unknown = await configService.deleteConfigurationForTenant(requesterTenantId, id);
      // Support different return contracts from the service:
      // - boolean true/false
      // - object with success/message (pass-through)
      if (result === false || result == null) {
        res.status(404).json({ error: 'Configuration not found' });
        return;
      }
      if (typeof result === 'object') {
        res.status(200).json(result);
        return;
      }
      res.status(200).json({ success: true, message: 'Configuration deleted' });
    } catch (err) {
      const message = err instanceof NotFoundError || (err instanceof Error && err.message === 'Configuration not found')
        ? 'Configuration not found'
        : (err instanceof Error ? err.message : 'Failed to delete configuration');
      const status = message === 'Configuration not found' ? 404 : 500;
      res.status(status).json({ error: message });
    }
  });
  router.delete(`${base}/:id`, deleteHandler);

  /**
   * @swagger
   * /api/configurations/{id}/validate:
   *   post:
   *     summary: Validate integration configuration
   *     description: Validates an integration configuration and checks connectivity
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     responses:
   *       200:
   *         description: Validation results
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 isValid:
   *                   type: boolean
   *                   description: Whether the configuration is valid
   *                 errors:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of validation errors
   *                 warnings:
   *                   type: array
   *                   items:
   *                     type: string
   *                   description: List of validation warnings
   *               example:
   *                 isValid: true
   *                 errors: []
   *                 warnings: ["Consider enabling real-time sync for better performance"]
   *       404:
   *         description: Configuration not found
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/Error'
   */
  const validateHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    const validateFn = configService.validateConfiguration;
    if (typeof validateFn !== 'function') {
      // Service deployments without validateConfiguration return a
      // structured 501 instead of throwing — the global error handler
      // would otherwise emit a generic 500.
      res.status(501).json({ error: 'Configuration validation is not implemented' });
      return;
    }
    // ConfigurationService.validateConfiguration expects an
    // IntegrationConfig object, not an id string, so fetch the
    // configuration first and return 404 if it does not exist.
    const config = await Promise.resolve(configService.getConfigurationForTenant(tenantId, id));
    if (!config) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const validation = await validateFn.call(configService, config);
    res.status(200).json(validation);
  });
  router.post(`${base}/:id/validate`, validateHandler);

  /**
   * @swagger
   * /api/configurations/{id}/activate:
   *   post:
   *     summary: Activate a stored draft configuration by ID
   *     description: >
   *       Resolves the tenant-owned configuration already stored under `id`,
   *       clones it active, and routes that clone through the same
   *       validation, cardinality, audit, and atomic persistence path as any
   *       other active save — this is not a second persistence path. The
   *       body accepts ONLY the `_cardinality` authorization envelope;
   *       systems, authentication, mappings, destinations, and credentials
   *       are never read from the request (activation reads the stored
   *       configuration, not the body). Unknown and cross-tenant ids return
   *       the identical 404.
   *     tags: [Configurations]
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Integration configuration ID
   *     responses:
   *       200:
   *         description: Configuration activated successfully
   *       400:
   *         description: Body content other than the `_cardinality` envelope
   *       401:
   *         description: Missing tenant claim or verified actor identity
   *       404:
   *         description: Unknown or cross-tenant configuration id
   *       422:
   *         description: Unresolved blocking cardinality findings
   */
  const activateHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'Configuration ID is required' });
      return;
    }

    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;

    // Operator identity is established BEFORE the existence precheck, and the
    // ordering is load-bearing. A caller holding a JWT with a tenantId claim
    // but no usable `req.user.id` would otherwise receive 404 for an unknown id
    // and 401 for a real one — an existence oracle for configuration IDs under
    // their own tenant, from a credential that is not authorized to act at all.
    // Every existence-dependent response now sits behind full identity.
    const context = requireConfigurationCommandContext(req, res, 'admin_activation', requesterTenantId);
    if (!context) return;

    // Tenant ownership precheck: an unknown id and a cross-tenant id both
    // resolve to undefined here, so both surface the identical 404 — a
    // cross-tenant id never leaks existence under a different tenant.
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }

    // Activation resolves its configuration from tenant-scoped storage, never
    // the request body: the ONLY body content accepted is the `_cardinality`
    // envelope. Any other field (systems, authentication, mappings,
    // destinations, credentials) is a 400 — activating a draft can never be
    // used to smuggle a body-authored configuration into an active save.
    // Shape check first, for the same reason as the readiness route:
    // `Object.keys([])` is empty, so a keys-only allowlist silently accepts an
    // array body.
    const rawActivateBody: unknown = req.body ?? {};
    if (!isPlainObject(rawActivateBody)) {
      res.status(400).json({
        error: 'invalid_request',
        details: [{ path: '', message: 'Request body must be a JSON object' }],
      });
      return;
    }
    const body = rawActivateBody;
    const disallowedKeys = Object.keys(body).filter((key) => key !== '_cardinality');
    if (disallowedKeys.length > 0) {
      res.status(400).json({
        error: 'invalid_request',
        details: disallowedKeys.map((key) => ({
          path: key,
          message: 'Field is not accepted by the activation route',
        })),
      });
      return;
    }

    const envelope = takeCardinalityEnvelope(res, body);
    if (!envelope) return;

    try {
      await configService.activateConfigurationForTenant(requesterTenantId, id, context, envelope.authorization);
    } catch (err) {
      // Typed check ONLY. `activateConfigurationForTenant` raises
      // `NotFoundError` for both the unknown-id and cross-tenant cases, so a
      // message-string disjunct would be dead weight here — and worse than
      // dead: its literal never equals that error's actual message
      // (`Configuration '<id>' not found`), so the only thing it could ever
      // match is some UNRELATED error that happens to read exactly
      // "Configuration not found", silently reporting it as a 404.
      if (err instanceof NotFoundError) {
        res.status(404).json({ error: 'Configuration not found' });
        return;
      }
      // Specialized (netsuite_serialized_asset) activation refusal: surface the
      // typed code and the sanitized blocker list so the editor can tell the
      // operator exactly what to fix. `ServiceUnavailableAppError` is
      // deliberately NOT caught — an undeterminable readiness gate must stay a
      // 503 through the error boundary rather than look like a fixable refusal.
      if (err instanceof SerializedAssetActivationBlockedError) {
        res.status(err.statusCode).json(err.toResponseBody());
        return;
      }
      throw err;
    }
    res.status(200).json({ message: 'Configuration activated successfully', id });
  });
  router.post(`${base}/:id/activate`, ...rateLimitAfterTenantCheck, activateHandler);

  // Additional endpoints used by tests
  const ALLOWED_EXPORT_FORMATS = new Set(['json']);
  const exportHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const rawFormat = String((req.query?.format as string) || 'json');
    // Normalize case + whitespace so semantically-equivalent formats
    // (?format=JSON, ?format=json%20) aren't rejected.
    const format = rawFormat.trim().toLowerCase();
    if (!ALLOWED_EXPORT_FORMATS.has(format)) {
      res.status(400).json({
        error: `Unsupported export format '${rawFormat}'. Supported: ${[...ALLOWED_EXPORT_FORMATS].join(', ')}`,
      });
      return;
    }
    const tenantId = requireTenantId(req, res);
    if (!tenantId) return;

    try {
      const result = await configService.exportConfigurationForTenant(tenantId, id);
      res.setHeader('Content-Disposition', `attachment; filename="${id}-export.${format}"`);
      // Concrete service returns a pre-serialized JSON string; res.json
      // would double-encode it (clients receive a quoted JSON string).
      // Send strings via .send() with the right content-type; fall through
      // to .json() for non-string mock returns.
      if (typeof result === 'string') {
        res.status(200).type('application/json').send(result);
      } else {
        res.status(200).json(result);
      }
    } catch (err) {
      // Cross-tenant / missing-config now throws NotFoundError (Copilot R8).
      if (err instanceof NotFoundError || (err instanceof Error && err.message === 'Configuration not found')) {
        res.status(404).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : 'Failed to export configuration';
      res.status(500).json({ error: message });
    }
  });
  router.get(`${base}/:id/export`, exportHandler);

  const importHandler = asyncHandler(async (req, res) => {
    // Auth gate FIRST (fail-closed, Codex review): tenant_required 401 before any
    // body validation/serialization, so a Bearer-authenticated caller with no
    // tenant claim never receives a payload 400 that masks the auth failure.
    // req.user.tenantId is authoritative (spec §9).
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    // Operator identity BEFORE the existence precheck further down (Codex R4) —
    // see the create handler for why the ordering is load-bearing.
    const context = requireConfigurationCommandContext(req, res, 'import', requesterTenantId);
    if (!context) return;
    const data = req.body;
    if (!data || typeof data !== 'object' || !('configuration' in data)) {
      res.status(400).json({ error: 'Invalid import data' });
      return;
    }
    // The concrete ConfigurationService.importConfiguration expects a
    // non-empty JSON string payload. Serialize objects defensively:
    // JSON.stringify can throw (circular refs, BigInt) or return undefined
    // (e.g. for `undefined` input). Both produce a deterministic 400 here
    // rather than a generic 500 from the global error handler.
    let configurationPayload: string | undefined;
    if (typeof data.configuration === 'string') {
      configurationPayload = data.configuration;
    } else {
      try {
        configurationPayload = JSON.stringify(data.configuration);
      } catch {
        res.status(400).json({ error: 'Invalid import data' });
        return;
      }
    }
    if (typeof configurationPayload !== 'string' || configurationPayload.trim().length === 0) {
      res.status(400).json({ error: 'Invalid import data' });
      return;
    }

    // Tenant ownership override + id-collision precheck for import (Copilot
    // R1 + R3). Parse the JSON payload, refuse 404 on cross-tenant id
    // collision, force-override the payload's tenantId to the caller's
    // tenant. If payload doesn't parse as an object, fall through.
    let parsedPayload: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(configurationPayload) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedPayload = parsed;
      }
    } catch {
      // Non-JSON-object payload — let the service reject.
    }

    let importAuthorization: CardinalityAuthorizationInput | undefined;
    if (parsedPayload) {
      if (typeof parsedPayload.id === 'string' && parsedPayload.id.length > 0) {
        const ownedByRequester = configService.getConfigurationForTenant(requesterTenantId, parsedPayload.id);
        if (!ownedByRequester && configService.getAllConfigurations().some(c => c.id === parsedPayload!.id)) {
          res.status(404).json({ error: 'Configuration not found' });
          return;
        }
      }
      // An imported override is only a REQUEST: it is stripped from the
      // configuration and attributed to the importer's command context, exactly
      // like a create/update envelope.
      const envelope = takeCardinalityEnvelope(res, parsedPayload);
      if (!envelope) return;
      importAuthorization = envelope.authorization;
      parsedPayload.tenantId = requesterTenantId;
      configurationPayload = JSON.stringify(parsedPayload);
    }

    const result = importAuthorization
      ? await configService.importConfiguration(configurationPayload, context, importAuthorization)
      : await configService.importConfiguration(configurationPayload, context);
    res.status(200).json(toExternalIntegrationConfig(result));
  });
  router.post(`${base}/import`, importHandler);

  const duplicateHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { newName } = req.body || {};
    // Auth gate: req.user.tenantId is authoritative (spec §9). Optional
    // service methods — calls return undefined when not implemented — but
    // the route contract shouldn't be tenant-blind. Returns 404 on
    // cross-tenant id.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    const duplicateFn = configService.duplicateConfiguration;
    if (typeof duplicateFn !== 'function') {
      res.status(501).json({ error: 'Configuration duplication is not implemented' });
      return;
    }
    const result = await duplicateFn.call(configService, id, newName);
    res.status(200).json(toExternalIntegrationConfig(result));
  });
  router.post(`${base}/:id/duplicate`, duplicateHandler);

  const historyHandler = asyncHandler(async (req, res) => {
    const { id } = req.params;
    // Auth gate + tenant ownership precheck — see duplicateHandler comment.
    const requesterTenantId = requireTenantId(req, res);
    if (!requesterTenantId) return;
    const owned = configService.getConfigurationForTenant(requesterTenantId, id);
    if (!owned) {
      res.status(404).json({ error: 'Configuration not found' });
      return;
    }
    try {
      const historyFn = configService.getConfigurationHistory;
      if (typeof historyFn !== 'function') {
        res.status(501).json({ error: 'Configuration history is not implemented' });
        return;
      }
      const history = await historyFn.call(configService, id);
      res.status(200).json(history);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve configuration history';
      res.status(500).json({ error: message });
    }
  });
  router.get(`${base}/:id/history`, historyHandler);

  return router;
};
