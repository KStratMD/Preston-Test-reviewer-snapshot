import { createConfigurationRouter } from '../configuration';
import { createMockRequest, createMockResponse, createMockLogger, expectSuccess, expectError } from './testHelpers';
import type { ConfigurationService } from '../../services/ConfigurationService';
import type { Logger } from '../../utils/Logger';

describe('Configuration Routes', () => {
  let mockConfigService: jest.Mocked<ConfigurationService>;
  let mockLogger: Logger;
  let router: any;

  beforeEach(() => {
    mockConfigService = {
      getConfiguration: jest.fn(),
      getAllConfigurations: jest.fn(),
      saveConfiguration: jest.fn(),
      deleteConfiguration: jest.fn(),
      validateConfiguration: jest.fn(),
      exportConfiguration: jest.fn(),
      importConfiguration: jest.fn(),
      getConfigurationHistory: jest.fn(),
      restoreConfiguration: jest.fn(),
      duplicateConfiguration: jest.fn(),
    } as any;

    mockLogger = createMockLogger();

    router = createConfigurationRouter({
      configurationService: mockConfigService,
      logger: mockLogger,
    });
  });

  describe('GET /api/configurations', () => {
    it('should return all configurations', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      const mockConfigs = [
        { id: 'config-1', name: 'Salesforce to NetSuite', active: true },
        { id: 'config-2', name: 'Dynamics to SAP', active: false },
      ];

      mockConfigService.getAllConfigurations.mockResolvedValue(mockConfigs);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.getAllConfigurations).toHaveBeenCalled();
      expectSuccess(res, mockConfigs);
    });

    it('should handle service errors', async () => {
      const req = createMockRequest();
      const res = createMockResponse();

      mockConfigService.getAllConfigurations.mockRejectedValue(
        new Error('Database connection failed')
      );

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 500, 'Database connection failed');
    });

    it('should redirect to dashboard when HTML is requested', async () => {
      const acceptsMock = jest.fn((types: any) => {
        if (Array.isArray(types)) {
          if (types.includes('json')) {
            return false;
          }
          if (types.includes('html')) {
            return 'html';
          }
        }
        if (types === 'json') {
          return false;
        }
        if (types === 'html') {
          return 'html';
        }
        return false;
      });

      const req = createMockRequest({
        headers: { accept: 'text/html' },
        accepts: acceptsMock,
      } as any);
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      const redirectMock = res.redirect as unknown as jest.Mock;
      expect(redirectMock).toHaveBeenCalledWith(302, '/integration-dashboard.html');
      expect(mockConfigService.getAllConfigurations).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/configurations/:id', () => {
    it('should return specific configuration', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
      });
      const res = createMockResponse();

      const mockConfig = {
        id: 'config-1',
        name: 'Salesforce to NetSuite',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        fieldMappings: [],
        active: true,
      };

      mockConfigService.getConfiguration.mockResolvedValue(mockConfig);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.getConfiguration).toHaveBeenCalledWith('config-1');
      expectSuccess(res, mockConfig);
    });

    it('should handle configuration not found', async () => {
      const req = createMockRequest({
        params: { id: 'non-existent' },
      });
      const res = createMockResponse();

      mockConfigService.getConfiguration.mockResolvedValue(null);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 404, 'Configuration not found');
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

      const req = createMockRequest({
        body: newConfig,
      });
      const res = createMockResponse();

      const savedConfig = {
        id: 'config-new',
        ...newConfig,
        createdAt: new Date().toISOString(),
      };

      mockConfigService.saveConfiguration.mockResolvedValue(savedConfig);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.saveConfiguration).toHaveBeenCalledWith(newConfig);
      expectSuccess(
        res,
        expect.objectContaining({
          message: 'Configuration saved successfully',
          id: savedConfig.id,
          name: newConfig.name,
          sourceSystem: newConfig.sourceSystem,
          targetSystem: newConfig.targetSystem,
        }),
        201,
      );
      expect(res.setHeader).toHaveBeenCalledWith('Location', expect.stringContaining(`/api/configurations/${savedConfig.id}`));
    });

    it('should validate required fields', async () => {
      const req = createMockRequest({
        body: {
          sourceSystem: 'SAP',
        },
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 400, 'name');
    });

    it('should validate configuration before saving', async () => {
      const config = {
        name: 'Test Config',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
      };

      const req = createMockRequest({
        body: config,
      });
      const res = createMockResponse();

      mockConfigService.validateConfiguration.mockResolvedValue({
        valid: false,
        errors: ['Invalid field mapping structure'],
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 400, 'Invalid field mapping structure');
    });
  });

  describe('PUT /api/configurations/:id', () => {
    it('should update existing configuration', async () => {
      const updatedConfig = {
        id: 'config-1',
        name: 'Updated Integration',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
        fieldMappings: [],
      };

      const req = createMockRequest({
        params: { id: 'config-1' },
        body: updatedConfig,
      });
      const res = createMockResponse();

      mockConfigService.saveConfiguration.mockResolvedValue({
        ...updatedConfig,
        updatedAt: new Date().toISOString(),
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.put
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.saveConfiguration).toHaveBeenCalledWith({
        ...updatedConfig,
        id: 'config-1',
      });
      expectSuccess(res);
    });

    it('should ensure ID consistency', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
        body: {
          id: 'different-id',
          name: 'Test',
        },
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.put
      );

      await handler.route.stack[0].handle(req, res);

      const savedConfig = (mockConfigService.saveConfiguration as jest.Mock).mock.calls[0]?.[0];
      expect(savedConfig?.id).toBe('config-1');
    });
  });

  describe('DELETE /api/configurations/:id', () => {
    it('should delete configuration', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
      });
      const res = createMockResponse();

      mockConfigService.deleteConfiguration.mockResolvedValue({
        success: true,
        message: 'Configuration deleted',
      });

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.delete
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.deleteConfiguration).toHaveBeenCalledWith('config-1');
      expectSuccess(res, {
        success: true,
        message: 'Configuration deleted',
      });
    });

    it('should handle deletion of non-existent configuration', async () => {
      const req = createMockRequest({
        params: { id: 'non-existent' },
      });
      const res = createMockResponse();

      mockConfigService.deleteConfiguration.mockRejectedValue(
        new Error('Configuration not found')
      );

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id' && 
        layer.route?.methods?.delete
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 404, 'Configuration not found');
    });
  });

  describe('POST /api/configurations/:id/validate', () => {
    it('should validate configuration', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
      });
      const res = createMockResponse();

      // Per PR #682: the route now fetches the config by id and passes
      // the config OBJECT to validateConfiguration (the concrete
      // ConfigurationService.validateConfiguration takes an
      // IntegrationConfig, not an id string). Mock getConfiguration to
      // return a stub config so the handler reaches the validate call.
      const fetchedConfig = { id: 'config-1', name: 'Test Config' };
      mockConfigService.getConfiguration.mockResolvedValue(fetchedConfig as any);
      mockConfigService.validateConfiguration.mockResolvedValue({
        valid: true,
        warnings: ['Consider adding error handling rules'],
      });

      const handler = router.stack.find((layer: any) =>
        layer.route?.path === '/api/configurations/:id/validate' &&
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.getConfiguration).toHaveBeenCalledWith('config-1');
      expect(mockConfigService.validateConfiguration).toHaveBeenCalledWith(fetchedConfig);
      expectSuccess(res, {
        valid: true,
        warnings: ['Consider adding error handling rules'],
      });
    });
  });

  describe('POST /api/configurations/:id/export', () => {
    it('should export configuration', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
        query: { format: 'json' },
      });
      const res = createMockResponse();

      const exportedData = {
        configuration: {
          id: 'config-1',
          name: 'Test Config',
        },
        metadata: {
          exportedAt: new Date().toISOString(),
          version: '1.0.0',
        },
      };

      mockConfigService.exportConfiguration.mockResolvedValue(exportedData);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id/export' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.exportConfiguration).toHaveBeenCalledWith('config-1', 'json');
      expect(res.setHeader).toHaveBeenCalledWith(
        'Content-Disposition',
        'attachment; filename="config-1-export.json"'
      );
      expectSuccess(res, exportedData);
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

      const req = createMockRequest({
        body: importData,
      });
      const res = createMockResponse();

      const importedConfig = {
        id: 'imported-1',
        ...importData.configuration,
        importedAt: new Date().toISOString(),
      };

      mockConfigService.importConfiguration.mockResolvedValue(importedConfig);

      const handler = router.stack.find((layer: any) =>
        layer.route?.path === '/api/configurations/import' &&
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      // Per PR #682: the route serializes data.configuration to a JSON
      // string before calling configService.importConfiguration (the
      // concrete ConfigurationService.importConfiguration expects a
      // non-empty JSON string payload, not an object).
      expect(mockConfigService.importConfiguration).toHaveBeenCalledWith(
        JSON.stringify(importData.configuration),
      );
      expectSuccess(res, importedConfig);
    });

    it('should validate import data structure', async () => {
      const req = createMockRequest({
        body: {
          invalidData: 'test',
        },
      });
      const res = createMockResponse();

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/import' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expectError(res, 400, 'Invalid import data');
    });
  });

  describe('POST /api/configurations/:id/duplicate', () => {
    it('should duplicate configuration', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
        body: { newName: 'Duplicated Config' },
      });
      const res = createMockResponse();

      const duplicatedConfig = {
        id: 'config-duplicate',
        name: 'Duplicated Config',
        sourceSystem: 'SAP',
        targetSystem: 'Oracle',
      };

      mockConfigService.duplicateConfiguration.mockResolvedValue(duplicatedConfig);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id/duplicate' && 
        layer.route?.methods?.post
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.duplicateConfiguration).toHaveBeenCalledWith('config-1', 'Duplicated Config');
      expectSuccess(res, duplicatedConfig);
    });
  });

  describe('GET /api/configurations/:id/history', () => {
    it('should return configuration history', async () => {
      const req = createMockRequest({
        params: { id: 'config-1' },
      });
      const res = createMockResponse();

      const history = [
        { version: 3, updatedAt: '2024-01-03', updatedBy: 'user3' },
        { version: 2, updatedAt: '2024-01-02', updatedBy: 'user2' },
        { version: 1, updatedAt: '2024-01-01', updatedBy: 'user1' },
      ];

      mockConfigService.getConfigurationHistory.mockResolvedValue(history);

      const handler = router.stack.find((layer: any) => 
        layer.route?.path === '/api/configurations/:id/history' && 
        layer.route?.methods?.get
      );

      await handler.route.stack[0].handle(req, res);

      expect(mockConfigService.getConfigurationHistory).toHaveBeenCalledWith('config-1');
      expectSuccess(res, history);
    });
  });
});