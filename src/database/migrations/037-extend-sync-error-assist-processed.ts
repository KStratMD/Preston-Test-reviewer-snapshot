import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'extend_sync_error_assist_processed',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      // SQLite ALTER TABLE supports ADD COLUMN one at a time.
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN confidence TEXT`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN suggestion_type TEXT`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN suggestion_text TEXT`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN references_field TEXT`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN operator_disposition TEXT NOT NULL DEFAULT 'pending'`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN operator_disposition_at TEXT`.execute(db);
      await sql`ALTER TABLE sync_error_assist_processed ADD COLUMN operator_disposition_user_id TEXT`.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_disposition
          ON sync_error_assist_processed(tenant_id, status, operator_disposition)
      `.execute(db);
    } else {
      await sql`
        ALTER TABLE sync_error_assist_processed
          ADD COLUMN IF NOT EXISTS confidence VARCHAR(16),
          ADD COLUMN IF NOT EXISTS suggestion_type VARCHAR(32),
          ADD COLUMN IF NOT EXISTS suggestion_text TEXT,
          ADD COLUMN IF NOT EXISTS references_field VARCHAR(255),
          ADD COLUMN IF NOT EXISTS operator_disposition VARCHAR(16) NOT NULL DEFAULT 'pending',
          ADD COLUMN IF NOT EXISTS operator_disposition_at TIMESTAMP,
          ADD COLUMN IF NOT EXISTS operator_disposition_user_id VARCHAR(255)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_disposition
          ON sync_error_assist_processed(tenant_id, status, operator_disposition)
      `.execute(db);
    }
  },
};
