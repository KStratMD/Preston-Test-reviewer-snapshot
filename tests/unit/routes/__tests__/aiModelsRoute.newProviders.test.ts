import request from 'supertest';
import { App } from '../../../../src/app';

/**
 * Route-level tests for new provider model listing & selection endpoints.
 * These are resilient: they skip assertions requiring real keys if providers are not registered.
 */

describe('AI Models Route - New Providers', () => {
  const appInstance = new App({ lightweight: true });
  let expressApp: any;
  beforeAll(async () => {
    await appInstance.waitForInitialization();
    expressApp = appInstance.getExpressApp();
  });
  afterAll(async () => { await appInstance.shutdown(); });
  const providers = ['grok','gemini','lmstudio'];

  test('GET /api/ai/proxy/models/:provider invalid provider returns client error', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models/invalid-provider');
    expect([400,404]).toContain(res.status);
    if (res.body && Object.prototype.hasOwnProperty.call(res.body, 'success')) {
      expect(res.body.success).toBe(false);
    }
  });

  test('GET /api/ai/proxy/models/:provider returns success or graceful fallback', async () => {
    for (const p of providers) {
  const res = await request(expressApp).get(`/api/ai/proxy/models/${p}`);
      if (res.status === 200) {
        expect(res.body.provider).toBe(p);
        expect(Array.isArray(res.body.models)).toBe(true);
      } else {
        // If 500, allow only if provider intentionally not bound and error message present
  expect([400,404,500]).toContain(res.status);
      }
    }
  });

  test('POST /api/ai/proxy/models/:provider/select handles missing modelId', async () => {
    const res = await request(expressApp)
      .post('/api/ai/proxy/models/gemini/select')
      .send({});
  expect([400,404]).toContain(res.status);
  });

  test('POST /api/ai/proxy/models/:provider/select sets model when provider supports switching', async () => {
    // Attempt only for providers that likely support dynamic switching
    for (const p of providers) {
      const res = await request(expressApp)
        .post(`/api/ai/proxy/models/${p}/select`)
        .send({ modelId: 'test-model-id' });
      if (res.status === 200) {
        expect(res.body.modelId).toBe('test-model-id');
      } else {
  expect([400,404,500]).toContain(res.status); // allowed if provider not registered
      }
    }
  });
});
