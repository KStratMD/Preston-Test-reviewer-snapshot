import { sql } from 'kysely';
import type { MigrationModule } from './index';

export const migration: MigrationModule = {
  name: 'create_reconciliation_center_tables',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          source_system TEXT NOT NULL,
          target_system TEXT NOT NULL,
          source_record_id TEXT NOT NULL,
          target_record_id TEXT,
          exception_type TEXT NOT NULL,
          severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved', 'dismissed')),
          amount_delta REAL,
          currency TEXT,
          description TEXT NOT NULL,
          suggested_action TEXT NOT NULL,
          assigned_to TEXT,
          due_at TEXT,
          resolved_at TEXT,
          resolution_note TEXT,
          resolved_by TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_schedules (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          name TEXT NOT NULL,
          cadence TEXT NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
          active INTEGER NOT NULL DEFAULT 1,
          next_run_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_runs (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          schedule_id TEXT,
          status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          exceptions_created INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        )
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_exceptions (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          source_system VARCHAR(64) NOT NULL,
          target_system VARCHAR(64) NOT NULL,
          source_record_id VARCHAR(255) NOT NULL,
          target_record_id VARCHAR(255),
          exception_type VARCHAR(64) NOT NULL,
          severity VARCHAR(32) NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
          status VARCHAR(32) NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'assigned', 'resolved', 'dismissed')),
          amount_delta NUMERIC(18,6),
          currency VARCHAR(16),
          description TEXT NOT NULL,
          suggested_action TEXT NOT NULL,
          assigned_to VARCHAR(255),
          due_at TIMESTAMP,
          resolved_at TIMESTAMP,
          resolution_note TEXT,
          resolved_by VARCHAR(255),
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_schedules (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          name VARCHAR(255) NOT NULL,
          cadence VARCHAR(32) NOT NULL CHECK (cadence IN ('hourly', 'daily', 'weekly')),
          active BOOLEAN NOT NULL DEFAULT TRUE,
          next_run_at TIMESTAMP NOT NULL,
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL
        )
      `.execute(db);
      await sql`
        CREATE TABLE IF NOT EXISTS reconciliation_runs (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          schedule_id VARCHAR(255),
          status VARCHAR(32) NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
          started_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          exceptions_created INTEGER NOT NULL DEFAULT 0,
          error_message TEXT
        )
      `.execute(db);
    }

    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_tenant_status ON reconciliation_exceptions(tenant_id, status)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_exceptions_tenant_severity ON reconciliation_exceptions(tenant_id, severity)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_schedules_tenant_active ON reconciliation_schedules(tenant_id, active)`.execute(db);
    await sql`CREATE INDEX IF NOT EXISTS idx_reconciliation_runs_tenant_schedule ON reconciliation_runs(tenant_id, schedule_id)`.execute(db);
  },
};
