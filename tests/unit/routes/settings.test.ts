/**
 * Settings Routes Unit Tests
 * Tests for settings API endpoints
 */

import { Request, Response, NextFunction } from 'express';

// Create mock functions at module level for hoisting
const mockGetDemoMode = jest.fn();
const mockSetDemoMode = jest.fn();
const mockGetDataset = jest.fn();
const mockSetDataset = jest.fn();
const mockGetUserSettings = jest.fn();
const mockUpdateUserSettings = jest.fn();
const mockResetToDefaults = jest.fn();
const mockListDatasets = jest.fn();
const mockGetTrainingExamples = jest.fn();

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    getAsync: jest.fn().mockImplementation((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('DemoModeService')) {
        return Promise.resolve({
          getDemoMode: mockGetDemoMode,
          setDemoMode: mockSetDemoMode,
        });
      }
      if (typeName.includes('UserSettingsService')) {
        return Promise.resolve({
          getDataset: mockGetDataset,
          setDataset: mockSetDataset,
        });
      }
      if (typeName.includes('MCPUserSettingsService')) {
        return Promise.resolve({
          getUserSettings: mockGetUserSettings,
          updateUserSettings: mockUpdateUserSettings,
          resetToDefaults: mockResetToDefaults,
        });
      }
      return Promise.resolve({});
    }),
    get: jest.fn().mockImplementation((type: symbol) => {
      const typeName = type.toString();
      if (typeName.includes('TrainingDataRepository')) {
        return {
          listDatasets: mockListDatasets,
          getTrainingExamples: mockGetTrainingExamples,
        };
      }
      return {};
    }),
  },
}));

jest.mock('../../../src/inversify/types', () => ({
  TYPES: {
    DemoModeService: Symbol.for('DemoModeService'),
    UserSettingsService: Symbol.for('UserSettingsService'),
    MCPUserSettingsService: Symbol.for('MCPUserSettingsService'),
    TrainingDataRepository: Symbol.for('TrainingDataRepository'),
  },
}));

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  },
}));

import { createSettingsRouter } from '../../../src/routes/settings';

describe('Settings Routes', () => {
  let router: any;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockNext: jest.Mock;

  beforeAll(async () => {
    router = await createSettingsRouter();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockNext = jest.fn();
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockReq = {
      params: {},
      query: {},
      body: {},
    };
    // Set user on request object
    (mockReq as any).user = { id: 'user-123' };
  });

  const getRouteHandler = (method: string, path: string) => {
    const routes = router.stack || [];
    for (const layer of routes) {
      if (layer.route && layer.route.path === path) {
        const methodHandler = layer.route.stack.find(
          (s: any) => s.method === method
        );
        if (methodHandler) {
          return methodHandler.handle;
        }
      }
    }
    return null;
  };

  describe('GET /demo-mode', () => {
    it('should return demo mode status', async () => {
      mockGetDemoMode.mockResolvedValue(true);

      const handler = getRouteHandler('get', '/demo-mode');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockGetDemoMode).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith({ enabled: true });
    });

    it('should handle errors', async () => {
      mockGetDemoMode.mockRejectedValue(new Error('Service error'));

      const handler = getRouteHandler('get', '/demo-mode');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNext).toHaveBeenCalledWith(expect.any(Error));
    });
  });

  describe('POST /demo-mode', () => {
    it('should set demo mode', async () => {
      mockReq.body = { enabled: true };
      mockSetDemoMode.mockResolvedValue(undefined);

      const handler = getRouteHandler('post', '/demo-mode');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockSetDemoMode).toHaveBeenCalledWith(true, { userId: 'user-123' });
      expect(mockJson).toHaveBeenCalledWith({ success: true, enabled: true });
    });

    it('should return 400 when enabled is not boolean', async () => {
      mockReq.body = { enabled: 'yes' };

      const handler = getRouteHandler('post', '/demo-mode');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'invalid_request',
        message: 'enabled must be a boolean.',
      });
    });
  });

  describe('GET /ai/dataset', () => {
    it('should return current dataset', async () => {
      mockGetDataset.mockResolvedValue('custom-dataset');

      const handler = getRouteHandler('get', '/ai/dataset');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({ datasetId: 'custom-dataset' });
    });

    it('should return default when no dataset set', async () => {
      mockGetDataset.mockResolvedValue(null);

      const handler = getRouteHandler('get', '/ai/dataset');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({ datasetId: 'default' });
    });
  });

  describe('POST /ai/dataset', () => {
    it('should set dataset preference', async () => {
      mockReq.body = { datasetId: 'my-dataset' };
      mockSetDataset.mockResolvedValue(undefined);

      const handler = getRouteHandler('post', '/ai/dataset');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockSetDataset).toHaveBeenCalledWith('my-dataset', 'user-123');
      expect(mockJson).toHaveBeenCalledWith({ success: true, datasetId: 'my-dataset' });
    });

    it('should return 400 when datasetId is missing', async () => {
      mockReq.body = {};

      const handler = getRouteHandler('post', '/ai/dataset');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'invalid_request',
        message: '`datasetId` must be a non-empty string.',
      });
    });
  });

  describe('GET /ai/datasets', () => {
    it('should return datasets list', async () => {
      const datasets = [
        { id: 'ds1', name: 'Dataset 1' },
        { id: 'ds2', name: 'Dataset 2' },
      ];
      mockListDatasets.mockResolvedValue(datasets);

      const handler = getRouteHandler('get', '/ai/datasets');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({ datasets });
    });

    it('should return empty list on error', async () => {
      mockListDatasets.mockRejectedValue(new Error('Failed'));

      const handler = getRouteHandler('get', '/ai/datasets');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({ datasets: [] });
    });
  });

  describe('GET /ai/datasets/:id/examples', () => {
    it('should return dataset examples', async () => {
      mockReq.params = { id: 'ds1' };
      mockReq.query = { limit: '10' };
      const examples = [{ input: 'test', output: 'result' }];
      mockGetTrainingExamples.mockResolvedValue(examples);

      const handler = getRouteHandler('get', '/ai/datasets/:id/examples');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockGetTrainingExamples).toHaveBeenCalledWith({
        datasetId: 'ds1',
        limit: 10,
      });
      expect(mockJson).toHaveBeenCalledWith({ examples });
    });

    it('should default to limit 5', async () => {
      mockReq.params = { id: 'ds1' };
      mockGetTrainingExamples.mockResolvedValue([]);

      const handler = getRouteHandler('get', '/ai/datasets/:id/examples');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockGetTrainingExamples).toHaveBeenCalledWith({
        datasetId: 'ds1',
        limit: 5,
      });
    });

    it('should clamp limit to max 25', async () => {
      mockReq.params = { id: 'ds1' };
      mockReq.query = { limit: '100' };
      mockGetTrainingExamples.mockResolvedValue([]);

      const handler = getRouteHandler('get', '/ai/datasets/:id/examples');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockGetTrainingExamples).toHaveBeenCalledWith({
        datasetId: 'ds1',
        limit: 25,
      });
    });
  });

  describe('POST /mcp', () => {
    it('should return 400 when no valid settings provided', async () => {
      mockReq.body = { invalid: 'value' };

      const handler = getRouteHandler('post', '/mcp');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        success: false,
        error: 'invalid_request',
        message: 'At least one MCP setting (schema, aiContext, validation, gateway, businessCentral) must be provided as a boolean.',
      });
    });
  });

});
