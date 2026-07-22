// tests/unit/routes/costTransparencyRoutes.test.ts
import express from 'express';
import request from 'supertest';
import router from '../../../src/routes/costTransparencyRoutes';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import type { CostTransparencyService } from '../../../src/services/cost/CostTransparencyService';

function makeApp(tenantId = 't1'): express.Express {
  const app = express();
  // extractIdentityContext requires both tenantId AND id on req.user
  // (see identityContext.ts:67 — `req.user?.tenantId && req.user.id != null`)
  app.use((req, _res, next) => { (req as any).user = { tenantId, id: 'u1' }; next(); });
  app.use('/api/cost-transparency', router);
  return app;
}

describe('costTransparencyRoutes', () => {
  beforeEach(() => { container.snapshot(); });
  afterEach(() => { container.restore(); });

  it('GET /dashboard returns tenant-scoped dashboard', async () => {
    const svc = {
      getDashboard: jest.fn().mockResolvedValue({
        tenantId: 't1', history: [], flows: [], anomalyDetected: false,
        lastRollupDate: null, todayLabel: 'no data',
      }),
    } as unknown as CostTransparencyService;
    container.rebind(TYPES.CostTransparencyService).toConstantValue(svc);

    const res = await request(makeApp('t1')).get('/api/cost-transparency/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe('t1');
    expect(svc.getDashboard).toHaveBeenCalledWith('t1');
  });

  it('GET /dashboard returns 401 with no identity', async () => {
    const app = express();
    app.use('/api/cost-transparency', router);
    const res = await request(app).get('/api/cost-transparency/dashboard');
    expect(res.status).toBe(401);
  });

  it('GET /anomalies returns days flagged anomalous', async () => {
    const svc = {
      getAnomalySummary: jest.fn().mockResolvedValue({
        anomalyDetected: true,
        history: [{ tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22', totalCostUsd: 10, measuredCount: 1, estimatedCount: 0 }],
      }),
    } as unknown as CostTransparencyService;
    container.rebind(TYPES.CostTransparencyService).toConstantValue(svc);

    const res = await request(makeApp('t1')).get('/api/cost-transparency/anomalies');
    expect(res.status).toBe(200);
    expect(res.body.anomalyDetected).toBe(true);
    expect(res.body.history).toHaveLength(1);
    expect(res.body.history[0].dateUtc).toBe('2026-05-22');
    expect(svc.getAnomalySummary).toHaveBeenCalledWith('t1');
  });
});
