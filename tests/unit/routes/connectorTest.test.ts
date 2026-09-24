/**
 * Connector Test Routes Unit Tests
 * Tests for connector test API endpoints
 */

import { Request, Response } from 'express';

// Mock NetSuiteConnector
const mockNetSuiteConnector = {
  initialize: jest.fn(),
  testConnection: jest.fn(),
};

jest.mock('../../../src/connectors/NetSuiteConnector', () => ({
  NetSuiteConnector: jest.fn(() => mockNetSuiteConnector),
}));

// Mock MockConnectorAdapter
const mockMockConnector = {
  initialize: jest.fn(),
  testConnection: jest.fn(),
};

jest.mock('../../../src/connectors/MockConnectorAdapter', () => ({
  MockConnectorAdapter: jest.fn(() => mockMockConnector),
}));

// Mock Logger (class + singleton — factory must be self-contained due to jest.mock hoisting)
jest.mock('../../../src/utils/Logger', () => {
  const inst = { info: jest.fn(), error: jest.fn(), debug: jest.fn(), warn: jest.fn() };
  return { Logger: jest.fn(() => inst), logger: inst, createLogger: jest.fn(() => inst) };
});

// Mock AuthService
jest.mock('../../../src/services/AuthService', () => ({
  AuthService: jest.fn(() => ({
    authenticate: jest.fn(),
  })),
}));

// Mock inversify container — prevents full DI initialization (EncryptionService et al.)
jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn().mockReturnValue({
      validateConnectorWrite: jest.fn().mockResolvedValue({
        approved: true,
        approvalRequired: false,
        findings: [],
        riskLevel: 'low',
        auditMetadata: { scanDurationMs: 0, findingsCount: 0, redacted: false, blocked: false },
      }),
    }),
  },
}));

import router from '../../../src/routes/connectorTest';

describe('Connector Test Routes', () => {
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
      body: {},
    };
  });

  // Get route handler
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

  describe('POST /test-connection', () => {
    it('should return 400 when connectorType is missing', async () => {
      mockReq.body = {
        configuration: { accountId: '123' },
      };

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: expect.stringContaining('Missing required fields'),
        })
      );
    });

    it('should return 400 when configuration is missing', async () => {
      mockReq.body = {
        connectorType: 'netsuite',
      };

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(400);
    });

    it('should test NetSuite connection successfully', async () => {
      mockReq.body = {
        connectorType: 'netsuite',
        connectorName: 'NetSuite Production',
        configuration: {
          accountId: 'TSTDRV123',
          consumerKey: 'key123',
          consumerSecret: 'secret123',
          tokenId: 'token123',
          tokenSecret: 'tokensecret123',
        },
      };

      mockNetSuiteConnector.initialize.mockResolvedValue(undefined);
      mockNetSuiteConnector.testConnection.mockResolvedValue({
        success: true,
        version: '2024.1',
        permissions: ['read', 'write'],
        rateLimits: 'Available',
      });

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNetSuiteConnector.initialize).toHaveBeenCalled();
      expect(mockNetSuiteConnector.testConnection).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          connectionType: 'real',
        })
      );
    });

    it('should handle NetSuite connection failure', async () => {
      mockReq.body = {
        connectorType: 'netsuite',
        connectorName: 'NetSuite Production',
        configuration: {
          accountId: 'TSTDRV123',
          consumerKey: 'badkey',
          consumerSecret: 'badsecret',
          tokenId: 'badtoken',
          tokenSecret: 'badtokensecret',
        },
      };

      mockNetSuiteConnector.initialize.mockRejectedValue(
        new Error('Invalid credentials')
      );

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid credentials',
        })
      );
    });

    it('should test mock connector for other types', async () => {
      mockReq.body = {
        connectorType: 'salesforce',
        connectorName: 'Salesforce',
        configuration: {
          clientId: 'test',
          clientSecret: 'test',
        },
      };

      mockMockConnector.initialize.mockResolvedValue(undefined);
      mockMockConnector.testConnection.mockResolvedValue({
        success: true,
        message: 'Connected to Salesforce (demo)',
        details: {
          connectionType: 'demo',
          responseTime: '100ms',
        },
      });

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockMockConnector.initialize).toHaveBeenCalled();
      expect(mockMockConnector.testConnection).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          connectionType: 'demo',
        })
      );
    });

    it('should handle mock connector failures', async () => {
      mockReq.body = {
        connectorType: 'hubspot',
        connectorName: 'HubSpot',
        configuration: {
          apiKey: 'test',
        },
      };

      mockMockConnector.initialize.mockResolvedValue(undefined);
      mockMockConnector.testConnection.mockResolvedValue({
        success: false,
        message: 'Connection failed',
        details: {},
      });

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
        })
      );
    });

    it('should handle generic errors', async () => {
      mockReq.body = {
        connectorType: 'unknown',
        connectorName: 'Unknown',
        configuration: {},
      };

      mockMockConnector.initialize.mockRejectedValue(
        new Error('Unexpected error')
      );

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Unexpected error',
        })
      );
    });

    it('should handle case-insensitive connector types', async () => {
      mockReq.body = {
        connectorType: 'NETSUITE',
        connectorName: 'NetSuite',
        configuration: {
          accountId: 'TEST123',
          consumerKey: 'key',
          consumerSecret: 'secret',
          tokenId: 'token',
          tokenSecret: 'tokensecret',
        },
      };

      mockNetSuiteConnector.initialize.mockResolvedValue(undefined);
      mockNetSuiteConnector.testConnection.mockResolvedValue({
        success: true,
      });

      const handler = getRouteHandler('post', '/test-connection');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response, mockNext);
      }

      expect(mockNetSuiteConnector.initialize).toHaveBeenCalled();
    });
  });
});
