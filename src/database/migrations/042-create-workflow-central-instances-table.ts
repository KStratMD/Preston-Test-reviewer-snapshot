import { sql } from 'kysely';
import type { MigrationModule } from './index';
// Drift gate: scripts/check-system-identity-isolation.mjs forbids the literal '__system__'
// string outside src/services/governance/identityContext.ts. Import the constant instead;
// Kysely's `sql` template binds it as a query parameter at execution time — no literal
// appears in source (spec §4.5, D5).
import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';

// Instance-durability migration for WorkflowCentralService (PR-OP-3).
// Moves the volatile in-memory `instances` Map to a durable table so that
// in-flight workflow instances survive server restarts.
//
// Spec refs: §4.1 (schema), §4.2 (backfill), §4.4 (indexes), §4.5 (identity),
//            D5 (JSON for variables/step_history), D8 (DLP carve-out — no
//            cancellation_reason column), D19 ("most-recent pending wins" rule),
//            D20 (INSERT OR IGNORE / ON CONFLICT DO NOTHING), D23 (paused_from_status).
//
// Idempotency: CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS + INSERT OR IGNORE
// (SQLite) / ON CONFLICT DO NOTHING (Postgres) ensure safe replay.

export const migration: MigrationModule = {
  name: 'create_workflow_central_instances_table',
  async run(db, dbType) {
    const nowIso = new Date().toISOString();

    // Observability pre-flight (spec §4.2): WARN on conditions the backfill
    // would silently handle so operators can audit drift after upgrade.
    const crossTenant = await sql<{
      tenant_a: string;
      tenant_b: string;
      instance_id: string;
    }>`
      SELECT a.tenant_id AS tenant_a, b.tenant_id AS tenant_b, a.instance_id
      FROM (SELECT DISTINCT tenant_id, instance_id FROM workflow_central_tasks) a
      JOIN (SELECT DISTINCT tenant_id, instance_id FROM workflow_central_tasks) b
        ON a.instance_id = b.instance_id AND a.tenant_id < b.tenant_id
    `.execute(db);
    for (const row of crossTenant.rows) {
      // Migrations run at boot before the DI logger is wired (DatabaseService
      // initialize → migration.run before container.get<Logger>). console.warn
      // is the only structured stream available at this phase, matching how
      // other pre-DI boot code (src/index.ts bootLog fallback) handles output.
      // eslint-disable-next-line no-console
      console.warn(
        'migration 042 backfill: cross-tenant instance_id collision ' +
          '(one row will be dropped by INSERT OR IGNORE / ON CONFLICT DO NOTHING)',
        { instance_id: row.instance_id, tenant_a: row.tenant_a, tenant_b: row.tenant_b },
      );
    }

    const disagreements = await sql<{
      tenant_id: string;
      instance_id: string;
      col: string;
    }>`
      SELECT tenant_id, instance_id, 'workflow_id' AS col
      FROM workflow_central_tasks GROUP BY tenant_id, instance_id
      HAVING MAX(workflow_id) <> MIN(workflow_id)
      UNION ALL
      SELECT tenant_id, instance_id, 'workflow_name' AS col
      FROM workflow_central_tasks GROUP BY tenant_id, instance_id
      HAVING MAX(workflow_name) <> MIN(workflow_name)
    `.execute(db);
    for (const row of disagreements.rows) {
      // eslint-disable-next-line no-console -- pre-DI boot phase; see cross-tenant warn comment above
      console.warn(
        'migration 042 backfill: workflow-metadata disagreement (MAX != MIN); ' +
          'backfill picks most-recent-pending task per D19',
        { tenant_id: row.tenant_id, instance_id: row.instance_id, column: row.col },
      );
    }

    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_instances (
          id                  TEXT PRIMARY KEY,
          tenant_id           TEXT NOT NULL,
          workflow_id         TEXT NOT NULL,
          workflow_name       TEXT NOT NULL,
          workflow_version    INTEGER NOT NULL,
          status              TEXT NOT NULL,
          current_step_id     TEXT,
          current_step_name   TEXT,
          variables           TEXT NOT NULL DEFAULT '{}',
          step_history        TEXT NOT NULL DEFAULT '[]',
          started_by          TEXT NOT NULL,
          started_at          TEXT NOT NULL,
          completed_at        TEXT,
          due_at              TEXT,
          error               TEXT,
          paused_from_status  TEXT,
          created_at          TEXT NOT NULL,
          updated_at          TEXT NOT NULL,
          UNIQUE(tenant_id, id)
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_status     ON workflow_central_instances(tenant_id, status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_workflow   ON workflow_central_instances(tenant_id, workflow_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_due        ON workflow_central_instances(tenant_id, due_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_completed  ON workflow_central_instances(tenant_id, completed_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_started_at ON workflow_central_instances(tenant_id, started_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_started_by ON workflow_central_instances(tenant_id, started_by)`.execute(db);

      // Backfill: synthesize one instance row per (tenant_id, instance_id) group
      // from the existing workflow_central_tasks rows. Source-of-truth rule (D19):
      // the most-recent pending task wins for step_id/step_name/workflow_name/workflow_id.
      // Ordering: pending first (CASE status WHEN 'pending' THEN 0 ELSE 1 END),
      // then most-recent created_at DESC, then id ASC for stable tiebreaking.
      // started_at = MIN(created_at) across the group (earliest task = instance start).
      await sql`
        INSERT OR IGNORE INTO workflow_central_instances (
          id, tenant_id, workflow_id, workflow_name, workflow_version, status,
          current_step_id, current_step_name, variables, step_history,
          started_by, started_at, completed_at, due_at, error, paused_from_status,
          created_at, updated_at
        )
        SELECT
          recent.instance_id,
          recent.tenant_id,
          recent.workflow_id,
          recent.workflow_name,
          1,
          'unknown_recovered',
          recent.step_id,
          recent.step_name,
          '{}',
          '[]',
          ${SYSTEM_IDENTITY.userId},
          recent.first_started_at,
          NULL,
          NULL,
          NULL,
          NULL,
          ${nowIso},
          ${nowIso}
        FROM (
          SELECT
            t.tenant_id,
            t.instance_id,
            t.workflow_id,
            t.workflow_name,
            t.step_id,
            t.step_name,
            (
              SELECT MIN(created_at)
              FROM workflow_central_tasks
              WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ) AS first_started_at
          FROM workflow_central_tasks t
          WHERE t.id = (
            SELECT id FROM workflow_central_tasks
            WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ORDER BY
              (CASE status WHEN 'pending' THEN 0 ELSE 1 END),
              created_at DESC,
              id ASC
            LIMIT 1
          )
        ) recent
      `.execute(db);
    } else {
      // Postgres branch
      await sql`
        CREATE TABLE IF NOT EXISTS workflow_central_instances (
          id                  VARCHAR(255) PRIMARY KEY,
          tenant_id           VARCHAR(255) NOT NULL,
          workflow_id         VARCHAR(255) NOT NULL,
          workflow_name       VARCHAR(255) NOT NULL,
          workflow_version    INTEGER NOT NULL,
          status              VARCHAR(32) NOT NULL,
          current_step_id     VARCHAR(255),
          current_step_name   VARCHAR(255),
          variables           TEXT NOT NULL DEFAULT '{}',
          step_history        TEXT NOT NULL DEFAULT '[]',
          started_by          VARCHAR(255) NOT NULL,
          started_at          TIMESTAMP NOT NULL,
          completed_at        TIMESTAMP,
          due_at              TIMESTAMP,
          error               TEXT,
          paused_from_status  VARCHAR(32),
          created_at          TIMESTAMP NOT NULL,
          updated_at          TIMESTAMP NOT NULL,
          UNIQUE(tenant_id, id)
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_status     ON workflow_central_instances(tenant_id, status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_workflow   ON workflow_central_instances(tenant_id, workflow_id)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_due        ON workflow_central_instances(tenant_id, due_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_completed  ON workflow_central_instances(tenant_id, completed_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_started_at ON workflow_central_instances(tenant_id, started_at)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_wc_instances_tenant_started_by ON workflow_central_instances(tenant_id, started_by)`.execute(db);

      await sql`
        INSERT INTO workflow_central_instances (
          id, tenant_id, workflow_id, workflow_name, workflow_version, status,
          current_step_id, current_step_name, variables, step_history,
          started_by, started_at, completed_at, due_at, error, paused_from_status,
          created_at, updated_at
        )
        SELECT
          recent.instance_id,
          recent.tenant_id,
          recent.workflow_id,
          recent.workflow_name,
          1,
          'unknown_recovered',
          recent.step_id,
          recent.step_name,
          '{}',
          '[]',
          ${SYSTEM_IDENTITY.userId},
          CAST(recent.first_started_at AS TIMESTAMP),
          NULL,
          NULL,
          NULL,
          NULL,
          CAST(${nowIso} AS TIMESTAMP),
          CAST(${nowIso} AS TIMESTAMP)
        FROM (
          SELECT
            t.tenant_id,
            t.instance_id,
            t.workflow_id,
            t.workflow_name,
            t.step_id,
            t.step_name,
            (
              SELECT MIN(created_at)
              FROM workflow_central_tasks
              WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ) AS first_started_at
          FROM workflow_central_tasks t
          WHERE t.id = (
            SELECT id FROM workflow_central_tasks
            WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ORDER BY
              (CASE status WHEN 'pending' THEN 0 ELSE 1 END),
              created_at DESC,
              id ASC
            LIMIT 1
          )
        ) recent
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }
  },
};
