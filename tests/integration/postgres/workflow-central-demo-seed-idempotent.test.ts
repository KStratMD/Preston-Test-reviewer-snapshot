/**
 * WorkflowCentral demo-seed Postgres idempotency (PR-F5b-3, blocker 2).
 *
 * The proof this file exists for CANNOT be expressed against SQLite. Before
 * F5b-3 both demo seeders faked ON CONFLICT DO NOTHING with a per-row
 * try/catch INSIDE one `database.transaction`. SQLite tolerates that: the
 * caught constraint violation leaves the transaction usable. Postgres does
 * not — the first violation puts the TX in an aborted state and EVERY
 * subsequent statement fails with "current transaction is aborted, commands
 * ignored until end of transaction block". So on Postgres a second boot
 * (or a container restart) would fail the whole seed pass, silently in the
 * caller's warn-and-continue posture.
 *
 * Post-fix both seeders use real onConflict().doNothing() upserts
 * (repo.insertInstanceIfMissing / insertTaskIfMissing), so re-seeding is a
 * clean no-op with inserted=0.
 *
 * NODE_ENV: tests/integration/setupEnvPostgres.ts defaults NODE_ENV to
 * 'production', under which seedWorkflowCentralDemoTasks self-gates and
 * returns {inserted: 0, skipped: 0} without touching the DB — which would
 * make every assertion here vacuous. This suite therefore pins 'development'
 * for its lifetime and restores the previous value in afterAll.
 * (seedWorkflowCentralDemoData does NOT self-gate; it is caller-gated.)
 *
 * Pattern source: tests/integration/postgres/workflow-central-concurrency.test.ts
 * (container.snapshot() + directly constructed DatabaseService + afterAll
 * tenant-scoped cleanup).
 */
import 'reflect-metadata';
import { sql } from 'kysely';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { Logger } from '../../../src/utils/Logger';
import { WorkflowCentralRepository } from '../../../src/services/workflowCentral/WorkflowCentralRepository';
import { WorkflowEngineService } from '../../../src/services/workflowCentral/WorkflowEngineService';
import {
  seedWorkflowCentralDemoData,
  seedWorkflowCentralDemoTasks,
} from '../../../src/services/workflowCentral/demoSeed';
import { CENTRAL_DEMO_TENANT_ID } from '../../../src/services/governance/demoTenant';

describe('workflow-central demo seed idempotency on Postgres (F5b-3 blocker 2)', () => {
  let db: DatabaseService;
  let repo: WorkflowCentralRepository;
  let engine: WorkflowEngineService;
  let logger: Logger;
  let originalNodeEnv: string | undefined;

  beforeAll(async () => {
    // Per-suite defense-in-depth gate; setupEnvPostgres.ts enforces this too.
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL required — this suite runs only in the postgres profile');
    }
    originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';

    container.snapshot();
    logger = new Logger('workflow-central-demo-seed-idempotent-test');
    db = new DatabaseService(logger);
    await db.initialize();
    if (container.isBound(TYPES.DatabaseService)) {
      container.unbind(TYPES.DatabaseService);
    }
    container.bind<DatabaseService>(TYPES.DatabaseService).toConstantValue(db);

    repo = await container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);

    // Migration 061 deletes system-tenant demo fixtures; make sure no demo-tenant
    // rows survive from an earlier run of this suite either.
    const k = db.getDatabase();
    await sql`DELETE FROM workflow_central_tasks WHERE tenant_id = ${CENTRAL_DEMO_TENANT_ID}`.execute(k);
    await sql`DELETE FROM workflow_central_instances WHERE tenant_id = ${CENTRAL_DEMO_TENANT_ID}`.execute(k);
  }, 30_000);

  afterAll(async () => {
    try {
      const k = db?.getDatabase();
      if (k) {
        await sql`DELETE FROM workflow_central_tasks WHERE tenant_id = ${CENTRAL_DEMO_TENANT_ID}`.execute(k);
        await sql`DELETE FROM workflow_central_instances WHERE tenant_id = ${CENTRAL_DEMO_TENANT_ID}`.execute(k);
      }
    } finally {
      await db?.shutdown();
      container.restore();
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('re-seeding an ALREADY-seeded Postgres DB completes without aborting the transaction', async () => {
    await seedWorkflowCentralDemoData(engine, repo, db, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    const first = await seedWorkflowCentralDemoTasks(repo, db, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(first).toEqual({ inserted: 3, skipped: 0 });

    // Second pass: pre-fix, the first PK conflict aborted the TX and every
    // later row failed ("current transaction is aborted"). Post-fix it is a
    // clean no-op.
    await expect(
      seedWorkflowCentralDemoData(engine, repo, db, {
        tenantId: CENTRAL_DEMO_TENANT_ID,
        logger,
      }),
    ).resolves.toBeUndefined();
    const second = await seedWorkflowCentralDemoTasks(repo, db, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    expect(second).toEqual({ inserted: 0, skipped: 3 });

    const k = db.getDatabase();
    const taskCount = await k
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
      .executeTakeFirstOrThrow();
    const instanceCount = await k
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
      .executeTakeFirstOrThrow();
    expect(Number(taskCount.n)).toBe(3);
    expect(Number(instanceCount.n)).toBe(3);
  }, 30_000);

  it('all THREE instance rows survive the second pass (a TX abort would have lost rows 2 and 3)', async () => {
    // Ordering note: this runs after the test above, so the rows are already
    // seeded; a third pass must still be a no-op and leave all three ids.
    await seedWorkflowCentralDemoData(engine, repo, db, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    const rows = await db
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .select(['id', 'tenant_id'])
      .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
      .orderBy('id')
      .execute();
    expect(rows.map((r) => r.id)).toEqual(['INST-1000', 'INST-1001', 'INST-1002']);
  }, 30_000);
});
