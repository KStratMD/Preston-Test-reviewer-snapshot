import { sql } from 'kysely';
import type { MigrationModule } from './index';

/**
 * Migration 045 — creates `governance_approvals` for the HITL approval-queue
 * bundle (PR 3A; spec: docs/plans/2026-05-18-hitl-approval-queue-bundle-spec.md).
 *
 * 3A ships the schema in isolation: PR 3B flips `approvalMode` to `'queue'`
 * and installs the route catches + resume worker that actually populate +
 * decide rows. With 3A alone the table is reachable but receives no writes.
 *
 * `apply_idempotency_key` is intentionally NON-UNIQUE: the contract is a
 * per-approval CAS (rowcount-based UPDATE in `claimForApply`), not a global
 * key uniqueness invariant. The same key value MAY legitimately appear on
 * different approval rows (Codex R1 + Copilot R1 on PR #818).
 *
 * Postgres uses `TIMESTAMP WITH TIME ZONE` to preserve ISO `Z` offsets;
 * the SQLite branch persists `TEXT` (matches the convention from
 * migrations 040-044). Idempotent via `IF NOT EXISTS`.
 *
 * Indexes shipped:
 *   - `idx_governance_approvals_tenant_status`   — tenant-scoped; powers `listPendingForTenant` / `countPendingForTenant`.
 *   - `idx_governance_approvals_tenant_created`  — tenant-scoped; powers the created_at DESC ordering inside `listPendingForTenant`.
 *   - `idx_governance_approvals_expires_pending` — INTENTIONALLY NOT tenant-scoped; powers the global maintenance sweep
 *     `ApprovalQueueRepository.expireStale(nowIso)` which is invoked by a scheduled job (PR 3B) and walks every tenant's
 *     pending rows by design. Copilot R1 on PR #819 flagged the prior "tenant-scoped" framing; the index name + this
 *     comment are the corrected source of truth.
 */

export const migration: MigrationModule = {
  name: 'create_governance_approvals_table',
  async run(db, dbType) {
    if (dbType === 'sqlite') {
      await sql`
        CREATE TABLE IF NOT EXISTS governance_approvals (
          id                    TEXT PRIMARY KEY,
          tenant_id             TEXT NOT NULL,
          requester_user_id     TEXT NOT NULL,
          operation_type        TEXT NOT NULL,
          resource_type         TEXT NOT NULL,
          resource_id           TEXT NOT NULL,
          risk_level            TEXT NOT NULL,
          redacted_payload      TEXT NOT NULL,
          policy_findings       TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'pending',
          created_at            TEXT NOT NULL,
          expires_at            TEXT NOT NULL,
          decided_at            TEXT,
          decided_by_user_id    TEXT,
          decision_reason       TEXT,
          apply_idempotency_key TEXT
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_status            ON governance_approvals(tenant_id, status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_created           ON governance_approvals(tenant_id, created_at DESC)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_expires_pending          ON governance_approvals(expires_at) WHERE status = 'pending'`.execute(db);
    } else {
      await sql`
        CREATE TABLE IF NOT EXISTS governance_approvals (
          id                    VARCHAR(255) PRIMARY KEY,
          tenant_id             VARCHAR(255) NOT NULL,
          requester_user_id     VARCHAR(255) NOT NULL,
          operation_type        VARCHAR(64)  NOT NULL,
          resource_type         VARCHAR(255) NOT NULL,
          resource_id           VARCHAR(255) NOT NULL,
          risk_level            VARCHAR(32)  NOT NULL,
          redacted_payload      TEXT         NOT NULL,
          policy_findings       TEXT         NOT NULL,
          status                VARCHAR(32)  NOT NULL DEFAULT 'pending',
          created_at            TIMESTAMP WITH TIME ZONE NOT NULL,
          expires_at            TIMESTAMP WITH TIME ZONE NOT NULL,
          decided_at            TIMESTAMP WITH TIME ZONE,
          decided_by_user_id    VARCHAR(255),
          decision_reason       TEXT,
          apply_idempotency_key VARCHAR(255)
        )
      `.execute(db);

      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_status            ON governance_approvals(tenant_id, status)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_tenant_created           ON governance_approvals(tenant_id, created_at DESC)`.execute(db);
      await sql`CREATE INDEX IF NOT EXISTS idx_governance_approvals_expires_pending          ON governance_approvals(expires_at) WHERE status = 'pending'`.execute(db);
    }
  },
};
