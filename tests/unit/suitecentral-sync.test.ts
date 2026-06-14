import request from 'supertest';
import { App } from '../../src/app';

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

  test('POST /api/suitecentral/sync returns processing fields', async () => {
    const res = await request(server).post('/api/suitecentral/sync').send({}).expect(200);
    expect(res.body).toBeDefined();
    expect(res.body.processingMs).toBeDefined();
    expect(res.body.processingTime).toBeDefined();
    expect(typeof res.body.processingMs).toBe('number');
    expect(typeof res.body.processingTime).toBe('string');
  });
});
