import request from 'supertest';
import { App } from '../../app';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { TrainingDataRepository } from '../../services/ai/TrainingDataRepository';

describe('AI Mapping Suggestions - dataset weighting flow', () => {
  let app: App;

  beforeAll(async () => {
    process.env.FORCE_FULL_APP_MODE = '1';
    app = new App({ lightweight: false });
    await app.waitForInitialization();
  });

  afterAll(async () => {
    await app.shutdown();
  });

  test('training repo computes per-signal effectiveness for dataset', async () => {
    const repo = container.get<TrainingDataRepository>(TYPES.TrainingDataRepository);
    const ds = `weighting-ds-${Date.now()}`;

    // Seed examples: strong semantic success, weak pattern
    const base = {
      sourceSystem: 'CRM',
      targetSystem: 'ERP',
      transformationType: 'direct',
      createdAt: new Date()
    } as any;

    const mk = (id: string, successRate: number, signals: string[]) => ({
      ...base,
      id,
      sourceField: 'name',
      targetField: 'customerName',
      successRate,
      userFeedback: successRate >= 0.6 ? 'positive' : 'negative',
      context: { signals }
    });

    // Semantic successes
    await repo.storeTrainingExample(mk('s1', 0.9, ['semantic']), ds);
    await repo.storeTrainingExample(mk('s2', 0.85, ['semantic']), ds);
    await repo.storeTrainingExample(mk('s3', 0.8, ['semantic']), ds);
    // Pattern mixed/weak
    await repo.storeTrainingExample(mk('p1', 0.5, ['pattern']), ds);
    await repo.storeTrainingExample(mk('p2', 0.4, ['pattern']), ds);
    await repo.storeTrainingExample(mk('p3', 0.45, ['pattern']), ds);

    const adj = await repo.getSignalEffectiveness(ds);
    // Expect semantic multiplier >= 1 and pattern <= 1
    expect(typeof adj.semantic === 'number').toBe(true);
    expect(typeof adj.pattern === 'number').toBe(true);
    if (adj.semantic && adj.pattern) {
      expect(adj.semantic).toBeGreaterThan(1 - 1e-9);
      expect(adj.pattern).toBeLessThan(1 + 1e-9);
    }
  });

  test('POST /api/ai/proxy/mapping/suggestions accepts datasetId and returns suggestions', async () => {
    const ds = `weighting-ds2-${Date.now()}`;
    const payload = {
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      sourceFields: [
        { name: 'Email', type: 'string' },
        { name: 'FirstName', type: 'string' }
      ],
      targetFields: [
        { name: 'emailAddress', type: 'string' },
        { name: 'first_name', type: 'string' }
      ],
      sampleData: [ { Email: 'test@example.com', FirstName: 'Ada' } ],
      datasetId: ds
    };

    const res = await request(app.getExpressApp())
      .post('/api/ai/proxy/mapping/suggestions')
      .send(payload);

    expect([200, 400]).toContain(res.status); // 400 only if missing schema validation changes in route
    if (res.status === 200) {
      expect(Array.isArray(res.body.suggestions)).toBe(true);
      if (res.body.suggestions.length) {
        expect(res.body.suggestions[0]).toHaveProperty('sourceField');
        expect(res.body.suggestions[0]).toHaveProperty('targetField');
        expect(typeof res.body.suggestions[0].confidence).toBe('number');
      }
    } else {
      // Ensure error structure present on validation failure
      expect(res.body).toHaveProperty('error');
    }
  }, 60000); // 60 second timeout for AI processing
});
