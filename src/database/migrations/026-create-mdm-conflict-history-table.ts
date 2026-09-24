import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_mdm_conflict_history_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_conflict_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          field_name TEXT NOT NULL,
          source_a TEXT NOT NULL,
          source_b TEXT NOT NULL,
          value_a TEXT NOT NULL,
          value_b TEXT NOT NULL,
          resolution TEXT NOT NULL CHECK (resolution IN ('auto', 'manual', 'pending')),
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS mdm_conflict_history (
          id SERIAL PRIMARY KEY,
          field_name VARCHAR(255) NOT NULL,
          source_a VARCHAR(255) NOT NULL,
          source_b VARCHAR(255) NOT NULL,
          value_a TEXT NOT NULL,
          value_b TEXT NOT NULL,
          resolution VARCHAR(20) NOT NULL CONSTRAINT chk_mdm_conflict_resolution CHECK (resolution IN ('auto', 'manual', 'pending')),
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
