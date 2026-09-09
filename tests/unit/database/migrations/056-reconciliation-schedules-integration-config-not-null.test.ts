import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { UNCONFIGURED_INTEGRATION_CONFIG_ID } from '../../../../src/services/reconciliationCenter/constants';

const MIGRATION_056_NAME = 'reconciliation_schedules_integration_config_not_null';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}
async function runThroughPrior(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) {
    if (m.name === MIGRATION_056_NAME) break;
    await m.run(db, 'sqlite');
  }
}
function migration056() {
  const m = MIGRATIONS.find((x) => x.name === MIGRATION_056_NAME);
  if (!m) throw new Error('migration 056 not registered');
  return m;
}

// Capture the error from a failing statement via try/catch + string match rather than
// `expect(...).rejects.toThrow()`. better-sqlite3's native binding caches its SqliteError
// constructor process-globally; when this file runs after another that initialized
// better-sqlite3 in a different Jest VM realm, the thrown error's `instanceof Error`
// resolves against the wrong realm's Error.prototype, so Jest's `.rejects.toThrow()` isError
// gate returns false and reports a misleading "Received function did not throw" even though
// the constraint DID fire. Same pattern as the migration 040/042/049 tests.
async function captureExecError(run: () => Promise<unknown>): Promise<string> {
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
  return String(err);
}

describe('migration 056 — integration_config_id NOT NULL flip', () => {
  let db: Kysely<Database>;
  beforeEach(async () => { db = makeDb(); await runThroughPrior(db); });
  afterEach(async () => { await db.destroy(); });

  it('backfills NULL configs to the sentinel and deactivates those rows', async () => {
    await sql`INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, integration_config_id, created_at, updated_at)
      VALUES ('s_null','t1','n','daily',1,'2026-05-29T00:00:00.000Z','netsuite_business_central_invoice_reconciliation',NULL,'2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')`.execute(db);
    await sql`INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, integration_config_id, created_at, updated_at)
      VALUES ('s_ok','t1','n','daily',1,'2026-05-29T00:00:00.000Z','netsuite_business_central_invoice_reconciliation','cfg_real','2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')`.execute(db);

    await migration056().run(db, 'sqlite');

    const rows = await sql<{ id: string; integration_config_id: string; active: number }>`
      SELECT id, integration_config_id, active FROM reconciliation_schedules ORDER BY id`.execute(db);
    const nullRow = rows.rows.find((r) => r.id === 's_null')!;
    const okRow = rows.rows.find((r) => r.id === 's_ok')!;
    expect(nullRow.integration_config_id).toBe(UNCONFIGURED_INTEGRATION_CONFIG_ID);
    expect(nullRow.active).toBe(0);
    expect(okRow.integration_config_id).toBe('cfg_real');
    expect(okRow.active).toBe(1);
  });

  it('makes the column NOT NULL (rejecting a NULL insert) and preserves both indexes', async () => {
    await migration056().run(db, 'sqlite');
    const cols = await sql<{ name: string; notnull: number }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    expect(cols.rows.find((c) => c.name === 'integration_config_id')!.notnull).toBe(1);

    const idx = await sql<{ name: string }>`PRAGMA index_list(reconciliation_schedules)`.execute(db);
    const names = idx.rows.map((r) => r.name);
    expect(names).toContain('idx_reconciliation_schedules_tenant_active');
    expect(names).toContain('idx_reconciliation_schedules_tenant_config');

    const nullErr = await captureExecError(() => sql`INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, handler_key, integration_config_id, created_at, updated_at)
      VALUES ('s_bad','t1','n','daily',1,'2026-05-29T00:00:00.000Z','netsuite_business_central_invoice_reconciliation',NULL,'2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')`.execute(db));
    expect(nullErr).toMatch(/NOT NULL constraint failed/);
  });

  it('preserves the cadence CHECK and handler_key default after the rebuild', async () => {
    await migration056().run(db, 'sqlite');
    const checkErr = await captureExecError(() => sql`INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, integration_config_id, created_at, updated_at)
      VALUES ('s_chk','t1','n','yearly',1,'2026-05-29T00:00:00.000Z','cfg','2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')`.execute(db));
    expect(checkErr).toMatch(/CHECK constraint failed/);
    await sql`INSERT INTO reconciliation_schedules (id, tenant_id, name, cadence, active, next_run_at, integration_config_id, created_at, updated_at)
      VALUES ('s_def','t1','n','daily',1,'2026-05-29T00:00:00.000Z','cfg','2026-05-29T00:00:00.000Z','2026-05-29T00:00:00.000Z')`.execute(db);
    const r = await sql<{ handler_key: string }>`SELECT handler_key FROM reconciliation_schedules WHERE id='s_def'`.execute(db);
    expect(r.rows[0].handler_key).toBe('netsuite_business_central_invoice_reconciliation');
  });

  it('runtime sentinel constant matches the canonical literal', () => {
    expect(UNCONFIGURED_INTEGRATION_CONFIG_ID).toBe('__unconfigured__');
  });

  it('is replay-safe (running 056 twice does not throw and keeps the column NOT NULL)', async () => {
    // The migration runner records the migrations row AFTER run() and wraps nothing
    // in a transaction, so an interrupted run re-executes from the top. The SQLite
    // rebuild's CREATE TABLE IF NOT EXISTS must keep that re-run harmless.
    await migration056().run(db, 'sqlite');
    await expect(migration056().run(db, 'sqlite')).resolves.not.toThrow();
    const cols = await sql<{ name: string; notnull: number }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    expect(cols.rows.find((c) => c.name === 'integration_config_id')!.notnull).toBe(1);
  });

  it('recovers from an orphaned _new table left by an interrupted prior run', async () => {
    // Simulate a crash after the rebuild table was created (and partially populated)
    // but before DROP/RENAME completed: a stale reconciliation_schedules_new exists.
    // The migration must DROP IF EXISTS it and rebuild cleanly rather than colliding.
    await sql`CREATE TABLE reconciliation_schedules_new (id TEXT PRIMARY KEY, junk TEXT)`.execute(db);
    await sql`INSERT INTO reconciliation_schedules_new (id, junk) VALUES ('stale', 'debris')`.execute(db);
    await expect(migration056().run(db, 'sqlite')).resolves.not.toThrow();
    const cols = await sql<{ name: string; notnull: number }>`PRAGMA table_info(reconciliation_schedules)`.execute(db);
    expect(cols.rows.find((c) => c.name === 'integration_config_id')!.notnull).toBe(1);
    // the orphan was dropped — no stale row survived into the rebuilt table
    const stale = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM reconciliation_schedules WHERE id='stale'`.execute(db);
    expect(Number(stale.rows[0].c)).toBe(0);
  });
});
