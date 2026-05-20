/**
 * Integration Route Tests
 *
 * Tests the /api/integrations API endpoints for integration execution and management.
 * Uses proper mocks matching the actual IntegrationService interface.
 */

import request from 'supertest';
import express from 'express';
import type { IntegrationService } from '../../../../src/services/IntegrationService';
import type { Logger } from '../../../../src/utils/Logger';

// Create comprehensive mock matching actual IntegrationService
function createMockIntegrationService(): jest.Mocked<Partial<IntegrationService>> {
  return {
    // Route looks for these method names first (test compatibility)
    executeIntegration: jest.fn(),
    testConnection: jest.fn(),
    getAllIntegrationStatuses: jest.fn(),

    // Then falls back to these (actual service methods)
    runIntegration: jest.fn(),
    testIntegration: jest.fn(),
    getIntegrationStatus: jest.fn(),
    stopIntegration: jest.fn(),
    syncSingleRecord: jest.fn(),
  } as any;
}

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as any;
}

function createTestApp(integrationService: Partial<IntegrationService>, logger?: Logger) {
  const app = express();
  app.use(express.json());

  const { createIntegrationRouter } = require('../../../../src/routes/integration');
  const router = createIntegrationRouter({
    integrationService: integrationService as IntegrationService,
    logger,
  });

  app.use(router);
  return app;
}

describe('Integration Route', () => {
  let app: express.Application;
  let mockIntegrationService: jest.Mocked<Partial<IntegrationService>>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockIntegrationService = createMockIntegrationService();
    mockLogger = createMockLogger();
    app = createTestApp(mockIntegrationService, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /api/integrations/:id/run', () => {
    it('should execute integration using executeIntegration method', async () => {
      mockIntegrationService.executeIntegration!.mockResolvedValue({
        status: 'success',
        success: true,
        recordsSynced: 100,
        recordsFailed: 0,
        executionId: 'exec-123',
      });

      const response = await request(app)
        .post('/api/integrations/sf-to-ns/run')
        .send({ batchSize: 50, dryRun: false })
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(response.body.executionId).toBe('exec-123');
      expect(mockIntegrationService.executeIntegration).toHaveBeenCalledWith(
        'sf-to-ns',
        expect.objectContaining({ batchSize: 50, dryRun: false })
      );
    });

    it('should fallback to runIntegration if executeIntegration not available', async () => {
      // Remove executeIntegration to test fallback
      delete (mockIntegrationService as any).executeIntegration;

      mockIntegrationService.runIntegration!.mockResolvedValue({
        status: 'success',
        success: true,
        recordsSynced: 50,
      });

      const response = await request(app)
        .post('/api/integrations/sap-to-oracle/run')
        .expect(200);

      expect(response.body.status).toBe('success');
      expect(mockIntegrationService.runIntegration).toHaveBeenCalledWith(
        'sap-to-oracle',
        expect.any(Object)
      );
    });

    it('should handle integration execution error', async () => {
      mockIntegrationService.executeIntegration!.mockRejectedValue(
        new Error('Integration not found')
      );

      const response = await request(app)
        .post('/api/integrations/non-existent/run')
        .expect(500);

      expect(response.body.error).toContain('Integration not found');
    });

    it('should handle missing integration ID', async () => {
      await request(app)
        .post('/api/integrations//run')
        .expect(404); // Express returns 404 for missing route params
    });
  });

  describe('POST /api/integrations/:id/test', () => {
    it('should test integration using testConnection method', async () => {
      mockIntegrationService.testConnection!.mockResolvedValue({
        success: true,
        errors: [],
        warnings: [],
        sourceConnected: true,
        targetConnected: true,
      });

      const response = await request(app)
        .post('/api/integrations/sf-to-ns/test')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockIntegrationService.testConnection).toHaveBeenCalledWith('sf-to-ns');
    });

    it('should fallback to testIntegration if testConnection not available', async () => {
      delete (mockIntegrationService as any).testConnection;

      mockIntegrationService.testIntegration!.mockResolvedValue({
        success: true,
        errors: [],
        warnings: ['Minor warning'],
      });

      const response = await request(app)
        .post('/api/integrations/test-integration/test')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockIntegrationService.testIntegration).toHaveBeenCalledWith('test-integration');
    });

    it('should handle 404 NotFoundError', async () => {
      const notFoundError = new Error('Configuration test-404 not found');
      (notFoundError as any).statusCode = 404;

      mockIntegrationService.testConnection!.mockRejectedValue(notFoundError);

      const response = await request(app)
        .post('/api/integrations/test-404/test')
        .expect(404);

      expect(response.body.error).toContain('not found');
    });
  });

  describe('POST /api/integrations/:id/stop', () => {
    it('should stop running integration', async () => {
      mockIntegrationService.stopIntegration!.mockResolvedValue(true);

      const response = await request(app)
        .post('/api/integrations/running-integration/stop')
        .expect(200);

      expect(response.body).toBe(true);
      expect(mockIntegrationService.stopIntegration).toHaveBeenCalledWith('running-integration');
    });

    it('should handle stop when integration is not running', async () => {
      mockIntegrationService.stopIntegration!.mockRejectedValue(
        new Error('Integration is not running')
      );

      await request(app)
        .post('/api/integrations/idle-integration/stop')
        .expect(500);
    });
  });

  describe('GET /api/integrations/status', () => {
    it('should get all integration statuses using getAllIntegrationStatuses', async () => {
      mockIntegrationService.getAllIntegrationStatuses!.mockResolvedValue([
        {
          configId: 'integration-1',
          isRunning: true,
          errorCount: 0,
          successCount: 5,
        },
        {
          configId: 'integration-2',
          isRunning: false,
          errorCount: 1,
          successCount: 10,
        },
      ]);

      const response = await request(app)
        .get('/api/integrations/status')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(2);
      expect(response.body[0].configId).toBe('integration-1');
    });

    it('should fallback to getIntegrationStatus when getAllIntegrationStatuses not available', async () => {
      delete (mockIntegrationService as any).getAllIntegrationStatuses;

      // When called with no args (fallback), returns single status
      mockIntegrationService.getIntegrationStatus!.mockResolvedValue({
        configId: 'default',
        isRunning: false,
        errorCount: 0,
        successCount: 1,
      });

      const response = await request(app)
        .get('/api/integrations/status')
        .expect(200);

      expect(Array.isArray(response.body)).toBe(true);
      expect(response.body).toHaveLength(1);
    });

    it('should return empty array when no method available', async () => {
      delete (mockIntegrationService as any).getAllIntegrationStatuses;
      delete (mockIntegrationService as any).getIntegrationStatus;

      const response = await request(app)
        .get('/api/integrations/status')
        .expect(200);

      expect(response.body).toEqual([]);
    });
  });

  describe('GET /api/integrations/:id/status', () => {
    it('should handle missing integration ID', async () => {
      await request(app)
        .get('/api/integrations//status')
        .expect(404);
    });
  });

  describe('POST /api/integrations/:id/sync-record', () => {
    it('should sync single record', async () => {
      mockIntegrationService.syncSingleRecord!.mockResolvedValue({
        success: true,
        recordId: 'REC-123',
        transformedData: { field: 'value' },
      });

      const response = await request(app)
        .post('/api/integrations/sf-to-ns/sync-record')
        .send({ recordId: 'REC-123', entityType: 'customer' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.recordId).toBe('REC-123');
      expect(mockIntegrationService.syncSingleRecord).toHaveBeenCalled();
    });
  });

  describe('POST /api/integrations/:id/mappings', () => {
    it('should save field mappings via the alias method when supplied', async () => {
      const saveFieldMappings = jest.fn().mockResolvedValue({ saved: 3 });
      (mockIntegrationService as Partial<IntegrationService> & { saveFieldMappings?: jest.Mock })
        .saveFieldMappings = saveFieldMappings;
      app = createTestApp(mockIntegrationService, mockLogger);

      const mappings = [
        { sourceField: 'a', targetField: 'A' },
        { sourceField: 'b', targetField: 'B' },
        { sourceField: 'c', targetField: 'C' },
      ];
      const response = await request(app)
        .post('/api/integrations/sf-to-ns/mappings')
        .send({ mappings })
        .expect(200);

      expect(response.body).toEqual({ saved: 3 });
      expect(saveFieldMappings).toHaveBeenCalledWith('sf-to-ns', mappings);
    });

    it('should return 400 when mappings is not an array', async () => {
      const response = await request(app)
        .post('/api/integrations/sf-to-ns/mappings')
        .send({ mappings: 'not-an-array' })
        .expect(400);

      expect(response.body.error).toMatch(/array/i);
    });
  });

  describe('Route Aliases', () => {
    it('should support both /api/integrations/:id/run and /:id/run', async () => {
      mockIntegrationService.executeIntegration!.mockResolvedValue({
        status: 'success',
        success: true,
      });

      await request(app).post('/api/integrations/test/run').expect(200);
      await request(app).post('/test/run').expect(200);

      expect(mockIntegrationService.executeIntegration).toHaveBeenCalledTimes(2);
    });

    it('should support both status endpoints', async () => {
      mockIntegrationService.getAllIntegrationStatuses!.mockResolvedValue([]);

      await request(app).get('/api/integrations/status').expect(200);
      await request(app).get('/status').expect(200);

      expect(mockIntegrationService.getAllIntegrationStatuses).toHaveBeenCalledTimes(2);
    });
  });
});
