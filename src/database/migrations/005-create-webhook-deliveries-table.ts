import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_webhook_deliveries_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          event_type TEXT NOT NULL,
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          http_status INTEGER,
          response_body TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at DATETIME,
          delivered_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (status IN ('pending', 'delivered', 'failed', 'retrying'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          webhook_id VARCHAR(255) NOT NULL,
          event_type VARCHAR(255) NOT NULL,
          payload JSONB NOT NULL,
          status VARCHAR(50) NOT NULL DEFAULT 'pending',
          http_status INTEGER,
          response_body TEXT,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_retry_at TIMESTAMP,
          delivered_at TIMESTAMP,
          created_at TIMESTAMP DEFAULT NOW(),
          updated_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT chk_webhook_status CHECK (status IN ('pending', 'delivered', 'failed', 'retrying'))
        )
      `.execute(db);
    }
  },
};
