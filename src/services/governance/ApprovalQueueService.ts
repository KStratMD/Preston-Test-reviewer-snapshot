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
import { isPendingOwnershipFingerprintConflict } from './ApprovalQueueRepository';
import type { ApprovalScope, RequesterProvenance } from './ApprovalQueueRepository';
import type { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import { computeApprovalFingerprint } from './approvalFingerprint';
import type { OutboundDecision } from './OutboundGovernanceService';
import {
  AlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  InvalidDecisionError,
  SeparationOfDutiesError,
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
  /**
   * How the requester was identified. Omitted reads as 'unknown', so a caller
   * that never considered provenance cannot pass for a verified one.
   */
  requesterProvenance?: RequesterProvenance;
  /**
   * The platform account this request came from. An approver must match it.
   * Null for JWT and system requests, which belong to no account.
   */
  requesterScope?: ApprovalScope | null;
}

/**
 * Who is deciding, and what they have actually proved.
 *
 * `verifiedRoles` comes from an `embedded_role_grants` row the caller proved
 * possession of — never from a role the host asserted. Before that split, a
 * host claiming 'approver' in the bootstrap body could approve its own tenant's
 * queue (measured 2026-09-03).
 */
export interface ApprovalDecider {
  userId: string;
  verifiedRoles: string[];
  scope: ApprovalScope | null;
}

export interface DecisionArgs {
  tenantId: string;
  id: string;
  approver?: ApprovalDecider;
  /**
   * @deprecated Pass `approver`. A bare user id carries no proof, so it maps to
   * an approver with no verified roles — which the separation-of-duties gate
   * refuses. Existing callers must be migrated, not silently admitted.
   */
  approverUserId?: string;
  /** Required on reject; optional on approve. */
  reason?: string;
}

// SeparationOfDutiesError is defined in ./ApprovalQueueErrors so the route
// error handler can import it without a runtime edge into this module. Re-
// exported here because callers reach for it beside the service that throws it.
export { SeparationOfDutiesError } from './ApprovalQueueErrors';

export interface ApprovalQueueServiceConfig {
  /** TTL in milliseconds before a pending approval expires. Default 24h. */
  defaultTtlMs: number;
}

const DEFAULT_CONFIG: ApprovalQueueServiceConfig = {
  defaultTtlMs: 24 * 60 * 60 * 1000, // 24h (per spec §7 Q4)
};

/**
 * Fixed text for the one path the bounded conflict protocol cannot resolve.
 * Carries no tenant data, no fingerprint, and no descriptor content.
 */
export const APPROVAL_ENQUEUE_NO_CONVERGENCE =
  'ownership approval enqueue did not converge on a pending row';

/**
 * How many dedupe conflicts the enqueue will RESOLVE before giving up. The
 * loop runs this many times plus one, so every resolution is followed by
 * another insert.
 *
 * Counting resolutions rather than inserts is the point. Copilot review on
 * #1131: with an insert bound, the LAST iteration could resolve a conflict and
 * then have no attempt left to use the resolution. Concretely — the blocker
 * disappears between the failed insert and the lookup, which means the dedupe
 * slot is now free, and the enqueue would nonetheless fail with
 * APPROVAL_ENQUEUE_NO_CONVERGENCE. That refuses a legitimate governed write
 * for a conflict that no longer exists, and it needs no adversary: ordinary
 * contention produces it.
 *
 * Still bounded, for the original reason. A live blocker is RETURNED rather
 * than retried, so the loop cannot spin on one; but a stream of concurrent
 * writers churning the slot could otherwise retry forever, and failing loudly
 * is the safer direction — the caller's write is refused, never duplicated.
 *
 * THE RESIDUAL IS RELOCATED, NOT ELIMINATED, and saying otherwise would be the
 * same overstatement the original comment made. Three consecutive conflicts
 * whose lookups all come back empty still throw while the slot is free. No
 * finite bound removes that (Codex review on #1131): raising the number only
 * makes it need one more simultaneous contention event, at the cost of more
 * database work on a path that is already the unhappy one. What changes with
 * this bound is the likelihood — it now takes three coincidences rather than
 * two — not the existence of the case.
 */
const ENQUEUE_CONFLICT_RESOLUTIONS = 2;

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
    /**
     * A8 dedupe key, as raw bytes from the composition root. Injected rather
     * than read here so this service never touches `process.env` and tests can
     * pin a deterministic key without any environment setup.
     */
    @inject(TYPES.ApprovalFingerprintKey) private readonly fingerprintKey: Buffer,
    /**
     * The persisted audit writer. Decisions and refusals are both recorded
     * through it — a refused decision that leaves no trace is indistinguishable
     * from one that was never attempted.
     */
    @inject(TYPES.AuditLogRepository) private readonly auditLogs: AuditLogRepository,
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
        requesterUserId: args.requesterUserId.trim(),
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
        requesterProvenance: args.requesterProvenance,
        requesterScope: args.requesterScope ?? null,
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

    // Fingerprint the PLAINTEXT intent, and do it BEFORE encryption. The
    // descriptor is sealed with AES-256-GCM under a random IV, so the
    // ciphertext differs on every call for identical input — fingerprinting it
    // would produce a fresh value each time and dedupe exactly nothing.
    //
    // Every vocabulary field is read from the WRITE DESCRIPTOR, never from the
    // `reason` wrapper, even where the wrapper carries an identical-looking
    // one. Copilot review on #1131: the descriptor is what gets persisted and
    // replayed; `reason.callerSystem` and `reason.entity` are not stored
    // anywhere, and nothing forces them to agree with `ownership.*`. Mixing
    // the two sources meant a caller passing a mismatched wrapper around the
    // same descriptor produced a DIFFERENT fingerprint for an IDENTICAL
    // persisted write — dedupe silently off, duplicate approvals, which is the
    // failure this whole mechanism exists to prevent. `enqueue` is
    // independently callable (see the operationType guard above, added for the
    // same reason), so that mismatch is reachable rather than theoretical.
    //
    // Keeping the intent a function of persisted state only is what makes the
    // "same fingerprint iff same persisted write" contract true by
    // construction rather than by caller discipline.
    const { ownership } = reason.writeDescriptor;
    const fingerprint = computeApprovalFingerprint(
      {
        tenantId: args.tenantId,
        operationType: args.operationType,
        resourceType: args.resourceType,
        resourceId: args.resourceId,
        callerSystem: ownership.callerSystem,
        targetSystem: ownership.targetSystem,
        entity: String(ownership.entity),
        operation: reason.writeDescriptor.operation,
        descriptor: reason.writeDescriptor,
      },
      this.fingerprintKey,
    );

    const encryptedPayload = await encryptDescriptor(
      reason.writeDescriptor,
      this.encryptionService,
    );
    const serializedDescriptor = JSON.stringify(encryptedPayload);

    // Bounded insert-conflict convergence. The partial unique index cannot
    // express `expires_at > now`, so a stale unreaped pending row still
    // occupies the slot; that residue is resolved here rather than in SQL.
    for (let resolution = 0; resolution <= ENQUEUE_CONFLICT_RESOLUTIONS; resolution += 1) {
      const ownershipNow = Date.now();
      const ownershipId = randomUUID();
      const ownershipCreatedAt = new Date(ownershipNow).toISOString();
      const ownershipExpiresAt = new Date(ownershipNow + this.config.defaultTtlMs).toISOString();

      try {
        await this.repo.insertPending({
          id: ownershipId,
          tenantId: args.tenantId,
          requesterUserId: args.requesterUserId.trim(),
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
          writeDescriptor: serializedDescriptor,
          requesterProvenance: args.requesterProvenance,
          requesterScope: args.requesterScope ?? null,
          requestFingerprint: fingerprint,
        });

        this.logger.info('ownership approval queued', {
          tenantId: args.tenantId,
          approvalId: ownershipId,
          operationType: args.operationType,
          resourceType: args.resourceType,
          // From the descriptor, matching the fingerprint above. Copilot review
          // on #1131: logging the `reason` wrapper's copies would make the log
          // disagree with the row whenever a caller passes a mismatched
          // wrapper — and that is precisely the situation someone would be
          // reading these lines to diagnose.
          callerSystem: ownership.callerSystem,
          declaredOwner: ownership.declaredOwner,
        });

        return ownershipId;
      } catch (error) {
        // Anything that is NOT this specific dedupe conflict is a real
        // failure and must surface unchanged — swallowing it would return
        // some unrelated approval's id as if the write had been queued.
        if (!isPendingOwnershipFingerprintConflict(error)) throw error;

        const nowIso = new Date().toISOString();
        const blocker = await this.repo.findPendingOwnershipByFingerprint(
          args.tenantId,
          fingerprint,
        );

        // The blocker was decided or swept between the failed insert and this
        // read. The slot is free again, so retry rather than report a
        // conflict that no longer exists.
        if (!blocker) continue;

        if (blocker.expiresAt > nowIso) {
          // A live pending row for identical intent: this enqueue IS the
          // duplicate the mechanism exists to absorb. Return the existing id
          // so the caller and the operator both see one approval.
          this.logger.info('ownership approval deduplicated onto an existing pending row', {
            tenantId: args.tenantId,
            approvalId: blocker.id,
            operationType: args.operationType,
            resourceType: args.resourceType,
          });
          return blocker.id;
        }

        // Stale: past its TTL but not yet swept. Expire it under a CAS so the
        // next iteration's insert can take the slot. Skipped once the
        // resolution budget is spent — there is no insert left to use it, and
        // the row is better left for the background sweep than transitioned by
        // a call that is about to fail.
        if (resolution < ENQUEUE_CONFLICT_RESOLUTIONS) {
          await this.repo.expirePendingFingerprintIfStale({
            tenantId: args.tenantId,
            fingerprint,
            nowIso,
          });
        }
      }
    }

    // Two rounds both ended on a blocker we could not clear. Fixed text, and
    // no fingerprint or tenant data in the message.
    this.logger.warn(APPROVAL_ENQUEUE_NO_CONVERGENCE, {
      tenantId: args.tenantId,
      operationType: args.operationType,
      resourceType: args.resourceType,
    });
    throw new Error(APPROVAL_ENQUEUE_NO_CONVERGENCE);
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
    // A bare approverUserId carries no proof of anything, so it maps to an
    // approver with no verified roles — which the first separation-of-duties
    // check below refuses. Admitting it would leave the deprecated path as a
    // way around the gate.
    const candidate: ApprovalDecider | undefined =
      args.approver ??
      (args.approverUserId !== undefined
        ? { userId: args.approverUserId, verifiedRoles: [], scope: null }
        : undefined);

    // The id is TRIMMED before it is judged, and blank fails. Every path below
    // this point either records a decision or audits a refusal, and both
    // attribute the row to this id — so a whitespace-only id would produce an
    // audit entry that reads as a real attempt by an actor who cannot be
    // identified. That is caller misuse, not a failed authorization, and it is
    // refused before anything is written. The same trim is why
    // requirePlatformAdmin's readActorId exists.
    const deciderUserId = candidate === undefined ? '' : candidate.userId.trim();
    if (deciderUserId === '') {
      throw new InvalidDecisionError(
        'decide() requires an approver with a non-blank userId (or the deprecated approverUserId)',
      );
    }

    const approver: ApprovalDecider = { ...(candidate as ApprovalDecider), userId: deciderUserId };

    const existing = await this.repo.getById(args.tenantId, args.id);
    if (!existing) {
      throw new ApprovalNotFoundError(args.id);
    }

    // Row state wins over separation of duties, and the ordering is deliberate.
    //
    // A terminal row cannot be decided by ANYONE, so refusing it on the
    // approver's identity says something untrue about why: the caller gets a
    // 403 naming a separation-of-duties reason for a decision that was
    // impossible regardless, and — worse — a
    // `governance.approval.decision_rejected` audit row is written claiming a
    // refused decision attempt on a row that was never decidable. Polluting the
    // audit trail with misleading refusals is the exact failure this work
    // exists to remove, and it outweighs the small state disclosure of telling
    // an unverified caller that an approval they already named is closed.
    //
    // The CAS below still re-checks state, because the row can turn terminal
    // between this read and that write; this only decides which error a caller
    // sees when it was ALREADY terminal.
    if (existing.status === 'expired') {
      throw new ApprovalExpiredError(args.id);
    }
    if (existing.status !== 'pending') {
      throw new AlreadyDecidedError(args.id, existing.status);
    }

    // The three separation-of-duties checks, in order of what they mean.
    if (!approver.verifiedRoles.some((r) => r === 'approver' || r === 'admin')) {
      await this.rejectDecision('unverified_approver', existing, approver);
    }
    // BOTH sides are trimmed. The approver id is normalised above; the
    // requester id is host-controlled too — it comes from the embedded
    // bootstrap body — so comparing a trimmed approver against an untrimmed
    // requester let a requester approve their own request by enqueuing as
    // '  alice  ' and deciding as 'alice'. Rows written before the enqueue-side
    // trim below can still carry padding, so normalising here is what makes
    // existing data safe, not just new data.
    if (approver.userId === existing.requesterUserId.trim()) {
      await this.rejectDecision('self_approval', existing, approver);
    }
    // A row with no scope came from a JWT or system path and belongs to no
    // platform account, so any verified approver in the tenant may decide it.
    // A row WITH a scope may only be decided from that same account.
    // Nullish, not `!== null`: a row read through a path that never populated
    // these fields yields undefined, and treating undefined as "has a scope"
    // would refuse every such decision with scope_mismatch — a gate failing
    // closed on its own missing data rather than on a real mismatch.
    const requesterPlatform = existing.requesterPlatform ?? null;
    const requesterAccount = existing.requesterPlatformAccountId ?? null;
    if (
      requesterPlatform !== null &&
      (approver.scope === null ||
        approver.scope.platform !== requesterPlatform ||
        approver.scope.platformAccountId !== requesterAccount)
    ) {
      await this.rejectDecision('scope_mismatch', existing, approver);
    }

    // True when the requester was never actually verified. Recorded rather
    // than blocked here: the strict posture is Task B4b's, and shipping the
    // record first means the data exists to tell how often it would fire.
    const sodWeak =
      existing.requesterProvenance === 'host_asserted' ||
      existing.requesterProvenance === 'unknown';

    // D-SoD prohibits APPROVING an unverifiable request, not deciding about it.
    // Rejection already demands a verified approver, so refusing a weak row is
    // not an act of trust in its requester — and gating both verbs would leave
    // such rows pending with no operator route to clear them, since
    // `expireStale()` has no production caller.
    if (args.decision === 'approved') {
      await this.enforceRequesterPolicy(existing, sodWeak, approver);
    }

    const decidedAt = new Date().toISOString();
    const result = await this.repo.decideWithAudit(
      {
        tenantId: args.tenantId,
        id: args.id,
        decidedByUserId: approver.userId,
        decision: args.decision,
        decisionReason: args.reason ?? null,
        decidedAt,
      },
      {
        tenant_id: existing.tenantId,
        user_id: approver.userId,
        action: 'governance.approval.decided',
        resource_type: 'governance_approval',
        resource_id: existing.id,
        result: 'success',
        error_message: null,
        old_values: null,
        new_values: null,
        ip_address: null,
        user_agent: null,
        // An OBJECT, not a pre-stringified string. AuditLogRepository.toDbJson
        // passes a string straight through, so stringifying here would store a
        // JSON *string* in the Postgres JSONB column instead of an object —
        // unqueryable by JSONB operators and inconsistent with every other
        // audit writer. On SQLite toDbJson stringifies it anyway.
        details: {
          decision: args.decision,
          requesterProvenance: existing.requesterProvenance,
          sodWeak,
          approverScope: approver.scope,
          approverVerifiedRoles: approver.verifiedRoles,
        },
      },
      this.auditLogs,
    );

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
    if (result.outcome === 'unverified_requester') {
      // Defence in depth: enforceRequesterPolicy above already refuses this for
      // callers that come through the service, so reaching here means the sink
      // caught something the service did not. It must not fall through to the
      // success path, which is exactly what an unhandled outcome would do.
      //
      // It goes through rejectDecision rather than throwing directly, so the
      // audit entry is written first. Copilot round 4: throwing here left the
      // MOST surprising refusal — the one the service policy missed — as the
      // only silent one, which contradicts the "audited, then thrown"
      // guarantee this policy is documented to provide.
      await this.rejectDecision('unverified_requester', result.row, approver);
    }
    if (result.outcome === 'already_decided') {
      throw new AlreadyDecidedError(args.id, result.row.status);
    }

    this.logger.info('approval decided', {
      tenantId: args.tenantId,
      approvalId: args.id,
      decision: args.decision,
      approverUserId: approver.userId,
      requesterProvenance: existing.requesterProvenance,
      sodWeak,
    });

    return result.row;
  }

  /**
   * Audit a refusal, then throw it.
   *
   * Every rejection is recorded before it is raised, so a refused decision is
   * as visible as an accepted one. An attacker probing the gate leaves the same
   * trail as an operator who mis-clicked, and neither is silent.
   *
   * Returns `never`: callers read as a guard, not as something to branch on.
   */
  private async rejectDecision(
    reason: SeparationOfDutiesError['reason'],
    existing: PersistedApproval,
    approver: ApprovalDecider,
  ): Promise<never> {
    await this.auditLogs.create({
      tenant_id: existing.tenantId,
      user_id: approver.userId,
      action: 'governance.approval.decision_rejected',
      resource_type: 'governance_approval',
      resource_id: existing.id,
      result: 'failure',
      error_message: reason,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      // See the success path: an object, so Postgres JSONB stores an object.
      details: {
        reason,
        approverScope: approver.scope,
        approverVerifiedRoles: approver.verifiedRoles,
        requesterProvenance: existing.requesterProvenance,
      },
    });
    throw new SeparationOfDutiesError(reason, existing.id);
  }

  /**
   * Policy on the REQUESTER's provenance: strict (spec §11, decision D-SoD,
   * approved 2026-09-02). Task B4b.
   *
   * A request whose requester was never verified is not approvable. `sodWeak`
   * is B4a's record of exactly that condition — `host_asserted` (the host
   * process asserted an identity and nothing checked it) or `unknown`.
   *
   * ## What this guarantees
   *
   * - **Approval only.** It runs when the decision is `approved`. Refusing an
   *   unverifiable request is not an act of trust in it, `reject()` already
   *   demands a verified approver, and gating both verbs would strand such rows
   *   forever — `expireStale()` has no production caller.
   * - **Defence in depth.** `ApprovalQueueRepository`'s CAS refuses the same
   *   transition inside the `UPDATE` itself, so a caller holding the repository
   *   cannot get round this method. Its weak-provenance list must stay identical
   *   to `sodWeak` above; a test asserts the two agree.
   * - **Not overridable.** This method is `private`.
   * - **Unconditional.** It reads no tenant configuration, so no setting can
   *   re-enable approval of an unverified requester; a config-gated version
   *   would be a different decision. The test spies all eight read methods on
   *   `TenantConfigurationRepository`.
   * - **Audited, then thrown.** `rejectDecision` writes the
   *   `governance.approval.decision_rejected` entry before throwing, so blocked
   *   attempts stay visible. Field names differ by path: a decision that goes
   *   through — approved *or* rejected — records `sodWeak` in its success audit,
   *   while a blocked one records reason `unverified_requester` plus the
   *   `requesterProvenance` that caused it.
   *
   * ## What it does not guarantee
   *
   * **Provenance is a label the enqueue caller supplies, not something this
   * layer verifies.** Omitting it reads as `unknown` and is refused, but an
   * in-process caller that affirmatively passes `'jwt'` is believed. Production
   * paths derive the value at trusted boundaries (`FlowExecutor`,
   * `approvalQueueErrorHandler`, the route-layer `guardedWrite` callers), and
   * nine call sites that thread a user id from elsewhere deliberately assert
   * nothing — their rows are not approvable until their callers can say how the
   * requester was identified. Closing this properly needs an attestation rather
   * than an enum, which is a larger change than this task.
   */
  private async enforceRequesterPolicy(
    existing: PersistedApproval,
    sodWeak: boolean,
    approver: ApprovalDecider,
  ): Promise<void> {
    if (sodWeak) {
      await this.rejectDecision('unverified_requester', existing, approver);
    }
  }
}
