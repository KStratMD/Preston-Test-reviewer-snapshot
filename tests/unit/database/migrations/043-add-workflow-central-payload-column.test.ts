import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as createWorkflowCentralTasks } from '../../../../src/database/migrations/041-create-workflow-central-tasks-table';
import { migration as createWorkflowCentralInstances } from '../../../../src/database/migrations/042-create-workflow-central-instances-table';
import { migration as addPayloadColumn } from '../../../../src/database/migrations/043-add-workflow-central-payload-column';

async function freshDb(): Promise<Kysely<Database>> {
  const sqlite = new BetterSqlite3(':memory:');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  await createWorkflowCentralTasks.run(db, 'sqlite');
  await createWorkflowCentralInstances.run(db, 'sqlite');
  return db;
}

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return rows.rows.map((r) => r.name);
}

describe('Migration 043 — add workflow_central payload column', () => {
  it('has the expected name', () => {
    expect(addPayloadColumn.name).toBe('add_workflow_central_payload_column');
  });

  it('adds payload TEXT column to workflow_central_tasks', async () => {
    const db = await freshDb();
    try {
      expect(await columnNames(db, 'workflow_central_tasks')).not.toContain('payload');
      await addPayloadColumn.run(db, 'sqlite');
      const cols = await columnNames(db, 'workflow_central_tasks');
      expect(cols).toContain('payload');
    } finally {
      await db.destroy();
    }
  });

  it('adds payload TEXT column to workflow_central_instances', async () => {
    const db = await freshDb();
    try {
      expect(await columnNames(db, 'workflow_central_instances')).not.toContain('payload');
      await addPayloadColumn.run(db, 'sqlite');
      const cols = await columnNames(db, 'workflow_central_instances');
      expect(cols).toContain('payload');
    } finally {
      await db.destroy();
    }
  });

  it('preserves legacy data and variables columns (NOT dropped)', async () => {
    const db = await freshDb();
    try {
      await addPayloadColumn.run(db, 'sqlite');
      expect(await columnNames(db, 'workflow_central_tasks')).toContain('data');
      expect(await columnNames(db, 'workflow_central_instances')).toContain('variables');
    } finally {
      await db.destroy();
    }
  });

  it('is idempotent — replaying the migration is a no-op (swallows duplicate column error)', async () => {
    const db = await freshDb();
    try {
      await addPayloadColumn.run(db, 'sqlite');
      // Second pass MUST NOT throw
      await expect(addPayloadColumn.run(db, 'sqlite')).resolves.toBeUndefined();
      // And the columns are still present singly (SQLite would have errored without swallow)
      const tasksCols = await columnNames(db, 'workflow_central_tasks');
      const instancesCols = await columnNames(db, 'workflow_central_instances');
      expect(tasksCols.filter((c) => c === 'payload')).toHaveLength(1);
      expect(instancesCols.filter((c) => c === 'payload')).toHaveLength(1);
    } finally {
      await db.destroy();
    }
  });

  it('allows the payload column to store JSON-serialized WorkflowPayload', async () => {
    const db = await freshDb();
    try {
      await addPayloadColumn.run(db, 'sqlite');
      const samplePayload = JSON.stringify({
        mode: 'external_reference',
        references: [{ system: 'netsuite', recordType: 'vendor', recordId: 'V-1' }],
      });
      // Manual INSERT bypasses the repository converters — proves the schema accepts the column.
      await sql`
        INSERT INTO workflow_central_tasks (
          id, tenant_id, instance_id, workflow_id, workflow_name, step_id, step_name,
          task_type, status, priority, assignee_id, assignee_name, description,
          due_at, data, actions, created_at, updated_at, payload
        ) VALUES (
          'T-1', 'tenant-A', 'INST-1', 'WF-1', 'Wflow', 'S-1', 'Step',
          'task', 'pending', 'medium', 'user-1', 'User', 'desc',
          NULL, '{}', '[]', '2026-05-18T00:00:00Z', '2026-05-18T00:00:00Z', ${samplePayload}
        )
      `.execute(db);

      const out = await sql<{ payload: string | null }>`SELECT payload FROM workflow_central_tasks WHERE id = 'T-1'`.execute(db);
      expect(out.rows[0]?.payload).toBe(samplePayload);
    } finally {
      await db.destroy();
    }
  });
});
