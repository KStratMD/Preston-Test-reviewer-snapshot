import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * SQLite stores REAL values as binary64. The original PostgreSQL branches for
 * these two columns used binary32 REAL, which could silently narrow a source
 * value during preservation. Keep the historical migrations immutable and
 * widen only the PostgreSQL target columns in this append-only migration.
 */
export const migration: MigrationModule = {
  name: 'widen_transfer_float_columns',
  async run(db, dbType) {
    if (dbType === 'sqlite') return;

    await sql`
      ALTER TABLE ai_sessions
        ALTER COLUMN overall_confidence TYPE DOUBLE PRECISION
        USING overall_confidence::DOUBLE PRECISION
    `.execute(db);

    await sql`
      ALTER TABLE reasoning_traces
        ALTER COLUMN confidence TYPE DOUBLE PRECISION
        USING confidence::DOUBLE PRECISION
    `.execute(db);
  },
};
