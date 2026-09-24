import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_ai_sessions_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS ai_sessions (
          session_id TEXT PRIMARY KEY,
          user_id TEXT,
          workflow_type TEXT,
          started_at DATETIME NOT NULL,
          completed_at DATETIME,
          status TEXT,
          overall_confidence REAL,
          total_execution_time INTEGER,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS ai_sessions (
          session_id VARCHAR(255) PRIMARY KEY,
          user_id VARCHAR(255),
          workflow_type VARCHAR(255),
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          status VARCHAR(50),
          overall_confidence REAL,
          total_execution_time INTEGER,
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW()
        )
      `.execute(db);
    }
  },
};
