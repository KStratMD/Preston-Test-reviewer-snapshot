import express from 'express';
jest.mock('../../integrations/SuiteCentralNetSuiteSync', () => ({
  runSuiteCentralNetSuiteSync: jest.fn().mockResolvedValue({
    integrationId: 'suitecentral-netsuite',
    syncId: 'sync_test',
    status: 'success',
    success: true,
    recordsProcessed: 3,
    recordsSuccessful: 3,
    recordsFailed: 0,
    errors: [],
    startTime: new Date(),
    endTime: new Date(),
    processingMs: 0,
    processingTime: '0.0s',
  }),
}));
import request from 'supertest';
import { createSuiteCentralNetSuiteSyncRouter } from '../suitecentralNetSuiteSync';
import type { IntegrationService } from '../../services/IntegrationService';
import type { ObservabilityService } from '../../observability';

class MockIntegrationService {
  private status = {
    configId: 'suitecentral-netsuite',
    isRunning: false,
    errorCount: 0,
    successCount: 3,
    lastSync: new Date(),
    lastSyncResult: {
      integrationId: 'suitecentral-netsuite',
      syncId: 'sync_test',
      status: 'success',
      success: true,
      recordsProcessed: 3,
      recordsSuccessful: 3,
      recordsFailed: 0,
      errors: [],
      startTime: new Date(),
      endTime: new Date(),
      processingMs: 0,
      processingTime: '0.0s',
    },
  };

  recordSyncResult(_id: string, result: any) {
    this.status = {
      ...this.status,
      lastSync: result.endTime,
      lastSyncResult: result,
    } as any;
  }

  getIntegrationStatus(_id: string) {
    return this.status as any;
  }
}

const observabilityService = {
  createScope: () => ({
    logger: { info: () => {}, error: () => {}, warn: () => {} },
    tracing: { createSpan: () => ({ end: () => {} }) },
    metrics: { recordCustomMetric: () => {} },
  }),
} as unknown as ObservabilityService;

describe('suitecentralNetSuiteSync routes', () => {
  const integrationService = new MockIntegrationService() as unknown as IntegrationService;
  const app = express();
  app.use(express.json());
  app.use(createSuiteCentralNetSuiteSyncRouter(integrationService, observabilityService));

  test('POST /sync returns completed result', async () => {
    const res = await request(app).post('/sync').expect(200);
    expect(res.body.status).toBe('success');
    expect(res.body.recordsProcessed).toBeGreaterThan(0);
  });

  test('GET /sync/status reports progress', async () => {
    await request(app).post('/sync').expect(200);
    const res = await request(app).get('/sync/status').expect(200);
    expect(res.body.lastSyncResult.status).toBe('success');
    expect(res.body.isRunning).toBe(false);
  });
});