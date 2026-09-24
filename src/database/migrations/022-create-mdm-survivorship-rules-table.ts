import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_survivorship_rules_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_survivorship_rules (
          id TEXT PRIMARY KEY,
          entity_type TEXT NOT NULL CHECK (entity_type IN ('vendor', 'customer', 'product', '*')),
          field_name TEXT NOT NULL,
          strategy TEXT NOT NULL CHECK (strategy IN ('source_priority', 'most_recent', 'most_complete', 'frequency', 'custom')),
          config TEXT NOT NULL DEFAULT '{}',
          priority INTEGER NOT NULL DEFAULT 1,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_survivorship_rules (
          id VARCHAR(255) PRIMARY KEY,
          entity_type VARCHAR(50) NOT NULL CONSTRAINT chk_mdm_rule_entity_type CHECK (entity_type IN ('vendor', 'customer', 'product', '*')),
          field_name VARCHAR(50) NOT NULL,
          strategy VARCHAR(50) NOT NULL CONSTRAINT chk_mdm_rule_strategy CHECK (strategy IN ('source_priority', 'most_recent', 'most_complete', 'frequency', 'custom')),
          config JSONB NOT NULL DEFAULT '{}',
          priority INTEGER NOT NULL DEFAULT 1,
          is_default INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
