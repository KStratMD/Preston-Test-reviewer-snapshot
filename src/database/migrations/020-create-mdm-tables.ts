import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_tables',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_golden_records (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('vendor', 'customer', 'product')),
          data TEXT NOT NULL DEFAULT '{}',
          confidence REAL NOT NULL DEFAULT 0,
          conflicts TEXT NOT NULL DEFAULT '[]',
          conflict_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'pending_review', 'archived')),
          approved_by TEXT,
          approved_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS mdm_entity_sources (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
          source_system TEXT NOT NULL,
          source_record_id TEXT NOT NULL,
          source_data TEXT NOT NULL DEFAULT '{}',
          last_synced_at DATETIME NOT NULL,
          sync_status TEXT NOT NULL DEFAULT 'pending' CHECK (sync_status IN ('synced', 'pending', 'failed', 'manual_required')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS mdm_sync_requests (
          id TEXT PRIMARY KEY,
          golden_record_id TEXT NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
          target_systems TEXT NOT NULL DEFAULT '[]',
          requested_by TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
          reviewed_by TEXT,
          reviewed_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_golden_records (
          id VARCHAR(255) PRIMARY KEY,
          entity_type VARCHAR(50) NOT NULL CONSTRAINT chk_mdm_entity_type CHECK (entity_type IN ('vendor', 'customer', 'product')),
          data JSONB NOT NULL DEFAULT '{}',
          confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
          conflicts JSONB NOT NULL DEFAULT '[]',
          conflict_count INTEGER NOT NULL DEFAULT 0,
          status VARCHAR(50) NOT NULL DEFAULT 'draft' CONSTRAINT chk_mdm_status CHECK (status IN ('draft', 'active', 'pending_review', 'archived')),
          approved_by VARCHAR(255),
          approved_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS mdm_entity_sources (
          id SERIAL PRIMARY KEY,
          golden_record_id VARCHAR(255) NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
          source_system VARCHAR(255) NOT NULL,
          source_record_id VARCHAR(255) NOT NULL,
          source_data JSONB NOT NULL DEFAULT '{}',
          last_synced_at TIMESTAMP NOT NULL,
          sync_status VARCHAR(50) NOT NULL DEFAULT 'pending' CONSTRAINT chk_mdm_sync_status CHECK (sync_status IN ('synced', 'pending', 'failed', 'manual_required')),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);

      await sql`
        CREATE TABLE IF NOT EXISTS mdm_sync_requests (
          id VARCHAR(255) PRIMARY KEY,
          golden_record_id VARCHAR(255) NOT NULL REFERENCES mdm_golden_records(id) ON DELETE CASCADE,
          target_systems JSONB NOT NULL DEFAULT '[]',
          requested_by VARCHAR(255) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending' CONSTRAINT chk_mdm_request_status CHECK (status IN ('pending', 'approved', 'rejected', 'completed')),
          reviewed_by VARCHAR(255),
          reviewed_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
