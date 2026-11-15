import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_sync_error_assist_processed_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_error_assist_processed (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          error_record_id TEXT NOT NULL,
          status TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 1,
          suggestion_record_id TEXT,
          trace_id TEXT,
          provider TEXT,
          cost_estimate_usd_cents INTEGER,
          failure_reason TEXT,
          reserved_at TEXT NOT NULL,
          completed_at TEXT,
          UNIQUE(tenant_id, error_record_id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_status_reserved
          ON sync_error_assist_processed(status, reserved_at)
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_error_assist_processed (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255) NOT NULL,
          error_record_id VARCHAR(255) NOT NULL,
          status VARCHAR(32) NOT NULL,
          attempts INT NOT NULL DEFAULT 1,
          suggestion_record_id VARCHAR(255),
          trace_id VARCHAR(255),
          provider VARCHAR(64),
          cost_estimate_usd_cents INT,
          failure_reason TEXT,
          reserved_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          UNIQUE(tenant_id, error_record_id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_sync_error_assist_processed_status_reserved
          ON sync_error_assist_processed(status, reserved_at)
      `.execute(db);
    }
  },
};
