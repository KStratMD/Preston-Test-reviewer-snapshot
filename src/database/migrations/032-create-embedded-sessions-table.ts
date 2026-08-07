import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_embedded_sessions_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS embedded_sessions (
          session_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          platform_account_id TEXT,
          csrf_token TEXT NOT NULL,
          expected_host_origin TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          last_rotation_at TEXT,
          erp_record_type TEXT,
          erp_record_id TEXT,
          erp_record_url TEXT,
          user_roles TEXT,
          created_at TEXT NOT NULL DEFAULT (STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS embedded_sessions (
          session_id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          platform TEXT NOT NULL,
          platform_account_id TEXT,
          csrf_token TEXT NOT NULL,
          expected_host_origin TEXT NOT NULL,
          expires_at TIMESTAMP NOT NULL,
          last_rotation_at TIMESTAMP,
          erp_record_type TEXT,
          erp_record_id TEXT,
          erp_record_url TEXT,
          user_roles TEXT,
          created_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `.execute(db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_embedded_sessions_expires_at ON embedded_sessions(expires_at)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_embedded_sessions_tenant_id ON embedded_sessions(tenant_id)`.execute(db);
  },
};
