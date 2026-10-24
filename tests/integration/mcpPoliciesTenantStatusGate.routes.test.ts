/**
 * Integration (F1, design D5-F1): the /api/mcp mount must sit behind
 * authMiddleware AND the tenant-lifecycle kill-switch gate. The router's
 * strict tenant resolution is unit-tested in
 * tests/unit/routes/__tests__/mcpPoliciesRouter.test.ts — this test pins the
 * COMPOSITION via the exported production wiring helper
 * mountMcpPolicyRoutes (same pattern as mountSyncCentralRoutes /
 * syncCentralTenantStatusGate.routes.test.ts), with REAL HS256-signed JWTs
 * against JWT_SECRET (design D6 evidence bar).
 */

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mountMcpPolicyRoutes } from '../../src/middleware/setup/RouteSetup';
import { createMCPPolicyRouter } from '../../src/routes/mcpPolicies';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';
import type { MCPPolicyService } from '../../src/services/mcp/MCPPolicyService';
import type { Logger } from '../../src/utils/Logger';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as any;

const policyService = {
  getPolicy: jest.fn().mockResolvedValue({
    allowlist: [],
    denylist: [],
    disabledTenants: [],
    defaultBehavior: 'suitecentral_allow_external_explicit',
    dbPolicies: [],
  }),
  upsertToolPolicy: jest.fn(),
  deleteToolPolicy: jest.fn(),
} as unknown as MCPPolicyService;

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

async function createApp(): Promise<express.Application> {
  const app = express();
  app.use(express.json());
  mountMcpPolicyRoutes(app, fakeTenantService, await createMCPPolicyRouter({ policyService, logger }));
  return app;
}

describe('/api/mcp mount — authMiddleware + tenant kill-switch gate wiring (F1)', () => {
  beforeAll(() => {
    if (!process.env.JWT_SECRET) {
      process.env.JWT_SECRET = 'integration-test-secret-mcp-gate';
    }
  });

  beforeEach(() => jest.clearAllMocks());

  it('rejects anonymous requests with 401 (authMiddleware fronts the mount)', async () => {
    const res = await request(await createApp()).get('/api/mcp/policies');

    expect(res.status).toBe(401);
    expect(policyService.getPolicy).not.toHaveBeenCalled();
  });

  it('returns 403 tenant_blocked for a suspended tenant before the router runs', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(await createApp())
      .get('/api/mcp/policies')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'tenant_blocked', reason: 'tenant_suspended', status: 'suspended' });
    expect(policyService.getPolicy).not.toHaveBeenCalled();
  });

  it('passes an active tenant through the gate to the router', async () => {
    const token = signToken({ id: 'u1', username: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const res = await request(await createApp())
      .get('/api/mcp/policies')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-active');
  });

  it('fails closed on an authenticated token without a tenant claim (gate 403 tenant_id_missing)', async () => {
    const token = signToken({ id: 'u1', username: 'u1', roles: ['user'] });
    const res = await request(await createApp())
      .get('/api/mcp/policies')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_id_missing');
    expect(policyService.getPolicy).not.toHaveBeenCalled();
  });
});
