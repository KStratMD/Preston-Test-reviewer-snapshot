import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_sync_error_assist_runs_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_error_assist_runs (
          tenant_id TEXT PRIMARY KEY,
          last_modified_at INTEGER NOT NULL,
          updated_at TEXT NOT NULL
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_error_assist_runs (
          tenant_id VARCHAR(255) PRIMARY KEY,
          last_modified_at BIGINT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
