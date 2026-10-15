/**
 * Workflow Router — Proxy Family
 *
 * AI-powered workflow analysis, predictions, and optimization.
 * Governance enforced at proxy mount boundary.
 */

import { Router, Request, Response } from 'express';
import type { AIWorkflowIntelligenceService } from '../../services/AIWorkflowIntelligenceService';
import type { Logger } from '../../utils/Logger';

export interface WorkflowRouterDependencies {
  logger: Logger;
  workflowIntelligenceService: AIWorkflowIntelligenceService;
}

export function createWorkflowRouter(deps: WorkflowRouterDependencies): Router {
  const { logger, workflowIntelligenceService } = deps;
  const router = Router();

  router.get('/analyze/:integrationId', async (req: Request, res: Response): Promise<void> => {
    try {
      const analysis = await workflowIntelligenceService.analyzeWorkflow(req.params.integrationId);
      res.json({ success: true, analysis, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Workflow analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze workflow', details: (error as Error).message });
    }
  });

  router.get('/predictions/:integrationId', async (req: Request, res: Response): Promise<void> => {
    try {
      const analysis = await workflowIntelligenceService.analyzeWorkflow(req.params.integrationId);
      res.json({ success: true, predictions: analysis.predictedFailures, remediationActions: analysis.remediationActions, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Prediction error:', error);
      res.status(500).json({ error: 'Failed to generate predictions', details: (error as Error).message });
    }
  });

  router.get('/optimize/:integrationId', async (req: Request, res: Response): Promise<void> => {
    try {
      const analysis = await workflowIntelligenceService.analyzeWorkflow(req.params.integrationId);
      res.json({ success: true, suggestions: analysis.optimizationSuggestions, smartSchedule: analysis.smartSchedule, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Optimization error:', error);
      res.status(500).json({ error: 'Failed to generate optimization suggestions', details: (error as Error).message });
    }
  });

  return router;
}
