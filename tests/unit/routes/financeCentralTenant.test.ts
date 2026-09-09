/**
 * F5b Task 8: financeCentral off the SYSTEM_IDENTITY fallback.
 * The route file is the unit under test; services are mocked at the container
 * boundary (pattern: paymentCentral.router.test.ts). The app carries NO auth
 * middleware — attestReadsOnly() simulates the gate's anonymous demo
 * attestation, reads only, exactly like the real mount.
 */
import request from 'supertest';
import express from 'express';
import * as fs from 'fs';
import * as path from 'path';

const mockGetDashboard = jest.fn();
const mockApproveItem = jest.fn();
const mockRejectItem = jest.fn();

const mockFinanceService = {
  getDashboard: mockGetDashboard,
  getCashPosition: jest.fn(),
  getARAgingReport: jest.fn(),
  getAPAgingReport: jest.fn(),
  getFinancialMetrics: jest.fn(),
  getCashFlowProjection: jest.fn(),
  getPendingApprovals: jest.fn(),
  getGLAccountBalances: jest.fn(),
  getConsolidatedFinancials: jest.fn(),
  getPeriodCloseStatus: jest.fn(),
  getDocuments: jest.fn(),
  recordPayment: jest.fn(),
};

const mockOperatorService = {
  approveItem: mockApproveItem,
  rejectItem: mockRejectItem,
};

const mockLogger = { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('FinanceCentralOperatorService')) return mockOperatorService;
      if (typeName.includes('FinanceCentralService')) return mockFinanceService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
    getAsync: jest.fn(async (type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('FinanceCentralOperatorService')) return mockOperatorService;
      if (typeName.includes('FinanceCentralService')) return mockFinanceService;
      if (typeName.includes('Logger')) return mockLogger;
      return {};
    }),
  },
}));

// eslint-disable-next-line import/first
import { financeCentralRouter } from '../../../src/routes/financeCentral';
// eslint-disable-next-line import/first
import { attestReadsOnly } from './central/centralRouterHarness';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../../src/services/governance/demoTenant';
// eslint-disable-next-line import/first
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';
// eslint-disable-next-line import/first
import { fakeAuthMiddleware, FakeUserOverrides } from './_helpers/routerTestAuth';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(attestReadsOnly());
  app.use('/api/finance-central', financeCentralRouter);
  return app;
}

/**
 * Mounts the router behind a typed fake auth middleware. Prefer this over an
 * inline `req.user` assignment: routerTestAuth types the object as
 * `NonNullable<Request['user']>`, so a claim-shape change in
 * src/types/express.d.ts fails the typecheck here instead of being papered
 * over by a cast. (The sibling helpers in supplierCentral.router.test.ts:86
 * and paymentCentral.router.test.ts:123 still use an `as any` inline; this
 * suite does not spread that hatch further.)
 */
function createAuthedApp(overrides: FakeUserOverrides) {
  const app = express();
  app.use(express.json());
  app.use(fakeAuthMiddleware(overrides));
  app.use('/api/finance-central', financeCentralRouter);
  return app;
}

function createSentinelUserApp() {
  return createAuthedApp({ id: SYSTEM_IDENTITY.userId, tenantId: 'tenant-a' });
}

describe('financeCentral tenant resolution (F5b)', () => {
  let app: express.Application;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  it('no longer imports extractIdentityContext', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../../src/routes/financeCentral.ts'),
      'utf8',
    );
    expect(src).not.toContain('extractIdentityContext');
  });

  it('resolves a gate-attested anonymous dashboard read to the demo tenant', async () => {
    mockGetDashboard.mockResolvedValue({ ok: true });
    const res = await request(app).get('/api/finance-central/dashboard').set('x-test-demo', '1');
    expect(res.status).toBe(200);
    expect(mockGetDashboard).toHaveBeenCalledWith(CENTRAL_DEMO_TENANT_ID);
  });

  it('401s an unattested credential-free dashboard read (the removed fallback)', async () => {
    const res = await request(app).get('/api/finance-central/dashboard');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockGetDashboard).not.toHaveBeenCalled();
  });

  it('401s an anonymous approval WRITE even with the demo header (harness attests reads only)', async () => {
    const res = await request(app)
      .post('/api/finance-central/approvals/a1/approve')
      .set('x-test-demo', '1')
      .send({ approverId: 'attacker' });
    expect(res.status).toBe(401);
    expect(mockApproveItem).not.toHaveBeenCalled();
  });

  it('refuses a sentinel actor instead of accepting a body approverId', async () => {
    const res = await request(createSentinelUserApp())
      .post('/api/finance-central/approvals/a1/approve')
      .send({ approverId: 'spoofed-operator' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'identity_required' });
    expect(mockApproveItem).not.toHaveBeenCalled();
  });

  /**
   * /reject writes a durable rejection record carrying `rejecterId`, exactly
   * like /approve writes one carrying `approverId`. It had no actor-boundary
   * coverage at all, so a regression to a body-supplied rejecter would have
   * passed. Each case below asserts the service is NOT reached on refusal —
   * a 401 with the write already issued would be no protection.
   */
  describe('POST /approvals/:id/reject — actor boundary', () => {
    const REASON = { reason: 'documentation incomplete' };

    it('rejects with the VERIFIED actor and ignores a body-supplied rejecterId', async () => {
      mockRejectItem.mockResolvedValue({ ok: true });
      const res = await request(createAuthedApp({ id: 'alice', tenantId: 'tenant-a' }))
        .post('/api/finance-central/approvals/a1/reject')
        .send({ ...REASON, rejecterId: 'spoofed-operator' });

      expect(res.status).toBe(200);
      expect(mockRejectItem).toHaveBeenCalledWith({
        tenantId: 'tenant-a',
        approvalId: 'a1',
        rejecterId: 'alice',
        reason: REASON.reason,
      });
    });

    it('refuses a blank actor even though the tenant claim is valid', async () => {
      const res = await request(createAuthedApp({ id: '', tenantId: 'tenant-a' }))
        .post('/api/finance-central/approvals/a1/reject')
        .send(REASON);

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'identity_required' });
      expect(mockRejectItem).not.toHaveBeenCalled();
    });

    it('refuses a sentinel actor instead of accepting a body rejecterId', async () => {
      const res = await request(createSentinelUserApp())
        .post('/api/finance-central/approvals/a1/reject')
        .send({ ...REASON, rejecterId: 'spoofed-operator' });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'identity_required' });
      expect(mockRejectItem).not.toHaveBeenCalled();
    });

    // No anonymous-write case here on purpose. It would be guarded twice over
    // — resolveCentralTenantId 401s an unattested anonymous request before
    // resolveActor is ever reached — so it cannot be made to fail by reverting
    // either guard alone, and a test that survives every single-point
    // regression proves nothing about this handler.
  });
});
