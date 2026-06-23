/**
 * Configuration Route Tests
 *
 * Tests the /api/configurations API endpoints.
 *
 * PR 13c-4 Task 7: the router was refactored from absolute-path-at-root-mount
 * to router-relative paths mounted at /api/configurations with authMiddleware.
 * Tests now drive the router through supertest behind fakeAuthMiddleware so
 * req.user.tenantId is populated (the handlers narrow on req.user?.tenantId and
 * 401 when absent). The Stage A suite asserts the auth-gate / tenant-scoping
 * closure directly.
 */

import request from 'supertest';
import express from 'express';
import { createConfigurationRouter } from '../../../../src/routes/configuration';
import type { ConfigurationService } from '../../../../src/services/ConfigurationService';
import { fakeAuthMiddleware, type FakeUserOverrides } from '../_helpers/routerTestAuth';
import { authMiddleware } from '../../../../src/middleware/auth';

function createMockConfigService(): jest.Mocked<ConfigurationService> {
  return {
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    getAllConfigurationsForTenant: jest.fn().mockReturnValue([]),
    saveConfiguration: jest.fn(),
    deleteConfiguration: jest.fn(),
    deleteConfigurationForTenant: jest.fn(),
    validateConfiguration: jest.fn(),
    exportConfigurationForTenant: jest.fn(),
    importConfiguration: jest.fn(),
    getConfigurationHistory: jest.fn(),
    restoreConfiguration: jest.fn(),
    duplicateConfiguration: jest.fn(),
  } as unknown as jest.Mocked<ConfigurationService>;
}

function makeApp(
  configService: ConfigurationService,
  authOverrides: FakeUserOverrides = {},
) {
  const app = express();
  app.use(express.json());
  // Mount at /api/configurations so the (now router-relative) router serves the
  // same public paths existing tests expect. fakeAuthMiddleware stands in for
  // the production authMiddleware so req.user.tenantId is populated.
  app.use('/api/configurations', fakeAuthMiddleware(authOverrides), createConfigurationRouter(configService));
  return app;
}

describe('Configuration Routes', () => {
  let mockConfigService: jest.Mocked<ConfigurationService>;

  beforeEach(() => {
    mockConfigService = createMockConfigService();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /api/configurations', () => {
    it('should return all configurations for the tenant', async () => {
      const mockConfigs = [
        { id: 'config-1', name: 'Salesforce to NetSuite', active: true },
        { id: 'config-2', name: 'Dynamics to SAP', active: false },
      ];
      (mockConfigService.getAllConfigurationsForTenant as jest.Mock).mockReturnValue(mockConfigs);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockConfigs);
      expect(mockConfigService.getAllConfigurationsForTenant).toHaveBeenCalledWith('test-tenant');
    });

    it('should handle service errors', async () => {
      (mockConfigService.getAllConfigurationsForTenant as jest.Mock).mockImplementation(() => {
        throw new Error('Database connection failed');
      });

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations');

      expect(res.status).toBe(500);
      expect(res.body.error).toContain('Database connection failed');
    });

    it('should redirect to dashboard when HTML is requested', async () => {
      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations').set('Accept', 'text/html');

      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/integration-dashboard.html');
      expect(mockConfigService.getAllConfigurationsForTenant).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/configurations/:id', () => {
    it('should return specific configuration', async () => {
      const mockConfig = {
        id: 'config-1',
        name: 'Salesforce to NetSuite',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fieldMappings: [],
        active: true,
      };
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue(mockConfig);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations/config-1');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(mockConfig);
      expect(mockConfigService.getConfigurationForTenant).toHaveBeenCalledWith('test-tenant', 'config-1');
    });

    it('should handle configuration not found', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Configuration not found');
    });
  });

  describe('POST /api/configurations', () => {
    it('should create new configuration', async () => {
      const newConfig = {
        name: 'New Integration',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fieldMappings: [],
      };
      const savedConfig = { id: 'config-new', ...newConfig };
      (mockConfigService.saveConfiguration as jest.Mock).mockResolvedValue(savedConfig);

      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations').send(newConfig);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        message: 'Configuration saved successfully',
        id: savedConfig.id,
        name: newConfig.name,
        sourceSystem: newConfig.sourceSystem,
        targetSystem: newConfig.targetSystem,
      });
      expect(res.headers.location).toBe(`/api/configurations/${savedConfig.id}`);
      // tenantId is forced server-side from the authenticated identity.
      expect(mockConfigService.saveConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({ ...newConfig, tenantId: 'test-tenant' }),
      );
    });

    it('should validate required fields', async () => {
      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations').send({ sourceSystem: 'SAP' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('name');
    });

    it('should validate configuration before saving', async () => {
      (mockConfigService.validateConfiguration as jest.Mock).mockResolvedValue({
        valid: false,
        errors: ['Invalid field mapping structure'],
      });

      const app = makeApp(mockConfigService);
      const res = await request(app)
        .post('/api/configurations')
        .send({ name: 'Test Config', sourceSystem: 'SAP', targetSystem: 'Oracle' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid field mapping structure');
    });
  });

  describe('PUT /api/configurations/:id', () => {
    it('should update existing configuration', async () => {
      const updatedConfig = {
        name: 'Updated Integration',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fieldMappings: [],
      };
      (mockConfigService.saveConfiguration as jest.Mock).mockResolvedValue({ ...updatedConfig, id: 'config-1' });

      const app = makeApp(mockConfigService);
      const res = await request(app).put('/api/configurations/config-1').send(updatedConfig);

      expect(res.status).toBe(200);
      expect(mockConfigService.saveConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({ ...updatedConfig, id: 'config-1', tenantId: 'test-tenant' }),
      );
    });

    it('should ensure ID consistency', async () => {
      const app = makeApp(mockConfigService);
      await request(app)
        .put('/api/configurations/config-1')
        .send({ id: 'different-id', name: 'Test' });

      const savedConfig = (mockConfigService.saveConfiguration as jest.Mock).mock.calls[0]?.[0];
      expect(savedConfig?.id).toBe('config-1');
    });
  });

  describe('DELETE /api/configurations/:id', () => {
    it('should delete configuration', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'config-1', tenantId: 'test-tenant' });
      (mockConfigService.deleteConfigurationForTenant as jest.Mock).mockResolvedValue(true);

      const app = makeApp(mockConfigService);
      const res = await request(app).delete('/api/configurations/config-1');

      expect(res.status).toBe(200);
      expect(mockConfigService.deleteConfigurationForTenant).toHaveBeenCalledWith('test-tenant', 'config-1');
    });

    it('should handle deletion of non-existent configuration', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue(undefined);

      const app = makeApp(mockConfigService);
      const res = await request(app).delete('/api/configurations/non-existent');

      expect(res.status).toBe(404);
      expect(res.body.error).toBe('Configuration not found');
    });
  });

  describe('POST /api/configurations/:id/validate', () => {
    it('should validate configuration', async () => {
      const fetchedConfig = { id: 'config-1', name: 'Test Config' };
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue(fetchedConfig);
      (mockConfigService.validateConfiguration as jest.Mock).mockResolvedValue({
        valid: true,
        warnings: ['Consider adding error handling rules'],
      });

      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations/config-1/validate').send({});

      expect(res.status).toBe(200);
      expect(mockConfigService.getConfigurationForTenant).toHaveBeenCalledWith('test-tenant', 'config-1');
      expect(mockConfigService.validateConfiguration).toHaveBeenCalledWith(fetchedConfig);
      expect(res.body).toEqual({ valid: true, warnings: ['Consider adding error handling rules'] });
    });
  });

  describe('GET /api/configurations/:id/export', () => {
    it('should export configuration', async () => {
      const exportedData = JSON.stringify({ configuration: { id: 'config-1', name: 'Test Config' } });
      (mockConfigService.exportConfigurationForTenant as jest.Mock).mockResolvedValue(exportedData);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations/config-1/export?format=json');

      expect(res.status).toBe(200);
      expect(mockConfigService.exportConfigurationForTenant).toHaveBeenCalledWith('test-tenant', 'config-1');
      expect(res.headers['content-disposition']).toBe('attachment; filename="config-1-export.json"');
      expect(JSON.parse(res.text)).toEqual({ configuration: { id: 'config-1', name: 'Test Config' } });
    });
  });

  describe('POST /api/configurations/import', () => {
    it('should import configuration', async () => {
      const importData = {
        configuration: {
          name: 'Imported Config',
          sourceSystem: 'NetSuite',
          targetSystem: 'Salesforce',
        },
      };
      const importedConfig = { id: 'imported-1', ...importData.configuration };
      (mockConfigService.importConfiguration as jest.Mock).mockResolvedValue(importedConfig);

      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations/import').send(importData);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(importedConfig);
      // The payload is serialized and the caller's tenantId is force-stamped.
      const calledWith = (mockConfigService.importConfiguration as jest.Mock).mock.calls[0]?.[0];
      expect(JSON.parse(calledWith as string)).toEqual({ ...importData.configuration, tenantId: 'test-tenant' });
    });

    it('should validate import data structure', async () => {
      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations/import').send({ invalidData: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid import data');
    });
  });

  describe('POST /api/configurations/:id/duplicate', () => {
    it('should duplicate configuration', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'config-1', tenantId: 'test-tenant' });
      const duplicatedConfig = {
        id: 'config-duplicate',
        name: 'Duplicated Config',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
      };
      (mockConfigService.duplicateConfiguration as jest.Mock).mockResolvedValue(duplicatedConfig);

      const app = makeApp(mockConfigService);
      const res = await request(app)
        .post('/api/configurations/config-1/duplicate')
        .send({ newName: 'Duplicated Config' });

      expect(res.status).toBe(200);
      expect(mockConfigService.duplicateConfiguration).toHaveBeenCalledWith('config-1', 'Duplicated Config');
      expect(res.body).toEqual(duplicatedConfig);
    });
  });

  describe('GET /api/configurations/:id/history', () => {
    it('should return configuration history', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'config-1', tenantId: 'test-tenant' });
      const history = [
        { version: 3, updatedAt: '2024-01-03', updatedBy: 'user3' },
        { version: 2, updatedAt: '2024-01-02', updatedBy: 'user2' },
        { version: 1, updatedAt: '2024-01-01', updatedBy: 'user1' },
      ];
      (mockConfigService.getConfigurationHistory as jest.Mock).mockResolvedValue(history);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations/config-1/history');

      expect(res.status).toBe(200);
      expect(mockConfigService.getConfigurationHistory).toHaveBeenCalledWith('config-1');
      expect(res.body).toEqual(history);
    });
  });
});

describe('Stage A — /api/configurations auth gate (PR 13c-4)', () => {
  // The Stage A suite asserts the auth-gate + tenant-scoping closure
  // introduced in Task 7: (1) real authMiddleware on the mount rejects
  // requests without a Bearer JWT with 401, (2) authenticated callers whose
  // req.user lacks a tenantId hit the handler-level narrowing 401, (3)
  // requests for a config owned by a different tenant collapse to 404 via the
  // service's tenant-scoped lookup, (4) same-tenant requests reach the
  // handler, (5) POST Location header uses the publicBase prefix.

  function makeAppWithFakeAuth(overrides: FakeUserOverrides, configService: ConfigurationService) {
    const app = express();
    app.use(express.json());
    app.use('/api/configurations', fakeAuthMiddleware(overrides), createConfigurationRouter(configService));
    return app;
  }

  function makeAppWithoutAuthSetup(configService: ConfigurationService) {
    const app = express();
    app.use(express.json());
    app.use('/api/configurations', authMiddleware, createConfigurationRouter(configService));
    return app;
  }

  // Service stub: config 'shared' belongs to tenant-a only. Tenant-scoped
  // lookup returns it for tenant-a, undefined for any other tenant.
  function makeService(): jest.Mocked<ConfigurationService> {
    const sharedConfig = { id: 'shared', tenantId: 'tenant-a', name: 'Shared' };
    return {
      getConfigurationForTenant: jest.fn((tenantId: string, id: string) =>
        tenantId === 'tenant-a' && id === 'shared' ? sharedConfig : undefined,
      ),
      getAllConfigurations: jest.fn().mockReturnValue([sharedConfig]),
      getAllConfigurationsForTenant: jest.fn().mockReturnValue([]),
      saveConfiguration: jest.fn().mockResolvedValue({ id: 'new-cfg' }),
      validateConfiguration: jest.fn().mockResolvedValue({ valid: true }),
    } as unknown as jest.Mocked<ConfigurationService>;
  }

  it('anonymous GET /api/configurations returns 401', async () => {
    const app = makeAppWithoutAuthSetup(makeService());
    const res = await request(app).get('/api/configurations');
    expect(res.status).toBe(401);
  });

  it('cross-tenant GET /api/configurations/:id returns 404 when config owned by other tenant', async () => {
    const app = makeAppWithFakeAuth({ tenantId: 'tenant-b' }, makeService());
    const res = await request(app).get('/api/configurations/shared');
    expect(res.status).toBe(404);
  });

  it('same-tenant GET /api/configurations/:id returns 200', async () => {
    const app = makeAppWithFakeAuth({ tenantId: 'tenant-a' }, makeService());
    const res = await request(app).get('/api/configurations/shared');
    expect(res.status).toBe(200);
  });

  it('missing tenantId in req.user returns 401', async () => {
    const app = makeAppWithFakeAuth({ tenantId: undefined }, makeService());
    const res = await request(app).get('/api/configurations/shared');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('GET list with Accept: text/html but missing tenantId returns 401, NOT a 302 redirect', async () => {
    // Copilot review: the fail-closed tenantId check must precede the HTML
    // convenience redirect, so a Bearer token lacking the tenantId claim gets
    // 401 uniformly regardless of Accept header.
    const app = makeAppWithFakeAuth({ tenantId: undefined }, makeService());
    const res = await request(app).get('/api/configurations').set('Accept', 'text/html');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('POST /api/configurations Location header points to /api/configurations/:id (not /:id)', async () => {
    const app = makeAppWithFakeAuth({ tenantId: 'tenant-a' }, makeService());
    const res = await request(app).post('/api/configurations').send({
      id: 'new-cfg', tenantId: 'tenant-a', name: 'New', sourceSystem: 'Salesforce', targetSystem: 'NetSuite',
      sourceEntity: 'Account', targetEntity: 'Customer', syncDirection: 'source_to_target', syncMode: 'batch',
      isActive: true, fieldMappings: [{ sourceField: 's', targetField: 't', transformationType: 'direct', isRequired: true }],
    });
    expect(res.status).toBe(201);
    expect(res.headers.location).toBe('/api/configurations/new-cfg');
  });

  it('POST /api/configurations with no tenantId returns 401 even when the body is invalid (auth before validation)', async () => {
    // Codex review: the fail-closed tenant gate must precede body validation, so
    // a Bearer-authenticated caller lacking a tenant claim gets tenant_required
    // 401 rather than a payload 400 that would mask the auth failure.
    const app = makeAppWithFakeAuth({ tenantId: undefined }, makeService());
    const res = await request(app).post('/api/configurations').send({ sourceSystem: 'SAP' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });

  it('POST /api/configurations/import with no tenantId returns 401 even when the body is invalid (auth before validation)', async () => {
    const app = makeAppWithFakeAuth({ tenantId: undefined }, makeService());
    const res = await request(app).post('/api/configurations/import').send({ invalidData: 'test' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized', reason: 'tenant_required' });
  });
});
