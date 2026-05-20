import type { OutboundGovernanceService } from '../src/services/governance/OutboundGovernanceService';

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
