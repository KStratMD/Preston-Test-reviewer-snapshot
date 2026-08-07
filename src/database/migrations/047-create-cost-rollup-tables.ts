import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_cost_rollup_tables',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      // Tenant + source columns on ai_usage_logs.
      await sql`ALTER TABLE ai_usage_logs ADD COLUMN tenant_id TEXT NOT NULL DEFAULT '__legacy_unattributed__'`.execute(db);
      await sql`ALTER TABLE ai_usage_logs ADD COLUMN cost_source TEXT NOT NULL DEFAULT 'estimated'`.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS cost_rollup_daily (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          date_utc TEXT NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          measured_count INTEGER NOT NULL DEFAULT 0,
          estimated_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(tenant_id, provider, date_utc)
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS cost_rollup_per_flow (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          flow_name TEXT NOT NULL,
          date_utc TEXT NOT NULL,
          total_cost_usd REAL NOT NULL DEFAULT 0,
          measured_count INTEGER NOT NULL DEFAULT 0,
          estimated_count INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')),
          UNIQUE(tenant_id, flow_name, date_utc)
        )
      `.execute(db);
    } else {
      await sql`ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(255) NOT NULL DEFAULT '__legacy_unattributed__'`.execute(db);
      await sql`ALTER TABLE ai_usage_logs ADD COLUMN IF NOT EXISTS cost_source VARCHAR(32) NOT NULL DEFAULT 'estimated'`.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS cost_rollup_daily (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          provider VARCHAR(64) NOT NULL,
          date_utc DATE NOT NULL,
          total_cost_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
          measured_count INTEGER NOT NULL DEFAULT 0,
          estimated_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tenant_id, provider, date_utc)
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS cost_rollup_per_flow (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          flow_name VARCHAR(128) NOT NULL,
          date_utc DATE NOT NULL,
          total_cost_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
          measured_count INTEGER NOT NULL DEFAULT 0,
          estimated_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tenant_id, flow_name, date_utc)
        )
      `.execute(db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_cost_rollup_daily_tenant_date ON cost_rollup_daily(tenant_id, date_utc)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_cost_rollup_per_flow_tenant_date ON cost_rollup_per_flow(tenant_id, date_utc)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_tenant_id ON ai_usage_logs(tenant_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_ai_usage_logs_cost_source ON ai_usage_logs(cost_source)`.execute(db);
  },
};
