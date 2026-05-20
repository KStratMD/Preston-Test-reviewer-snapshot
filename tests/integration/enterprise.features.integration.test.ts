import './setupEnv';
import request from 'supertest';
import type { Application as ExpressApp } from 'express';
import { App } from '../../src/app';
import { createTestApp } from './helpers/testServices';

jest.setTimeout(300000);

describe('Enterprise Features API', () => {
  let expressApp: ExpressApp;
  let appInstance: App;

  beforeAll(async () => {
    const testApp = await createTestApp();
    appInstance = testApp.appInstance;
    expressApp = testApp.expressApp;
  });

  afterAll(async () => {
    if (appInstance && typeof appInstance.shutdown === 'function') {
      await appInstance.shutdown();
    }
  });

  it('returns enterprise feature status snapshot', async () => {
    const response = await request(expressApp)
      .get('/api/enterprise/features/status')
      .expect(200);

    expect(response.body).toHaveProperty('bcMetadata');
    expect(response.body.bcMetadata).toHaveProperty('status');
    expect(response.body.bcMetadata).toHaveProperty('cacheHitRate');
    expect(response.body).toHaveProperty('deltaSyncCursors');
    expect(response.body).toHaveProperty('approveToApply');
    expect(response.body).toHaveProperty('netsuiteGovernance');
    expect(response.body).toHaveProperty('goldenSetEvaluator');
    expect(response.body).toHaveProperty('universalTranslation');
  });

  it('refreshes BC metadata and updates status metrics', async () => {
    const statusBefore = await request(expressApp)
      .get('/api/enterprise/features/status')
      .expect(200);

    const previousSync = new Date(statusBefore.body.bcMetadata.lastSync).getTime();

    const refreshResponse = await request(expressApp)
      .post('/api/enterprise/bcMetadata/refresh')
      .expect(200);

    expect(refreshResponse.body.success).toBe(true);
    expect(refreshResponse.body).toHaveProperty('entitiesRefreshed');

    const statusAfter = await request(expressApp)
      .get('/api/enterprise/features/status')
      .expect(200);

    const nextSync = new Date(statusAfter.body.bcMetadata.lastSync).getTime();
    expect(nextSync).toBeGreaterThan(previousSync);
    expect(statusAfter.body.bcMetadata.entitiesRefreshed).toBe(refreshResponse.body.entitiesRefreshed);
  });

  it('exposes delta sync cursor telemetry', async () => {
    const response = await request(expressApp)
      .get('/api/enterprise/deltaSyncCursors')
      .expect(200);

    expect(Array.isArray(response.body.cursors)).toBe(true);
    expect(response.body.cursors.length).toBeGreaterThan(0);
    expect(response.body).toHaveProperty('totalCursors');
    expect(response.body).toHaveProperty('checksumMatches');
  });

  it('provides approval queue insights', async () => {
    const response = await request(expressApp)
      .get('/api/enterprise/approvals')
      .expect(200);

    expect(Array.isArray(response.body.pendingApprovals)).toBe(true);
    expect(response.body).toHaveProperty('totalPending');
    expect(response.body).toHaveProperty('hashVerifications');
    expect(response.body).toHaveProperty('mismatchRate');
  });

  it('resets NetSuite governance counters', async () => {
    const statusBefore = await request(expressApp)
      .get('/api/enterprise/features/status')
      .expect(200);

    const previousUnits = statusBefore.body.netsuiteGovernance.unitsConsumed;

    const resetResponse = await request(expressApp)
      .post('/api/enterprise/governance/reset')
      .expect(200);

    expect(resetResponse.body.success).toBe(true);
    expect(resetResponse.body.newUnitsConsumed).toBe(0);

    const statusAfter = await request(expressApp)
      .get('/api/enterprise/features/status')
      .expect(200);

    expect(statusAfter.body.netsuiteGovernance.unitsConsumed).toBe(0);
    expect(resetResponse.body.previousUnitsConsumed).toBe(previousUnits);
  });

  it('runs golden-set evaluation and returns results', async () => {
    const response = await request(expressApp)
      .post('/api/enterprise/golden-set/evaluate')
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.evaluation).toMatchObject({
      testCases: expect.any(Number),
      passed: expect.any(Number),
      failed: expect.any(Number),
      accuracy: expect.any(Number),
      hallucinations: expect.any(Number),
      avgConfidence: expect.any(Number)
    });
  });

  it('runs universal translation sample', async () => {
    const response = await request(expressApp)
      .post('/api/enterprise/translation/test')
      .send({ format: 'X12 850', sampleData: 'ISA*TEST~' })
      .expect(200);

    expect(response.body.success).toBe(true);
    expect(response.body.translated).toMatchObject({
      format: 'X12 850',
      outputFormat: expect.any(String),
      processingTime: expect.any(Number),
      confidence: expect.any(Number)
    });
  });

  it('increments usage summary after actions', async () => {
    const statsBefore = await request(expressApp)
      .get('/api/enterprise/stats')
      .expect(200);

    const beforeTotal = statsBefore.body.summary.totalOperations;

    await request(expressApp)
      .post('/api/enterprise/bcMetadata/refresh')
      .expect(200);

    const statsAfter = await request(expressApp)
      .get('/api/enterprise/stats')
      .expect(200);

    expect(statsAfter.body.summary.totalOperations).toBeGreaterThan(beforeTotal);
  });

  it('records activity entries for recent actions', async () => {
    const response = await request(expressApp)
      .get('/api/enterprise/activity')
      .expect(200);

    expect(Array.isArray(response.body.activities)).toBe(true);

    const featuresSeen = response.body.activities.map((activity: { feature: string }) => activity.feature);
    expect(featuresSeen).toEqual(expect.arrayContaining([
      'BC Metadata',
      'NetSuite Governance',
      'Golden-Set Evaluator',
      'Universal Translator'
    ]));
  });
});