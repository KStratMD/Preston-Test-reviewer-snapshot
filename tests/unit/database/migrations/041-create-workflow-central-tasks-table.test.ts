import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as createWorkflowCentralTasks } from '../../../../src/database/migrations/041-create-workflow-central-tasks-table';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

describe('041 create workflow_central_tasks table', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates the table with correct columns and nullability', async () => {
    await createWorkflowCentralTasks.run(db, 'sqlite');

    const columns = await sql<{
      name: string;
      notnull: number;
      dflt_value: string | null;
      type: string;
      pk: number;
    }>`PRAGMA table_info(workflow_central_tasks)`.execute(db);

    const byName = new Map(columns.rows.map((c) => [c.name, c]));

    // Table must exist — if it doesn't, byName will be empty
    expect(byName.size).toBeGreaterThan(0);

    // `id` uses `TEXT PRIMARY KEY` (no explicit NOT NULL) per spec §2.D3.
    // SQLite's PRAGMA table_info reports notnull=0 for a bare PRIMARY KEY column
    // even though inserting NULL would fail — this is SQLite-specific PRAGMA behaviour.
    expect(byName.get('id')?.pk).toBe(1);
    expect(byName.get('id')?.notnull).toBe(0);

    // NOT NULL columns
    const requiredCols = [
      'tenant_id',
      'instance_id',
      'workflow_id',
      'workflow_name',
      'step_id',
      'step_name',
      'task_type',
      'status',
      'priority',
      'assignee_id',
      'assignee_name',
      'description',
      'created_at',
      'updated_at',
    ];
    for (const col of requiredCols) {
      expect(byName.has(col)).toBe(true);
      expect(byName.get(col)?.notnull).toBe(1);
    }

    // Nullable columns
    const nullableCols = [
      'due_at',
      'completed_at',
      'completed_by',
      'completion_action_id',
      'completion_comment',
    ];
    for (const col of nullableCols) {
      expect(byName.has(col)).toBe(true);
      expect(byName.get(col)?.notnull).toBe(0);
    }

    // NOT NULL columns with defaults
    expect(byName.get('status')?.dflt_value).toBe("'pending'");
    expect(byName.get('data')?.dflt_value).toBe("'{}'");
    expect(byName.get('actions')?.dflt_value).toBe("'[]'");
    expect(byName.get('data')?.notnull).toBe(1);
    expect(byName.get('actions')?.notnull).toBe(1);
  });

  it('creates all 4 indexes with correct column tuples', async () => {
    await createWorkflowCentralTasks.run(db, 'sqlite');

    const indexList = await sql<{
      seq: number;
      name: string;
      unique: number;
    }>`PRAGMA index_list(workflow_central_tasks)`.execute(db);

    const indexNames = new Set(indexList.rows.map((r) => r.name));

    expect(indexNames.has('idx_workflow_central_tasks_assignee_status')).toBe(true);
    expect(indexNames.has('idx_workflow_central_tasks_instance')).toBe(true);
    expect(indexNames.has('idx_workflow_central_tasks_pending_due')).toBe(true);
    expect(indexNames.has('idx_workflow_central_tasks_completed_at')).toBe(true);

    // Verify index column tuples
    const assigneeStatusCols = await sql<{ name: string }>`
      PRAGMA index_info(idx_workflow_central_tasks_assignee_status)
    `.execute(db);
    expect(assigneeStatusCols.rows.map((r) => r.name)).toEqual([
      'tenant_id',
      'assignee_id',
      'status',
    ]);

    const instanceCols = await sql<{ name: string }>`
      PRAGMA index_info(idx_workflow_central_tasks_instance)
    `.execute(db);
    expect(instanceCols.rows.map((r) => r.name)).toEqual([
      'tenant_id',
      'instance_id',
      'status',
    ]);

    const pendingDueCols = await sql<{ name: string }>`
      PRAGMA index_info(idx_workflow_central_tasks_pending_due)
    `.execute(db);
    expect(pendingDueCols.rows.map((r) => r.name)).toEqual([
      'tenant_id',
      'status',
      'due_at',
    ]);

    const completedAtCols = await sql<{ name: string }>`
      PRAGMA index_info(idx_workflow_central_tasks_completed_at)
    `.execute(db);
    expect(completedAtCols.rows.map((r) => r.name)).toEqual([
      'tenant_id',
      'completed_at',
    ]);
  });

  it('is idempotent — running migration twice does not throw', async () => {
    await expect(createWorkflowCentralTasks.run(db, 'sqlite')).resolves.not.toThrow();
    await expect(createWorkflowCentralTasks.run(db, 'sqlite')).resolves.not.toThrow();
  });
});
