/**
 * PR 13b — Task 29: AuditService.queryGovernanceChecks unit tests.
 *
 * Read-only operator-dashboard accessor. Filters governance_check audit rows
 * by tenant + checkType + time window. Bypasses queryAuditLogs because:
 *   1. AuditQuery has no tenantId field.
 *   2. The hydrated AuditLog drops the persistence-row tenant_id.
 * Both gaps are by design for the older queryAuditLogs surface; this method
 * pushes the tenantIds filter down to AuditLogRepository.findByAuditFilters
 * which DOES accept it, then post-filters in TS for the checkType + approved
 * fields that live inside the hydrated `event.details` and `outcome.success`.
 *
 * Seven scenarios exercise the public contract:
 *   1. tenantIds is pushed down to the repo (not just post-filtered).
 *   2. checkType='ownership' returns only ownership rows.
 *   3. checkType='loop_detection' returns only loop rows.
 *   4. since is pushed down as startDate.
 *   5. approved=false filters out approved rows.
 *   6. limit defaults to 200 when omitted; explicit values are pushed down.
 *   7. Empty repo result returns [].
 *
 * The seeded repo rows match the persisted-AI-audit-envelope shape that
 * `AuditService.storeAuditLog` writes via `buildPersistedAIAuditDetails` —
 * `{schemaVersion:1, source:'ai-orchestrator-audit-service', sessionId,
 * event, context, outcome, compliance, retention, auditDlp}`. Anything else
 * fails the `isAIAuditRow` filter and would be invisible to this method.
 */

import { AuditService } from '../../../../../src/services/ai/orchestrator/AuditService';
import type { Logger } from '../../../../../src/utils/Logger';
import type { AuditLogRepository } from '../../../../../src/database/repositories/AuditLogRepository';
import type { OutboundGovernanceService } from '../../../../../src/services/governance/OutboundGovernanceService';
import type { AuditLog as PersistedRow } from '../../../../../src/database/types';

type Repo = jest.Mocked<Pick<AuditLogRepository, 'findByAuditFilters' | 'create'>>;
type Outbound = jest.Mocked<Pick<OutboundGovernanceService, 'validateAuditLogPayload'>>;

interface SeedOpts {
  id: string;
  tenantId: string;
  sessionId: string;
  checkType: 'ownership' | 'loop_detection' | 'input' | 'output';
  approved: boolean;
  timestamp?: Date;
  ownership?: Record<string, unknown>;
}

/**
 * Construct a persisted audit_logs row whose `details` column matches the
 * shape `buildPersistedAIAuditDetails` writes. `isAIAuditRow` checks
 * `schemaVersion===1 && source==='ai-orchestrator-audit-service'` — both must
 * be present or `hydrateAIAuditLog` falls back to the data-access shape and
 * the event.type is wrong.
 */
function seedRow(opts: SeedOpts): PersistedRow {
  const ts = opts.timestamp ?? new Date('2026-05-20T00:00:00Z');
  return {
    id: opts.id,
    tenant_id: opts.tenantId,
    user_id: '__system__',
    action: `validate_${opts.checkType}`,
    resource_type: 'governance_service',
    resource_id: opts.sessionId,
    old_values: null,
    new_values: null,
    details: {
      schemaVersion: 1,
      source: 'ai-orchestrator-audit-service',
      sessionId: opts.sessionId,
      event: {
        type: 'governance_check',
        action: `validate_${opts.checkType}`,
        resource: 'governance_service',
        details: {
          checkType: opts.checkType,
          approved: opts.approved,
          ...(opts.ownership ? { ownership: opts.ownership } : {}),
        },
      },
      context: { agents: [], cost: 0, executionTime: 0, dataClassification: 'internal' },
      outcome: {
        success: opts.approved,
        resultSummary: `Governance ${opts.checkType} check: ${opts.approved ? 'approved' : 'rejected'}`,
        riskLevel: opts.approved ? 'low' : 'medium',
        governanceFlags: [],
        errors: opts.approved ? [] : ['rejected'],
        warnings: [],
      },
      compliance: {
        regulation: ['SOX', 'GDPR'],
        retentionRequired: true,
        encryptionRequired: false,
        anonymizationRequired: false,
        approvalRequired: false,
      },
      retention: {
        retentionPeriod: 180,
        purgeDate: new Date(ts.getTime() + 180 * 86400 * 1000).toISOString(),
        archiveRequired: false,
        legalHold: false,
      },
      auditDlp: {
        approved: true,
        approvalRequired: false,
        riskLevel: 'none',
        findings: [],
        redacted: false,
        blocked: false,
        omittedRawDetails: false,
      },
    },
    result: opts.approved ? 'success' : 'failure',
    error_message: null,
    duration_ms: 0,
    ip_address: null,
    user_agent: null,
    created_at: ts.toISOString(),
  } as PersistedRow;
}

describe('AuditService.queryGovernanceChecks', () => {
  let svc: AuditService;
  let mockLogger: Logger;
  let mockRepo: Repo;
  let mockOutbound: Outbound;

  beforeEach(() => {
    mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;
    mockRepo = {
      findByAuditFilters: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue(undefined),
    } as never;
    mockOutbound = {
      validateAuditLogPayload: jest.fn(),
    } as never;
    svc = new AuditService(
      mockLogger,
      mockRepo as unknown as AuditLogRepository,
      mockOutbound as unknown as OutboundGovernanceService,
      { startCleanupTimer: false },
    );
  });

  it('pushes tenantIds:[filter.tenantId] down to the repository', async () => {
    const since = new Date('2026-05-19T00:00:00Z');
    await svc.queryGovernanceChecks({
      tenantId: 'tenant-a',
      checkType: 'ownership',
      since,
    });
    expect(mockRepo.findByAuditFilters).toHaveBeenCalledTimes(1);
    const args = mockRepo.findByAuditFilters.mock.calls[0][0];
    expect(args.tenantIds).toEqual(['tenant-a']);
  });

  it("filters checkType='ownership' to ownership rows only", async () => {
    mockRepo.findByAuditFilters.mockResolvedValueOnce([
      seedRow({ id: 'a1', tenantId: 't1', sessionId: 'cor-1', checkType: 'ownership', approved: false }),
      seedRow({ id: 'a2', tenantId: 't1', sessionId: 'cor-2', checkType: 'ownership', approved: false }),
      seedRow({ id: 'a3', tenantId: 't1', sessionId: 'cor-3', checkType: 'loop_detection', approved: false }),
    ]);
    const out = await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since: new Date('2026-05-19T00:00:00Z'),
    });
    expect(out).toHaveLength(2);
    for (const log of out) {
      expect(log.event.type).toBe('governance_check');
      expect((log.event.details as Record<string, unknown>).checkType).toBe('ownership');
    }
  });

  it("filters checkType='loop_detection' to loop rows only", async () => {
    mockRepo.findByAuditFilters.mockResolvedValueOnce([
      seedRow({ id: 'a1', tenantId: 't1', sessionId: 'cor-1', checkType: 'ownership', approved: false }),
      seedRow({ id: 'a2', tenantId: 't1', sessionId: 'cor-2', checkType: 'loop_detection', approved: false }),
      seedRow({ id: 'a3', tenantId: 't1', sessionId: 'cor-3', checkType: 'loop_detection', approved: false }),
    ]);
    const out = await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'loop_detection',
      since: new Date('2026-05-19T00:00:00Z'),
    });
    expect(out).toHaveLength(2);
    for (const log of out) {
      expect((log.event.details as Record<string, unknown>).checkType).toBe('loop_detection');
    }
  });

  it('pushes `since` down as startDate', async () => {
    const since = new Date('2026-05-15T12:34:56Z');
    await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since,
    });
    const args = mockRepo.findByAuditFilters.mock.calls[0][0];
    expect(args.startDate).toBe(since);
  });

  it('approved=false excludes approved rows', async () => {
    mockRepo.findByAuditFilters.mockResolvedValueOnce([
      seedRow({ id: 'a1', tenantId: 't1', sessionId: 'cor-1', checkType: 'ownership', approved: true }),
      seedRow({ id: 'a2', tenantId: 't1', sessionId: 'cor-2', checkType: 'ownership', approved: false }),
    ]);
    const out = await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since: new Date('2026-05-19T00:00:00Z'),
      approved: false,
    });
    expect(out).toHaveLength(1);
    expect(out[0].outcome.success).toBe(false);
  });

  it('limit defaults to 200 when omitted; explicit values pushed down', async () => {
    await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since: new Date('2026-05-19T00:00:00Z'),
    });
    expect(mockRepo.findByAuditFilters.mock.calls[0][0].limit).toBe(200);

    mockRepo.findByAuditFilters.mockClear();
    await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since: new Date('2026-05-19T00:00:00Z'),
      limit: 50,
    });
    expect(mockRepo.findByAuditFilters.mock.calls[0][0].limit).toBe(50);
  });

  it('returns [] when repo returns no rows', async () => {
    mockRepo.findByAuditFilters.mockResolvedValueOnce([]);
    const out = await svc.queryGovernanceChecks({
      tenantId: 't1',
      checkType: 'ownership',
      since: new Date('2026-05-19T00:00:00Z'),
    });
    expect(out).toEqual([]);
  });
});
