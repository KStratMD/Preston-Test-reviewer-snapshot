/**
 * Migration 061 — surgical delete of the legacy system-tenant demo fixtures
 * (PR-F5b-3). The rows are recreated under CENTRAL_DEMO_TENANT_ID by the boot
 * seed pass that runs immediately after migrations, so this is a re-key
 * implemented as delete-and-reseed.
 *
 * What the WHERE must NOT touch:
 *   - non-demo rows owned by the system tenant (real background-job state);
 *   - demo-id rows owned by a real tenant. Only finance can actually hold one
 *     (its PK is `id`, with UNIQUE(tenant_id, approval_id) — 039:21/46), so the
 *     workflow tables' foreign-tenant survivors use different ids: their ids
 *     are GLOBAL primary keys (041/042) and a duplicate is uninsertable.
 *
 * Harness mirrors 060's test: in-memory SQLite, run the prerequisite
 * migrations, insert fixtures, invoke the module under test directly.
 */
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Database } from '../../../../src/database/types';
import { SYSTEM_IDENTITY } from '../../../../src/services/governance/identityContext';
import { migration as createFinanceApprovals } from '../../../../src/database/migrations/039-create-finance-central-approvals-table';
import { migration as createWorkflowTasks } from '../../../../src/database/migrations/041-create-workflow-central-tasks-table';
import { migration as createWorkflowInstances } from '../../../../src/database/migrations/042-create-workflow-central-instances-table';
import { migration as deleteSystemTenantDemoFixtures } from '../../../../src/database/migrations/061-delete-system-tenant-demo-fixtures';

const SYS = SYSTEM_IDENTITY.tenantId;
const REAL_TENANT = 'tenant-real-1';

async function makeDb(): Promise<{ db: Kysely<Database>; sqlite: BetterSqlite3.Database }> {
  const sqlite = new BetterSqlite3(':memory:');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  await createFinanceApprovals.run(db, 'sqlite');
  await createWorkflowTasks.run(db, 'sqlite');
  await createWorkflowInstances.run(db, 'sqlite');
  return { db, sqlite };
}

async function insertInstance(db: Kysely<Database>, id: string, tenantId: string): Promise<void> {
  await sql`INSERT INTO workflow_central_instances
    (id, tenant_id, workflow_id, workflow_name, workflow_version, status,
     started_by, started_at, created_at, updated_at)
    VALUES (${id}, ${tenantId}, 'WF-1', 'Demo', 1, 'running',
            'seed', '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z')`.execute(db);
}

async function insertTask(db: Kysely<Database>, id: string, tenantId: string): Promise<void> {
  await sql`INSERT INTO workflow_central_tasks
    (id, tenant_id, instance_id, workflow_id, workflow_name, step_id, step_name,
     task_type, status, priority, assignee_id, assignee_name, description,
     created_at, updated_at)
    VALUES (${id}, ${tenantId}, 'INST-X', 'WF-1', 'Demo', 'STEP-1', 'Step One',
            'approval', 'pending', 'high', 'a@b.c', 'A B', 'demo task',
            '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z')`.execute(db);
}

async function insertApproval(
  db: Kysely<Database>,
  rowId: string,
  approvalId: string,
  tenantId: string,
): Promise<void> {
  await sql`INSERT INTO finance_central_approvals
    (id, tenant_id, approval_id, document_id, document_number, document_type,
     description, amount, currency, submitted_by, submitted_at,
     current_approver, approval_level, priority, created_at, updated_at)
    VALUES (${rowId}, ${tenantId}, ${approvalId}, 'DOC-1', 'INV-1', 'invoice',
            'demo approval', 100.0, 'USD', 'submitter', '2026-07-01T00:00:00.000Z',
            'approver', 1, 'high', '2026-07-01T00:00:00.000Z',
            '2026-07-01T00:00:00.000Z')`.execute(db);
}

async function seedFixtures(db: Kysely<Database>): Promise<void> {
  // Legacy demo fixtures owned by the system tenant — these must go.
  await insertInstance(db, 'INST-1000', SYS);
  await insertInstance(db, 'INST-1001', SYS);
  await insertInstance(db, 'INST-1002', SYS);
  await insertTask(db, 'WCTASK-demo-001', SYS);
  await insertTask(db, 'WCTASK-demo-002', SYS);
  await insertTask(db, 'WCTASK-demo-003', SYS);
  await insertApproval(db, 'fca-sys-1', 'appr-001', SYS);
  await insertApproval(db, 'fca-sys-12', 'appr-012', SYS);

  // Survivor class 1: non-demo ids owned by the system tenant.
  await insertInstance(db, 'INST-REAL-9', SYS);
  await insertTask(db, 'WCTASK-real-9', SYS);
  await insertApproval(db, 'fca-sys-real', 'appr-real-9', SYS);

  // Survivor class 2: a real tenant's rows. Finance can legitimately hold the
  // SAME approval_id as the system tenant (UNIQUE is (tenant_id, approval_id));
  // the workflow tables cannot, so they use distinct ids.
  await insertApproval(db, 'fca-real-1', 'appr-001', REAL_TENANT);
  await insertInstance(db, 'INST-2000', REAL_TENANT);
  await insertTask(db, 'WCTASK-real-tenant-1', REAL_TENANT);
}

async function snapshot(db: Kysely<Database>): Promise<{
  instances: string[];
  tasks: string[];
  approvals: string[];
}> {
  const instances = await sql<{ id: string; tenant_id: string }>`
    SELECT id, tenant_id FROM workflow_central_instances ORDER BY tenant_id, id`.execute(db);
  const tasks = await sql<{ id: string; tenant_id: string }>`
    SELECT id, tenant_id FROM workflow_central_tasks ORDER BY tenant_id, id`.execute(db);
  const approvals = await sql<{ id: string; tenant_id: string; approval_id: string }>`
    SELECT id, tenant_id, approval_id FROM finance_central_approvals
    ORDER BY tenant_id, approval_id`.execute(db);
  return {
    instances: instances.rows.map((r) => `${r.tenant_id}/${r.id}`),
    tasks: tasks.rows.map((r) => `${r.tenant_id}/${r.id}`),
    approvals: approvals.rows.map((r) => `${r.tenant_id}/${r.approval_id}`),
  };
}

describe('migration 061 — delete legacy system-tenant demo fixtures', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;

  beforeEach(async () => {
    ({ db, sqlite } = await makeDb());
    await seedFixtures(db);
  });

  afterEach(async () => {
    await db.destroy();
    sqlite.close();
  });

  it('deletes ONLY the fixed demo-fixture rows owned by the system tenant', async () => {
    await deleteSystemTenantDemoFixtures.run(db, 'sqlite');

    expect(await snapshot(db)).toEqual({
      instances: [`${SYS}/INST-REAL-9`, `${REAL_TENANT}/INST-2000`],
      tasks: [`${SYS}/WCTASK-real-9`, `${REAL_TENANT}/WCTASK-real-tenant-1`],
      approvals: [`${SYS}/appr-real-9`, `${REAL_TENANT}/appr-001`],
    });
  });

  it('leaves a real tenant\'s same-id demo approval untouched', async () => {
    await deleteSystemTenantDemoFixtures.run(db, 'sqlite');

    const rows = await sql<{ id: string }>`
      SELECT id FROM finance_central_approvals
      WHERE approval_id = 'appr-001'`.execute(db);
    expect(rows.rows.map((r) => r.id)).toEqual(['fca-real-1']);
  });

  it('is idempotent — a second run deletes nothing and does not throw', async () => {
    await deleteSystemTenantDemoFixtures.run(db, 'sqlite');
    const afterFirst = await snapshot(db);

    await expect(deleteSystemTenantDemoFixtures.run(db, 'sqlite')).resolves.toBeUndefined();
    expect(await snapshot(db)).toEqual(afterFirst);
  });

  it('runs clean against a database that never held demo fixtures', async () => {
    const { db: fresh, sqlite: freshSqlite } = await makeDb();
    try {
      await expect(deleteSystemTenantDemoFixtures.run(fresh, 'sqlite')).resolves.toBeUndefined();
    } finally {
      await fresh.destroy();
      freshSqlite.close();
    }
  });
});
