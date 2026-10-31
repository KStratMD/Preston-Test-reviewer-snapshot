import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as createAuditLogs } from '../../../../src/database/migrations/006-create-audit-logs-table';
import { migration as hardenAuditLogs } from '../../../../src/database/migrations/031-harden-audit-logs-for-persistence';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

describe('031 harden audit_logs for persistence', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('backfills null tenants, adds durable detail columns, and makes tenant_id non-null in sqlite', async () => {
    await createAuditLogs.run(db, 'sqlite');
    await sql`
      INSERT INTO audit_logs (
        id, tenant_id, user_id, action, resource_type, resource_id,
        old_values, new_values, ip_address, user_agent, created_at
      ) VALUES (
        'legacy-1', NULL, 'user-1', 'execute_workflow', 'multi_agent_orchestrator',
        'session-1', NULL, NULL, NULL, NULL, '2026-05-03T00:00:00.000Z'
      )
    `.execute(db);

    await hardenAuditLogs.run(db, 'sqlite');

    const columns = await sql<{ name: string; notnull: number }>`
      PRAGMA table_info(audit_logs)
    `.execute(db);
    const byName = new Map(columns.rows.map((column) => [column.name, column]));

    expect(byName.get('tenant_id')?.notnull).toBe(1);
    expect(byName.has('details')).toBe(true);
    expect(byName.has('result')).toBe(true);
    expect(byName.has('error_message')).toBe(true);
    expect(byName.has('duration_ms')).toBe(true);

    const rows = await sql<{ tenant_id: string; result: string }>`
      SELECT tenant_id, result FROM audit_logs WHERE id = 'legacy-1'
    `.execute(db);
    expect(rows.rows).toEqual([
      { tenant_id: '__legacy_unattributed__', result: 'success' },
    ]);
  });
});
