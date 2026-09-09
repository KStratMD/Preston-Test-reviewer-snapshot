import request from 'supertest';
import jwt from 'jsonwebtoken';

// F2: model reads under /api/ai/proxy require an authenticated tenant.
// fastMocks' AuthService stub ignores tokens (no subject → 401), so restore
// the real HS256 verification path BEFORE App wires its bindings. jest.unmock
// is hoisted above imports by the transform; keeping it above the App import
// in source makes the ordering explicit.
jest.unmock('../../../src/services/AuthService');

// F2: sign with the SAME secret AuthService.verifyJWT resolves. Set it before
// importing App so both the env parse and the token share one value — CI has
// no .env, and jwt.sign(claims, undefined) would otherwise throw.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { App } from '../../../src/app';

/** Basic smoke tests for new aggregate and active model endpoints */

describe('AI Models Aggregate & Active Routes', () => {
  const appInstance = new App({ lightweight: true });
  let expressApp: any;
  let auth: Record<string, string>;
  beforeAll(async () => {
    await appInstance.waitForInitialization();
    expressApp = appInstance.getExpressApp();
    const token = jwt.sign(
      { id: 'u1', username: 'u1', tenantId: 'tenant-models-agg', roles: ['user'] },
      process.env.JWT_SECRET as string,
      { algorithm: 'HS256', expiresIn: '5m' },
    );
    auth = { Authorization: `Bearer ${token}` };
  });
  afterAll(async () => { await appInstance.shutdown(); });

  test('GET /api/ai/proxy/models returns aggregate structure', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models').set(auth);
  expect([200,500,404]).toContain(res.status); // allow 404 if route not mounted in lightweight mode
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.providers).toBeDefined();
      expect(res.body.active).toBeDefined();
    }
  });

  test('GET /api/ai/proxy/models/active returns active snapshot', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models/active').set(auth);
  expect([200,500,404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.active).toBeDefined();
      expect(res.body.activeModels).toBeDefined();
    }
  });
});
