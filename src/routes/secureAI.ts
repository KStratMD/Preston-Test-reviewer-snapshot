/**
 * Secure AI API Routes - Server-side AI operations
 * Phase 1 Implementation: Secure proxy for AI providers
 * Eliminates client-side API key exposure
 */

import { Router, Request, Response } from 'express';
import { injectable } from 'inversify';
import { TYPES } from '../inversify/types';
import { container } from '../inversify/inversify.config';
import { logger, type Logger } from '../utils/Logger';
import { SecureAIService, type AIServiceRequest } from '../services/ai/SecureAIService';
import rateLimit from 'express-rate-limit';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

// AuthenticatedRequest uses the global Request.user augmentation (src/types/express.d.ts)
export type AuthenticatedRequest = Request;

/**
 * Rate limiting for AI endpoints to prevent abuse
 */
const aiRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 AI requests per windowMs
  message: {
    error: 'Too many AI requests from this IP, please try again later.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const premiumAIRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500, // Higher limit for authenticated users
  message: {
    error: 'AI rate limit exceeded, please try again later.',
    retryAfter: '15 minutes'
  },
  skip: (req) => !(req as AuthenticatedRequest).user, // Only apply to authenticated users
  standardHeaders: true,
  legacyHeaders: false,
});

@injectable()
export class SecureAIController {
  private readonly router: Router;

  constructor(
    private readonly logger: Logger,
    private readonly aiService: SecureAIService
  ) {
    this.router = Router();
    this.setupRoutes();
  }

  private setupRoutes(): void {
    // Apply rate limiting to all AI routes
    this.router.use(aiRateLimit);
    this.router.use(premiumAIRateLimit);

    // Initialize AI service
    this.router.use(async (req, res, next) => {
      try {
        await this.aiService.initialize();
        next();
      } catch (error) {
        this.logger.error('AI service initialization failed', error);
        res.status(503).json({
          error: 'AI service temporarily unavailable',
          message: 'Please try again later'
        });
      }
    });

    // Field mapping suggestions
    this.router.post('/mapping/suggestions', this.handleMappingSuggestions.bind(this));

    // Data quality analysis
    this.router.post('/quality/analyze', this.handleDataQualityAnalysis.bind(this));

    // Provider health check
    this.router.get('/providers/health', this.handleProvidersHealth.bind(this));

    // Provider list (admin only)
    this.router.get('/providers', this.handleProvidersList.bind(this));

    // AI service status
    this.router.get('/status', this.handleServiceStatus.bind(this));
  }

  /**
   * Generate field mapping suggestions
   * POST /api/ai/mapping/suggestions
   */
  private async handleMappingSuggestions(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        sourceSystem,
        targetSystem,
        sourceFields,
        targetFields,
        sampleData,
        industry,
        businessProcess,
        providerId
      } = req.body;

      // Validate required fields
      if (!sourceSystem || !targetSystem || !sourceFields || !targetFields) {
        res.status(400).json({
          error: 'Missing required fields',
          required: ['sourceSystem', 'targetSystem', 'sourceFields', 'targetFields']
        });
        return;
      }

      const request: AIServiceRequest = {
        providerId,
        operation: 'mapping',
        context: {
          sourceSystem,
          targetSystem,
          sourceFields,
          targetFields,
          sampleData,
          industry,
          businessProcess
        },
        userId: req.user?.id
      };

      const result = await this.aiService.generateMappingSuggestions(request);

      if (result.success) {
        res.json({
          success: true,
          suggestions: result.data,
          metadata: {
            providerId: result.providerId,
            responseTime: result.metadata.responseTime,
            requestId: result.metadata.requestId
          }
        });
      } else {
        res.status(422).json({
          error: 'AI mapping generation failed',
          message: result.error,
          requestId: result.metadata.requestId
        });
      }

    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'secure_ai.mapping_suggestions',
        resourceId: 'new',
      })) return;
      this.logger.error('Mapping suggestions endpoint error', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'AI mapping service encountered an error'
      });
    }
  }

  /**
   * Analyze data quality
   * POST /api/ai/quality/analyze
   */
  private async handleDataQualityAnalysis(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      const {
        sourceSystem,
        businessPurpose,
        schema,
        data,
        providerId
      } = req.body;

      // Validate required fields
      if (!sourceSystem || !businessPurpose || !schema || !data) {
        res.status(400).json({
          error: 'Missing required fields',
          required: ['sourceSystem', 'businessPurpose', 'schema', 'data']
        });
        return;
      }

      // Limit data size for analysis
      if (data.length > 1000) {
        res.status(400).json({
          error: 'Data size too large',
          message: 'Maximum 1000 records allowed for analysis',
          received: data.length
        });
        return;
      }

      const request: AIServiceRequest = {
        providerId,
        operation: 'quality',
        context: {
          sourceSystem,
          businessPurpose,
          schema
        },
        data,
        userId: req.user?.id
      };

      const result = await this.aiService.analyzeDataQuality(request);

      if (result.success) {
        res.json({
          success: true,
          assessment: result.data,
          metadata: {
            providerId: result.providerId,
            responseTime: result.metadata.responseTime,
            requestId: result.metadata.requestId
          }
        });
      } else {
        res.status(422).json({
          error: 'AI quality analysis failed',
          message: result.error,
          requestId: result.metadata.requestId
        });
      }

    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'secure_ai.quality_analyze',
        resourceId: 'new',
      })) return;
      this.logger.error('Data quality analysis endpoint error', error);
      res.status(500).json({
        error: 'Internal server error',
        message: 'AI quality analysis service encountered an error'
      });
    }
  }

  /**
   * Check provider health
   * GET /api/ai/providers/health
   */
  private async handleProvidersHealth(req: Request, res: Response): Promise<void> {
    try {
      const healthChecks = await this.aiService.testProviders();

      const overallHealth = Object.values(healthChecks).every(check => check.ok);

      res.json({
        healthy: overallHealth,
        providers: healthChecks,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.logger.error('Providers health check error', error);
      res.status(500).json({
        error: 'Health check failed',
        message: 'Unable to check provider status'
      });
    }
  }

  /**
   * List available providers (admin only)
   * GET /api/ai/providers
   */
  private async handleProvidersList(req: AuthenticatedRequest, res: Response): Promise<void> {
    try {
      // In production, add admin role check
      // if (req.user?.role !== 'admin') {
      //   res.status(403).json({ error: 'Admin access required' });
      //   return;
      // }

      const providers = this.aiService.getAvailableProviders();

      res.json({
        providers,
        count: providers.length
      });

    } catch (error) {
      this.logger.error('Providers list endpoint error', error);
      res.status(500).json({
        error: 'Failed to list providers',
        message: 'Unable to retrieve provider information'
      });
    }
  }

  /**
   * AI service status
   * GET /api/ai/status
   */
  private async handleServiceStatus(req: Request, res: Response): Promise<void> {
    try {
      const providers = this.aiService.getAvailableProviders();
      const healthChecks = await this.aiService.testProviders();

      const healthyProviders = Object.entries(healthChecks)
        .filter(([_, check]) => check.ok)
        .length;

      res.json({
        status: 'operational',
        providers: {
          total: providers.length,
          healthy: healthyProviders,
          unhealthy: providers.length - healthyProviders
        },
        capabilities: [
          'Field mapping suggestions',
          'Data quality analysis',
          'Provider fallback',
          'Rate limiting',
          'Audit logging'
        ],
        version: '1.0.0',
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.logger.error('AI service status error', error);
      res.status(500).json({
        status: 'degraded',
        error: 'Status check failed'
      });
    }
  }

  getRouter(): Router {
    return this.router;
  }
}

// Export route factory function
export function createSecureAIRoutes(logger: Logger): Router {
  const aiService = container.get<SecureAIService>(TYPES.SecureAIService);
  const controller = new SecureAIController(logger, aiService);
  return controller.getRouter();
}
