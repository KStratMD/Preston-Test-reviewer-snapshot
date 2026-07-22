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
  ResetFailedApplyClaimOutcome,
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
import type { CanonicalEntity, CallerSystem, SourceSystem } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import type { WriteDescriptor } from '../../governance/sourceOfTruth/guardedWrite';
import type { EncryptionService } from '../security/EncryptionService';
import { encryptDescriptor } from './writeDescriptorEncryption';

// ── Public types ──────────────────────────────────────────────────

/**
 * Discriminated union of enqueue reasons (PR 13b Stage B).
 *
 *   - governance: an OutboundDecision that flagged approvalRequired=true
 *     (the pre-existing path, unchanged).
 *   - ownership: a queue_for_human conflict-policy decision from
 *     guardedWrite + OwnershipResolver.validateWrite. Requires a fully-
 *     enriched WriteDescriptor so OwnershipResumeHandler can re-dispatch
 *     the original write after operator approval.
 */
export type EnqueueReason =
  | { kind: 'governance'; decision: OutboundDecision }
  | {
      kind: 'ownership';
      // Widened beyond CanonicalEntity to accept connector-side record types
      // (e.g. 'contacts', 'Customer') for entities not in SOURCE_OF_TRUTH_MANIFEST.
      // Copilot R1 cluster-B.
      entity: CanonicalEntity | string;
      declaredOwner: SourceSystem;
      callerSystem: CallerSystem;
      conflictPolicy: 'queue_for_human';
      writeDescriptor: WriteDescriptor;
    };

export interface EnqueueArgs {
  tenantId: string;
  requesterUserId: string;
  operationType: ApprovalOperationType;
  resourceType: string;
  resourceId: string;
  /**
   * The enqueue reason — either a governance decision or an ownership-queue
   * decision from guardedWrite (PR 13b Stage B). Callers that pass the legacy
   * `decision` shape must wrap it: `{ kind: 'governance', decision }`.
   */
  reason: EnqueueReason;
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
    @inject(TYPES.EncryptionService) private readonly encryptionService: EncryptionService,
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
   * Enqueue an approval. Two arms:
   *
   *   governance — from an `OutboundDecision` that flagged approvalRequired=true.
   *     Three fail-closed guards apply (same as the original PR 3A contract):
   *       1. decision.approvalRequired must be true.
   *       2. decision.redactedPayload must be present.
   *       3. decision.auditMetadata.redacted must be true (guards against
   *          persisting the original payload as the redacted form).
   *
   *   ownership — from a `queue_for_human` conflict-policy decision in
   *     `guardedWrite`. The `WriteDescriptor.args` field is the raw
   *     connector mutation payload (typically PII — contact name, email,
   *     address). PR 13c-2 wraps it in AES-256-GCM via the global
   *     `EncryptionService` before persisting into
   *     `governance_approvals.write_descriptor`; the operator approvals API
   *     returns the column verbatim, so the encryption keeps the column
   *     opaque to the approval surface (and to anyone with read access to
   *     the row absent the key). `OwnershipResumeHandler.apply()` decrypts
   *     on approve before re-dispatching. The manifest vocabulary fields
   *     (`targetSystem`, `operation`, etc.) stay plaintext for queryability.
   *
   *     Trust model: identical blast radius to AI-provider API-key
   *     encryption — same global key (`AI_CONFIG_ENCRYPTION_KEY`), same
   *     `EncryptionService` instance. Per-tenant envelope encryption is a
   *     follow-up hardening lift tracked outside this PR.
   *
   * The `reason` field is a discriminated union — callers must wrap their
   * existing `decision` arg: `reason: { kind: 'governance', decision }`.
   */
  async enqueue(args: EnqueueArgs): Promise<string> {
    const { reason } = args;

    if (reason.kind === 'governance') {
      const { decision } = reason;
      if (!decision.approvalRequired) {
        throw new InvalidDecisionError(
          'enqueue() requires decision.approvalRequired === true',
        );
      }
      if (decision.redactedPayload === undefined) {
        throw new InvalidDecisionError(
          'enqueue() requires decision.redactedPayload to be present (fail-safe blocks must not enqueue)',
        );
      }
      if (decision.auditMetadata.redacted !== true) {
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
        riskLevel: decision.riskLevel as 'low' | 'medium' | 'high',
        redactedPayload: JSON.stringify(decision.redactedPayload),
        policyFindings: JSON.stringify(decision.findings),
        createdAt,
        expiresAt,
        writeDescriptor: null,
      });

      this.logger.info('approval queued', {
        tenantId: args.tenantId,
        approvalId: id,
        operationType: args.operationType,
        resourceType: args.resourceType,
        riskLevel: decision.riskLevel,
      });

      return id;
    }

    // ownership arm — queue_for_human from guardedWrite (PR 13c-2 Task 3).
    //
    // PR 13b fail-closed this arm via QueueForHumanNotYetSafeError because
    // operator approvals API returns `PersistedApproval` rows verbatim and
    // the raw `WriteDescriptor.args` would leak PII through that surface.
    // PR 13c-2 lifts the fail-closed by wrapping args in AES-256-GCM via
    // the global EncryptionService before persisting. The column stays a
    // single TEXT (no schema change) — only the JSON shape inside changes.
    if (!reason.writeDescriptor) {
      throw new InvalidDecisionError(
        'enqueue() ownership arm requires a non-null writeDescriptor',
      );
    }

    // Copilot R1 on PR #853: `enqueue()` is independently callable, so the
    // service must validate the operationType ↔ reason.kind invariant.
    // A mis-call with `reason.kind: 'ownership'` but operationType !==
    // 'ownership_write' would silently persist an encrypted descriptor
    // under (e.g.) operationType: 'ai_call', breaking the
    // operations-router `?reason=ownership` filter and the resume registry's
    // operationType-keyed dispatch.
    if (args.operationType !== 'ownership_write') {
      throw new InvalidDecisionError(
        `enqueue() ownership arm requires operationType='ownership_write'; received '${args.operationType}'`,
      );
    }

    const encryptedPayload = await encryptDescriptor(
      reason.writeDescriptor,
      this.encryptionService,
    );

    const ownershipNow = Date.now();
    const ownershipId = randomUUID();
    const ownershipCreatedAt = new Date(ownershipNow).toISOString();
    const ownershipExpiresAt = new Date(ownershipNow + this.config.defaultTtlMs).toISOString();

    await this.repo.insertPending({
      id: ownershipId,
      tenantId: args.tenantId,
      requesterUserId: args.requesterUserId,
      operationType: args.operationType,
      resourceType: args.resourceType,
      resourceId: args.resourceId,
      // queue_for_human decisions don't carry an explicit risk level; the
      // policy itself is the signal. 'medium' matches the decision audit
      // row's riskLevel for the queue_required path in guardedWrite.
      riskLevel: 'medium',
      // Empty findings array — ownership-queue rows are not produced by
      // OutboundGovernance and so don't have policy findings. The column
      // is NOT NULL so we serialize an empty array rather than null.
      redactedPayload: JSON.stringify({}),
      policyFindings: JSON.stringify([]),
      createdAt: ownershipCreatedAt,
      expiresAt: ownershipExpiresAt,
      writeDescriptor: JSON.stringify(encryptedPayload),
    });

    this.logger.info('ownership approval queued', {
      tenantId: args.tenantId,
      approvalId: ownershipId,
      operationType: args.operationType,
      resourceType: args.resourceType,
      callerSystem: reason.callerSystem,
      declaredOwner: reason.declaredOwner,
    });

    return ownershipId;
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

  /**
   * Tenant-scoped pending count.
   *
   * Accepts an optional `operationType` filter so the route layer can ask
   * "how many ownership_write rows are pending" without first listing them
   * and counting in memory (Copilot R3 on PR #851).
   */
  async countPending(
    tenantId: string,
    opts: { operationType?: ApprovalOperationType } = {},
  ): Promise<number> {
    return this.repo.countPendingForTenant(tenantId, opts);
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

  /**
   * Tenant-scoped count of decided rows for the given terminal status.
   *
   * Accepts an optional `operationType` filter — see {@link countPending}
   * (Copilot R3 on PR #851).
   */
  async countByTerminalStatus(
    tenantId: string,
    status: 'approved' | 'rejected',
    opts: { operationType?: ApprovalOperationType } = {},
  ): Promise<number> {
    return this.repo.countByTerminalStatusForTenant(tenantId, status, opts);
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
      this.logger.info('ApprovalQueueService → resume completed', {
        approvalId: row.id,
        tenantId: row.tenantId,
        applied: outcome.applied,
        ...('skipped' in outcome ? { skipped: outcome.skipped } : {}),
        ...('error' in outcome ? { error: outcome.error } : {}),
      });
    } catch (err) {
      // Belt + suspenders — worker.resume contract returns ResumeOutcome and
      // never throws. If it ever does throw, log without disturbing the
      // approve/reset response (already returned).
      this.logger.error(
        'ApprovalQueueService → worker.resume threw (contract violation)',
        err instanceof Error ? err : new Error(String(err)),
        { approvalId: row.id, tenantId: row.tenantId },
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

  /**
   * Admin recovery for a failed apply claim. `reason` is REQUIRED at the
   * service boundary — mirrors `reject()`'s non-empty-reason gate so
   * programmatic callers cannot bypass the operator-accountability audit
   * trail by skipping the reason field (Copilot R3 finding).
   */
  async resetFailedApplyClaim(args: {
    tenantId: string;
    id: string;
    adminUserId: string;
    reason: string;
  }): Promise<ResetFailedApplyClaimOutcome> {
    if (!args.reason || args.reason.trim().length === 0) {
      throw new InvalidDecisionError('resetFailedApplyClaim() requires a non-empty reason');
    }
    const outcome = await this.repo.resetFailedApplyClaim({ tenantId: args.tenantId, id: args.id });
    this.logger.info('Approval apply claim reset requested', {
      tenantId: args.tenantId,
      approvalId: args.id,
      adminUserId: args.adminUserId,
      reason: args.reason,
      outcome: outcome.outcome,
    });
    // Copilot R11: after a successful reset, re-invoke the resume worker.
    // Copilot R13: fire it ASYNC (fire-and-forget via `void`) so the admin
    // HTTP recovery response isn't blocked on a slow/hung connector write —
    // matches the `approve() → fireResumeAsync` pattern. Failures are logged
    // inside fireResumeAsync; reset always returns immediately after the DB
    // mutation lands.
    if (outcome.outcome === 'reset' && this.resumeWorker) {
      void this.fireResumeAsync(outcome.row);
    }
    return outcome;
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
