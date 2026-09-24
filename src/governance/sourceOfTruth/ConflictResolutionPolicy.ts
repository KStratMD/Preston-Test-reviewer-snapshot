import type { CanonicalEntity, ConflictPolicy, SourceSystem, CallerSystem } from './SourceOfTruthManifest';

/**
 * Base class for all write-block errors thrown by guardedWrite or
 * OwnershipResolver. Middleware checks `instanceof WriteBlockedError`
 * once and maps to 409 with body { error: <subclass.code>, ...detail }.
 */
export abstract class WriteBlockedError extends Error {
  abstract readonly code:
    | 'ownership_violation'
    | 'ownership_blocked'
    | 'ownership_field_level_merge_blocked'
    | 'loop_detected'
    | 'queue_for_human_not_yet_safe';
  abstract readonly detail: Record<string, unknown>;
}

/**
 * Thrown by OwnershipResolver.validateWrite when the manifest entry's
 * conflictPolicy is 'reject_with_alert'. FlowExecutor's dedicated catch
 * translates this into a FlowBlockedResult with reason: 'ownership'.
 *
 * Carries the full decision context so the FlowResult shape can pin
 * declaredOwner/callerSystem/policy/fieldPath without losing data to the
 * Error.message string.
 */
export class OwnershipViolationError extends WriteBlockedError {
  readonly code = 'ownership_violation' as const;
  readonly detail: {
    entity: CanonicalEntity | string;
    declaredOwner: SourceSystem;
    callerSystem: CallerSystem;
    conflictPolicy: ConflictPolicy;
    fieldPath?: string;
    correlationId: string;
  };
  constructor(detail: OwnershipViolationError['detail']) {
    super(
      `OwnershipViolation: caller='${detail.callerSystem}' attempted to write '${detail.entity}' owned by '${detail.declaredOwner}' (policy='${detail.conflictPolicy}')`,
    );
    this.name = 'OwnershipViolationError';
    this.detail = detail;
  }
}

/**
 * Thrown by guardedWrite when a non-owner write is blocked by the manifest's
 * source_wins or target_wins policy (i.e., write is silently suppressed or
 * redirected). Distinct from OwnershipViolationError (reject_with_alert).
 */
export class OwnershipBlockedError extends WriteBlockedError {
  readonly code = 'ownership_blocked' as const;
  readonly detail: {
    entity: CanonicalEntity | string;
    declaredOwner: SourceSystem;
    callerSystem: CallerSystem;
    policy: 'source_wins';
    correlationId: string;
  };
  constructor(detail: OwnershipBlockedError['detail']) {
    super(
      `OwnershipBlocked: caller='${detail.callerSystem}' write to '${detail.entity}' blocked by policy='${detail.policy}' (owner='${detail.declaredOwner}')`,
    );
    this.name = 'OwnershipBlockedError';
    this.detail = detail;
  }
}

/**
 * Thrown by guardedWrite when merge_field_level cannot safely dispatch a
 * non-owner update. The detail carries field names only, never field values.
 */
export class OwnershipFieldLevelMergeBlockedError extends WriteBlockedError {
  readonly code = 'ownership_field_level_merge_blocked' as const;
  readonly detail: {
    entity: CanonicalEntity | string;
    declaredOwner: SourceSystem;
    callerSystem: CallerSystem;
    policy: 'merge_field_level';
    correlationId: string;
    allowedFieldPaths: string[];
    blockedFieldPaths: string[];
  };
  constructor(detail: OwnershipFieldLevelMergeBlockedError['detail']) {
    super(
      `OwnershipFieldLevelMergeBlocked: caller='${detail.callerSystem}' write to '${detail.entity}' blocked by policy='${detail.policy}' (owner='${detail.declaredOwner}', blockedFields=${detail.blockedFieldPaths.join(',')})`,
    );
    this.name = 'OwnershipFieldLevelMergeBlockedError';
    this.detail = detail;
  }
}

/**
 * Thrown by guardedWrite when a reciprocal-write loop is detected within the
 * configured window. Carries the breakingCondition from the manifest entry's
 * knownLoops so the caller can surface it in audit logs and UI.
 */
export class LoopDetectedError extends WriteBlockedError {
  readonly code = 'loop_detected' as const;
  readonly detail: {
    entity: CanonicalEntity | string;
    callerSystem: SourceSystem;
    targetSystem: SourceSystem;
    breakingCondition: string;
    correlationId: string;
  };
  constructor(detail: LoopDetectedError['detail']) {
    super(
      `LoopDetected: caller='${detail.callerSystem}' → target='${detail.targetSystem}' on entity='${detail.entity}'; breakingCondition: ${detail.breakingCondition}`,
    );
    this.name = 'LoopDetectedError';
    this.detail = detail;
  }
}

/**
 * Historical fail-closed marker from PR 13b. PR 13c-2 Task 3 lifted the
 * fail-closed by encrypting `WriteDescriptor.args` via the global
 * `EncryptionService` before persisting into
 * `governance_approvals.write_descriptor`, so `guardedWrite` no longer
 * throws this error. It is retained as part of the `WriteBlockedError`
 * hierarchy + `FlowExecutor` catch surface for any future code path that
 * wants to fail-closed defensively (e.g. an emergency operator command
 * that disables the encrypted-args path).
 *
 * Continues to map to 409 via `approvalQueueErrorHandler`.
 */
export class QueueForHumanNotYetSafeError extends WriteBlockedError {
  readonly code = 'queue_for_human_not_yet_safe' as const;
  readonly detail: {
    entity: CanonicalEntity | string;
    declaredOwner: SourceSystem;
    callerSystem: CallerSystem;
    correlationId: string;
  };
  constructor(detail: QueueForHumanNotYetSafeError['detail']) {
    super(
      `QueueForHumanNotYetSafe: caller='${detail.callerSystem}' write to '${detail.entity}' would queue for human approval; deferred to PR 13c pending DLP-safe descriptor storage`,
    );
    this.name = 'QueueForHumanNotYetSafeError';
    this.detail = detail;
  }
}

/**
 * Thrown by guardedWrite when the queue_for_human policy fires and the
 * write has been enqueued for human approval. Callers (FlowExecutor, routes)
 * catch this to return 202 with the pendingApprovalId. NOT a WriteBlockedError
 * — the write is in progress (pending), not hard-blocked.
 *
 * Carries the queueId (the governance_approvals row id) so callers can
 * build the pollUrl without a second DB read.
 *
 * PR 13c-2 Task 3 made this the load-bearing throw on the queue path —
 * ApprovalQueueService.enqueue persists the encrypted descriptor and
 * returns the queueId, which guardedWrite wraps into this error.
 */
export class OwnershipPendingApprovalError extends Error {
  constructor(public readonly queueId: string) {
    super(`Write queued for human approval (queueId=${queueId})`);
    this.name = 'OwnershipPendingApprovalError';
  }
}

/**
 * Thrown by guardedWrite when the queue_for_human policy fires but the
 * caller did not provide a resume descriptor. NOT a WriteBlockedError —
 * this is a caller-side programming error (missing argument), not a
 * policy-enforcement block.
 */
export class MissingWriteDescriptorError extends Error {
  constructor(public readonly correlationId: string) {
    super(
      `MissingWriteDescriptor: queue_for_human policy fired but caller did not provide a resume descriptor (correlationId=${correlationId})`,
    );
    this.name = 'MissingWriteDescriptorError';
  }
}

/**
 * Thrown by OwnershipResolver.validateWrite when a manifest entry uses a
 * ConflictPolicy that is declared in the type but not yet implemented.
 * Defense-in-depth: the CI gate is the primary tripwire and should block
 * this manifest shape from reaching production.
 */
export class PolicyNotYetImplementedError extends Error {
  constructor(public readonly policy: ConflictPolicy) {
    super(
      `ConflictPolicy '${policy}' is declared in the enum but not yet implemented. ` +
        `Add runtime support before enabling it in SOURCE_OF_TRUTH_MANIFEST.`
    );
    this.name = 'PolicyNotYetImplementedError';
  }
}
