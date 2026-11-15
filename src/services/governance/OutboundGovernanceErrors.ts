import type { OutboundDecision } from './OutboundGovernanceService';

export class GovernanceBlockedError extends Error {
  constructor(public readonly decision: OutboundDecision<unknown>) {
    // Generic message — block reasons span high-risk PII, strict-mode PII of any
    // severity, oversize payloads, and fail-safe scanner failures (findings may be
    // empty in those last two). Callers should read decision.riskLevel /
    // decision.findings / decision.auditMetadata for the specific cause.
    super('Request blocked by outbound governance policy.');
    this.name = 'GovernanceBlockedError';
  }
}

export class PendingApprovalError extends Error {
  constructor(public readonly decision: OutboundDecision<unknown>) {
    super('Request queued for human approval due to outbound governance policy.');
    this.name = 'PendingApprovalError';
  }
}

export function isProviderGovernanceError(error: unknown): error is GovernanceBlockedError | PendingApprovalError {
  return error instanceof GovernanceBlockedError || error instanceof PendingApprovalError;
}
