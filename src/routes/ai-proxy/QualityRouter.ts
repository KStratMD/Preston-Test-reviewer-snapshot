/**
 * Quality Router - Data Quality and Telemetry Endpoints
 * Handles telemetry statistics, data quality analysis, and provider testing
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { isAnonymousRequest } from '../../middleware/aiProxyPolicyGate';
import type { Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../../services/UnifiedTelemetryService';
import { ProviderRegistry } from '../../services/ai/ProviderRegistry';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';
import { GovernanceService } from '../../services/ai/orchestrator/GovernanceService';
import { verifiedUserId } from '../utils/verifiedIdentity';

export interface QualityRouterDependencies {
  logger: Logger;
  telemetry: UnifiedTelemetryService;
  registry: ProviderRegistry;
  governanceService: GovernanceService;
}

export async function createQualityRouter(deps: QualityRouterDependencies): Promise<Router> {
  const router = Router();
  const { logger, telemetry, registry, governanceService } = deps;

  /**
   * GET /api/ai/telemetry/statistics - Get telemetry statistics
   */
  router.get('/telemetry/statistics', asyncHandler(async (req: Request, res: Response) => {
    const timeframe = (req.query.timeframe as 'hour' | 'day' | 'week') || 'day';

    try {
      const statistics = await telemetry.getStatistics(timeframe);

      res.json({
        success: true,
        statistics,
        timeframe,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get telemetry statistics', { error: String(error) });

      res.status(500).json({
        success: false,
        error: 'Failed to get statistics'
      });
    }
  }));

  /**
   * POST /api/ai/data-quality/analyze - Analyze data quality
   */
  router.post('/data-quality/analyze', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const {
      data,
      sourceSystem,
      businessPurpose,
      schema,
      preferredProvider
    } = req.body;

    // Validate required fields
    if (!data || !sourceSystem || !businessPurpose || !schema) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: data, sourceSystem, businessPurpose, schema'
      });
    }

    try {
      // Governance pre-check
      try {
        const analysisId = `dq_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 6)}`;
        // F6: identity from the VERIFIED req.user only — no system-sentinel
        // fallback. Placed here rather than at the top of the handler so the
        // pre-existing required-field 400 still runs first; this is the last
        // point before any governance work.
        const userId = verifiedUserId(req);
        if (userId === null) {
          return res.status(401).json({ error: 'identity_required' });
        }
        const preCheck = await governanceService.validateInput(req.body, {
          sessionId: analysisId,
          userId,
          sourceSystem,
          targetSystem: 'data-quality',
          timestamp: new Date(),
          metadata: { route: 'data-quality/analyze' }
        } as any);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;
          logger.warn('Governance blocked data quality analysis', { reason: preCheck.reason, flags: preCheck.flags });
          return res.status(400).json({
            success: false,
            error: { type: 'governance_violation', ruleId, message: preCheck.reason || 'Blocked by governance policy' },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: { timestamp: new Date().toISOString() }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (data-quality/analyze)', { error: String(gerr) });
      }
      // Get available provider
      const providerInfo = await registry.getAvailableProvider(preferredProvider);
      if (!providerInfo) {
        return res.status(503).json({
          success: false,
          error: 'No AI providers available'
        });
      }

      const { provider, id: providerId } = providerInfo;

      // Analyze data quality
      const assessment = await provider.analyzeDataQuality(data, {
        sourceSystem,
        businessPurpose,
        schema
      });

      const duration = Date.now() - startTime;

      // Log telemetry
      logger.info('AI data quality analysis completed', {
        providerId,
        sourceSystem,
        recordCount: data.length,
        overallScore: assessment.overallScore,
        issuesCount: assessment.issues.length,
        duration
      });

      res.json({
        success: true,
        assessment,
        metadata: {
          providerId,
          providerName: provider.name,
          duration,
          recordCount: data.length,
          timestamp: new Date().toISOString()
        }
      });

    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.data_quality_analyze',
        resourceId: 'new',
      })) return;
      logger.error('AI data quality analysis failed', {
        error: String(error),
        sourceSystem
      });

      res.status(500).json({
        success: false,
        error: 'Failed to analyze data quality',
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * POST /api/ai/providers/test - Test specific provider connectivity
   */
  router.post('/providers/:providerId/test', asyncHandler(async (req: Request, res: Response) => {
    // F2 zero-spend ruling (v4/v5): anonymous demo sessions never invoke a
    // provider connectivity test (paid completions on several providers).
    // The id is still validated against the registry WITHOUT touching the
    // provider instance, preserving the existing unknown-provider 404
    // (Codex round-4 finding 5: a fixture that 200s for invented ids would
    // change the endpoint's contract).
    if (isAnonymousRequest(req)) {
      const known = registry.listProviders().some((p) => p.id === req.params.providerId);
      if (!known) {
        res.status(404).json({ success: false, error: `Provider '${req.params.providerId}' not found` });
        return;
      }
      res.json({
        success: true,
        demoFixture: true,
        providerId: req.params.providerId,
        message: 'demo session — live connectivity test requires authentication',
      });
      return;
    }

    const { providerId } = req.params;

    const provider = registry.getProvider(providerId);
    if (!provider) {
      return res.status(404).json({
        success: false,
        error: `Provider '${providerId}' not found`
      });
    }

    try {
      const result = await provider.testConnection();

      res.json({
        success: result.ok,
        providerId,
        providerName: provider.name,
        message: result.message,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error(`Provider ${providerId} test failed`, { error: String(error) });

      res.status(500).json({
        success: false,
        error: 'Provider test failed',
        details: String(error)
      });
    }
  }));

  return router;
}
