import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_reasoning_traces_indexes',
  async run(db, _dbType) {
    await sql`CREATE INDEX IF NOT EXISTS idx_rt_session_id ON reasoning_traces(session_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_rt_agent_name ON reasoning_traces(agent_name)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_rt_timestamp ON reasoning_traces(timestamp)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_rt_user_id ON reasoning_traces(user_id)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_ai_sessions_status ON ai_sessions(status)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_id ON ai_sessions(user_id)`.execute(db);
  },
};
