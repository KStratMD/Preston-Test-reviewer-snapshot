// tests/unit/routes/identityRoutes.test.ts
import express from 'express';
import request from 'supertest';
import router from '../../../src/routes/identityRoutes';

// The route uses the canonical isSystemIdentity(extractIdentityContext(req))
// model: a real identity is shown only when it resolves NON-system, which
// requires req.user to carry BOTH id AND tenantId (see identityContext.ts:89).
// A tenant-less JWT normalizes to SYSTEM_IDENTITY → demo fallback. Mirror the
// req.user shape optionalAuthMiddleware sets here.
function makeApp(user?: Record<string, unknown>): express.Express {
  const app = express();
  if (user) {
    app.use((req, _res, next) => { (req as express.Request & { user?: unknown }).user = user; next(); });
  }
  app.use('/api/identity', router);
  return app;
}

describe('identityRoutes', () => {
  it('returns the demo fallback for an unauthenticated request', async () => {
    const res = await request(makeApp()).get('/api/identity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      displayName: 'Demo User',
      tenantId: 'Demo Tenant',
      role: 'Platform Admin (Demo)',
    });
  });

  it('sets no-store cache headers (per-caller response must never be cached)', async () => {
    const res = await request(makeApp()).get('/api/identity');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['pragma']).toBe('no-cache');
  });

  it('returns the real-user shape when req.user is populated', async () => {
    const app = makeApp({
      id: 'u1',
      username: 'jdoe',
      tenantId: 'acme',
      roles: ['Admin', 'User'],
      permissions: [],
    });
    const res = await request(app).get('/api/identity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authenticated: true,
      displayName: 'jdoe',
      tenantId: 'acme',
      role: 'Admin',
    });
  });

  it('falls back to "User" role when roles is empty', async () => {
    const app = makeApp({ id: 'u2', username: 'noroles', tenantId: 'acme', roles: [], permissions: [] });
    const res = await request(app).get('/api/identity');
    expect(res.status).toBe(200);
    expect(res.body.authenticated).toBe(true);
    expect(res.body.role).toBe('User');
  });

  it('treats a tenant-less JWT user as system (demo fallback)', async () => {
    // req.user without tenantId → extractIdentityContext returns SYSTEM_IDENTITY,
    // so the canonical isSystemIdentity gate yields the demo fallback (consistent
    // with every other identity consumer in the repo).
    const app = makeApp({ id: 'u3', username: 'orphan', roles: ['Admin'], permissions: [] });
    const res = await request(app).get('/api/identity');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      authenticated: false,
      displayName: 'Demo User',
      tenantId: 'Demo Tenant',
      role: 'Platform Admin (Demo)',
    });
  });
});
