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

  it('allows admin header fallback only when tenant claims are absent', async () => {
    const { app, policyService } = await createApp({
      roles: ['admin'],
      permissions: ['*'],
      userId: null,
      userTenantId: null,
    });

    await request(app)
      .get('/api/mcp/policies')
      .set('x-tenant-id', 'tenant-from-header')
      .expect(200);

    expect(policyService.getPolicy).toHaveBeenCalledWith('tenant-from-header');
  });
});
