import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';

import {
  mountActionIslandRoutes,
  mountContextRoutes,
  mountCostTransparencyRoutes,
  mountHelpRoutes,
} from '../../src/middleware/setup/RouteSetup';
import { TenantBlockedError } from '../../src/services/tenants/TenantLifecycleService';

const SUSPENDED_TENANT = 'tenant-suspended';

const fakeTenantService = {
  requireActive: jest.fn(async (tenantId: string) => {
    if (tenantId === SUSPENDED_TENANT) {
      throw new TenantBlockedError(tenantId, 'suspended', 'tenant_suspended');
    }
  }),
} as never;

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

function createApp(demo: boolean): { app: express.Application; routerHits: jest.Mock } {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });

  app.use(express.json());
  mountContextRoutes(app, fakeTenantService, router, {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

function createActionApp(demo: boolean): { app: express.Application; routerHits: jest.Mock } {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });
  app.use(express.json());
  mountActionIslandRoutes(app, fakeTenantService, router, {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

function createHelpApp(demo: boolean): { app: express.Application; routerHits: jest.Mock } {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });
  app.use(express.json());
  mountHelpRoutes(app, fakeTenantService, router, {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

function createCostTransparencyApp(demo: boolean): { app: express.Application; routerHits: jest.Mock } {
  const app = express();
  const routerHits = jest.fn();
  const router = express.Router();
  router.all('*', (_req, res) => {
    routerHits();
    res.status(200).json({ reached: true });
  });
  app.use(express.json());
  mountCostTransparencyRoutes(app, fakeTenantService, router, {
    isDemoRuntime: () => demo,
    demoLimiter: (_req, _res, next) => next(),
  });
  return { app, routerHits };
}

describe('/api/context mount — demo-family policy gate (F5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('anonymous GET reaches the router only in a demo runtime', async () => {
    const { app, routerHits } = createApp(true);

    const res = await request(app).get('/api/context/netsuite/customer/123');

    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('anonymous GET is 401 outside a demo runtime', async () => {
    const { app, routerHits } = createApp(false);

    const res = await request(app).get('/api/context/netsuite/customer/123');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('garbage Bearer credentials cannot enter the anonymous demo branch', async () => {
    const { app, routerHits } = createApp(true);

    const res = await request(app)
      .get('/api/context/netsuite/customer/123')
      .set('Authorization', 'Bearer not-a-jwt');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('a suspended tenant is blocked before the router', async () => {
    const { app, routerHits } = createApp(true);
    const token = signToken({ sub: 'user-1', tenantId: SUSPENDED_TENANT });

    const res = await request(app)
      .get('/api/context/netsuite/customer/123')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('an active tenant reaches the router', async () => {
    const { app, routerHits } = createApp(false);
    const token = signToken({ sub: 'user-1', tenantId: 'tenant-active' });

    const res = await request(app)
      .get('/api/context/netsuite/customer/123')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
    expect(routerHits).toHaveBeenCalledTimes(1);
  });
});

describe('/api/actions mount - demo-family policy gate (F5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows an anonymous exact demo action in a demo runtime', async () => {
    const { app, routerHits } = createActionApp(true);
    const res = await request(app).post('/api/actions/request-w9').send({});
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('rejects an anonymous action outside the exact demo allowlist', async () => {
    const { app, routerHits } = createActionApp(true);
    const res = await request(app).post('/api/actions/check-inventory').send({});
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an anonymous exact demo action outside a demo runtime', async () => {
    const { app, routerHits } = createActionApp(false);
    const res = await request(app).post('/api/actions/request-w9').send({});
    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('blocks a suspended tenant from an exact demo action before the router', async () => {
    const { app, routerHits } = createActionApp(true);
    const token = signToken({ sub: 'user-1', tenantId: SUSPENDED_TENANT });
    const res = await request(app).post('/api/actions/request-w9')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows an active tenant to reach an action outside the demo allowlist', async () => {
    const { app, routerHits } = createActionApp(false);
    const token = signToken({ sub: 'user-1', tenantId: 'tenant-active' });
    const res = await request(app).post('/api/actions/check-inventory')
      .set('Authorization', `Bearer ${token}`).send({});
    expect(res.status).toBe(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('keeps the health probe public outside a demo runtime', async () => {
    const { app, routerHits } = createActionApp(false);
    const res = await request(app).get('/api/actions/health');
    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('does not expose health descendants outside a demo runtime', async () => {
    const { app, routerHits } = createActionApp(false);
    const res = await request(app).get('/api/actions/health/private');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });
});

describe('/api/help mount - demo-family policy gate (F5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('allows anonymous POST /chat in a demo runtime', async () => {
    const { app, routerHits } = createHelpApp(true);

    const res = await request(app).post('/api/help/chat').send({ message: 'hello' });

    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('rejects anonymous POST /chat outside a demo runtime', async () => {
    const { app, routerHits } = createHelpApp(false);

    const res = await request(app).post('/api/help/chat').send({ message: 'hello' });

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows anonymous GET /audiences in a demo runtime', async () => {
    const { app, routerHits } = createHelpApp(true);

    const res = await request(app).get('/api/help/audiences');

    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('rejects anonymous POST /reindex', async () => {
    const { app, routerHits } = createHelpApp(true);

    const res = await request(app).post('/api/help/reindex');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('rejects an ordinary tenant JWT from POST /reindex with the platform-admin error', async () => {
    const { app, routerHits } = createHelpApp(true);
    const token = signToken({
      sub: 'tenant-user',
      tenantId: 'tenant-active',
      roles: ['user'],
      permissions: [],
    });

    const res = await request(app)
      .post('/api/help/reindex')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Platform administrator access required' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows a platform-administrator JWT to POST /reindex', async () => {
    const { app, routerHits } = createHelpApp(false);
    const token = signToken({
      sub: 'platform-admin',
      tenantId: 'tenant-active',
      roles: ['admin'],
      permissions: [],
    });

    const res = await request(app)
      .post('/api/help/reindex')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
    expect(fakeTenantService.requireActive).not.toHaveBeenCalled();
  });

  it('blocks a suspended tenant JWT from GET /session/:id before the router', async () => {
    const { app, routerHits } = createHelpApp(true);
    const token = signToken({
      sub: 'suspended-user',
      tenantId: SUSPENDED_TENANT,
      roles: ['user'],
      permissions: [],
    });

    const res = await request(app)
      .get('/api/help/session/abc')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });
});

describe('/api/cost-transparency mount - strict demo-family policy gate (F5)', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects an anonymous dashboard request outside a demo runtime before the router', async () => {
    const { app, routerHits } = createCostTransparencyApp(false);

    const res = await request(app).get('/api/cost-transparency/dashboard');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('allows an active tenant JWT to reach the dashboard router', async () => {
    const { app, routerHits } = createCostTransparencyApp(false);
    const token = signToken({ sub: 'user-1', tenantId: 'tenant-active' });

    const res = await request(app)
      .get('/api/cost-transparency/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(fakeTenantService.requireActive).toHaveBeenCalledWith('tenant-active');
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('blocks a suspended tenant before the dashboard router', async () => {
    const { app, routerHits } = createCostTransparencyApp(false);
    const token = signToken({ sub: 'user-1', tenantId: SUSPENDED_TENANT });

    const res = await request(app)
      .get('/api/cost-transparency/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(routerHits).not.toHaveBeenCalled();
  });

  it('keeps the exact health probe public outside a demo runtime', async () => {
    const { app, routerHits } = createCostTransparencyApp(false);

    const res = await request(app).get('/api/cost-transparency/health');

    expect(res.status).toBe(200);
    expect(routerHits).toHaveBeenCalledTimes(1);
  });

  it('does not expose health descendants outside a demo runtime', async () => {
    const { app, routerHits } = createCostTransparencyApp(false);

    const res = await request(app).get('/api/cost-transparency/health/private');

    expect(res.status).toBe(401);
    expect(routerHits).not.toHaveBeenCalled();
  });
});
