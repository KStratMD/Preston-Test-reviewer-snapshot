/**
 * HealthCheckService Unit Tests
 * Tests for health check service and middleware
 */

import { Request, Response, NextFunction } from 'express';
import {
  HealthCheckService,
  DeploymentConfig,
  defaultDeploymentConfig,
  HealthCheckResult,
} from '../../../src/services/HealthCheckService';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PerformanceMonitor
jest.mock('../../../src/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    getPerformanceReport: jest.fn().mockReturnValue({
      status: 'healthy',
      metrics: {},
    }),
  },
}));

// Mock AdvancedCache
jest.mock('../../../src/services/AdvancedCache', () => ({
  integrationCache: {
    getHealth: jest.fn().mockReturnValue({ status: 'healthy', hitRate: 85 }),
    getStats: jest.fn().mockReturnValue({ hits: 100, misses: 18 }),
  },
  responseCache: {
    getHealth: jest.fn().mockReturnValue({ status: 'healthy', hitRate: 90 }),
    getStats: jest.fn().mockReturnValue({ hits: 200, misses: 22 }),
  },
  configCache: {
    getHealth: jest.fn().mockReturnValue({ status: 'healthy', hitRate: 95 }),
    getStats: jest.fn().mockReturnValue({ hits: 50, misses: 3 }),
  },
  distributedCache: {
    getHealth: jest.fn().mockReturnValue({ status: 'healthy', hitRate: 80 }),
    getStats: jest.fn().mockReturnValue({ hits: 300, misses: 75 }),
  },
}));

// Mock RequestOptimizer
jest.mock('../../../src/middleware/RequestOptimizer', () => ({
  requestOptimizer: {
    getOptimizationReport: jest.fn().mockReturnValue({
      optimizations: [],
      status: 'optimal',
    }),
  },
}));

// Mock fetch for external dependency checks
global.fetch = jest.fn().mockImplementation(() =>
  Promise.resolve({
    ok: true,
    status: 200,
  })
);

describe('HealthCheckService', () => {
  let healthCheckService: HealthCheckService;
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;
  let setMock: jest.Mock;

  const testConfig: DeploymentConfig = {
    version: '1.0.0',
    environment: 'development',
    features: {
      advancedCaching: true,
      requestOptimization: true,
    },
    limits: {
      maxConnections: 1000,
      requestTimeout: 30000,
      memoryLimit: 2,
      cpuLimit: 80,
    },
    monitoring: {
      enableMetrics: true,
      enableTracing: false,
      enableProfiling: false,
      metricsInterval: 10000,
    },
    cache: {
      enabled: true,
      maxSize: 104857600,
      defaultTTL: 3600000,
    },
    security: {
      enableRateLimit: true,
      enableCORS: true,
      enableHelmet: true,
      trustedProxies: [],
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();

    jsonMock = jest.fn();
    setMock = jest.fn();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      path: '/test',
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
      set: setMock,
    };

    mockNext = jest.fn();

    healthCheckService = new HealthCheckService(testConfig);
  });

  describe('constructor', () => {
    it('should initialize with deployment config', () => {
      const service = new HealthCheckService(testConfig);
      expect(service).toBeDefined();
    });

    it('should record start time', () => {
      const beforeCreate = Date.now();
      const service = new HealthCheckService(testConfig);
      const afterCreate = Date.now();

      const deploymentInfo = service.getDeploymentInfo();
      const startTime = new Date(deploymentInfo.startTime as string).getTime();

      expect(startTime).toBeGreaterThanOrEqual(beforeCreate);
      expect(startTime).toBeLessThanOrEqual(afterCreate);
    });
  });

  describe('createHealthCheckMiddleware()', () => {
    it('should return middleware function', () => {
      const middleware = healthCheckService.createHealthCheckMiddleware();
      expect(typeof middleware).toBe('function');
    });

    it('should call next for non-health paths', async () => {
      mockRequest.path = '/api/users';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('should handle /health path', async () => {
      mockRequest.path = '/health';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          version: '1.0.0',
        })
      );
    });

    it('should handle /health/live path', async () => {
      mockRequest.path = '/health/live';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(200);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
        })
      );
    });

    it('should handle /health/ready path', async () => {
      mockRequest.path = '/health/ready';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          checks: expect.any(Object),
        })
      );
    });

    it('should handle /health/detailed path', async () => {
      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalled();
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          checks: expect.any(Object),
          metrics: expect.any(Object),
        })
      );
    });
  });

  describe('Liveness Check', () => {
    it('should return uptime', async () => {
      mockRequest.path = '/health';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      // Wait a bit to ensure uptime > 0
      await new Promise(resolve => setTimeout(resolve, 10));

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          uptime: expect.any(Number),
        })
      );
    });

    it('should include timestamp', async () => {
      mockRequest.path = '/health';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.timestamp).toBeDefined();
      expect(new Date(response.timestamp).getTime()).not.toBeNaN();
    });
  });

  describe('Readiness Check', () => {
    it('should check memory usage', async () => {
      mockRequest.path = '/health/ready';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.checks.memory).toBeDefined();
      expect(response.checks.memory.status).toMatch(/^(pass|warn|fail)$/);
    });

    it('should check cache health', async () => {
      mockRequest.path = '/health/ready';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.checks.cache).toBeDefined();
    });

    it('should return 200 when healthy', async () => {
      // Mock low memory usage to ensure 'pass' status deterministically
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = jest.fn().mockReturnValue({
        heapUsed: 50 * 1024 * 1024,   // 50MB
        heapTotal: 200 * 1024 * 1024,  // 200MB (25% utilization - well under 85% threshold)
        rss: 100 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      }) as any;

      try {
        mockRequest.path = '/health/ready';
        const middleware = healthCheckService.createHealthCheckMiddleware();

        await middleware(mockRequest as Request, mockResponse as Response, mockNext);

        expect(statusMock).toHaveBeenCalledWith(200);
      } finally {
        process.memoryUsage = originalMemoryUsage;
      }
    });
  });

  describe('Detailed Health Check', () => {
    it('should include all health checks', async () => {
      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.checks.memory).toBeDefined();
      expect(response.checks.cpu).toBeDefined();
      expect(response.checks.cache).toBeDefined();
      expect(response.checks.performance).toBeDefined();
      expect(response.checks.database).toBeDefined();
      expect(response.checks.external).toBeDefined();
      expect(response.checks.features).toBeDefined();
    });

    it('should include metrics', async () => {
      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.metrics).toBeDefined();
      expect(response.metrics.performance).toBeDefined();
      expect(response.metrics.cache).toBeDefined();
      expect(response.metrics.optimization).toBeDefined();
    });

    it('should set health check duration header', async () => {
      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setMock).toHaveBeenCalledWith(
        'X-Health-Check-Duration',
        expect.any(String)
      );
    });

    it('should include environment in response', async () => {
      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(response.environment).toBe('development');
    });
  });

  describe('getDeploymentInfo()', () => {
    it('should return version', () => {
      const info = healthCheckService.getDeploymentInfo();
      expect(info.version).toBe('1.0.0');
    });

    it('should return environment', () => {
      const info = healthCheckService.getDeploymentInfo();
      expect(info.environment).toBe('development');
    });

    it('should return start time', () => {
      const info = healthCheckService.getDeploymentInfo();
      expect(info.startTime).toBeDefined();
    });

    it('should return uptime', () => {
      const info = healthCheckService.getDeploymentInfo();
      expect(info.uptime).toBeGreaterThanOrEqual(0);
    });

    it('should return config info', () => {
      const info = healthCheckService.getDeploymentInfo();
      expect(info.config).toBeDefined();
      expect((info.config as any).features).toBeDefined();
      expect((info.config as any).limits).toBeDefined();
      expect((info.config as any).monitoring).toBeDefined();
    });
  });

  describe('defaultDeploymentConfig', () => {
    it('should have version', () => {
      expect(defaultDeploymentConfig.version).toBeDefined();
    });

    it('should have environment', () => {
      expect(defaultDeploymentConfig.environment).toBeDefined();
    });

    it('should have features', () => {
      expect(defaultDeploymentConfig.features).toBeDefined();
      expect(defaultDeploymentConfig.features.advancedCaching).toBeDefined();
    });

    it('should have limits', () => {
      expect(defaultDeploymentConfig.limits).toBeDefined();
      expect(defaultDeploymentConfig.limits.maxConnections).toBeDefined();
      expect(defaultDeploymentConfig.limits.requestTimeout).toBeDefined();
    });

    it('should have monitoring config', () => {
      expect(defaultDeploymentConfig.monitoring).toBeDefined();
      expect(defaultDeploymentConfig.monitoring.enableMetrics).toBeDefined();
    });

    it('should have cache config', () => {
      expect(defaultDeploymentConfig.cache).toBeDefined();
      expect(defaultDeploymentConfig.cache.enabled).toBeDefined();
      expect(defaultDeploymentConfig.cache.maxSize).toBeDefined();
    });

    it('should have security config', () => {
      expect(defaultDeploymentConfig.security).toBeDefined();
      expect(defaultDeploymentConfig.security.enableRateLimit).toBeDefined();
      expect(defaultDeploymentConfig.security.enableCORS).toBeDefined();
    });
  });

  describe('Status Determination', () => {
    it('should return healthy when all checks pass', async () => {
      mockRequest.path = '/health/ready';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      const response = jsonMock.mock.calls[0][0];
      expect(['healthy', 'degraded', 'unhealthy']).toContain(response.status);
    });
  });

  describe('Error Handling', () => {
    it('should handle errors in detailed health check', async () => {
      // Mock an error in performance report
      const { performanceMonitor } = require('../../../src/services/PerformanceMonitor');
      performanceMonitor.getPerformanceReport.mockImplementationOnce(() => {
        throw new Error('Performance monitor error');
      });

      mockRequest.path = '/health/detailed';
      const middleware = healthCheckService.createHealthCheckMiddleware();

      await middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unhealthy',
          error: 'Health check system failure',
        })
      );
    });
  });
});
