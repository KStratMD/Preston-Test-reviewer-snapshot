import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_integration_config_history_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_config_history (
          id TEXT PRIMARY KEY,
          config_id TEXT NOT NULL,
          version INTEGER NOT NULL,
          configuration TEXT NOT NULL,
          checksum TEXT NOT NULL,
          is_active INTEGER DEFAULT 0,
          created_by TEXT NOT NULL,
          description TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(config_id, version)
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_config_history (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          config_id VARCHAR(255) NOT NULL,
          version INTEGER NOT NULL,
          configuration JSONB NOT NULL,
          checksum VARCHAR(64) NOT NULL,
          is_active BOOLEAN DEFAULT FALSE,
          created_by VARCHAR(255) NOT NULL,
          description TEXT,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(config_id, version)
        )
      `.execute(db);
    }
  },
};
