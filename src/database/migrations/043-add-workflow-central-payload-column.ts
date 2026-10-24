import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 043 — adds `payload TEXT` column to both `workflow_central_tasks`
 * and `workflow_central_instances` for the governance-without-hosting-data
 * Phase 1 pivot (ADR-019).
 *
 * The column carries the JSON-serialized `WorkflowPayload` tagged union from
 * `src/services/workflowCentral/payload/WorkflowPayload.ts`. Reads use the
 * `payload` column when present; legacy rows fall back to the existing
 * `data` / `variables` columns via the repository's transitional helper.
 *
 * The legacy `data` / `variables` columns are intentionally NOT dropped
 * here — Phase 1 follow-up PR (Task 19) ships migration 044 after Phase 1
 * runs in production for ≥2 weeks with backfill verified.
 *
 * Idempotency:
 *   SQLite — no `ADD COLUMN IF NOT EXISTS`; swallow the "duplicate column"
 *           error on replay (per canonical pattern across the codebase).
 *   Postgres — native `ADD COLUMN IF NOT EXISTS` makes replay a no-op.
 */

export const migration: MigrationModule = {
  name: 'add_workflow_central_payload_column',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE workflow_central_tasks ADD COLUMN payload TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
      await sql`ALTER TABLE workflow_central_instances ADD COLUMN payload TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE workflow_central_tasks ADD COLUMN IF NOT EXISTS payload TEXT`.execute(db);
      await sql`ALTER TABLE workflow_central_instances ADD COLUMN IF NOT EXISTS payload TEXT`.execute(db);
    }
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}
