import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_integration_jobs_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_jobs (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          queue_job_id TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          total_records INTEGER NOT NULL DEFAULT 0,
          processed_records INTEGER NOT NULL DEFAULT 0,
          failed_records INTEGER NOT NULL DEFAULT 0,
          batch_size INTEGER NOT NULL DEFAULT 100,
          priority INTEGER NOT NULL DEFAULT 0,
          started_at DATETIME,
          completed_at DATETIME,
          error_message TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_jobs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          integration_id VARCHAR(255) NOT NULL,
          queue_job_id VARCHAR(255) NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          total_records INTEGER NOT NULL DEFAULT 0,
          processed_records INTEGER NOT NULL DEFAULT 0,
          failed_records INTEGER NOT NULL DEFAULT 0,
          batch_size INTEGER NOT NULL DEFAULT 100,
          priority INTEGER NOT NULL DEFAULT 0,
          started_at TIMESTAMP,
          completed_at TIMESTAMP,
          error_message TEXT,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT chk_status CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled'))
        )
      `.execute(db);
    }
  },
};
