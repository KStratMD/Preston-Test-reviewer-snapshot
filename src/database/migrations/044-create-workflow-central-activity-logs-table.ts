import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 044 — creates `workflow_central_activity_logs` for PR-OP-3b.
 *
 * Spec: `docs/plans/2026-05-18-workflow-central-activity-logs-durability-spec.md`.
 *
 * Prior to this migration, `WorkflowCentralService.activityLogs` was a dead
 * in-memory Map (declared, never written) and `getRecentActivity` always
 * returned `[]`. This migration introduces the table that activity-log writes
 * land in; the service layer in PR-OP-3b tees inserts off the existing
 * `safeAudit` calls in each verb (`startInstance`, `cancelInstance`,
 * `pauseInstance`, `resumeInstance`, `completeTask`, `delegateTask`).
 *
 * No FK from `instance_id` → `workflow_central_instances.id` — matches the
 * project-wide stance on legacy tolerance (PR-OP-3 Appendix B "Rejected
 * approaches"). No backfill — there is no prior in-memory state to migrate.
 *
 * Idempotency: CREATE TABLE/INDEX IF NOT EXISTS makes replay a no-op.
 */

export const migration: MigrationModule = {
  name: 'create_workflow_central_activity_logs_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_activity_logs (
          id              TEXT PRIMARY KEY,
          tenant_id       TEXT NOT NULL,
          instance_id     TEXT NOT NULL,
          workflow_name   TEXT NOT NULL,
          action          TEXT NOT NULL,
          user_id         TEXT NOT NULL,
          user_name       TEXT NOT NULL,
          step_name       TEXT,
          details         TEXT,
          timestamp       TEXT NOT NULL
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_wc_activity_logs_tenant_timestamp           ON workflow_central_activity_logs(tenant_id, timestamp DESC)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_activity_logs_tenant_instance_timestamp  ON workflow_central_activity_logs(tenant_id, instance_id, timestamp DESC)`.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_activity_logs (
          id              VARCHAR(255) PRIMARY KEY,
          tenant_id       VARCHAR(255) NOT NULL,
          instance_id     VARCHAR(255) NOT NULL,
          workflow_name   VARCHAR(255) NOT NULL,
          action          VARCHAR(64)  NOT NULL,
          user_id         VARCHAR(255) NOT NULL,
          user_name       VARCHAR(255) NOT NULL,
          step_name       VARCHAR(255),
          details         TEXT,
          timestamp       TIMESTAMP WITH TIME ZONE NOT NULL
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_wc_activity_logs_tenant_timestamp           ON workflow_central_activity_logs(tenant_id, timestamp DESC)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_activity_logs_tenant_instance_timestamp  ON workflow_central_activity_logs(tenant_id, instance_id, timestamp DESC)`.execute(db);
    }
  },
};
