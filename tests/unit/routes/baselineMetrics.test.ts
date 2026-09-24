/**
 * Baseline Metrics Routes Unit Tests
 * Tests for baseline metrics API endpoints
 */

import { Request, Response } from 'express';

// Mock BaselineMetricsService
const mockBaselineService = {
  getDashboardData: jest.fn(),
  initializeBaselines: jest.fn(),
  captureCurrentBaseline: jest.fn(),
  compareToBaseline: jest.fn(),
};

jest.mock('../../../src/services/baselines/BaselineMetricsService', () => ({
  BaselineMetricsService: jest.fn(() => mockBaselineService),
}));

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import router from '../../../src/routes/baselineMetrics';

describe('Baseline Metrics Routes', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockRes = {
      json: mockJson,
      status: mockStatus,
    };
    mockReq = {};
  });

  // Get route handler by path and method
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

  describe('GET /dashboard', () => {
    it('should return dashboard data successfully', async () => {
      const mockDashboardData = {
        performance: { responseTime: 150 },
        accuracy: { score: 95 },
        cost: { total: 100 },
      };
      mockBaselineService.getDashboardData.mockReturnValue(mockDashboardData);

      const handler = getRouteHandler('get', '/dashboard');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockDashboardData,
        })
      );
    });

    it('should handle errors gracefully', async () => {
      mockBaselineService.getDashboardData.mockImplementation(() => {
        throw new Error('Service unavailable');
      });

      const handler = getRouteHandler('get', '/dashboard');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to fetch baseline dashboard data',
        })
      );
    });
  });

  describe('POST /initialize', () => {
    it('should initialize baselines successfully', async () => {
      mockBaselineService.initializeBaselines.mockResolvedValue(undefined);

      const handler = getRouteHandler('post', '/initialize');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockBaselineService.initializeBaselines).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          message: 'Baseline measurement system initialized successfully',
        })
      );
    });

    it('should handle initialization errors', async () => {
      mockBaselineService.initializeBaselines.mockRejectedValue(
        new Error('Init failed')
      );

      const handler = getRouteHandler('post', '/initialize');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to initialize baseline system',
        })
      );
    });
  });

  describe('GET /current', () => {
    it('should return current baseline successfully', async () => {
      const mockBaseline = {
        performance: { avgResponseTime: 100 },
        timestamp: Date.now(),
      };
      mockBaselineService.captureCurrentBaseline.mockResolvedValue(mockBaseline);

      const handler = getRouteHandler('get', '/current');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockBaseline,
        })
      );
    });

    it('should handle capture errors', async () => {
      mockBaselineService.captureCurrentBaseline.mockRejectedValue(
        new Error('Capture failed')
      );

      const handler = getRouteHandler('get', '/current');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /comparison', () => {
    it('should return comparison data successfully', async () => {
      const mockComparison = {
        performanceDelta: -10,
        accuracyDelta: 5,
        overallScore: 90,
      };
      mockBaselineService.compareToBaseline.mockResolvedValue(mockComparison);

      const handler = getRouteHandler('get', '/comparison');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: mockComparison,
        })
      );
    });

    it('should handle comparison errors', async () => {
      mockBaselineService.compareToBaseline.mockRejectedValue(
        new Error('Comparison failed')
      );

      const handler = getRouteHandler('get', '/comparison');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
    });
  });

  describe('GET /gates', () => {
    it('should return gate status successfully', async () => {
      const mockComparison = {
        gateStatus: {
          passed: true,
          checks: [{ name: 'performance', passed: true }],
        },
        overallScore: 95,
      };
      mockBaselineService.compareToBaseline.mockResolvedValue(mockComparison);

      const handler = getRouteHandler('get', '/gates');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            gateStatus: mockComparison.gateStatus,
            overallScore: 95,
          }),
        })
      );
    });

    it('should handle gate check errors', async () => {
      mockBaselineService.compareToBaseline.mockRejectedValue(
        new Error('Gate check failed')
      );

      const handler = getRouteHandler('get', '/gates');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Failed to check gate status',
        })
      );
    });
  });
});
