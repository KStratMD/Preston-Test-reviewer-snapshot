// HITL approval-queue resume worker (PR 3B).
//
// After an operator approves a queued request (PR 3C's operator API +
// ApprovalQueueService.approve()), this worker re-invokes the original
// action against the redacted payload. Idempotent via the
// `apply_idempotency_key` CAS on the repository — concurrent invocations
// against the same approval row resolve to exactly-one apply (the rest
// return `skipped: 'already_claimed'`).
//
// **Apply-failure semantics (PR 3B intentional trade-off / spec §11
// Tier-C follow-up).** Once `claimForApply` sets `apply_idempotency_key`,
// the CAS is permanent — even if `handler.apply()` then throws, the row
// stays claimed and subsequent `resume()` calls return
// `skipped: 'already_claimed'`. There is **no automatic retry** for
// transient handler failures, and the failure surfaces ONLY in the
// ERROR-level log emitted by the catch (tagged `surface: 'apply_failed'`).
// The spec's risk table explicitly accepts this — operators recover by
// hitting a Tier-C admin endpoint (not yet shipped) to reset the claim
// and re-attempt. A follow-up PR will add an `apply_failed` status column
// + retry policy, but PR 3B's scope is the wiring framework.
//
// Handler dispatch (Q1 from spec §7): a constructor-injected registry maps
// (operationType, resourceType) → an ApprovalResumeHandler. Handlers are
// registered from the inversify composition root after the worker is
// constructed (matches how WorkflowEngineService definitions are registered).
//
// Scope cut for PR 3B: the registry ships EMPTY by default — no production
// handlers (NetSuite-resume, OpenAI-resume, etc.) are wired in this PR.
// Routes will still 202-enqueue correctly; the resume path returns
// `skipped: 'no_handler'` until a follow-up registers concrete handlers.
// The unit-test suite (`ApprovalResumeWorker.test.ts`) registers in-memory
// handlers to prove the dispatch + idempotency CAS + race semantics. The
// PR 3B integration suite covers enqueue → 202 + the operator GET +
// startup guard; the apply-after-approve round-trip lands when a concrete
// handler is registered in a follow-up.

import { injectable, inject } from 'inversify';

import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import type {
  ApprovalOperationType,
  ApprovalQueueRepository,
  PersistedApproval,
} from './ApprovalQueueRepository';

/**
 * A registered handler that knows how to re-invoke the original action for a
 * given (operationType, resourceType) pair. Implementations live alongside
 * the corresponding provider/connector and are bound via the composition root.
 */
export interface ApprovalResumeHandler {
  readonly operationType: ApprovalOperationType;
  readonly resourceType: string;
  /**
   * Re-invoke the original action using the approval's stored redacted_payload.
   * Implementations parse `approval.redactedPayload` (JSON string), look up
   * the tenant's connector/provider as needed, and execute the write.
   *
   * Errors thrown by handler.apply are CAUGHT by the worker and surfaced as
   * `{applied: false, error}` — the worker NEVER lets handler exceptions
   * propagate out (its callers fire-and-forget). Handlers should still log
   * internally for diagnostics.
   */
  apply(approval: PersistedApproval): Promise<unknown>;
}

/**
 * Constructor-injected registry of resume handlers. Singleton-bound; populated
 * once at composition-root time via `register()`. Duplicate registration for
 * the same (operationType, resourceType) pair throws — silently overwriting
 * would mean two providers fighting over the same key.
 */
@injectable()
export class ApprovalResumeRegistry {
  private readonly handlers = new Map<string, ApprovalResumeHandler>();

  register(handler: ApprovalResumeHandler): void {
    const key = ApprovalResumeRegistry.makeKey(handler.operationType, handler.resourceType);
    if (this.handlers.has(key)) {
      throw new Error(
        `ApprovalResumeRegistry: duplicate handler for ${key} (operationType=${handler.operationType}, resourceType=${handler.resourceType})`,
      );
    }
    this.handlers.set(key, handler);
  }

  resolve(
    operationType: ApprovalOperationType,
    resourceType: string,
  ): ApprovalResumeHandler | null {
    return this.handlers.get(ApprovalResumeRegistry.makeKey(operationType, resourceType)) ?? null;
  }

  /** Test/debugging hook: how many handlers are registered. */
  size(): number {
    return this.handlers.size;
  }

  /** Test/debugging hook: list registered keys. */
  registeredKeys(): string[] {
    return Array.from(this.handlers.keys()).sort();
  }

  private static makeKey(operationType: ApprovalOperationType, resourceType: string): string {
    return `${operationType}::${resourceType}`;
  }
}

/**
 * Result of `ApprovalResumeWorker.resume()`. Always returned, never thrown:
 *
 *   - `{applied: true, result}` — handler ran successfully.
 *   - `{applied: false, skipped: 'not_approved'}` — defensive guard; the
 *     approval row's status is not 'approved' so the resume is a no-op.
 *   - `{applied: false, skipped: 'no_handler'}` — no handler registered for
 *     the (operationType, resourceType) pair. Expected when PR 3B ships
 *     before per-provider handler PRs.
 *   - `{applied: false, skipped: 'already_claimed'}` — another worker already
 *     claimed and applied this approval; idempotent skip.
 *   - `{applied: false, error}` — handler threw; the error message is
 *     captured for surface logging.
 */
export type ResumeOutcome =
  | { applied: true; result: unknown }
  | { applied: false; skipped: 'not_approved' }
  | { applied: false; skipped: 'no_handler' }
  | { applied: false; skipped: 'already_claimed' }
  | { applied: false; error: string };

@injectable()
export class ApprovalResumeWorker {
  constructor(
    @inject(TYPES.ApprovalQueueRepository) private readonly repo: ApprovalQueueRepository,
    @inject(TYPES.ApprovalResumeRegistry) private readonly registry: ApprovalResumeRegistry,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  /**
   * Re-invoke the original action for an approved approval. See ResumeOutcome
   * docs for the result shape. NEVER throws — all errors are returned as
   * `{applied: false, error}`.
   *
   * Idempotency: `repo.claimForApply` is the CAS gate. Two concurrent
   * `resume()` calls against the same approval id will see exactly one
   * `claimForApply` return the row; the other returns null and we report
   * `skipped: 'already_claimed'`. The CAS also enforces `status='approved'`
   * so an unapproved row cannot be applied even if the registry-lookup
   * accidentally succeeded.
   *
   * The idempotency key uses the approval id (NOT a timestamp) so two
   * concurrent calls produce the same key — exactly the race we want
   * exactly-one semantics for. Including a timestamp would let both calls
   * write different keys, and the rowcount-based CAS would still gate on
   * `apply_idempotency_key IS NULL` correctly — but using a stable per-row
   * key makes the audit trail readable ("which key claimed this row?") and
   * matches the spec §3 phrase "per-approval idempotency."
   */
  async resume(approval: PersistedApproval): Promise<ResumeOutcome> {
    // Defensive — should be unreachable on the normal path because
    // ApprovalQueueService.approve() only fires this after a successful CAS
    // to 'approved'. Belt + suspenders: explicitly check rather than trust
    // an upstream invariant.
    if (approval.status !== 'approved') {
      this.logger.warn('ApprovalResumeWorker.resume called for non-approved row', {
        approvalId: approval.id,
        status: approval.status,
      });
      return { applied: false, skipped: 'not_approved' };
    }

    const handler = this.registry.resolve(approval.operationType, approval.resourceType);
    if (!handler) {
      this.logger.warn('ApprovalResumeWorker.resume — no handler registered', {
        approvalId: approval.id,
        operationType: approval.operationType,
        resourceType: approval.resourceType,
      });
      return { applied: false, skipped: 'no_handler' };
    }

    const idempotencyKey = `resume::${approval.id}`;
    let claimed: PersistedApproval | null;
    try {
      claimed = await this.repo.claimForApply({
        tenantId: approval.tenantId,
        id: approval.id,
        idempotencyKey,
      });
    } catch (claimErr) {
      // claimForApply itself shouldn't normally throw, but DB-layer issues
      // could surface here. Treat as a transient error → log + return.
      const message = claimErr instanceof Error ? claimErr.message : String(claimErr);
      this.logger.error(
        'ApprovalResumeWorker.resume — claimForApply threw',
        claimErr instanceof Error ? claimErr : new Error(message),
        { approvalId: approval.id },
      );
      return { applied: false, error: message };
    }

    if (!claimed) {
      this.logger.info('ApprovalResumeWorker.resume — claim already taken (idempotent skip)', {
        approvalId: approval.id,
      });
      return { applied: false, skipped: 'already_claimed' };
    }

    try {
      const result = await handler.apply(claimed);
      this.logger.info('ApprovalResumeWorker.resume applied', {
        approvalId: approval.id,
        operationType: approval.operationType,
        resourceType: approval.resourceType,
      });
      return { applied: true, result };
    } catch (applyErr) {
      const message = applyErr instanceof Error ? applyErr.message : String(applyErr);
      // Known design trade-off (Copilot R4 / spec §11 Tier-C follow-up): the
      // CAS claim has already set apply_idempotency_key, so subsequent
      // resume() invocations return `skipped: 'already_claimed'` — there is
      // NO automatic retry path for transient failures, and the failure is
      // only visible in logs (no `apply_failed` status column yet). This
      // matches the spec's stated risk table ("worker re-runs are no-ops;
      // operator manually re-attempts via a Tier-C admin endpoint").
      //
      // We emit a structured ERROR-level log with the full triage triplet
      // (approvalId, operationType, resourceType) plus the claim's tenant
      // so operators can pull failed approvals out of the log pipeline AND
      // correlate them to the audit log's approval-id keyed events. The
      // surface-tag `apply_failed` makes log queries grep-friendly.
      this.logger.error(
        'ApprovalResumeWorker.resume — handler.apply threw (apply_failed; claim persisted, no auto-retry)',
        applyErr instanceof Error ? applyErr : new Error(message),
        {
          surface: 'apply_failed',
          approvalId: approval.id,
          tenantId: approval.tenantId,
          operationType: approval.operationType,
          resourceType: approval.resourceType,
          resourceId: approval.resourceId,
          idempotencyKey,
        },
      );
      return { applied: false, error: message };
    }
  }
}
