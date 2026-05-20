/**
 * Help Chat Routes
 * API endpoints for natural language documentation help
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/Logger';
import { extractIdentityContext } from '../services/governance/identityContext';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import type { HelpChatService } from '../services/help/HelpChatService';
import type { DocumentationKnowledgeBase } from '../services/help/DocumentationKnowledgeBase';
import type { UnifiedTelemetryService } from '../services/UnifiedTelemetryService';
import type { GovernanceService } from '../services/ai/orchestrator/GovernanceService';

// Rate limiting for help chat endpoints
const helpChatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per 15 minutes
  message: 'Too many help requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Create help routes
 */
export function createHelpRouter(
  helpChatService: HelpChatService,
  knowledgeBase: DocumentationKnowledgeBase,
  telemetry?: UnifiedTelemetryService,
  governance?: GovernanceService
): Router {
  const router = Router();

  /**
   * POST /api/help/chat
   * Send a help chat message and get AI response
   */
  router.post('/chat', helpChatRateLimit, asyncHandler(async (req: Request, res: Response) => {
    const { message, sessionId } = req.body;
    const startTime = Date.now();

    // Validate request
    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({
        success: false,
        error: 'Message is required and must be a non-empty string'
      });
      return;
    }

    if (message.length > 2000) {
      res.status(400).json({
        success: false,
        error: 'Message is too long (max 2000 characters)'
      });
      return;
    }

    try {
      // Governance check (if available and has canExecute method)
      if (governance && typeof (governance as any).canExecute === 'function') {
        const isAllowed = await (governance as any).canExecute({
          providerId: 'help-chat',
          modelId: 'help-assistant',
          estimatedCost: 0.003,
          estimatedTokens: 1000
        });

        if (!isAllowed) {
          logger.warn('Help chat request blocked by governance', {
            ip: req.ip,
            message: message.substring(0, 100)
          });

          res.status(429).json({
            success: false,
            error: 'Help chat is temporarily unavailable due to governance policies'
          });
          return;
        }
      }

      // Process message
      const identity = extractIdentityContext(req);
      const response = await helpChatService.processMessage({
        message,
        sessionId
      }, identity);

      const duration = Date.now() - startTime;

      // Record telemetry
      if (telemetry && typeof (telemetry as any).recordMetric === 'function') {
        (telemetry as any).recordMetric('help.chat.request', 1, {
          sessionId: response.sessionId,
          duration,
          sourcesFound: response.sources.length
        });
      }

      logger.info('Help chat request completed', {
        sessionId: response.sessionId,
        duration,
        sourcesFound: response.sources.length
      });

      res.json({
        success: true,
        data: response
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'help.chat',
        resourceId: 'new',
      })) return;
      logger.error('Help chat request failed', { error, message: message.substring(0, 100) });

      // Record error telemetry
      if (telemetry && typeof (telemetry as any).recordMetric === 'function') {
        (telemetry as any).recordMetric('help.chat.error', 1, {
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }

      res.status(500).json({
        success: false,
        error: error instanceof Error ? error.message : 'Failed to process help request'
      });
    }
  }));

  /**
   * GET /api/help/status
   * Get documentation indexing status and health
   */
  router.get('/status', asyncHandler(async (_req: Request, res: Response) => {
    try {
      const stats = await knowledgeBase.getStats();
      const progress = knowledgeBase.getIndexingProgress();
      const isReady = knowledgeBase.isReady();

      res.json({
        success: true,
        data: {
          ready: isReady,
          stats,
          progress: {
            status: progress.status,
            indexed: progress.indexed,
            total: progress.total,
            failed: progress.failed
          }
        }
      });
    } catch (error) {
      logger.error('Failed to get help status', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to get help status'
      });
    }
  }));

  /**
   * POST /api/help/reindex
   * Trigger documentation re-indexing (no auth required in development)
   */
  router.post('/reindex', asyncHandler(async (_req: Request, res: Response) => {
    try {
      logger.info('Manual documentation re-index triggered');

      // Clear existing index
      await knowledgeBase.clear();

      // Start re-indexing in background
      knowledgeBase.indexDocumentation().catch(error => {
        logger.error('Background re-indexing failed', { error });
      });

      res.json({
        success: true,
        message: 'Documentation re-indexing started in background',
        data: {
          status: 'started',
          jobId: `reindex-${Date.now()}`
        }
      });
    } catch (error) {
      logger.error('Failed to trigger re-index', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to trigger documentation re-indexing'
      });
    }
  }));

  /**
   * GET /api/help/session/:sessionId
   * Get conversation history for a session
   */
  router.get('/session/:sessionId', asyncHandler(async (req: Request, res: Response) => {
    const { sessionId } = req.params;

    try {
      const session = helpChatService.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: 'Session not found or expired'
        });
        return;
      }

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          messages: session.messages,
          createdAt: session.createdAt,
          lastActivityAt: session.lastActivityAt
        }
      });
    } catch (error) {
      logger.error('Failed to get session', { error, sessionId });

      res.status(500).json({
        success: false,
        error: 'Failed to get session'
      });
    }
  }));

  return router;
}
