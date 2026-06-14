import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_data_quality_reports_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS data_quality_reports (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          job_id TEXT,
          source_system TEXT NOT NULL,
          target_system TEXT NOT NULL,
          record_count INTEGER NOT NULL DEFAULT 0,
          valid_records INTEGER NOT NULL DEFAULT 0,
          invalid_records INTEGER NOT NULL DEFAULT 0,
          duplicate_records INTEGER NOT NULL DEFAULT 0,
          quality_score REAL NOT NULL DEFAULT 0.00,
          validation_rules TEXT NOT NULL,
          quality_metrics TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS data_quality_reports (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          integration_id VARCHAR(255) NOT NULL,
          job_id VARCHAR(255),
          source_system VARCHAR(255) NOT NULL,
          target_system VARCHAR(255) NOT NULL,
          record_count INTEGER NOT NULL DEFAULT 0,
          valid_records INTEGER NOT NULL DEFAULT 0,
          invalid_records INTEGER NOT NULL DEFAULT 0,
          duplicate_records INTEGER NOT NULL DEFAULT 0,
          quality_score DECIMAL(5,2) NOT NULL DEFAULT 0.00,
          validation_rules JSONB NOT NULL,
          quality_metrics JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
