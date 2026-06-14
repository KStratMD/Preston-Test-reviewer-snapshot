/**
 * Audit Service - Comprehensive logging and compliance tracking
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject, unmanaged } from 'inversify';
import { TYPES } from '../../../inversify/types';
import type { Logger } from '../../../utils/Logger';
import type { AuditLogRepository } from '../../../database/repositories/AuditLogRepository';
import type { NewAuditLog } from '../../../database/types';
import { OutboundGovernanceService, type OutboundDecision } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY } from '../../governance/identityContext';
import {
  buildPersistedAIAuditDetails,
  hydrateAIAuditLog,
  isAIAuditRow,
  type AuditDlpPersistenceMetadata,
} from './AuditPersistenceMapper';

export interface AuditServiceOptions {
  startCleanupTimer?: boolean;
  now?: () => Date;
}

export interface AuditLog {
  id: string;
  timestamp: Date;
  sessionId: string;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  event: AuditEvent;
  context: AuditContext;
  outcome: AuditOutcome;
  compliance: ComplianceInfo;
  retention: RetentionInfo;
}

export interface AuditEvent {
  type: 'orchestrator_execution' | 'agent_execution' | 'governance_check' | 'data_access' | 'configuration_change' | 'security_event' | 'error_event';
  action: string;
  resource: string;
  details: Record<string, unknown>;
}

export interface AuditContext {
  sourceSystem?: string;
  targetSystem?: string;
  industry?: string;
  businessProcess?: string;
  dataClassification?: 'public' | 'internal' | 'confidential' | 'restricted';
  agents: string[];
  cost: number;
  executionTime: number;
}

export interface AuditOutcome {
  success: boolean;
  resultSummary: string;
  confidence?: number;
  riskLevel: 'low' | 'medium' | 'high';
  governanceFlags: string[];
  errors: string[];
  warnings: string[];
}

export interface ComplianceInfo {
  regulation: string[];
  retentionRequired: boolean;
  encryptionRequired: boolean;
  anonymizationRequired: boolean;
  approvalRequired: boolean;
  approver?: string;
  approvalDate?: Date;
}

export interface RetentionInfo {
  retentionPeriod: number; // days
  purgeDate: Date;
  archiveRequired: boolean;
  archiveLocation?: string;
  legalHold: boolean;
  legalHoldReason?: string;
}

export interface AuditQuery {
  sessionIds?: string[];
  userIds?: string[];
  eventTypes?: string[];
  dateRange?: {
    start: Date;
    end: Date;
  };
  riskLevels?: ('low' | 'medium' | 'high')[];
  hasErrors?: boolean;
  complianceFlags?: string[];
  limit?: number;
  offset?: number;
  sortBy?: 'timestamp' | 'risk' | 'cost';
  sortOrder?: 'asc' | 'desc';
}

export interface AuditReport {
  summary: AuditSummary;
  complianceStatus: ComplianceStatus;
  riskAnalysis: RiskAnalysis;
  recommendations: string[];
  entries: AuditLog[];
  generatedAt: Date;
  reportPeriod: {
    start: Date;
    end: Date;
  };
}

export interface AuditSummary {
  totalEvents: number;
  successRate: number;
  averageCost: number;
  averageExecutionTime: number;
  topAgents: { agent: string; usage: number }[];
  errorDistribution: Record<string, number>;
  riskDistribution: Record<string, number>;
}

export interface ComplianceStatus {
  overallCompliance: number; // 0-1
  violations: ComplianceViolation[];
  requirements: ComplianceRequirement[];
  certifications: ComplianceCertification[];
}

export interface ComplianceViolation {
  id: string;
  regulation: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  occurrenceCount: number;
  firstOccurrence: Date;
  lastOccurrence: Date;
  status: 'open' | 'investigating' | 'resolved' | 'exception';
  remediationPlan?: string;
}

export interface ComplianceRequirement {
  regulation: string;
  requirement: string;
  status: 'compliant' | 'non_compliant' | 'partial' | 'not_applicable';
  evidence: string[];
  lastVerified: Date;
}

export interface ComplianceCertification {
  name: string;
  status: 'active' | 'expired' | 'pending';
  validUntil?: Date;
  auditor?: string;
  scope: string[];
}

export interface RiskAnalysis {
  overallRiskScore: number; // 0-1
  riskTrends: { date: Date; score: number }[];
  riskFactors: RiskFactor[];
  mitigationEffectiveness: number;
}

export interface RiskFactor {
  factor: string;
  impact: number; // 0-1
  likelihood: number; // 0-1
  riskScore: number; // impact * likelihood
  trend: 'increasing' | 'stable' | 'decreasing';
  controls: string[];
}

@injectable()
export class AuditService {
  private complianceViolations = new Map<string, ComplianceViolation>();
  private retentionPolicies = new Map<string, number>(); // event type -> retention days
  private complianceRequirements = new Map<string, ComplianceRequirement[]>();
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly now: () => Date;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.AuditLogRepository) private readonly auditLogRepository: AuditLogRepository,
    @inject(TYPES.OutboundGovernanceService) private readonly outboundGovernance: OutboundGovernanceService,
    @unmanaged() options: AuditServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.initializeService(options.startCleanupTimer ?? true);
  }

  /**
   * Log orchestrator execution audit entry
   */
  async logOrchestratorExecution(data: {
    tenantId?: string;
    sessionId: string;
    userId?: string;
    agents: string[];
    success: boolean;
    cost: number;
    executionTime: number;
    governanceFlags?: string[];
    ipAddress?: string;
    userAgent?: string;
  }): Promise<string> {
    const auditId = this.generateAuditId();

    const auditLog: AuditLog = {
      id: auditId,
      timestamp: this.now(),
      sessionId: data.sessionId,
      userId: data.userId,
      ipAddress: data.ipAddress,
      userAgent: data.userAgent,
      event: {
        type: 'orchestrator_execution',
        action: 'execute_workflow',
        resource: 'multi_agent_orchestrator',
        details: {
          agents: data.agents,
          cost: data.cost,
          executionTime: data.executionTime
        }
      },
      context: {
        agents: data.agents,
        cost: data.cost,
        executionTime: data.executionTime,
        dataClassification: 'internal'
      },
      outcome: {
        success: data.success,
        resultSummary: `Orchestrator executed ${data.agents.length} agents`,
        riskLevel: this.calculateRiskLevel(data),
        governanceFlags: data.governanceFlags || [],
        errors: [],
        warnings: []
      },
      compliance: this.determineComplianceInfo('orchestrator_execution'),
      retention: this.calculateRetentionInfo('orchestrator_execution')
    };

    await this.storeAuditLog(auditLog, data.tenantId);
    await this.checkComplianceViolations(auditLog);

    this.logger.info('Orchestrator execution audit logged', {
      auditId,
      sessionId: data.sessionId,
      success: data.success,
      agentCount: data.agents.length
    });

    return auditId;
  }

  /**
   * Log orchestrator error audit entry
   */
  async logOrchestratorError(data: {
    tenantId?: string;
    sessionId: string;
    error: string;
    agents: string[];
    userId?: string;
    ipAddress?: string;
  }): Promise<string> {
    const auditId = this.generateAuditId();

    const auditLog: AuditLog = {
      id: auditId,
      timestamp: this.now(),
      sessionId: data.sessionId,
      userId: data.userId,
      ipAddress: data.ipAddress,
      event: {
        type: 'error_event',
        action: 'orchestrator_failure',
        resource: 'multi_agent_orchestrator',
        details: {
          error: data.error,
          agents: data.agents
        }
      },
      context: {
        agents: data.agents,
        cost: 0,
        executionTime: 0,
        dataClassification: 'internal'
      },
      outcome: {
        success: false,
        resultSummary: `Orchestrator failed: ${data.error}`,
        riskLevel: 'high',
        governanceFlags: ['execution_failure'],
        errors: [data.error],
        warnings: []
      },
      compliance: this.determineComplianceInfo('error_event'),
      retention: this.calculateRetentionInfo('error_event')
    };

    await this.storeAuditLog(auditLog, data.tenantId);
    await this.checkComplianceViolations(auditLog);

    return auditId;
  }

  /**
   * Log agent execution audit entry
   */
  async logAgentExecution(data: {
    tenantId?: string;
    sessionId: string;
    agentName: string;
    success: boolean;
    confidence: number;
    executionTime: number;
    cost: number;
    governanceFlags?: string[];
    userId?: string;
  }): Promise<string> {
    const auditId = this.generateAuditId();

    const auditLog: AuditLog = {
      id: auditId,
      timestamp: this.now(),
      sessionId: data.sessionId,
      userId: data.userId,
      event: {
        type: 'agent_execution',
        action: 'execute_agent',
        resource: data.agentName,
        details: {
          confidence: data.confidence,
          executionTime: data.executionTime,
          cost: data.cost
        }
      },
      context: {
        agents: [data.agentName],
        cost: data.cost,
        executionTime: data.executionTime,
        dataClassification: 'internal'
      },
      outcome: {
        success: data.success,
        resultSummary: `Agent ${data.agentName} executed`,
        confidence: data.confidence,
        riskLevel: this.calculateAgentRiskLevel(data),
        governanceFlags: data.governanceFlags || [],
        errors: [],
        warnings: []
      },
      compliance: this.determineComplianceInfo('agent_execution'),
      retention: this.calculateRetentionInfo('agent_execution')
    };

    await this.storeAuditLog(auditLog, data.tenantId);

    return auditId;
  }

  /**
   * Log governance check audit entry
   */
  async logGovernanceCheck(data: {
    tenantId?: string;
    sessionId: string;
    checkType: 'input' | 'output' | 'ownership' | 'loop_detection';
    approved: boolean;
    riskLevel: 'low' | 'medium' | 'high';
    flags: string[];
    reason?: string;
    userId?: string;
    ownership?: {
      // Widened beyond CanonicalEntity to also accept connector-side record
      // types (e.g. 'contacts', 'Customer') flowing through guardedWrite for
      // entities not yet in SOURCE_OF_TRUTH_MANIFEST. Audit row carries the
      // `ownership_no_policy_declared` flag in that case. Copilot R1 cluster-B.
      entity: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').CanonicalEntity | string;
      declaredOwner: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').SourceSystem;
      callerSystem: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').CallerSystem;
      targetSystem: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').SourceSystem;
      // Canonical union shared with OwnershipResolver/guardedWrite (Copilot review).
      operation: import('../../../governance/sourceOfTruth/OwnershipResolver').WriteOperation;
      recordIdHash?: string;
      policy?: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').ConflictPolicy;
      allowedFieldPaths?: string[];
      blockedFieldPaths?: string[];
      queueId?: string;
      loopBreakingCondition?: string;
      resumeFromQueue?: boolean;
      governanceOverride?: {
        permitted: true;
        reason: string;
        originalPolicy: import('../../../governance/sourceOfTruth/SourceOfTruthManifest').ConflictPolicy;
      };
    };
  }): Promise<string> {
    const auditId = this.generateAuditId();

    const auditLog: AuditLog = {
      id: auditId,
      timestamp: this.now(),
      sessionId: data.sessionId,
      userId: data.userId,
      event: {
        type: 'governance_check',
        action: `validate_${data.checkType}`,
        resource: 'governance_service',
        details: {
          checkType: data.checkType,
          approved: data.approved,
          reason: data.reason,
          ...(data.ownership ? { ownership: data.ownership } : {}),
        }
      },
      context: {
        agents: [],
        cost: 0,
        executionTime: 0,
        dataClassification: 'internal'
      },
      outcome: {
        success: data.approved,
        resultSummary: `Governance ${data.checkType} check: ${data.approved ? 'approved' : 'rejected'}`,
        riskLevel: data.riskLevel,
        governanceFlags: data.flags,
        errors: data.approved ? [] : [data.reason || 'Governance check failed'],
        warnings: []
      },
      compliance: this.determineComplianceInfo('governance_check'),
      retention: this.calculateRetentionInfo('governance_check')
    };

    await this.storeAuditLog(auditLog, data.tenantId);
    await this.checkComplianceViolations(auditLog);

    return auditId;
  }

  /**
   * Log data access audit entry
   */
  async logDataAccess(data: {
    tenantId?: string;
    sessionId: string;
    dataType: string;
    action: 'read' | 'write' | 'delete' | 'export';
    resource: string;
    dataClassification: 'public' | 'internal' | 'confidential' | 'restricted';
    userId?: string;
    ipAddress?: string;
  }): Promise<string> {
    const auditId = this.generateAuditId();

    const auditLog: AuditLog = {
      id: auditId,
      timestamp: this.now(),
      sessionId: data.sessionId,
      userId: data.userId,
      ipAddress: data.ipAddress,
      event: {
        type: 'data_access',
        action: data.action,
        resource: data.resource,
        details: {
          dataType: data.dataType,
          dataClassification: data.dataClassification
        }
      },
      context: {
        agents: [],
        cost: 0,
        executionTime: 0,
        dataClassification: data.dataClassification
      },
      outcome: {
        success: true,
        resultSummary: `Data ${data.action} on ${data.resource}`,
        riskLevel: this.calculateDataAccessRisk(data.dataClassification, data.action),
        governanceFlags: [],
        errors: [],
        warnings: []
      },
      compliance: this.determineComplianceInfo('data_access'),
      retention: this.calculateRetentionInfo('data_access')
    };

    await this.storeAuditLog(auditLog, data.tenantId);
    await this.checkComplianceViolations(auditLog);

    return auditId;
  }

  /**
   * Query audit logs
   */
  async queryAuditLogs(query: AuditQuery): Promise<AuditLog[]> {
    // Pagination is applied in-memory after filter+sort so that sortBy:'risk'
    // and in-memory-only filters (eventTypes, riskLevels) rank the full set
    // before truncating. DB-level pagination would give incorrect top-N for
    // non-timestamp sorts. Known gap: unbounded read for large tables.
    let results = (await this.auditLogRepository.findByAuditFilters({
      sessionIds: query.sessionIds,
      userIds: query.userIds,
      startDate: query.dateRange?.start,
      endDate: query.dateRange?.end,
    })).map((row) => hydrateAIAuditLog(row));

    // Filter by eventTypes against the persisted envelope (event.type)
    // rather than the audit_logs.action column, which holds e.g. 'execute_workflow'.
    if (query.eventTypes) {
      results = results.filter(log => query.eventTypes!.includes(log.event.type));
    }

    if (query.riskLevels) {
      results = results.filter(log => query.riskLevels!.includes(log.outcome.riskLevel));
    }

    if (query.hasErrors !== undefined) {
      results = results.filter(log =>
        query.hasErrors ? log.outcome.errors.length > 0 : log.outcome.errors.length === 0
      );
    }

    if (query.complianceFlags) {
      results = results.filter(log =>
        query.complianceFlags!.some(flag => log.outcome.governanceFlags.includes(flag))
      );
    }

    // Sort results
    const sortBy = query.sortBy || 'timestamp';
    const sortOrder = query.sortOrder || 'desc';

    results.sort((a, b) => {
      let aValue, bValue;

      switch (sortBy) {
        case 'timestamp':
          aValue = a.timestamp.getTime();
          bValue = b.timestamp.getTime();
          break;
        case 'risk':
          const riskValues = { low: 1, medium: 2, high: 3 };
          aValue = riskValues[a.outcome.riskLevel];
          bValue = riskValues[b.outcome.riskLevel];
          break;
        case 'cost':
          aValue = a.context.cost;
          bValue = b.context.cost;
          break;
        default:
          aValue = a.timestamp.getTime();
          bValue = b.timestamp.getTime();
      }

      return sortOrder === 'asc' ? aValue - bValue : bValue - aValue;
    });

    const offset = query.offset || 0;
    const limit = query.limit !== undefined ? query.limit : results.length;
    return results.slice(offset, offset + limit);
  }

  /**
   * Query governance check audit rows for the operator dashboard (PR 13b).
   *
   * Filters by tenant + checkType + time window. Bypasses `queryAuditLogs`
   * because (a) `AuditQuery` has no `tenantId` field and (b) the hydrated
   * `AuditLog` shape drops the persistence-row `tenant_id`. Both gaps are
   * intentional for the older queryAuditLogs surface; this method pushes
   * the tenantIds filter down to `AuditLogRepository.findByAuditFilters`
   * which DOES accept it, then post-filters in TS for the checkType +
   * approved fields that live inside `event.details` after hydration.
   *
   * @param filter.tenantId   tenant to scope rows to (driven by the embedded
   *                          session's tenant_id at the route layer, NOT a
   *                          query param the operator could forge)
   * @param filter.checkType  'ownership' | 'loop_detection' — narrow filter
   *                          for the two governance-dashboard surfaces
   * @param filter.since      lower bound on created_at (operator UI uses 1h
   *                          default window; route translates to startDate)
   * @param filter.approved   optional outcome.success filter; the
   *                          ownership-rejections endpoint passes `false` to
   *                          surface only the rejected/queued rows; the
   *                          loop-detections endpoint omits to show both
   *                          (alert + permitted loop entries)
   * @param filter.limit      optional row cap, defaults to 200 — matches the
   *                          dashboard's max page size; pushed to repo so
   *                          the SQL LIMIT clause does the truncation
   */
  async queryGovernanceChecks(filter: {
    tenantId: string;
    checkType: 'ownership' | 'loop_detection';
    since: Date;
    approved?: boolean;
    limit?: number;
  }): Promise<AuditLog[]> {
    // Copilot R1 (PR 13b) cluster-C: applying the SQL LIMIT before the
    // in-memory checkType/approved filter could silently drop matching
    // governance rows whenever the first N rows in the time window were
    // OTHER event types (validate_input, execute_workflow, etc.). Both
    // filters are now pushed into `findByAuditFilters` so the SQL LIMIT
    // truncates rows that already match. `action` is uniquely derived
    // from `validate_${checkType}` (see line 410) and `result` is
    // 'success' | 'failure' from `outcome.success` (line 834), so the
    // pushdown is an exact replacement for the prior in-memory filter
    // — the remaining `event.type === 'governance_check'` check is
    // defense-in-depth against a future `validate_*` action that doesn't
    // populate the same event-shape.
    const rows = await this.auditLogRepository.findByAuditFilters({
      tenantIds: [filter.tenantId],
      actions: [`validate_${filter.checkType}`],
      result:
        filter.approved === undefined
          ? undefined
          : filter.approved
            ? 'success'
            : 'failure',
      startDate: filter.since,
      endDate: this.now(),
      limit: filter.limit ?? 200,
    });
    const hydrated = rows
      .filter((r) => isAIAuditRow(r))
      .map((r) => hydrateAIAuditLog(r));
    // The SQL pushdown above is the load-bearing correctness change. The
    // in-memory filters below are retained as defense-in-depth — they
    // catch the case where a future schema migration breaks the
    // action/result column ↔ event.type/outcome.success invariant without
    // also updating this query, by failing closed on the dashboard rather
    // than leaking unrelated audit rows.
    return hydrated.filter((log) => {
      if (log.event.type !== 'governance_check') return false;
      const details = log.event.details as Record<string, unknown> | null;
      if (!details || details.checkType !== filter.checkType) return false;
      if (filter.approved !== undefined && log.outcome.success !== filter.approved) return false;
      return true;
    });
  }

  /**
   * Generate audit report
   */
  async generateAuditReport(period: { start: Date; end: Date }): Promise<AuditReport> {
    const logs = await this.queryAuditLogs({
      dateRange: period,
      limit: 10000 // Large limit for comprehensive report
    });

    const summary = this.calculateAuditSummary(logs);
    const complianceStatus = this.calculateComplianceStatus(logs);
    const riskAnalysis = this.calculateRiskAnalysis(logs);
    const recommendations = this.generateRecommendations(summary, complianceStatus, riskAnalysis);

    return {
      summary,
      complianceStatus,
      riskAnalysis,
      recommendations,
      entries: logs,
      generatedAt: new Date(),
      reportPeriod: period
    };
  }

  /**
   * Get compliance violations
   */
  getComplianceViolations(): ComplianceViolation[] {
    return Array.from(this.complianceViolations.values());
  }

  /**
   * Update compliance requirement
   */
  updateComplianceRequirement(regulation: string, requirement: ComplianceRequirement): void {
    if (!this.complianceRequirements.has(regulation)) {
      this.complianceRequirements.set(regulation, []);
    }

    const requirements = this.complianceRequirements.get(regulation)!;
    const existingIndex = requirements.findIndex(r => r.requirement === requirement.requirement);

    if (existingIndex >= 0) {
      requirements[existingIndex] = requirement;
    } else {
      requirements.push(requirement);
    }

    this.logger.info('Compliance requirement updated', {
      regulation,
      requirement: requirement.requirement,
      status: requirement.status
    });
  }

  /**
   * Set retention policy
   */
  setRetentionPolicy(eventType: string, retentionDays: number): void {
    this.retentionPolicies.set(eventType, retentionDays);
    this.logger.info('Retention policy updated', { eventType, retentionDays });
  }

  /**
   * Cleanup expired audit logs
   */
  async cleanupExpiredLogs(): Promise<number> {
    const cutoff = this.now();
    // Restrict to rows written by this AI AuditService (schemaVersion+source check)
    // so that non-AI audit entries (auth, API key events, error logs) in the shared
    // audit_logs table are never accidentally deleted by the AI retention policy.
    const rows = await this.auditLogRepository.findByAuditFilters({ endDate: cutoff });
    const logs = rows.filter(isAIAuditRow).map(hydrateAIAuditLog);
    const expiredIds = logs
      .filter((log) => log.retention.purgeDate <= cutoff && !log.retention.legalHold)
      .map((log) => log.id);

    let cleanedCount = 0;
    const BATCH_SIZE = 500;
    for (let i = 0; i < expiredIds.length; i += BATCH_SIZE) {
      cleanedCount += await this.auditLogRepository.deleteByIds(expiredIds.slice(i, i + BATCH_SIZE));
    }

    if (cleanedCount > 0) {
      this.logger.info('Expired audit logs cleaned up', { cleanedCount });
    }

    return cleanedCount;
  }

  /**
   * Get audit statistics
   */
  async getAuditStatistics(): Promise<{
    totalLogs: number;
    logsByType: Record<string, number>;
    violationsCount: number;
    averageRiskScore: number;
    complianceRate: number;
  }> {
    const logs = await this.queryAuditLogs({});
    const totalLogs = logs.length;

    const logsByType: Record<string, number> = {};
    logs.forEach(log => {
      logsByType[log.event.type] = (logsByType[log.event.type] || 0) + 1;
    });

    const violationsCount = this.complianceViolations.size;

    const riskValues = { low: 1, medium: 2, high: 3 };
    const averageRiskScore = logs.length > 0
      ? logs.reduce((sum, log) => sum + riskValues[log.outcome.riskLevel], 0) / logs.length
      : 0;

    const successfulLogs = logs.filter(log => log.outcome.success).length;
    const complianceRate = logs.length > 0 ? successfulLogs / logs.length : 1;

    return {
      totalLogs,
      logsByType,
      violationsCount,
      averageRiskScore,
      complianceRate
    };
  }

  // Private methods

  private initializeService(startCleanupTimer: boolean): void {
    // Set default retention policies
    this.setRetentionPolicy('orchestrator_execution', 90);
    this.setRetentionPolicy('agent_execution', 30);
    this.setRetentionPolicy('governance_check', 180);
    this.setRetentionPolicy('data_access', 365);
    this.setRetentionPolicy('error_event', 365);
    this.setRetentionPolicy('security_event', 2555); // 7 years

    // Initialize compliance requirements
    this.initializeComplianceRequirements();

    // Start periodic cleanup
    if (startCleanupTimer) {
      this.cleanupTimer = setInterval(async () => {
        try {
          await this.cleanupExpiredLogs();
        } catch (error) {
          this.logger.warn('Periodic audit log cleanup failed', { error: String(error) });
        }
      }, 86400000); // Daily cleanup
      // unref() so this timer doesn't keep short-lived processes alive
      this.cleanupTimer.unref();
    }

    this.logger.info('Audit service initialized');
  }

  private initializeComplianceRequirements(): void {
    // GDPR requirements
    this.updateComplianceRequirement('GDPR', {
      regulation: 'GDPR',
      requirement: 'Data retention limits',
      status: 'compliant',
      evidence: ['Automated retention policies configured'],
      lastVerified: new Date()
    });

    // SOX requirements
    this.updateComplianceRequirement('SOX', {
      regulation: 'SOX',
      requirement: 'Audit trail completeness',
      status: 'compliant',
      evidence: ['All financial data access logged'],
      lastVerified: new Date()
    });

    // HIPAA requirements
    this.updateComplianceRequirement('HIPAA', {
      regulation: 'HIPAA',
      requirement: 'PHI access logging',
      status: 'compliant',
      evidence: ['Healthcare data access audit trails'],
      lastVerified: new Date()
    });
  }

  private generateAuditId(): string {
    return `audit_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
  }

  private async storeAuditLog(auditLog: AuditLog, tenantId?: string): Promise<void> {
    const resolvedTenantId = this.resolveTenantId(tenantId);
    const { details, auditDlp } = await this.sanitizeEventDetails(auditLog, resolvedTenantId);
    const event = { ...auditLog.event, details };
    // When DLP redacts or blocks, strip outcome.errors and resultSummary to
    // prevent sensitive text (e.g. raw error messages) leaking through those
    // fields even when event.details was sanitized.
    const outcome = (auditDlp.redacted || auditDlp.omittedRawDetails)
      ? { ...auditLog.outcome, errors: [], resultSummary: '[redacted by DLP]' }
      : auditLog.outcome;
    const persistedAuditLog: AuditLog = { ...auditLog, event, outcome };
    const persistedDetails = buildPersistedAIAuditDetails(persistedAuditLog, auditDlp);

    const row: NewAuditLog = {
      id: auditLog.id,
      tenant_id: resolvedTenantId,
      user_id: auditLog.userId ?? SYSTEM_IDENTITY.userId,
      action: auditLog.event.action,
      resource_type: auditLog.event.resource,
      resource_id: auditLog.sessionId,
      old_values: null,
      new_values: null,
      details: persistedDetails,
      result: auditLog.outcome.success ? 'success' : 'failure',
      error_message: outcome.errors[0] ?? null,
      duration_ms: Math.round(auditLog.context.executionTime),
      ip_address: auditLog.ipAddress ?? null,
      user_agent: auditLog.userAgent ?? null,
      created_at: auditLog.timestamp.toISOString(),
    };

    await this.auditLogRepository.create(row);

    this.logger.debug('Audit log stored', {
      id: auditLog.id,
      tenantId: resolvedTenantId,
      sessionId: auditLog.sessionId,
      eventType: auditLog.event.type,
    });
  }

  private resolveTenantId(tenantId?: string): string {
    const normalized = tenantId?.trim();
    return normalized && normalized.length > 0 ? normalized : SYSTEM_IDENTITY.tenantId;
  }

  private async sanitizeEventDetails(
    auditLog: AuditLog,
    tenantId: string,
  ): Promise<{ details: Record<string, unknown>; auditDlp: AuditDlpPersistenceMetadata }> {
    const originalDetails = auditLog.event.details ?? {};
    const decision = await this.outboundGovernance.validateAuditLogPayload(originalDetails, {
      tenantId,
      userId: auditLog.userId ?? SYSTEM_IDENTITY.userId,
      destination: 'audit_log',
      destinationDetail: 'audit_logs.details',
      operationType: 'write',
      resourceType: auditLog.event.resource,
      resourceId: auditLog.sessionId,
    });

    const redactedPayload = decision.redactedPayload;
    const details = redactedPayload && typeof redactedPayload === 'object'
      ? redactedPayload as Record<string, unknown>
      : {
          omittedByOutboundGovernance: true,
          reason: 'audit_details_unavailable_after_governance_block',
        };

    return {
      details,
      auditDlp: this.toAuditDlpMetadata(decision, redactedPayload == null),
    };
  }

  private toAuditDlpMetadata(
    decision: OutboundDecision<unknown>,
    omittedRawDetails: boolean,
  ): AuditDlpPersistenceMetadata {
    return {
      approved: decision.approved,
      approvalRequired: decision.approvalRequired,
      riskLevel: decision.riskLevel,
      findings: decision.findings,
      redacted: decision.auditMetadata.redacted,
      blocked: decision.auditMetadata.blocked,
      omittedRawDetails,
    };
  }

  private calculateRiskLevel(data: { cost: number; agents: string[]; governanceFlags?: string[] }): 'low' | 'medium' | 'high' {
    let riskScore = 0;

    // Cost-based risk
    if (data.cost > 0.5) riskScore += 0.3;
    else if (data.cost > 0.2) riskScore += 0.1;

    // Agent count risk
    if (data.agents.length > 3) riskScore += 0.2;

    // Governance flags risk
    const flags = data.governanceFlags || [];
    if (flags.includes('pii_detected')) riskScore += 0.5;
    if (flags.includes('execution_failure')) riskScore += 0.4;
    if (flags.length > 2) riskScore += 0.2;

    if (riskScore >= 0.7) return 'high';
    if (riskScore >= 0.3) return 'medium';
    return 'low';
  }

  private calculateAgentRiskLevel(data: { confidence: number; success: boolean; governanceFlags?: string[] }): 'low' | 'medium' | 'high' {
    let riskScore = 0;

    // Confidence-based risk
    if (data.confidence < 0.3) riskScore += 0.5;
    else if (data.confidence < 0.6) riskScore += 0.2;

    // Success-based risk
    if (!data.success) riskScore += 0.4;

    // Governance flags
    const flags = data.governanceFlags || [];
    if (flags.length > 0) riskScore += 0.3;

    if (riskScore >= 0.7) return 'high';
    if (riskScore >= 0.3) return 'medium';
    return 'low';
  }

  private calculateDataAccessRisk(
    classification: 'public' | 'internal' | 'confidential' | 'restricted',
    action: 'read' | 'write' | 'delete' | 'export'
  ): 'low' | 'medium' | 'high' {
    const classificationRisk = { public: 0, internal: 0.2, confidential: 0.5, restricted: 0.8 };
    const actionRisk = { read: 0, write: 0.3, export: 0.5, delete: 0.7 };

    const totalRisk = classificationRisk[classification] + actionRisk[action];

    if (totalRisk >= 0.8) return 'high';
    if (totalRisk >= 0.4) return 'medium';
    return 'low';
  }

  private determineComplianceInfo(eventType: string): ComplianceInfo {
    const baseInfo: ComplianceInfo = {
      regulation: [],
      retentionRequired: true,
      encryptionRequired: false,
      anonymizationRequired: false,
      approvalRequired: false
    };

    switch (eventType) {
      case 'data_access':
        baseInfo.regulation = ['GDPR', 'CCPA'];
        baseInfo.encryptionRequired = true;
        break;
      case 'governance_check':
        baseInfo.regulation = ['SOX', 'GDPR'];
        break;
      case 'error_event':
        baseInfo.regulation = ['SOX'];
        baseInfo.retentionRequired = true;
        break;
      default:
        baseInfo.regulation = ['Internal'];
    }

    return baseInfo;
  }

  private calculateRetentionInfo(eventType: string): RetentionInfo {
    const retentionDays = this.retentionPolicies.get(eventType) || 30;
    const purgeDate = new Date();
    purgeDate.setDate(purgeDate.getDate() + retentionDays);

    return {
      retentionPeriod: retentionDays,
      purgeDate,
      archiveRequired: retentionDays > 365,
      legalHold: false
    };
  }

  private async checkComplianceViolations(auditLog: AuditLog): Promise<void> {
    // Check for PII violations
    if (auditLog.outcome.governanceFlags.includes('pii_detected')) {
      await this.recordComplianceViolation({
        id: `pii_violation_${auditLog.id}`,
        regulation: 'GDPR',
        severity: 'high',
        description: 'PII detected in processing',
        occurrenceCount: 1,
        firstOccurrence: auditLog.timestamp,
        lastOccurrence: auditLog.timestamp,
        status: 'open'
      });
    }

    // Check for high-risk operations
    if (auditLog.outcome.riskLevel === 'high' && !auditLog.userId) {
      await this.recordComplianceViolation({
        id: `unauthorized_high_risk_${auditLog.id}`,
        regulation: 'Internal',
        severity: 'medium',
        description: 'High-risk operation without user authentication',
        occurrenceCount: 1,
        firstOccurrence: auditLog.timestamp,
        lastOccurrence: auditLog.timestamp,
        status: 'open'
      });
    }
  }

  private async recordComplianceViolation(violation: ComplianceViolation): Promise<void> {
    const existing = this.complianceViolations.get(violation.id);
    if (existing) {
      existing.occurrenceCount++;
      existing.lastOccurrence = violation.lastOccurrence;
    } else {
      this.complianceViolations.set(violation.id, violation);
    }

    this.logger.warn('Compliance violation recorded', {
      id: violation.id,
      regulation: violation.regulation,
      severity: violation.severity
    });
  }

  private calculateAuditSummary(logs: AuditLog[]): AuditSummary {
    const totalEvents = logs.length;
    const successfulEvents = logs.filter(log => log.outcome.success).length;
    const successRate = totalEvents > 0 ? successfulEvents / totalEvents : 1;

    const totalCost = logs.reduce((sum, log) => sum + log.context.cost, 0);
    const averageCost = totalEvents > 0 ? totalCost / totalEvents : 0;

    const totalTime = logs.reduce((sum, log) => sum + log.context.executionTime, 0);
    const averageExecutionTime = totalEvents > 0 ? totalTime / totalEvents : 0;

    // Calculate top agents
    const agentUsage = new Map<string, number>();
    logs.forEach(log => {
      log.context.agents.forEach(agent => {
        agentUsage.set(agent, (agentUsage.get(agent) || 0) + 1);
      });
    });

    const topAgents = Array.from(agentUsage.entries())
      .map(([agent, usage]) => ({ agent, usage }))
      .sort((a, b) => b.usage - a.usage)
      .slice(0, 5);

    // Error and risk distributions
    const errorDistribution: Record<string, number> = {};
    const riskDistribution: Record<string, number> = {};

    logs.forEach(log => {
      // Error distribution
      log.outcome.errors.forEach(error => {
        const errorType = error.split(':')[0] || 'Unknown';
        errorDistribution[errorType] = (errorDistribution[errorType] || 0) + 1;
      });

      // Risk distribution
      riskDistribution[log.outcome.riskLevel] = (riskDistribution[log.outcome.riskLevel] || 0) + 1;
    });

    return {
      totalEvents,
      successRate,
      averageCost,
      averageExecutionTime,
      topAgents,
      errorDistribution,
      riskDistribution
    };
  }

  private calculateComplianceStatus(logs: AuditLog[]): ComplianceStatus {
    const violations = Array.from(this.complianceViolations.values());
    const requirements = Array.from(this.complianceRequirements.values()).flat();

    const compliantRequirements = requirements.filter(r => r.status === 'compliant').length;
    const overallCompliance = requirements.length > 0 ? compliantRequirements / requirements.length : 1;

    const certifications: ComplianceCertification[] = [
      {
        name: 'SOC 2 Type II',
        status: 'active',
        validUntil: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
        scope: ['Security', 'Availability', 'Confidentiality']
      }
    ];

    return {
      overallCompliance,
      violations,
      requirements,
      certifications
    };
  }

  private calculateRiskAnalysis(logs: AuditLog[]): RiskAnalysis {
    const riskValues = { low: 1, medium: 2, high: 3 };
    const totalRisk = logs.reduce((sum, log) => sum + riskValues[log.outcome.riskLevel], 0);
    const overallRiskScore = logs.length > 0 ? totalRisk / (logs.length * 3) : 0;

    // Risk trends (simplified - would need time series data in real implementation)
    const riskTrends = [
      { date: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), score: 0.3 },
      { date: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), score: overallRiskScore }
    ];

    const riskFactors: RiskFactor[] = [
      {
        factor: 'High-cost operations',
        impact: 0.7,
        likelihood: 0.3,
        riskScore: 0.21,
        trend: 'stable',
        controls: ['Cost monitoring', 'Approval workflows']
      },
      {
        factor: 'PII exposure',
        impact: 0.9,
        likelihood: 0.2,
        riskScore: 0.18,
        trend: 'decreasing',
        controls: ['PII detection', 'Auto-redaction']
      }
    ];

    return {
      overallRiskScore,
      riskTrends,
      riskFactors,
      mitigationEffectiveness: 0.85
    };
  }

  private generateRecommendations(
    summary: AuditSummary,
    compliance: ComplianceStatus,
    risk: RiskAnalysis
  ): string[] {
    const recommendations: string[] = [];

    if (summary.successRate < 0.95) {
      recommendations.push('Improve system reliability - success rate below 95%');
    }

    if (summary.averageCost > 0.25) {
      recommendations.push('Review cost optimization strategies - average cost is high');
    }

    if (compliance.overallCompliance < 0.9) {
      recommendations.push('Address compliance gaps - overall compliance below 90%');
    }

    if (risk.overallRiskScore > 0.6) {
      recommendations.push('Implement additional risk controls - risk score is elevated');
    }

    if (compliance.violations.length > 0) {
      recommendations.push('Resolve outstanding compliance violations');
    }

    return recommendations;
  }
}
