/**
 * Help Chat Routes
 * API endpoints for natural language documentation help
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import rateLimit from 'express-rate-limit';
import { logger } from '../utils/Logger';
import { isAnonymousRequest } from '../middleware/aiProxyPolicyGate';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';
import type { HelpChatService } from '../services/help/HelpChatService';
import { InternalAudienceAuthorizationError } from '../services/help/HelpChatService';
import type { DocumentationKnowledgeBase } from '../services/help/DocumentationKnowledgeBase';
import type { UnifiedTelemetryService } from '../services/UnifiedTelemetryService';
import type { GovernanceService } from '../services/ai/orchestrator/GovernanceService';
import type { HelpChatContext } from '../services/help/types';
import { HELP_AUDIENCES } from '../services/help/types';

// Rate limiting for help chat endpoints
const helpChatRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 50, // Limit each IP to 50 requests per 15 minutes
  message: 'Too many help requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
});

const VALID_AUDIENCES: ReadonlySet<string> = new Set<string>(HELP_AUDIENCES);
const MAX_SURFACE_LEN = 80;
const NODE_ID_RE = /^[a-z0-9-]{1,80}$/;
const MAX_CORPUS_ENTRIES = 10;
const MAX_CORPUS_ENTRY_LEN = 80;
const DEMO_INDEX_WARMING_FALLBACK = 'The help index is still warming up — try the documentation links…';

function requestIdentity(req: Request): { tenantId: string; userId: string } | null {
  const rawUserId = req.user?.id;
  const rawTenantId = req.user?.tenantId;
  const userId = typeof rawUserId === 'string'
    ? rawUserId.trim()
    : typeof rawUserId === 'number'
      ? String(rawUserId)
      : '';
  const tenantId = typeof rawTenantId === 'string' ? rawTenantId.trim() : '';
  return userId.length > 0 && tenantId.length > 0 ? { tenantId, userId } : null;
}

/**
 * Type guard for an optional `context` field from an untrusted request body.
 * Returns true when the value is a valid HelpChatContext or absent (undefined).
 * Callers must normalize null → undefined before invoking (see handler).
 */
function isValidHelpChatContext(raw: unknown): raw is HelpChatContext | undefined {
  if (raw === undefined) {
    return true;
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return false;
  }

  const ctx = raw as Record<string, unknown>;
  // Own-property checks (not the `in` operator) so an inherited/prototype-
  // polluted property name can never be treated as a client-supplied field.
  const hasOwn = (key: string): boolean => Object.prototype.hasOwnProperty.call(ctx, key);

  if (hasOwn('surface')) {
    if (typeof ctx['surface'] !== 'string' || ctx['surface'].length > MAX_SURFACE_LEN) {
      return false;
    }
  }

  if (hasOwn('nodeId')) {
    if (typeof ctx['nodeId'] !== 'string' || !NODE_ID_RE.test(ctx['nodeId'])) {
      return false;
    }
  }

  if (hasOwn('audience')) {
    if (typeof ctx['audience'] !== 'string' || !VALID_AUDIENCES.has(ctx['audience'])) {
      return false;
    }
  }

  if (hasOwn('corpus')) {
    const corpus = ctx['corpus'];
    if (!Array.isArray(corpus) || corpus.length > MAX_CORPUS_ENTRIES) {
      return false;
    }
    for (const entry of corpus) {
      if (typeof entry !== 'string' || entry.length > MAX_CORPUS_ENTRY_LEN) {
        return false;
      }
    }
  }

  return true;
}

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
    const { message, sessionId, context: rawContext } = req.body as {
      message: unknown;
      sessionId: unknown;
      context: unknown;
    };
    const startTime = Date.now();

    // Validate message
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

    // Validate optional context — normalize null to undefined so the type
    // predicate's narrowed type (HelpChatContext | undefined) is honest.
    const normalizedContext = rawContext ?? undefined;
    if (!isValidHelpChatContext(normalizedContext)) {
      res.status(400).json({
        success: false,
        error: 'invalid_context'
      });
      return;
    }

    const context = normalizedContext;

    // The mount gate leaves the anonymous demo request credential-free; this
    // shared predicate selects the zero-spend local retrieval branch.
    const anonymous = isAnonymousRequest(req);
    if (context?.audience === 'internal' && anonymous) {
      res.status(403).json({
        success: false,
        error: 'internal_audience_requires_auth'
      });
      return;
    }

    if (anonymous) {
      const chunks = knowledgeBase.findSimilarChunksLocalOnly(message, 3);
      const response = chunks.length > 0
        ? chunks
          .map(chunk => `### ${chunk.title} — ${chunk.section}\n${chunk.content}`)
          .join('\n\n')
        : DEMO_INDEX_WARMING_FALLBACK;

      res.json({
        success: true,
        data: {
          response,
          sources: chunks.map(chunk => ({
            filePath: chunk.filePath,
            title: chunk.title,
            section: chunk.section,
            similarity: 1,
          })),
          sessionId: null,
          timestamp: new Date(),
          mode: 'demo_local_retrieval',
        },
      });
      return;
    }

    const identity = requestIdentity(req);
    if (!identity) {
      res.status(401).json({ success: false, error: 'identity_required' });
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

      // Process message — reuse the identity resolved above.
      const response = await helpChatService.processMessage({
        message,
        sessionId: typeof sessionId === 'string' ? sessionId : undefined,
        context
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
        duration,
        sourcesFound: response.sources.length
      });

      res.json({
        success: true,
        data: response
      });
    } catch (error) {
      // Defense in depth: the service retains the same typed internal-audience
      // authorization failure for authenticated-path callers.
      if (error instanceof InternalAudienceAuthorizationError) {
        res.status(403).json({
          success: false,
          error: 'internal_audience_requires_auth'
        });
        return;
      }
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
   * GET /api/help/audiences
   * Returns which audience scopes the caller may request.
   * Anonymous: public only. Authenticated: public + internal.
   */
  router.get('/audiences', asyncHandler(async (req: Request, res: Response) => {
    // Advertise internal access only for a complete verified request identity.
    const authenticated = requestIdentity(req) !== null;
    const allowedAudiences: string[] = authenticated ? ['public', 'internal'] : ['public'];

    res.json({
      success: true,
      data: {
        authenticated,
        allowedAudiences,
        defaultAudience: 'public'
      }
    });
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
   * Trigger documentation re-indexing (platform-admin enforced at mount)
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
    const ctx = requestIdentity(req);
    if (!ctx) {
      res.status(401).json({ success: false, error: 'identity_required' });
      return;
    }

    try {
      const session = helpChatService.getSession(sessionId, ctx);

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
      logger.error('Failed to get session', { error });

      res.status(500).json({
        success: false,
        error: 'Failed to get session'
      });
    }
  }));

  return router;
}
