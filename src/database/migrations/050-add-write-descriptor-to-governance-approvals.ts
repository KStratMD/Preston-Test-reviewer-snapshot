import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 050 — adds nullable `write_descriptor TEXT` column to
 * `governance_approvals` for the Stage B PR 13b queue_for_human enforcement.
 *
 * The column carries the JSON-serialized `WriteDescriptor` from
 * `src/governance/sourceOfTruth/guardedWrite.ts`. Ownership-queue rows
 * (operationType='ownership_write') must populate this column; legacy
 * governance rows (operationType='ai_call' | 'connector_write' | 'audit_log')
 * leave it NULL.
 *
 * OwnershipResumeHandler reads `approval.writeDescriptor` to re-dispatch the
 * original write after operator approval, so the connector + operation +
 * entityType + args are preserved across the enqueue → approve → resume cycle.
 *
 * Idempotency:
 *   SQLite — no `ADD COLUMN IF NOT EXISTS`; swallow the "duplicate column"
 *           error on replay (per canonical pattern across the codebase).
 *   Postgres — native `ADD COLUMN IF NOT EXISTS` makes replay a no-op.
 */

export const migration: MigrationModule = {
  name: 'add_write_descriptor_to_governance_approvals',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE governance_approvals ADD COLUMN write_descriptor TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS write_descriptor TEXT`.execute(db);
    }
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}
