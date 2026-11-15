/**
 * Automation Libraries Routes Unit Tests
 * Tests for automation libraries API endpoints
 */

import { Request, Response } from 'express';

// Mock the container
const mockAutomationService = {
  getLibraries: jest.fn(),
  getLibrary: jest.fn(),
  getPayoutExecutions: jest.fn(),
  executePayoutAutomation: jest.fn(),
  getQualityResults: jest.fn(),
  executeQualityCheck: jest.fn(),
  getInstallerTasks: jest.fn(),
  executeInstaller: jest.fn(),
  getAnalytics: jest.fn(),
};

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn(() => mockAutomationService),
  },
}));

jest.mock('../../../src/inversify/types', () => ({
  TYPES: {
    AutomationLibrariesService: Symbol.for('AutomationLibrariesService'),
  },
}));

import { automationLibrariesRouter as router } from '../../../src/routes/automationLibraries';

describe('Automation Libraries Routes', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockNext: jest.Mock;

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
      query: {},
      params: {},
      body: {},
    };
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

  describe('GET /libraries', () => {
    it('should return all libraries', async () => {
      const mockLibraries = [
        { id: 'lib1', name: 'Library 1' },
        { id: 'lib2', name: 'Library 2' },
      ];
      mockAutomationService.getLibraries.mockResolvedValue(mockLibraries);

      const handler = getRouteHandler('get', '/libraries');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getLibraries).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockLibraries);
    });

    it('should filter by category', async () => {
      mockReq.query = { category: 'payout' };
      mockAutomationService.getLibraries.mockResolvedValue([]);

      const handler = getRouteHandler('get', '/libraries');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getLibraries).toHaveBeenCalledWith('payout');
    });
  });

  describe('GET /libraries/:libraryId', () => {
    it('should return library by ID', async () => {
      const mockLibrary = { id: 'lib1', name: 'Library 1' };
      mockReq.params = { libraryId: 'lib1' };
      mockAutomationService.getLibrary.mockResolvedValue(mockLibrary);

      const handler = getRouteHandler('get', '/libraries/:libraryId');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getLibrary).toHaveBeenCalledWith('lib1');
      expect(mockJson).toHaveBeenCalledWith(mockLibrary);
    });

    it('should return 404 when library not found', async () => {
      mockReq.params = { libraryId: 'nonexistent' };
      mockAutomationService.getLibrary.mockResolvedValue(null);

      const handler = getRouteHandler('get', '/libraries/:libraryId');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Library not found' });
    });
  });

  describe('GET /payout/executions', () => {
    it('should return payout executions', async () => {
      const mockExecutions = [{ id: 'exec1', status: 'completed' }];
      mockAutomationService.getPayoutExecutions.mockResolvedValue(mockExecutions);

      const handler = getRouteHandler('get', '/payout/executions');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getPayoutExecutions).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockExecutions);
    });

    it('should filter by status and vendorId', async () => {
      mockReq.query = {
        status: 'pending',
        vendorId: 'vendor123',
        limit: '10',
        offset: '5',
      };
      mockAutomationService.getPayoutExecutions.mockResolvedValue([]);

      const handler = getRouteHandler('get', '/payout/executions');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getPayoutExecutions).toHaveBeenCalledWith({
        status: ['pending'],
        vendorId: 'vendor123',
        limit: 10,
        offset: 5,
      });
    });
  });

  describe('POST /payout/execute', () => {
    it('should execute payout automation', async () => {
      mockReq.body = {
        vendorId: 'vendor123',
        amount: 1000,
        description: 'Test payout',
        paymentMethod: 'ach',
        metadata: { key: 'value' },
      };
      mockAutomationService.executePayoutAutomation.mockResolvedValue('exec-123');

      const handler = getRouteHandler('post', '/payout/execute');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.executePayoutAutomation).toHaveBeenCalledWith(
        'vendor123',
        1000,
        'Test payout',
        'ach',
        { key: 'value' }
      );
      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(mockJson).toHaveBeenCalledWith({ executionId: 'exec-123' });
    });
  });

  describe('GET /quality/results', () => {
    it('should return quality results', async () => {
      const mockResults = [{ id: 'qr1', status: 'passed' }];
      mockAutomationService.getQualityResults.mockResolvedValue(mockResults);

      const handler = getRouteHandler('get', '/quality/results');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getQualityResults).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockResults);
    });
  });

  describe('POST /quality/execute', () => {
    it('should execute quality check', async () => {
      mockReq.body = {
        templateId: 'template1',
        targetType: 'integration',
        targetId: 'int-123',
        targetName: 'Test Integration',
      };
      const mockResult = { id: 'check-123', status: 'passed' };
      mockAutomationService.executeQualityCheck.mockResolvedValue(mockResult);

      const handler = getRouteHandler('post', '/quality/execute');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.executeQualityCheck).toHaveBeenCalledWith(
        'template1',
        'integration',
        'int-123',
        'Test Integration'
      );
      expect(mockJson).toHaveBeenCalledWith(mockResult);
    });

    it('should return 400 when required fields are missing', async () => {
      mockReq.body = {
        templateId: 'template1',
        // missing targetType, targetId, targetName
      };

      const handler = getRouteHandler('post', '/quality/execute');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.any(String) })
      );
    });
  });

  describe('GET /installer/tasks', () => {
    it('should return installer tasks', async () => {
      const mockTasks = [{ id: 'task1', status: 'pending' }];
      mockAutomationService.getInstallerTasks.mockResolvedValue(mockTasks);

      const handler = getRouteHandler('get', '/installer/tasks');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getInstallerTasks).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockTasks);
    });

    it('should filter by status and environment', async () => {
      mockReq.query = {
        status: 'completed',
        environment: 'production',
        limit: '20',
        offset: '0',
      };
      mockAutomationService.getInstallerTasks.mockResolvedValue([]);

      const handler = getRouteHandler('get', '/installer/tasks');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getInstallerTasks).toHaveBeenCalledWith({
        status: ['completed'],
        environment: 'production',
        limit: 20,
        offset: 0,
      });
    });
  });

  describe('POST /installer/execute', () => {
    it('should execute installer', async () => {
      mockReq.body = {
        templateId: 'template1',
        targetType: 'connector',
        targetName: 'NetSuite',
        targetVersion: '1.0.0',
        environment: 'sandbox',
        executedBy: 'user@example.com',
      };
      mockAutomationService.executeInstaller.mockResolvedValue('task-123');

      const handler = getRouteHandler('post', '/installer/execute');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.executeInstaller).toHaveBeenCalledWith(
        'template1',
        'connector',
        'NetSuite',
        '1.0.0',
        'sandbox',
        'user@example.com'
      );
      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(mockJson).toHaveBeenCalledWith({ taskId: 'task-123' });
    });

    it('should return 400 when required fields are missing', async () => {
      mockReq.body = {
        templateId: 'template1',
        // missing other required fields
      };

      const handler = getRouteHandler('post', '/installer/execute');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
    });
  });

  describe('GET /analytics', () => {
    it('should return analytics data', async () => {
      const mockAnalytics = {
        totalExecutions: 100,
        successRate: 95,
        avgDuration: 150,
      };
      mockAutomationService.getAnalytics.mockResolvedValue(mockAnalytics);

      const handler = getRouteHandler('get', '/analytics');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockAutomationService.getAnalytics).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(mockAnalytics);
    });
  });
});
