-- Delta Sync Cursor Store Schema
-- Supports both SQLite and PostgreSQL

-- SQLite version
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
  status TEXT CHECK(status IN ('active', 'paused', 'error')) DEFAULT 'active',
  metadata TEXT, -- JSON
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sync_cursors_flow ON sync_cursors(flow_id);
CREATE INDEX IF NOT EXISTS idx_sync_cursors_system ON sync_cursors(source_system, target_system);
CREATE INDEX IF NOT EXISTS idx_sync_cursors_entity ON sync_cursors(entity_type);
CREATE INDEX IF NOT EXISTS idx_sync_cursors_status ON sync_cursors(status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_cursors_unique ON sync_cursors(flow_id, entity_type);

-- PostgreSQL version (conditional, will not run on SQLite)
-- CREATE TABLE IF NOT EXISTS sync_cursors (
--   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
--   flow_id VARCHAR(255) NOT NULL,
--   source_system VARCHAR(100) NOT NULL,
--   target_system VARCHAR(100) NOT NULL,
--   entity_type VARCHAR(100) NOT NULL,
--   last_sync_timestamp BIGINT NOT NULL,
--   last_record_id VARCHAR(255),
--   checksum VARCHAR(64),
--   records_processed INTEGER DEFAULT 0,
--   status VARCHAR(20) CHECK(status IN ('active', 'paused', 'error')) DEFAULT 'active',
--   metadata JSONB,
--   created_at BIGINT NOT NULL,
--   updated_at BIGINT NOT NULL
-- );
