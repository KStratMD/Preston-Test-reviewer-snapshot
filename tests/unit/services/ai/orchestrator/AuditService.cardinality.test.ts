import { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { AuditLogRepository } from '../../../../../src/database/repositories/AuditLogRepository';
import type { OutboundGovernanceService } from '../../../../../src/services/governance/OutboundGovernanceService';
import type { NewAuditLog } from '../../../../../src/database/types';

/**
 * Focused tests for the cardinality activation audit surface added in Task 6
 * (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md,
 * "Activation semantics" + "Audited override"). Mirrors the manual-mock idiom
 * in AuditService.logGovernanceCheck.test.ts: a fake repository + a
 * pass-through outbound-governance stub so persisted row shape can be
 * asserted directly instead of round-tripping a real DB.
 */
describe('AuditService cardinality activation audits', () => {
  let svc: AuditService;
  let mockLogger: Logger;
  let mockRepo: jest.Mocked<Pick<AuditLogRepository, 'create'>>;
  let mockOutbound: jest.Mocked<Pick<OutboundGovernanceService, 'validateAuditLogPayload'>>;

  beforeEach(() => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
    mockRepo = { create: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<Pick<AuditLogRepository, 'create'>>;
    mockOutbound = {
      validateAuditLogPayload: jest.fn().mockImplementation((payload: unknown) =>
        Promise.resolve({
          approved: true,
          approvalRequired: false,
          redactedPayload: payload,
          findings: [],
          riskLevel: 'none' as const,
          auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
        }),
      ),
    } as unknown as jest.Mocked<Pick<OutboundGovernanceService, 'validateAuditLogPayload'>>;
    svc = new AuditService(
      mockLogger,
      mockRepo as unknown as AuditLogRepository,
      mockOutbound as unknown as OutboundGovernanceService,
      { startCleanupTimer: false },
    );
  });

  function lastRow(): NewAuditLog {
    const calls = mockRepo.create.mock.calls;
    return calls[calls.length - 1][0];
  }

  describe('logCardinalityDecision', () => {
    it('writes one decision row per direction with verified actor/tenant/correlation', async () => {
      await svc.logCardinalityDecision({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-1',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-forward',
        findingKeys: ['relationship_flatten|source_to_target|contacts|0'],
        decision: 'blocked',
      });
      await svc.logCardinalityDecision({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-1',
        configurationId: 'config-1',
        direction: 'target_to_source',
        reportFingerprint: 'fp-reverse',
        findingKeys: [],
        decision: 'allowed',
      });

      expect(mockRepo.create).toHaveBeenCalledTimes(2);

      const [forwardRow, reverseRow] = mockRepo.create.mock.calls.map((call) => call[0]);
      expect(forwardRow.action).toBe('cardinality_activation_decision');
      expect(reverseRow.action).toBe('cardinality_activation_decision');
      expect(forwardRow.tenant_id).toBe('tenant-a');
      expect(forwardRow.user_id).toBe('user-a');

      expect(forwardRow.details).toMatchObject({
        event: {
          details: {
            correlationId: 'corr-1',
            direction: 'source_to_target',
            reportFingerprint: 'fp-forward',
            findingKeys: ['relationship_flatten|source_to_target|contacts|0'],
            decision: 'blocked',
          },
        },
      });
      expect(reverseRow.details).toMatchObject({
        event: {
          details: {
            direction: 'target_to_source',
            reportFingerprint: 'fp-reverse',
            decision: 'allowed',
          },
        },
      });
    });

    it('carries override reason and scope only when an override is involved', async () => {
      await svc.logCardinalityDecision({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-2',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        findingKeys: ['relationship_evidence_unavailable|source_to_target|Account|0'],
        decision: 'overridden',
        override: {
          reason: 'Connector cannot supply relationship evidence; reviewed manually.',
          scope: ['relationship_evidence_unavailable|source_to_target|Account|0'],
        },
      });

      const row = lastRow();
      expect(row.details).toMatchObject({
        event: {
          details: {
            decision: 'overridden',
            override: {
              reason: 'Connector cannot supply relationship evidence; reviewed manually.',
              scope: ['relationship_evidence_unavailable|source_to_target|Account|0'],
            },
          },
        },
      });

      const noOverrideRow = await (async () => {
        await svc.logCardinalityDecision({
          tenantId: 'tenant-a',
          actorUserId: 'user-a',
          correlationId: 'corr-3',
          configurationId: 'config-1',
          direction: 'source_to_target',
          reportFingerprint: 'fp-2',
          findingKeys: [],
          decision: 'allowed',
        });
        return lastRow();
      })();
      const detailsWithoutOverride = (noOverrideRow.details as { event: { details: Record<string, unknown> } }).event.details;
      expect(detailsWithoutOverride).not.toHaveProperty('override');
    });

    it('decision success means the policy decision was recorded, not that any disk save succeeded', async () => {
      await svc.logCardinalityDecision({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-4',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        findingKeys: ['relationship_flatten|source_to_target|contacts|0'],
        decision: 'blocked',
      });

      const row = lastRow();
      // The row's own result/outcome reflects that the AUDIT WRITE succeeded,
      // even though the policy decision itself was a block.
      expect(row.result).toBe('success');
    });

    it('rejects (does not swallow) when the underlying persistence call fails, so activation can be refused', async () => {
      mockRepo.create.mockRejectedValueOnce(new Error('db unavailable'));

      await expect(
        svc.logCardinalityDecision({
          tenantId: 'tenant-a',
          actorUserId: 'user-a',
          correlationId: 'corr-5',
          configurationId: 'config-1',
          direction: 'source_to_target',
          reportFingerprint: 'fp-1',
          findingKeys: ['relationship_flatten|source_to_target|contacts|0'],
          decision: 'blocked',
        }),
      ).rejects.toThrow('db unavailable');
    });

    it('never includes a samples-shaped field in the persisted decision payload', async () => {
      await svc.logCardinalityDecision({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-6',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        findingKeys: [],
        decision: 'allowed',
      });

      const row = lastRow();
      const details = (row.details as { event: { details: Record<string, unknown> } }).event.details;
      expect(Object.keys(details).sort()).toEqual(
        ['correlationId', 'decision', 'direction', 'findingKeys', 'reportFingerprint'].sort(),
      );
    });
  });

  describe('logCardinalityOutcome', () => {
    it('writes a separate succeeded outcome row', async () => {
      await svc.logCardinalityOutcome({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-7',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        outcome: 'succeeded',
      });

      const row = lastRow();
      expect(row.action).toBe('cardinality_activation_outcome');
      expect(row.result).toBe('success');
      expect(row.details).toMatchObject({
        event: { details: { outcome: 'succeeded', direction: 'source_to_target' } },
      });
    });

    it('writes a separate failed outcome row, distinct from the decision row', async () => {
      await svc.logCardinalityOutcome({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-8',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        outcome: 'failed',
        reason: 'disk_write_rejected',
      });

      const row = lastRow();
      expect(row.action).toBe('cardinality_activation_outcome');
      expect(row.result).toBe('failure');
      expect(row.error_message).toBe('disk_write_rejected');
    });

    it('succeeded and failed outcomes for the same config/direction produce two independent rows', async () => {
      await svc.logCardinalityOutcome({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-9',
        configurationId: 'config-1',
        direction: 'source_to_target',
        reportFingerprint: 'fp-1',
        outcome: 'succeeded',
      });
      await svc.logCardinalityOutcome({
        tenantId: 'tenant-a',
        actorUserId: 'user-a',
        correlationId: 'corr-9',
        configurationId: 'config-1',
        direction: 'target_to_source',
        reportFingerprint: 'fp-2',
        outcome: 'failed',
        reason: 'disk_write_rejected',
      });

      expect(mockRepo.create).toHaveBeenCalledTimes(2);
      const [succeededRow, failedRow] = mockRepo.create.mock.calls.map((call) => call[0]);
      expect(succeededRow.id).not.toBe(failedRow.id);
      expect(succeededRow.result).toBe('success');
      expect(failedRow.result).toBe('failure');
    });
  });
});
