/**
 * WorkflowCentral demo-seed unit tests (PR-F5b-3).
 *
 * Two properties this suite exists to pin:
 *   1. Instance rows land on the tenant the CALLER passes — the producer must
 *      hardcode nothing (F5b-3 blocker 1).
 *   2. Re-seeding an already-seeded DB is a clean no-op via real
 *      ON CONFLICT DO NOTHING upserts, not a caught exception (blocker 2). The
 *      Postgres half of that proof — where a caught PK violation aborts the
 *      whole transaction — lives in
 *      tests/integration/postgres/workflow-central-demo-seed-idempotent.test.ts.
 *
 * NODE_ENV: seedWorkflowCentralDemoTasks self-gates on production AND test
 * (demoSeed.ts), so this suite pins 'development' for its lifetime — the
 * override pattern that function's own header documents. HOSTED_DEMO is pinned
 * BEFORE the src/ imports below because src/config/env.ts zod-snapshots it at
 * first module evaluation.
 *
 * Harness: tests/unit/services/workflowCentral/WorkflowCentralRepository.test.ts
 * (raw BetterSqlite3 + Kysely + a structural DatabaseService stub; explicit
 * migrations per test and an explicit connection close).
 */
import 'reflect-metadata';

const ENV_KEYS = ['NODE_ENV', 'HOSTED_DEMO'] as const;
const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
process.env.NODE_ENV = 'development';
process.env.HOSTED_DEMO = '0';

// eslint-disable-next-line import/first
import { Kysely, SqliteDialect } from 'kysely';
// eslint-disable-next-line import/first
import BetterSqlite3 from 'better-sqlite3';
// eslint-disable-next-line import/first
import type { Database } from '../../../../src/database/types';
// eslint-disable-next-line import/first
import type { DatabaseService } from '../../../../src/database/DatabaseService';
// eslint-disable-next-line import/first
import type { Logger } from '../../../../src/utils/Logger';
// eslint-disable-next-line import/first
import { migration as createWorkflowCentralTasks } from '../../../../src/database/migrations/041-create-workflow-central-tasks-table';
// eslint-disable-next-line import/first
import { migration as createWorkflowCentralInstances } from '../../../../src/database/migrations/042-create-workflow-central-instances-table';
// eslint-disable-next-line import/first
import { migration as addWorkflowCentralPayloadColumn } from '../../../../src/database/migrations/043-add-workflow-central-payload-column';
// eslint-disable-next-line import/first
import { WorkflowCentralRepository } from '../../../../src/services/workflowCentral/WorkflowCentralRepository';
// eslint-disable-next-line import/first
import { WorkflowEngineService } from '../../../../src/services/workflowCentral/WorkflowEngineService';
// eslint-disable-next-line import/first
import {
  seedWorkflowCentralDemoData,
  seedWorkflowCentralDemoTasks,
} from '../../../../src/services/workflowCentral/demoSeed';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../../src/services/governance/demoTenant';

const INSTANCE_IDS = ['INST-1000', 'INST-1001', 'INST-1002'];

function stubLogger(): Logger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  } as unknown as Logger;
}

describe('WorkflowCentral demo seeds (F5b-3)', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;
  let dbService: DatabaseService;
  let repo: WorkflowCentralRepository;
  let engine: WorkflowEngineService;
  const logger = stubLogger();

  beforeEach(async () => {
    sqlite = new BetterSqlite3(':memory:');
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
    await createWorkflowCentralTasks.run(db, 'sqlite');
    await createWorkflowCentralInstances.run(db, 'sqlite');
    // 043 adds the `payload` column both seeders write.
    await addWorkflowCentralPayloadColumn.run(db, 'sqlite');
    dbService = {
      getDatabase: () => db,
      getDbType: () => 'sqlite' as const,
      transaction: <T>(cb: (trx: Kysely<Database>) => Promise<T>) => db.transaction().execute(cb),
    } as unknown as DatabaseService;
    repo = new WorkflowCentralRepository(dbService, logger);
    engine = new WorkflowEngineService(logger);
  });

  afterEach(async () => {
    await db.destroy();
    // See the repository suite's makeDb() comment: Kysely.destroy() does not
    // close a caller-supplied BetterSqlite3 connection.
    sqlite.close();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('seeds instance rows under the tenant the caller passes (no hardcoded system tenant)', async () => {
    await seedWorkflowCentralDemoData(engine, repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });

    const rows = await db
      .selectFrom('workflow_central_instances')
      .select(['id', 'tenant_id'])
      .where('id', 'in', INSTANCE_IDS)
      .execute();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.tenant_id).toBe(CENTRAL_DEMO_TENANT_ID);
  });

  it('seeds task rows under the caller tenant and reports the insert count', async () => {
    const result = await seedWorkflowCentralDemoTasks(repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(result).toEqual({ inserted: 3, skipped: 0 });

    const rows = await db
      .selectFrom('workflow_central_tasks')
      .select(['id', 'tenant_id'])
      .execute();
    expect(rows.map((r) => r.id).sort()).toEqual([
      'WCTASK-demo-001',
      'WCTASK-demo-002',
      'WCTASK-demo-003',
    ]);
    for (const r of rows) expect(r.tenant_id).toBe(CENTRAL_DEMO_TENANT_ID);
  });

  it('re-seeding is a conflict-skipping no-op, not a duplicate write', async () => {
    await seedWorkflowCentralDemoData(engine, repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    const first = await seedWorkflowCentralDemoTasks(repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(first).toEqual({ inserted: 3, skipped: 0 });

    await expect(
      seedWorkflowCentralDemoData(engine, repo, dbService, {
        tenantId: CENTRAL_DEMO_TENANT_ID,
        logger,
      }),
    ).resolves.toBeUndefined();
    const second = await seedWorkflowCentralDemoTasks(repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(second).toEqual({ inserted: 0, skipped: 3 });

    const instanceCount = await db
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    const taskCount = await db
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(instanceCount.n)).toBe(3);
    expect(Number(taskCount.n)).toBe(3);
  });

  it('an already-seeded row belonging to ANOTHER tenant is not overwritten', async () => {
    // The ids are global primary keys, so a foreign-tenant row with the same id
    // must make the seed skip — never silently re-key someone else's row.
    await seedWorkflowCentralDemoTasks(repo, dbService, { tenantId: 'tenant-x', logger });
    const result = await seedWorkflowCentralDemoTasks(repo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(result).toEqual({ inserted: 0, skipped: 3 });

    const rows = await db.selectFrom('workflow_central_tasks').select(['tenant_id']).execute();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.tenant_id).toBe('tenant-x');
  });
});
