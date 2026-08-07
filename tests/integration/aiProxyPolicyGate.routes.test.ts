import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import { mountAiProxyRoutes } from '../../src/middleware/setup/RouteSetup';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';

const SUSPENDED_TENANT = 'tenant-suspended';
const routerHits: string[] = [];

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as any;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

function stubRouter(): express.Router {
  const router = express.Router();
  router.use((req, res) => {
    routerHits.push(`${req.method} ${req.path}`);
    res.json({ reached: true, path: req.path });
  });
  return router;
}

function createApp(demo: boolean): express.Application {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  mountAiProxyRoutes(app, fakeTenantService, stubRouter(), { isDemoRuntime: () => demo });
  return app;
}

describe('/api/ai/proxy mount — policy gate + tenant kill switch (F2)', () => {
  beforeAll(() => {
    if (!process.env.JWT_SECRET) process.env.JWT_SECRET = 'integration-test-secret-ai-proxy-gate';
  });

  beforeEach(() => {
    jest.clearAllMocks();
    routerHits.length = 0;
  });

  it('demo off: anonymous GET /status is 401 before the router', async () => {
    await request(createApp(false)).get('/api/ai/proxy/status').expect(401);
    expect(routerHits).toEqual([]);
  });

  it('demo off: anonymous POST /mapping/suggestions is 401', async () => {
    await request(createApp(false)).post('/api/ai/proxy/mapping/suggestions').send({}).expect(401);
    expect(routerHits).toEqual([]);
  });

  it('demo on: exact anonymous allowlist paths reach the router without tenant lookup', async () => {
    const app = createApp(true);
    const calls = [
      () => request(app).get('/api/ai/proxy/providers'),
      () => request(app).get('/api/ai/proxy/mcp/tools'),
      () => request(app).post('/api/ai/proxy/mcp').send({}),
      () => request(app).post('/api/ai/proxy/mapping/suggestions').send({}),
      () => request(app).post('/api/ai/proxy/suggestions/s-1/accept').send({}),
    ];
    for (const call of calls) expect((await call()).status).toBe(200);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
    expect(routerHits).toHaveLength(5);
  });

  it('demo on: anonymous non-allowlisted paths stay 401', async () => {
    const app = createApp(true);
    expect((await request(app).post('/api/ai/proxy/orchestrate').send({})).status).toBe(401);
    expect((await request(app).post('/api/ai/proxy/mapping/apply-suggestions').send({})).status).toBe(401);
    expect((await request(app).put('/api/ai/proxy/provider-config').send({})).status).toBe(401);
    expect(routerHits).toEqual([]);
  });

  it('demo on: suspended-tenant JWT on a demo path is blocked', async () => {
    const token = signToken({ id: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(createApp(true))
      .post('/api/ai/proxy/mapping/suggestions')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_blocked');
    expect(routerHits).toEqual([]);
  });

  it('demo on: active-tenant JWT on a demo path runs the tenant gate', async () => {
    const token = signToken({ id: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    await request(createApp(true))
      .post('/api/ai/proxy/mapping/suggestions')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
  });

  it('demo off: suspended-tenant JWT on a paid path is blocked', async () => {
    const token = signToken({ id: 'u1', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(createApp(false))
      .post('/api/ai/proxy/orchestrate')
      .set('Authorization', `Bearer ${token}`)
      .send({});
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_blocked');
    expect(routerHits).toEqual([]);
  });

  it('demo off: tenant-less JWT fails closed', async () => {
    const token = signToken({ id: 'u1', roles: ['user'] });
    const res = await request(createApp(false))
      .get('/api/ai/proxy/status')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('tenant_id_missing');
    expect(routerHits).toEqual([]);
  });

  it('provider-config rejects ordinary tenants and admits an admin role', async () => {
    const app = createApp(false);
    const tenantToken = signToken({ id: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    const adminToken = signToken({ id: 'a1', tenantId: 'tenant-active', roles: ['admin'] });
    await request(app).put('/api/ai/proxy/provider-config').set('Authorization', `Bearer ${tenantToken}`).send({}).expect(403);
    await request(app).put('/api/ai/proxy/provider-config').set('Authorization', `Bearer ${adminToken}`).send({}).expect(200);
    expect(routerHits).toHaveLength(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('demo off: active-tenant JWT reaches a paid path', async () => {
    const token = signToken({ id: 'u1', tenantId: 'tenant-active', roles: ['user'] });
    await request(createApp(false))
      .post('/api/ai/proxy/orchestrate')
      .set('Authorization', `Bearer ${token}`)
      .send({})
      .expect(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
  });

  it('demo on: anonymous parsed body over 64 KiB is 413', async () => {
    const res = await request(createApp(true))
      .post('/api/ai/proxy/mapping/suggestions')
      .send({ pad: 'x'.repeat(70 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body.error).toBe('demo_payload_too_large');
    expect(routerHits).toEqual([]);
  });
});
