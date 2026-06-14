import * as express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { resolveActor } from '../services/governance/resolveActor';
import { extractIdentityContext } from '../services/governance/identityContext';
import type { SyncCentralService } from '../services/SyncCentralService';

const router = express.Router();

// Pricing Tier Management Routes
router.get('/tiers', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const tiers = await syncService.getPricingTiers();
  res.json(tiers);
}));

router.get('/tiers/:tierId', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const tierId = req.params.tierId;

  if (!tierId) {
    return res.status(400).json({ error: 'Tier ID required' });
  }

  const tier = await syncService.getPricingTier(tierId);

  if (!tier) {
    return res.status(404).json({ error: 'Pricing tier not found' });
  }

  res.json(tier);
}));

// Subscription Management Routes
router.get('/subscriptions', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const {
    customerId,
    tierId,
    status,
    limit = 50,
    offset = 0
  } = req.query;

  const subscriptions = await syncService.getSubscriptions(tenantId, {
    customerId: customerId as string,
    tierId: tierId as string,
    status: status as any,
    limit: Number(limit),
    offset: Number(offset)
  });

  res.json(subscriptions);
}));

router.post('/subscriptions', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const subscriptionData = req.body;
  const subscriptionId = await syncService.createSubscription(tenantId, subscriptionData);
  res.status(201).json({ subscriptionId });
}));

router.post('/subscriptions/:subscriptionId/cancel', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);
  const subscriptionId = req.params.subscriptionId;
  const { reason } = req.body ?? {};

  if (!subscriptionId) {
    return res.status(400).json({ error: 'Subscription ID required' });
  }

  try {
    const cancelled = await syncService.cancelSubscription(
      tenantId,
      subscriptionId,
      typeof reason === 'string' ? reason : undefined,
      resolveActor(req, (req.body ?? {}).cancelledBy) ?? 'api'
    );

    res.json({ success: true, subscription: cancelled });
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message;
      const normalized = message.toLowerCase();

      if (normalized.includes('not found')) {
        return res.status(404).json({ error: message });
      }
      if (normalized.includes('cannot be cancelled')) {
        return res.status(409).json({ error: message });
      }

      return res.status(400).json({ error: message });
    }

    return next(error);
  }
}));

// Usage Management Routes
router.post('/subscriptions/:subscriptionId/usage', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const usageData = req.body;
  const subscriptionId = req.params.subscriptionId;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'Subscription ID required' });
  }
  await syncService.updateUsage(tenantId, subscriptionId, usageData);
  res.json({ success: true });
}));

router.get('/subscriptions/:subscriptionId/limit-check', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const { limitType, requestedAmount } = req.query;
  const subscriptionId = req.params.subscriptionId;
  if (!subscriptionId) {
    return res.status(400).json({ error: 'Subscription ID required' });
  }
  const result = await syncService.checkLimit(
    tenantId,
    subscriptionId,
    limitType as any,
    Number(requestedAmount) || 1
  );

  res.json(result);
}));

// Alerts Management Routes
router.get('/alerts', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const { subscriptionId } = req.query;
  const alerts = await syncService.getUsageAlerts(tenantId, subscriptionId as string);
  res.json(alerts);
}));

router.post('/alerts/:alertId/acknowledge', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const alertId = req.params.alertId;
  const body = req.body ?? {};
  const acknowledgedBy = resolveActor(req, body.acknowledgedBy);
  if (!alertId || !acknowledgedBy) {
    return res.status(400).json({ error: 'Alert ID and acknowledgedBy required' });
  }
  await syncService.acknowledgeAlert(tenantId, alertId, acknowledgedBy);
  res.json({ success: true });
}));

// Analytics Routes
router.get('/analytics', asyncHandler(async (req, res, next) => {
  const syncService = container.get<SyncCentralService>(TYPES.SyncCentralService);
  const { tenantId } = extractIdentityContext(req);

  const analytics = await syncService.getAnalytics(tenantId);
  res.json(analytics);
}));

export { router as syncCentralRouter };
