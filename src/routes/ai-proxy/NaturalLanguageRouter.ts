/**
 * Natural Language Router — Proxy Family
 *
 * Handles AI-powered natural language configuration, troubleshooting, and documentation.
 * Auth and governance handled at the proxy mount boundary.
 */

import { Router, Request, Response } from 'express';
import type { AINaturalLanguageService } from '../../services/AINaturalLanguageService';
import type { Logger } from '../../utils/Logger';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';

export interface NaturalLanguageRouterDependencies {
  logger: Logger;
  naturalLanguageService: AINaturalLanguageService;
}

export function createNaturalLanguageRouter(deps: NaturalLanguageRouterDependencies): Router {
  const { logger, naturalLanguageService } = deps;
  const router = Router();

  // Process natural language configuration request
  router.post('/configure', async (req: Request, res: Response): Promise<void> => {
    try {
      const { text, context, userId, sessionId } = req.body;

      if (!text) {
        res.status(400).json({
          error: 'Text input is required'
        });
        return;
      }

      const response = await naturalLanguageService.processConfigurationRequest({
        text,
        context,
        userId,
        sessionId
      });

      res.json({
        success: true,
        response,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.nl.configure',
        resourceId: 'new',
      })) return;
      logger.error('Natural language configuration error:', error);
      res.status(500).json({
        error: 'Failed to process natural language configuration',
        details: (error as Error).message
      });
    }
  });

  // Natural language troubleshooting
  router.post('/troubleshoot', async (req: Request, res: Response): Promise<void> => {
    try {
      const { issue, context } = req.body;

      if (!issue) {
        res.status(400).json({
          error: 'Issue description is required'
        });
        return;
      }

      const response = await naturalLanguageService.troubleshootWithNL(issue, context);

      res.json({
        success: true,
        troubleshooting: response,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.nl.troubleshoot',
        resourceId: 'new',
      })) return;
      logger.error('Natural language troubleshooting error:', error);
      res.status(500).json({
        error: 'Failed to process troubleshooting request',
        details: (error as Error).message
      });
    }
  });

  // Generate documentation
  router.get('/documentation/:integrationId', async (req: Request, res: Response): Promise<void> => {
    try {
      const integrationId = req.params.integrationId as string;

      const documentation = await naturalLanguageService.generateDocumentation(integrationId);

      res.json({
        success: true,
        documentation,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Documentation generation error:', error);
      res.status(500).json({
        error: 'Failed to generate documentation',
        details: (error as Error).message
      });
    }
  });

  // Explain configuration
  router.get('/explain/:configId', async (req: Request, res: Response): Promise<void> => {
    try {
      const configId = req.params.configId as string;

      const explanation = await naturalLanguageService.explainConfiguration(configId);

      res.json({
        success: true,
        explanation,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      logger.error('Configuration explanation error:', error);
      res.status(500).json({
        error: 'Failed to explain configuration',
        details: (error as Error).message
      });
    }
  });

  return router;
}
