import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_dead_letter_records_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS dead_letter_records (
          id TEXT PRIMARY KEY,
          original_queue TEXT NOT NULL,
          job_id TEXT NOT NULL,
          job_data TEXT NOT NULL,
          error TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at DATETIME NOT NULL,
          retried_at DATETIME,
          retry_queue TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS dead_letter_records (
          id VARCHAR(255) PRIMARY KEY,
          original_queue VARCHAR(255) NOT NULL,
          job_id VARCHAR(255) NOT NULL,
          job_data JSONB NOT NULL,
          error TEXT NOT NULL,
          failure_count INTEGER NOT NULL DEFAULT 0,
          last_attempt_at TIMESTAMP NOT NULL,
          retried_at TIMESTAMP,
          retry_queue VARCHAR(255),
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
