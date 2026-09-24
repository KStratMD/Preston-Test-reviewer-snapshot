import express from 'express';
import request from 'supertest';
import { createMCPPolicyRouter } from '../../../../src/routes/mcpPolicies';
import type { MCPPolicyService } from '../../../../src/services/mcp/MCPPolicyService';
import type { Logger } from '../../../../src/utils/Logger';

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;
}

describe('MCPPolicyRouter', () => {
  function createPolicyServiceMock(): jest.Mocked<Pick<MCPPolicyService, 'getPolicy' | 'upsertToolPolicy' | 'deleteToolPolicy'>> {
    return {
      getPolicy: jest.fn().mockResolvedValue({
        allowlist: ['netsuite.ns_getRecord'],
        denylist: [],
        disabledTenants: [],
        defaultBehavior: 'suitecentral_allow_external_explicit',
        dbPolicies: [],
      }),
      upsertToolPolicy: jest.fn().mockResolvedValue({
        id: 1,
        tenantId: 'tenant-a',
        systemName: 'netsuite',
        toolPattern: 'ns_getRecord',
        action: 'allow',
        createdAt: new Date('2026-02-17T00:00:00Z'),
      }),
      deleteToolPolicy: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<Pick<MCPPolicyService, 'getPolicy' | 'upsertToolPolicy' | 'deleteToolPolicy'>>;
  }

  async function createApp(options?: {
    roles?: string[];
    permissions?: string[];
    userId?: string | null;
    userTenantId?: string | null;
    tenantContextTenantId?: string;
    authTenantId?: string;
  }) {
    const policyService = createPolicyServiceMock();
    const logger = createMockLogger();
    const router = await createMCPPolicyRouter({
      policyService: policyService as unknown as MCPPolicyService,
      logger,
    });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const user: any = {
        username: 'tenant-a-user',
        roles: options?.roles || ['user'],
        permissions: options?.permissions || [],
      };
      if (options?.userId !== null) {
        user.id = options?.userId || 'tenant-a';
      }
      if (options?.userTenantId !== null) {
        user.tenantId = options?.userTenantId || 'tenant-a';
      }
      req.user = user;
      if (options?.tenantContextTenantId) {
        (req as any).tenantContext = { tenantId: options.tenantContextTenantId };
      }
      if (options?.authTenantId) {
        (req as any).auth = { tenantId: options.authTenantId };
      }
      next();
    });
    app.use('/api/mcp', router);

    return { app, policyService, logger };
  }

  it('returns policy snapshot for tenant from authenticated user context', async () => {
    const { app, policyService } = await createApp();

    const res = await request(app)
      .get('/api/mcp/policies')
      .expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-a');
    expect(res.body.success).toBe(true);
    expect(res.body.tenantId).toBe('tenant-a');
    expect(res.body.policy.defaultBehavior).toBe('suitecentral_allow_external_explicit');
  });

  it('ignores x-tenant-id for non-admin requests when authenticated tenant/user is present', async () => {
    const { app, policyService } = await createApp();

    await request(app)
      .get('/api/mcp/policies')
      .set('x-tenant-id', 'tenant-from-header')
      .expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-a');
  });

  it('upserts tenant policy rule via PUT', async () => {
    const { app, policyService } = await createApp();

    const res = await request(app)
      .put('/api/mcp/policies')
      .send({
        systemName: 'netsuite',
        toolPattern: 'ns_createRecord',
        action: 'allow',
      })
      .expect(200);

    expect(policyService.upsertToolPolicy).toHaveBeenCalledWith({
      tenantId: 'tenant-a',
      systemName: 'netsuite',
      toolPattern: 'ns_createRecord',
      action: 'allow',
    });
    expect(res.body.success).toBe(true);
  });

  it('validates required fields for PUT requests', async () => {
    const { app, policyService } = await createApp();

    const res = await request(app)
      .put('/api/mcp/policies')
      .send({ action: 'allow' })
      .expect(400);

    expect(policyService.upsertToolPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('invalid_request');
  });

  it('deletes policy rule by id', async () => {
    const { app, policyService } = await createApp();

    const res = await request(app)
      .delete('/api/mcp/policies/5')
      .expect(200);

    expect(policyService.deleteToolPolicy).toHaveBeenCalledWith(5, 'tenant-a');
    expect(res.body.success).toBe(true);
    expect(res.body.deletedId).toBe(5);
  });

  it('returns 404 when deleting missing policy rule', async () => {
    const { app, policyService } = await createApp();
    policyService.deleteToolPolicy.mockResolvedValueOnce(false);

    const res = await request(app)
      .delete('/api/mcp/policies/999')
      .expect(404);

    expect(res.body.error).toBe('not_found');
  });

  it('rejects cross-tenant policy override for non-admin users', async () => {
    const { app, policyService } = await createApp({ roles: ['user'] });

    const res = await request(app)
      .get('/api/mcp/policies?tenantId=tenant-b')
      .expect(403);

    expect(policyService.getPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('forbidden');
  });

  it('allows cross-tenant policy access for admin users', async () => {
    const { app, policyService } = await createApp({ roles: ['admin'] });

    const res = await request(app)
      .get('/api/mcp/policies?tenantId=tenant-b')
      .expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-b');
    expect(res.body.tenantId).toBe('tenant-b');
  });

  // ---- F1 (design D4/D5-F1): user.id is never a tenant id; canonical order; strict flip ----

  it('returns 403 tenant_required for a tenant-less authenticated user (user.id is NOT promoted to tenantId)', async () => {
    const { app, policyService } = await createApp({ userId: 'user-42', userTenantId: null });

    const res = await request(app)
      .get('/api/mcp/policies')
      .expect(403);

    expect(policyService.getPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });

  it('returns 403 tenant_required on PUT for a tenant-less authenticated user', async () => {
    const { app, policyService } = await createApp({ userId: 'user-42', userTenantId: null });

    const res = await request(app)
      .put('/api/mcp/policies')
      .send({ systemName: 'netsuite', toolPattern: 'ns_x', action: 'allow' })
      .expect(403);

    expect(policyService.upsertToolPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });

  it('canonical order: req.user.tenantId beats req.tenantContext.tenantId', async () => {
    const { app, policyService } = await createApp({ tenantContextTenantId: 'tenant-ctx' });

    await request(app).get('/api/mcp/policies').expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-a');
  });

  it('canonical order: req.auth.tenantId beats user and tenantContext', async () => {
    const { app, policyService } = await createApp({
      authTenantId: 'tenant-auth',
      tenantContextTenantId: 'tenant-ctx',
    });

    await request(app).get('/api/mcp/policies').expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-auth');
  });

  it('tenantContext is still consulted when auth/user carry no tenant', async () => {
    const { app, policyService } = await createApp({
      userId: 'user-42',
      userTenantId: null,
      tenantContextTenantId: 'tenant-ctx',
    });

    await request(app).get('/api/mcp/policies').expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-ctx');
  });

  it('non-admin tenant-less user with x-tenant-id header gets 403 (header fallback deleted in F1)', async () => {
    const { app, policyService } = await createApp({ userId: null, userTenantId: null, roles: ['user'] });

    const res = await request(app)
      .get('/api/mcp/policies')
      .set('x-tenant-id', 'tenant-from-header')
      .expect(403);

    expect(policyService.getPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });

  it('DELETE is strict too — tenant-less authenticated user gets 403 tenant_required', async () => {
    const { app, policyService } = await createApp({ userId: 'user-42', userTenantId: null });

    const res = await request(app)
      .delete('/api/mcp/policies/5')
      .expect(403);

    expect(policyService.deleteToolPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });

  it('x-organization-id is not trusted either — the parallel header fallback is deleted', async () => {
    const { app, policyService } = await createApp({
      roles: ['admin'],
      permissions: ['*'],
      userId: null,
      userTenantId: null,
    });

    const res = await request(app)
      .get('/api/mcp/policies')
      .set('x-organization-id', 'org-from-header')
      .expect(403);

    expect(policyService.getPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });

  it('rejects the former admin header fallback — tenant-less admin with x-tenant-id gets 403 (F1: header path deleted; admins use the explicit ?tenantId= override)', async () => {
    const { app, policyService } = await createApp({
      roles: ['admin'],
      permissions: ['*'],
      userId: null,
      userTenantId: null,
    });

    const res = await request(app)
      .get('/api/mcp/policies')
      .set('x-tenant-id', 'tenant-from-header')
      .expect(403);

    expect(policyService.getPolicy).not.toHaveBeenCalled();
    expect(res.body.error).toBe('tenant_required');
  });
});
