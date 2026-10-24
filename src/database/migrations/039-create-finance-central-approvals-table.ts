import { sql } from 'kysely';
import type { MigrationModule } from './index';

// Operator-promotion of FinanceCentralService.approveItem / rejectItem from
// in-memory Map mutation to a durable row with two-stage state machine.
// Schema mirrors SyncErrorAssist operator-disposition columns (migration 037)
// plus FC-specific fields. See docs/plans/2026-05-13-operator-promotion-spec.md
// §2.D5 for column-level rationale.
//
// Idempotency: CREATE TABLE IF NOT EXISTS works for both SQLite and Postgres
// for the initial create. The migration runner tracks applied migrations by
// name, so this runs at most once per environment; the IF NOT EXISTS is a
// defence-in-depth no-op for fresh databases.

export const migration: MigrationModule = {
  name: 'create_finance_central_approvals_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS finance_central_approvals (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          approval_id TEXT NOT NULL,
          document_id TEXT NOT NULL,
          document_number TEXT NOT NULL,
          document_type TEXT NOT NULL,
          description TEXT NOT NULL,
          entity_name TEXT,
          employee_name TEXT,
          amount REAL NOT NULL,
          currency TEXT NOT NULL,
          submitted_by TEXT NOT NULL,
          submitted_at TEXT NOT NULL,
          current_approver TEXT NOT NULL,
          approval_level INTEGER NOT NULL,
          priority TEXT NOT NULL,
          netsuite_id TEXT,
          operator_disposition TEXT NOT NULL DEFAULT 'pending',
          operator_disposition_at TEXT,
          operator_disposition_user_id TEXT,
          applied_record_id TEXT,
          rejection_reason TEXT,
          approval_comments TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE(tenant_id, approval_id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_finance_central_approvals_disposition
          ON finance_central_approvals(tenant_id, operator_disposition)
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS finance_central_approvals (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          tenant_id VARCHAR(255) NOT NULL,
          approval_id VARCHAR(255) NOT NULL,
          document_id VARCHAR(255) NOT NULL,
          document_number VARCHAR(255) NOT NULL,
          document_type VARCHAR(32) NOT NULL,
          description TEXT NOT NULL,
          entity_name VARCHAR(255),
          employee_name VARCHAR(255),
          amount DECIMAL(15,2) NOT NULL,
          currency VARCHAR(8) NOT NULL,
          submitted_by VARCHAR(255) NOT NULL,
          submitted_at TIMESTAMP NOT NULL,
          current_approver VARCHAR(255) NOT NULL,
          approval_level INT NOT NULL,
          priority VARCHAR(16) NOT NULL,
          netsuite_id VARCHAR(255),
          operator_disposition VARCHAR(16) NOT NULL DEFAULT 'pending',
          operator_disposition_at TIMESTAMP,
          operator_disposition_user_id VARCHAR(255),
          applied_record_id VARCHAR(255),
          rejection_reason TEXT,
          approval_comments TEXT,
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          UNIQUE(tenant_id, approval_id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_finance_central_approvals_disposition
          ON finance_central_approvals(tenant_id, operator_disposition)
      `.execute(db);
    }
  },
};
