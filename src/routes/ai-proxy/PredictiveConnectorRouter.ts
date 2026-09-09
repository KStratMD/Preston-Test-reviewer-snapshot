/**
 * Predictive Connector Router — Proxy Family
 *
 * AI-powered connector recommendations, pathway optimization, ecosystem analysis.
 * Governance enforced at proxy mount boundary.
 */

import { Router, Request, Response } from 'express';
import type { AIPredictiveConnectorService } from '../../services/AIPredictiveConnectorService';
import type { Logger } from '../../utils/Logger';

export interface PredictiveConnectorRouterDependencies {
  logger: Logger;
  predictiveConnectorService: AIPredictiveConnectorService;
}

export function createPredictiveConnectorRouter(deps: PredictiveConnectorRouterDependencies): Router {
  const { logger, predictiveConnectorService } = deps;
  const router = Router();

  router.post('/recommendations', async (req: Request, res: Response): Promise<void> => {
    try {
      const { currentSystems, industry, companySize, businessGoals } = req.body;
      if (!currentSystems || !industry || !companySize) {
        res.status(400).json({ error: 'Current systems, industry, and company size are required' });
        return;
      }
      const recommendations = await predictiveConnectorService.generateRecommendations(currentSystems, industry, companySize, businessGoals || []);
      res.json({ success: true, recommendations, totalRecommendations: recommendations.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Connector recommendations error:', error);
      res.status(500).json({ error: 'Failed to generate connector recommendations', details: (error as Error).message });
    }
  });

  router.post('/predict-next', async (req: Request, res: Response): Promise<void> => {
    try {
      const { currentSystems, industry, growthStage } = req.body;
      if (!currentSystems || !industry) {
        res.status(400).json({ error: 'Current systems and industry are required' });
        return;
      }
      const predictions = await predictiveConnectorService.predictNextIntegrations(currentSystems, industry, growthStage || 'growth');
      res.json({ success: true, predictions, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Next integrations prediction error:', error);
      res.status(500).json({ error: 'Failed to predict next integrations', details: (error as Error).message });
    }
  });

  router.post('/optimize-pathway', async (req: Request, res: Response): Promise<void> => {
    try {
      const { sourceSystems, targetSystems, constraints } = req.body;
      if (!sourceSystems || !targetSystems) {
        res.status(400).json({ error: 'Source and target systems are required' });
        return;
      }
      const pathways = await predictiveConnectorService.optimizeIntegrationPathway(sourceSystems, targetSystems, constraints || {});
      res.json({ success: true, pathways, totalPathways: pathways.length, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('Integration pathway optimization error:', error);
      res.status(500).json({ error: 'Failed to optimize integration pathway', details: (error as Error).message });
    }
  });

  router.post('/analyze-ecosystem', async (req: Request, res: Response): Promise<void> => {
    try {
      const { systems } = req.body;
      if (!systems || !Array.isArray(systems)) {
        res.status(400).json({ error: 'Systems array is required' });
        return;
      }
      const analysis = await predictiveConnectorService.analyzeSystemEcosystem(systems);
      res.json({ success: true, analysis, timestamp: new Date().toISOString() });
    } catch (error) {
      logger.error('System ecosystem analysis error:', error);
      res.status(500).json({ error: 'Failed to analyze system ecosystem', details: (error as Error).message });
    }
  });

  return router;
}
