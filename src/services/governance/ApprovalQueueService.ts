// HITL approval-queue service (PR 3A).
//
// Domain layer atop ApprovalQueueRepository. Maps repo CAS outcomes to typed
// errors (ApprovalNotFoundError → route 404; AlreadyDecidedError → 409).
//
// PR 3A in isolation has zero side-effects: the table exists, nothing writes
// to it yet. The service is the surface PR 3B's route catches enqueue
// against and the surface PR 3C's operator API decides through.

import { injectable, inject, unmanaged } from 'inversify';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import type {
  ApprovalOperationType,
  ApprovalQueueRepository,
  ListPendingOptions,
  PersistedApproval,
} from './ApprovalQueueRepository';
import type { OutboundDecision } from './OutboundGovernanceService';
import {
  AlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  InvalidDecisionError,
  UnredactedPayloadError,
} from './ApprovalQueueErrors';
import type { ApprovalResumeWorker } from './ApprovalResumeWorker';

// ── Public types ──────────────────────────────────────────────────

export interface EnqueueArgs {
  tenantId: string;
  requesterUserId: string;
  operationType: ApprovalOperationType;
  resourceType: string;
  resourceId: string;
  /** The OutboundDecision that flagged approvalRequired=true. */
  decision: OutboundDecision;
}

export interface DecisionArgs {
  tenantId: string;
  id: string;
  approverUserId: string;
  /** Required on reject; optional on approve. */
  reason?: string;
}

export interface ApprovalQueueServiceConfig {
  /** TTL in milliseconds before a pending approval expires. Default 24h. */
  defaultTtlMs: number;
}

const DEFAULT_CONFIG: ApprovalQueueServiceConfig = {
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24h (per spec §7 Q4)
};

// ── Service ───────────────────────────────────────────────────────

@injectable()
export class ApprovalQueueService {
  private readonly config: ApprovalQueueServiceConfig;
  /**
   * PR 3B: post-construction setter (not constructor-injected) to break the
   * potential circular dep between this service and the resume worker. The
   * composition root resolves the worker AFTER constructing this service and
   * calls `setResumeWorker(worker)`. PR 3A unit tests don't wire the worker
   * and accept the no-op resume behavior — `approve()` is a successful CAS
   * either way; the worker simply doesn't fire.
   */
  private resumeWorker?: ApprovalResumeWorker;

  constructor(
    @inject(TYPES.ApprovalQueueRepository) private readonly repo: ApprovalQueueRepository,
    @inject(TYPES.Logger) private readonly logger: Logger,
    @unmanaged() config?: Partial<ApprovalQueueServiceConfig>,
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Wire the resume worker (PR 3B). Called once from the composition root
   * after both the service and the worker are constructed. Calling twice
   * silently overwrites — last-write-wins.
   *
   * Passing `undefined` disables resume firing — `approve()` becomes a
   * pure CAS without any post-decision side effect. This is the default
   * state immediately after construction; PR 3A's unit tests rely on it
   * by never calling this setter, but callers may also pass `undefined`
   * explicitly to drop a previously-wired worker (e.g. test teardown).
   * Copilot R5 clarified the docstring (it previously implied PR 3A's
   * tests actively passed `undefined`, which they don't).
   */
  setResumeWorker(worker: ApprovalResumeWorker | undefined): void {
    this.resumeWorker = worker;
  }

  /**
   * Enqueue an approval from an `OutboundDecision` that flagged
   * approvalRequired=true. Throws `InvalidDecisionError` for any other
   * decision shape — callers (PR 3B route catches) must only invoke this
   * after pattern-matching on `decision.approvalRequired === true`.
   *
   * The redacted_payload comes from `decision.redactedPayload`, the
   * DLP-scanned form — NEVER the caller's raw payload.
   *
   * Three defensive guards, all fail-closed:
   *
   *   1. `decision.approvalRequired === true` — caller-misuse guard
   *      (`InvalidDecisionError`).
   *   2. `decision.redactedPayload !== undefined` — fail-safe blocks
   *      (oversize / scan exception / scanFailed) intentionally omit this
   *      field per `OutboundDecision.redactedPayload` jsdoc; they must not
   *      enqueue (`InvalidDecisionError`).
   *   3. `decision.auditMetadata.redacted === true` — `OutboundGovernanceService`
   *      falls back to the original payload when `scanResult.redactedData` is
   *      missing (`redactedPayload = scanResult.redactedData ?? payload`). If
   *      PII was detected (`approvalRequired=true`) but no redacted form was
   *      produced, the "redactedPayload" is actually the original. Persisting
   *      it would violate the spec §3 acceptance gate "No raw PII in approval
   *      records." Fail-closed via `UnredactedPayloadError` (route → 500).
   *      Copilot R2 on PR #819 caught this.
   */
  async enqueue(args: EnqueueArgs): Promise<string> {
    if (!args.decision.approvalRequired) {
      throw new InvalidDecisionError(
        'enqueue() requires decision.approvalRequired === true',
      );
    }
    if (args.decision.redactedPayload === undefined) {
      throw new InvalidDecisionError(
        'enqueue() requires decision.redactedPayload to be present (fail-safe blocks must not enqueue)',
      );
    }
    if (args.decision.auditMetadata.redacted !== true) {
      throw new UnredactedPayloadError(
        'enqueue() refused: decision.auditMetadata.redacted !== true, so decision.redactedPayload is the original (unredacted) payload — persisting would leak raw PII into governance_approvals',
      );
    }

    const now = Date.now();
    const id = randomUUID();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + this.config.defaultTtlMs).toISOString();

    await this.repo.insertPending({
      id,
      tenantId: args.tenantId,
      requesterUserId: args.requesterUserId,
      operationType: args.operationType,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      // OutboundDecision.riskLevel widens to include 'none' which never reaches
      // approvalRequired=true. The narrow cast is sound under that invariant;
      // PR 3B's resume-worker pipeline will not produce a 'none' here either.
      riskLevel: args.decision.riskLevel as 'low' | 'medium' | 'high',
      redactedPayload: JSON.stringify(args.decision.redactedPayload),
      policyFindings: JSON.stringify(args.decision.findings),
      createdAt,
      expiresAt,
    });

    this.logger.info('approval queued', {
      tenantId: args.tenantId,
      approvalId: id,
      operationType: args.operationType,
      resourceType: args.resourceType,
      riskLevel: args.decision.riskLevel,
    });

    return id;
  }

  /** Tenant-scoped get. Returns null on tenant mismatch or unknown id. */
  async getById(tenantId: string, id: string): Promise<PersistedApproval | null> {
    return this.repo.getById(tenantId, id);
  }

  /** Tenant-scoped pending list. Bounded by APPROVAL_LIST_MAX_LIMIT. */
  async listPending(
    tenantId: string,
    opts?: ListPendingOptions,
  ): Promise<PersistedApproval[]> {
    return this.repo.listPendingForTenant(tenantId, opts);
  }

  /** Tenant-scoped pending count. */
  async countPending(tenantId: string): Promise<number> {
    return this.repo.countPendingForTenant(tenantId);
  }

  /**
   * Tenant-scoped history list — approved or rejected rows.
   *
   * Pending status is NOT accepted here; callers viewing the pending tab use
   * `listPending` (which honours the expires_at TTL gate). The terminal-only
   * shape keeps the history surface honest about what it returns: decided
   * rows that won't change again.
   */
  async listByTerminalStatus(
    tenantId: string,
    status: 'approved' | 'rejected',
    opts?: ListPendingOptions,
  ): Promise<PersistedApproval[]> {
    return this.repo.listByTerminalStatusForTenant(tenantId, status, opts);
  }

  /** Tenant-scoped count of decided rows for the given terminal status. */
  async countByTerminalStatus(
    tenantId: string,
    status: 'approved' | 'rejected',
  ): Promise<number> {
    return this.repo.countByTerminalStatusForTenant(tenantId, status);
  }

  /**
   * Operator approve. CAS to 'approved'.
   *   not_found       → ApprovalNotFoundError (route 404)
   *   already_decided → AlreadyDecidedError (route 409)
   *   updated         → returns the persisted row
   *
   * On a successful CAS, fire-and-forget the resume worker (PR 3B). The
   * non-blocking behavior comes from `void this.fireResumeAsync(row)` — the
   * promise is intentionally NOT awaited, so the approve() response returns
   * to the caller immediately while the worker runs in the background
   * (operator UI feels responsive). The worker NEVER throws (its contract
   * returns ResumeOutcome); `fireResumeAsync` adds a belt-and-suspenders
   * catch so even a contract violation can't crash anything (Copilot R3
   * clarified the control-flow comment).
   */
  async approve(args: DecisionArgs): Promise<PersistedApproval> {
    const row = await this.decide({ ...args, decision: 'approved' });
    if (this.resumeWorker) {
      void this.fireResumeAsync(row);
    }
    return row;
  }

  private async fireResumeAsync(row: PersistedApproval): Promise<void> {
    if (!this.resumeWorker) return;
    try {
      const outcome = await this.resumeWorker.resume(row);
      this.logger.info('ApprovalQueueService.approve → resume completed', {
        approvalId: row.id,
        applied: outcome.applied,
        ...('skipped' in outcome ? { skipped: outcome.skipped } : {}),
        ...('error' in outcome ? { error: outcome.error } : {}),
      });
    } catch (err) {
      // Belt + suspenders — worker.resume contract returns ResumeOutcome and
      // never throws. If it ever does throw, log without disturbing the
      // approve response (already returned).
      this.logger.error(
        'ApprovalQueueService.approve → worker.resume threw (contract violation)',
        err instanceof Error ? err : new Error(String(err)),
        { approvalId: row.id },
      );
    }
  }

  /**
   * Operator reject. CAS to 'rejected'.
   * `reason` is REQUIRED (Codex acceptance gate); throws InvalidDecisionError
   * if missing.
   */
  async reject(args: DecisionArgs): Promise<PersistedApproval> {
    if (!args.reason || args.reason.trim().length === 0) {
      throw new InvalidDecisionError('reject() requires a non-empty reason');
    }
    return this.decide({ ...args, decision: 'rejected' });
  }

  /**
   * Per-approval CAS claim for apply. Pass-through to the repository for the
   * PR 3B `ApprovalResumeWorker` (which lands in 3B, not 3A). Returns the
   * claimed row on success, null if another worker already claimed it.
   */
  async claimForApply(args: {
    tenantId: string;
    id: string;
    idempotencyKey: string;
  }): Promise<PersistedApproval | null> {
    return this.repo.claimForApply(args);
  }

  // ── Internals ───────────────────────────────────────────────────

  private async decide(
    args: DecisionArgs & { decision: 'approved' | 'rejected' },
  ): Promise<PersistedApproval> {
    const result = await this.repo.decide({
      tenantId: args.tenantId,
      id: args.id,
      decidedByUserId: args.approverUserId,
      decision: args.decision,
      decisionReason: args.reason ?? null,
      decidedAt: new Date().toISOString(),
    });

    if (result.outcome === 'not_found') {
      throw new ApprovalNotFoundError(args.id);
    }
    if (result.outcome === 'expired') {
      // TTL elapsed before the operator decided. Per spec §7 Q5, expired
      // is TERMINAL — the caller must re-issue the original request. Codex
      // 5.4 HIGH + Copilot R3 #1 on PR #819: route layer needs 410 distinct
      // from 409 (already_decided), so we throw a distinct typed class.
      throw new ApprovalExpiredError(args.id);
    }
    if (result.outcome === 'already_decided') {
      throw new AlreadyDecidedError(args.id, result.row.status);
    }

    this.logger.info('approval decided', {
      tenantId: args.tenantId,
      approvalId: args.id,
      decision: args.decision,
      approverUserId: args.approverUserId,
    });

    return result.row;
  }
}
