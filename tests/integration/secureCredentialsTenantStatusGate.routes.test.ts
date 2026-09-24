import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { mountSecureCredentialRoutes } from '../../src/middleware/setup/RouteSetup';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

const routerHits = jest.fn();

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

function createApp(): express.Application {
  const app = express();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });
  mountSecureCredentialRoutes(app, fakeTenantService, router);
  return app;
}

describe('/api/credentials mount — tenant lifecycle gate wiring', () => {
  beforeAll(() => {
    process.env.JWT_SECRET ??= 'integration-test-secret-secure-credentials-gate';
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks a suspended tenant before credential routes run', async () => {
    const token = signToken({ id: 'u1', tenantId: SUSPENDED_TENANT, roles: ['integration_manager'] });
    const response = await request(createApp())
      .post('/api/credentials')
      .set('Authorization', `Bearer ${token}`)
      .send({ systemType: 'Salesforce', systemId: 'sf-prod', credentials: { clientSecret: 'sentinel' } });

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'tenant_blocked', reason: 'tenant_suspended', status: 'suspended' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows an active tenant to reach credential routes', async () => {
    const token = signToken({ id: 'u1', tenantId: 'tenant-active', roles: ['integration_manager'] });
    const response = await request(createApp())
      .delete('/api/credentials/Salesforce/sf-prod')
      .set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
  });
});
