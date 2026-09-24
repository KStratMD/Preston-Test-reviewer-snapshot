import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_metrics_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS metrics (
          id TEXT PRIMARY KEY,
          metric_name TEXT NOT NULL,
          metric_type TEXT NOT NULL,
          value REAL NOT NULL,
          labels TEXT,
          timestamp DATETIME NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          CHECK (metric_type IN ('counter', 'gauge', 'histogram', 'summary'))
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS metrics (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          metric_name VARCHAR(255) NOT NULL,
          metric_type VARCHAR(50) NOT NULL,
          value DECIMAL NOT NULL,
          labels JSONB,
          timestamp TIMESTAMP NOT NULL,
          created_at TIMESTAMP DEFAULT NOW(),
          CONSTRAINT chk_metric_type CHECK (metric_type IN ('counter', 'gauge', 'histogram', 'summary'))
        )
      `.execute(db);
    }
  },
};
