import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_embedded_service_token_versions_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS embedded_service_token_versions (
          token_hash TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          platform_account_id TEXT NOT NULL,
          valid_from TEXT NOT NULL,
          valid_until TEXT NOT NULL,
          retired_at TEXT,
          created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS embedded_service_token_versions (
          token_hash TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          platform_account_id TEXT NOT NULL,
          valid_from TIMESTAMP NOT NULL,
          valid_until TIMESTAMP NOT NULL,
          retired_at TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `.execute(db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_embedded_token_versions_tenant_platform ON embedded_service_token_versions(tenant_id, platform)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_embedded_token_versions_valid_until ON embedded_service_token_versions(valid_until)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_embedded_token_versions_retired_at ON embedded_service_token_versions(retired_at)`.execute(db);
  },
};
