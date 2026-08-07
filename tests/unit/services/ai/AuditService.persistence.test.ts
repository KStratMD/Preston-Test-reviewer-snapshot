import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { Database } from '../../../../src/database/types';
import { migration as createAuditLogs } from '../../../../src/database/migrations/006-create-audit-logs-table';
import { migration as hardenAuditLogs } from '../../../../src/database/migrations/031-harden-audit-logs-for-persistence';
import { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';
import { createMockOutboundGovernanceService } from '../../../governanceTestUtils';

function makeLogger() {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

async function makeHarness() {
  const db = makeDb();
  await createAuditLogs.run(db, 'sqlite');
  await hardenAuditLogs.run(db, 'sqlite');
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  const repo = new AuditLogRepository(databaseService);
  const outbound = createMockOutboundGovernanceService();
  const logger = makeLogger();
  const service = new AuditService(logger as never, repo, outbound, { startCleanupTimer: false });
  return { db, repo, outbound, logger, service };
}

describe('AI AuditService persistence', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('persists orchestrator executions and can read them through a new service instance', async () => {
    const { db, repo, outbound, logger, service } = await makeHarness();
    try {
      const auditId = await service.logOrchestratorExecution({
        tenantId: 'tenant-a',
        sessionId: 'session-a',
        userId: 'user-a',
        agents: ['field-mapping'],
        success: true,
        cost: 0.12,
        executionTime: 345,
        governanceFlags: [],
      });

      const restarted = new AuditService(logger as never, repo, outbound, { startCleanupTimer: false });
      const logs = await restarted.queryAuditLogs({ sessionIds: ['session-a'] });

      expect(logs).toHaveLength(1);
      expect(logs[0].id).toBe(auditId);
      expect(logs[0].sessionId).toBe('session-a');
      expect(logs[0].context.cost).toBe(0.12);
    } finally {
      await db.destroy();
    }
  });

  it('writes a non-null system tenant when caller has no tenant id', async () => {
    const { db, repo, service } = await makeHarness();
    try {
      await service.logOrchestratorError({
        sessionId: 'session-system',
        error: 'boom',
        agents: ['agent-a'],
      });

      const rows = await repo.findByAuditFilters({ sessionIds: ['session-system'] });
      expect(rows[0].tenant_id).toBe('__system__');
    } finally {
      await db.destroy();
    }
  });

  it('computes statistics from persisted rows', async () => {
    const { db, service } = await makeHarness();
    try {
      await service.logOrchestratorExecution({
        tenantId: 'tenant-a',
        sessionId: 'stats-1',
        agents: ['a'],
        success: true,
        cost: 0.01,
        executionTime: 10,
      });
      await service.logOrchestratorError({
        tenantId: 'tenant-a',
        sessionId: 'stats-2',
        error: 'failed',
        agents: ['a'],
      });

      const stats = await service.getAuditStatistics();
      expect(stats.totalLogs).toBe(2);
      expect(stats.logsByType.orchestrator_execution).toBe(1);
      expect(stats.logsByType.error_event).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it('redacts audit details before persistence', async () => {
    const { db, repo, outbound, service } = await makeHarness();
    try {
      outbound.validateAuditLogPayload.mockResolvedValueOnce({
        approved: true,
        approvalRequired: false,
        redactedPayload: { email: '[REDACTED]' },
        findings: ['email'],
        riskLevel: 'low',
        auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: false },
      });

      await service.logGovernanceCheck({
        tenantId: 'tenant-a',
        sessionId: 'dlp-redact',
        checkType: 'input',
        approved: true,
        riskLevel: 'low',
        flags: [],
        reason: 'email a@example.com',
      });

      const rows = await repo.findByAuditFilters({ sessionIds: ['dlp-redact'] });
      const persisted = rows[0].details as {
        event: { details: Record<string, unknown> };
        auditDlp: { redacted: boolean; blocked: boolean };
      };
      expect(persisted.event.details).toEqual({ email: '[REDACTED]' });
      expect(persisted.auditDlp.redacted).toBe(true);
      expect(persisted.auditDlp.blocked).toBe(false);
      expect(outbound.validateAuditLogPayload).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ destination: 'audit_log', destinationDetail: 'audit_logs.details' }),
      );
    } finally {
      await db.destroy();
    }
  });

  it('persists redacted details for blocked audit DLP decisions', async () => {
    const { db, repo, outbound, service } = await makeHarness();
    try {
      outbound.validateAuditLogPayload.mockResolvedValueOnce({
        approved: false,
        approvalRequired: false,
        redactedPayload: { ssn: '[REDACTED]' },
        findings: ['ssn'],
        riskLevel: 'high',
        auditMetadata: { scanDurationMs: 1, findingsCount: 1, redacted: true, blocked: true },
      });

      await service.logDataAccess({
        tenantId: 'tenant-a',
        sessionId: 'dlp-block-redacted',
        dataType: 'customer',
        action: 'write',
        resource: 'customer',
        dataClassification: 'restricted',
      });

      const rows = await repo.findByAuditFilters({ sessionIds: ['dlp-block-redacted'] });
      const persisted = rows[0].details as {
        event: { details: Record<string, unknown> };
        auditDlp: { blocked: boolean; omittedRawDetails: boolean };
      };
      expect(persisted.event.details).toEqual({ ssn: '[REDACTED]' });
      expect(persisted.auditDlp.blocked).toBe(true);
      expect(persisted.auditDlp.omittedRawDetails).toBe(false);
    } finally {
      await db.destroy();
    }
  });

  it('omits raw details when audit DLP blocks without a redacted payload', async () => {
    const { db, repo, outbound, service } = await makeHarness();
    try {
      outbound.validateAuditLogPayload.mockResolvedValueOnce({
        approved: false,
        approvalRequired: false,
        findings: [],
        riskLevel: 'high',
        auditMetadata: { scanDurationMs: 1, findingsCount: 0, redacted: false, blocked: true },
      });

      await service.logGovernanceCheck({
        tenantId: 'tenant-a',
        sessionId: 'dlp-block-omitted',
        checkType: 'input',
        approved: false,
        riskLevel: 'high',
        flags: ['scan_failed'],
        reason: 'raw secret should not persist',
      });

      const rows = await repo.findByAuditFilters({ sessionIds: ['dlp-block-omitted'] });
      const persisted = rows[0].details as {
        event: { details: Record<string, unknown> };
        auditDlp: { omittedRawDetails: boolean };
      };
      expect(persisted.event.details).toEqual({
        omittedByOutboundGovernance: true,
        reason: 'audit_details_unavailable_after_governance_block',
      });
      expect(JSON.stringify(persisted)).not.toContain('raw secret should not persist');
      expect(persisted.auditDlp.omittedRawDetails).toBe(true);
      expect(rows[0].error_message).toBeNull();
    } finally {
      await db.destroy();
    }
  });
});
