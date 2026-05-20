// Typed errors for the HITL approval queue (PR 3A).
//
// Each class carries a `readonly code` for stable route-layer mapping:
//   - InvalidDecisionError      → caller misuse; ApprovalQueueService throws
//                                 when enqueue() is called with a decision
//                                 whose approvalRequired is false.
//   - UnredactedPayloadError    → upstream-invariant violation; the DLP scan
//                                 found PII (approvalRequired=true) but did
//                                 NOT actually produce a redacted form. Maps
//                                 to route 500 (fail-closed) — refusing to
//                                 persist raw PII is the only safe option.
//   - ApprovalNotFoundError     → route 404
//   - AlreadyDecidedError       → route 409
//   - ApprovalExpiredError      → route 410 (caller must re-issue per Q5)
//
// Route mapping lives in PR 3B; PR 3A's role is to ship the typed classes
// the service throws so the route can pattern-match without parsing
// err.message (per [[feedback-copilot-typed-error-pressure]]).

/**
 * Thrown by `ApprovalQueueService.enqueue` when called with an `OutboundDecision`
 * whose `approvalRequired` is false. This is a caller-misuse error — callers
 * should only enqueue decisions that the governance layer already classified
 * as requiring human approval.
 */
export class InvalidDecisionError extends Error {
  readonly code = 'invalid_decision';
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}

/**
 * Thrown by `ApprovalQueueService.enqueue` when the inbound `OutboundDecision`
 * has `approvalRequired === true` but `auditMetadata.redacted !== true` —
 * meaning the DLP scan detected PII but did NOT produce a redacted form, so
 * `decision.redactedPayload` is actually the original (unredacted) payload.
 *
 * `OutboundGovernanceService` falls back to the original payload when
 * `scanResult.redactedData` is missing (`redactedPayload = scanResult.redactedData ?? payload`).
 * Without this guard, queue-mode would persist raw PII into `governance_approvals`,
 * violating the spec §3 acceptance gate "No raw PII in approval records."
 *
 * The contract is fail-closed: refuse to persist rather than silently store
 * unredacted PII. Route layer (PR 3B) should map this to a 500 fail-closed
 * response — the same posture used by `OutboundGovernanceService` for scan
 * failures (Copilot R2 on PR #819).
 */
export class UnredactedPayloadError extends Error {
  readonly code = 'unredacted_payload';
  constructor(message: string) {
    super(message);
    this.name = 'UnredactedPayloadError';
  }
}

/**
 * Thrown by `ApprovalQueueService` decide/get verbs when the approval id is
 * unknown OR belongs to a different tenant. Tenant-mismatch is collapsed to
 * not-found by design (no information leak about cross-tenant existence).
 */
export class ApprovalNotFoundError extends Error {
  readonly code = 'approval_not_found';
  constructor(id: string) {
    super(`approval not found: ${id}`);
    this.name = 'ApprovalNotFoundError';
  }
}

/**
 * Thrown by `ApprovalQueueService.approve` / `.reject` when the approval row
 * has already been decided by another operator — `currentStatus` is one of
 * 'approved' or 'rejected'. Maps to route 409 in PR 3B.
 *
 * NOTE: 'expired' is NOT covered by this class. Expired rows (whether the
 * sweeper has run or not) raise `ApprovalExpiredError` which maps to 410.
 * The `decide()` repository method routes both pre-sweep and post-sweep
 * expired rows to the 'expired' outcome (Copilot R4 on PR #819).
 *
 * `currentStatus` is intentionally narrowed to `'approved' | 'rejected'`
 * via `AlreadyDecidedStatus` so the compiler enforces that 'expired' /
 * 'pending' can never accidentally flow into a 409 path. The narrowed
 * `AlreadyDecidedRow` variant on `DecideOutcome` carries the same
 * invariant up to the service layer (Copilot R5 + R6 on PR #819).
 */
export type AlreadyDecidedStatus = 'approved' | 'rejected';

export class AlreadyDecidedError extends Error {
  readonly code = 'already_decided';
  constructor(id: string, public readonly currentStatus: AlreadyDecidedStatus) {
    super(`approval ${id} already in terminal status: ${currentStatus}`);
    this.name = 'AlreadyDecidedError';
  }
}

/**
 * Reserved for the expiration path. PR 3A's `expireStale` job does NOT throw
 * this — it just transitions rows from pending → expired in bulk. The class
 * exists for callers (PR 3B route handlers; PR 3C operator API) that need to
 * surface "you tried to act on an expired approval" cleanly.
 */
export class ApprovalExpiredError extends Error {
  readonly code = 'approval_expired';
  constructor(id: string) {
    super(`approval ${id} has expired`);
    this.name = 'ApprovalExpiredError';
  }
}
