/**
 * Integration Route Tests
 *
 * Tests the /api/integrations API endpoints for integration execution and management.
 * Uses proper mocks matching the actual IntegrationService interface.
 */

import request from 'supertest';
import express from 'express';
import type { IntegrationService } from '../../../../src/services/IntegrationService';
import type { ConfigurationService } from '../../../../src/services/ConfigurationService';
import type { Logger } from '../../../../src/utils/Logger';
import { fakeAuthMiddleware, type FakeUserOverrides } from '../_helpers/routerTestAuth';
import { authMiddleware } from '../../../../src/middleware/auth';
import { NotFoundError } from '../../../../src/errors/NotFoundError';

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

function createTestApp(
  integrationService: Partial<IntegrationService>,
  logger?: Logger,
  authOverrides: FakeUserOverrides = {},
) {
  const app = express();
  app.use(express.json());

  // PR 13c-4 Task 6: mount fakeAuthMiddleware so existing tests populate
  // req.user.tenantId — required after the integration router started
  // narrowing on req.user?.tenantId and 401-ing when absent.
  app.use(fakeAuthMiddleware(authOverrides));

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

describe('Stage A — /api/integrations auth gate (PR 13c-4)', () => {
  // The Stage A suite asserts the anonymous-bypass closure introduced in
  // Task 6: (1) real authMiddleware on the mount rejects requests without
  // a Bearer JWT with 401, (2) authenticated callers whose req.user lacks
  // a tenantId hit the handler-level narrowing 401, (3) requests for a
  // config owned by a different tenant collapse to 404 via the service's
  // tenant-scoped lookup, (4) same-tenant requests reach the handler.
  //
  // Mount note: createIntegrationRouter registers BOTH `${base}/...` and
  // `/...` route aliases. Tests mount the router at '/' so we can hit the
  // unprefixed alias paths ('/status', '/:id/run', etc.) — production mount
  // in RouteSetup.ts is at '/api/integrations'.

  function makeAppWithFakeAuth(
    overrides: FakeUserOverrides = {},
    mockService?: jest.Mocked<Partial<IntegrationService>>,
    mockConfigService?: jest.Mocked<Partial<ConfigurationService>>,
  ) {
    const service = mockService ?? ({
      runIntegrationForTenant: jest.fn(),
      executeIntegration: jest.fn(),
      runIntegration: jest.fn(),
      getAllIntegrationStatuses: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Partial<IntegrationService>>);
    const app = express();
    app.use(express.json());
    app.use('/', fakeAuthMiddleware(overrides));
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createIntegrationRouter } = require('../../../../src/routes/integration');
    app.use(
      '/',
      createIntegrationRouter({
        integrationService: service as IntegrationService,
        ...(mockConfigService ? { configurationService: mockConfigService as ConfigurationService } : {}),
      }),
    );
    return { app, service };
  }

  function makeAppWithRealAuth() {
    const service = {
      runIntegrationForTenant: jest.fn(),
      getAllIntegrationStatuses: jest.fn().mockResolvedValue([]),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const app = express();
    app.use(express.json());
    // Real authMiddleware: missing Bearer JWT → 401 with shape
    // {success:false, error:'No valid authorization header found'}.
    app.use('/', authMiddleware);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createIntegrationRouter } = require('../../../../src/routes/integration');
    app.use(
      '/',
      createIntegrationRouter({
        integrationService: service as IntegrationService,
      }),
    );
    return { app, service };
  }

  it('anonymous GET /status returns 401 via authMiddleware', async () => {
    const { app } = makeAppWithRealAuth();
    const res = await request(app).get('/status');
    expect(res.status).toBe(401);
    // authMiddleware's body shape — not normalized by this PR.
    expect(res.body).toMatchObject({ success: false });
  });

  it('anonymous POST /:id/run returns 401 via authMiddleware', async () => {
    const { app } = makeAppWithRealAuth();
    const res = await request(app).post('/shared/run').send({});
    expect(res.status).toBe(401);
  });

  it('missing tenantId in req.user returns 401 from handler narrowing', async () => {
    // fakeAuthMiddleware({tenantId: undefined}) sets req.user but omits
    // tenantId — the handler's req.user?.tenantId narrowing must 401.
    const { app } = makeAppWithFakeAuth({ tenantId: undefined });
    const res = await request(app).post('/shared/run').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('missing tenantId on POST /:id/sync-record returns 401 even with an empty body (auth before body validation)', async () => {
    // Codex review: the tenant gate must precede recordId validation, so a
    // tenantless caller gets 401 tenant_required rather than a recordId 400.
    const { app } = makeAppWithFakeAuth({ tenantId: undefined });
    const res = await request(app).post('/shared/sync-record').send({});
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('cross-tenant POST /:id/run returns 404 when service raises NotFoundError', async () => {
    // Service rejects for tenant-b on config 'shared' (which is owned by
    // tenant-a) — the route's existing 404 mapping kicks in.
    const service = {
      runIntegrationForTenant: jest.fn(async (tenantId: string, id: string) => {
        if (tenantId !== 'tenant-a') {
          // Mirror the real service: runIntegrationWithOptionalTenant throws
          // NotFoundError, which the route maps to 404 via `instanceof`.
          throw new NotFoundError(`Configuration ${id} not found for tenant ${tenantId}`);
        }
        return { status: 'success' };
      }),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const { app } = makeAppWithFakeAuth({ tenantId: 'tenant-b' }, service);
    const res = await request(app).post('/shared/run').send({});
    expect(res.status).toBe(404);
    expect(service.runIntegrationForTenant).toHaveBeenCalledWith('tenant-b', 'shared', expect.any(Object));
  });

  it('same-tenant POST /:id/run reaches the handler successfully', async () => {
    const service = {
      runIntegrationForTenant: jest.fn(async (tenantId: string, id: string) => {
        return { status: 'success', tenantId, id };
      }),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const { app } = makeAppWithFakeAuth({ tenantId: 'tenant-a' }, service);
    const res = await request(app).post('/shared/run').send({});
    expect(res.status).toBeLessThan(400);
    expect(service.runIntegrationForTenant).toHaveBeenCalledWith('tenant-a', 'shared', expect.any(Object));
  });

  it('cross-tenant POST /:id/stop returns 404 before calling the global stop method', async () => {
    const service = {
      stopIntegration: jest.fn().mockResolvedValue(true),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const configService = {
      getConfigurationForTenant: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<Partial<ConfigurationService>>;
    const { app } = makeAppWithFakeAuth({ tenantId: 'tenant-b' }, service, configService);

    const res = await request(app).post('/shared/stop').send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Integration not found' });
    expect(configService.getConfigurationForTenant).toHaveBeenCalledWith('tenant-b', 'shared');
    expect(service.stopIntegration).not.toHaveBeenCalled();
  });

  it('GET /status only returns statuses for the caller tenant', async () => {
    const service = {
      getAllIntegrationStatuses: jest.fn().mockResolvedValue([
        { configId: 'tenant-a-config', isRunning: true, errorCount: 0, successCount: 1 },
        { configId: 'tenant-b-config', isRunning: false, errorCount: 0, successCount: 2 },
      ]),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const configService = {
      getAllConfigurationsForTenant: jest.fn().mockReturnValue([
        { id: 'tenant-a-config', tenantId: 'tenant-a' },
      ]),
    } as unknown as jest.Mocked<Partial<ConfigurationService>>;
    const { app } = makeAppWithFakeAuth({ tenantId: 'tenant-a' }, service, configService);

    const res = await request(app).get('/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      { configId: 'tenant-a-config', isRunning: true, errorCount: 0, successCount: 1 },
    ]);
    expect(configService.getAllConfigurationsForTenant).toHaveBeenCalledWith('tenant-a');
  });

  it('cross-tenant GET /:id/status returns 404 before reading global status', async () => {
    const service = {
      getIntegrationStatus: jest.fn().mockReturnValue({
        configId: 'shared',
        isRunning: false,
        errorCount: 0,
        successCount: 1,
      }),
    } as unknown as jest.Mocked<Partial<IntegrationService>>;
    const configService = {
      getConfigurationForTenant: jest.fn().mockReturnValue(undefined),
    } as unknown as jest.Mocked<Partial<ConfigurationService>>;
    const { app } = makeAppWithFakeAuth({ tenantId: 'tenant-b' }, service, configService);

    const res = await request(app).get('/shared/status');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Integration not found' });
    expect(configService.getConfigurationForTenant).toHaveBeenCalledWith('tenant-b', 'shared');
    expect(service.getIntegrationStatus).not.toHaveBeenCalled();
  });
});
