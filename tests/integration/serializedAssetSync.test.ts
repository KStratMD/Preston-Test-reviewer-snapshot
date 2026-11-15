/**
 * SerializedAssetSyncService — durability, tenant isolation, idempotency, and
 * restart-recovery integration proof (Task 12, 2026-07-27 NetSuite
 * serialized-asset sync plan). SQLite dialect.
 *
 * Runs against a real, file-backed-in-memory SQLite database via
 * `DatabaseService` (real migrations 058/059 + the governance-approvals
 * bundle), real `DeferredSerializedUnitRepository` /
 * `SerializedAssetSweepCursorRepository` instances, and the real
 * `ApprovalQueueService` / `AuditService` singletons resolved through the DI
 * container after rebinding `TYPES.DatabaseService` to this test's database —
 * the same pattern used by `guardedWrite.endToEnd.test.ts` and
 * `workflow-central-restart-recovery.test.ts`.
 *
 * The actual assertions live in
 * `tests/integration/helpers/serializedAssetSyncDurability.ts`, shared
 * verbatim with the PostgreSQL dialect suite
 * (`tests/integration/postgres/serializedAssetSync.postgres.test.ts`) so the
 * two dialect suites cannot drift apart.
 *
 * Jest config: jest.slow.config.cjs (`npm run test:integration -- serializedAssetSync`),
 * NOT the default `npm test` (jest.fast.config.cjs's roots exclude
 * tests/integration entirely and would silently match zero tests).
 */

import 'reflect-metadata';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { DatabaseService } from '../../src/database/DatabaseService';
import { Logger } from '../../src/utils/Logger';
import { defineSerializedAssetSyncDurabilitySuite } from './helpers/serializedAssetSyncDurability';

describe('serializedAssetSync durability (SQLite)', () => {
  let db: DatabaseService;

  beforeAll(async () => {
    container.snapshot();
    process.env.DB_TYPE = 'sqlite';
    process.env.SQLITE_DB_PATH = ':memory:';
    db = new DatabaseService(new Logger('serialized-asset-sync-durability-sqlite'));
    await db.initialize();
    if (container.isBound(TYPES.DatabaseService)) {
      container.unbind(TYPES.DatabaseService);
    }
    container.bind<DatabaseService>(TYPES.DatabaseService).toConstantValue(db);
  });

  afterAll(async () => {
    await db?.shutdown();
    container.restore();
  });

  defineSerializedAssetSyncDurabilitySuite('sqlite', () => db);
});
