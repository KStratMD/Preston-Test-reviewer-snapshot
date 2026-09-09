import request from 'supertest';
import jwt from 'jsonwebtoken';

// F4: /api/suitecentral/sync is a platform-admin surface (mountSuiteCentralSyncRoutes:
// authMiddleware + requirePlatformAdmin + erp-write limiter). The fastMocks
// AuthService stub ignores tokens (no subject → 401), so restore the real
// HS256 verification path — same pattern as aiProxy.smoke.test.ts.
jest.unmock('../../src/services/AuthService');

// Hermeticity (Copilot R2 on PR #1055): the unit-suite setup (fastMocks) does
// NOT set JWT_SECRET, so without this fallback jwt.sign below throws whenever
// the environment lacks one. Must run before App import so src/config sees it.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { App } from '../../src/app';
const adminAuth = () => ({
  Authorization: `Bearer ${jwt.sign(
    { sub: 'sync-smoke-admin', tenantId: 'sync-smoke', roles: ['admin'] },
    process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' },
  )}`,
});

describe('SuiteCentral sync fallback', () => {
  let appInstance: App;
  let server: any;

  beforeAll(async () => {
    appInstance = new App({ lightweight: true });
    await appInstance.waitForInitialization();
    server = appInstance.getExpressApp();
  });

  afterAll(async () => {
    await appInstance.shutdown();
  });

  test('POST /api/suitecentral/sync returns processing fields (admin JWT)', async () => {
    const res = await request(server).post('/api/suitecentral/sync').set(adminAuth()).send({}).expect(200);
    expect(res.body).toBeDefined();
    expect(res.body.processingMs).toBeDefined();
    expect(res.body.processingTime).toBeDefined();
    expect(typeof res.body.processingMs).toBe('number');
    expect(typeof res.body.processingTime).toBe('string');
  });

  test('POST /api/suitecentral/sync anonymous → 401 (F4 platform-admin surface)', async () => {
    await request(server).post('/api/suitecentral/sync').send({}).expect(401);
  });
});
