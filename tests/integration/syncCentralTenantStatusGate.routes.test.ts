/**
 * Integration: the SyncCentral and Automation mounts must sit BEHIND the
 * tenant-lifecycle kill-switch gate (PR #879). The gate middleware itself is
 * unit-tested in tests/unit/middleware/tenantStatusGate.test.ts, and the
 * individual routers pin their own HTTP contracts — but neither pins the
 * *composition*: that a suspended tenant actually gets a 403 on real
 * SyncCentral/Automation paths. This closes that gap so a future refactor
 * can't silently unwire the gate from the mounts in RouteSetup.ts.
 *
 * Mounts /api/sync-central, /api/sync-orchestrator, and /api/automation-libraries
 * behind makeTenantStatusGate(...) exactly as RouteSetup.setupAPIRoutes does.
 */

import request from 'supertest';
import express, { type Request } from 'express';

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

import { syncCentralRouter } from '../../src/routes/syncCentral';
import { syncOrchestratorRouter } from '../../src/routes/syncOrchestrator';
import { automationLibrariesRouter } from '../../src/routes/automationLibraries';
// Exercise the SAME wiring helper production uses (RouteSetup.setupAPIRoutes
// calls mountSyncCentralRoutes), so this test pins the real mount: dropping a
// mount or the gate from the helper fails here.
import { mountSyncCentralRoutes } from '../../src/middleware/setup/RouteSetup';
// Import from the same surface the gate narrows against (TenantLifecycleService
// re-exports TenantBlockedError) so instanceof stays aligned with production
// even if the re-export arrangement changes.
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';

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
} as any;

// An auth-injecting shim populates req.user (the global /api
// optionalAuthMiddleware's job in production), then the production helper mounts
// all three SyncCentral surfaces behind the gate.
function createApp(tenantId: string): express.Application {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { user?: unknown }).user = { id: 'u1', tenantId };
    next();
  });
  mountSyncCentralRoutes(app, fakeTenantService, {
    syncCentral: syncCentralRouter,
    syncOrchestrator: syncOrchestratorRouter,
    automationLibraries: automationLibrariesRouter,
  });
  return app;
}

describe('SyncCentral & Automation mounts — tenant kill-switch gate wiring', () => {
  beforeEach(() => jest.clearAllMocks());

  const routes = [
    { name: 'SyncCentral', path: '/api/sync-central/tiers', mock: mockGetPricingTiers },
    { name: 'SyncOrchestrator', path: '/api/sync-orchestrator/operations', mock: mockGetOperations },
    { name: 'AutomationLibraries', path: '/api/automation-libraries/libraries', mock: mockGetLibraries },
  ];

  routes.forEach(({ name, path, mock }) => {
    describe(`${name} (${path})`, () => {
      it('returns 403 tenant_blocked for a suspended tenant', async () => {
        const res = await request(createApp(SUSPENDED_TENANT)).get(path);

        expect(res.status).toBe(403);
        expect(res.body).toEqual({
          error: 'tenant_blocked',
          reason: 'tenant_suspended',
          status: 'suspended',
        });
        // Gate short-circuits before the router — the service is never consulted.
        expect(mock).not.toHaveBeenCalled();
      });

      it('passes an active tenant through the gate to the router', async () => {
        mock.mockResolvedValue([]);
        const res = await request(createApp('tenant-active')).get(path);

        expect(res.status).toBe(200);
        expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
        // Prove the request actually reached the downstream router/service,
        // not just that some 200 was returned.
        expect(mock).toHaveBeenCalled();
      });
    });
  });
});

