// src/routes/costTransparencyRoutes.ts
import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';
import type { CostTransparencyService } from '../services/cost/CostTransparencyService';

const router = express.Router();

async function getService(): Promise<CostTransparencyService> {
  return container.getAsync<CostTransparencyService>(TYPES.CostTransparencyService);
}

router.get('/dashboard', asyncHandler(async (req, res) => {
  const { tenantId } = extractIdentityContext(req);
  if (!tenantId || tenantId === SYSTEM_IDENTITY.tenantId) {
    return res.status(401).json({ error: 'identity_required' });
  }
  const svc = await getService();
  res.json(await svc.getDashboard(tenantId));
}));

router.get('/anomalies', asyncHandler(async (req, res) => {
  const { tenantId } = extractIdentityContext(req);
  if (!tenantId || tenantId === SYSTEM_IDENTITY.tenantId) {
    return res.status(401).json({ error: 'identity_required' });
  }
  const svc = await getService();
  res.json(await svc.getAnomalySummary(tenantId));
}));

router.get('/health', (_req, res) => {
  res.json({ status: 'healthy', service: 'cost-transparency' });
});

export default router;
