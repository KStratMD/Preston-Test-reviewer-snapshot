import { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { AuditLogRepository } from '../../../../../src/database/repositories/AuditLogRepository';
import type { OutboundGovernanceService } from '../../../../../src/services/governance/OutboundGovernanceService';

// A2 (defense-in-depth): the constructor must reject a missing
// OutboundGovernanceService at wiring time, mirroring the BaseProvider /
// BaseConnector invariant, so a DI regression cannot silently ship audit rows
// past the egress DLP chokepoint (which would otherwise only fail at persist
// time, deep inside a request).

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
const mockRepo = { create: jest.fn() } as unknown as AuditLogRepository;
const mockOutbound = { validateAuditLogPayload: jest.fn() } as unknown as OutboundGovernanceService;

describe('AuditService constructor guard (A2)', () => {
  it('throws when OutboundGovernanceService is missing', () => {
    expect(
      () => new AuditService(mockLogger, mockRepo, undefined as unknown as OutboundGovernanceService, { startCleanupTimer: false }),
    ).toThrow(/OutboundGovernanceService is required/);
  });

  it('constructs when the dependency is supplied', () => {
    expect(
      () => new AuditService(mockLogger, mockRepo, mockOutbound, { startCleanupTimer: false }),
    ).not.toThrow();
  });
});
