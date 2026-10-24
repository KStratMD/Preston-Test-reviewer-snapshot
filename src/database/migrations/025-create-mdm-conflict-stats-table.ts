import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_conflict_stats_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_conflict_stats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          field_name TEXT NOT NULL,
          source_system TEXT NOT NULL,
          target_system TEXT NOT NULL DEFAULT '',
          conflict_count INTEGER NOT NULL DEFAULT 0,
          resolution_count INTEGER NOT NULL DEFAULT 0,
          auto_resolution_count INTEGER NOT NULL DEFAULT 0,
          manual_resolution_count INTEGER NOT NULL DEFAULT 0,
          last_conflict_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          common_issues TEXT NOT NULL DEFAULT '[]',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(field_name, source_system, target_system)
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_conflict_stats (
          id SERIAL PRIMARY KEY,
          field_name VARCHAR(255) NOT NULL,
          source_system VARCHAR(255) NOT NULL,
          target_system VARCHAR(255) NOT NULL DEFAULT '',
          conflict_count INTEGER NOT NULL DEFAULT 0,
          resolution_count INTEGER NOT NULL DEFAULT 0,
          auto_resolution_count INTEGER NOT NULL DEFAULT 0,
          manual_resolution_count INTEGER NOT NULL DEFAULT 0,
          last_conflict_at TIMESTAMP NOT NULL DEFAULT NOW(),
          common_issues JSONB NOT NULL DEFAULT '[]',
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(field_name, source_system, target_system)
        )
      `.execute(db);
    }
  },
};
