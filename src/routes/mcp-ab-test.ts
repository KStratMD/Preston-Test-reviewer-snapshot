/**
 * MCP A/B Testing API Routes
 * Phase 3 Week 2: Endpoints for managing and analyzing A/B tests
 */

import { Router, type Request, type Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { MCPABTestService, MCPABTestConfig, MCPTestMetrics } from '../services/ai/mcp/MCPABTestService';
import type { Logger } from '../utils/Logger';

const router = Router();

/**
 * POST /api/mcp/ab-test/initialize
 * Initialize a new A/B test
 */
router.post('/initialize', async (req: Request, res: Response) => {
  try {
    const logger = container.get<Logger>(TYPES.Logger);
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);

    const config: MCPABTestConfig = {
      testId: req.body.testId || 'mcp-accuracy-test-1',
      name: req.body.name || 'MCP AI Enhancement Accuracy Test',
      description: req.body.description || 'Measure +3-4% accuracy improvement from MCP context',
      enabled: req.body.enabled !== false, // Default: true

      controlGroupPercent: req.body.controlGroupPercent || 50,
      treatmentGroupPercent: req.body.treatmentGroupPercent || 50,

      minSampleSize: req.body.minSampleSize || 50, // Minimum 50 samples per group
      confidenceLevel: req.body.confidenceLevel || 0.95, // 95% confidence

      startDate: req.body.startDate ? new Date(req.body.startDate) : new Date(),
      endDate: req.body.endDate ? new Date(req.body.endDate) : new Date(Date.now() + 14 * 24 * 60 * 60 * 1000), // 14 days

      metrics: req.body.metrics || ['accuracy', 'confidence', 'manualCorrections', 'validationTime']
    };

    await abTestService.initialize(config);

    logger.info('A/B test initialized via API', {
      testId: config.testId,
      testName: config.name
    });

    res.json({
      success: true,
      message: 'A/B test initialized successfully',
      config
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to initialize A/B test', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to initialize A/B test'
    });
  }
});

/**
 * GET /api/mcp/ab-test/assign/:sessionId
 * Get test group assignment for a session
 */
router.get('/assign/:sessionId', async (req: Request, res: Response) => {
  try {
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);
    const sessionId = req.params.sessionId;

    const group = await abTestService.assignGroup(sessionId);

    res.json({
      success: true,
      sessionId,
      group,
      mcpEnabled: group === 'treatment' // MCP enhancement enabled for treatment group only
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to assign test group', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to assign test group',
      group: 'excluded', // Fallback to excluded on error
      mcpEnabled: false
    });
  }
});

/**
 * POST /api/mcp/ab-test/metrics
 * Record test metrics for a session
 */
router.post('/metrics', (req: Request, res: Response) => {
  try {
    const logger = container.get<Logger>(TYPES.Logger);
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);

    const metrics: MCPTestMetrics = {
      testId: req.body.testId || 'mcp-accuracy-test-1',
      sessionId: req.body.sessionId,
      userId: req.body.userId,
      group: req.body.group,
      timestamp: new Date(),

      sourceSystem: req.body.sourceSystem,
      targetSystem: req.body.targetSystem,
      fieldCount: req.body.fieldCount,

      totalMappings: req.body.totalMappings,
      correctMappings: req.body.correctMappings,
      incorrectMappings: req.body.incorrectMappings,
      accuracyRate: req.body.accuracyRate,

      avgConfidence: req.body.avgConfidence,
      confidenceDistribution: req.body.confidenceDistribution || [],

      manualCorrections: req.body.manualCorrections,
      validationTimeMs: req.body.validationTimeMs,
      userAcceptanceRate: req.body.userAcceptanceRate,

      mcpContextUsed: req.body.mcpContextUsed || false,
      mcpAccuracyImprovement: req.body.mcpAccuracyImprovement,
      confidenceBoostApplied: req.body.confidenceBoostApplied
    };

    abTestService.recordMetrics(metrics);

    logger.info('Test metrics recorded via API', {
      testId: metrics.testId,
      sessionId: metrics.sessionId,
      group: metrics.group,
      accuracyRate: metrics.accuracyRate.toFixed(2)
    });

    res.json({
      success: true,
      message: 'Metrics recorded successfully'
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to record test metrics', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to record test metrics'
    });
  }
});

/**
 * GET /api/mcp/ab-test/results/:testId
 * Get aggregated test results with statistical analysis
 */
router.get('/results/:testId', (req: Request, res: Response) => {
  try {
    const logger = container.get<Logger>(TYPES.Logger);
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);
    const testId = req.params.testId;

    const results = abTestService.getResults(testId);

    if (!results) {
      return res.status(404).json({
        success: false,
        error: 'No test results found or insufficient samples',
        testId
      });
    }

    logger.info('Test results retrieved via API', {
      testId,
      accuracyImprovement: results.accuracyImprovement.toFixed(2) + '%',
      statistically_significant: results.statistically_significant
    });

    res.json({
      success: true,
      results
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to get test results', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get test results'
    });
  }
});

/**
 * GET /api/mcp/ab-test/metrics/:testId
 * Get raw metrics for a test
 */
router.get('/metrics/:testId', (req: Request, res: Response) => {
  try {
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);
    const testId = req.params.testId;

    const metrics = abTestService.getMetrics(testId);

    res.json({
      success: true,
      testId,
      count: metrics.length,
      metrics
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to get test metrics', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to get test metrics'
    });
  }
});

/**
 * DELETE /api/mcp/ab-test/data/:testId
 * Clear test data
 */
router.delete('/data/:testId', (req: Request, res: Response) => {
  try {
    const logger = container.get<Logger>(TYPES.Logger);
    const abTestService = container.get<MCPABTestService>(TYPES.MCPABTestService);
    const testId = req.params.testId;

    abTestService.clearTestData(testId);

    logger.info('Test data cleared via API', { testId });

    res.json({
      success: true,
      message: 'Test data cleared successfully',
      testId
    });
  } catch (error) {
    const logger = container.get<Logger>(TYPES.Logger);
    logger.error('Failed to clear test data', {
      error: error instanceof Error ? error.message : String(error)
    });

    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to clear test data'
    });
  }
});

export default router;
