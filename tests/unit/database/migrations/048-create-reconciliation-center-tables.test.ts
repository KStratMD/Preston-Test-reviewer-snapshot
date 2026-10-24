import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as m048 } from '../../../../src/database/migrations/048-create-reconciliation-center-tables';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

describe('migration 048: reconciliation center tables', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await m048.run(db, 'sqlite');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates the three reconciliation tables', async () => {
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `.execute(db);
    const names = tables.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'reconciliation_exceptions',
        'reconciliation_schedules',
        'reconciliation_runs',
      ]),
    );
  });

  it('creates reconciliation_exceptions with the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_exceptions)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'amount_delta',
      'assigned_to',
      'created_at',
      'currency',
      'description',
      'due_at',
      'exception_type',
      'id',
      'resolution_note',
      'resolved_at',
      'resolved_by',
      'severity',
      'source_record_id',
      'source_system',
      'status',
      'suggested_action',
      'target_record_id',
      'target_system',
      'tenant_id',
      'updated_at',
    ]);
  });

  it('creates reconciliation_schedules with the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'active',
      'cadence',
      'created_at',
      'id',
      'name',
      'next_run_at',
      'tenant_id',
      'updated_at',
    ]);
  });

  it('creates reconciliation_runs with the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_runs)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'completed_at',
      'error_message',
      'exceptions_created',
      'id',
      'schedule_id',
      'started_at',
      'status',
      'tenant_id',
    ]);
  });

  it('creates the tenant-scoped indexes', async () => {
    const idx = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index'
        AND tbl_name IN ('reconciliation_exceptions','reconciliation_schedules','reconciliation_runs')
    `.execute(db);
    const names = idx.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'idx_reconciliation_exceptions_tenant_status',
        'idx_reconciliation_exceptions_tenant_severity',
        'idx_reconciliation_schedules_tenant_active',
        'idx_reconciliation_runs_tenant_schedule',
      ]),
    );
  });
});
