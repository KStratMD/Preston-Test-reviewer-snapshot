import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as m012 } from '../../../../src/database/migrations/012-create-ai-configurations-table';
import { migration as m047 } from '../../../../src/database/migrations/047-create-cost-rollup-tables';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

describe('migration 047: cost rollup tables + ai_usage_logs columns', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    // ai_usage_logs lives in migration 012; it's the table we ALTER.
    await m012.run(db, 'sqlite');
    await m047.run(db, 'sqlite');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates cost_rollup_daily with the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(cost_rollup_daily)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'created_at',
      'date_utc',
      'estimated_count',
      'id',
      'measured_count',
      'provider',
      'tenant_id',
      'total_cost_usd',
    ]);
  });

  it('creates cost_rollup_per_flow with the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(cost_rollup_per_flow)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'created_at',
      'date_utc',
      'estimated_count',
      'flow_name',
      'id',
      'measured_count',
      'tenant_id',
      'total_cost_usd',
    ]);
  });

  it('adds tenant_id and cost_source to ai_usage_logs with safe defaults', async () => {
    const cols = await sql<{ name: string; dflt_value: string | null }>`PRAGMA table_info(ai_usage_logs)`.execute(db);
    const tenantCol = cols.rows.find((r) => r.name === 'tenant_id');
    const sourceCol = cols.rows.find((r) => r.name === 'cost_source');
    expect(tenantCol?.dflt_value).toBe("'__legacy_unattributed__'");
    expect(sourceCol?.dflt_value).toBe("'estimated'");
  });

  it('creates the rollup indexes', async () => {
    const idx = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('cost_rollup_daily','cost_rollup_per_flow')`.execute(db);
    const names = idx.rows.map((r) => r.name).sort();
    expect(names).toContain('idx_cost_rollup_daily_tenant_date');
    expect(names).toContain('idx_cost_rollup_per_flow_tenant_date');
  });

  it('creates the ai_usage_logs indexes', async () => {
    const idx = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index' AND tbl_name = 'ai_usage_logs'
    `.execute(db);
    const names = idx.rows.map((r) => r.name);
    expect(names).toContain('idx_ai_usage_logs_tenant_id');
    expect(names).toContain('idx_ai_usage_logs_cost_source');
  });
});
