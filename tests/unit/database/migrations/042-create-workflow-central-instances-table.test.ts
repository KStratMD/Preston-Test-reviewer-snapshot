import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

describe('042 create workflow_central_instances table', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    // Pre-create workflow_central_tasks so backfill SQL can reference it.
    await sql`
      CREATE TABLE IF NOT EXISTS workflow_central_tasks (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        instance_id TEXT NOT NULL,
        workflow_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        step_id TEXT NOT NULL,
        step_name TEXT NOT NULL,
        task_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL,
        assignee_id TEXT NOT NULL,
        assignee_name TEXT NOT NULL,
        description TEXT NOT NULL,
        due_at TEXT,
        data TEXT NOT NULL DEFAULT '{}',
        actions TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        completed_by TEXT,
        completion_action_id TEXT,
        completion_comment TEXT,
        UNIQUE(tenant_id, id)
      )
    `.execute(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates workflow_central_instances table with all required columns', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    const cols = await sql<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>`PRAGMA table_info(workflow_central_instances)`.execute(db);

    const byName = new Map(cols.rows.map((c) => [c.name, c]));

    // Table must exist
    expect(byName.size).toBeGreaterThan(0);

    const expectedCols = [
      'id', 'tenant_id', 'workflow_id', 'workflow_name', 'workflow_version',
      'status', 'current_step_id', 'current_step_name', 'variables', 'step_history',
      'started_by', 'started_at', 'completed_at', 'due_at', 'error',
      'paused_from_status', 'created_at', 'updated_at',
    ];
    expect(byName.size).toBe(expectedCols.length);
    for (const col of expectedCols) {
      expect(byName.has(col)).toBe(true);
    }

    // NOT NULL columns
    const notNullCols = [
      'tenant_id', 'workflow_id', 'workflow_name', 'workflow_version', 'status',
      'variables', 'step_history', 'started_by', 'started_at', 'created_at', 'updated_at',
    ];
    for (const col of notNullCols) {
      expect(byName.get(col)?.notnull).toBe(1);
    }

    // Nullable columns
    const nullableCols = [
      'current_step_id', 'current_step_name', 'completed_at', 'due_at', 'error', 'paused_from_status',
    ];
    for (const col of nullableCols) {
      expect(byName.get(col)?.notnull).toBe(0);
    }

    // defaults
    expect(byName.get('variables')?.dflt_value).toBe("'{}'");
    expect(byName.get('step_history')?.dflt_value).toBe("'[]'");
  });

  it('does NOT create cancellation_reason column (D8 DLP carve-out)', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    const cols = await sql<{ name: string }>`PRAGMA table_info(workflow_central_instances)`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).not.toContain('cancellation_reason');
  });

  it('creates all 6 secondary indexes', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    const indexList = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='workflow_central_instances'
    `.execute(db);
    const indexNames = new Set(indexList.rows.map((r) => r.name));

    expect(indexNames.has('idx_wc_instances_tenant_status')).toBe(true);
    expect(indexNames.has('idx_wc_instances_tenant_workflow')).toBe(true);
    expect(indexNames.has('idx_wc_instances_tenant_due')).toBe(true);
    expect(indexNames.has('idx_wc_instances_tenant_completed')).toBe(true);
    expect(indexNames.has('idx_wc_instances_tenant_started_at')).toBe(true);
    expect(indexNames.has('idx_wc_instances_tenant_started_by')).toBe(true);
  });

  it('enforces UNIQUE(tenant_id, id) constraint', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    await sql`
      INSERT INTO workflow_central_instances
        (id, tenant_id, workflow_id, workflow_name, workflow_version, status,
         variables, step_history, started_by, started_at, created_at, updated_at)
      VALUES
        ('I1', 'tnt_a', 'WF1', 'WF', 1, 'active', '{}', '[]', '__system__', '2026-01-01', '2026-01-01', '2026-01-01')
    `.execute(db);

    // Duplicate row must be rejected by the PRIMARY KEY / UNIQUE(tenant_id, id) constraint.
    // Use try/catch rather than expect().rejects.toThrow() to avoid fakeTimers
    // promise-chain interference when multiple tests run sequentially.
    let threw = false;
    try {
      await sql`
        INSERT INTO workflow_central_instances
          (id, tenant_id, workflow_id, workflow_name, workflow_version, status,
           variables, step_history, started_by, started_at, created_at, updated_at)
        VALUES
          ('I1', 'tnt_a', 'WF1', 'WF', 1, 'active', '{}', '[]', '__system__', '2026-01-01', '2026-01-01', '2026-01-01')
      `.execute(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('paused_from_status defaults to NULL', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    await sql`
      INSERT INTO workflow_central_instances
        (id, tenant_id, workflow_id, workflow_name, workflow_version, status,
         variables, step_history, started_by, started_at, created_at, updated_at)
      VALUES
        ('I2', 'tnt_b', 'WF1', 'WF', 1, 'active', '{}', '[]', '__system__', '2026-01-01', '2026-01-01', '2026-01-01')
    `.execute(db);

    const rows = await sql<{ paused_from_status: string | null }>`
      SELECT paused_from_status FROM workflow_central_instances WHERE id='I2'
    `.execute(db);
    expect(rows.rows[0].paused_from_status).toBeNull();
  });

  it('is idempotent on re-apply against populated DB', async () => {
    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    // First run creates the table; insert a task to seed the backfill
    await sql`
      INSERT INTO workflow_central_tasks
        (id, tenant_id, instance_id, workflow_id, workflow_name, step_id, step_name,
         task_type, status, priority, assignee_id, assignee_name, description, created_at, updated_at)
      VALUES
        ('T1', 'tnt_a', 'I1', 'WF1', 'WF One', 'STEP-1', 'Step One',
         'task', 'pending', 'med', 'op1', 'Op One', 'desc', '2026-01-01', '2026-01-01')
    `.execute(db);
    await migration.run(db, 'sqlite');

    // Re-apply should not throw
    await expect(migration.run(db, 'sqlite')).resolves.not.toThrow();

    // The backfill row still exists (not duplicated, not deleted)
    const count = await sql<{ c: number }>`SELECT COUNT(*) c FROM workflow_central_instances`.execute(db);
    expect(count.rows[0].c).toBe(1);
  });

  it('backfill synthesizes instance rows from existing tasks with status=unknown_recovered', async () => {
    // Pre-seed 3 task rows across 2 instances with disagreeing workflow_name
    await sql`
      INSERT INTO workflow_central_tasks
        (id, tenant_id, instance_id, workflow_id, workflow_name, step_id, step_name,
         task_type, status, priority, assignee_id, assignee_name, description, created_at, updated_at)
      VALUES
        ('T1', 'tnt_a', 'I1', 'WF1', 'Name A', 'S1', 'Step', 'task', 'completed', 'med', 'op', 'Op', 'd', '2026-01-01', '2026-01-01'),
        ('T2', 'tnt_a', 'I1', 'WF1', 'Name B', 'S2', 'Step', 'task', 'pending',   'med', 'op', 'Op', 'd', '2026-01-02', '2026-01-02'),
        ('T3', 'tnt_a', 'I2', 'WF2', 'Other',  'S1', 'Step', 'task', 'pending',   'med', 'op', 'Op', 'd', '2026-01-03', '2026-01-03')
    `.execute(db);

    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    const rows = await sql<{
      id: string;
      status: string;
      started_at: string;
      current_step_id: string | null;
      workflow_name: string;
    }>`SELECT id, status, started_at, current_step_id, workflow_name FROM workflow_central_instances ORDER BY id`.execute(db);

    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].id).toBe('I1');
    expect(rows.rows[0].status).toBe('unknown_recovered');
    expect(rows.rows[0].started_at).toBe('2026-01-01'); // MIN created_at
    expect(rows.rows[0].current_step_id).toBe('S2');    // most-recent pending task's step_id
    expect(rows.rows[0].workflow_name).toBe('Name B');  // most-recent pending task's workflow_name (D19); regression net against MAX() implementation
  });

  it('backfill asserts source-of-truth fields: workflow_name from most-recent-pending task', async () => {
    // Two tasks for same instance: earlier=completed/Name A, later=pending/Name B
    // Source-of-truth rule: most-recent-pending wins for metadata fields
    await sql`
      INSERT INTO workflow_central_tasks
        (id, tenant_id, instance_id, workflow_id, workflow_name, step_id, step_name,
         task_type, status, priority, assignee_id, assignee_name, description, created_at, updated_at)
      VALUES
        ('T10', 'tnt_z', 'IX', 'WF9', 'Old Name', 'SA', 'StepA', 'task', 'completed', 'med', 'op', 'Op', 'd', '2026-02-01', '2026-02-01'),
        ('T11', 'tnt_z', 'IX', 'WF9', 'New Name', 'SB', 'StepB', 'task', 'pending',   'med', 'op', 'Op', 'd', '2026-02-02', '2026-02-02')
    `.execute(db);

    const { migration } = await import(
      '../../../../src/database/migrations/042-create-workflow-central-instances-table'
    );
    await migration.run(db, 'sqlite');

    const rows = await sql<{
      id: string;
      workflow_name: string;
      current_step_id: string;
      current_step_name: string;
    }>`SELECT id, workflow_name, current_step_id, current_step_name
       FROM workflow_central_instances WHERE id='IX'`.execute(db);

    expect(rows.rows).toHaveLength(1);
    // Most-recent pending task wins for workflow_name / step fields
    expect(rows.rows[0].workflow_name).toBe('New Name');
    expect(rows.rows[0].current_step_id).toBe('SB');
    expect(rows.rows[0].current_step_name).toBe('StepB');
  });
});
