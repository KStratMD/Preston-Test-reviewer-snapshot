/**
 * SerializedAssetSyncService — durability, tenant isolation, idempotency, and
 * restart-recovery integration proof (Task 12, 2026-07-27 NetSuite
 * serialized-asset sync plan). PostgreSQL dialect.
 *
 * Lives under `tests/integration/postgres/**` because the PostgreSQL CI
 * profile (`jest.postgres.config.cjs`) discovers ONLY specs in this
 * directory — a spec anywhere else never exercises migration 058/059's
 * PostgreSQL branch. `tests/integration/setupEnvPostgres.ts` (the profile's
 * setupFile) already hard-fails at load time if `DATABASE_URL` is unset —
 * no `.skip` for a missing database, per repo convention. Per-suite
 * `beforeAll` guard below is defense-in-depth for a misrouted runner.
 *
 * The dialect-agnostic assertions (tenant isolation, idempotency, restart
 * recovery, mixed counts, governance rejection, ApprovalQueueService.enqueue,
 * the privacy canary sweep, standard-config bypass) are shared verbatim with
 * the SQLite suite (`tests/integration/serializedAssetSync.test.ts`) via
 * `tests/integration/helpers/serializedAssetSyncDurability.ts` so the two
 * dialect suites cannot drift apart.
 *
 * This file ADDS one PostgreSQL-only proof: a genuine Postgres CHECK-
 * violation error's `.detail` field really does embed the whole failing row
 * (the documented decision-8 hazard, confirmed as a positive control rather
 * than assumed), and `SerializedAssetSyncService`'s persist-retry-and-log
 * path still only ever logs the error's `.name`, never `.message`/`.detail`.
 *
 * Local run: `DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/preston_test DB_TYPE=postgres npm run test:integration:postgres`
 * (matches the `postgres-integration` job in the CI-minimal workflow).
 */

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { AuditLogRepository } from '../../../src/database/repositories/AuditLogRepository';
import { Logger } from '../../../src/utils/Logger';
import {
  SerializedAssetSyncService,
  type SerializedAssetDeferredStore,
  type SerializedAssetSweepCursorStore,
} from '../../../src/services/serializedAsset/SerializedAssetSyncService';
import type { IConnector } from '../../../src/interfaces/IConnector';
import {
  defineSerializedAssetSyncDurabilitySuite,
  makeConfig,
  sourceRecord,
  makeReadiness,
  makeResolver,
  makeMetrics,
  makeLogger,
  makeTargetConnector,
  unit,
  CANARY_SERIAL,
  CANARY_SERIAL_PREFIX,
} from '../helpers/serializedAssetSyncDurability';

describe('serializedAssetSync durability (PostgreSQL)', () => {
  let db: DatabaseService;

  beforeAll(async () => {
    // Defense-in-depth: setupEnvPostgres.ts already hard-fails at jest
    // setupFile time; this catches a misrouted direct `npx jest` invocation
    // outside the postgres profile with a loud failure rather than a
    // silently green no-op (matches the sibling postgres suites' pattern).
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL required — this suite only runs under the postgres-integration profile');
    }

    container.snapshot();
    db = new DatabaseService(new Logger('serialized-asset-sync-durability-postgres'));
    await db.initialize();
    if (container.isBound(TYPES.DatabaseService)) {
      container.unbind(TYPES.DatabaseService);
    }
    container.bind<DatabaseService>(TYPES.DatabaseService).toConstantValue(db);
  }, 30_000);

  afterAll(async () => {
    try {
      const k = db?.getDatabase();
      if (k) {
        await sql`DELETE FROM deferred_serialized_units`.execute(k);
        await sql`DELETE FROM serialized_asset_sweep_cursors`.execute(k);
        await sql`DELETE FROM governance_approvals WHERE resource_type = 'serialized_asset'`.execute(k);
        // audit_logs is a SHARED table (every guardedWrite caller in the app
        // writes to it), so this scopes to only the tenant-id patterns this
        // suite's tests actually use — a full DELETE would wipe unrelated
        // rows in a long-lived shared local database; scoping by resource
        // type/action isn't safe here since those are shared vocabulary too.
        await sql`DELETE FROM audit_logs WHERE tenant_id LIKE 'tenant-%' OR tenant_id = 't1'`.execute(k);
      }
    } finally {
      await db?.shutdown();
      container.restore();
    }
  });

  defineSerializedAssetSyncDurabilitySuite('postgres', () => db);

  // ===========================================================================
  // PostgreSQL-only — decision 8's DETAIL-in-row hazard, as a positive control
  // ===========================================================================

  describe('decision 8 — Postgres CHECK-violation DETAIL hazard', () => {
    it('a genuine Postgres CHECK-violation error DETAIL embeds the whole failing row (positive control); the service still logs only the error class name', async () => {
      // Deliberately SHORT, fixed ids (not randomUUID) for this one test:
      // Postgres's "Failing row contains (...)" DETAIL truncates each
      // attribute's textual representation at a fixed byte budget, and long
      // UUID-shaped tenant/config ids ahead of `serialNumber` in the JSONB's
      // (length-ordered) key rendering can consume that whole budget before
      // the canary is ever reached — confirmed empirically. Short ids leave
      // enough room for the canary PREFIX to survive, which is what this
      // positive control needs to demonstrate. Safe to hardcode: this table
      // is wiped in afterAll and the profile runs single-threaded (maxWorkers: 1).
      const tenantId = 't1';
      const configId = 'c1';
      const invId = 'i1';
      const nowIso = new Date().toISOString();
      const canaryUnit = unit(tenantId, configId, invId, CANARY_SERIAL, 'x');

      // 1) Positive control: prove the documented hazard is real, not
      // hypothetical, by directly tripping the CHECK constraint with a
      // canary-bearing payload and inspecting the RAW driver error.
      let capturedError: (Error & { detail?: string }) | undefined;
      try {
        await sql`
          INSERT INTO deferred_serialized_units
            (tenant_id, configuration_id, inventory_number_id, normalized_payload, reason, attempt_count, next_attempt_at, first_deferred_at, last_attempt_at)
          VALUES (${tenantId}, ${configId}, ${invId}, ${JSON.stringify(canaryUnit)}, 'bogus_reason_violates_check', 1, ${nowIso}, ${nowIso}, ${nowIso})
        `.execute(db.getDatabase());
      } catch (err) {
        capturedError = err as Error & { detail?: string };
      }

      expect(capturedError).toBeDefined();
      // PostgreSQL truncates each individual attribute's textual
      // representation inside "Failing row contains (...)" — a recognizable
      // PREFIX of the 33-character canary survives, not the whole value
      // (confirmed empirically; see CANARY_SERIAL_PREFIX's doc comment).
      // That fragment, alongside the fully-untruncated tenant/config/
      // inventory-number columns, is still the real hazard.
      expect(capturedError!.detail ?? '').toContain(CANARY_SERIAL_PREFIX);
      expect(capturedError!.detail ?? '').toContain(tenantId);
      expect(capturedError!.detail ?? '').toContain(configId);
      expect(capturedError!.detail ?? '').toContain(invId);
      expect(capturedError!.message).not.toContain(CANARY_SERIAL_PREFIX); // .message alone is safe; .detail is the hazard

      // 2) Feed this EXACT real driver error into the service's
      // persist-retry-and-log path (persistDeferral retries once, then logs
      // on final failure) and confirm the logger call carries only the
      // error's `.name` — never `.message` or `.detail`.
      const deferredStore: SerializedAssetDeferredStore = {
        upsertDeferred: jest.fn().mockRejectedValue(capturedError),
        listDue: jest.fn().mockResolvedValue({ units: [], undecodable: [] }),
        listForRetry: jest.fn().mockResolvedValue({ units: [], undecodable: [] }),
        deleteSucceeded: jest.fn().mockResolvedValue(false),
        touchAttempt: jest.fn().mockResolvedValue(null),
      };
      const cursorStore: SerializedAssetSweepCursorStore = {
        getNextOffset: jest.fn().mockResolvedValue(0),
        setNextOffset: jest.fn().mockResolvedValue(undefined),
      };
      const logger = makeLogger();
      const metrics = makeMetrics();
      const resolver = makeResolver();
      const target = makeTargetConnector({});
      const source = { list: jest.fn().mockResolvedValue([sourceRecord(invId, CANARY_SERIAL, 'item-missing')]) };
      const config = makeConfig(tenantId, configId);

      const service = new SerializedAssetSyncService(
        deferredStore,
        cursorStore,
        makeReadiness() as never,
        metrics,
        {
          ownershipResolver: resolver as never,
          auditService: { logGovernanceCheck: jest.fn().mockResolvedValue('a') } as never,
        },
        { logDataAccess: jest.fn().mockResolvedValue('a') } as never,
        logger as never,
      );

      const result = await service.run({
        config,
        sourceConnector: source as unknown as IConnector,
        targetConnector: target as unknown as IConnector,
        options: { batchSize: 100, concurrency: 4, dryRun: false, forceDeferredRetry: false },
        actor: { tenantId, userId: 'op-detail-hazard', correlationId: randomUUID() },
      });

      expect(deferredStore.upsertDeferred).toHaveBeenCalledTimes(2); // select-then-write's single retry
      expect(result).toMatchObject({ mode: 'executed', failed: 1 });

      const observedLogCalls = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
      // The captured real error's `.detail` DOES carry the canary prefix
      // (proven above) — the load-bearing assertion is that the service's
      // OWN logging never reaches for `.detail`/`.message` at all, so that
      // fragment never reappears here.
      expect(observedLogCalls).not.toContain(CANARY_SERIAL_PREFIX);
      expect(observedLogCalls).not.toContain('bogus_reason_violates_check');
      expect(observedLogCalls).not.toContain('Failing row contains');
      // The class-name-only discipline is still verifiable: pg's driver sets
      // `.name` to the literal string 'error' (confirmed against a live
      // Postgres 15 container), which the service DOES log.
      expect(observedLogCalls).toContain('errorName');
    });
  });

  // ===========================================================================
  // Regression — AuditLogRepository.create() persists a UUID-shaped id on
  // Postgres (the defect this task's durability suite discovered: every
  // audit write threw `invalid input syntax for type uuid` before the fix).
  // Mutation-covered already; this test states the invariant by name.
  // ===========================================================================

  describe('AuditLogRepository — Postgres audit_logs.id UUID invariant', () => {
    const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    it('substitutes a UUID-shaped id when the caller supplies a non-UUID app-generated id (AuditService.generateAuditId()\'s shape)', async () => {
      const repo = new AuditLogRepository(db);
      const nonUuidId = `audit_${Date.now()}_notauuid`;
      const created = await repo.create({
        id: nonUuidId,
        tenant_id: 'tenant-uuid-regress',
        user_id: 'user-uuid-regress',
        action: 'test.uuid_regress',
        resource_type: 'test_resource',
        resource_id: 'res-1',
        old_values: null,
        new_values: null,
        details: null,
        result: 'success',
        error_message: null,
        duration_ms: 0,
        ip_address: null,
        user_agent: null,
        created_at: new Date().toISOString(),
      });

      expect(created.id).toMatch(UUID_SHAPE);
      expect(created.id).not.toBe(nonUuidId);

      const persisted = await sql<{ id: string }>`
        SELECT id FROM audit_logs WHERE tenant_id = 'tenant-uuid-regress' AND action = 'test.uuid_regress'
      `.execute(db.getDatabase());
      expect(persisted.rows).toHaveLength(1);
      expect(persisted.rows[0].id).toMatch(UUID_SHAPE);
    });

    it('preserves a caller-supplied VALID uuid verbatim (SuiteCentralAuditWriter already passes uuidv4())', async () => {
      const repo = new AuditLogRepository(db);
      const callerUuid = randomUUID();
      const created = await repo.create({
        id: callerUuid,
        tenant_id: 'tenant-uuid-regress',
        user_id: 'user-uuid-regress',
        action: 'test.uuid_regress_preserved',
        resource_type: 'test_resource',
        resource_id: 'res-2',
        old_values: null,
        new_values: null,
        details: null,
        result: 'success',
        error_message: null,
        duration_ms: 0,
        ip_address: null,
        user_agent: null,
        created_at: new Date().toISOString(),
      });

      expect(created.id).toBe(callerUuid);
    });
  });
});
