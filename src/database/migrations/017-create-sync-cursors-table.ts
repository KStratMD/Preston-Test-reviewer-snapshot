import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_sync_cursors_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          id TEXT PRIMARY KEY,
          flow_id TEXT NOT NULL,
          source_system TEXT NOT NULL,
          target_system TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          last_sync_timestamp INTEGER NOT NULL,
          last_record_id TEXT,
          checksum TEXT,
          records_processed INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'paused', 'error')),
          metadata TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(flow_id, entity_type)
        )
      `.execute(db);

      // Create indexes for fast lookups
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_flow_id ON sync_cursors(flow_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_status ON sync_cursors(status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_flow_entity ON sync_cursors(flow_id, entity_type)`.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS sync_cursors (
          id UUID PRIMARY KEY,
          flow_id VARCHAR(255) NOT NULL,
          source_system VARCHAR(255) NOT NULL,
          target_system VARCHAR(255) NOT NULL,
          entity_type VARCHAR(255) NOT NULL,
          last_sync_timestamp BIGINT NOT NULL,
          last_record_id VARCHAR(255),
          checksum VARCHAR(64),
          records_processed INTEGER DEFAULT 0,
          status VARCHAR(20) NOT NULL DEFAULT 'active'
            CONSTRAINT chk_sync_cursor_status CHECK (status IN ('active', 'paused', 'error')),
          metadata JSONB,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          UNIQUE(flow_id, entity_type)
        )
      `.execute(db);

      // Create indexes for fast lookups
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_flow_id ON sync_cursors(flow_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_status ON sync_cursors(status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_sync_cursors_flow_entity ON sync_cursors(flow_id, entity_type)`.execute(db);
    }
  },
};
