/**
 * Integration: the three SyncCentral/Automation mounts split into two
 * postures under PR3 (F6 sub-project B).
 *
 * /api/sync-central is genuinely tenant-scoped (TenantSandbox-backed) and
 * sits behind authMiddleware + the tenant-lifecycle kill-switch gate
 * (PR #879's original invariant, now fronted by auth per PR3).
 *
 * /api/sync-orchestrator and /api/automation-libraries hold process-global
 * state (SyncOperation has no tenantId; AutomationLibrariesService's stores
 * are process-global Maps), so authentication cannot isolate them — they
 * take the F4 platform-admin shape instead (authMiddleware +
 * requirePlatformAdmin, no kill switch).
 *
 * This closes the gap where neither the gate unit test nor the individual
 * routers' HTTP contracts pin the *composition*: that anonymous callers are
 * rejected, that a suspended tenant gets 403 on sync-central, and that the
 * two platform-global mounts require a platform admin rather than any
 * tenant.
 */

import request from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';

// Routers resolve services from the inversify container at request time.
const mockGetPricingTiers = jest.fn();
const mockSyncService = { getPricingTiers: mockGetPricingTiers };

const mockGetOperations = jest.fn();
const mockOrchestrator = { getOperations: mockGetOperations };

const mockGetLibraries = jest.fn();
const mockAutomationService = { getLibraries: mockGetLibraries };

jest.mock('../../src/inversify/inversify.config', () => {
  // Resolve against the exact TYPES symbols (Symbol.for-based) rather than
  // substring-matching symbol descriptions, so the mock can't silently drift
  // if a description string changes.
  const { TYPES } = require('../../src/inversify/types');
  const resolve = (type: symbol) => {
    if (type === TYPES.SyncCentralService) return mockSyncService;
    if (type === TYPES.SyncCentralOrchestrator) return mockOrchestrator;
    if (type === TYPES.AutomationLibrariesService) return mockAutomationService;
    return {};
  };
  return {
    container: {
      get: jest.fn(resolve),
      getAsync: jest.fn(async (type: symbol) => resolve(type)),
    },
  };
});

// Stands in for JWT verification: a populated req.user means "verified".
// requirePlatformAdmin and the kill-switch gate stay real, because they are
// what this test is pinning — only authMiddleware itself is stubbed, so the
// test exercises the *composition order* (auth -> authz -> gate -> router)
// without minting real JWTs.
//
// The 401 body is a DELIBERATELY distinguishable sentinel, not the real
// authMiddleware's 'Authentication required' message: requirePlatformAdmin
// (verifiedAdmin.ts) returns that exact same message and status on its own
// unauthenticated branch, so asserting on the shared string would pass
// whether authMiddleware ran or not — a false pass if authMiddleware were
// ever dropped from mountSyncOrchestratorRoutes/mountAutomationLibrariesRoutes.
// The sentinel body lets the anonymous-callers test below prove authMiddleware
// specifically ran on all three mounts, not just some 401-returning gate.
jest.mock('../../src/middleware/auth', () => ({
  authMiddleware: (req: Request, res: Response, next: NextFunction) => {
    if (!(req as Request & { user?: unknown }).user) {
      return res.status(401).json({ error: 'auth_middleware_401' });
    }
    next();
  },
  // Runtime export used elsewhere in RouteSetup — a partial mock would leave
  // it undefined and break any test that drives full route setup.
  optionalAuthMiddleware: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { syncCentralRouter } from '../../src/routes/syncCentral';
import { syncOrchestratorRouter } from '../../src/routes/syncOrchestrator';
import { automationLibrariesRouter } from '../../src/routes/automationLibraries';
// Exercise the SAME wiring helpers production uses (RouteSetup.setupAPIRoutes
// calls all three), so this test pins the real mounts: dropping a mount, the
// gate, or the authz check from any helper fails here.
import {
  mountSyncCentralRoutes,
  mountSyncOrchestratorRoutes,
  mountAutomationLibrariesRoutes,
} from '../../src/middleware/setup/RouteSetup';
// Import from the same surface the gate narrows against (TenantLifecycleService
// re-exports TenantBlockedError) so instanceof stays aligned with production
// even if the re-export arrangement changes.
import { TenantBlockedError, type TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';

const SUSPENDED_TENANT = 'tenant-suspended';

// Stand-in for TenantLifecycleService: requireActive throws for the suspended
// tenant (mirrors what the real service does after an operator suspension) and
// resolves for everyone else. The gate only depends on this one method.
const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as unknown as TenantLifecycleService;

function mountAll(app: express.Application, tenantSvc: TenantLifecycleService): void {
  mountSyncCentralRoutes(app, tenantSvc, syncCentralRouter);
  mountSyncOrchestratorRoutes(app, syncOrchestratorRouter);
  mountAutomationLibrariesRoutes(app, automationLibrariesRouter);
}

// An auth-injecting shim populates req.user (the global /api
// optionalAuthMiddleware's job in production, stubbed by the mocked
// authMiddleware above), then the production helpers mount all three
// surfaces behind their real postures.
function appWithUser(user: Record<string, unknown>): express.Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = user;
    next();
  });
  mountAll(app, fakeTenantService);
  return app;
}

describe('SyncCentral (tenant kill-switch gate wiring)', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('SyncCentral (/api/sync-central/tiers)', () => {
    it('returns 403 tenant_blocked for a suspended tenant', async () => {
      const app = appWithUser({ id: 'u1', tenantId: SUSPENDED_TENANT });
      const res = await request(app).get('/api/sync-central/tiers');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        error: 'tenant_blocked',
        reason: 'tenant_suspended',
        status: 'suspended',
      });
      // Gate short-circuits before the router — the service is never consulted.
      expect(mockGetPricingTiers).not.toHaveBeenCalled();
    });

    it('passes an active tenant through the gate to the router', async () => {
      mockGetPricingTiers.mockResolvedValue([]);
      const app = appWithUser({ id: 'u1', tenantId: 'tenant-active' });
      const res = await request(app).get('/api/sync-central/tiers');

      expect(res.status).toBe(200);
      expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
      // Prove the request actually reached the downstream router/service,
      // not just that some 200 was returned.
      expect(mockGetPricingTiers).toHaveBeenCalled();
    });
  });
});

describe('PR3 mount postures', () => {
  beforeEach(() => jest.clearAllMocks());

  const paths = [
    '/api/sync-central/tiers',
    '/api/sync-orchestrator/operations',
    '/api/automation-libraries/libraries',
  ];

  it.each(paths)('%s rejects anonymous callers', async (path) => {
    const app = express();
    app.use(express.json());
    mountAll(app, fakeTenantService);
    const res = await request(app).get(path);
    expect(res.status).toBe(401);
    // Body, not just status: requirePlatformAdmin's own unauthenticated
    // branch also returns 401 with {error: 'Authentication required'} — an
    // identical status code here would pass even if authMiddleware were
    // deleted from mountSyncOrchestratorRoutes/mountAutomationLibrariesRoutes
    // and requirePlatformAdmin were catching the anonymous request instead.
    // The sentinel body proves authMiddleware itself ran on every path.
    expect(res.body).toEqual({ error: 'auth_middleware_401' });
  });

  it.each([
    '/api/sync-orchestrator/operations',
    '/api/automation-libraries/libraries',
  ])('%s rejects a non-admin tenant JWT', async (path) => {
    const app = appWithUser({ id: 'u1', tenantId: 'tenant-ok' });
    const res = await request(app).get(path);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('Platform administrator access required');
  });

  // Both prefixes, or the name overstates what is asserted: a one-route
  // version would pass while /api/automation-libraries rejected valid admins.
  it.each([
    ['/api/sync-orchestrator/operations', mockGetOperations],
    ['/api/automation-libraries/libraries', mockGetLibraries],
  ])('admits a platform admin on %s', async (path, mock) => {
    const app = appWithUser({ id: 'admin-1', tenantId: 'tenant-ok', roles: ['admin'] });
    (mock as jest.Mock).mockResolvedValue([]);
    await request(app).get(path as string).expect(200);
    // Prove the request reached the router, not just that some 200 came back.
    expect(mock).toHaveBeenCalled();
  });

  it('threads the injected limiter into /api/sync-orchestrator, running it before the router', async () => {
    // mountSyncOrchestratorRoutes's third parameter exists precisely so a
    // caller (production or test) can supply a real limiter. Nothing else in
    // this file proves it is actually wired in, let alone wired in the right
    // order — a limiter mounted AFTER the router would run too late to ever
    // reject anything. Order is the property that matters here, not merely
    // "was called".
    const order: string[] = [];
    const limiterSpy = jest.fn((_req: Request, _res: Response, next: NextFunction) => {
      order.push('limiter');
      next();
    });
    mockGetOperations.mockImplementation(async () => {
      order.push('router');
      return [];
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as Request & { user?: unknown }).user = { id: 'admin-1', tenantId: 'tenant-ok', roles: ['admin'] };
      next();
    });
    mountSyncOrchestratorRoutes(app, syncOrchestratorRouter, limiterSpy);

    const res = await request(app).get('/api/sync-orchestrator/operations');

    expect(res.status).toBe(200);
    expect(limiterSpy).toHaveBeenCalled();
    expect(order).toEqual(['limiter', 'router']);
  });

  it('still 403s a suspended tenant on sync-central', async () => {
    const app = appWithUser({ id: 'u1', tenantId: SUSPENDED_TENANT });
    const res = await request(app).get('/api/sync-central/tiers');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_blocked');
  });

  it('403s an authenticated tenant-less JWT on sync-central', async () => {
    const app = appWithUser({ id: 'u1' });
    const res = await request(app).get('/api/sync-central/tiers');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_id_missing');
  });
});
