import { Router } from 'express';
import type { Request as ExpressRequest } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { DemoModeService } from '../services/DemoModeService';
import { UserSettingsService } from '../services/UserSettingsService';
import type { MCPUserSettingsService } from '../services/settings/MCPUserSettingsService';
import type { TrainingDataRepository } from '../services/ai/TrainingDataRepository';
import { logger } from '../utils/Logger';

// Replace (rather than intersect) the global Express.Request user property:
// the global augmentation in src/types/express/index.d.ts declares
// `user?: Express.User` with `id?: number`, while the JWT middleware in
// this project sets id as a string from the sub claim. Intersecting with
// `id?: string` would collapse to `never` and silently hide the value.
interface AuthedUser {
  id?: string;
  email?: string;
  sub?: string;
}
type AuthedRequest = Omit<ExpressRequest, 'user'> & { user?: AuthedUser };

export async function createSettingsRouter(): Promise<Router> {
  const router = Router();
  const demoModeService = await container.getAsync<DemoModeService>(TYPES.DemoModeService);
  const userSettings = await container.getAsync<UserSettingsService>(TYPES.UserSettingsService);

  router.get('/demo-mode', async (req, res, next) => {
    try {
      const enabled = await demoModeService.getDemoMode();
      res.json({ enabled });
    } catch (error) {
      next(error);
    }
  });

  router.post('/demo-mode', async (req: AuthedRequest, res, next) => {
    try {
      const { enabled } = req.body ?? {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'enabled must be a boolean.'
        });
      }

      const userId =
        req.user?.id ??
        req.user?.email ??
        req.user?.sub;

      await demoModeService.setDemoMode(enabled, { userId });
      res.json({ success: true, enabled });
    } catch (error) {
      logger.error('Failed to update demo mode setting', {
        error: error instanceof Error ? error.message : String(error)
      });
      next(error);
    }
  });

  // AI dataset preference (server-side persisted)
  router.get('/ai/dataset', async (req: AuthedRequest, res, next) => {
    /**
     * @openapi
     * /api/settings/ai/dataset:
     *   get:
     *     summary: Get active AI dataset preference
     *     tags: [Settings]
     *     responses:
     *       200:
     *         description: Active datasetId
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 datasetId:
     *                   type: string
     */
    try {
      const userId = req.user?.id ?? req.user?.email ?? req.user?.sub;
      const datasetId = await userSettings.getDataset(userId) || 'default';
      res.json({ datasetId });
    } catch (error) {
      next(error);
    }
  });

  router.post('/ai/dataset', async (req: AuthedRequest, res, next) => {
    /**
     * @openapi
     * /api/settings/ai/dataset:
     *   post:
     *     summary: Set active AI dataset preference
     *     tags: [Settings]
     *     requestBody:
     *       required: true
     *       content:
     *         application/json:
     *           schema:
     *             type: object
     *             required: [datasetId]
     *             properties:
     *               datasetId:
     *                 type: string
     *     responses:
     *       200:
     *         description: Preference saved
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 success:
     *                   type: boolean
     *                 datasetId:
     *                   type: string
     *       400:
     *         description: Invalid request
     */
    try {
      const { datasetId } = req.body ?? {};
      if (!datasetId || typeof datasetId !== 'string') {
        return res.status(400).json({ success: false, error: 'invalid_request', message: '`datasetId` must be a non-empty string.' });
      }
      const userId = req.user?.id ?? req.user?.email ?? req.user?.sub;
      await userSettings.setDataset(datasetId, userId);
      res.json({ success: true, datasetId });
    } catch (error) {
      next(error);
    }
  });

  router.get('/ai/datasets', async (req, res, next) => {
    /**
     * @openapi
     * /api/settings/ai/datasets:
     *   get:
     *     summary: List available AI training datasets
     *     tags: [Settings]
     *     responses:
     *       200:
     *         description: Datasets list
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 datasets:
     *                   type: array
     *                   items:
     *                     type: object
     *                     properties:
     *                       id: { type: string }
     *                       name: { type: string }
     *                       exampleCount: { type: integer }
     *                       updatedAt: { type: string, format: date-time }
     */
    try {
      const trainingRepo = container.get<TrainingDataRepository>(TYPES.TrainingDataRepository);
      const datasets = await trainingRepo.listDatasets();
      res.json({ datasets });
    } catch (error) {
      // Fail-open: return empty list to keep UI functional
      try {
        res.json({ datasets: [] });
      } catch (err) {
        next(err);
      }
    }
  });

  // Get sample training examples for a dataset (for quick inspection)
  router.get('/ai/datasets/:id/examples', async (req, res, next) => {
    /**
     * @openapi
     * /api/settings/ai/datasets/{id}/examples:
     *   get:
     *     summary: Get sample training examples for a dataset
     *     tags: [Settings]
     *     parameters:
     *       - in: path
     *         name: id
     *         required: true
     *         schema:
     *           type: string
     *         description: Dataset identifier
     *       - in: query
     *         name: limit
     *         required: false
     *         schema:
     *           type: integer
     *           minimum: 1
     *           maximum: 25
     *         description: Maximum number of examples (default 5)
     *     responses:
     *       200:
     *         description: Examples list (may be empty)
     *         content:
     *           application/json:
     *             schema:
     *               type: object
     *               properties:
     *                 examples:
     *                   type: array
     *                   items:
     *                     type: object
     */
    try {
      const datasetId = req.params.id;
      const limit = Math.max(1, Math.min(25, parseInt(String(req.query.limit || '5'), 10) || 5));
      const trainingRepo = container.get<TrainingDataRepository>(TYPES.TrainingDataRepository);
      const examples = await trainingRepo.getTrainingExamples({ datasetId, limit });
      res.json({ examples });
    } catch (error) {
      // Fail-open: return empty examples list
      try {
        res.json({ examples: [] });
      } catch (err) {
        next(err);
      }
    }
  });

  // MCP User Settings Endpoints (Phase 3 Week 3)
  const mcpSettingsService = await container.getAsync<MCPUserSettingsService>(TYPES.MCPUserSettingsService);

  router.get('/mcp', async (req: AuthedRequest, res, next) => {
    try {
      const userId =
        req.user?.id ??
        req.user?.email ??
        req.user?.sub ??
        'default';

      const settings = await mcpSettingsService.getUserSettings(userId);

      res.json({
        schema: settings.mcp_schema_enabled,
        aiContext: settings.mcp_ai_context_enabled,
        validation: settings.mcp_validation_enabled,
        gateway: settings.mcp_gateway_enabled,
        businessCentral: settings.mcp_bc_enabled
      });
    } catch (error) {
      logger.error('Failed to get MCP settings', {
        error: error instanceof Error ? error.message : String(error)
      });
      next(error);
    }
  });

  router.post('/mcp', async (req: AuthedRequest, res, next) => {
    try {
      const userId =
        req.user?.id ??
        req.user?.email ??
        req.user?.sub ??
        'default';

      const { schema, aiContext, validation, gateway, businessCentral } = req.body ?? {};

      // Validate at least one setting is provided
      if (
        typeof schema !== 'boolean' &&
        typeof aiContext !== 'boolean' &&
        typeof validation !== 'boolean' &&
        typeof gateway !== 'boolean' &&
        typeof businessCentral !== 'boolean'
      ) {
        return res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'At least one MCP setting (schema, aiContext, validation, gateway, businessCentral) must be provided as a boolean.'
        });
      }

      const update = {
        ...(typeof schema === 'boolean' ? { mcp_schema_enabled: schema } : {}),
        ...(typeof aiContext === 'boolean' ? { mcp_ai_context_enabled: aiContext } : {}),
        ...(typeof validation === 'boolean' ? { mcp_validation_enabled: validation } : {}),
        ...(typeof gateway === 'boolean' ? { mcp_gateway_enabled: gateway } : {}),
        ...(typeof businessCentral === 'boolean' ? { mcp_bc_enabled: businessCentral } : {}),
      };

      const updated = await mcpSettingsService.updateUserSettings(userId, update);

      res.json({
        success: true,
        schema: updated.mcp_schema_enabled,
        aiContext: updated.mcp_ai_context_enabled,
        validation: updated.mcp_validation_enabled,
        gateway: updated.mcp_gateway_enabled,
        businessCentral: updated.mcp_bc_enabled
      });
    } catch (error) {
      logger.error('Failed to update MCP settings', {
        error: error instanceof Error ? error.message : String(error)
      });
      next(error);
    }
  });

  router.post('/mcp/reset', async (req: AuthedRequest, res, next) => {
    try {
      const userId =
        req.user?.id ??
        req.user?.email ??
        req.user?.sub ??
        'default';

      await mcpSettingsService.resetToDefaults(userId);

      res.json({ success: true, message: 'MCP settings reset to defaults' });
    } catch (error) {
      logger.error('Failed to reset MCP settings', {
        error: error instanceof Error ? error.message : String(error)
      });
      next(error);
    }
  });

  return router;
}
