/**
 * Test helpers for sync-error-assist operator integration tests (PR 17b / PR 17c).
 *
 * Bridges the inversify container to an in-memory sqlite DatabaseService and
 * provides seeders for embedded_sessions + sync_error_assist_processed plus
 * audit_logs lookups for assertions.
 *
 * Extended in PR 17c (T13 Step 0) with integration-app seams:
 *   buildIntegrationApp / tenantConfigRepoFor / syncErrorRepoFor / waitFor.
 */
import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { register } from 'prom-client';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { Logger } from '../../../src/utils/Logger';
import { SESSION_MAX_LIFETIME_MS } from '../../../src/embedded/contract/PostMessageProtocol';
import express, { type Express } from 'express';
import rateLimit from 'express-rate-limit';
import type { TenantConfigurationRepository } from '../../../src/database/repositories/TenantConfigurationRepository';
import type { SyncErrorAssistRepository } from '../../../src/services/syncErrorAssist/SyncErrorAssistRepository';
import type { SyncErrorAssistService } from '../../../src/services/syncErrorAssist/SyncErrorAssistService';
// C2 — type-only import; the rebind below uses an in-memory mock cast through
// `as unknown as SecretManager` (only `getSecret`/`setSecret` are exercised).
import type { SecretManager } from '../../../src/services/SecretManager';
// R16-8 — buildIntegrationApp resolves ConnectorManager + ProviderRegistry as their real
// types (R15-1 spyOn pattern). These type imports were missing from the helper file's import
// block; without them, the `container.getAsync<ConnectorManager>(...)` + `<ProviderRegistry>(...)`
// generics fail compilation in tsconfig.test.json.
import type { ConnectorManager } from '../../../src/services/integration/ConnectorManager';
import type { ProviderRegistry } from '../../../src/services/ai/ProviderRegistry';
import { syncErrorAssistRoutes, resetTenantPostAuthLimiterForTest } from '../../../src/routes/syncErrorAssistRoutes';
import { resetIpPreAuthLimiterDepsForTest, resetIpPreAuthLimiterForTest } from '../../../src/middleware/setup/MiddlewareSetup';

let initializedDb: DatabaseService | null = null;

/**
 * Build an in-memory sqlite DatabaseService and rebind the container so every
 * service resolved after this point sees the same DB instance (synchronously).
 *
 * Call once in beforeAll. Idempotent: a second call returns the cached service.
 */
export async function setupTestDatabase(): Promise<DatabaseService> {
  if (initializedDb !== null) return initializedDb;

  process.env.DB_TYPE = 'sqlite';
  process.env.SQLITE_DB_PATH = ':memory:';

  const logger = new Logger('sync-error-assist-routes-test');
  const db = new DatabaseService(logger);
  await db.initialize();

  if (container.isBound(TYPES.DatabaseService)) {
    container.unbind(TYPES.DatabaseService);
  }
  container.bind<DatabaseService>(TYPES.DatabaseService).toConstantValue(db);

  initializedDb = db;
  return db;
}

/**
 * Tear down the rebound database. Call once in afterAll.
 */
export async function teardownTestDatabase(): Promise<void> {
  if (initializedDb === null) return;
  await initializedDb.shutdown();
  initializedDb = null;
}

function getDb() {
  if (initializedDb === null) {
    throw new Error('setupTestDatabase() must be called before any seeder or query helper.');
  }
  return initializedDb.getDatabase();
}

export async function seedEmbeddedSession(args: {
  tenantId: string;
  userId: string;
  userRoles?: string[];
  expectedHostOrigin?: string;
}): Promise<string> {
  const sessionId = `es_test_${randomUUID()}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_LIFETIME_MS);
  await getDb()
    .insertInto('embedded_sessions')
    .values({
      session_id: sessionId,
      tenant_id: args.tenantId,
      user_id: args.userId,
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: `csrf_test_${randomUUID()}`,
      expected_host_origin: args.expectedHostOrigin ?? 'http://localhost:3000',
      expires_at: expiresAt.toISOString(),
      last_rotation_at: null,
      erp_record_type: null,
      erp_record_id: null,
      erp_record_url: null,
      user_roles: JSON.stringify(args.userRoles ?? ['ops']),
    })
    .execute();
  return sessionId;
}

export async function seedSuggestion(args: {
  tenantId: string;
  errorRecordId: string;
  status?: string;
  operatorDisposition?: string;
  confidence?: 'high' | 'mid' | 'low' | null;
  suggestionType?: string | null;
  suggestionText?: string | null;
}): Promise<void> {
  await getDb()
    .insertInto('sync_error_assist_processed')
    .values({
      id: randomUUID(),
      tenant_id: args.tenantId,
      error_record_id: args.errorRecordId,
      status: args.status ?? 'succeeded',
      attempts: 1,
      suggestion_record_id: `ns_sugg_${randomUUID()}`,
      trace_id: `trace_${randomUUID()}`,
      provider: 'cloud-api',
      cost_estimate_usd_cents: 12,
      confidence: args.confidence ?? 'high',
      suggestion_type: args.suggestionType ?? 'create_missing_record',
      suggestion_text: args.suggestionText ?? 'Create the missing item.',
      references_field: null,
      failure_reason: null,
      reserved_at: new Date().toISOString(),
      completed_at: new Date().toISOString(),
      operator_disposition: args.operatorDisposition ?? 'pending',
      operator_disposition_at: null,
      operator_disposition_user_id: null,
    })
    .execute();
}

export async function fetchAuditLogsByAction(action: string) {
  return getDb()
    .selectFrom('audit_logs')
    .selectAll()
    .where('action', '=', action)
    .execute();
}

export async function clearSyncErrorAssistTestState(): Promise<void> {
  const db = getDb();
  await sql`DELETE FROM audit_logs WHERE action LIKE 'sync_error_assist.%'`.execute(db);
  await sql`DELETE FROM sync_error_assist_processed`.execute(db);
  await sql`DELETE FROM embedded_sessions WHERE session_id LIKE 'es_test_%'`.execute(db);
  // R13-4 — purge tenant_configurations rows written by buildIntegrationApp() so
  // secondary kits don't leak stale enabled-flag state across tests.
  await sql`DELETE FROM tenant_configurations WHERE setting_key LIKE 'sync_error_assist.%'`.execute(db);
  // Clear the prom-client default registry so each test's `buildIntegrationApp()` call can
  // create fresh SyncErrorAssistMetrics counters without triggering "metric already registered"
  // errors. Mirrors the `register.clear()` pattern used in syncErrorAssist.fixture.test.ts.
  register.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// T13 Step 0: Integration-app seams (R7-3 / R8-4 / R8-5 / R8-6 / R11-7 /
//             R12-3 / R13-2 / R13-4 / R14-3 / R15-1 / R15-4 / R16-8 /
//             R18-7 / R19-2 / R22-2)
// ─────────────────────────────────────────────────────────────────────────────

/** Test-only Jest mock surface for an AIProvider — only the methods PR 17c calls.
 * R17-1 — Structurally complete vs `AIProvider` interface at src/services/ai/providers/types.ts:47.
 * After R16-2 added tsconfig.test.json, this stub flows through `runCycle(..., providerInfo)` /
 * `processClaimedRecord({..., providerInfo})` which type-check against the real `ResolvedProvider`
 * → `AIProvider` boundary. Without `isAvailable`, `getCapabilities`, `suggest`, `assessQuality`,
 * `testConnection` the literal would not compile when handed to those methods. The unused
 * methods are harmless `jest.fn()` stubs; tests can still override per-call via `mockResolvedValue`
 * if they want to drive those code paths in the future.
 */
export function makeIntegrationAiProviderStub() {
  return {
    mode: 'cloud-api' as const,
    isAvailable: true,
    chat: jest.fn(),
    getLastTokenUsage: jest.fn().mockReturnValue({ estimatedCost: 0, totalTokens: 0 }),
    getCapabilities: jest.fn().mockResolvedValue({
      models: ['claude-3-5-sonnet'],
      maxTokens: 200000,
      supportsTools: true,
      supportsStreaming: true,
    }),
    suggest: jest.fn(),
    assessQuality: jest.fn(),
    testConnection: jest.fn().mockResolvedValue({ ok: true }),
  };
}

/** Test-only Jest mock surface for the NetSuite connector. */
export function makeIntegrationNsConnectorStub() {
  return {
    search: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ id: 'ns-test-1' }),
  };
}

/**
 * R15-4 — Test-only Jest mock surface for a Logger. `withCorrelationId()` returns the
 * SAME mock object so spies on `info/warn/error` observe calls the route makes on the
 * correlation-bound child. Production `Logger.withCorrelationId` returns a new child
 * instance (Logger.ts:103), which would silently miss any spy attached to the parent.
 */
export function makeIntegrationLoggerStub() {
  const log = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    withCorrelationId: jest.fn(),
  };
  log.withCorrelationId.mockReturnValue(log);
  return log;
}

export interface IntegrationAppKit {
  app: Express;
  aiProviderStub: ReturnType<typeof makeIntegrationAiProviderStub>;
  nsConnectorStub: ReturnType<typeof makeIntegrationNsConnectorStub>;
  /** R15-4 — bound to TYPES.Logger as a singleton; tests spy directly on its methods. */
  loggerStub: ReturnType<typeof makeIntegrationLoggerStub>;
  syncErrorAssistService: SyncErrorAssistService;
  tenantConfigRepo: TenantConfigurationRepository;
  syncErrorRepo: SyncErrorAssistRepository;
  providerId: string;
  /** R11-7 — restore the container snapshot + put back the monkey-patched methods. Call
   *  in `afterEach` so later test files don't inherit this kit's stubs.
   *
   *  R12-3 — LIFO ordering is REQUIRED. `container.snapshot()/restore()` is a stack: if a
   *  test creates a SECONDARY kit on top of an outer `beforeEach` kit, the secondary kit's
   *  `restore()` MUST be called BEFORE the outer kit's `restore()`. The canonical pattern
   *  for secondary kits inside `it()` blocks is:
   *
   *      const secondaryKit = await buildIntegrationApp({ ... });
   *      try {
   *        // ... test body uses secondaryKit ...
   *      } finally {
   *        secondaryKit.restore();   // pops secondary's snapshot first
   *      }
   *
   *  The outer afterEach then calls `kit.restore()` to pop the primary snapshot. Violating
   *  this order pops the wrong snapshot and leaves later tests with the secondary's
   *  monkey-patches still in place on the resolved singleton instances. */
  restore(): void;
}

/**
 * R8-4 — patches `connectorManager.getConnector` for 'netsuite' + replaces
 * `providerRegistry.getAvailableProvider` so Task 13's
 * `kit.aiProviderStub.chat.mockResolvedValueOnce(...)` and
 * `kit.nsConnectorStub.search.mockResolvedValueOnce(...)` attach to fresh Jest mocks
 * rather than production singletons.
 *
 * R9-4 — `ipLimitOverride` raises the pre-auth IP limit for tests that need to send
 * many requests from a single test client (e.g. the post-auth tenant-rate-limit tests).
 * Default 30/min matches production.
 */
export async function buildIntegrationApp(opts: { ipLimitOverride?: number } = {}): Promise<IntegrationAppKit> {
  resetTenantPostAuthLimiterForTest();
  resetIpPreAuthLimiterDepsForTest();
  // R16-8 + R15-3 — recreate the IP limiter so the counter store starts at 0 per build.
  resetIpPreAuthLimiterForTest();

  const aiProviderStub = makeIntegrationAiProviderStub();
  const nsConnectorStub = makeIntegrationNsConnectorStub();
  const loggerStub = makeIntegrationLoggerStub();

  // R11-7 — container.snapshot()/restore() is the canonical Inversify pattern for
  // test-scoped binding mutations. Take a snapshot BEFORE patching so afterEach can
  // restore() and prevent later tests from inheriting our stubs. The snapshot/restore
  // pair is exposed on the kit so tests can wire it into their afterEach hook.
  container.snapshot();

  // R15-4 — Rebind TYPES.Logger to a constant-value mock whose withCorrelationId() returns
  // itself. Without this, the route's `log = logger.withCorrelationId(correlationId)` creates
  // a fresh Logger instance (Logger.ts:103), and `jest.spyOn(await container.getAsync(TYPES.Logger), 'info')`
  // attaches the spy to the parent — missing every child-bound log call. The rebind is popped
  // by `container.restore()` in the kit's `restore()` method below.
  container.rebind<typeof loggerStub>(TYPES.Logger).toConstantValue(loggerStub);

  // C2 — Bind an in-memory SecretManager mock so `isEncrypted: true` writes/reads
  // work for integration tests. The production async factory binding resolves to
  // `SecretManagerStub` (provider='env'), whose `setSecret` rejects — that blocks
  // the encrypted-at-rest write path that C2 requires for secret-bearing settings
  // like `sync_error_assist.webhook_hmac_secret`. The mock is signature-compatible
  // with the two methods `TenantConfigurationRepository` calls (`getSecret`,
  // `setSecret`); the repo never consults SecretManager for plaintext rows, so
  // pre-existing `isEncrypted: false` fixtures keep using the unchanged plaintext
  // branch and don't observe the mock.
  const secretManagerStore = new Map<string, string>();
  container.rebind<SecretManager>(TYPES.SecretManager).toConstantValue({
    getSecret: jest.fn(async (name: string) => {
      if (!secretManagerStore.has(name)) throw new Error(`secret '${name}' not found`);
      return { value: secretManagerStore.get(name) as string };
    }),
    setSecret: jest.fn(async (name: string, value: string) => {
      secretManagerStore.set(name, value);
    }),
  } as unknown as SecretManager);

  // R9-2: SyncErrorAssistService calls `this.connectorManager.getConnector('netsuite', ...)`,
  // not the raw NetSuiteConnector binding. ConnectorManager builds connectors from its registry,
  // so rebinding TYPES.NetSuiteConnector would NOT change what the service sees. Patch
  // ConnectorManager.getConnector instead so it returns our stub when called for 'netsuite'.
  //
  // R15-1 — Resolve as the real ConnectorManager type and use jest.spyOn rather than
  // `(connectorManager as any).getConnector = ...`. spyOn preserves the method signature,
  // mockRestore() in `restore()` is the canonical unwind, no `as any` needed.
  const connectorManager = await container.getAsync<ConnectorManager>(TYPES.ConnectorManager);
  const origGetConnector = connectorManager.getConnector.bind(connectorManager);
  const getConnectorSpy = jest.spyOn(connectorManager, 'getConnector').mockImplementation((systemType, systemId) => {
    if (systemType === 'netsuite') return Promise.resolve(nsConnectorStub as unknown as ReturnType<typeof origGetConnector> extends Promise<infer R> ? R : never);
    return origGetConnector(systemType, systemId);
  });

  // R9-1: token is TYPES.ProviderRegistry (NOT AIProviderRegistry); return shape is
  // `{ provider, id }` per ProviderRegistry.ts:110 (NOT `{ provider, providerId }`).
  // R15-1 — Same jest.spyOn pattern; resolve as real ProviderRegistry.
  const providerRegistry = await container.getAsync<ProviderRegistry>(TYPES.ProviderRegistry);
  const origGetAvailableProvider = providerRegistry.getAvailableProvider.bind(providerRegistry);
  const getAvailableProviderSpy = jest.spyOn(providerRegistry, 'getAvailableProvider').mockResolvedValue(
    { provider: aiProviderStub, id: 'claude-fixture' } as unknown as Awaited<ReturnType<typeof origGetAvailableProvider>>,
  );

  // R12-4 — DELIBERATE PARALLEL CHAIN (not "production middleware chain"). The helper rolls
  // its own express setup instead of calling `setupMiddleware(app, config)` for two reasons:
  //
  //   1. Per-test `ipLimitOverride`. The production `ipPreAuthLimiter` (mounted by
  //      `MiddlewareSetup.setupBasicMiddleware()`) is a module-scoped 30/min constant.
  //      Tenant-rate-limit tests need 100+ requests through, so they raise the IP limit
  //      via this helper-local rateLimit() instance. Settable per `buildIntegrationApp()`
  //      call without process.env mutation that could leak across tests.
  //   2. Test efficiency. `setupAll()` mounts CORS / helmet / compression / global rate
  //      limit / static files / wiki export fallback — none of which the syncErrorAssist
  //      integration suite needs. A parallel chain keeps integration test startup quick.
  //
  // CONTRACT: this parallel chain mirrors the production chain mounted in
  // `src/middleware/setup/MiddlewareSetup.ts` (Task 11). Both must stay in sync:
  //
  //   - same path: `/api/sync-error-assist/ingest`
  //   - same order: IP limiter → express.raw({type:'application/json', limit:'256kb'}) → express.json
  //   - same IP-limit default: 30/min, windowMs: 60_000
  //
  // Task 11's middleware-contract test asserts production behavior through the REAL
  // `setupMiddleware(app, config)` call — drift in either direction surfaces there. Future
  // PR: hoist `ipLimitOverride` into a `MiddlewareConfig` test seam so this helper can
  // route through `setupMiddleware` and we delete this parallel chain entirely.
  //
  // R19-2 — Use req.ip directly as the rate-limit key. express-rate-limit 7.x does not
  // export an `ipKeyGenerator` helper; the default key is already `req.ip`. Tests run with
  // `trust proxy` disabled (no X-Forwarded-For), so `req.ip` is always the loopback address
  // — both the IP-limit path and the tenant-limit path behave deterministically.
  const app = express();
  app.use(
    '/api/sync-error-assist/ingest',
    rateLimit({
      windowMs: 60_000,
      limit: opts.ipLimitOverride ?? 30,
      standardHeaders: 'draft-7', legacyHeaders: false,
    }),
    express.raw({ type: 'application/json', limit: '256kb' }),
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(syncErrorAssistRoutes);

  const syncErrorAssistService = await container.getAsync<SyncErrorAssistService>(TYPES.SyncErrorAssistService);
  const tenantConfigRepo = await container.getAsync<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
  const syncErrorRepo = await container.getAsync<SyncErrorAssistRepository>(TYPES.SyncErrorAssistRepository);

  return {
    app,
    aiProviderStub, nsConnectorStub, loggerStub,
    syncErrorAssistService, tenantConfigRepo, syncErrorRepo,
    providerId: 'claude-fixture',
    restore: () => {
      // R15-1 — mockRestore() unwinds the spies cleanly; no need for `(x as any).method = orig`.
      // Restore spies first, then pop the Inversify container snapshot (which also pops the
      // TYPES.Logger rebind from R15-4).
      getConnectorSpy.mockRestore();
      getAvailableProviderSpy.mockRestore();
      container.restore();
    },
  };
}

/** R8-5 — sync accessor: tests call `tenantConfigRepoFor(kit)` directly without an extra `await`. */
export function tenantConfigRepoFor(kit: IntegrationAppKit): TenantConfigurationRepository {
  return kit.tenantConfigRepo;
}

/** Test-only repo wrapper exposing the convenience methods Task 13 uses. */
export interface IntegrationSyncErrorRepo {
  claim(tenantId: string, errorRecordId: string): Promise<{ id: string } | null>;
  getProcessedRowByErrorRecord(tenantId: string, errorRecordId: string): Promise<{ status: string } | undefined>;
  getWatermark(tenantId: string): Promise<Date | null>;
  /** R8-6 / R9-3 — the production seam is `repo.reapStuckProcessing(cutoff: Date)` per
   *  `SyncErrorAssistRepository.ts:101`. The service does NOT have `runReaperOnce`. The
   *  wrapper accepts a `Date` to match.
   *  Codex PR #777 R2: production return shape is `{reaped, recoveries[]}`; the wrapper
   *  returns just the reaped count for backward compat with existing integration tests
   *  that consume a number. New tests verifying watermark recovery should call
   *  `kit.syncErrorRepo.reapStuckProcessing(...)` directly to get the full outcome. */
  runReaper(cutoff: Date): Promise<number>;
  /** R18-7 — Backdate `reserved_at` on a processing row so reaper tests can exercise the
   *  production 60-min cutoff (`SyncErrorAssistService.REAPER_CUTOFF_MS`) without relying on
   *  `jest.useFakeTimers()` (which conflicts with real DB writes in integration suites).
   *  Returns true if a row was found AND updated; false if no matching processing row exists.
   */
  backdateReservedAt(tenantId: string, errorRecordId: string, reservedAt: Date): Promise<boolean>;
}

export function syncErrorRepoFor(kit: IntegrationAppKit): IntegrationSyncErrorRepo {
  // R15-1 — Drop `const repo: any = ...`. The real SyncErrorAssistRepository class declares
  // claim, getProcessedRowByErrorRecord, getWatermark, and reapStuckProcessing as public
  // methods (SyncErrorAssistRepository.ts:25, :212, :137, :101), so no defensive guard or
  // `: any` is needed.
  // R22-2 — `SyncErrorAssistRepository.getProcessedRowByErrorRecord` returns `row ?? null`
  // (see `SyncErrorAssistRepository.ts:219`), NOT `undefined`. A type-only `as` cast hides
  // the runtime mismatch, so `expect(row).toBeUndefined()` assertions in disabled-feature
  // tests would fail at runtime. Convert null → undefined inside the wrapper.
  const repo = kit.syncErrorRepo;
  return {
    claim: (tenantId, errorRecordId) => repo.claim(tenantId, errorRecordId),
    getProcessedRowByErrorRecord: async (tenantId, errorRecordId) => {
      const row = await repo.getProcessedRowByErrorRecord(tenantId, errorRecordId);
      return row ? { status: row.status } : undefined;
    },
    getWatermark: (tenantId) => repo.getWatermark(tenantId),
    runReaper: async (cutoff) => (await repo.reapStuckProcessing(cutoff)).reaped,
    backdateReservedAt: async (tenantId, errorRecordId, reservedAt) => {
      // R18-7 — Direct kysely UPDATE; production code never backdates reserved_at, so this
      // is intentionally a test-only seam. Filter by tenant + errorRecordId + status='processing'
      // so the test can't accidentally rewrite a row that's already transitioned out.
      // `SyncErrorAssistRepository.db` is private; resolve `DatabaseService` directly from
      // the container instead of accessing the private field, which would require an
      // `as unknown as { db: DatabaseService }` cast at this seam.
      const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
      const result = await dbService.getDatabase()
        .updateTable('sync_error_assist_processed')
        .set({ reserved_at: reservedAt.toISOString() })
        .where('tenant_id', '=', tenantId)
        .where('error_record_id', '=', errorRecordId)
        .where('status', '=', 'processing')
        .executeTakeFirst();
      return Number(result.numUpdatedRows ?? 0) > 0;
    },
  };
}

/**
 * R14-3 — Polling helper for fire-and-forget assertions. Replaces fixed
 * `await new Promise((r) => setTimeout(r, 100))` patterns that assume
 * `setImmediate` + DLP scan + DB write all complete within 100ms. On slow
 * CI agents (GitHub Actions free tier especially) that assumption fails
 * intermittently. `waitFor` polls a predicate every `pollMs` until it
 * returns true or `timeoutMs` elapses.
 *
 * Use this whenever a test asserts on state mutated by a `setImmediate`
 * worker after returning 202 — DB row status transitions, Jest mock call
 * counts, watermark advances, etc.
 *
 * @param predicate function returning boolean (or Promise<boolean>); polled
 *                  until true. Throwing predicates abort the wait.
 * @param timeoutMs hard deadline in milliseconds (default 5000).
 * @param pollMs    poll interval in milliseconds (default 50).
 * @throws Error with timeout message if predicate never returns true.
 */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 5000,
  pollMs = 50,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
