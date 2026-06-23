/**
 * Route regression suite for syncCentral.ts.
 * The route file is the unit under test; SyncCentralService is mocked at
 * the inversify boundary (same pattern as supplierCentral.router.test.ts).
 *
 * Goal: lock the HTTP contract and verify resolveActor wiring on the
 * subscription cancel route so actor attribution cannot be spoofed via body.
 */

import request from 'supertest';
import express from 'express';

// ---- Mock service methods (all methods the routes call) ----
const mockGetPricingTiers = jest.fn();
const mockGetPricingTier = jest.fn();
const mockGetSubscriptions = jest.fn();
const mockCreateSubscription = jest.fn();
const mockCancelSubscription = jest.fn();
const mockUpdateUsage = jest.fn();
const mockCheckLimit = jest.fn();
const mockGetUsageAlerts = jest.fn();
const mockAcknowledgeAlert = jest.fn();
const mockGetAnalytics = jest.fn();

const mockSyncService = {
  getPricingTiers: mockGetPricingTiers,
  getPricingTier: mockGetPricingTier,
  getSubscriptions: mockGetSubscriptions,
  createSubscription: mockCreateSubscription,
  cancelSubscription: mockCancelSubscription,
  updateUsage: mockUpdateUsage,
  checkLimit: mockCheckLimit,
  getUsageAlerts: mockGetUsageAlerts,
  acknowledgeAlert: mockAcknowledgeAlert,
  getAnalytics: mockGetAnalytics,
};

// Mock the inversify container before importing the router
jest.mock('../../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('SyncCentralService')) return mockSyncService;
      return {};
    }),
  },
}));

import { syncCentralRouter } from '../../../../src/routes/syncCentral';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/sync-central', syncCentralRouter);
  return app;
}

function createAuthedApp(userId: string, tenantId = 'tenant-a') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as any).user = { tenantId, id: userId }; next(); });
  app.use('/api/sync-central', syncCentralRouter);
  return app;
}

describe('syncCentral router', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  // ==================== GET /tiers ====================

  describe('GET /tiers', () => {
    it('happy path — returns 200 with tiers', async () => {
      const tiers = [{ id: 'tier_basic', name: 'Basic' }];
      mockGetPricingTiers.mockResolvedValue(tiers);

      const res = await request(app).get('/api/sync-central/tiers');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(tiers);
    });
  });

  // ==================== GET /tiers/:tierId ====================

  describe('GET /tiers/:tierId', () => {
    it('happy path — returns 200 with tier', async () => {
      const tier = { id: 'tier_basic', name: 'Basic' };
      mockGetPricingTier.mockResolvedValue(tier);

      const res = await request(app).get('/api/sync-central/tiers/tier_basic');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(tier);
    });

    it('error path — tier not found returns 404', async () => {
      mockGetPricingTier.mockResolvedValue(null);

      const res = await request(app).get('/api/sync-central/tiers/missing');

      expect(res.status).toBe(404);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== GET /subscriptions ====================

  describe('GET /subscriptions', () => {
    it('happy path — returns 200 with subscriptions', async () => {
      const subs = [{ id: 'sub1', status: 'active' }];
      mockGetSubscriptions.mockResolvedValue(subs);

      const res = await request(app).get('/api/sync-central/subscriptions');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(subs);
    });
  });

  // ==================== POST /subscriptions ====================

  describe('POST /subscriptions', () => {
    it('happy path — returns 201 with subscriptionId', async () => {
      mockCreateSubscription.mockResolvedValue('sub_abc123');

      const res = await request(app)
        .post('/api/sync-central/subscriptions')
        .send({ customerId: 'c1', tierId: 'tier_basic' });

      expect(res.status).toBe(201);
      expect(res.body).toHaveProperty('subscriptionId', 'sub_abc123');
    });
  });

  // ==================== POST /subscriptions/:subscriptionId/cancel ====================

  describe('POST /subscriptions/:subscriptionId/cancel', () => {
    it('happy path — returns 200 with {success, subscription}', async () => {
      mockCancelSubscription.mockResolvedValue({ id: 'sub1', status: 'cancelled' });

      const res = await request(app)
        .post('/api/sync-central/subscriptions/sub1/cancel')
        .send({ reason: 'churn', cancelledBy: 'some-user' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('subscription');
      expect(res.body.subscription).toHaveProperty('status', 'cancelled');
    });

    it('error path — not found returns 404', async () => {
      mockCancelSubscription.mockRejectedValue(new Error('not found'));

      const res = await request(app)
        .post('/api/sync-central/subscriptions/missing/cancel')
        .send({});

      expect(res.status).toBe(404);
    });

    it('error path — cannot be cancelled returns 409', async () => {
      mockCancelSubscription.mockRejectedValue(new Error('cannot be cancelled'));

      const res = await request(app)
        .post('/api/sync-central/subscriptions/sub1/cancel')
        .send({});

      expect(res.status).toBe(409);
    });
  });

  // ==================== POST /subscriptions/:subscriptionId/usage ====================

  describe('POST /subscriptions/:subscriptionId/usage', () => {
    it('happy path — returns 200 with {success}', async () => {
      mockUpdateUsage.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/sync-central/subscriptions/sub1/usage')
        .send({ syncCount: 5 });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });
  });

  // ==================== GET /subscriptions/:subscriptionId/limit-check ====================

  describe('GET /subscriptions/:subscriptionId/limit-check', () => {
    it('happy path — returns 200 with limit check result', async () => {
      const result = { allowed: true, current: 5, limit: 100 };
      mockCheckLimit.mockResolvedValue(result);

      const res = await request(app)
        .get('/api/sync-central/subscriptions/sub1/limit-check')
        .query({ limitType: 'sync_count', requestedAmount: '1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual(result);
    });
  });

  // ==================== GET /alerts ====================

  describe('GET /alerts', () => {
    it('happy path — returns 200 with alerts', async () => {
      const alerts = [{ id: 'alert1', type: 'usage_warning' }];
      mockGetUsageAlerts.mockResolvedValue(alerts);

      const res = await request(app).get('/api/sync-central/alerts');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(alerts);
    });
  });

  // ==================== POST /alerts/:alertId/acknowledge ====================

  describe('POST /alerts/:alertId/acknowledge', () => {
    it('happy path — returns 200 with {success}', async () => {
      mockAcknowledgeAlert.mockResolvedValue(undefined);

      const res = await request(app)
        .post('/api/sync-central/alerts/alert1/acknowledge')
        .send({ acknowledgedBy: 'some-user' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('success', true);
    });

    it('error path — missing acknowledgedBy returns 400', async () => {
      const res = await request(app)
        .post('/api/sync-central/alerts/alert1/acknowledge')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty('error');
    });
  });

  // ==================== GET /analytics ====================

  describe('GET /analytics', () => {
    it('happy path — returns 200 with analytics', async () => {
      const analytics = { totalSubscriptions: 10, activeSubscriptions: 8 };
      mockGetAnalytics.mockResolvedValue(analytics);

      const res = await request(app).get('/api/sync-central/analytics');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(analytics);
    });
  });
});

describe('cancel attribution (resolveActor)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('authenticated identity overrides spoofed cancelledBy', async () => {
    mockSyncService.cancelSubscription.mockResolvedValue({ id: 'sub1', status: 'cancelled' });
    await request(createAuthedApp('alice'))
      .post('/api/sync-central/subscriptions/sub1/cancel')
      .send({ reason: 'churn', cancelledBy: 'spoof' })
      .expect(200);
    expect(mockSyncService.cancelSubscription).toHaveBeenCalledWith('tenant-a', 'sub1', 'churn', 'alice');
  });

  it('pre-auth with no cancelledBy defaults to "api"', async () => {
    mockSyncService.cancelSubscription.mockResolvedValue({ id: 'sub1', status: 'cancelled' });
    await request(createApp())
      .post('/api/sync-central/subscriptions/sub1/cancel')
      .send({ reason: 'churn' })
      .expect(200);
    expect(mockSyncService.cancelSubscription).toHaveBeenCalledWith('__system__', 'sub1', 'churn', 'api');
  });

  it('pre-auth uses a valid body cancelledBy', async () => {
    mockSyncService.cancelSubscription.mockResolvedValue({ id: 'sub1', status: 'cancelled' });
    await request(createApp())
      .post('/api/sync-central/subscriptions/sub1/cancel')
      .send({ reason: 'churn', cancelledBy: 'demo-user' })
      .expect(200);
    expect(mockSyncService.cancelSubscription).toHaveBeenCalledWith('__system__', 'sub1', 'churn', 'demo-user');
  });
});

describe('alert-acknowledge attribution (resolveActor)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('authenticated identity overrides spoofed acknowledgedBy', async () => {
    mockSyncService.acknowledgeAlert.mockResolvedValue(undefined);
    await request(createAuthedApp('alice'))
      .post('/api/sync-central/alerts/a1/acknowledge')
      .send({ acknowledgedBy: 'spoof' })
      .expect(200);
    expect(mockSyncService.acknowledgeAlert).toHaveBeenCalledWith('tenant-a', 'a1', 'alice');
  });

  it('pre-auth 400s on missing acknowledgedBy', async () => {
    await request(createApp())
      .post('/api/sync-central/alerts/a1/acknowledge')
      .send({})
      .expect(400);
    expect(mockSyncService.acknowledgeAlert).not.toHaveBeenCalled();
  });

  it('pre-auth uses a valid body acknowledgedBy', async () => {
    mockSyncService.acknowledgeAlert.mockResolvedValue(undefined);
    await request(createApp())
      .post('/api/sync-central/alerts/a1/acknowledge')
      .send({ acknowledgedBy: 'demo-op' })
      .expect(200);
    expect(mockSyncService.acknowledgeAlert).toHaveBeenCalledWith('__system__', 'a1', 'demo-op');
  });
});
