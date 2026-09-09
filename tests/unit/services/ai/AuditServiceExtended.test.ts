/**
 * Comprehensive unit tests for AuditService
 * Covers: logOrchestratorExecution, logOrchestratorError, logAgentExecution,
 *         logGovernanceCheck, logDataAccess, queryAuditLogs, generateAuditReport,
 *         getComplianceViolations, updateComplianceRequirement, setRetentionPolicy,
 *         cleanupExpiredLogs, getAuditStatistics
 */
import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import { migration as createAuditLogs } from '../../../../src/database/migrations/006-create-audit-logs-table';
import { migration as hardenAuditLogs } from '../../../../src/database/migrations/031-harden-audit-logs-for-persistence';
import { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import { createMockOutboundGovernanceService } from '../../../governanceTestUtils';
import { AuditService } from '../../../../src/services/ai/orchestrator/AuditService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

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
  return { db, repo, outbound };
}

describe('AuditService', () => {
  let service: AuditService;
  let db: Kysely<Database>;

  beforeEach(async () => {
    jest.clearAllMocks();
    const harness = await makeHarness();
    db = harness.db;
    service = new AuditService(mockLogger, harness.repo, harness.outbound, { startCleanupTimer: false });
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('constructor', () => {
    it('should initialize with default retention policies', () => {
      expect(service).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('Audit service initialized');
    });
  });

  describe('logOrchestratorExecution', () => {
    it('should log successful orchestrator execution', async () => {
      const auditId = await service.logOrchestratorExecution({
        sessionId: 'session-1',
        userId: 'user-1',
        agents: ['agent-a', 'agent-b'],
        success: true,
        cost: 0.1,
        executionTime: 500,
      });
      expect(auditId).toMatch(/^audit_/);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Orchestrator execution audit logged',
        expect.objectContaining({ sessionId: 'session-1' })
      );
    });

    it('should calculate low risk for cheap operations', async () => {
      await service.logOrchestratorExecution({
        sessionId: 's1',
        agents: ['a'],
        success: true,
        cost: 0.01,
        executionTime: 100,
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['s1'] });
      expect(logs[0].outcome.riskLevel).toBe('low');
    });

    it('should calculate higher risk for expensive operations', async () => {
      await service.logOrchestratorExecution({
        sessionId: 's2',
        agents: ['a', 'b', 'c', 'd'],
        success: true,
        cost: 0.6,
        executionTime: 5000,
        governanceFlags: ['pii_detected'],
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['s2'] });
      expect(logs[0].outcome.riskLevel).toBe('high');
    });

    it('should store audit log that can be queried', async () => {
      await service.logOrchestratorExecution({
        sessionId: 'query-test',
        agents: ['a'],
        success: true,
        cost: 0.1,
        executionTime: 200,
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['query-test'] });
      expect(logs.length).toBe(1);
      expect(logs[0].event.type).toBe('orchestrator_execution');
    });
  });

  describe('logOrchestratorError', () => {
    it('should log orchestrator error', async () => {
      const auditId = await service.logOrchestratorError({
        sessionId: 'err-session',
        error: 'Something went wrong',
        agents: ['agent-x'],
      });
      expect(auditId).toMatch(/^audit_/);
      const logs = await service.queryAuditLogs({ sessionIds: ['err-session'] });
      expect(logs[0].outcome.success).toBe(false);
      expect(logs[0].outcome.riskLevel).toBe('high');
      expect(logs[0].outcome.errors).toContain('Something went wrong');
    });
  });

  describe('logAgentExecution', () => {
    it('should log agent execution', async () => {
      const auditId = await service.logAgentExecution({
        sessionId: 'agent-session',
        agentName: 'FieldMappingAgent',
        success: true,
        confidence: 0.9,
        executionTime: 300,
        cost: 0.05,
      });
      expect(auditId).toMatch(/^audit_/);
      const logs = await service.queryAuditLogs({ sessionIds: ['agent-session'] });
      expect(logs[0].event.type).toBe('agent_execution');
      expect(logs[0].event.resource).toBe('FieldMappingAgent');
    });

    it('should assess high risk for low confidence + failure', async () => {
      await service.logAgentExecution({
        sessionId: 'risky-agent',
        agentName: 'BadAgent',
        success: false,
        confidence: 0.2,
        executionTime: 100,
        cost: 0.01,
        governanceFlags: ['content_filtered'],
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['risky-agent'] });
      expect(logs[0].outcome.riskLevel).toBe('high');
    });

    it('should assess low risk for high confidence + success', async () => {
      await service.logAgentExecution({
        sessionId: 'safe-agent',
        agentName: 'GoodAgent',
        success: true,
        confidence: 0.95,
        executionTime: 100,
        cost: 0.01,
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['safe-agent'] });
      expect(logs[0].outcome.riskLevel).toBe('low');
    });
  });

  describe('logGovernanceCheck', () => {
    it('should log approved governance check', async () => {
      const auditId = await service.logGovernanceCheck({
        sessionId: 'gov-session',
        checkType: 'input',
        approved: true,
        riskLevel: 'low',
        flags: [],
      });
      expect(auditId).toMatch(/^audit_/);
      const logs = await service.queryAuditLogs({ sessionIds: ['gov-session'] });
      expect(logs[0].outcome.success).toBe(true);
    });

    it('should log rejected governance check with reason', async () => {
      await service.logGovernanceCheck({
        sessionId: 'gov-reject',
        checkType: 'output',
        approved: false,
        riskLevel: 'high',
        flags: ['pii_detected'],
        reason: 'PII in output',
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['gov-reject'] });
      expect(logs[0].outcome.success).toBe(false);
      expect(logs[0].outcome.errors).toContain('PII in output');
    });

    it('should record compliance violation for PII detection', async () => {
      await service.logGovernanceCheck({
        sessionId: 'pii-session',
        checkType: 'output',
        approved: false,
        riskLevel: 'high',
        flags: ['pii_detected'],
      });
      const violations = service.getComplianceViolations();
      const piiViolation = violations.find(v => v.regulation === 'GDPR');
      expect(piiViolation).toBeDefined();
    });
  });

  describe('logDataAccess', () => {
    it('should log data access', async () => {
      const auditId = await service.logDataAccess({
        sessionId: 'data-session',
        dataType: 'customer',
        action: 'read',
        resource: 'customer_table',
        dataClassification: 'internal',
      });
      expect(auditId).toMatch(/^audit_/);
      const logs = await service.queryAuditLogs({ sessionIds: ['data-session'] });
      expect(logs[0].event.type).toBe('data_access');
    });

    it('should assess high risk for restricted data deletion', async () => {
      await service.logDataAccess({
        sessionId: 'restricted-delete',
        dataType: 'pii',
        action: 'delete',
        resource: 'pii_table',
        dataClassification: 'restricted',
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['restricted-delete'] });
      expect(logs[0].outcome.riskLevel).toBe('high');
    });

    it('should assess low risk for public data read', async () => {
      await service.logDataAccess({
        sessionId: 'public-read',
        dataType: 'config',
        action: 'read',
        resource: 'public_config',
        dataClassification: 'public',
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['public-read'] });
      expect(logs[0].outcome.riskLevel).toBe('low');
    });

    it('should assess medium risk for confidential export', async () => {
      await service.logDataAccess({
        sessionId: 'conf-export',
        dataType: 'reports',
        action: 'export',
        resource: 'reports_table',
        dataClassification: 'confidential',
      });
      const logs = await service.queryAuditLogs({ sessionIds: ['conf-export'] });
      expect(['medium', 'high']).toContain(logs[0].outcome.riskLevel);
    });
  });

  describe('queryAuditLogs', () => {
    beforeEach(async () => {
      await service.logOrchestratorExecution({
        sessionId: 'q1',
        userId: 'user-a',
        agents: ['agent-1'],
        success: true,
        cost: 0.1,
        executionTime: 100,
      });
      await service.logAgentExecution({
        sessionId: 'q2',
        agentName: 'agent-2',
        success: false,
        confidence: 0.5,
        executionTime: 200,
        cost: 0.2,
        userId: 'user-b',
      });
      await service.logOrchestratorError({
        sessionId: 'q3',
        error: 'Error occurred',
        agents: ['agent-3'],
        userId: 'user-a',
      });
    });

    it('should return all logs when no filters', async () => {
      const logs = await service.queryAuditLogs({});
      expect(logs.length).toBe(3);
    });

    it('should filter by sessionIds', async () => {
      const logs = await service.queryAuditLogs({ sessionIds: ['q1'] });
      expect(logs.length).toBe(1);
      expect(logs[0].sessionId).toBe('q1');
    });

    it('should filter by userIds', async () => {
      const logs = await service.queryAuditLogs({ userIds: ['user-a'] });
      expect(logs.length).toBe(2);
    });

    it('should filter by eventTypes', async () => {
      const logs = await service.queryAuditLogs({ eventTypes: ['error_event'] });
      expect(logs.length).toBe(1);
    });

    it('should filter by riskLevels', async () => {
      const logs = await service.queryAuditLogs({ riskLevels: ['high'] });
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter by hasErrors', async () => {
      const logsWithErrors = await service.queryAuditLogs({ hasErrors: true });
      expect(logsWithErrors.length).toBeGreaterThanOrEqual(1);
      for (const log of logsWithErrors) {
        expect(log.outcome.errors.length).toBeGreaterThan(0);
      }
    });

    it('should sort by timestamp desc by default', async () => {
      const logs = await service.queryAuditLogs({});
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(logs[i].timestamp.getTime());
      }
    });

    it('should sort by cost', async () => {
      const logs = await service.queryAuditLogs({ sortBy: 'cost', sortOrder: 'desc' });
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i - 1].context.cost).toBeGreaterThanOrEqual(logs[i].context.cost);
      }
    });

    it('should sort by risk', async () => {
      const logs = await service.queryAuditLogs({ sortBy: 'risk', sortOrder: 'asc' });
      expect(logs.length).toBe(3);
    });

    it('should apply limit', async () => {
      const logs = await service.queryAuditLogs({ limit: 1 });
      expect(logs.length).toBe(1);
    });

    it('should apply offset', async () => {
      const allLogs = await service.queryAuditLogs({});
      const offsetLogs = await service.queryAuditLogs({ offset: 1 });
      expect(offsetLogs.length).toBe(allLogs.length - 1);
    });
  });

  describe('generateAuditReport', () => {
    it('should generate report for period', async () => {
      await service.logOrchestratorExecution({
        sessionId: 'r1',
        agents: ['a'],
        success: true,
        cost: 0.1,
        executionTime: 100,
      });
      const start = new Date(Date.now() - 60000);
      const end = new Date(Date.now() + 60000);
      const report = await service.generateAuditReport({ start, end });
      expect(report).toBeDefined();
      expect(report.summary.totalEvents).toBeGreaterThanOrEqual(1);
      expect(typeof report.summary.successRate).toBe('number');
      expect(typeof report.summary.averageCost).toBe('number');
      expect(report.complianceStatus).toBeDefined();
      expect(typeof report.complianceStatus.overallCompliance).toBe('number');
      expect(report.riskAnalysis).toBeDefined();
      expect(typeof report.riskAnalysis.overallRiskScore).toBe('number');
      expect(Array.isArray(report.recommendations)).toBe(true);
      expect(report.generatedAt).toBeInstanceOf(Date);
    });

    it('should generate recommendations for low success rate', async () => {
      await service.logOrchestratorError({
        sessionId: 'fail-1',
        error: 'fail',
        agents: ['a'],
      });
      const start = new Date(Date.now() - 60000);
      const end = new Date(Date.now() + 60000);
      const report = await service.generateAuditReport({ start, end });
      expect(report.recommendations.some(r => r.includes('reliability'))).toBe(true);
    });
  });

  describe('compliance management', () => {
    it('should get compliance violations', () => {
      const violations = service.getComplianceViolations();
      expect(Array.isArray(violations)).toBe(true);
    });

    it('should update compliance requirement', () => {
      service.updateComplianceRequirement('PCI-DSS', {
        regulation: 'PCI-DSS',
        requirement: 'Card data encryption',
        status: 'compliant',
        evidence: ['AES-256 encryption'],
        lastVerified: new Date(),
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Compliance requirement updated',
        expect.objectContaining({ regulation: 'PCI-DSS' })
      );
    });

    it('should update existing requirement', () => {
      service.updateComplianceRequirement('GDPR', {
        regulation: 'GDPR',
        requirement: 'Data retention limits',
        status: 'non_compliant',
        evidence: [],
        lastVerified: new Date(),
      });
      // Should update the existing one, not add duplicate
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Compliance requirement updated',
        expect.objectContaining({ regulation: 'GDPR', status: 'non_compliant' })
      );
    });
  });

  describe('retention policies', () => {
    it('should set retention policy', () => {
      service.setRetentionPolicy('custom_event', 60);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Retention policy updated',
        { eventType: 'custom_event', retentionDays: 60 }
      );
    });
  });

  describe('cleanupExpiredLogs', () => {
    it('should return 0 when no expired logs', async () => {
      await service.logOrchestratorExecution({
        sessionId: 'recent',
        agents: ['a'],
        success: true,
        cost: 0.1,
        executionTime: 100,
      });
      const cleaned = await service.cleanupExpiredLogs();
      expect(cleaned).toBe(0);
    });
  });

  describe('getAuditStatistics', () => {
    it('should return empty stats when no logs', async () => {
      const stats = await service.getAuditStatistics();
      expect(stats.totalLogs).toBe(0);
      expect(stats.violationsCount).toBe(0);
      expect(stats.averageRiskScore).toBe(0);
      expect(stats.complianceRate).toBe(1);
    });

    it('should return stats after logging', async () => {
      await service.logOrchestratorExecution({
        sessionId: 's1',
        agents: ['a'],
        success: true,
        cost: 0.1,
        executionTime: 100,
      });
      await service.logOrchestratorError({
        sessionId: 's2',
        error: 'err',
        agents: ['b'],
      });
      const stats = await service.getAuditStatistics();
      expect(stats.totalLogs).toBe(2);
      expect(stats.logsByType['orchestrator_execution']).toBe(1);
      expect(stats.logsByType['error_event']).toBe(1);
      expect(stats.complianceRate).toBe(0.5);
    });
  });
});
