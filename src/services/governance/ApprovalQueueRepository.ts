// HITL approval-queue repository (PR 3A).
//
// Surfaces a CAS-shaped `decide()` so the service can map cleanly to
// 404 vs 409 without a racy pre-read (Copilot R1 on PR #818 spec — the
// prior `null` return collapsed 'not_found' and 'already_decided').
//
// `claimForApply` enforces per-approval idempotency via a rowcount-based
// CAS, NOT global uniqueness — `apply_idempotency_key` is intentionally
// NOT UNIQUE in the schema. The same key value MAY appear across different
// approval rows; each approval row can only be claimed once.

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { GovernanceApproval } from '../../database/types';

// ── Public types ──────────────────────────────────────────────────

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';
export type ApprovalApplyStatus = 'not_started' | 'claimed' | 'succeeded' | 'failed';
export type ApprovalOperationType = 'ai_call' | 'connector_write' | 'audit_log' | 'ownership_write';
export type ApprovalRiskLevel = 'low' | 'medium' | 'high';

/**
 * Input shape for `insertPending`. Mirrors `GovernanceApproval` minus the
 * decision fields (set by `decide` later) and minus `apply_idempotency_key`
 * (set by `claimForApply` later). `status` is always 'pending' for new rows.
 */
export interface NewPendingApprovalRow {
  id: string;
  tenantId: string;
  requesterUserId: string;
  operationType: ApprovalOperationType;
  resourceType: string;
  resourceId: string;
  riskLevel: ApprovalRiskLevel;
  /** JSON-stringified redacted payload from OutboundDecision.redactedPayload. */
  redactedPayload: string;
  /** JSON-stringified string[] of PII type names from OutboundDecision.findings. */
  policyFindings: string;
  createdAt: string;
  expiresAt: string;
  /**
   * JSON-serialized WriteDescriptor for ownership_write rows (PR 13b Stage B).
   * NULL for legacy governance rows (operationType='ai_call' | 'connector_write' | 'audit_log').
   */
  writeDescriptor: string | null;
}

/**
 * The persisted row shape returned by every read verb. Narrows the
 * stringly-typed schema columns to typed unions at the deserialize boundary.
 */
export interface PersistedApproval {
  id: string;
  tenantId: string;
  requesterUserId: string;
  operationType: ApprovalOperationType;
  resourceType: string;
  resourceId: string;
  riskLevel: ApprovalRiskLevel;
  redactedPayload: string;
  policyFindings: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  decidedByUserId: string | null;
  decisionReason: string | null;
  applyIdempotencyKey: string | null;
  applyStatus: ApprovalApplyStatus;
  appliedAt: string | null;
  applyFailedAt: string | null;
  applyError: string | null;
  /**
   * JSON-serialized WriteDescriptor for ownership_write rows (PR 13b Stage B).
   * NULL for legacy governance rows.
   */
  writeDescriptor: string | null;
}

/**
 * Tagged outcome from `decide()` so the service maps cleanly to 404 / 409 / 410.
 *
 * 'expired' was added in PR #819 R3 (Codex 5.4 HIGH + Copilot R3 #1): the
 * prior implementation only filtered by `status='pending'`, so a row past
 * its TTL but not yet swept by `expireStale` was treated as `already_decided`
 * — making 410 impossible to distinguish from 409 at the route layer.
 *
 * The 'already_decided' variant carries a narrowed row shape
 * (`status: 'approved' | 'rejected'`) so the type system enforces that
 * 'expired' rows can never accidentally flow into a 409 path at the service
 * layer (Copilot R5 on PR #819). The repository's disambiguation reads
 * already maintain this invariant at runtime; this just lifts it into the
 * type system.
 */
export type AlreadyDecidedRow = PersistedApproval & { status: 'approved' | 'rejected' };

export type DecideOutcome =
  | { outcome: 'updated'; row: PersistedApproval }
  | { outcome: 'not_found' }
  | { outcome: 'already_decided'; row: AlreadyDecidedRow }
  | { outcome: 'expired'; row: PersistedApproval };

export type ResetFailedApplyClaimOutcome =
  | { outcome: 'reset'; row: PersistedApproval }
  | { outcome: 'not_found' }
  | { outcome: 'not_failed'; row: PersistedApproval };

export interface ListPendingOptions {
  /** Bounded by [APPROVAL_LIST_MIN_LIMIT, APPROVAL_LIST_MAX_LIMIT]. Default APPROVAL_LIST_DEFAULT_LIMIT. */
  limit?: number;
  /** Non-negative integer. Default 0. Out-of-range / non-integer throws InvalidOffsetError. */
  offset?: number;
  /**
   * Snapshot "now" for TTL exclusion. Defaults to `new Date().toISOString()`
   * at call time. Passing an explicit value lets tests pin the boundary
   * deterministically without `jest.useFakeTimers`.
   */
  nowIso?: string;
  /**
   * Restrict results to a single `operation_type`. PUSHED INTO THE WHERE
   * CLAUSE — paginates against the filtered population, not the full one.
   * Copilot R3 on PR #851: the prior in-memory filter at the route layer
   * widened to APPROVAL_LIST_MAX_LIMIT (100) rows and post-filtered, which
   * silently undercounted ownership-reason approvals for tenants with >100
   * matching-status rows. Now the filter is applied SQL-side so `total` and
   * `items` agree on the filtered population at any page depth.
   */
  operationType?: ApprovalOperationType;
}

export const APPROVAL_LIST_MIN_LIMIT = 1;
export const APPROVAL_LIST_DEFAULT_LIMIT = 10;
export const APPROVAL_LIST_MAX_LIMIT = 100;

/** Thrown by list verbs when `opts.limit` is out of range or non-integer. */
export class InvalidLimitError extends Error {
  readonly code = 'invalid_limit';
  constructor(received: unknown, min: number, max: number) {
    super(`limit must be an integer in [${min}, ${max}]; received ${String(received)}`);
    this.name = 'InvalidLimitError';
  }
}

/**
 * Thrown by `listPendingForTenant` when `opts.offset` is non-integer OR
 * negative. Copilot R3 on PR #819 flagged the prior pass-through behavior:
 * negative or non-integer offsets reach the DB driver and produce surprising
 * errors. Matches the validation posture of `InvalidLimitError`.
 */
export class InvalidOffsetError extends Error {
  readonly code = 'invalid_offset';
  constructor(received: unknown) {
    super(`offset must be a non-negative integer; received ${String(received)}`);
    this.name = 'InvalidOffsetError';
  }
}

// ── Repository ────────────────────────────────────────────────────

@injectable()
export class ApprovalQueueRepository {
  constructor(
    @inject(TYPES.DatabaseService) private readonly db: DatabaseService,
  ) {}

  /** Insert a new pending approval. Returns the row as persisted. */
  async insertPending(row: NewPendingApprovalRow): Promise<PersistedApproval> {
    const db = this.db.getDatabase();
    await db
      .insertInto('governance_approvals')
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        requester_user_id: row.requesterUserId,
        operation_type: row.operationType,
        resource_type: row.resourceType,
        resource_id: row.resourceId,
        risk_level: row.riskLevel,
        redacted_payload: row.redactedPayload,
        policy_findings: row.policyFindings,
        status: 'pending',
        created_at: row.createdAt,
        expires_at: row.expiresAt,
        decided_at: null,
        decided_by_user_id: null,
        decision_reason: null,
        apply_idempotency_key: null,
        apply_status: 'not_started',
        applied_at: null,
        apply_failed_at: null,
        apply_error: null,
        write_descriptor: row.writeDescriptor,
      })
      .execute();

    const fetched = await this.getByIdInternal(row.tenantId, row.id);
    if (!fetched) {
      // Should be unreachable — we just inserted the row with the same id.
      // Plain Error is intentional: this path is a hard invariant violation
      // (DB layer would have errored on the INSERT first), not a recoverable
      // condition callers should pattern-match against. Copilot R3 on PR #819
      // flagged the prior comment claim of "typed error" — corrected.
      throw new Error(`insertPending could not read back row ${row.id}`);
    }
    return fetched;
  }

  /** Tenant-scoped get by id. Returns null on tenant mismatch or unknown id. */
  async getById(tenantId: string, id: string): Promise<PersistedApproval | null> {
    return this.getByIdInternal(tenantId, id);
  }

  /**
   * Tenant-scoped list of pending approvals, ordered created_at DESC + id
   * DESC for stable ordering on same-tick inserts (mirrors PR-OP-3b activity
   * log tiebreaker pattern).
   *
   * TTL-honoring: rows whose `expires_at <= opts.nowIso` are EXCLUDED even
   * when their persisted `status` is still 'pending' (e.g. the background
   * `expireStale` sweep hasn't caught up). The list contract is "actionable
   * pending rows," not "rows with status='pending'." Codex 5.4 HIGH on PR
   * #819 caught this gap.
   */
  async listPendingForTenant(
    tenantId: string,
    opts: ListPendingOptions = {},
  ): Promise<PersistedApproval[]> {
    const limit = this.validateLimit(opts.limit);
    const offset = this.validateOffset(opts.offset);
    const nowIso = opts.nowIso ?? new Date().toISOString();
    const db = this.db.getDatabase();
    let q = db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', nowIso);
    if (opts.operationType !== undefined) {
      q = q.where('operation_type', '=', opts.operationType);
    }
    const rows = await q
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map(rowToPersistedApproval);
  }

  /**
   * Tenant-scoped count of ACTIONABLE pending rows. Excludes expired-but-
   * unswept rows — see `listPendingForTenant` for the rationale.
   *
   * Accepts an optional `operationType` filter so the count and the list
   * stay in sync at any page depth (Copilot R3 on PR #851).
   */
  async countPendingForTenant(
    tenantId: string,
    nowIsoOrOpts?: string | { nowIso?: string; operationType?: ApprovalOperationType },
  ): Promise<number> {
    // Back-compat: prior signature accepted nowIso as a string positional arg.
    const opts = typeof nowIsoOrOpts === 'string' ? { nowIso: nowIsoOrOpts } : (nowIsoOrOpts ?? {});
    const now = opts.nowIso ?? new Date().toISOString();
    const db = this.db.getDatabase();
    let q = db
      .selectFrom('governance_approvals')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'pending')
      .where('expires_at', '>', now);
    if (opts.operationType !== undefined) {
      q = q.where('operation_type', '=', opts.operationType);
    }
    const result = await q.executeTakeFirstOrThrow();
    return Number(result.c);
  }

  /**
   * Tenant-scoped list of approvals filtered by terminal status — the history
   * view counterpart to `listPendingForTenant`. ONLY accepts the terminal
   * states `'approved'` and `'rejected'`; pending is handled separately via
   * `listPendingForTenant` because it carries an expires_at TTL gate that the
   * terminal-status filter doesn't need. (Decided rows are immutable; their
   * expires_at is informational, not actionable.)
   *
   * Ordering: `decided_at DESC, id DESC` — most-recently-DECIDED rows first.
   * NOT `created_at DESC` because the audit-trail mental model is "what got
   * decided when", not "what was requested when". An old request that an
   * operator approves today should appear ABOVE newer requests approved
   * earlier in the history view. Codex 5.5 MEDIUM on PR #826 caught the
   * prior `created_at` ordering. `id DESC` is the tiebreaker on same-tick
   * decisions (mirrors the pending-list tiebreaker pattern).
   *
   * Why terminal-only: mixing pending-but-expired rows into a generic
   * `listByStatus(...)` would either lie about the persisted status (the row
   * is still status='pending' in the DB until the background sweeper writes
   * 'expired') or produce two semantically different result sets behind one
   * method signature. The PR 3C Tier-C history-view follow-up ships approved + rejected
   * tabs only; expired-tab support is a follow-up (would require either a
   * UNION query or a separate route shape).
   */
  async listByTerminalStatusForTenant(
    tenantId: string,
    status: 'approved' | 'rejected',
    opts: ListPendingOptions = {},
  ): Promise<PersistedApproval[]> {
    const limit = this.validateLimit(opts.limit);
    const offset = this.validateOffset(opts.offset);
    const db = this.db.getDatabase();
    let q = db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', status);
    if (opts.operationType !== undefined) {
      q = q.where('operation_type', '=', opts.operationType);
    }
    const rows = await q
      .orderBy('decided_at', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .offset(offset)
      .execute();
    return rows.map(rowToPersistedApproval);
  }

  /**
   * Tenant-scoped count of decided rows for the given terminal status.
   *
   * Accepts an optional `operationType` filter so the count and the list
   * stay in sync at any page depth (Copilot R3 on PR #851).
   */
  async countByTerminalStatusForTenant(
    tenantId: string,
    status: 'approved' | 'rejected',
    opts: { operationType?: ApprovalOperationType } = {},
  ): Promise<number> {
    const db = this.db.getDatabase();
    let q = db
      .selectFrom('governance_approvals')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', status);
    if (opts.operationType !== undefined) {
      q = q.where('operation_type', '=', opts.operationType);
    }
    const result = await q
      .executeTakeFirstOrThrow();
    return Number(result.c);
  }

  /**
   * CAS-style decision write — only transitions 'pending' → 'approved'/'rejected'.
   *
   * Returns a tagged outcome so the service can map cleanly to 404 / 409 / 410
   * without a racy pre-read:
   *
   *   rowcount=1 → 'updated' (the happy CAS path)
   *   rowcount=0 → SELECT inside the same logical operation to disambiguate:
   *                no row at all                                     → 'not_found'
   *                status='expired' (post-sweep)                     → 'expired'  (R4)
   *                status='pending' AND expires_at <= decidedAt      → 'expired'  (R3 pre-sweep)
   *                otherwise (status='approved' / 'rejected')        → 'already_decided'
   *
   * Both expired cases collapse to the same outcome so the route layer
   * maps consistently to 410 regardless of whether the background sweeper
   * has caught up yet (Copilot R4 on PR #819).
   *
   * TTL gate (Codex 5.4 HIGH + Copilot R3 #1 on PR #819): the WHERE clause
   * additionally requires `expires_at > decidedAt`. Without this gate, a row
   * past its TTL but not yet swept by `expireStale` would still transition
   * to 'approved' / 'rejected' — letting an operator act on an "expired"
   * request and violating the spec §7 Q5 "terminal" contract.
   */
  async decide(args: {
    tenantId: string;
    id: string;
    decidedByUserId: string;
    decision: 'approved' | 'rejected';
    decisionReason: string | null;
    decidedAt: string;
  }): Promise<DecideOutcome> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        status: args.decision,
        decided_at: args.decidedAt,
        decided_by_user_id: args.decidedByUserId,
        decision_reason: args.decisionReason,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('id', '=', args.id)
      .where('status', '=', 'pending')
      .where('expires_at', '>', args.decidedAt)
      .executeTakeFirst();

    // numUpdatedRows is a bigint in kysely; coerce for arithmetic.
    if (Number(result.numUpdatedRows ?? 0n) === 1) {
      const row = await this.getByIdInternal(args.tenantId, args.id);
      if (!row) {
        // Unreachable — we just wrote with same tenant + id.
        throw new Error(`decide() could not read back row ${args.id}`);
      }
      return { outcome: 'updated', row };
    }

    const existing = await this.getByIdInternal(args.tenantId, args.id);
    if (!existing) {
      return { outcome: 'not_found' };
    }
    // 'expired' outcome covers BOTH:
    //   (a) post-sweep — status='expired' (the background sweeper already
    //       transitioned this row)
    //   (b) pre-sweep — status='pending' AND expires_at <= decidedAt (TTL
    //       elapsed but the sweeper hasn't caught up yet)
    // Without case (a), the route layer would map post-sweep expired rows
    // to 409 (already_decided) instead of 410 (expired) — breaking the
    // contract that "expired is terminal and always 410". Copilot R4 on
    // PR #819 caught the gap (3 findings, one root cause).
    if (
      existing.status === 'expired' ||
      (existing.status === 'pending' && existing.expiresAt <= args.decidedAt)
    ) {
      return { outcome: 'expired', row: existing };
    }
    // At this point the only remaining valid statuses are 'approved' or
    // 'rejected' — 'pending' rowcount=1 would have been the updated path,
    // 'pending' with elapsed TTL was caught above, and 'expired' was caught
    // above. The narrow cast lifts the runtime invariant into the type
    // system (AlreadyDecidedRow union variant; Copilot R5 on PR #819).
    return { outcome: 'already_decided', row: existing as AlreadyDecidedRow };
  }

  /**
   * Per-approval CAS claim for apply. Compare-and-swap pattern:
   *
   *   UPDATE governance_approvals
   *      SET apply_idempotency_key = ?
   *    WHERE id = ? AND tenant_id = ?
   *      AND apply_idempotency_key IS NULL
   *      AND status = 'approved'                   -- (R3 status gate)
   *
   * Returns the row if claimed (rowcount=1), null if already claimed OR if
   * the row's status is not 'approved' (rowcount=0).
   *
   * Two layered invariants:
   *   1. Per-approval idempotency: the same key value MAY legitimately appear
   *      across different approvals (the schema column is NON-UNIQUE; see
   *      migration 045). Each approval row can only be successfully claimed
   *      once.
   *   2. Status gate (Codex 5.4 MEDIUM on PR #819): only 'approved' rows are
   *      claimable. Without this gate, a row in 'pending' / 'rejected' /
   *      'expired' status with a NULL idempotency key could still be claimed,
   *      letting PR 3B's resume worker apply an action the operator never
   *      approved (or actively rejected). The CAS now refuses to even allow
   *      the apply attempt for non-approved rows.
   */
  async claimForApply(args: {
    tenantId: string;
    id: string;
    idempotencyKey: string;
  }): Promise<PersistedApproval | null> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        apply_idempotency_key: args.idempotencyKey,
        apply_status: 'claimed',
        applied_at: null,
        apply_failed_at: null,
        apply_error: null,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('id', '=', args.id)
      .where('apply_idempotency_key', 'is', null)
      .where('apply_status', '=', 'not_started')
      .where('status', '=', 'approved')
      .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0n) === 1) {
      return this.getByIdInternal(args.tenantId, args.id);
    }
    return null;
  }

  async markApplySucceeded(args: {
    tenantId: string;
    id: string;
    appliedAt: string;
  }): Promise<PersistedApproval | null> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        apply_status: 'succeeded',
        applied_at: args.appliedAt,
        apply_failed_at: null,
        apply_error: null,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('id', '=', args.id)
      .where('status', '=', 'approved')
      .where('apply_status', '=', 'claimed')
      .where('apply_idempotency_key', 'is not', null)
      .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0n) === 1) {
      return this.getByIdInternal(args.tenantId, args.id);
    }
    return null;
  }

  async markApplyFailed(args: {
    tenantId: string;
    id: string;
    error: string;
    failedAt: string;
  }): Promise<PersistedApproval | null> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        apply_status: 'failed',
        apply_failed_at: args.failedAt,
        apply_error: args.error,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('id', '=', args.id)
      .where('status', '=', 'approved')
      .where('apply_status', '=', 'claimed')
      .where('apply_idempotency_key', 'is not', null)
      .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0n) === 1) {
      return this.getByIdInternal(args.tenantId, args.id);
    }
    return null;
  }

  async resetFailedApplyClaim(args: {
    tenantId: string;
    id: string;
  }): Promise<ResetFailedApplyClaimOutcome> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        apply_idempotency_key: null,
        apply_status: 'not_started',
        applied_at: null,
        apply_failed_at: null,
        apply_error: null,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('id', '=', args.id)
      .where('status', '=', 'approved')
      .where('apply_status', '=', 'failed')
      .where('apply_idempotency_key', 'is not', null)
      .executeTakeFirst();

    if (Number(result.numUpdatedRows ?? 0n) === 1) {
      const row = await this.getByIdInternal(args.tenantId, args.id);
      if (!row) {
        throw new Error(`resetFailedApplyClaim() could not read back row ${args.id}`);
      }
      return { outcome: 'reset', row };
    }

    const existing = await this.getByIdInternal(args.tenantId, args.id);
    if (!existing) {
      return { outcome: 'not_found' };
    }
    return { outcome: 'not_failed', row: existing };
  }

  /**
   * Batch expire stale pending rows. Returns count expired.
   *
   * Bulk transition pending → expired for any row whose expires_at is at or
   * before `nowIso`. Called by a scheduled job (PR 3B). Decided rows are
   * never overwritten — the WHERE clause restricts to status='pending'.
   *
   * INTENTIONALLY CROSS-TENANT. This is the single exception to the
   * "tenant-scoping is mandatory on every read + every write" contract
   * enforced by every other method on this repository — and is by design.
   * The maintenance worker runs once per tick across all tenants; per-tenant
   * iteration would force the scheduled job to first enumerate every tenant
   * (no live source of truth) and then issue N writes that walk the same
   * partial index `idx_governance_approvals_expires_pending` anyway. Tenant
   * data is never read or written across boundaries — only the status column
   * flips pending → expired and decided_at is set. Copilot R1 on PR #819
   * flagged the prior unqualified phrasing; this docstring + the matching
   * comment in migration 045 are the corrected source of truth.
   */
  async expireStale(nowIso: string): Promise<number> {
    const db = this.db.getDatabase();
    const result = await db
      .updateTable('governance_approvals')
      .set({
        status: 'expired',
        decided_at: nowIso,
      })
      .where('status', '=', 'pending')
      .where('expires_at', '<=', nowIso)
      .executeTakeFirst();
    return Number(result.numUpdatedRows ?? 0n);
  }

  // ── Internals ───────────────────────────────────────────────────

  private async getByIdInternal(
    tenantId: string,
    id: string,
  ): Promise<PersistedApproval | null> {
    const db = this.db.getDatabase();
    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToPersistedApproval(row) : null;
  }

  private validateLimit(received: unknown): number {
    if (received === undefined) {
      return APPROVAL_LIST_DEFAULT_LIMIT;
    }
    if (typeof received !== 'number' || !Number.isInteger(received)) {
      throw new InvalidLimitError(received, APPROVAL_LIST_MIN_LIMIT, APPROVAL_LIST_MAX_LIMIT);
    }
    if (received < APPROVAL_LIST_MIN_LIMIT || received > APPROVAL_LIST_MAX_LIMIT) {
      throw new InvalidLimitError(received, APPROVAL_LIST_MIN_LIMIT, APPROVAL_LIST_MAX_LIMIT);
    }
    return received;
  }

  private validateOffset(received: unknown): number {
    if (received === undefined) {
      return 0;
    }
    if (typeof received !== 'number' || !Number.isInteger(received) || received < 0) {
      throw new InvalidOffsetError(received);
    }
    return received;
  }
}

// ── Row deserializer ──────────────────────────────────────────────

/**
 * Narrow the stringly-typed schema columns to the typed unions. Unknown
 * union values are returned unchanged (cast through `as`) — invariants live
 * at write time, not at read time. Callers that want to gate on enum values
 * should pattern-match the resulting union.
 */
function rowToPersistedApproval(row: GovernanceApproval): PersistedApproval {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    requesterUserId: row.requester_user_id,
    operationType: row.operation_type as ApprovalOperationType,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    riskLevel: row.risk_level as ApprovalRiskLevel,
    redactedPayload: row.redacted_payload,
    policyFindings: row.policy_findings,
    status: row.status as ApprovalStatus,
    createdAt: timestampToIso(row.created_at),
    expiresAt: timestampToIso(row.expires_at),
    decidedAt: nullableTimestampToIso(row.decided_at),
    decidedByUserId: row.decided_by_user_id,
    decisionReason: row.decision_reason,
    applyIdempotencyKey: row.apply_idempotency_key,
    applyStatus: (row.apply_status ?? 'not_started') as ApprovalApplyStatus,
    appliedAt: nullableTimestampToIso(row.applied_at ?? null),
    applyFailedAt: nullableTimestampToIso(row.apply_failed_at ?? null),
    applyError: row.apply_error ?? null,
    writeDescriptor: row.write_descriptor,
  };
}

/**
 * Coerce a timestamp column to an ISO string. Postgres TIMESTAMPTZ comes back
 * as `Date` via node-postgres; SQLite returns the raw TEXT verbatim. Normalize
 * to ISO strings at the read boundary so the TTL gate (R3) and the
 * disambiguation read (R4) compare apples to apples on a single representation
 * (Copilot R6 on PR #819).
 */
function timestampToIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function nullableTimestampToIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return timestampToIso(value);
}
