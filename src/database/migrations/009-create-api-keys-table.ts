import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_api_keys_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS api_keys (
          id TEXT PRIMARY KEY,
          tenant_id TEXT,
          key_name TEXT NOT NULL,
          key_hash TEXT NOT NULL UNIQUE,
          key_prefix TEXT NOT NULL,
          permissions TEXT NOT NULL,
          rate_limit INTEGER,
          expires_at DATETIME,
          last_used_at DATETIME,
          is_active INTEGER DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS api_keys (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255),
          key_name VARCHAR(255) NOT NULL,
          key_hash VARCHAR(255) NOT NULL UNIQUE,
          key_prefix VARCHAR(50) NOT NULL,
          permissions TEXT[] NOT NULL,
          rate_limit INTEGER,
          expires_at TIMESTAMP,
          last_used_at TIMESTAMP,
          is_active BOOLEAN DEFAULT TRUE,
          created_by VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
