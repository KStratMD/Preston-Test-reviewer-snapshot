import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_reasoning_traces_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS reasoning_traces (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES ai_sessions(session_id) ON DELETE CASCADE,
          step_number INTEGER NOT NULL,
          agent_name TEXT NOT NULL,
          action TEXT NOT NULL,
          input_summary TEXT,
          output_summary TEXT,
          confidence REAL,
          reasoning TEXT,
          timestamp DATETIME NOT NULL,
          execution_time INTEGER,
          user_id TEXT,
          metadata TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(session_id, step_number)
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS reasoning_traces (
          id VARCHAR(255) PRIMARY KEY,
          session_id VARCHAR(255) NOT NULL REFERENCES ai_sessions(session_id) ON DELETE CASCADE,
          step_number INTEGER NOT NULL,
          agent_name VARCHAR(255) NOT NULL,
          action VARCHAR(255) NOT NULL,
          input_summary TEXT,
          output_summary TEXT,
          confidence REAL,
          reasoning TEXT,
          timestamp TIMESTAMP NOT NULL,
          execution_time INTEGER,
          user_id VARCHAR(255),
          metadata JSONB,
          created_at TIMESTAMP DEFAULT NOW(),
          UNIQUE(session_id, step_number)
        )
      `.execute(db);
    }
  },
};
