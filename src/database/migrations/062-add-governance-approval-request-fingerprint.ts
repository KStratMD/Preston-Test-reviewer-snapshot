import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 062 — add `request_fingerprint` to governance_approvals, plus the
 * partial unique index that makes ownership-approval enqueue idempotent (A8).
 *
 * The ownership arm of `ApprovalQueueService.enqueue` inserted a fresh row per
 * call, so a caller retried by an outage — or two replicas handling the same
 * governed write — produced N pending approvals for ONE write intent. An
 * operator then had to decide each of them, and approving more than one
 * re-dispatched the same connector mutation more than once.
 *
 * NULLABLE by design, and deliberately NOT backfilled. Legacy governance rows
 * and every non-ownership operation type have no fingerprint and never will;
 * computing one for historical rows would require their write descriptors,
 * which are encrypted, and would invent dedupe relationships between rows that
 * were never deduped when they were created.
 *
 * The index's DEDUPE DOMAIN is deliberately narrow — `(tenant_id,
 * request_fingerprint)` restricted to pending ownership rows with a non-null
 * fingerprint:
 *
 *  - tenant-scoped, because two tenants issuing an identical write intent are
 *    two separate approvals; collapsing them would leak one tenant's queue
 *    state into another's.
 *  - `status = 'pending'` only, because a decided approval is history. If a
 *    terminal row blocked, a given write intent could be approved exactly once
 *    for the lifetime of the tenant and the same mutation could never
 *    legitimately recur.
 *  - `operation_type = 'ownership_write'` only, because no other arm computes
 *    a fingerprint and no other arm is being made idempotent here.
 *  - non-null fingerprint, so legacy rows cannot collide. SQL already treats
 *    NULLs as distinct under a unique index; the predicate makes that explicit
 *    rather than relying on it, and keeps the index small.
 *
 * What the predicate CANNOT express is `expires_at > now` — a partial index
 * must be immutable, and `now` is not. So a stale, unreaped pending row does
 * block a new one that ought to supersede it. That residue is handled in the
 * service by a bounded insert-conflict protocol (A8.3), not here; the
 * alternative — omitting `status` from the predicate — would trade a
 * recoverable conflict for the permanent one described above.
 *
 * Idempotency: SQLite swallows the duplicate-column error on replay (mirrors
 * migrations 052 and 055); Postgres uses native `ADD COLUMN IF NOT EXISTS`.
 * Both engines support partial indexes, so the predicate is identical.
 */
export const migration: MigrationModule = {
  name: 'add_governance_approval_request_fingerprint',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`ALTER TABLE governance_approvals ADD COLUMN request_fingerprint TEXT`
        .execute(db)
        .catch(swallowDuplicateColumn);
    } else {
      await sql`ALTER TABLE governance_approvals ADD COLUMN IF NOT EXISTS request_fingerprint VARCHAR(64)`.execute(db);
    }

    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS uq_governance_approvals_pending_ownership_fingerprint
        ON governance_approvals (tenant_id, request_fingerprint)
        WHERE status = 'pending'
          AND operation_type = 'ownership_write'
          AND request_fingerprint IS NOT NULL
    `.execute(db);

    // NOTE: no second, predicate-free index on (tenant_id, request_fingerprint).
    // One was added here initially and removed: the partial unique index above
    // already covers both queries the conflict protocol issues — the blocker
    // lookup and the CAS-expire — because both filter on exactly its predicate.
    // Its only extra reach was terminal-row diagnosis by fingerprint, which no
    // code path performs, so it was pure write amplification on a governance
    // table for a query nobody makes.
  },
};

function swallowDuplicateColumn(err: Error): void {
  if (!/duplicate column name/i.test(err.message)) throw err;
}
