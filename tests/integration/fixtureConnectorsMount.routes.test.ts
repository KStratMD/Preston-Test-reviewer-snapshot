/**
 * /api/fixtures was mounted BARE — no authMiddleware, no kill switch — while
 * routePolicy.ts has always declared it `auth: 'required'`,
 * `lifecycle: 'enforce'`. An anonymous POST therefore reached guardedWrite and
 * inserted a durable audit_logs row attributed to the retired __system__
 * sentinel. This pins the runtime to the declared policy.
 */
import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

import { mountFixtureConnectorRoutes } from '../../src/middleware/setup/RouteSetup';
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
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

describe('/api/fixtures mount composition', () => {
  let app: express.Application;
  const hits = jest.fn();

  beforeAll(() => {
    app = express();
    app.use(express.json());
    const spy = express.Router();
    spy.all('*', (_req, res) => { hits(); res.status(200).json({ ok: true }); });
    mountFixtureConnectorRoutes(app, fakeTenantService, spy);
  });
  beforeEach(() => jest.clearAllMocks());

  it('anonymous GET → 401; router unreached', async () => {
    const res = await request(app).get('/api/fixtures/available-systems');
    expect(res.status).toBe(401);
    expect(hits).not.toHaveBeenCalled();
  });

  it('anonymous POST → 401; router unreached (no durable audit row)', async () => {
    const res = await request(app).post('/api/fixtures/netsuite/customers').send({});
    expect(res.status).toBe(401);
    expect(hits).not.toHaveBeenCalled();
  });

  it('tenant-less JWT → 403 (fail closed)', async () => {
    const res = await request(app)
      .get('/api/fixtures/available-systems')
      .set('Authorization', `Bearer ${signToken({ sub: 'user-1' })}`);
    expect(res.status).toBe(403);
    expect(hits).not.toHaveBeenCalled();
  });

  it('suspended tenant → 403 tenant_blocked; router unreached', async () => {
    const res = await request(app)
      .get('/api/fixtures/available-systems')
      .set('Authorization', `Bearer ${signToken({ sub: 'user-1', tenantId: SUSPENDED_TENANT })}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    expect(hits).not.toHaveBeenCalled();
  });

  it('active tenant → router reached', async () => {
    const res = await request(app)
      .get('/api/fixtures/available-systems')
      .set('Authorization', `Bearer ${signToken({ sub: 'user-1', tenantId: 'tenant-a' })}`);
    expect(res.status).toBe(200);
    expect(hits).toHaveBeenCalledTimes(1);
  });
});
