import express from 'express';
import request from 'supertest';
import { fakeAuthMiddleware } from './routerTestAuth';

describe('fakeAuthMiddleware', () => {
  it('default overrides populate req.user with test-tenant', async () => {
    const app = express();
    app.use(fakeAuthMiddleware());
    app.get('/probe', (req, res) => { res.json({ user: req.user }); });
    const res = await request(app).get('/probe');
    expect(res.body.user).toEqual({
      id: 'test-user', username: 'test-user', tenantId: 'test-tenant', roles: [], permissions: [],
    });
  });

  it('overrides apply', async () => {
    const app = express();
    app.use(fakeAuthMiddleware({ tenantId: 'tenant-x', roles: ['admin'] }));
    app.get('/probe', (req, res) => { res.json({ user: req.user }); });
    const res = await request(app).get('/probe');
    expect(res.body.user.tenantId).toBe('tenant-x');
    expect(res.body.user.roles).toEqual(['admin']);
  });

  it('explicit tenantId: undefined results in req.user without tenantId', async () => {
    const app = express();
    app.use(fakeAuthMiddleware({ tenantId: undefined }));
    app.get('/probe', (req, res) => { res.json({ tenantId: req.user?.tenantId ?? null }); });
    const res = await request(app).get('/probe');
    expect(res.body.tenantId).toBeNull();
  });
});
