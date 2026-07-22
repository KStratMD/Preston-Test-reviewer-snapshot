import type { OutboundGovernanceService } from '../src/services/governance/OutboundGovernanceService';
import type { OwnershipResolver } from '../src/governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../src/services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../src/services/governance/ApprovalQueueService';

const makeApprovedDecision = (payload: unknown) => Promise.resolve({
  approved: true,
  approvalRequired: false,
  redactedPayload: payload,
  findings: [],
  riskLevel: 'none' as const,
  auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
});

export function createMockOutboundGovernanceService(): jest.Mocked<OutboundGovernanceService> {
  return {
    validateAIProviderRequest: jest.fn().mockImplementation(makeApprovedDecision),
    validateAuditLogPayload: jest.fn().mockImplementation(makeApprovedDecision),
    validateConnectorWrite: jest.fn().mockImplementation(makeApprovedDecision),
  } as unknown as jest.Mocked<OutboundGovernanceService>;
}

/** Always-allow OwnershipResolver stub for tests that don't exercise ownership blocks. */
export function createMockOwnershipResolver(): Pick<OwnershipResolver, 'validateWrite' | 'detectLoop'> {
  return {
    validateWrite: jest.fn().mockResolvedValue({ allowed: true as const, owner: 'netsuite' as const }),
    detectLoop: jest.fn().mockResolvedValue({ loopDetected: false }),
  };
}

/** No-op AuditService stub for tests that don't assert audit log interactions. */
export function createMockAuditService(): Pick<AuditService, 'logGovernanceCheck'> {
  return {
    logGovernanceCheck: jest.fn().mockResolvedValue('test-audit-id'),
  };
}

/**
 * No-op ApprovalQueueService stub for tests that don't exercise the
 * queue_for_human path. Required as the 9th IntegrationService ctor arg
 * and the 6th SyncCentralOrchestrator ctor arg as of PR 13b Stage A2.5.
 */
export function createMockApprovalQueueService(): Pick<ApprovalQueueService, 'enqueue'> {
  return {
    enqueue: jest.fn().mockResolvedValue('q-id'),
  };
}
