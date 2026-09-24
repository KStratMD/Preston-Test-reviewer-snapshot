import { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { AuditLogRepository } from '../../../../../src/database/repositories/AuditLogRepository';
import type { OutboundGovernanceService } from '../../../../../src/services/governance/OutboundGovernanceService';

describe('AuditService.logGovernanceCheck (widened)', () => {
  let svc: AuditService;
  let mockLogger: Logger;
  let mockRepo: jest.Mocked<Pick<AuditLogRepository, 'create'>>;
  let mockOutbound: jest.Mocked<Pick<OutboundGovernanceService, 'validateAuditLogPayload'>>;

  beforeEach(() => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
    mockRepo = { create: jest.fn().mockResolvedValue(undefined) } as any;
    mockOutbound = {
      validateAuditLogPayload: jest.fn().mockImplementation((payload: unknown) =>
        Promise.resolve({
          approved: true, approvalRequired: false, redactedPayload: payload, findings: [],
          riskLevel: 'none' as const,
          auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
        })
      ),
    } as any;
    svc = new AuditService(mockLogger, mockRepo as any, mockOutbound as any, { startCleanupTimer: false });
  });

  it('backward-compat: input checkType still works (no ownership field)', async () => {
    const id = await svc.logGovernanceCheck({
      sessionId: 'sess-1', checkType: 'input', approved: true, riskLevel: 'low', flags: [],
    });
    expect(id).toMatch(/^[a-f0-9-]+/);
    expect(mockRepo.create).toHaveBeenCalledTimes(1);
    const row = mockRepo.create.mock.calls[0][0];
    expect(row.action).toBe('validate_input');
  });

  it('ownership checkType persists ownership detail', async () => {
    await svc.logGovernanceCheck({
      sessionId: 'cor-1', checkType: 'ownership', approved: false, riskLevel: 'medium',
      flags: ['ownership_rejected'],
      ownership: {
        entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'salesforce',
        targetSystem: 'netsuite', operation: 'create', policy: 'reject_with_alert',
      },
    });
    const row = mockRepo.create.mock.calls[0][0];
    expect(row.action).toBe('validate_ownership');
    expect(row.details).toMatchObject({ event: { details: { ownership: { entity: 'customer', declaredOwner: 'netsuite' } } } });
  });

  it('loop_detection checkType persists loop detail', async () => {
    await svc.logGovernanceCheck({
      sessionId: 'cor-2', checkType: 'loop_detection', approved: false, riskLevel: 'high',
      flags: ['loop_detected'],
      ownership: {
        entity: 'payment', declaredOwner: 'stripe', callerSystem: 'netsuite',
        targetSystem: 'stripe', operation: 'update',
        loopBreakingCondition: 'audit_logs.action != "sync_back_from_erp"',
      },
    });
    const row = mockRepo.create.mock.calls[0][0];
    expect(row.action).toBe('validate_loop_detection');
  });

  it('ownership row with governanceOverride records override context', async () => {
    await svc.logGovernanceCheck({
      sessionId: 'cor-3', checkType: 'ownership', approved: true, riskLevel: 'high',
      flags: ['governance_override'],
      ownership: {
        entity: 'customer', declaredOwner: 'netsuite', callerSystem: 'operator_action',
        targetSystem: 'hubspot', operation: 'update',
        governanceOverride: { permitted: true, reason: 'fixing typo for tenant T-42', originalPolicy: 'reject_with_alert' },
      },
    });
    const row = mockRepo.create.mock.calls[0][0];
    expect(row.details).toMatchObject({
      event: {
        details: {
          ownership: {
            governanceOverride: { permitted: true, reason: 'fixing typo for tenant T-42', originalPolicy: 'reject_with_alert' },
          },
        },
      },
    });
  });
});
