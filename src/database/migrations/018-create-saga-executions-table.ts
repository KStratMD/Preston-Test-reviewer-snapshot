import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_saga_executions_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS saga_executions (
          id TEXT PRIMARY KEY,
          idempotency_key TEXT NOT NULL UNIQUE,
          saga_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'compensating', 'compensated')),
          current_step INTEGER DEFAULT 0,
          steps_json TEXT NOT NULL DEFAULT '[]',
          context_json TEXT NOT NULL DEFAULT '{}',
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          completed_at INTEGER
        )
      `.execute(db);

      // Create indexes for fast lookups
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_idempotency ON saga_executions(idempotency_key)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_type ON saga_executions(saga_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_status ON saga_executions(status)`.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS saga_executions (
          id UUID PRIMARY KEY,
          idempotency_key VARCHAR(64) NOT NULL UNIQUE,
          saga_type VARCHAR(255) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'pending'
            CONSTRAINT chk_saga_status CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'compensating', 'compensated')),
          current_step INTEGER DEFAULT 0,
          steps_json JSONB NOT NULL DEFAULT '[]',
          context_json JSONB NOT NULL DEFAULT '{}',
          error TEXT,
          created_at BIGINT NOT NULL,
          updated_at BIGINT NOT NULL,
          completed_at BIGINT
        )
      `.execute(db);

      // Create indexes for fast lookups
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_idempotency ON saga_executions(idempotency_key)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_type ON saga_executions(saga_type)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_saga_status ON saga_executions(status)`.execute(db);
    }
  },
};
