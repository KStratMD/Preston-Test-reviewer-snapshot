import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

describe('migration 052 — add handler_key to reconciliation_schedules', () => {
  let db: Kysely<Database>;
  beforeEach(async () => { db = makeDb(); await runAll(db); });
  afterEach(async () => { await db.destroy(); });

  it('adds the handler_key column', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain('handler_key');
  });

  it('defaults handler_key to the netsuite↔bc reconciler when omitted', async () => {
    await sql`
      INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, integration_config_id, created_at, updated_at)
      VALUES ('sch_1', 't1', 'nightly', 'daily', 1, '2026-05-29T00:00:00.000Z', 'cfg_t', '2026-05-29T00:00:00.000Z', '2026-05-29T00:00:00.000Z')
    `.execute(db);
    const row = await sql<{ handler_key: string }>`SELECT handler_key FROM reconciliation_schedules WHERE id = 'sch_1'`.execute(db);
    expect(row.rows[0].handler_key).toBe('netsuite_business_central_invoice_reconciliation');
  });

  it('is replay-safe (running twice does not throw and leaves the column intact)', async () => {
    const { migration } = await import('../../../../src/database/migrations/052-add-handler-key-to-reconciliation-schedules');
    await expect(migration.run(db, 'sqlite')).resolves.not.toThrow();
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    expect(cols.rows.map((r) => r.name)).toContain('handler_key');
  });
});
