import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as createActivityLogs } from '../../../../src/database/migrations/044-create-workflow-central-activity-logs-table';

async function freshDb(): Promise<Kysely<Database>> {
  const sqlite = new BetterSqlite3(':memory:');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return db;
}

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return rows.rows.map((r) => r.name);
}

async function indexNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table}`.execute(db);
  return rows.rows.map((r) => r.name);
}

describe('Migration 044 — create workflow_central_activity_logs table', () => {
  it('has the expected name', () => {
    expect(createActivityLogs.name).toBe('create_workflow_central_activity_logs_table');
  });

  it('creates the table with all expected columns', async () => {
    const db = await freshDb();
    try {
      await createActivityLogs.run(db, 'sqlite');
      const cols = await columnNames(db, 'workflow_central_activity_logs');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'tenant_id',
          'instance_id',
          'workflow_name',
          'action',
          'user_id',
          'user_name',
          'step_name',
          'details',
          'timestamp',
        ]),
      );
    } finally {
      await db.destroy();
    }
  });

  it('creates the two tenant-scoped indexes', async () => {
    const db = await freshDb();
    try {
      await createActivityLogs.run(db, 'sqlite');
      const indexes = await indexNames(db, 'workflow_central_activity_logs');
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_wc_activity_logs_tenant_timestamp',
          'idx_wc_activity_logs_tenant_instance_timestamp',
        ]),
      );
    } finally {
      await db.destroy();
    }
  });

  it('is idempotent — replaying the migration is a no-op', async () => {
    const db = await freshDb();
    try {
      await createActivityLogs.run(db, 'sqlite');
      await expect(createActivityLogs.run(db, 'sqlite')).resolves.toBeUndefined();
      const cols = await columnNames(db, 'workflow_central_activity_logs');
      expect(cols).toContain('id');
    } finally {
      await db.destroy();
    }
  });

  it('accepts inserts with the expected shape', async () => {
    const db = await freshDb();
    try {
      await createActivityLogs.run(db, 'sqlite');
      const details = JSON.stringify({ previous_status: 'running', cancelled_by: 'user-1' });
      await sql`
        INSERT INTO workflow_central_activity_logs (
          id, tenant_id, instance_id, workflow_name, action, user_id, user_name,
          step_name, details, timestamp
        ) VALUES (
          'A-1', 'tenant-A', 'INST-1', 'Wflow', 'instance_cancelled', 'user-1', 'User One',
          'Step 1', ${details}, '2026-05-18T00:00:00Z'
        )
      `.execute(db);
      const rows = await sql<{ id: string; details: string | null }>`
        SELECT id, details FROM workflow_central_activity_logs WHERE id = 'A-1'
      `.execute(db);
      expect(rows.rows[0]?.id).toBe('A-1');
      expect(rows.rows[0]?.details).toBe(details);
    } finally {
      await db.destroy();
    }
  });

  it('allows nullable step_name and details', async () => {
    const db = await freshDb();
    try {
      await createActivityLogs.run(db, 'sqlite');
      await sql`
        INSERT INTO workflow_central_activity_logs (
          id, tenant_id, instance_id, workflow_name, action, user_id, user_name,
          step_name, details, timestamp
        ) VALUES (
          'A-2', 'tenant-A', 'INST-2', 'Wflow', 'instance_started', 'user-1', 'User One',
          NULL, NULL, '2026-05-18T00:00:01Z'
        )
      `.execute(db);
      const rows = await sql<{ step_name: string | null; details: string | null }>`
        SELECT step_name, details FROM workflow_central_activity_logs WHERE id = 'A-2'
      `.execute(db);
      expect(rows.rows[0]?.step_name).toBeNull();
      expect(rows.rows[0]?.details).toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
