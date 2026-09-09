import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_integration_execution_logs_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_execution_logs (
          id TEXT PRIMARY KEY,
          integration_id TEXT NOT NULL,
          job_id TEXT,
          level TEXT NOT NULL,
          message TEXT NOT NULL,
          metadata TEXT,
          trace_id TEXT,
          span_id TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (level IN ('info', 'warn', 'error', 'debug'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS integration_execution_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          integration_id VARCHAR(255) NOT NULL,
          job_id VARCHAR(255),
          level VARCHAR(20) NOT NULL,
          message TEXT NOT NULL,
          metadata JSONB,
          trace_id VARCHAR(255),
          span_id VARCHAR(255),
          created_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT chk_level CHECK (level IN ('info', 'warn', 'error', 'debug'))
        )
      `.execute(db);
    }
  },
};
