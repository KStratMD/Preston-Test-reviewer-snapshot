// Real-JWT integration coverage for the SuiteCentral control-plane boundary.
//
// Mounts all three namespaces exactly as RouteSetup does — authMiddleware, then
// the matching verifiedAdmin guard, then the router — and drives them with JWTs
// signed against the real test secret. The unit suites mock the guards away and
// so cannot prove this ordering; these can.
//
// jest.slow.config.cjs runs tests/integration/setupEnv.ts BEFORE this module
// loads, setting process.env.JWT_SECRET ← STRONG_TEST_JWT_SECRET, which
// authMiddleware captures via env.JWT_SECRET on its first resolveServices()
// call. Signing here with the same secret keeps verification deterministic.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import { authMiddleware } from '../../src/middleware/auth';
import {
  requirePlatformAdmin,
  requireSuiteCentralTenantAdmin,
} from '../../src/middleware/verifiedAdmin';
import {
  createSuiteCentralAllowedHostsRouter,
  createSuiteCentralControlPlaneRouter,
} from '../../src/routes/suiteCentralControlPlane';
import { SuiteCentralNotFoundError } from '../../src/services/suitecentral/controlPlane/errors';
import type { SuiteCentralControlPlaneService } from '../../src/services/suitecentral/controlPlane/SuiteCentralControlPlaneService';

const JWT_SECRET = STRONG_TEST_JWT_SECRET;

function signJwt(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
}

const anonymous = undefined;
const ordinaryUserToken = signJwt({ sub: 'user-1', tenantId: 'tenant-a', roles: ['user'], permissions: [] });
const tenantAdminToken = signJwt({ sub: 'tenant-admin-1', tenantId: 'tenant-a', roles: ['tenant_admin'], permissions: [] });
const otherTenantAdminToken = signJwt({ sub: 'tenant-admin-2', tenantId: 'tenant-b', roles: ['tenant_admin'], permissions: [] });
const platformAdminToken = signJwt({ sub: 'platform-admin-1', tenantId: 'platform', roles: ['admin'], permissions: ['*'] });

const service = {
  listEnvironments: jest.fn(),
  getEnvironment: jest.fn(),
  listAllowedHosts: jest.fn(),
  createAllowedHost: jest.fn(),
  revokeAllowedHost: jest.fn(),
};

/** Mirrors RouteSetup's mount order for the three SuiteCentral namespaces. */
async function buildApp(): Promise<express.Express> {
  const app = express();
  app.use(express.json());
  const injected = service as unknown as SuiteCentralControlPlaneService;

  app.use(
    '/api/suitecentral/prod',
    authMiddleware,
    requireSuiteCentralTenantAdmin,
    await createSuiteCentralControlPlaneRouter({ accessMode: 'tenant_admin', service: injected }),
  );
  app.use(
    '/api/admin/tenants/:tenantId/suitecentral',
    authMiddleware,
    requirePlatformAdmin,
    await createSuiteCentralControlPlaneRouter({ accessMode: 'platform_admin', service: injected }),
  );
  app.use(
    '/api/admin/suitecentral/allowed-hosts',
    authMiddleware,
    requirePlatformAdmin,
    await createSuiteCentralAllowedHostsRouter({ service: injected }),
  );

  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });
  return app;
}

/** Attach a bearer token only when one is supplied, so anonymous stays anonymous. */
function authed(test: request.Test, token: string | undefined): request.Test {
  return token ? test.set('Authorization', `Bearer ${token}`) : test;
}

describe('SuiteCentral control plane — real JWT boundary', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service.listEnvironments.mockResolvedValue([]);
    service.listAllowedHosts.mockResolvedValue([]);
  });

  describe('tenant namespace — /api/suitecentral/prod', () => {
    it('rejects an anonymous request with 401', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), anonymous).expect(401);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('rejects an ordinary authenticated user with 403', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), ordinaryUserToken).expect(403);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('allows a tenant admin, scoped to its own JWT tenant', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), tenantAdminToken).expect(200);
      expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({
        actorUserId: 'tenant-admin-1',
        targetTenantId: 'tenant-a',
        accessMode: 'tenant_admin',
      }));
    });

    // The mount is a single app.use chain; a duplicated mount would run the
    // handler twice per request and double every audited side effect.
    it('invokes the service exactly once per authenticated request', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), tenantAdminToken).expect(200);
      expect(service.listEnvironments).toHaveBeenCalledTimes(1);
    });

    it('denies a platform admin on the tenant namespace', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), platformAdminToken).expect(403);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('authenticates before it validates a body', async () => {
      await authed(
        request(app).post('/api/suitecentral/prod/environments').send({ nonsense: true }),
        anonymous,
      ).expect(401);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('cannot be re-scoped by a forged tenant header', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), tenantAdminToken)
        .set('x-tenant-id', 'tenant-b')
        .expect(200);
      expect(service.listEnvironments).toHaveBeenCalledWith(
        expect.objectContaining({ targetTenantId: 'tenant-a' }),
      );
    });

    // Cross-tenant ids are the service's job (a typed 404, no existence leak);
    // this proves the route surfaces that verdict rather than masking it.
    it('reports a cross-tenant environment id as 404', async () => {
      service.getEnvironment.mockRejectedValue(
        new SuiteCentralNotFoundError('environment_not_found', 'Environment not found.'),
      );
      const res = await authed(
        request(app).get('/api/suitecentral/prod/environments/env-owned-by-tenant-b'),
        tenantAdminToken,
      ).expect(404);
      expect(res.body.error).toBe('environment_not_found');
      expect(service.getEnvironment).toHaveBeenCalledWith(
        expect.objectContaining({ targetTenantId: 'tenant-a' }),
        'env-owned-by-tenant-b',
      );
    });

    it('scopes each tenant admin to its own tenant', async () => {
      await authed(request(app).get('/api/suitecentral/prod/environments'), otherTenantAdminToken).expect(200);
      expect(service.listEnvironments).toHaveBeenCalledWith(
        expect.objectContaining({ targetTenantId: 'tenant-b' }),
      );
    });
  });

  describe('platform namespace — /api/admin/tenants/:tenantId/suitecentral', () => {
    it('rejects an anonymous request with 401', async () => {
      await authed(request(app).get('/api/admin/tenants/tenant-a/suitecentral/environments'), anonymous).expect(401);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('rejects a tenant admin with 403', async () => {
      await authed(request(app).get('/api/admin/tenants/tenant-a/suitecentral/environments'), tenantAdminToken)
        .expect(403);
      expect(service.listEnvironments).not.toHaveBeenCalled();
    });

    it('allows a platform admin to target any tenant by path', async () => {
      await authed(request(app).get('/api/admin/tenants/tenant-b/suitecentral/environments'), platformAdminToken)
        .expect(200);
      expect(service.listEnvironments).toHaveBeenCalledWith(expect.objectContaining({
        actorUserId: 'platform-admin-1',
        targetTenantId: 'tenant-b',
        accessMode: 'platform_admin',
      }));
    });

    it('never falls back to the platform admin own tenant claim', async () => {
      await authed(request(app).get('/api/admin/tenants/tenant-b/suitecentral/environments'), platformAdminToken)
        .expect(200);
      expect(service.listEnvironments).not.toHaveBeenCalledWith(
        expect.objectContaining({ targetTenantId: 'platform' }),
      );
    });

    it('invokes the service exactly once per authenticated request', async () => {
      await authed(request(app).get('/api/admin/tenants/tenant-b/suitecentral/environments'), platformAdminToken)
        .expect(200);
      expect(service.listEnvironments).toHaveBeenCalledTimes(1);
    });
  });

  describe('platform allowlist — /api/admin/suitecentral/allowed-hosts', () => {
    it('rejects an anonymous request with 401', async () => {
      await authed(request(app).get('/api/admin/suitecentral/allowed-hosts'), anonymous).expect(401);
      expect(service.listAllowedHosts).not.toHaveBeenCalled();
    });

    it('denies a tenant admin with 403', async () => {
      await authed(request(app).get('/api/admin/suitecentral/allowed-hosts'), tenantAdminToken).expect(403);
      expect(service.listAllowedHosts).not.toHaveBeenCalled();
    });

    it('denies an ordinary user with 403', async () => {
      await authed(request(app).get('/api/admin/suitecentral/allowed-hosts'), ordinaryUserToken).expect(403);
      expect(service.listAllowedHosts).not.toHaveBeenCalled();
    });

    it('allows a platform admin', async () => {
      await authed(request(app).get('/api/admin/suitecentral/allowed-hosts'), platformAdminToken).expect(200);
      expect(service.listAllowedHosts).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: 'platform-admin-1', accessMode: 'platform_admin' }),
      );
    });
  });
});
