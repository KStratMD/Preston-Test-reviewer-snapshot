import { sql } from 'kysely';
import type { MigrationModule } from './index';

// Operator-promotion of WorkflowCentralService task management from in-memory
// Maps to a durable row. See
// docs/plans/2026-05-14-workflow-central-operator-promotion-spec.md §2.D3
// for column-level rationale.
//
// Idempotency: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS ensure
// this migration is safe to replay (F-07). The migration runner tracks applied
// migrations by name, so this runs at most once per environment; the IF NOT
// EXISTS clauses are defence-in-depth for fresh databases.

export const migration: MigrationModule = {
  name: 'create_workflow_central_tasks_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_tasks (
          id TEXT PRIMARY KEY,
          tenant_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          workflow_name TEXT NOT NULL,
          step_id TEXT NOT NULL,
          step_name TEXT NOT NULL,
          task_type TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          priority TEXT NOT NULL,
          assignee_id TEXT NOT NULL,
          assignee_name TEXT NOT NULL,
          description TEXT NOT NULL,
          due_at TEXT,
          data TEXT NOT NULL DEFAULT '{}',
          actions TEXT NOT NULL DEFAULT '[]',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          completed_at TEXT,
          completed_by TEXT,
          completion_action_id TEXT,
          completion_comment TEXT,
          UNIQUE(tenant_id, id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_assignee_status
          ON workflow_central_tasks(tenant_id, assignee_id, status)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_instance
          ON workflow_central_tasks(tenant_id, instance_id, status)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_pending_due
          ON workflow_central_tasks(tenant_id, status, due_at)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_completed_at
          ON workflow_central_tasks(tenant_id, completed_at)
      `.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_tasks (
          id VARCHAR(255) PRIMARY KEY,
          tenant_id VARCHAR(255) NOT NULL,
          instance_id VARCHAR(255) NOT NULL,
          workflow_id VARCHAR(255) NOT NULL,
          workflow_name VARCHAR(255) NOT NULL,
          step_id VARCHAR(255) NOT NULL,
          step_name VARCHAR(255) NOT NULL,
          task_type VARCHAR(255) NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          priority VARCHAR(16) NOT NULL,
          assignee_id VARCHAR(255) NOT NULL,
          assignee_name VARCHAR(255) NOT NULL,
          description TEXT NOT NULL,
          due_at TIMESTAMP,
          data TEXT NOT NULL DEFAULT '{}',
          actions TEXT NOT NULL DEFAULT '[]',
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          completed_at TIMESTAMP,
          completed_by VARCHAR(255),
          completion_action_id VARCHAR(255),
          completion_comment TEXT,
          UNIQUE(tenant_id, id)
        )
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_assignee_status
          ON workflow_central_tasks(tenant_id, assignee_id, status)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_instance
          ON workflow_central_tasks(tenant_id, instance_id, status)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_pending_due
          ON workflow_central_tasks(tenant_id, status, due_at)
      `.execute(db);
      await sql`
        CREATE INDEX IF NOT EXISTS idx_workflow_central_tasks_completed_at
          ON workflow_central_tasks(tenant_id, completed_at)
      `.execute(db);
    }
  },
};
