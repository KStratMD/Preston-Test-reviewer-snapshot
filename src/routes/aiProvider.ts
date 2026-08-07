import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { AIProviderConfigService, type StoredAIConfig } from '../utils/ai/AIProviderConfigService';

export function createAIProviderRouter(): Router {
  const router = Router();
  const logger = container.get<Logger>(TYPES.Logger);
  const cfgService = new AIProviderConfigService(logger, container.get(TYPES.ConfigDirectory));

  router.get('/', asyncHandler(async (_req, res): Promise<void> => {
    const cfg = cfgService.getConfig();
    void res.json({ success: true, config: cfg });
  }));

  router.put('/', asyncHandler(async (req, res): Promise<void> => {
    const body = req.body || {};
    const mode = body.mode as StoredAIConfig['mode'];
    if (!['rule-based', 'cloud-api', 'local-llm'].includes(String(mode))) {
      res.status(400).json({ success: false, error: 'Invalid mode' });
      return;
    }
    const cfg: StoredAIConfig = { mode, cloud: body.cloud || {}, local: body.local || {} };
    cfgService.setConfig(cfg);
    void res.json({ success: true, config: cfg });
  }));

  router.post('/test', asyncHandler(async (_req, res): Promise<void> => {
    const provider = cfgService.getProvider(logger);
    const result = await provider.testConnection();
    void res.json({ success: result.ok, message: result.message });
  }));

  return router;
}
