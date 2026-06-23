import { Router, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { ReasoningTraceRepository } from '../database/repositories/ReasoningTraceRepository';
import type { CostTrackingService } from '../services/ai/CostTrackingService';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import type { DLPService } from '../services/security/DLPService';
import type { Logger } from '../utils/Logger';

const router = Router();
const SERVER_START_TIME = new Date().toISOString();

// Lazy service initialization
let traceRepo: ReasoningTraceRepository;
let costService: CostTrackingService;
let auditService: AuditService;
let dlpService: DLPService;
let logger: Logger;

async function getServices() {
  if (!logger) {
    // ReasoningTraceRepository and CostTrackingService are async-bound — sync
    // .get() returns Promise<T> on cold-resolution paths (singleton-realization
    // ordering luck would otherwise mask this bug). Use getAsync uniformly so
    // the function is correct regardless of bootstrap order.
    logger = container.get<Logger>(TYPES.Logger);
    traceRepo = await container.getAsync<ReasoningTraceRepository>(TYPES.ReasoningTraceRepository);
    costService = await container.getAsync<CostTrackingService>(TYPES.CostTrackingService);
    auditService = container.get<AuditService>(TYPES.AuditService);
    dlpService = container.get<DLPService>(TYPES.DLPService);
  }
  return { traceRepo, costService, auditService, dlpService, logger };
}

function hasCompliancePermission(req: Request): boolean {
  const permissions = req.user?.permissions || [];
  return permissions.some(p =>
    p === 'compliance:read' ||
    p === 'compliance:admin' ||
    p === 'admin' ||
    p === '*'
  );
}

/**
 * GET /api/compliance/summary — aggregate compliance stats
 */
router.get('/summary', async (req: Request, res: Response) => {
  try {
    if (!hasCompliancePermission(req)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for compliance data' });
    }

    const { traceRepo, costService, auditService } = await getServices();

    // Reasoning trace stats (from DB — survives restart)
    const traceCount = await traceRepo.countSessions();
    const recentSessions = await traceRepo.queryTraces({}, { limit: 5 });

    // AI cost data (from DB — survives restart)
    const now = new Date();
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
    const costData = await costService.getUsageStatisticsFromDB(thirtyDaysAgo, now);

    // Audit log stats
    const auditStats = await auditService.getAuditStatistics();

    res.json({
      success: true,
      data: {
        reasoningTraces: {
          totalSessions: traceCount,
          recentSessions: recentSessions.map(s => ({
            sessionId: s.session_id,
            status: s.status,
            startedAt: s.started_at,
            confidence: s.overall_confidence,
          })),
          dataSource: 'database',
          coverage: 'all_time',
        },
        aiCosts: {
          totalCost: costData.totalCost,
          totalRequests: costData.totalRequests,
          totalTokens: costData.totalTokens,
          byProvider: costData.byProvider,
          dataSource: 'database',
          coverage: 'last_30_days',
        },
        auditActions: {
          totalLogs: auditStats.totalLogs,
          logsByType: auditStats.logsByType,
          violationsCount: auditStats.violationsCount,
          complianceRate: auditStats.complianceRate,
          dataSource: 'database',
          coverage: 'all_time',
        },
      },
    });
  } catch (error) {
    const { logger } = await getServices();
    // Logger.error only attaches its 2nd arg when it is an Error instance —
    // forward the real error (wrapped if needed) so the log carries it.
    logger.error('Compliance summary failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * POST /api/compliance/export — assemble evidence package JSON
 */
router.post('/export', async (req: Request, res: Response) => {
  try {
    if (!hasCompliancePermission(req)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for compliance export' });
    }

    const { traceRepo, costService, auditService } = await getServices();
    const { startDate: startStr, endDate: endStr } = req.body;

    const startDate = startStr ? new Date(startStr) : new Date(Date.now() - 30 * 24 * 3600 * 1000);
    const endDate = endStr ? new Date(endStr) : new Date();

    if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ success: false, error: 'Invalid date format' });
    }
    if (startDate > endDate) {
      return res.status(400).json({ success: false, error: 'startDate must be before endDate' });
    }

    // Reasoning traces for date range (from DB)
    const traceSessions = await traceRepo.queryTraces({
      startDate,
      endDate,
    });

    // AI usage for date range (from DB)
    const costData = await costService.getUsageStatisticsFromDB(startDate, endDate);

    // Audit actions
    const auditStats = await auditService.getAuditStatistics();

    res.json({
      metadata: {
        exportDate: new Date().toISOString(),
        coveragePeriod: {
          start: startDate.toISOString(),
          end: endDate.toISOString(),
        },
        caveats: [
          { source: 'dlp', type: 'session_scoped', serverStartTime: SERVER_START_TIME },
        ],
      },
      reasoningTraces: traceSessions.map(s => ({
        sessionId: s.session_id,
        userId: s.user_id,
        workflowType: s.workflow_type,
        startedAt: s.started_at,
        completedAt: s.completed_at,
        status: s.status,
        overallConfidence: s.overall_confidence,
        totalExecutionTime: s.total_execution_time,
      })),
      aiUsage: {
        totalCost: costData.totalCost,
        totalRequests: costData.totalRequests,
        totalTokens: costData.totalTokens,
        byProvider: costData.byProvider,
      },
      auditActions: {
        totalLogs: auditStats.totalLogs,
        logsByType: auditStats.logsByType,
        violationsCount: auditStats.violationsCount,
        complianceRate: auditStats.complianceRate,
      },
    });
  } catch (error) {
    const { logger } = await getServices();
    logger.error('Compliance export failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/compliance/soc2-mapping — static SOC 2 Trust Services Criteria mapping
 */
router.get('/soc2-mapping', async (req: Request, res: Response) => {
  try {
    if (!hasCompliancePermission(req)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for compliance data' });
    }

    const { dlpService } = await getServices();
    const dlpPatternCount = dlpService.getRegisteredPatterns().length;

    res.json({
      success: true,
      data: {
        dlpPatternCount,
        scopeDisclosure: {
          auditLog: 'persistent',
          note: 'Audit log events persist to audit_logs with tenant attribution. Audit event details are redacted or omitted by outbound governance before persistence.',
        },
        security: {
          criteria: 'CC6.1 - Logical and Physical Access Controls',
          features: [
            { feature: 'JWT Authentication', status: 'implemented', file: 'src/middleware/auth.ts' },
            { feature: 'RBAC Permissions', status: 'implemented', file: 'src/middleware/rbac.ts' },
            { feature: 'Timing-Safe API Key Validation', status: 'implemented', file: 'src/middleware/security/authentication.ts' },
            { feature: 'Rate Limiting', status: 'implemented', file: 'src/middleware/security/protection.ts' },
            { feature: 'Production Guards (JWT_SECRET, demo mode)', status: 'implemented', file: 'src/config/env.ts' },
          ],
        },
        availability: {
          criteria: 'A1.2 - Recovery and Continuity',
          features: [
            { feature: 'Health Check Endpoints', status: 'implemented', file: 'src/routes/health.ts' },
            { feature: 'Circuit Breaker Pattern', status: 'implemented', file: 'src/utils/CircuitBreaker.ts' },
            { feature: 'Disaster Recovery Config', status: 'implemented', file: 'public/disaster-recovery.html' },
          ],
        },
        processingIntegrity: {
          criteria: 'PI1.4 - Processing Accuracy',
          features: [
            { feature: 'AI Confidence Scoring', status: 'implemented', file: 'src/services/ai/orchestrator/ReasoningTraceEngine.ts' },
            { feature: 'Hallucination Detection', status: 'implemented', file: 'src/services/ai/orchestrator/GovernanceService.ts' },
            { feature: 'Schema Drift Blocking', status: 'implemented', file: 'src/services/sync/SchemaRegistryService.ts' },
            { feature: 'Reasoning Traces (DB-persisted)', status: 'implemented', file: 'src/database/repositories/ReasoningTraceRepository.ts' },
          ],
        },
        confidentiality: {
          criteria: 'C1.1 - Confidential Information Protection',
          features: [
            { feature: `DLP/PII Detection (${dlpPatternCount} patterns)`, status: 'implemented', file: 'src/services/security/DLPService.ts' },
            { feature: 'Sensitive Data Masking in Logs', status: 'implemented', file: 'src/utils/securityHelpers.ts' },
            { feature: 'Encrypted Credential Storage', status: 'implemented', file: 'src/services/ConnectorCredentialService.ts' },
          ],
        },
        privacy: {
          criteria: 'P1.1 - Privacy Notice and Consent',
          features: [
            { feature: 'GDPR/CCPA Compliance Design', status: 'implemented', file: 'src/services/security/DLPService.ts' },
            { feature: 'Audit Trail Logging', status: 'implemented', file: 'src/services/ai/orchestrator/AuditService.ts' },
            { feature: 'Data Retention Policies', status: 'implemented', file: 'src/services/ai/orchestrator/AuditService.ts' },
          ],
        },
      },
    });
  } catch (error) {
    const { logger } = await getServices();
    logger.error('SOC2 mapping failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

/**
 * GET /api/compliance/dlp-patterns — registered DLP/PII pattern metadata
 *
 * Single source of truth for the C1 confidentiality panel on the
 * compliance dashboard. Returns the metadata-only view from
 * `DLPService.getRegisteredPatterns()` so the dashboard's count and
 * pattern list never drift from the actual scanned set.
 */
router.get('/dlp-patterns', async (req: Request, res: Response) => {
  try {
    if (!hasCompliancePermission(req)) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions for compliance data' });
    }

    const { dlpService } = await getServices();
    const patterns = dlpService.getRegisteredPatterns();

    res.json({
      success: true,
      data: {
        count: patterns.length,
        patterns,
      },
    });
  } catch (error) {
    const { logger } = await getServices();
    logger.error('DLP patterns query failed', error instanceof Error ? error : new Error(String(error)));
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

export default router;
