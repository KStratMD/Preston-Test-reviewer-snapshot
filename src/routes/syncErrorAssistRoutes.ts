// R19-4 — Re-export schema + sentinel so the route handler can import locally and external
// callers can resolve via the spec-pinned path `src/routes/syncErrorAssistRoutes.ts`.
export {
  WebhookPayloadSchema,
  objectDepth,
  MAX_SOURCE_PAYLOAD_BYTES,
  MAX_SOURCE_PAYLOAD_DEPTH,
  TENANT_ID_REGEX,
  ERROR_RECORD_ID_REGEX,
  RESERVED_TENANT_SENTINEL,
} from './syncErrorAssistWebhookSchema';

import { Router, type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import type { RateLimitRequestHandler } from 'express-rate-limit';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { validateGuestContext } from '../middleware/embeddedAuthMiddleware';
import { validateApplyAction } from '../services/syncErrorAssist/applyAction';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import type {
  SyncErrorAssistOperatorService,
  OperatorResult,
} from '../services/syncErrorAssist/SyncErrorAssistOperatorService';
import type { SyncErrorAssistService } from '../services/syncErrorAssist/SyncErrorAssistService';
import type { SyncErrorAssistMetrics, WebhookValidationFailureReason } from '../services/syncErrorAssist/SyncErrorAssistMetrics';
import type { TenantConfigurationRepository } from '../database/repositories/TenantConfigurationRepository';
import type { EmbeddedSession } from '../database/types';
import type { Logger } from '../utils/Logger';
import { verifySuiteCentralWebhook } from '../middleware/syncErrorAssistWebhook';
// Copilot-PR766 — Import SYSTEM_IDENTITY as a value (not type-only) because the route
// handler uses `SYSTEM_IDENTITY.userId` to build the webhook's IdentityContext. The literal
// `"__system__"` string is forbidden in `src/` outside `identityContext.ts` by the CI gate
// `scripts/check-system-identity-isolation.mjs`.
import { SYSTEM_IDENTITY, type IdentityContext } from '../services/governance/identityContext';
// R20-2 — Local import of the reserved-sentinel constant. The re-export block at the top of
// this file (see Task 9 Step 5) makes `RESERVED_TENANT_SENTINEL` available to EXTERNAL
// callers via `import { RESERVED_TENANT_SENTINEL } from '.../syncErrorAssistRoutes'`, but
// `export { X } from './path'` does NOT create a local binding inside this file — the
// re-export is a pass-through symbol for consumers, not a value in scope for the route
// handler. Add the explicit import here so the R19-4 header guard `keyIdHeader ===
// RESERVED_TENANT_SENTINEL` resolves at compile time.
import { WebhookPayloadSchema, RESERVED_TENANT_SENTINEL } from './syncErrorAssistWebhookSchema';

export const syncErrorAssistRoutes = Router();

// ---------------------------------------------------------------------------
// PR 17c Task 10 Step 0 — Webhook route module state + reset seam (R21-1 /
// R24-6 / R25-3). The lazy `tenantPostAuthLimiter` instance and the cached
// DI-deps promise live at module scope so the route handler (Task 10 Step 3)
// can reuse them across requests. Step 3 assigns and reads these — it does
// NOT re-declare them.
// ---------------------------------------------------------------------------

let tenantPostAuthLimiter: RateLimitRequestHandler | null = null;
let cachedHandlerDepsPromise: Promise<{ metrics: SyncErrorAssistMetrics; logger: Logger }> | null = null;

/**
 * Test-only seam: clears BOTH the lazy limiter instance and the lazy DI-deps
 * promise so `beforeEach` blocks in integration suites start each test with
 * a fresh internal counter Map (recreated on next request) AND a fresh
 * resolved-deps fetch (so a `rebind(TYPES.Logger)` in the next test's setup
 * actually swaps the logger spy the limiter handler uses).
 *
 * Production code never calls this. Exported as a named export (not
 * `__test__` namespace) because the integration helper module imports it for
 * cross-file test-state isolation.
 */
export function resetTenantPostAuthLimiterForTest(): void {
  tenantPostAuthLimiter = null;
  cachedHandlerDepsPromise = null;
}

const DUMMY_SECRET = '0'.repeat(64);

// R2-1 / R3-2 / R7-4 — cache the limiter at module scope. `express-rate-limit` stores per-key
// counters on the limiter instance — recreating it per request resets the count and AC #7's
// "101st valid webhook returns 429" never trips.
//
// R7-4 — under a flood of rate-limited requests, doing `container.getAsync` per call adds two
// async DI resolutions per 429. Cache metrics + logger references at module scope behind a
// lazy promise. Reset seam clears the cache between test runs.
//
// R25-3 — The `let tenantPostAuthLimiter`, `let cachedHandlerDepsPromise`, and
// `resetTenantPostAuthLimiterForTest` declarations are ALREADY in scope from Task 10
// Step 0 above. Do NOT re-declare them here — TypeScript will error with
// `Cannot redeclare block-scoped variable` / `Duplicate function implementation`. Step 3
// only ADDS the consumers (`getCachedHandlerDeps`, `makeTenantPostAuthLimiter`,
// `applyLimiter`, the route handler) that read/write the state Step 0 established.

async function getCachedHandlerDeps(): Promise<{ metrics: SyncErrorAssistMetrics; logger: Logger }> {
  if (!cachedHandlerDepsPromise) {
    // R8-1 — cache only on success. If container.getAsync rejects (transient DI failure),
    // a cached rejected promise would block every subsequent rate-limited request from
    // emitting metric/log even after DI recovers. Clear the cache in `.catch` so the
    // next call retries.
    const pending = (async () => {
      const [metrics, logger] = await Promise.all([
        container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics),
        container.getAsync<Logger>(TYPES.Logger),
      ]);
      return { metrics, logger };
    })();
    pending.catch(() => {
      if (cachedHandlerDepsPromise === pending) cachedHandlerDepsPromise = null;
    });
    cachedHandlerDepsPromise = pending;
  }
  return cachedHandlerDepsPromise;
}

function makeTenantPostAuthLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => {
      const keyId = req.headers['x-suitecentral-key-id'];
      return typeof keyId === 'string' ? `tenant:${keyId}` : 'tenant:unknown';
    },
    // R4-4 — handler is async so the metric increment is deterministic relative to the response.
    // R7-4 — use the cached handler deps (single DI lookup amortized across all rate-limited requests).
    handler: async (req, res) => {
      const keyId = req.headers['x-suitecentral-key-id'];
      const tenantLabel = typeof keyId === 'string' ? keyId : 'unknown';
      // R17-5 — Spec §7.1 "Validation failed" row requires `correlationId, reason, tenantId` on
      // every validation-failed warn. The route generates `correlationId` before invoking the
      // limiter and stashes it in `res.locals.syncErrorAssistCorrelationId` (see route step 7
      // below); read it back here so the tenant-rate-limited path satisfies the same logging
      // contract as every other validation-failed branch. Falls back to `'unknown'` only if a
      // hypothetical future caller invokes the limiter without first setting the local — keeps
      // the log line shape stable so dashboards never see `undefined` for this field.
      const correlationId =
        typeof res.locals.syncErrorAssistCorrelationId === 'string'
          ? res.locals.syncErrorAssistCorrelationId
          : 'unknown';
      try {
        const { metrics: m, logger: l } = await getCachedHandlerDeps();
        m.recordWebhookValidationFailed(tenantLabel, 'rate_limited');
        // R6-2 / spec §7.1 — tenant rate-limited rejection emits the standard "webhook validation failed" warn.
        l.warn('webhook validation failed', { correlationId, reason: 'rate_limited', tenantId: tenantLabel });
      } catch {
        // ignore — the 429 response still goes out below
      }
      res.status(429).json({ ok: false, code: 'tenant_rate_limited' });
    },
  });
}

// R25-3 — `resetTenantPostAuthLimiterForTest` is declared in Task 10 Step 0 above.
// Do NOT re-declare here. The Step 0 body already nulls both `tenantPostAuthLimiter`
// and `cachedHandlerDepsPromise`.

// Promise wrapper around the limiter middleware that ALWAYS resolves — `handled === true`
// when the limiter sent the 429 response, false otherwise. We never have to inspect
// res.headersSent inside the route body because the wrapper makes the contract explicit.
function applyLimiter(
  limiter: ReturnType<typeof rateLimit>,
  req: Request,
  res: Response,
): Promise<{ handled: boolean }> {
  return new Promise((resolve, reject) => {
    let resolved = false;
    res.once('finish', () => {
      if (!resolved) { resolved = true; resolve({ handled: true }); }
    });
    limiter(req, res, (err) => {
      if (resolved) return;
      resolved = true;
      if (err) reject(err);
      else resolve({ handled: res.headersSent });
    });
  });
}

// R15-2 — Cheap pre-auth validation (415 content-type, 401 missing-header) runs BEFORE
// observability DI lookups so that a misconfigured SyncErrorAssistMetrics or Logger binding
// can't mask the canonical 415/401 response with a generic 500. Observability emission on
// those branches uses `tryEmitValidationFailed` which swallows DI failures — the canonical
// status code is the contract, the metric/log is best-effort.

/**
 * R15-2 — Best-effort observability emission for pre-auth code paths (recordWebhookReceivedRaw,
 * recordWebhookValidationFailed for 415/401). Resolves SyncErrorAssistMetrics + Logger lazily
 * and swallows DI failures so that the canonical HTTP response status never depends on
 * observability dependencies. Awaited so test spies on the underlying methods fire before
 * the response — but if DI is broken, the awaits resolve to no-ops and the route still
 * returns the right status.
 */
async function tryEmitValidationFailed(
  tenantId: string,
  // R16-5 — Bounded union (re-imported from SyncErrorAssistMetrics) instead of `string`.
  // recordWebhookValidationFailed's signature requires the union; `string` would fail TS narrowing.
  reason: WebhookValidationFailureReason,
  correlationId: string,
): Promise<void> {
  try {
    const metrics = await container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics);
    metrics.recordWebhookValidationFailed(tenantId, reason);
  } catch { /* observability unavailable; canonical response was correct regardless */ }
  try {
    const logger = await container.getAsync<Logger>(TYPES.Logger);
    logger.withCorrelationId(correlationId).warn('webhook validation failed', { correlationId, reason, tenantId });
  } catch { /* observability unavailable */ }
}

/**
 * R15-2 — Best-effort `recordWebhookReceivedRaw` emission for the pre-auth raw-inbound
 * counter (gotcha #31). Same swallow-on-DI-failure semantics as `tryEmitValidationFailed`
 * so the counter doesn't gate the response status code.
 */
async function tryEmitWebhookReceivedRaw(): Promise<void> {
  try {
    const metrics = await container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics);
    metrics.recordWebhookReceivedRaw();
  } catch { /* observability unavailable */ }
}

syncErrorAssistRoutes.post('/api/sync-error-assist/ingest', async (req: Request, res: Response) => {
  const correlationId = randomUUID();
  // `signatureVerifiedAtMs` is initialized below — AFTER HMAC verification succeeds — so the
  // `sync_error_assist_webhook_e2e_latency_seconds` histogram observes "signature-verified-to-
  // claim-acked latency" as its help text claims. Starting it at handler entry would also
  // bake in pre-auth work (limiter check, header parse) which is unrelated to the post-auth
  // ingest path the metric was designed to measure.
  let signatureVerifiedAtMs: number;

  // R5-5 — Spec §7.1 lists the "webhook received" event as POST-AUTH
  // (`tenantId (post-auth only), errorRecordId, attempt`). The log is therefore emitted
  // AFTER schema parse + tenant_mismatch check (see step 6b below), not at handler entry.

  // R17-4 — Top-level try/catch protects against rejected promises on awaits that are NOT
  // inside a branch-specific try/catch (the two `tenantConfig.getBoolean(...)` calls at the
  // feature-flag gate, the `tenantConfig.getString(...)` call for the HMAC secret, the
  // `applyLimiter(...)` wrapper if its limiter throws synchronously, and any future awaits
  // added to the handler). Express 4 does NOT auto-convert a rejected route promise into the
  // canonical `{ok: false, code: 'internal_error'}` JSON response — it forwards to `next(err)`
  // which then hits Express's default error handler (a generic HTML 500). The spec requires
  // a strict JSON body shape, so we own the 500 response here rather than relying on a global
  // error middleware. Branch-specific try/catches BELOW remain unchanged — they produce
  // more specific status codes (400 invalid_body, 401 unknown_tenant, 500 internal_error
  // for the service-resolution case) and run before this outer catch sees the error.
  //
  // `!res.headersSent` guard: the limiter handler (line below) calls `res.status(429).json(...)`
  // and resolves the applyLimiter promise; if a subsequent rejection happens after the 429 is
  // sent, we MUST NOT call `res.status(500).json(...)` (Express would throw "Cannot set
  // headers after they are sent"). The guard makes the outer catch a no-op in that race.
  try {
  // 1. Media-type check (R2-8 / gotcha #28) — runs BEFORE DI (R15-2) so observability
  //    failures cannot mask the canonical 415.
  if (!req.is('application/json')) {
    await tryEmitValidationFailed('unknown', 'content_type_invalid', correlationId);
    return res.status(415).json({ ok: false, code: 'unsupported_media_type' });
  }

  // 2. Pre-auth received counter (R3-11 / gotcha #31) — emitted via best-effort helper so
  //    DI failure can't mask the 401 below. Counts every request that has passed content-type
  //    triage, regardless of header presence; matches the spec's "raw inbound volume" intent.
  await tryEmitWebhookReceivedRaw();

  // 3. Header presence — cheap; no required DI.
  const keyIdHeader = req.headers['x-suitecentral-key-id'];
  const tsHeader = req.headers['x-suitecentral-timestamp'];
  const sigHeader = req.headers['x-suitecentral-signature'];
  if (typeof keyIdHeader !== 'string' || typeof tsHeader !== 'string' || typeof sigHeader !== 'string') {
    await tryEmitValidationFailed('unknown', 'missing_header', correlationId);
    return res.status(401).json({ ok: false });
  }

  // R19-4 — Reject the reserved SYSTEM_IDENTITY sentinel at the header level, BEFORE the
  // per-tenant secret lookup. The schema rejects the same sentinel on the body's `tenantId`
  // field (a defense-in-depth pair), but rejecting the header first means we never even
  // attempt the secret lookup for `__system__`. Reason label `unknown_tenant` keeps the
  // observability bucket consistent with the post-HMAC unknown-tenant rejection — both are
  // "this key is not a valid tenant" failures from the operator's perspective, so they get
  // the same alerting/dashboard treatment. The tenant label collapses to `'unknown'` per the
  // R13-1 cardinality policy (don't echo attacker-supplied keys).
  if (keyIdHeader === RESERVED_TENANT_SENTINEL) {
    await tryEmitValidationFailed('unknown', 'unknown_tenant', correlationId);
    return res.status(401).json({ ok: false });
  }

  // R16-7 — Preflight HMAC syntax check with DUMMY_SECRET. Syntax/time failures
  // (`malformed_timestamp`, `replay_window_exceeded`, `malformed_signature`) are
  // secret-independent — `verifySuiteCentralWebhook` returns the same reason for those
  // regardless of which secret is passed (it short-circuits on header-shape / time-window /
  // length-mismatch BEFORE running the crypto). Running this preflight here, BEFORE the
  // required metrics/logger/tenantConfig DI lookups, means a misconfigured observability
  // binding cannot mask the canonical 401 for those failure modes. Only `signature_mismatch`
  // (the well-formed-but-bad-HMAC case) requires the real secret to differentiate
  // `unknown_tenant` from `signature_mismatch`, so it falls through to the post-DI path.
  const rawBody = req.body as Buffer;
  const preflightResult = verifySuiteCentralWebhook(rawBody, req.headers, DUMMY_SECRET);
  if (preflightResult.ok === false) {
    if (preflightResult.reason !== 'signature_mismatch') {
      await tryEmitValidationFailed('unknown', preflightResult.reason, correlationId);
      return res.status(401).json({ ok: false });
    }
    // `signature_mismatch` falls through to the post-DI path (needs real secret).
  }

  // 4. Required DI lookups for the rest of the handler — failure becomes 500 only after
  // pre-auth checks have completed. The `signature_mismatch` branch + the rare-but-possible
  // happy path with DUMMY_SECRET both need the real metrics/logger/tenantConfig to resolve.
  let metrics: SyncErrorAssistMetrics;
  let logger: Logger;
  try {
    [metrics, logger] = await Promise.all([
      container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics),
      container.getAsync<Logger>(TYPES.Logger),
    ]);
  } catch {
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
  const log = logger.withCorrelationId(correlationId);

  // 5. Per-tenant secret lookup (DI failure → 500)
  let tenantConfig: TenantConfigurationRepository;
  try {
    tenantConfig = await container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
  } catch {
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }
  const secret = await tenantConfig.getString(keyIdHeader, 'sync_error_assist.webhook_hmac_secret');

  // 5. HMAC verification with REAL secret — dummy-HMAC equalizes timing for unknown-tenant ↔
  // valid-tenant-bad-signature. The preflight above already returned 401 for syntax/time/
  // length-mismatch failures, so we know the only remaining cases are: signature_mismatch
  // against DUMMY (which may or may not match the real secret), or preflight-passed.
  const verifyResult = verifySuiteCentralWebhook(rawBody, req.headers, secret ?? DUMMY_SECRET);

  // R12-2 — Surface canonical HMAC reason BEFORE collapsing to `unknown_tenant`. Syntax /
  // time reasons (`malformed_timestamp`, `replay_window_exceeded`, `malformed_signature`,
  // `missing_header`) are independent of which secret was used — bucket them as themselves
  // regardless of whether the tenant is known. Only `signature_mismatch` against an unknown
  // tenant collapses to `unknown_tenant` (i.e., a well-formed, in-window, correct-length
  // signature for a tenant we don't have a secret for). Order matters: a malformed timestamp
  // sent to an unknown tenant must metric as `malformed_timestamp`, NOT `unknown_tenant`,
  // so operators can distinguish "attacker probing the endpoint" from "client clock skew".
  //
  // R13-1 — `tenantId` label collapses to `'unknown'` for EVERY `secret === null` branch
  // (not just `signature_mismatch`). Reason: never echo an attacker-supplied keyIdHeader
  // into the metrics tenant-label cardinality — unbounded label values would explode the
  // metric series count. The `reason` label still carries the canonical HMAC failure code
  // so observability stays precise; only the `tenant_id` label is collapsed.
  if (verifyResult.ok === false) {
    const tenantId = secret === null ? 'unknown' : keyIdHeader;
    const reason = secret === null && verifyResult.reason === 'signature_mismatch'
      ? 'unknown_tenant'
      : verifyResult.reason;
    metrics.recordWebhookValidationFailed(tenantId, reason);
    log.warn('webhook validation failed', { correlationId, reason, tenantId });
    return res.status(401).json({ ok: false });
  }
  // `verifyResult.ok === true` here. If `secret === null` we verified against DUMMY_SECRET —
  // astronomically unlikely to match, but defensively reject as `unknown_tenant`.
  if (secret === null) {
    // Spec gotcha #31 + R9-9 (cross-ref repaired) — bucket the unknown-tenant rejection separately; don't echo attacker-supplied keyId.
    metrics.recordWebhookValidationFailed('unknown', 'unknown_tenant');
    log.warn('webhook validation failed', { correlationId, reason: 'unknown_tenant', tenantId: 'unknown' });
    return res.status(401).json({ ok: false });
  }

  // HMAC verification succeeded against a real tenant secret — start the timer that
  // backs `sync_error_assist_webhook_e2e_latency_seconds` (help text:
  // "Signature-verified-to-claim-acked latency"). Set here rather than at handler entry
  // so the metric measures only post-auth work, matching the help text contract.
  signatureVerifiedAtMs = Date.now();

  // 6a. Body parse (R5-2 / spec §6 — body parse failure is `body_invalid` reason + 400 invalid_body code,
  //     distinct from schema validation failure which is `invalid_payload`).
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawBody.toString('utf8'));
  } catch {
    metrics.recordWebhookValidationFailed(keyIdHeader, 'body_invalid');
    log.warn('webhook validation failed', { correlationId, reason: 'body_invalid', tenantId: keyIdHeader });
    return res.status(400).json({ ok: false, code: 'invalid_body' });
  }

  // 6b. Schema validation (R5-2 / spec §6 — `invalid_payload`).
  //     R6-3 / spec §6 R4-7: response body NEVER includes `errors` (Zod's `.errors[]` echoes
  //     offending values back to the caller — leaks PII / tenant data). Server-side, log a
  //     SANITIZED issue summary (paths + Zod error codes only, NOT the offending values) so
  //     operators can debug schema rejections without exposing payload contents.
  let parsed;
  try {
    parsed = WebhookPayloadSchema.parse(parsedJson);
  } catch (err) {
    const issuesSummary = err instanceof z.ZodError
      ? err.issues.map((i) => ({ path: i.path.join('.'), code: i.code }))   // path + code only — no `received` / `expected` values
      : [{ code: 'unknown_validation_error' }];
    metrics.recordWebhookValidationFailed(keyIdHeader, 'invalid_payload');
    log.warn('webhook validation failed', {
      correlationId, reason: 'invalid_payload', tenantId: keyIdHeader, issues: issuesSummary,
    });
    return res.status(400).json({ ok: false, code: 'invalid_payload' });
  }
  if (parsed.tenantId !== keyIdHeader) {
    metrics.recordWebhookValidationFailed(keyIdHeader, 'tenant_mismatch');
    log.warn('webhook validation failed', { correlationId, reason: 'tenant_mismatch', tenantId: keyIdHeader });
    return res.status(400).json({ ok: false, code: 'tenant_mismatch' });
  }

  // R5-5 / spec §7.1 — "webhook received" event fires POST-AUTH with full fields.
  log.info('webhook received', {
    correlationId,
    tenantId: keyIdHeader,
    errorRecordId: parsed.errorRecordId,
    attempt: parsed.attemptCount ?? 0,
  });

  // 7. Post-auth tenant rate limiter (custom handler emits the rate_limited metric + constant body).
  //    Cached at module scope — the limiter holds per-key counters; recreating per request resets them (R2-1).
  //    Handler resolves metrics fresh from the container per call (R3-2).
  // R17-5 — Stash `correlationId` on `res.locals` BEFORE invoking the limiter so the
  // limiter's handler can read it back and include it in the "webhook validation failed"
  // warn log (spec §7.1 contract). The limiter handler runs in a separate function scope
  // where `correlationId` is not in lexical scope, so res.locals is the cleanest bridge.
  res.locals.syncErrorAssistCorrelationId = correlationId;
  if (!tenantPostAuthLimiter) {
    tenantPostAuthLimiter = makeTenantPostAuthLimiter();
  }
  const { handled } = await applyLimiter(tenantPostAuthLimiter, req, res);
  if (handled) return;

  // 8. Authenticated counter (R8-2 — spec §2.1 step 7-8 places this AFTER the tenant limiter,
  //    not before. Rate-limited requests intentionally do NOT increment this counter; they
  //    increment validation_failed{rate_limited} only. R7-5 was an over-eager move that
  //    contradicted the canonical request-flow ordering — reverted here.)
  metrics.recordWebhookAuthenticated(keyIdHeader);

  // 9. Feature flags — BOTH must be enabled (gotcha #32)
  const enabled = await tenantConfig.getBoolean(keyIdHeader, 'sync_error_assist.enabled');
  const webhookEnabled = await tenantConfig.getBoolean(keyIdHeader, 'sync_error_assist.webhook_enabled');
  if (!enabled || !webhookEnabled) {
    metrics.recordWebhookProcessed(keyIdHeader, 'disabled');
    log.info('webhook disabled', {
      correlationId, tenantId: keyIdHeader, errorRecordId: parsed.errorRecordId,
    });
    return res.status(200).json({ ok: false, reason: 'webhook_disabled' });
  }

  // 10. Resolve service + dispatch
  let service: SyncErrorAssistService;
  try {
    service = await container.getAsync<SyncErrorAssistService>(TYPES.SyncErrorAssistService);
  } catch {
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }

  // R6-1 / Copilot-PR766 — webhook is HMAC-authenticated; tenant identity is established
  // by the verified HMAC over keyIdHeader (and the tenantId-vs-keyIdHeader anti-spoof at
  // step 6b above). `extractIdentityContext(req)` falls back to SYSTEM_IDENTITY when
  // there's no req.auth/req.user — webhooks don't go through HTTP auth middleware, so that
  // fallback would attribute every AI call + audit row to the system sentinel instead of
  // the real tenant. Construct the identity directly from the HMAC-verified keyIdHeader.
  //
  // Use `SYSTEM_IDENTITY.userId` (imported from identityContext) for the userId field —
  // the CI gate `scripts/check-system-identity-isolation.mjs` forbids the literal
  // `"__system__"` anywhere in `src/` outside `identityContext.ts`.
  const ctx: IdentityContext = { tenantId: keyIdHeader, userId: SYSTEM_IDENTITY.userId };

  let result;
  try {
    result = await service.ingestWebhook({ tenantId: keyIdHeader, errorRecord: parsed, ctx, correlationId });
  } catch {
    return res.status(500).json({ ok: false, code: 'internal_error' });
  }

  metrics.recordWebhookE2eLatency(keyIdHeader, (Date.now() - signatureVerifiedAtMs) / 1000);
  metrics.recordWebhookProcessed(keyIdHeader, result.status === 'accepted' ? 'accepted' : 'duplicate');

  return res.status(202).json(
    result.status === 'duplicate'
      ? { status: 'duplicate' }
      : { status: 'accepted', claimId: result.claimId },
  );
  } catch (err) {
    // R17-4 — Outer safety net for awaits not covered by a branch-specific try/catch
    // (today: `tenantConfig.getString`, both `tenantConfig.getBoolean` calls, the
    // `applyLimiter` wrapper, plus any future await added to the handler). The `!res.headersSent`
    // guard prevents a "Cannot set headers after they are sent" crash if a response has
    // already been dispatched by an early `return res.status(...).json(...)` upstream
    // (e.g. the 429 from the post-auth tenant limiter, which calls `res.status(429).json(...)`
    // and resolves `applyLimiter` before any subsequent rejection could land here).
    //
    // NOTE: this path does NOT emit `webhook_validation_failed{...}` — that metric is for
    // contract-level validation outcomes (`invalid_payload`, `signature_mismatch`, etc.),
    // not for server-side faults. The existing branch-specific 500 catches (DI lookup
    // failures, `service.ingestWebhook` throws) also intentionally skip it. Conflating
    // server faults with validation outcomes would skew alerting/SLO dashboards.
    if (!res.headersSent) {
      return res.status(500).json({ ok: false, code: 'internal_error' });
    }
    // Headers already sent — log via console.error as a last resort (the handler may not have
    // resolved a Logger yet, and we can't risk another DI lookup from inside the catch).
    // eslint-disable-next-line no-console
    console.error('[sync-error-assist] unhandled error after response sent', { correlationId, err });
    return;
  }
});

// ---------------------------------------------------------------------------
// PR 17b: operator surface — list / accept / reject / escalate.
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const OPERATOR_ROLES = new Set(['ops', 'admin', 'finance']);

/**
 * Resolve the operator service via Inversify's async path. The container
 * binds `DatabaseService` via `toDynamicValue(async ...)` (see
 * `src/inversify/inversify.config.ts`), so any binding that transitively
 * depends on it can return a Promise from `.get()` if the singleton hasn't
 * been realized yet. `.getAsync()` always awaits the resolution chain, so
 * callers safely receive a fully constructed service.
 *
 * In production the singleton is realized during app boot (well before the
 * first request lands). The async wrapper is defensive — keeps the routes
 * correct under bootstrap-race scenarios that test setups have hit before.
 */
async function getOperatorService(): Promise<SyncErrorAssistOperatorService> {
  return container.getAsync<SyncErrorAssistOperatorService>(TYPES.SyncErrorAssistOperatorService);
}

/**
 * Narrow `req.body` to a plain Record so we can read fields without scattering
 * `as any` casts (Codex round-3 fix). Express types body as `any` by default;
 * the single contained cast inside this helper is materially better than
 * inline casts at every call-site.
 */
function asRecord(body: unknown): Record<string, unknown> {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }
  return {};
}

function getSessionContext(res: Response): { tenantId: string; userId: string; userRoles: string[] } {
  const session = res.locals.embeddedSession as EmbeddedSession;
  let userRoles: string[] = [];
  if (typeof session.user_roles === 'string' && session.user_roles.length > 0) {
    try {
      const parsed: unknown = JSON.parse(session.user_roles);
      if (Array.isArray(parsed) && parsed.every((r) => typeof r === 'string')) {
        userRoles = parsed as string[];
      }
    } catch {
      /* malformed JSON → empty array */
    }
  }
  return { tenantId: session.tenant_id, userId: session.user_id, userRoles };
}

function requireOperatorRole(_req: Request, res: Response, next: NextFunction): void {
  const { userRoles } = getSessionContext(res);
  if (!userRoles.some((r) => OPERATOR_ROLES.has(r))) {
    res.status(403).json({ ok: false, code: 'forbidden_role' });
    return;
  }
  next();
}

function statusForCode(code: OperatorResult['code']): number {
  switch (code) {
    case 'ok': return 200;
    case 'not_found': return 404;
    case 'already_dispositioned': return 409;
    case 'connector_unavailable': return 503;
    case 'write_failed': return 502;
  }
}

syncErrorAssistRoutes.get(
  '/api/sync-error-assist/suggestions',
  validateGuestContext,
  requireOperatorRole,
  async (req: Request, res: Response) => {
    const { tenantId } = getSessionContext(res);
    const rawLimit = Number(req.query.limit ?? DEFAULT_LIST_LIMIT);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;
    const operatorService = await getOperatorService();
    const items = await operatorService.list({ tenantId, limit });
    res.status(200).json({ items });
  },
);

syncErrorAssistRoutes.post(
  '/api/sync-error-assist/suggestions/:errorRecordId/accept',
  validateGuestContext,
  requireOperatorRole,
  // Signature includes `next` so the post-helper fall-through can route the
  // error to Express's error middleware via next(error) rather than throwing
  // out of an unwrapped async handler — which would surface as an unhandled
  // promise rejection and a hung request (Copilot R6). The other PR 3B
  // catch sites use either asyncHandler() OR `(req, res, next)` for the
  // same reason; this route had neither.
  async (req: Request, res: Response, next) => {
    const { tenantId, userId } = getSessionContext(res);
    const errorRecordId = req.params.errorRecordId;
    const body = asRecord(req.body);
    const applyAction = validateApplyAction(body.applyAction);
    if (!applyAction) {
      res.status(400).json({ ok: false, code: 'invalid_apply_action' });
      return;
    }
    try {
      const operatorService = await getOperatorService();
      const result = await operatorService.accept({
        tenantId, errorRecordId, userId, applyAction,
      });
      res.status(statusForCode(result.code)).json({
        ok: result.ok,
        code: result.code,
        ...(result.message ? { message: result.message } : {}),
        ...(result.appliedRecordId ? { appliedRecordId: result.appliedRecordId } : {}),
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'connector_write',
        resourceType: 'sync_error_assist.accept',
        resourceId: errorRecordId,
      })) return;
      next(error);
    }
  },
);

syncErrorAssistRoutes.post(
  '/api/sync-error-assist/suggestions/:errorRecordId/reject',
  validateGuestContext,
  requireOperatorRole,
  async (req: Request, res: Response) => {
    const { tenantId, userId } = getSessionContext(res);
    const errorRecordId = req.params.errorRecordId;
    const body = asRecord(req.body);
    const reason = typeof body.reason === 'string' ? body.reason : '';
    if (reason.length === 0) {
      res.status(400).json({ ok: false, code: 'missing_reason' });
      return;
    }
    const operatorService = await getOperatorService();
    const result = await operatorService.reject({ tenantId, errorRecordId, userId, reason });
    res.status(statusForCode(result.code)).json({ ok: result.ok, code: result.code });
  },
);

syncErrorAssistRoutes.post(
  '/api/sync-error-assist/suggestions/:errorRecordId/escalate',
  validateGuestContext,
  requireOperatorRole,
  async (req: Request, res: Response) => {
    const { tenantId, userId } = getSessionContext(res);
    const errorRecordId = req.params.errorRecordId;
    const body = asRecord(req.body);
    const note = typeof body.note === 'string' ? body.note : '';
    if (note.length === 0) {
      res.status(400).json({ ok: false, code: 'missing_note' });
      return;
    }
    const operatorService = await getOperatorService();
    const result = await operatorService.escalate({ tenantId, errorRecordId, userId, note });
    res.status(statusForCode(result.code)).json({ ok: result.ok, code: result.code });
  },
);
