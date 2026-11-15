/**
 * AI Configuration API Routes
 * Secure backend APIs for AI provider and task-specific model configuration
 */

import { Router, Request, Response } from 'express';
import { sql } from 'kysely';
import { logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { AIConfigurationService, type AIProviderConfig, type AITaskModelConfig, type AITaskType, type AIProviderType } from '../services/ai/AIConfigurationService';
import { DatabaseService } from '../database/DatabaseService';
import { ModelCatalogService, type ProviderId } from '../services/ai/ModelCatalogService';

/**
 * Interface for AI usage statistics returned from the database
 */
interface AIUsageStat {
  providerType?: string;
  taskType?: string;
  tokensUsed?: number;
  cost?: number;
  timestamp?: Date | string;
}

/**
 * Create AI Configuration router with dependency injection
 */
function createAIConfigRouter(): Router {
  const router = Router();

  /**
   * Type extension for authenticated requests
   * Note: JWT middleware sets id as string (from sub claim)
   */
  type RequestWithUser = Request & { user?: { id?: string | number } };

  /**
   * Get user ID from authenticated request with fallback for demo mode
   * Handles string IDs from JWT (sub claim) by parsing to number
   * Falls back to 1 for demo/development mode or invalid IDs
   */
  const getUserId = (req: Request): number => {
    const request = req as RequestWithUser;
    const rawId = request.user?.id;

    if (rawId === undefined || rawId === null) {
      return 1; // Demo mode fallback
    }

    // Handle numeric IDs directly
    if (typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0) {
      return Math.floor(rawId);
    }

    // Parse string IDs from JWT
    if (typeof rawId === 'string') {
      const parsed = parseInt(rawId, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }

    // Invalid ID format - fallback to demo user
    logger.warn('Invalid user ID format in aiConfig, using demo fallback', { rawId: typeof rawId });
    return 1;
  };

  // Lazy service getter to avoid sync DI access
  const getServices = async () => {
    const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const aiConfigService = await container.getAsync<AIConfigurationService>(TYPES.AIConfigurationService);
    const modelCatalogService = await container.getAsync<ModelCatalogService>(TYPES.ModelCatalogService);
    return { dbService, aiConfigService, modelCatalogService };
  };

/**
 * Get user's AI provider configurations
 */
router.get('/api/ai-config/providers', async (req: Request, res: Response) => {
  const userId = getUserId(req);

  try {
    const { aiConfigService } = await getServices();
    const providerType = req.query.provider as AIProviderType;

    const configs = await aiConfigService.getProviderConfigs(userId, providerType);

    // Remove sensitive data before sending to client
    const sanitizedConfigs = configs.map(config => ({
      ...config,
      apiKey: config.apiKey ? '[CONFIGURED]' : undefined,
      encryptedApiKey: undefined as string | undefined
    }));

    res.json({
      success: true,
      data: sanitizedConfigs
    });

    logger.info('AI provider configurations retrieved', {
      userId: String(userId),
      providerType,
      count: configs.length
    });
  } catch (error) {
    logger.error('Failed to get AI provider configurations', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(userId),
      providerType: req.query.provider
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve AI provider configurations',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Convert boolean values to SQLite-compatible format (recursively)
 */
function convertBooleansForSQLite(obj: unknown): unknown {
  const dbType = (process.env.DB_TYPE as 'sqlite' | 'postgres') || 'sqlite';
  if (dbType !== 'sqlite') {
    return obj;
  }

  function convertNestedBooleans(value: unknown): unknown {
    if (value === null || value === undefined) {
      return value;
    }

    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }

    if (Array.isArray(value)) {
      return value.map(item => convertNestedBooleans(item));
    }

    if (typeof value === 'object') {
      const converted: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
        converted[key] = convertNestedBooleans(val);
      }
      return converted;
    }

    return value;
  }

  return convertNestedBooleans(obj);
}

/**
 * Save AI provider configuration
 */
router.post('/api/ai-config/providers', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);

    // Convert boolean values for SQLite compatibility before passing to service
    const convertedBody = convertBooleansForSQLite(req.body);

    const config: AIProviderConfig = {
      ...(convertedBody as any),
      userId
    };

    // Validate required fields
    if (!config.providerType || !config.providerName) {
      return res.status(400).json({
        success: false,
        error: 'Provider type and name are required'
      });
    }

    // Validate API key for cloud providers
    const cloudProviders = ['openai', 'claude', 'gemini', 'grok', 'openrouter'];
    const isCloudProvider = cloudProviders.includes(config.providerType);
    const hasApiKey = config.apiKey && config.apiKey.trim().length > 0;
    const isPreservingKey = (req.body as any).preserveExistingKey === true || (req.body as any).hasStoredKey === true;

    if (isCloudProvider && !hasApiKey && !isPreservingKey) {
      return res.status(400).json({
        success: false,
        error: `API key is required for ${config.providerType}. Provide an API key or enable "preserve existing key" if updating.`
      });
    }

    const savedConfig = await aiConfigService.saveProviderConfig(config);

    // Remove sensitive data before sending response
    const sanitizedConfig = {
      ...savedConfig,
      apiKey: savedConfig.apiKey ? '[CONFIGURED]' : undefined
    };

    res.json({
      success: true,
      data: sanitizedConfig,
      message: 'AI provider configuration saved successfully'
    });

    logger.info('AI provider configuration saved', {
      userId: String(userId),
      provider: config.providerType,
      configId: savedConfig.id
    });

  } catch (error) {
    logger.error('Failed to save AI provider configuration', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req)),
      provider: req.body.providerType
    });

    res.status(500).json({
      success: false,
      error: 'Failed to save AI provider configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Test AI provider connection
 */
router.post('/api/ai-config/providers/:id/test', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);
    const configId = parseInt(req.params.id);

    if (isNaN(configId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration ID'
      });
    }

    // Get the provider configuration
    const configs = await aiConfigService.getProviderConfigs(userId);
    const config = configs.find(c => c.id === configId);

    if (!config) {
      return res.status(404).json({
        success: false,
        error: 'Provider configuration not found'
      });
    }

    // Test the connection
    const testResult = await aiConfigService.testProviderConnection(config);

    res.json({
      success: testResult.success,
      data: testResult,
      message: testResult.message
    });

    logger.info('AI provider connection tested', {
      userId: String(userId),
      configId,
      provider: config.providerType,
      success: testResult.success,
      responseTime: testResult.responseTime
    });

  } catch (error) {
    logger.error('Failed to test AI provider connection', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req)),
      configId: req.params.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to test AI provider connection',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get task-specific model configurations
 */
router.get('/api/ai-config/tasks', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);
    const taskType = req.query.task as AITaskType;

    if (taskType) {
      // Get configuration for specific task
      const taskConfig = await aiConfigService.getTaskModelConfig(userId, taskType);

      res.json({
        success: true,
        data: taskConfig
      });
    } else {
      // Get all task configurations
      const taskTypes: AITaskType[] = ['field_mapping', 'quality_assessment', 'data_validation', 'transformation_suggestion', 'help_chat'];
      const allTaskConfigs = await Promise.all(
        taskTypes.map(async (task) => ({
          taskType: task,
          config: await aiConfigService.getTaskModelConfig(userId, task)
        }))
      );

      res.json({
        success: true,
        data: allTaskConfigs
      });
    }

    logger.info('Task model configurations retrieved', {
      userId: String(userId),
      taskType: taskType || 'all'
    });

  } catch (error) {
    logger.error('Failed to get task model configurations', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req)),
      taskType: req.query.task
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve task model configurations',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Save task-specific model configuration
 */
router.post('/api/ai-config/tasks', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);

    // Convert boolean values for SQLite compatibility before passing to service
    const convertedBody = convertBooleansForSQLite(req.body);

    const config: AITaskModelConfig = {
      ...(convertedBody as any),
      userId
    };

    // Validate required fields
    if (!config.taskType || !config.providerConfigId || !config.modelVersion) {
      return res.status(400).json({
        success: false,
        error: 'Task type, provider configuration ID, and model version are required'
      });
    }

    // Validate task type
    const validTaskTypes = ['field_mapping', 'quality_assessment', 'data_validation', 'transformation_suggestion', 'help_chat'];
    if (!validTaskTypes.includes(config.taskType)) {
      return res.status(400).json({
        success: false,
        error: `Invalid task type. Must be one of: ${validTaskTypes.join(', ')}`
      });
    }

    const savedConfig = await aiConfigService.saveTaskModelConfig(config);

    res.json({
      success: true,
      data: savedConfig,
      message: 'Task model configuration saved successfully'
    });

    logger.info('Task model configuration saved', {
      userId: String(userId),
      taskType: config.taskType,
      model: config.modelVersion,
      priority: config.priority
    });

  } catch (error) {
    logger.error('Failed to save task model configuration', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req)),
      taskType: req.body.taskType
    });

    res.status(500).json({
      success: false,
      error: 'Failed to save task model configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get AI usage statistics
 */
router.get('/api/ai-config/usage', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);
    const startDate = req.query.start ? new Date(req.query.start as string) : undefined;
    const endDate = req.query.end ? new Date(req.query.end as string) : undefined;

    const stats = await aiConfigService.getUsageStats(userId, startDate, endDate);

    res.json({
      success: true,
      data: stats,
      meta: {
        userId,
        startDate,
        endDate,
        totalRecords: stats.length
      }
    });

    logger.info('AI usage statistics retrieved', {
      userId: String(userId),
      startDate,
      endDate,
      recordCount: stats.length
    });

  } catch (error) {
    logger.error('Failed to get AI usage statistics', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req))
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve AI usage statistics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});


/**
 * Get AI usage summary (aggregated totals)
 */
router.get('/api/ai-config/usage/summary', async (req: Request, res: Response) => {
  try {
    const { aiConfigService } = await getServices();
    const userId = getUserId(req);
    const startDate = req.query.start ? new Date(req.query.start as string) : undefined;
    const endDate = req.query.end ? new Date(req.query.end as string) : undefined;

    const stats = await aiConfigService.getUsageStats(userId, startDate, endDate);

    // Cast stats to proper type for aggregation
    const typedStats = stats as AIUsageStat[];

    // Aggregate the statistics
    const summary = {
      totalRequests: typedStats.length,
      totalTokens: typedStats.reduce((sum: number, stat: AIUsageStat) => sum + (stat.tokensUsed || 0), 0),
      totalCost: typedStats.reduce((sum: number, stat: AIUsageStat) => sum + (stat.cost || 0), 0),
      byProvider: {} as Record<string, { requests: number; tokens: number; cost: number }>,
      byTask: {} as Record<string, { requests: number; tokens: number; cost: number }>,
      period: {
        start: startDate || (typedStats.length > 0 ? typedStats[0].timestamp : null),
        end: endDate || (typedStats.length > 0 ? typedStats[typedStats.length - 1].timestamp : null)
      }
    };

    // Group by provider
    typedStats.forEach((stat: AIUsageStat) => {
      const provider = stat.providerType || 'unknown';
      if (!summary.byProvider[provider]) {
        summary.byProvider[provider] = { requests: 0, tokens: 0, cost: 0 };
      }
      summary.byProvider[provider].requests++;
      summary.byProvider[provider].tokens += stat.tokensUsed || 0;
      summary.byProvider[provider].cost += stat.cost || 0;
    });

    // Group by task
    typedStats.forEach((stat: AIUsageStat) => {
      const task = stat.taskType || 'unknown';
      if (!summary.byTask[task]) {
        summary.byTask[task] = { requests: 0, tokens: 0, cost: 0 };
      }
      summary.byTask[task].requests++;
      summary.byTask[task].tokens += stat.tokensUsed || 0;
      summary.byTask[task].cost += stat.cost || 0;
    });

    res.json({
      success: true,
      ...summary,
      meta: {
        userId,
        startDate,
        endDate
      }
    });

    logger.info('AI usage summary retrieved', {
      userId: String(userId),
      totalRequests: summary.totalRequests,
      totalCost: summary.totalCost
    });

  } catch (error) {
    logger.error('Failed to get AI usage summary', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req))
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve AI usage summary',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Delete/deactivate AI provider configuration
 */
router.delete('/api/ai-config/providers/:id', async (req: Request, res: Response) => {
  try {
    const { dbService } = await getServices();
    const userId = getUserId(req);
    const configId = parseInt(req.params.id);

    if (isNaN(configId)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid configuration ID'
      });
    }

    // Soft delete by setting is_active = false
    const result = await sql`
      UPDATE ai_provider_configs
      SET is_active = false, updated_at = ${new Date()}
      WHERE id = ${configId} AND user_id = ${userId}
      RETURNING *
    `.execute(dbService.getDatabase());

    if (result.rows.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'Provider configuration not found'
      });
    }

    res.json({
      success: true,
      message: 'Provider configuration deactivated successfully'
    });

    logger.info('AI provider configuration deactivated', {
      userId: String(userId),
      configId
    });

  } catch (error) {
    logger.error('Failed to delete AI provider configuration', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId: String(getUserId(req)),
      configId: req.params.id
    });

    res.status(500).json({
      success: false,
      error: 'Failed to delete AI provider configuration',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

/**
 * Get available models for a provider type
 */
router.get('/api/ai-config/models/:providerType', async (req: Request, res: Response) => {
  try {
    const providerType = req.params.providerType as AIProviderType;
    const refresh = req.query.refresh === 'true';

    // Map AIProviderType to ProviderId
    const providerIdMap: Record<string, ProviderId> = {
      'openai': 'openai',
      'claude': 'anthropic',
      'gemini': 'gemini',
      'lmstudio': 'lmstudio',
      'grok': 'grok',
      'openrouter': 'openrouter'
    };

    const providerId = providerIdMap[providerType];

    // For rule-based provider, return static list (no LLM)
    if (providerType === 'rule-based') {
      const models = [
        { id: 'rule-based-v1', name: 'Rule-Based Engine v1', description: 'Deterministic field mapping algorithm' }
      ];

      res.json({
        success: true,
        data: {
          providerType,
          models,
          cached: false
        }
      });

      logger.debug('Available models retrieved (rule-based)', {
        providerType,
        modelCount: models.length
      });

      return;
    }

    // Use ModelCatalogService for dynamic model fetching
    if (providerId) {
      const { modelCatalogService } = await getServices();
      const modelInfos = await modelCatalogService.listModels(providerId, { refresh });

      // Map ModelInfo to the expected format
      const models = modelInfos.map(info => ({
        id: info.id,
        name: info.id, // Use id as name for now
        description: `Context: ${info.contextWindow || 'N/A'}, ${info.supports?.join(', ') || 'No features listed'}`
      }));

      res.json({
        success: true,
        data: {
          providerType,
          models,
          cached: !refresh
        }
      });

      logger.debug('Available models retrieved (dynamic)', {
        providerType,
        providerId,
        modelCount: models.length,
        refresh
      });

      return;
    }

    // Fallback: provider not supported
    res.status(400).json({
      success: false,
      error: `Provider '${providerType}' is not supported for dynamic model listing`
    });

  } catch (error) {
    logger.error('Failed to get available models', {
      error: error.message,
      providerType: req.params.providerType
    });

    res.status(500).json({
      success: false,
      error: 'Failed to retrieve available models',
      message: error.message
    });
  }
});

/**
 * Health check endpoint for AI configuration service
 */
router.get('/api/ai-config/health', async (req: Request, res: Response) => {
  try {
    const { dbService } = await getServices();
    // Test database connection
    const dbTest = await sql`SELECT 1 as test`.execute(dbService.getDatabase());
    const dbHealthy = dbTest.rows.length > 0;

    res.json({
      success: true,
      data: {
        service: 'AI Configuration Service',
        status: 'healthy',
        timestamp: new Date().toISOString(),
        database: dbHealthy ? 'connected' : 'disconnected',
        features: {
          providerConfig: true,
          taskModelConfig: true,
          encryption: true,
          usageTracking: true,
          auditLogging: true
        }
      }
    });

  } catch (error) {
    logger.error('AI configuration service health check failed', {
      error: error.message
    });

    res.status(500).json({
      success: false,
      error: 'AI configuration service health check failed',
      message: error.message
    });
  }
});

  return router;
}

export { createAIConfigRouter };
export default createAIConfigRouter;
