import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}
// Run only THROUGH migration 055: migration 056 flips this column to NOT NULL and
// rebuilds the table, which would invalidate this suite's nullable-column assertions.
async function runThrough055(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) {
    await m.run(db, 'sqlite');
    if (m.name === 'add_integration_config_id_to_reconciliation_schedules') break;
  }
}

describe('migration 055 — integration_config_id on reconciliation_schedules', () => {
  let db: Kysely<Database>;
  beforeEach(async () => { db = makeDb(); await runThrough055(db); });
  afterEach(async () => { await db.destroy(); });

  it('adds a nullable integration_config_id column', async () => {
    const cols = await sql<{ name: string; notnull: number }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    const col = cols.rows.find((c) => c.name === 'integration_config_id');
    expect(col).toBeDefined();
    expect(col!.notnull).toBe(0); // nullable
  });

  it('accepts a row with a null integration_config_id', async () => {
    await sql`
      INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, created_at, updated_at)
      VALUES ('s1','t1','nightly','daily',1,'2026-05-29T00:00:00.000Z','netsuite_business_central_invoice_reconciliation','2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')
    `.execute(db);
    const row = await sql<{ integration_config_id: string | null }>`SELECT integration_config_id FROM reconciliation_schedules WHERE id='s1'`.execute(db);
    expect(row.rows[0].integration_config_id).toBeNull();
  });

  it('round-trips a non-null integration_config_id value', async () => {
    await sql`
      INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, integration_config_id, created_at, updated_at)
      VALUES ('s2','t1','nightly','daily',1,'2026-05-29T00:00:00.000Z','netsuite_business_central_invoice_reconciliation','cfg-123','2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')
    `.execute(db);
    const row = await sql<{ integration_config_id: string | null }>`SELECT integration_config_id FROM reconciliation_schedules WHERE id='s2'`.execute(db);
    expect(row.rows[0].integration_config_id).toBe('cfg-123');
  });

  it('creates the tenant+config index over the right columns', async () => {
    const idx = await sql<{ name: string }>`PRAGMA index_list(reconciliation_schedules)`.execute(db);
    expect(idx.rows.map((r) => r.name)).toContain('idx_reconciliation_schedules_tenant_config');
    const info = await sql<{ name: string }>`PRAGMA index_info(idx_reconciliation_schedules_tenant_config)`.execute(db);
    const cols = info.rows.map((r) => r.name);
    expect(cols).toContain('tenant_id');
    expect(cols).toContain('integration_config_id');
  });

  it('is replay-safe (running twice does not throw and leaves the column intact)', async () => {
    const { migration } = await import('../../../../src/database/migrations/055-add-integration-config-id-to-reconciliation-schedules');
    await expect(migration.run(db, 'sqlite')).resolves.not.toThrow();
    const cols = await sql<{ name: string }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    expect(cols.rows.map((c) => c.name)).toContain('integration_config_id');
  });
});
