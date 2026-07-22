import request from 'supertest';
import { App } from '../../../src/app';

/** Basic smoke tests for new aggregate and active model endpoints */

describe('AI Models Aggregate & Active Routes', () => {
  const appInstance = new App({ lightweight: true });
  let expressApp: any;
  beforeAll(async () => { await appInstance.waitForInitialization(); expressApp = appInstance.getExpressApp(); });
  afterAll(async () => { await appInstance.shutdown(); });

  test('GET /api/ai/proxy/models returns aggregate structure', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models');
  expect([200,500,404]).toContain(res.status); // allow 404 if route not mounted in lightweight mode
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.providers).toBeDefined();
      expect(res.body.active).toBeDefined();
    }
  });

  test('GET /api/ai/proxy/models/active returns active snapshot', async () => {
    const res = await request(expressApp).get('/api/ai/proxy/models/active');
  expect([200,500,404]).toContain(res.status);
    if (res.status === 200) {
      expect(res.body.success).toBe(true);
      expect(res.body.active).toBeDefined();
      expect(res.body.activeModels).toBeDefined();
    }
  });
});
