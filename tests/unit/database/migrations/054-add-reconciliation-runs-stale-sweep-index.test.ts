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

describe('migration 054 — reconciliation_runs stale-sweep partial index', () => {
  let db: Kysely<Database>;
  beforeEach(async () => { db = makeDb(); await runAll(db); });
  afterEach(async () => { await db.destroy(); });

  it('creates the partial index on reconciliation_runs', async () => {
    const idx = await sql<{ name: string }>`PRAGMA index_list(reconciliation_runs)`.execute(db);
    expect(idx.rows.map((r) => r.name)).toContain('idx_reconciliation_runs_running_started_at');
  });

  it('indexes started_at and is partial on status=running', async () => {
    const info = await sql<{ name: string }>`PRAGMA index_info(idx_reconciliation_runs_running_started_at)`.execute(db);
    expect(info.rows.map((r) => r.name)).toContain('started_at');
    const ddl = await sql<{ sql: string }>`SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_reconciliation_runs_running_started_at'`.execute(db);
    expect(ddl.rows[0].sql).toMatch(/WHERE status = 'running'/i);
  });

  it('is replay-safe (running twice does not throw)', async () => {
    const { migration } = await import('../../../../src/database/migrations/054-add-reconciliation-runs-stale-sweep-index');
    await expect(migration.run(db, 'sqlite')).resolves.not.toThrow();
  });

  it('the reclaim predicate (literal status + range on started_at) USES the partial index', async () => {
    // Pins the whole point of this migration: the planner actually picks the
    // partial index for the sweep's query shape. The reclaim query emits a
    // LITERAL `status = 'running'` (sql.lit) + a bound `started_at < ?`, which is
    // what makes the partial-index predicate provable. A bound `status = ?` here
    // would NOT be guaranteed to use the index (the Copilot concern this answers).
    const plan = await sql<{ detail: string }>`
      EXPLAIN QUERY PLAN
      UPDATE reconciliation_runs SET status = 'failed'
      WHERE status = 'running' AND started_at < ${'2026-05-05T00:00:00.000Z'}
    `.execute(db);
    const detail = plan.rows.map((r) => r.detail).join(' ');
    expect(detail).toMatch(/USING INDEX idx_reconciliation_runs_running_started_at/);
    expect(detail).not.toMatch(/SCAN reconciliation_runs(?! USING)/); // not a full table scan
  });
});
