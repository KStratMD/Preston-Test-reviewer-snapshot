import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { migration as m053 } from '../../../../src/database/migrations/053-reconciliation-schedule-next-run-at-tztz';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

describe('migration 053 — reconciliation_schedules.next_run_at TIMESTAMPTZ', () => {
  let db: Kysely<Database>;
  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });
  afterEach(async () => {
    await db.destroy();
  });

  // SQLite has no real timestamp types (the column is TEXT) — the migration is a
  // no-op there. The real Postgres TIMESTAMP -> TIMESTAMPTZ conversion is exercised
  // by the Postgres Integration CI job.
  it('is a no-op on sqlite and leaves the schedule table writable with ISO strings', async () => {
    await expect(m053.run(db, 'sqlite')).resolves.not.toThrow();
    await sql`
      INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, integration_config_id, created_at, updated_at)
      VALUES ('sch_1', 't1', 'nightly', 'hourly', 1, '2026-05-29T00:00:00.000Z', 'netsuite_business_central_invoice_reconciliation', 'cfg_t', '2026-05-29T00:00:00.000Z', '2026-05-29T00:00:00.000Z')
    `.execute(db);
    const row = await sql<{ next_run_at: string }>`SELECT next_run_at FROM reconciliation_schedules WHERE id = 'sch_1'`.execute(db);
    expect(row.rows[0].next_run_at).toBe('2026-05-29T00:00:00.000Z');
  });

  it('is replay-safe on sqlite (running twice does not throw)', async () => {
    await expect(m053.run(db, 'sqlite')).resolves.not.toThrow();
    await expect(m053.run(db, 'sqlite')).resolves.not.toThrow();
  });
});
