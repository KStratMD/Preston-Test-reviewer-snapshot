/**
 * Provider Router - AI Provider Management Endpoints
 * Handles provider status, model management, and provider testing
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import type { Logger } from '../../utils/Logger';
import { ProviderRegistry } from '../../services/ai/ProviderRegistry';
import { ModelCatalogService } from '../../services/ai/ModelCatalogService';

export interface ProviderRouterDependencies {
  logger: Logger;
  registry: ProviderRegistry;
  modelCatalog: ModelCatalogService;
}

export async function createProviderRouter(deps: ProviderRouterDependencies): Promise<Router> {
  const router = Router();
  const { logger, registry, modelCatalog } = deps;

  /**
   * GET /api/ai/proxy/status - Get AI proxy service status
   */
  router.get('/status', asyncHandler(async (req: Request, res: Response) => {
    const providers = registry.listProviders();
    const availableCount = providers.filter(p => p.available).length;

    res.json({
      success: true,
      status: 'operational',
      timestamp: new Date().toISOString(),
      providers: {
        total: providers.length,
        available: availableCount,
        unavailable: providers.length - availableCount
      },
      telemetry: {
        enabled: true
      },
      rateLimiting: {
        enabled: true,
        windowMs: 15 * 60 * 1000,
        maxRequests: 100
      }
    });
  }));

  /**
   * GET /api/ai/providers - List available AI providers
   */
  router.get('/providers', asyncHandler(async (req: Request, res: Response) => {
    const providers = registry.listProviders();

    // Test connectivity for each provider
    const providersWithStatus = await Promise.all(
      providers.map(async (p) => {
        const provider = registry.getProvider(p.id);
        if (provider) {
          const test = await provider.testConnection();
          return { ...p, available: test.ok, status: test.message };
        }
        return { ...p, available: false, status: 'Provider not found' };
      })
    );

    res.json({
      success: true,
      providers: providersWithStatus,
      timestamp: new Date().toISOString()
    });
  }));

  /**
   * GET /api/ai/models (aggregate) - Unified model catalog across providers
   * Query params: refresh=true forces re-fetch for each provider
   * NOTE: Registered before /models/:provider to prevent Express matching 'active'
   * as a provider parameter (static routes must precede parameterized ones).
   */
  router.get('/models', asyncHandler(async (req: Request, res: Response) => {
    try {
      const refresh = req.query.refresh === 'true';
      // If client passes dynamic=true, enable dynamic capability introspection (runtime provider probing)
      const dynamic = req.query.dynamic === 'true';
      const aggregate = await modelCatalog.aggregate(refresh, dynamic);
      res.json({ success: true, ...(aggregate as any) });
    } catch (err) {
      logger.error('Failed to build aggregate model catalog', { error: String(err) });
      res.status(500).json({ success: false, error: 'Failed to build aggregate model catalog' });
    }
  }));

  /**
   * GET /api/ai/models/active - Lightweight active model snapshot
   * NOTE: Registered before /models/:provider to prevent Express matching 'active'
   * as a provider parameter (static routes must precede parameterized ones).
   */
  router.get('/models/active', asyncHandler(async (_req: Request, res: Response) => {
    try {
      const aggregate = await modelCatalog.aggregate(false);
      res.json({ success: true, active: (aggregate as any).active, activeModels: (aggregate as any).activeModels, timestamp: new Date().toISOString() });
    } catch (err) {
      logger.error('Failed to get active model snapshot', { error: String(err) });
      res.status(500).json({ success: false, error: 'Failed to get active model snapshot' });
    }
  }));

  /**
   * GET /api/ai/models/:provider - List models for a provider (dynamic catalog)
   * Query params: refresh=true to bypass cache, search=substring to filter
   */
  router.get('/models/:provider', asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider as any;
    const allowedProviders = ['openai','anthropic','grok','gemini','lmstudio','openrouter'];
    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ success: false, error: `Invalid provider. Use one of: ${allowedProviders.join(', ')}` });
    }
    const refresh = req.query.refresh === 'true';
    const search = (req.query.search as string) || undefined;
    try {
      const models = await modelCatalog.listModels(provider, { refresh, search });
      res.json({
        success: true,
        provider,
        activeModel: modelCatalog.getActiveModel(provider),
        count: models.length,
        models,
        cached: !refresh,
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      res.status(500).json({ success: false, error: 'Failed to list models', details: String(err) });
    }
  }));

  /**
   * GET /api/ai/models/:provider/capabilities - Capability metadata for a provider's known models
   */
  router.get('/models/:provider/capabilities', asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider as any;
    const allowedProviders = ['openai','anthropic','grok','gemini','lmstudio','openrouter'];
    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ success: false, error: `Invalid provider. Use one of: ${allowedProviders.join(', ')}` });
    }
    try {
      // Leverage aggregate to avoid duplicating capability logic
      const aggregate = await modelCatalog.aggregate(false);
      const entry = (aggregate as any).providers?.[provider];
      if (!entry) {
        return res.status(404).json({ success: false, error: 'Provider not found in catalog' });
      }
      res.json({
        success: true,
        provider,
        activeModel: entry.activeModel,
        capabilityCount: Object.keys(entry.capabilities || {}).length,
        capabilities: entry.capabilities || {},
        timestamp: new Date().toISOString()
      });
    } catch (err) {
      logger.error('Failed to get provider capabilities', { provider, error: String(err) });
      res.status(500).json({ success: false, error: 'Failed to get capabilities' });
    }
  }));

  /**
   * POST /api/ai/models/:provider/select - Switch active model at runtime
   * Body: { modelId: string, test?: boolean }
   */
  router.post('/models/:provider/select', asyncHandler(async (req: Request, res: Response) => {
    const provider = req.params.provider as any;
    const { modelId, test } = req.body || {};
    const allowedProviders = ['openai','anthropic','grok','gemini','lmstudio','openrouter'];
    if (!allowedProviders.includes(provider)) {
      return res.status(400).json({ success: false, error: `Invalid provider. Use one of: ${allowedProviders.join(', ')}` });
    }
    if (!modelId) {
      return res.status(400).json({ success: false, error: 'Missing required field: modelId' });
    }
  const result = await modelCatalog.setActiveModel(provider, modelId);
    if (!result.ok) {
      return res.status(500).json({ success: false, error: result.message });
    }
    let connectivity: unknown = undefined;
    if (test) {
      try {
  const providerMap: Record<string,string> = { anthropic: 'claude' };
  const registryId = providerMap[provider] || provider;
  const reg = registry.getProvider(registryId);
        if (reg) {
          connectivity = await reg.testConnection();
        }
      } catch (err) {
        connectivity = { ok: false, message: String(err) };
      }
    }
    res.json({
      success: true,
      provider,
      modelId,
      activeModel: modelCatalog.getActiveModel(provider),
      connectivity,
      message: result.message,
      timestamp: new Date().toISOString()
    });
  }));

  return router;
}
