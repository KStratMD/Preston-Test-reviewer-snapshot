import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 046 — adds the composite index that powers the Tier-C history-view
 * pagination query (PR #826).
 *
 * `ApprovalQueueRepository.listByTerminalStatusForTenant()` now orders by
 * `(decided_at DESC, id DESC)` per the Codex 5.5 MEDIUM finding on PR #826
 * (audit-trail mental model is "what got decided when", not "what was
 * requested when"). Without an index that includes `decided_at`, the query
 * would require a per-tenant sort on every page load, degrading as history
 * grows.
 *
 * Filtering by `status IN ('approved', 'rejected')` is the type-narrowed
 * call surface, but the index includes `status` so the
 * `WHERE tenant_id = ? AND status = ?` predicate is satisfied straight
 * from the leading columns. The index covers BOTH terminal statuses in
 * one definition.
 *
 * Idempotent via `IF NOT EXISTS`.
 *
 * Why a new migration instead of editing 045: migrations are append-only
 * once they ship in any released version; 045 was the PR 3A schema
 * commit. Adding a new file keeps the historical migration graph honest.
 */

export const migration: MigrationModule = {
  name: 'add_governance_approvals_decided_index',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_status_decided
          ON governance_approvals(tenant_id, status, decided_at DESC, id DESC)
      `.execute(db);
    } else {
      // Postgres: same composite shape; the `DESC` modifiers on
      // decided_at + id let the index serve the ORDER BY clause directly.
      await sql`
        CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_status_decided
          ON governance_approvals(tenant_id, status, decided_at DESC, id DESC)
      `.execute(db);
    }
  },
};
