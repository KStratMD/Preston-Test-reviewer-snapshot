import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 051 — adds apply lifecycle fields to governance_approvals.
 *
 * Approval status remains the operator decision state. These columns track
 * post-approval resume/apply state so failed connector writes can be reset
 * without reopening or duplicating successfully applied approvals.
 */
export const migration: MigrationModule = {
  name: 'add_apply_lifecycle_to_governance_approvals',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE governance_approvals ADD COLUMN apply_status TEXT NOT NULL DEFAULT 'not_started'`
        .execute(db)
        .catch(swallowDuplicateColumn);
      await sql`ALTER TABLE governance_approvals ADD COLUMN applied_at TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
      await sql`ALTER TABLE governance_approvals ADD COLUMN apply_failed_at TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
      await sql`ALTER TABLE governance_approvals ADD COLUMN apply_error TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS apply_status VARCHAR(32) NOT NULL DEFAULT 'not_started'`.execute(db);
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS applied_at TIMESTAMP WITH TIME ZONE`.execute(db);
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS apply_failed_at TIMESTAMP WITH TIME ZONE`.execute(db);
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS apply_error TEXT`.execute(db);
    }
    // Backfill (Copilot R13): rows persisted before this migration may already
    // carry a non-null `apply_idempotency_key` from PR 13c-2's worker — those
    // are claimed-but-incomplete and should report `apply_status='claimed'`,
    // not the column default 'not_started'. Without this backfill, operator
    // queries filtering on apply_status would mis-report the row's lifecycle.
    // claimForApply's WHERE clause already filters on `apply_idempotency_key
    // IS NULL`, so even mis-labeled rows aren't double-claimed — this is a
    // status-accuracy fix, not a safety fix.
    await sql`UPDATE governance_approvals SET apply_status = 'claimed' WHERE apply_idempotency_key IS NOT NULL AND apply_status = 'not_started'`.execute(db);
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}