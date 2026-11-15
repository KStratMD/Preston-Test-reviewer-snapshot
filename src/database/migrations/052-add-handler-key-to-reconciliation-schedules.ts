import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 052 — adds `handler_key` to `reconciliation_schedules`.
 *
 * The scheduler dispatch (ReconciliationCenterService.runDueSchedules) looks up
 * a Reconciler by this key. v1 ships one handler:
 * `netsuite_business_central_invoice_reconciliation`. A discriminator only —
 * NOT a generic source/target/entity/field schema (one proven handler first).
 *
 * Idempotency:
 *   SQLite — no `ADD COLUMN IF NOT EXISTS`; swallow the duplicate-column error
 *            on replay (canonical pattern, mirrors migration 050).
 *   Postgres — native `ADD COLUMN IF NOT EXISTS` makes replay a no-op.
 */
export const migration: MigrationModule = {
  name: 'add_handler_key_to_reconciliation_schedules',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE reconciliation_schedules ADD COLUMN handler_key TEXT NOT NULL DEFAULT 'netsuite_business_central_invoice_reconciliation'`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE reconciliation_schedules ADD COLUMN IF NOT EXISTS handler_key VARCHAR(128) NOT NULL DEFAULT 'netsuite_business_central_invoice_reconciliation'`.execute(db);
    }
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}
