import { Router } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { featureFlagService } from '../services/FeatureFlagService';

export function createFeatureFlagsRouter(): Router {
  const router = Router();

  // Get all feature flags
  router.get('/', asyncHandler(async (_req, res) => {
    const flags = featureFlagService.getAllFlags();
    res.json({ flags });
  }));

  // Get feature flags by category
  router.get('/category/:category', asyncHandler(async (req, res) => {
    const category = req.params.category as any;
    const flags = featureFlagService.getFlagsByCategory(category);
    res.json({ flags, category });
  }));

  // Check if specific flag is enabled
  router.get('/:key', asyncHandler(async (req, res) => {
    const key = req.params.key;
    const enabled = featureFlagService.isEnabled(key);
    const flag = featureFlagService.getFlag(key);

    res.json({
      key,
      enabled,
      flag: flag || null
    });
  }));

  // Update feature flag (disabled in production for security)
  router.put('/:key', asyncHandler(async (req, res) => {
    const key = req.params.key;
    const updates = req.body;

    // SECURITY: Feature flag updates are blocked in production
    // Feature flags should be managed through environment configuration or deployment pipelines
    // This prevents runtime tampering with application behavior
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        error: 'Feature flag updates are disabled in production',
        message: 'Configure feature flags via environment variables or deployment configuration'
      });
    }

    try {
      featureFlagService.updateFlag(key, updates);
      const updatedFlag = featureFlagService.getFlag(key);

      res.json({
        success: true,
        flag: updatedFlag
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(400).json({
        error: err.message
      });
    }
  }));

  // Toggle feature flag (disabled in production for security)
  router.post('/:key/toggle', asyncHandler(async (req, res) => {
    const key = req.params.key;

    // SECURITY: Feature flag toggles are blocked in production
    if (process.env.NODE_ENV === 'production') {
      return res.status(403).json({
        error: 'Feature flag toggles are disabled in production',
        message: 'Configure feature flags via environment variables or deployment configuration'
      });
    }

    try {
      const newState = featureFlagService.toggleFlag(key);
      const flag = featureFlagService.getFlag(key);

      res.json({
        success: true,
        key,
        enabled: newState,
        flag
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      res.status(400).json({
        error: err.message
      });
    }
  }));

  // Studio-specific endpoints
  router.get('/studio/status', asyncHandler(async (_req, res) => {
    const studioDeprecated = featureFlagService.isEnabled('studioDeprecated');
    const enhancedEditor = featureFlagService.isEnabled('enhancedFieldEditor');
    const shouldRedirect = featureFlagService.shouldRedirectStudioToEditor();
    const showWarning = featureFlagService.shouldShowStudioDeprecationWarning();

    res.json({
      studioDeprecated,
      enhancedEditor,
      shouldRedirect,
      showWarning,
      deprecationMessage: showWarning ? featureFlagService.getStudioDeprecationMessage() : null
    });
  }));

  return router;
}