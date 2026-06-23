import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_tenant_configurations_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS tenant_configurations (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          setting_key TEXT NOT NULL,
          setting_value TEXT NOT NULL,
          is_encrypted INTEGER DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(tenant_id, setting_key)
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS tenant_configurations (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255) NOT NULL,
          setting_key VARCHAR(255) NOT NULL,
          setting_value TEXT NOT NULL,
          is_encrypted BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(tenant_id, setting_key)
        )
      `.execute(db);
    }
  },
};
