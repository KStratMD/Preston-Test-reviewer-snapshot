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

import 'reflect-metadata';
import request from 'supertest';
import express from 'express';
import * as os from 'os';
import * as path from 'path';
import { promises as fsp } from 'fs';
import { createConfigurationRouter } from '../../../../src/routes/configuration';
import { ConfigurationService } from '../../../../src/services/ConfigurationService';
import { fakeAuthMiddleware, type FakeUserOverrides } from '../_helpers/routerTestAuth';
import { authMiddleware } from '../../../../src/middleware/auth';
import type { Logger } from '../../../../src/utils/Logger';
import type { IntegrationConfig } from '../../../../src/types';

function credentialBearingConfiguration(id = 'config-secret'): IntegrationConfig {
  return {
    id,
    tenantId: 'test-tenant',
    name: 'Credential-bearing configuration',
    sourceSystem: {
      type: 'Salesforce',
      systemId: 'salesforce-production',
      credentialSource: 'secret_manager',
    },
    targetSystem: { type: 'NetSuite', credentialSource: 'environment' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    sourceAuthentication: {
      type: 'api_key',
      credentials: { apiKey: 'route-source-secret-do-not-return' },
    },
    targetAuthentication: {
      type: 'basic',
      credentials: { password: 'route-target-secret-do-not-return' },
    },
    authentication: {
      source: {
        type: 'oauth2',
        credentials: { clientSecret: 'route-legacy-source-secret-do-not-return' },
      },
      target: {
        type: 'oauth1',
        credentials: { tokenSecret: 'route-legacy-target-secret-do-not-return' },
      },
    },
  };
}

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

    it('redacts current and legacy authentication from every listed configuration', async () => {
      const stored = credentialBearingConfiguration();
      (mockConfigService.getAllConfigurationsForTenant as jest.Mock).mockReturnValue([stored]);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toEqual(expect.objectContaining({
        id: 'config-secret',
        sourceSystem: expect.objectContaining({
          systemId: 'salesforce-production',
          credentialSource: 'secret_manager',
        }),
      }));
      expect(res.body[0]).not.toHaveProperty('sourceAuthentication');
      expect(res.body[0]).not.toHaveProperty('targetAuthentication');
      expect(res.body[0]).not.toHaveProperty('authentication');
      expect(JSON.stringify(res.body)).not.toContain('do-not-return');
      expect(stored.sourceAuthentication?.credentials.apiKey).toBe('route-source-secret-do-not-return');
    });

    it('filters object-form system references by their type', async () => {
      const matching = credentialBearingConfiguration('matching');
      const other = {
        ...credentialBearingConfiguration('other'),
        sourceSystem: { type: 'Dynamics365', credentialSource: 'environment' as const },
        targetSystem: { type: 'Salesforce', credentialSource: 'environment' as const },
      };
      (mockConfigService.getAllConfigurationsForTenant as jest.Mock).mockReturnValue([matching, other]);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations?sourceSystem=Salesforce&targetSystem=NetSuite');

      expect(res.status).toBe(200);
      expect(res.body.map((config: { id: string }) => config.id)).toEqual(['matching']);
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

    it('redacts current and legacy authentication from a configuration detail response', async () => {
      const stored = credentialBearingConfiguration();
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue(stored);

      const app = makeApp(mockConfigService);
      const res = await request(app).get('/api/configurations/config-secret');

      expect(res.status).toBe(200);
      expect(res.body).toEqual(expect.objectContaining({
        id: 'config-secret',
        sourceSystem: expect.objectContaining({ credentialSource: 'secret_manager' }),
      }));
      expect(res.body).not.toHaveProperty('sourceAuthentication');
      expect(res.body).not.toHaveProperty('targetAuthentication');
      expect(res.body).not.toHaveProperty('authentication');
      expect(JSON.stringify(res.body)).not.toContain('do-not-return');
      expect(stored.authentication?.source?.credentials.clientSecret)
        .toBe('route-legacy-source-secret-do-not-return');
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
      // The request carries NO id (the real create case). The id in the
      // response must come from the PERSISTED record the service returns —
      // this mock now mirrors the concrete service's contract
      // (Promise<IntegrationConfig>) instead of pretending an impl that
      // returned void still yielded an id. The real-service proof lives in
      // the 'real ConfigurationService' describe below.
      (mockConfigService.saveConfiguration as jest.Mock).mockImplementation(
        async (config: Record<string, unknown>) => ({ ...config, id: 'config-new' }),
      );

      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations').send(newConfig);

      expect(res.status).toBe(201);
      // The write endpoint answers with {message, id} only — it never echoes
      // the stored record (systems/credential references) back.
      expect(res.body).toEqual({
        message: 'Configuration saved successfully',
        id: 'config-new',
      });
      expect(res.headers.location).toBe('/api/configurations/config-new');
      // tenantId is forced server-side from the authenticated identity. The
      // trusted command context (Task 8) is threaded as the second argument —
      // built from the fakeAuthMiddleware default actor ('test-user') and
      // tenant ('test-tenant').
      expect(mockConfigService.saveConfiguration).toHaveBeenCalledWith(
        expect.objectContaining({ ...newConfig, tenantId: 'test-tenant' }),
        {
          tenantId: 'test-tenant',
          actorUserId: 'test-user',
          correlationId: expect.any(String),
          operation: 'create',
        },
      );
    });

    it('returns 401 operator_identity_required and does not save when the caller has no actor id', async () => {
      const app = makeApp(mockConfigService, { id: '' });
      const res = await request(app).post('/api/configurations').send({
        name: 'New Integration', sourceSystem: 'SAP', targetSystem: 'Oracle', fieldMappings: [],
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
      expect(mockConfigService.saveConfiguration).not.toHaveBeenCalled();
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
        {
          tenantId: 'test-tenant',
          actorUserId: 'test-user',
          correlationId: expect.any(String),
          operation: 'update',
        },
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
      const [calledWith, calledContext] = (mockConfigService.importConfiguration as jest.Mock).mock.calls[0];
      expect(JSON.parse(calledWith as string)).toEqual({ ...importData.configuration, tenantId: 'test-tenant' });
      // Trusted command context (Task 8) threaded as the second argument.
      expect(calledContext).toEqual({
        tenantId: 'test-tenant',
        actorUserId: 'test-user',
        correlationId: expect.any(String),
        operation: 'import',
      });
    });

    it('redacts authentication from the imported configuration response', async () => {
      const importedConfig = credentialBearingConfiguration('imported-secret');
      (mockConfigService.importConfiguration as jest.Mock).mockResolvedValue(importedConfig);

      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations/import').send({
        configuration: {
          name: 'Imported Config',
          sourceSystem: 'NetSuite',
          targetSystem: 'Salesforce',
        },
      });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('imported-secret');
      expect(res.body).not.toHaveProperty('sourceAuthentication');
      expect(res.body).not.toHaveProperty('targetAuthentication');
      expect(res.body).not.toHaveProperty('authentication');
      expect(JSON.stringify(res.body)).not.toContain('do-not-return');
    });

    it('should validate import data structure', async () => {
      const app = makeApp(mockConfigService);
      const res = await request(app).post('/api/configurations/import').send({ invalidData: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid import data');
    });

    it('returns 401 operator_identity_required and does not import when the caller has no actor id', async () => {
      const app = makeApp(mockConfigService, { id: '' });
      const res = await request(app).post('/api/configurations/import').send({
        configuration: { name: 'Imported Config', sourceSystem: 'NetSuite', targetSystem: 'Salesforce' },
      });

      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized', reason: 'operator_identity_required' });
      expect(mockConfigService.importConfiguration).not.toHaveBeenCalled();
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

    it('redacts authentication from a duplicated configuration response', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({
        id: 'config-1',
        tenantId: 'test-tenant',
      });
      (mockConfigService.duplicateConfiguration as jest.Mock)
        .mockResolvedValue(credentialBearingConfiguration('config-duplicate-secret'));

      const app = makeApp(mockConfigService);
      const res = await request(app)
        .post('/api/configurations/config-1/duplicate')
        .send({ newName: 'Duplicated Config' });

      expect(res.status).toBe(200);
      expect(res.body.id).toBe('config-duplicate-secret');
      expect(res.body).not.toHaveProperty('sourceAuthentication');
      expect(res.body).not.toHaveProperty('targetAuthentication');
      expect(res.body).not.toHaveProperty('authentication');
      expect(JSON.stringify(res.body)).not.toContain('do-not-return');
    });

    it('returns 501 when duplication is not implemented by the service', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'config-1', tenantId: 'test-tenant' });
      const { duplicateConfiguration: _duplicateConfiguration, ...serviceWithoutDuplicate } = mockConfigService;

      const app = makeApp(serviceWithoutDuplicate as unknown as ConfigurationService);
      const res = await request(app)
        .post('/api/configurations/config-1/duplicate')
        .send({ newName: 'Duplicated Config' });

      expect(res.status).toBe(501);
      expect(res.body).toEqual({ error: 'Configuration duplication is not implemented' });
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
    it('returns 501 when history is not implemented by the service', async () => {
      (mockConfigService.getConfigurationForTenant as jest.Mock).mockReturnValue({ id: 'config-1', tenantId: 'test-tenant' });
      const { getConfigurationHistory: _getConfigurationHistory, ...serviceWithoutHistory } = mockConfigService;

      const app = makeApp(serviceWithoutHistory as unknown as ConfigurationService);
      const res = await request(app).get('/api/configurations/config-1/history');

      expect(res.status).toBe(501);
      expect(res.body).toEqual({ error: 'Configuration history is not implemented' });
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

/**
 * The create path with the REAL ConfigurationService — no service mock.
 *
 * Every prior POST test drove a jest mock whose `saveConfiguration` resolved a
 * record carrying an id. The concrete service used to resolve `void` and
 * generate the uuid on an internal sanitized clone, so a create WITHOUT a
 * client-supplied id returned `id: undefined` and no Location header in
 * production while those mocked tests stayed green — which left the editor's
 * "create a new inactive draft" step dead on arrival. These tests run the real
 * service against a temp config directory so the id can only come from where a
 * client actually gets it: the persisted record.
 */
describe('POST /api/configurations (real ConfigurationService — no service mock)', () => {
  const silentLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
  let tmpDir: string;
  let service: ConfigurationService;

  // The exact projection the field-mapping editor POSTs for a new
  // serialized-asset draft: managed credential REFERENCES only (no secret
  // values), inactive, and — critically — no `id`.
  const editorDraftProjection = {
    name: 'NetSuite Serialized Asset Sync',
    sourceSystem: { type: 'NetSuite', systemId: 'ns-managed-1', credentialSource: 'secret_manager' },
    targetSystem: { type: 'Salesforce', systemId: 'sf-managed-1', credentialSource: 'secret_manager' },
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig: {
      executionProfile: 'netsuite_serialized_asset',
      serialNumberTargetField: 'SerialNumber',
      productReferenceTargetField: 'Product2Id',
    },
  };

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'config-route-real-'));
    service = new ConfigurationService(silentLogger, tmpDir);
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns a usable server-generated id (and Location) when the client supplies none', async () => {
    const app = makeApp(service);

    const res = await request(app).post('/api/configurations').send(editorDraftProjection);

    expect(res.status).toBe(201);
    expect(typeof res.body.id).toBe('string');
    expect(res.body.id.length).toBeGreaterThan(0);
    expect(res.headers.location).toBe(`/api/configurations/${res.body.id}`);

    // "Usable" means addressable: the id the client was handed resolves to the
    // stored record, both in the service and over the read route the editor's
    // readiness/activation calls are keyed on.
    expect(service.getConfigurationForTenant('test-tenant', res.body.id)).toBeDefined();
    const fetched = await request(app).get(`/api/configurations/${res.body.id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.executionProfile).toBe('netsuite_serialized_asset');
  });

  it('does not mutate the caller-supplied configuration object while generating the id', async () => {
    const caller = { ...editorDraftProjection, tenantId: 'test-tenant' } as never;
    const saved = await service.saveConfiguration(caller);

    expect((caller as { id?: string }).id).toBeUndefined();
    expect(typeof saved.id).toBe('string');
    expect(saved.id.length).toBeGreaterThan(0);

    // The returned record is a copy, not the stored object — mutating it can
    // never reach tenant-scoped storage.
    saved.name = 'mutated by the caller';
    expect(service.getConfigurationForTenant('test-tenant', saved.id)?.name)
      .toBe('NetSuite Serialized Asset Sync');
  });
});
