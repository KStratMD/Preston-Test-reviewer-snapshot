// Real-JWT integration coverage for the platform-admin settings boundary.
//
// Mounts /api/admin/settings exactly as production does — authMiddleware first,
// then the router whose first handler is requirePlatformAdmin — and drives it
// with JWTs signed against the real test secret. Handler-only tests with a
// mocked pass-through middleware cannot prove this ordering; these can.
//
// jest.slow.config.cjs runs tests/integration/setupEnv.ts BEFORE this module
// loads, setting process.env.JWT_SECRET ← STRONG_TEST_JWT_SECRET, which
// authMiddleware captures via env.JWT_SECRET on its first resolveServices()
// call. Signing here with the same secret keeps verification deterministic.

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import { authMiddleware } from '../../src/middleware/auth';
import { createAdminSettingsRouter } from '../../src/routes/adminSettings';
import { getDemoModeOverride } from '../../src/config/runtimeFlags';

const JWT_SECRET = STRONG_TEST_JWT_SECRET;

const adminService = { setDemoMode: jest.fn() };

function signJwt(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
}

const userToken = signJwt({ sub: 'user-1', tenantId: 'tenant-a', roles: ['user'], permissions: [] });
const adminToken = signJwt({ sub: 'admin-1', tenantId: 'platform', roles: ['admin'], permissions: ['*'] });

async function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/settings', authMiddleware, await createAdminSettingsRouter(adminService as never));
  // Minimal terminal error handler so an unexpected throw surfaces as 500
  // rather than hanging the request (matches production fail-closed behavior).
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: err instanceof Error ? err.message : 'internal error' });
  });
  return app;
}

describe('settings authorization — real JWT admin boundary', () => {
  let app: express.Express;

  beforeAll(async () => {
    app = await buildApp();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    adminService.setDemoMode.mockResolvedValue({ enabled: true });
  });

  it('authenticates before validating the admin body', async () => {
    // Invalid body, but no Bearer: must 401 at authMiddleware, never reaching
    // requirePlatformAdmin or body validation, and never touching the service.
    await request(app).post('/api/admin/settings/demo-mode').send({ enabled: 'yes' }).expect(401);
    expect(adminService.setDemoMode).not.toHaveBeenCalled();
  });

  it('forbids an authenticated non-admin', async () => {
    await request(app)
      .post('/api/admin/settings/demo-mode')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ enabled: true })
      .expect(403);
    expect(adminService.setDemoMode).not.toHaveBeenCalled();
  });

  it('allows a platform admin and records only the verified subject', async () => {
    await request(app)
      .post('/api/admin/settings/demo-mode')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: true, userId: 'forged', actorUserId: 'forged' })
      .expect(200);
    expect(adminService.setDemoMode).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: 'admin-1', enabled: true }),
    );
  });

  it('rejects an invalid body from an authenticated admin', async () => {
    await request(app)
      .post('/api/admin/settings/demo-mode')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ enabled: 'yes' })
      .expect(400);
    expect(adminService.setDemoMode).not.toHaveBeenCalled();
  });

  it('leaves the process-global demo override untouched for unauthorized callers', async () => {
    const before = getDemoModeOverride();
    await request(app).post('/api/admin/settings/demo-mode').send({ enabled: true }).expect(401);
    await request(app)
      .post('/api/admin/settings/demo-mode')
      .set('Authorization', `Bearer ${userToken}`)
      .send({ enabled: true })
      .expect(403);
    // No unauthorized path reached the mutation service, so the global runtime
    // override — which the request limiter consults — cannot have flipped.
    expect(getDemoModeOverride()).toBe(before);
    expect(adminService.setDemoMode).not.toHaveBeenCalled();
  });
});
