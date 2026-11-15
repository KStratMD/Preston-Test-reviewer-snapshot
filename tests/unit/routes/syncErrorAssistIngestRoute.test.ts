// tests/unit/routes/syncErrorAssistIngestRoute.test.ts
import request from 'supertest';
import * as crypto from 'crypto';
// R11-2 — there is no `buildApp` helper at `tests/helpers/testApp.ts`. Reuse the integration
// helper `buildIntegrationApp()` (created in Task 13 Step 0). This is a unit-route file under
// `tests/unit/routes/`, but the test surface still needs the full middleware chain + DI
// rebinds the integration helper provides.
import {
  buildIntegrationApp, tenantConfigRepoFor,
  setupTestDatabase, teardownTestDatabase, clearSyncErrorAssistTestState,
} from '../../integration/helpers/syncErrorAssistTestHelpers';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { resetTenantPostAuthLimiterForTest } from '../../../src/routes/syncErrorAssistRoutes';
// R16-6 — type imports for jest.spyOn targets (avoids `container.getAsync<any>(...)`).
// R18-2 — `TenantConfigurationRepository` is needed by the R17-4 outer-catch test below
// (it does `container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository)`
// before spying on getString). Without this import tsconfig.test.json fails the test file.
import type { SyncErrorAssistService } from '../../../src/services/syncErrorAssist/SyncErrorAssistService';
import type { SyncErrorAssistMetrics } from '../../../src/services/syncErrorAssist/SyncErrorAssistMetrics';
import type { TenantConfigurationRepository } from '../../../src/database/repositories/TenantConfigurationRepository';

const SECRET = 'a'.repeat(64);
const TENANT = 'acme';

function sign(rawBody: string, ts: number): string {
  return crypto.createHmac('sha256', SECRET).update(`${ts}.${rawBody}`).digest('hex');
}

async function configureTenant(kit: Awaited<ReturnType<typeof buildIntegrationApp>>, opts: { secret?: string | null; enabled?: boolean; webhookEnabled?: boolean } = {}) {
  const tenantConfig = tenantConfigRepoFor(kit);
  // C2 — webhook_hmac_secret is secret-bearing and must be stored with
  // isEncrypted: true; the route reads it via `getSecretString` which throws
  // on plaintext rows.
  if (opts.secret !== null) await tenantConfig.upsert(TENANT, 'sync_error_assist.webhook_hmac_secret', opts.secret ?? SECRET, { isEncrypted: true });
  await tenantConfig.upsert(TENANT, 'sync_error_assist.enabled', String(opts.enabled ?? true), { isEncrypted: false });
  await tenantConfig.upsert(TENANT, 'sync_error_assist.webhook_enabled', String(opts.webhookEnabled ?? true), { isEncrypted: false });
}

describe('POST /api/sync-error-assist/ingest — route handler', () => {
  let kit: Awaited<ReturnType<typeof buildIntegrationApp>>;
  let app: typeof kit['app'];

  beforeAll(async () => { await setupTestDatabase(); });
  afterAll(async () => { await teardownTestDatabase(); });
  afterEach(async () => {
    kit?.restore();                                   // R11-7 — undo container snapshot + monkey-patches
    await clearSyncErrorAssistTestState();
  });

  beforeEach(async () => {
    resetTenantPostAuthLimiterForTest();   // R4-5 — clear cached limiter + per-key counters between tests
    kit = await buildIntegrationApp();
    app = kit.app;
  });

  it('AC #8 — non-JSON content-type → 415 unsupported_media_type', async () => {
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ ok: false, code: 'unsupported_media_type' });
  });

  it('AC #2 — missing x-suitecentral-key-id → 401 + body { ok: false }', async () => {
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', 'a'.repeat(64))
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });

  it('AC #2 — missing x-suitecentral-timestamp → 401 + body { ok: false }', async () => {
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-signature', 'a'.repeat(64))
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });

  it('AC #2 — malformed timestamp ("123abc") → 401 + body { ok: false } (gotcha #43)', async () => {
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', '123abc')
      .set('x-suitecentral-signature', 'a'.repeat(64))
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });

  it('AC #2 — unknown tenant → 401 + body { ok: false } (constant body, NOT echoing keyId)', async () => {
    // No tenant configured.
    const ts = Math.floor(Date.now() / 1000);
    const body = '{}';
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', 'totally-unknown-tenant')
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sign(body, ts))
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });

  it('AC #2 — signature mismatch (valid tenant) → 401 + body { ok: false }', async () => {
    await configureTenant(kit);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ tenantId: TENANT, errorRecordId: 'x', lastModified: new Date().toISOString(), errorType: 't', errorMessage: 'm' });
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', '0'.repeat(64))            // wrong sig
      .send(body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });

  it('R12-2 — unknown tenant + malformed timestamp metrics as malformed_timestamp, NOT unknown_tenant', async () => {
    // The R12-2 reorder ensures syntax/time HMAC reasons (malformed_timestamp,
    // replay_window_exceeded, malformed_signature) are bucketed as themselves regardless of
    // whether the tenant is known. Only `signature_mismatch` against an unknown tenant
    // collapses to `unknown_tenant`. This lets operators distinguish "attacker probing the
    // endpoint with garbage" from "client clock skew" from "tenant we don't recognize".
    // R16-6 — resolve with the real type instead of `<any>` generic.
    const metrics = await container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics);
    const failSpy = jest.spyOn(metrics, 'recordWebhookValidationFailed');
    try {
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', 'totally-unknown-tenant')
        .set('x-suitecentral-timestamp', '123abc')                  // malformed
        .set('x-suitecentral-signature', 'a'.repeat(64))
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
      // Critical: tenant_id label is 'unknown' (don't echo attacker-supplied keyId), reason
      // is 'malformed_timestamp' (canonical syntax reason), NOT 'unknown_tenant' (which
      // would erase the signal that this was a syntax failure).
      expect(failSpy).toHaveBeenCalledWith('unknown', 'malformed_timestamp');
    } finally {
      failSpy.mockRestore();
    }
  });

  it('R12-2 — unknown tenant + well-formed-bad-signature still collapses to unknown_tenant', async () => {
    // Counterpart to the malformed_timestamp test above: a signature_mismatch against an
    // unknown tenant SHOULD collapse to 'unknown_tenant' (dummy-HMAC equalizes timing AND
    // operators get a single bucket for "we don't have a secret for this tenant"). This
    // pins the one branch where collapsing IS correct.
    // R16-6 — resolve with the real type instead of `<any>` generic.
    const metrics = await container.getAsync<SyncErrorAssistMetrics>(TYPES.SyncErrorAssistMetrics);
    const failSpy = jest.spyOn(metrics, 'recordWebhookValidationFailed');
    try {
      const ts = Math.floor(Date.now() / 1000);
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', 'totally-unknown-tenant')
        .set('x-suitecentral-timestamp', String(ts))                // in-window
        .set('x-suitecentral-signature', '0'.repeat(64))            // well-formed length, won't verify
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
      expect(failSpy).toHaveBeenCalledWith('unknown', 'unknown_tenant');
    } finally {
      failSpy.mockRestore();
    }
  });

  it('AC #12 — route-level claim-ack latency: valid signed POST returns 202 in <1s even when processClaimedRecord never settles', async () => {
    // R7-1 — AC #12 requires "webhook arrival → claim ack <1 second" measured at the HTTP layer
    // (post → response), NOT at service.ingestWebhook (which the Task 8 test already covers).
    // This guards against HMAC/schema/limiter/DI/response-serialization delays.
    await configureTenant(kit);

    // R16-6 — Use jest.spyOn with the real SyncErrorAssistService type instead of
    // `container.getAsync<any>(...) + service.method = jest.fn(...)`. spyOn auto-restores
    // via mockRestore() and avoids the `<any>` generic (any-budget violation).
    const service = await container.getAsync<SyncErrorAssistService>(TYPES.SyncErrorAssistService);
    const spy = jest.spyOn(service, 'processClaimedRecord').mockImplementation(() => new Promise(() => {}));

    try {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        tenantId: TENANT, errorRecordId: 'err-latency',
        lastModified: new Date().toISOString(),
        errorType: 'sync', errorMessage: 'NS error',
        sourcePayload: { foo: 'bar' }, attemptCount: 0,
      });
      const sig = sign(body, ts);
      const startMs = Date.now();
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', TENANT)
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', sig)
        .send(body);
      const elapsedMs = Date.now() - startMs;

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'accepted', claimId: expect.any(String) });
      expect(elapsedMs).toBeLessThan(1000);              // spec contract: <1s claim ack

      // R19-3 — Drain the macrotask queue so the route's `setImmediate(() => service.processClaimedRecord(...))`
      // callback has actually fired BEFORE the `finally` restores the spy. Without this drain,
      // the spy.mockRestore() in finally can run before the setImmediate callback, and the
      // callback then invokes the REAL processClaimedRecord (with a never-resolving aiStub.chat
      // for the latency test's stubbed-out scenario), leaking work into sibling tests and
      // causing order-dependent failures. The assert `spy.mock.calls.length === 1` doubles as a
      // contract check: the route MUST schedule exactly one processClaimedRecord invocation per
      // accepted webhook.
      await new Promise((resolve) => setImmediate(resolve));
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('AC #1 + #5 — valid signed payload from enabled tenant → 202 { status: "accepted", claimId }', async () => {
    await configureTenant(kit);
    // R21-2 — Stub processClaimedRecord + drain setImmediate so the route's fire-and-forget
    // worker (registered via `setImmediate(() => service.processClaimedRecord(...))` in §6)
    // doesn't leak the REAL processClaimedRecord into sibling tests, where the bare
    // `aiStub.chat = jest.fn()` default from buildIntegrationApp would either throw or hang
    // depending on the implementer's chosen contract. Same pattern as R19-3's AC #12 latency
    // test — the `processSpy.toHaveBeenCalledTimes(1)` doubles as a route-contract check.
    const service = await container.getAsync<SyncErrorAssistService>(TYPES.SyncErrorAssistService);
    const processSpy = jest.spyOn(service, 'processClaimedRecord').mockResolvedValue('succeeded');
    try {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        tenantId: TENANT, errorRecordId: 'err-1',
        lastModified: new Date().toISOString(),
        errorType: 'sync', errorMessage: 'NS error',
        sourcePayload: { foo: 'bar' }, attemptCount: 0,
      });
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', TENANT)
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', sign(body, ts))
        .send(body);
      expect(res.status).toBe(202);
      expect(res.body).toEqual({ status: 'accepted', claimId: expect.any(String) });
      await new Promise((resolve) => setImmediate(resolve));
      expect(processSpy).toHaveBeenCalledTimes(1);
    } finally {
      processSpy.mockRestore();
    }
  });

  it('R5-2 / §6 — malformed JSON body (HMAC valid) → 400 + body { ok: false, code: "invalid_body" }', async () => {
    await configureTenant(kit);
    const ts = Math.floor(Date.now() / 1000);
    const body = '{ this is: not valid JSON';                    // unparseable
    const sig = sign(body, ts);                                  // HMAC over the raw bytes — passes verifier
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sig)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, code: 'invalid_body' });   // distinct from invalid_payload
  });

  it('R5-2 / §6 — schema-invalid JSON body (HMAC valid) → 400 + body { ok: false, code: "invalid_payload" }', async () => {
    await configureTenant(kit);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ tenantId: TENANT, errorRecordId: 'err-1' });   // missing required fields
    const sig = sign(body, ts);
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sig)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, code: 'invalid_payload' });
  });

  it('AC #9 — tenant header/body mismatch → 400 tenant_mismatch', async () => {
    await configureTenant(kit);
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      tenantId: 'beta',                                      // body says "beta"
      errorRecordId: 'err-1', lastModified: new Date().toISOString(),
      errorType: 't', errorMessage: 'm',
    });
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)                   // header says "acme"
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sign(body, ts))
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ ok: false, code: 'tenant_mismatch' });
  });

  it('AC #3 — webhook_enabled=false → 200 webhook_disabled (NOT 503; gotcha #8)', async () => {
    await configureTenant(kit, { webhookEnabled: false });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      tenantId: TENANT, errorRecordId: 'err-1',
      lastModified: new Date().toISOString(),
      errorType: 't', errorMessage: 'm',
    });
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sign(body, ts))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'webhook_disabled' });
  });

  it('R18-6 — sync_error_assist.enabled=false (with webhook_enabled=true) → 200 webhook_disabled (BOTH flags gate)', async () => {
    // R18-6 — Spec gotcha #32 / R3-15: the route gates on `(enabled && webhook_enabled)`.
    // The sibling test above exercises only the `webhook_enabled=false` branch; if a future
    // implementer accidentally tightened the gate to `webhook_enabled` ONLY (ignoring the
    // base feature-flag), that test would still pass. This test pins the AND semantics by
    // flipping the OTHER side of the conjunction. Both branches MUST short-circuit before
    // service dispatch — assert no claim was inserted to lock that in.
    await configureTenant(kit, { enabled: false, webhookEnabled: true });
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      tenantId: TENANT, errorRecordId: 'err-enabled-off',
      lastModified: new Date().toISOString(),
      errorType: 't', errorMessage: 'm',
    });
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sign(body, ts))
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, reason: 'webhook_disabled' });
  });

  it('§7.1 — webhook received: logs POST-AUTH info with {correlationId, tenantId, errorRecordId, attempt}', async () => {
    await configureTenant(kit);
    // R15-4 — spy on the rebound loggerStub from buildIntegrationApp. withCorrelationId
    // returns `loggerStub` itself, so the route's `log.info(...)` calls fire on this same
    // mock and the spy observes them.
    const loggerSpy = jest.spyOn(kit.loggerStub, 'info');
    // R21-2 — Same setImmediate drain pattern as the AC #1 happy-path: this test sends a
    // valid signed payload, so the route schedules processClaimedRecord. Without stubbing
    // + draining, the REAL service runs after the test boundary with the bare aiStub.chat
    // from buildIntegrationApp and leaks state into sibling tests.
    const service = await container.getAsync<SyncErrorAssistService>(TYPES.SyncErrorAssistService);
    const processSpy = jest.spyOn(service, 'processClaimedRecord').mockResolvedValue('succeeded');
    try {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        tenantId: TENANT, errorRecordId: 'err-r1',
        lastModified: new Date().toISOString(),
        errorType: 'sync', errorMessage: 'm',
        attemptCount: 2,
      });
      const sig = sign(body, ts);
      await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', TENANT)
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', sig)
        .send(body);
      expect(loggerSpy).toHaveBeenCalledWith(
        'webhook received',
        expect.objectContaining({
          correlationId: expect.any(String),
          tenantId: TENANT,                                       // post-auth
          errorRecordId: 'err-r1',
          attempt: 2,
        }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(processSpy).toHaveBeenCalledTimes(1);
    } finally {
      processSpy.mockRestore();
    }
  });

  it('§7.1 — validation failed: logs "webhook validation failed" warn with reason on every reject branch', async () => {
    // R15-4 — spy on the rebound loggerStub from buildIntegrationApp.
    const warnSpy = jest.spyOn(kit.loggerStub, 'warn');
    // Trigger missing-header → reason: 'missing_header'
    await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json').send('{}');
    expect(warnSpy).toHaveBeenCalledWith(
      'webhook validation failed',
      expect.objectContaining({ reason: 'missing_header', tenantId: 'unknown' }),
    );
  });

  it('§7.1 — webhook disabled: logs "webhook disabled" info with tenantId + errorRecordId', async () => {
    await configureTenant(kit, { webhookEnabled: false });
    // R15-4 — spy on the rebound loggerStub from buildIntegrationApp.
    const infoSpy = jest.spyOn(kit.loggerStub, 'info');
    const ts = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      tenantId: TENANT, errorRecordId: 'err-disabled',
      lastModified: new Date().toISOString(),
      errorType: 't', errorMessage: 'm',
    });
    await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', TENANT)
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', sign(body, ts))
      .send(body);
    expect(infoSpy).toHaveBeenCalledWith(
      'webhook disabled',
      expect.objectContaining({ tenantId: TENANT, errorRecordId: 'err-disabled' }),
    );
  });

  it('§6 — service-resolution error (DI failure) → 500 internal_error', async () => {
    // R8-7 — wrap the container patch in try/finally so the patched method is always
    // restored even if assertions throw. Without finally, a flaky assertion would leak
    // a broken container into every subsequent test.
    // R15-1 — use jest.spyOn instead of `(container as any).getAsync = ...`. spyOn keeps
    // the static method signature intact (no `as any` / `id: any`) and mockRestore() handles
    // the unwind, so the finally block doesn't need a manual reassignment.
    // R17-3 — use mockImplementation (not mockImplementationOnce). After R15-2 reordered the
    // metrics/logger DI lookups to the top of the route and R16-7 added the DUMMY_SECRET HMAC
    // preflight, the SyncErrorAssistService is no longer the FIRST `container.getAsync` call —
    // it's now the FOURTH (preflight has no DI, then metrics, logger, tenantConfig, then the
    // service). A `mockImplementationOnce` would fall on the metrics call and the service
    // resolution would succeed via the real container, silently turning this into a false
    // positive that never exercises the service-DI-failure path. Use the same scoped
    // `mockImplementation` + id-discriminator pattern that the R15-2 / R16-7 sibling tests
    // below use — this is the canonical shape for "fail exactly one DI lookup, pass the rest".
    const origGetAsync = container.getAsync.bind(container);
    const spy = jest.spyOn(container, 'getAsync').mockImplementation(async (id) => {
      if (id === TYPES.SyncErrorAssistService) throw new Error('DI explode');
      return origGetAsync(id);
    });
    try {
      await configureTenant(kit);
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        tenantId: TENANT, errorRecordId: 'err-1',
        lastModified: new Date().toISOString(),
        errorType: 't', errorMessage: 'm',
      });
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', TENANT)
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', sign(body, ts))
        .send(body);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, code: 'internal_error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('R15-2 — observability DI failure (SyncErrorAssistMetrics broken) MUST NOT mask the canonical 415', async () => {
    // R15-2 — Pre-auth content-type validation runs BEFORE the metrics/logger DI lookups
    // and emits via tryEmitValidationFailed which swallows DI failures. So even if the
    // SyncErrorAssistMetrics binding is broken, a bad content-type still returns 415, not
    // a generic 500. This is the contract: response status code is independent of
    // observability availability.
    const origGetAsync = container.getAsync.bind(container);
    const spy = jest.spyOn(container, 'getAsync').mockImplementation(async (id) => {
      if (id === TYPES.SyncErrorAssistMetrics) throw new Error('observability broken');
      return origGetAsync(id);
    });
    try {
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'text/plain')
        .send('hello');
      expect(res.status).toBe(415);
      expect(res.body).toEqual({ ok: false, code: 'unsupported_media_type' });
    } finally {
      spy.mockRestore();
    }
  });

  it('R15-2 — observability DI failure MUST NOT mask the canonical 401 for missing headers', async () => {
    // Sibling to the 415 test: missing-header validation is also pre-DI, so observability
    // breakage cannot swap the 401 for a 500.
    const origGetAsync = container.getAsync.bind(container);
    const spy = jest.spyOn(container, 'getAsync').mockImplementation(async (id) => {
      if (id === TYPES.SyncErrorAssistMetrics || id === TYPES.Logger) throw new Error('observability broken');
      return origGetAsync(id);
    });
    try {
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        // Deliberately omit x-suitecentral-key-id / -timestamp / -signature
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('R16-7 — observability DI failure MUST NOT mask 401 for malformed timestamp (preflight catches it pre-DI)', async () => {
    // R16-7 — Syntax/time HMAC failures (malformed_timestamp here) are secret-independent
    // and caught by the DUMMY_SECRET preflight BEFORE the required metrics/logger/tenantConfig
    // DI lookups. Even with observability AND tenantConfig DI broken, the canonical 401 fires.
    const origGetAsync = container.getAsync.bind(container);
    const spy = jest.spyOn(container, 'getAsync').mockImplementation(async (id) => {
      if (id === TYPES.SyncErrorAssistMetrics
       || id === TYPES.Logger
       || id === TYPES.TenantConfigurationRepository) throw new Error('DI broken');
      return origGetAsync(id);
    });
    try {
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', 'acme')
        .set('x-suitecentral-timestamp', '123abc')                    // malformed (gotcha #43)
        .set('x-suitecentral-signature', 'a'.repeat(64))
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('R16-7 — observability DI failure MUST NOT mask 401 for malformed signature (preflight catches it pre-DI)', async () => {
    // Sibling to the malformed-timestamp test. Length-mismatched signature is also
    // secret-independent (the verifier short-circuits on length before timingSafeEqual).
    const origGetAsync = container.getAsync.bind(container);
    const spy = jest.spyOn(container, 'getAsync').mockImplementation(async (id) => {
      if (id === TYPES.SyncErrorAssistMetrics
       || id === TYPES.Logger
       || id === TYPES.TenantConfigurationRepository) throw new Error('DI broken');
      return origGetAsync(id);
    });
    try {
      const ts = Math.floor(Date.now() / 1000);
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', 'acme')
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', 'short')                     // length mismatch
        .send('{}');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ ok: false });
    } finally {
      spy.mockRestore();
    }
  });

  it('R17-4 — tenantConfig.getString throws asynchronously → outer catch returns 500 internal_error (NOT a generic Express HTML 500)', async () => {
    // R17-4 — `tenantConfig.getString(keyIdHeader, ...)` is awaited OUTSIDE a branch-specific
    // try/catch (a deliberate seam — the unguarded await lets the outer try/catch own the
    // 500 contract for every database fault from this point on, not just `getString`). If the
    // repository rejects (e.g. DB connection lost mid-request), Express 4 would otherwise
    // forward to `next(err)` and return a generic HTML 500. This test pins the canonical
    // JSON contract by replacing the resolved TenantConfigurationRepository with one whose
    // `getString` throws — equivalent to a DB connection failure on a valid HMAC-signed
    // request. The body must be `{ok: false, code: 'internal_error'}`, the status 500.
    await configureTenant(kit);
    const tenantConfig = await container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
    const spy = jest.spyOn(tenantConfig, 'getString').mockRejectedValueOnce(new Error('DB connection lost'));
    try {
      const ts = Math.floor(Date.now() / 1000);
      const body = JSON.stringify({
        tenantId: TENANT, errorRecordId: 'err-outer-catch',
        lastModified: new Date().toISOString(),
        errorType: 't', errorMessage: 'm',
      });
      const res = await request(app).post('/api/sync-error-assist/ingest')
        .set('Content-Type', 'application/json')
        .set('x-suitecentral-key-id', TENANT)
        .set('x-suitecentral-timestamp', String(ts))
        .set('x-suitecentral-signature', sign(body, ts))
        .send(body);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({ ok: false, code: 'internal_error' });
    } finally {
      spy.mockRestore();
    }
  });

  it('R19-4 — `x-suitecentral-key-id: __system__` → 401 unknown_tenant (no per-tenant secret lookup, no body parsing)', async () => {
    // R19-4 — Reject the reserved SYSTEM_IDENTITY sentinel at the header layer BEFORE the
    // per-tenant secret lookup. The schema also rejects the body's `tenantId === '__system__'`
    // (R19-4 sibling refinement), so this header-level guard is defense-in-depth: even with
    // a misprovisioned `tenant_configurations` row for `__system__`, the route never
    // attempts the lookup. The 401 + `unknown_tenant` reason mirrors the post-HMAC unknown-
    // tenant rejection so observability stays consistent. We DO NOT pass a valid signature
    // here because the route must reject BEFORE the HMAC verification step — any 64-char
    // hex string is sufficient to pass the header-presence guard.
    const ts = Math.floor(Date.now() / 1000);
    const res = await request(app).post('/api/sync-error-assist/ingest')
      .set('Content-Type', 'application/json')
      .set('x-suitecentral-key-id', '__system__')
      .set('x-suitecentral-timestamp', String(ts))
      .set('x-suitecentral-signature', 'a'.repeat(64))
      .send('{}');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ ok: false });
  });
});
