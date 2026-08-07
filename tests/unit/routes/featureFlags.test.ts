/**
 * Feature Flags Routes Unit Tests
 * Tests for feature flags API endpoints
 */

import { Request, Response } from 'express';

// Mock featureFlagService
const mockFeatureFlagService = {
  getAllFlags: jest.fn(),
  getFlagsByCategory: jest.fn(),
  isEnabled: jest.fn(),
  getFlag: jest.fn(),
  updateFlag: jest.fn(),
  toggleFlag: jest.fn(),
  shouldRedirectStudioToEditor: jest.fn(),
  shouldShowStudioDeprecationWarning: jest.fn(),
  getStudioDeprecationMessage: jest.fn(),
};

jest.mock('../../../src/services/FeatureFlagService', () => ({
  featureFlagService: mockFeatureFlagService,
}));

import { createFeatureFlagsRouter } from '../../../src/routes/featureFlags';

describe('Feature Flags Routes', () => {
  let router: ReturnType<typeof createFeatureFlagsRouter>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockNext: jest.Mock;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createFeatureFlagsRouter();
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockNext = jest.fn();
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockReq = {
      params: {},
      body: {},
    };
    process.env.NODE_ENV = 'development';
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  const getRouteHandler = (method: string, path: string) => {
    const routes = (router as any).stack || [];
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

  describe('GET /', () => {
    it('should return all feature flags', async () => {
      const mockFlags = [
        { key: 'flag1', enabled: true },
        { key: 'flag2', enabled: false },
      ];
      mockFeatureFlagService.getAllFlags.mockReturnValue(mockFlags);

      const handler = getRouteHandler('get', '/');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockFeatureFlagService.getAllFlags).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith({ flags: mockFlags });
    });
  });

  describe('GET /category/:category', () => {
    it('should return flags by category', async () => {
      mockReq.params = { category: 'ai' };
      const mockFlags = [{ key: 'aiFeature', enabled: true }];
      mockFeatureFlagService.getFlagsByCategory.mockReturnValue(mockFlags);

      const handler = getRouteHandler('get', '/category/:category');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockFeatureFlagService.getFlagsByCategory).toHaveBeenCalledWith('ai');
      expect(mockJson).toHaveBeenCalledWith({ flags: mockFlags, category: 'ai' });
    });
  });

  describe('GET /:key', () => {
    it('should return flag status by key', async () => {
      mockReq.params = { key: 'myFlag' };
      mockFeatureFlagService.isEnabled.mockReturnValue(true);
      mockFeatureFlagService.getFlag.mockReturnValue({
        key: 'myFlag',
        enabled: true,
        description: 'Test flag',
      });

      const handler = getRouteHandler('get', '/:key');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockFeatureFlagService.isEnabled).toHaveBeenCalledWith('myFlag');
      expect(mockFeatureFlagService.getFlag).toHaveBeenCalledWith('myFlag');
      expect(mockJson).toHaveBeenCalledWith({
        key: 'myFlag',
        enabled: true,
        flag: expect.objectContaining({ key: 'myFlag' }),
      });
    });

    it('should return null flag when not found', async () => {
      mockReq.params = { key: 'nonexistent' };
      mockFeatureFlagService.isEnabled.mockReturnValue(false);
      mockFeatureFlagService.getFlag.mockReturnValue(null);

      const handler = getRouteHandler('get', '/:key');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({
        key: 'nonexistent',
        enabled: false,
        flag: null,
      });
    });
  });

  describe('PUT /:key', () => {
    it('should update flag in development mode', async () => {
      mockReq.params = { key: 'testFlag' };
      mockReq.body = { enabled: true, description: 'Updated flag' };
      mockFeatureFlagService.getFlag.mockReturnValue({
        key: 'testFlag',
        enabled: true,
        description: 'Updated flag',
      });

      const handler = getRouteHandler('put', '/:key');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockFeatureFlagService.updateFlag).toHaveBeenCalledWith('testFlag', {
        enabled: true,
        description: 'Updated flag',
      });
      expect(mockJson).toHaveBeenCalledWith({
        success: true,
        flag: expect.objectContaining({ key: 'testFlag' }),
      });
    });

    it('should block update in production mode', async () => {
      process.env.NODE_ENV = 'production';
      mockReq.params = { key: 'testFlag' };
      mockReq.body = { enabled: true };

      const handler = getRouteHandler('put', '/:key');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(403);
      expect(mockJson).toHaveBeenCalledWith({
        error: 'Feature flag updates are disabled in production',
        message: 'Configure feature flags via environment variables or deployment configuration',
      });
      expect(mockFeatureFlagService.updateFlag).not.toHaveBeenCalled();
    });

    it('should handle update errors', async () => {
      mockReq.params = { key: 'testFlag' };
      mockReq.body = { enabled: true };
      mockFeatureFlagService.updateFlag.mockImplementation(() => {
        throw new Error('Update failed');
      });

      const handler = getRouteHandler('put', '/:key');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Update failed' });
    });
  });

  describe('POST /:key/toggle', () => {
    it('should toggle flag in development mode', async () => {
      mockReq.params = { key: 'toggleFlag' };
      mockFeatureFlagService.toggleFlag.mockReturnValue(true);
      mockFeatureFlagService.getFlag.mockReturnValue({
        key: 'toggleFlag',
        enabled: true,
      });

      const handler = getRouteHandler('post', '/:key/toggle');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockFeatureFlagService.toggleFlag).toHaveBeenCalledWith('toggleFlag');
      expect(mockJson).toHaveBeenCalledWith({
        success: true,
        key: 'toggleFlag',
        enabled: true,
        flag: expect.any(Object),
      });
    });

    it('should block toggle in production mode', async () => {
      process.env.NODE_ENV = 'production';
      mockReq.params = { key: 'toggleFlag' };

      const handler = getRouteHandler('post', '/:key/toggle');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(403);
      expect(mockJson).toHaveBeenCalledWith({
        error: 'Feature flag toggles are disabled in production',
        message: 'Configure feature flags via environment variables or deployment configuration',
      });
      expect(mockFeatureFlagService.toggleFlag).not.toHaveBeenCalled();
    });

    it('should handle toggle errors', async () => {
      mockReq.params = { key: 'toggleFlag' };
      mockFeatureFlagService.toggleFlag.mockImplementation(() => {
        throw new Error('Toggle failed');
      });

      const handler = getRouteHandler('post', '/:key/toggle');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Toggle failed' });
    });
  });

  describe('GET /studio/status', () => {
    it('should return studio status', async () => {
      mockFeatureFlagService.isEnabled.mockImplementation((key: string) => {
        if (key === 'studioDeprecated') return true;
        if (key === 'enhancedFieldEditor') return true;
        return false;
      });
      mockFeatureFlagService.shouldRedirectStudioToEditor.mockReturnValue(true);
      mockFeatureFlagService.shouldShowStudioDeprecationWarning.mockReturnValue(true);
      mockFeatureFlagService.getStudioDeprecationMessage.mockReturnValue(
        'Studio is deprecated'
      );

      const handler = getRouteHandler('get', '/studio/status');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({
        studioDeprecated: true,
        enhancedEditor: true,
        shouldRedirect: true,
        showWarning: true,
        deprecationMessage: 'Studio is deprecated',
      });
    });

    it('should return null deprecation message when warning not shown', async () => {
      mockFeatureFlagService.isEnabled.mockReturnValue(false);
      mockFeatureFlagService.shouldRedirectStudioToEditor.mockReturnValue(false);
      mockFeatureFlagService.shouldShowStudioDeprecationWarning.mockReturnValue(false);

      const handler = getRouteHandler('get', '/studio/status');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith({
        studioDeprecated: false,
        enhancedEditor: false,
        shouldRedirect: false,
        showWarning: false,
        deprecationMessage: null,
      });
    });
  });
});
