// tests/unit/routes/identityRoutes.test.ts
import express from 'express';
import request from 'supertest';
import router from '../../../src/routes/identityRoutes';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';

// The route shows a real identity only when req.user carries BOTH a non-empty
// id AND a non-empty tenantId, and NEITHER is the system sentinel. A
// tenant-less JWT, or one claiming the sentinel in either field, gets the demo
// fallback. Mirror the req.user shape optionalAuthMiddleware sets here.
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
      capabilities: {
        helpReindex: false,
      },
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
      capabilities: {
        helpReindex: false,
      },
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
      capabilities: {
        helpReindex: false,
      },
    });
  });

  it('never advertises reindex from admin-shaped claims that lack tenant identity', async () => {
    const app = makeApp({
      id: 'orphan-admin',
      username: 'orphan-admin',
      roles: ['admin'],
      permissions: ['*'],
    });

    const res = await request(app).get('/api/identity');

    expect(res.body.authenticated).toBe(false);
    expect(res.body.capabilities).toEqual({ helpReindex: false });
  });

  it('advertises help reindex for a platform administrator role', async () => {
    const app = makeApp({
      id: 'platform-1',
      username: 'platform-admin',
      tenantId: 'acme',
      roles: ['admin'],
      permissions: [],
    });

    const res = await request(app).get('/api/identity');

    expect(res.body.capabilities).toEqual({ helpReindex: true });
  });

  it('advertises help reindex for the canonical wildcard permission', async () => {
    const app = makeApp({
      id: 'platform-2',
      username: 'wildcard-admin',
      tenantId: 'acme',
      roles: ['user'],
      permissions: ['*'],
    });

    const res = await request(app).get('/api/identity');

    expect(res.body.capabilities).toEqual({ helpReindex: true });
  });

  it('does not advertise help reindex for an ordinary tenant user', async () => {
    const app = makeApp({
      id: 'tenant-1',
      username: 'tenant-user',
      tenantId: 'acme',
      roles: ['user'],
      permissions: ['help:read'],
    });

    const res = await request(app).get('/api/identity');

    expect(res.body.capabilities).toEqual({ helpReindex: false });
  });
  // auth.ts accepts tenantId === SYSTEM_IDENTITY.tenantId, and the old
  // extractIdentityContext treated that as system EVEN WITH a real user id.
  // The predicate must reject the sentinel in BOTH fields, or a system-tenant
  // JWT would start receiving an authenticated identity — and helpReindex —
  // that it does not get today.
  it('a JWT claiming the system tenant gets the demo card, not an identity', async () => {
    const res = await request(makeApp({
      id: 'real-user', username: 'real', roles: ['admin'], permissions: [],
      tenantId: SYSTEM_IDENTITY.tenantId,
    })).get('/api/identity');
    expect(res.body).toMatchObject({
      authenticated: false,
      displayName: 'Demo User',
      capabilities: { helpReindex: false },
    });
  });

  it('a user whose id IS the system sentinel gets the demo card', async () => {
    const res = await request(makeApp({
      id: SYSTEM_IDENTITY.userId, username: 'sys', roles: [], permissions: [],
      tenantId: 'tenant-a',
    })).get('/api/identity');
    expect(res.body).toMatchObject({ authenticated: false, displayName: 'Demo User' });
  });

  it('rejects padded system sentinels and does not coerce non-string ids', async () => {
    const paddedSentinel = await request(makeApp({
      id: ` ${SYSTEM_IDENTITY.userId} `,
      username: 'padded-system',
      roles: ['admin'],
      permissions: [],
      tenantId: 'tenant-a',
    })).get('/api/identity');
    expect(paddedSentinel.body).toMatchObject({ authenticated: false, displayName: 'Demo User' });

    const objectId = await request(makeApp({
      id: { unexpected: true },
      username: 'object-id',
      roles: ['admin'],
      permissions: [],
      tenantId: 'tenant-a',
    })).get('/api/identity');
    expect(objectId.body).toMatchObject({ authenticated: false, displayName: 'Demo User' });
  });
});
