import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_circuit_breaker_states_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS circuit_breaker_states (
          id TEXT PRIMARY KEY,
          service_name TEXT NOT NULL UNIQUE,
          state TEXT NOT NULL DEFAULT 'closed',
          failure_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          last_failure_at DATETIME,
          last_success_at DATETIME,
          opened_at DATETIME,
          next_attempt_at DATETIME,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (state IN ('closed', 'open', 'half-open'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS circuit_breaker_states (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          service_name VARCHAR(255) NOT NULL UNIQUE,
          state VARCHAR(20) NOT NULL DEFAULT 'closed',
          failure_count INTEGER NOT NULL DEFAULT 0,
          success_count INTEGER NOT NULL DEFAULT 0,
          last_failure_at TIMESTAMP,
          last_success_at TIMESTAMP,
          opened_at TIMESTAMP,
          next_attempt_at TIMESTAMP,
          updated_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT chk_circuit_state CHECK (state IN ('closed', 'open', 'half-open'))
        )
      `.execute(db);
    }
  },
};
