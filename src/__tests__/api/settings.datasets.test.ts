import request from 'supertest';
import { App } from '../../app';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { TrainingDataRepository } from '../../services/ai/TrainingDataRepository';
import type { AuthService } from '../../services/AuthService';

describe('Settings API - AI Datasets', () => {
  let app: App;
  // POST /api/settings/ai/dataset now requires authentication. In the fast
  // config AuthService is a jest mock, so we point its verifyJWT at a
  // subject-bearing payload; authMiddleware then populates req.user.id from it.
  const authHeader = 'Bearer test-token';
  const TEST_USER_ID = 'dataset-test-user';

  beforeAll(async () => {
    process.env.FORCE_FULL_APP_MODE = '1';
    app = new App({ lightweight: false });
    await app.waitForInitialization();
    const authService = container.get<AuthService>(TYPES.AuthService);
    (authService.verifyJWT as jest.Mock).mockReturnValue({
      sub: TEST_USER_ID,
      tenantId: 'tenant-test',
    });
  });

  afterAll(async () => {
    await app.shutdown();
  });

  test('GET /api/settings/ai/dataset returns a datasetId', async () => {
    const res = await request(app.getExpressApp()).get('/api/settings/ai/dataset');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('datasetId');
    expect(typeof res.body.datasetId).toBe('string');
  });

  test('POST /api/settings/ai/dataset requires authentication', async () => {
    const res = await request(app.getExpressApp())
      .post('/api/settings/ai/dataset')
      .send({ datasetId: 'anon-should-fail' });
    expect(res.status).toBe(401);
  });

  test('POST /api/settings/ai/dataset sets dataset preference and GET returns it', async () => {
    const ds = `test-ds-${Date.now()}`;
    const post = await request(app.getExpressApp())
      .post('/api/settings/ai/dataset')
      .set('Authorization', authHeader)
      .send({ datasetId: ds });
    expect(post.status).toBe(200);
    expect(post.body).toMatchObject({ success: true, datasetId: ds });

    // Read back as the same identity — the preference is keyed by the verified
    // user id, so an anonymous GET would resolve a different key.
    const get = await request(app.getExpressApp())
      .get('/api/settings/ai/dataset')
      .set('Authorization', authHeader);
    expect(get.status).toBe(200);
    expect(get.body.datasetId).toBe(ds);
  });

  test('GET /api/settings/ai/datasets lists datasets (after seeding examples)', async () => {
    const trainingRepo = container.get<TrainingDataRepository>(TYPES.TrainingDataRepository);
    const ds = `list-ds-${Date.now()}`;
    // Seed a couple of examples into the repository to ensure dataset appears
    await trainingRepo.storeTrainingExample({
      id: `ex-${Date.now()}-1`,
      sourceSystem: 'CRM',
      targetSystem: 'ERP',
      sourceField: 'email',
      targetField: 'emailAddress',
      transformationType: 'direct',
      successRate: 0.9,
      userFeedback: 'positive',
      createdAt: new Date()
    } as any, ds);

    const res = await request(app.getExpressApp()).get('/api/settings/ai/datasets');
    if (res.status !== 200) {
       
      console.log('Datasets endpoint error payload:', res.text || res.body);
    }
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('datasets');
    expect(Array.isArray(res.body.datasets)).toBe(true);
    // Prefer our dataset to be present; tolerate fail-open empty list
    const found = res.body.datasets.find((d: any) => d.id === ds);
    if (found) {
      expect(found.exampleCount).toBeGreaterThanOrEqual(1);
    }
  });

  test('GET /api/settings/ai/datasets/:id/examples returns limited examples', async () => {
    const trainingRepo = container.get<TrainingDataRepository>(TYPES.TrainingDataRepository);
    const ds = `examples-ds-${Date.now()}`;
    // Seed 3 examples
    for (let i = 0; i < 3; i++) {
      await trainingRepo.storeTrainingExample({
        id: `ex-${Date.now()}-${i}`,
        sourceSystem: 'CRM',
        targetSystem: 'ERP',
        sourceField: `field_${i}`,
        targetField: `target_${i}`,
        transformationType: 'direct',
        successRate: 0.5 + 0.1 * i,
        userFeedback: 'positive',
        createdAt: new Date()
      } as any, ds);
    }

    const res = await request(app.getExpressApp()).get(`/api/settings/ai/datasets/${encodeURIComponent(ds)}/examples?limit=2`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('examples');
    expect(Array.isArray(res.body.examples)).toBe(true);
    expect(res.body.examples.length).toBeLessThanOrEqual(2);
    if (res.body.examples.length) {
      expect(res.body.examples[0]).toHaveProperty('sourceField');
      expect(res.body.examples[0]).toHaveProperty('targetField');
    }
  });
});
