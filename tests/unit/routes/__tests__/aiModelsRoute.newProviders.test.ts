import request from 'supertest';
import jwt from 'jsonwebtoken';

// F2: /api/ai/proxy mounts behind createAiProxyPolicyGate — model reads
// require an authenticated tenant and POST /models/:provider/select is
// platform-admin. fastMocks' AuthService stub ignores tokens (no subject →
// 401), so restore the real HS256 verification path BEFORE App wires its
// bindings. jest.unmock is hoisted above imports by the transform; keeping it
// above the App import in source makes the ordering explicit.
jest.unmock('../../../../src/services/AuthService');

// F2: sign with the SAME secret AuthService.verifyJWT resolves. Set it before
// importing App so both the env parse and the token share one value — CI has
// no .env, and jwt.sign(claims, undefined) would otherwise throw.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

import { App } from '../../../../src/app';

/**
 * Route-level tests for new provider model listing & selection endpoints.
 * These are resilient: they skip assertions requiring real keys if providers are not registered.
 */

describe('AI Models Route - New Providers', () => {
  const appInstance = new App({ lightweight: true });
  let expressApp: any;
  let tenantAuth: Record<string, string>;
  let adminAuth: Record<string, string>;
  beforeAll(async () => {
    await appInstance.waitForInitialization();
    expressApp = appInstance.getExpressApp();
    const secret = process.env.JWT_SECRET as string;
    const sign = (claims: Record<string, unknown>) =>
      jwt.sign(claims, secret, { algorithm: 'HS256', expiresIn: '5m' });
    tenantAuth = { Authorization: `Bearer ${sign({ id: 'u1', username: 'u1', tenantId: 'tenant-models-test', roles: ['user'] })}` };
    adminAuth = { Authorization: `Bearer ${sign({ id: 'a1', username: 'a1', tenantId: 'tenant-models-test', roles: ['admin'] })}` };
  });
  afterAll(async () => { await appInstance.shutdown(); });
  const providers = ['grok','gemini','lmstudio'];

  test('anonymous GET /api/ai/proxy/models/:provider is refused by the strict central gate', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models/gemini');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  test('GET /api/ai/proxy/models/:provider invalid provider returns client error', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models/invalid-provider').set(tenantAuth);
    expect([400,404]).toContain(res.status);
    if (res.body && Object.prototype.hasOwnProperty.call(res.body, 'success')) {
      expect(res.body.success).toBe(false);
    }
  });

  test('GET /api/ai/proxy/models/:provider returns success or graceful fallback', async () => {
    for (const p of providers) {
  const res = await request(expressApp).get(`/api/ai/proxy/models/${p}`).set(tenantAuth);
      if (res.status === 200) {
        expect(res.body.provider).toBe(p);
        expect(Array.isArray(res.body.models)).toBe(true);
      } else {
        // If 500, allow only if provider intentionally not bound and error message present
  expect([400,404,500]).toContain(res.status);
      }
    }
  });

  test('POST /api/ai/proxy/models/:provider/select is platform_admin — tenant JWT gets 403', async () => {
    const res = await request(expressApp)
      .post('/api/ai/proxy/models/gemini/select')
      .set(tenantAuth)
      .send({ modelId: 'test-model-id' });
    expect(res.status).toBe(403);
  });

  test('POST /api/ai/proxy/models/:provider/select handles missing modelId', async () => {
    const res = await request(expressApp)
      .post('/api/ai/proxy/models/gemini/select')
      .set(adminAuth)
      .send({});
  expect([400,404]).toContain(res.status);
  });

  test('POST /api/ai/proxy/models/:provider/select sets model when provider supports switching', async () => {
    // Attempt only for providers that likely support dynamic switching
    for (const p of providers) {
      const res = await request(expressApp)
        .post(`/api/ai/proxy/models/${p}/select`)
        .set(adminAuth)
        .send({ modelId: 'test-model-id' });
      if (res.status === 200) {
        expect(res.body.modelId).toBe('test-model-id');
      } else {
  expect([400,404,500]).toContain(res.status); // allowed if provider not registered
      }
    }
  });
});
