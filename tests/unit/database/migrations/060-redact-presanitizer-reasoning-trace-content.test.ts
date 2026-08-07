import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import type { Database } from '../../../../src/database/types';
import { migration as createSessions } from '../../../../src/database/migrations/028-create-ai-sessions-table';
import { migration as createTraces } from '../../../../src/database/migrations/029-create-reasoning-traces-table';
import { migration as redactLegacyContent } from '../../../../src/database/migrations/060-redact-presanitizer-reasoning-trace-content';

it('nulls legacy content while preserving the trace skeleton', async () => {
  const db = new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
  try {
    await createSessions.run(db, 'sqlite');
    await createTraces.run(db, 'sqlite');
    await sql`INSERT INTO ai_sessions (session_id, started_at, status)
      VALUES ('s1', CURRENT_TIMESTAMP, 'running')`.execute(db);
    await sql`INSERT INTO reasoning_traces
      (id, session_id, step_number, agent_name, action, input_summary,
       output_summary, reasoning, timestamp)
      VALUES ('t1', 's1', 1, 'agent-a', 'execute',
       '{"email":"jane.doe@example.com"}',
       '{"ssn":"123-45-6789"}',
       'raw reasoning jane.doe@example.com', CURRENT_TIMESTAMP)`.execute(db);

    await redactLegacyContent.run(db, 'sqlite');

    const result = await sql<{
      agent_name: string;
      step_number: number;
      input_summary: string | null;
      output_summary: string | null;
      reasoning: string | null;
    }>`SELECT agent_name, step_number, input_summary, output_summary, reasoning
       FROM reasoning_traces WHERE id = 't1'`.execute(db);
    expect(result.rows[0]).toEqual({
      agent_name: 'agent-a',
      step_number: 1,
      input_summary: null,
      output_summary: null,
      reasoning: null,
    });
  } finally {
    await db.destroy();
  }
});
