/**
 * Integration (cardinality-preflight design, Task 9): the /api/configurations
 * mount must sit behind authMiddleware AND the tenant-lifecycle kill switch —
 * the routePolicy row for this family is `auth: 'required'`,
 * `lifecycle: 'enforce'`, and until Task 9 the gate half was missing, so a
 * suspended tenant's still-valid JWT could create, update, import, or ACTIVATE
 * a configuration.
 *
 * The router's own tenant narrowing is unit-tested in
 * tests/unit/routes/__tests__/configuration.test.ts; this test pins the
 * COMPOSITION via the exported production wiring helper
 * mountConfigurationRoutes (same pattern as mountMcpPolicyRoutes /
 * mcpPoliciesTenantStatusGate.routes.test.ts), with REAL HS256-signed JWTs
 * against JWT_SECRET.
 */

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mountConfigurationRoutes } from '../../src/middleware/setup/RouteSetup';
import { createConfigurationRouter } from '../../src/routes/configuration';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';
import type { ConfigurationService } from '../../src/services/ConfigurationService';
import { makeStubPreflight } from '../helpers/cardinalityTestDoubles';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

const getAllForTenant = jest.fn().mockReturnValue([]);
const saveConfiguration = jest.fn().mockResolvedValue(undefined);
const configurationService = {
  getAllConfigurations: jest.fn().mockReturnValue([]),
  getAllConfigurationsForTenant: getAllForTenant,
  getConfigurationForTenant: jest.fn(),
  saveConfiguration,
} as unknown as ConfigurationService;

const preflight = makeStubPreflight();

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

function createApp(): express.Application {
  const app = express();
  app.use(express.json());
  mountConfigurationRoutes(
    app,
    fakeTenantService,
    createConfigurationRouter({ configurationService, cardinalityPreflight: preflight }),
  );
  return app;
}

describe('/api/configurations mount — authMiddleware + tenant kill-switch gate wiring (Task 9)', () => {
  beforeAll(() => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'integration-test-secret-configuration-gate';
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('rejects anonymous requests with 401 (authMiddleware fronts the mount)', async () => {
    const res = await request(createApp()).get('/api/configurations').set('Accept', 'application/json');

    expect(res.status).toBe(401);
    expect(getAllForTenant).not.toHaveBeenCalled();
  });

  it('returns 403 tenant_blocked for a suspended tenant before the router runs', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(createApp())
      .get('/api/configurations')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'tenant_blocked', reason: 'tenant_suspended', status: 'suspended' });
    expect(getAllForTenant).not.toHaveBeenCalled();
  });

  it('blocks a suspended tenant from ACTIVATING a configuration', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(createApp())
      .post('/api/configurations')
      .set('Authorization', `Bearer ${token}`)
      .send({ id: 'cfg-1', name: 'Blocked', sourceSystem: 'salesforce', targetSystem: 'netsuite', isActive: true });

    expect(res.status).toBe(403);
    expect(saveConfiguration).not.toHaveBeenCalled();
  });

  it('passes an active tenant through the gate to the router', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const res = await request(createApp())
      .get('/api/configurations')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
    expect(getAllForTenant).toHaveBeenCalledWith('tenant-active');
  });

  it('reaches the preflight route for an active tenant', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const res = await request(createApp())
      .post('/api/configurations/cardinality-preflight')
      .set('Authorization', `Bearer ${token}`)
      .send({
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
        sourceEntity: 'Account',
        targetEntity: 'Customer',
        syncDirection: 'source_to_target',
        fieldMappings: [],
        strategies: [],
        keyDeclarations: { sourceRecordKeys: ['id'], parentKeys: ['accountId'], targetKeys: ['externalId'] },
      });

    expect(res.status).toBe(200);
    expect((preflight.runForPlan as jest.Mock)).toHaveBeenCalledWith(
      expect.objectContaining({ sourceEntity: 'Account' }),
      'tenant-active',
      undefined,
    );
  });

  it('fails closed on an authenticated token without a tenant claim (gate 403 tenant_id_missing)', async () => {
    const token = signToken({ id: 'u1', username: 'u1', roles: ['user'] });
    const res = await request(createApp())
      .get('/api/configurations')
      .set('Accept', 'application/json')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_id_missing');
    expect(getAllForTenant).not.toHaveBeenCalled();
  });
});
