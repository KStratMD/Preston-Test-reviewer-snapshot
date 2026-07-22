/**
 * Health Routes Unit Tests
 * Tests for health check API endpoints
 */

import { Request, Response } from 'express';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
  })),
}));

// Mock serverConfig
jest.mock('../../../src/config', () => ({
  serverConfig: {
    env: 'test',
    port: 3000,
  },
}));

import { createHealthRouter } from '../../../src/routes/health';

describe('Health Routes', () => {
  let router: ReturnType<typeof createHealthRouter>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  let mockSet: jest.Mock;
  let mockSend: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createHealthRouter();
    mockJson = jest.fn().mockReturnThis();
    mockStatus = jest.fn().mockReturnThis();
    mockSet = jest.fn().mockReturnThis();
    mockSend = jest.fn().mockReturnThis();
    mockRes = {
      json: mockJson,
      status: mockStatus,
      set: mockSet,
      send: mockSend,
    };
    mockReq = {};
  });

  const getRouteHandler = (method: string, path: string) => {
    const routes = (router as any).stack || [];
    for (const layer of routes) {
      if (layer.route && layer.route.path === path) {
        const handlers = layer.route.stack.filter(
          (s: any) => s.method === method || !s.method
        );
        if (handlers.length > 0) {
          return handlers[handlers.length - 1].handle;
        }
      }
    }
    return null;
  };

  describe('GET /health', () => {
    it('should return healthy status in test environment', async () => {
      const handler = getRouteHandler('get', '/health');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          timestamp: expect.any(String),
          uptime: expect.any(Number),
        })
      );
    });
  });

  describe('GET /health/ready', () => {
    const originalEnv = process.env;
    let memoryUsageSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env = { ...originalEnv };
      memoryUsageSpy = jest.spyOn(process, 'memoryUsage');
    });

    afterEach(() => {
      process.env = originalEnv;
      memoryUsageSpy.mockRestore();
    });

    it('should return ready status when JWT_SECRET is configured', async () => {
      process.env.JWT_SECRET = 'a-secret-that-is-at-least-32-characters-long';
      memoryUsageSpy.mockReturnValue({
        rss: 1024 * 1024 * 100,
        heapTotal: 1024 * 1024 * 100,
        heapUsed: 1024 * 1024 * 10,
        external: 1024 * 1024,
        arrayBuffers: 1024 * 512,
      });

      const handler = getRouteHandler('get', '/health/ready');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
          timestamp: expect.any(String),
        })
      );
    });

    it('should return not-ready when JWT_SECRET is missing', async () => {
      delete process.env.JWT_SECRET;

      const handler = getRouteHandler('get', '/health/ready');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not-ready',
        })
      );
    });

    it('should return not-ready when JWT_SECRET is too short', async () => {
      process.env.JWT_SECRET = 'short';

      const handler = getRouteHandler('get', '/health/ready');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'not-ready',
        })
      );
    });
  });

  describe('GET /ready', () => {
    const originalEnv = process.env;
    let memoryUsageSpy: jest.SpyInstance;

    beforeEach(() => {
      process.env = { ...originalEnv };
      memoryUsageSpy = jest.spyOn(process, 'memoryUsage');
    });

    afterEach(() => {
      process.env = originalEnv;
      memoryUsageSpy.mockRestore();
    });

    it('should return ready status (alias endpoint)', async () => {
      process.env.JWT_SECRET = 'a-secret-that-is-at-least-32-characters-long';
      memoryUsageSpy.mockReturnValue({
        rss: 1024 * 1024 * 100,
        heapTotal: 1024 * 1024 * 100,
        heapUsed: 1024 * 1024 * 10,
        external: 1024 * 1024,
        arrayBuffers: 1024 * 512,
      });

      const handler = getRouteHandler('get', '/ready');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'ready',
        })
      );
    });
  });

  describe('GET /health/live', () => {
    it('should return alive status', () => {
      const handler = getRouteHandler('get', '/health/live');
      if (handler) {
        handler(mockReq as Request, mockRes as Response);
      }

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'alive',
          timestamp: expect.any(String),
          uptime: expect.any(Number),
        })
      );
    });
  });

  describe('GET /metrics (with observability service)', () => {
    it('should return metrics when observability service is provided', () => {
      const mockObservabilityService = {
        recordMetric: jest.fn(),
      };
      const routerWithMetrics = createHealthRouter(mockObservabilityService as any);

      const handler = (() => {
        const routes = (routerWithMetrics as any).stack || [];
        for (const layer of routes) {
          if (layer.route && layer.route.path === '/metrics') {
            const handlers = layer.route.stack.filter(
              (s: any) => s.method === 'get' || !s.method
            );
            if (handlers.length > 0) {
              return handlers[handlers.length - 1].handle;
            }
          }
        }
        return null;
      })();

      if (handler) {
        handler(mockReq as Request, mockRes as Response);
      }

      expect(mockSet).toHaveBeenCalledWith('Content-Type', 'text/plain; charset=utf-8');
      expect(mockSend).toHaveBeenCalledWith(expect.stringContaining('nodejs_memory_heap_used_bytes'));
    });
  });

  describe('createHealthRouter', () => {
    it('should create a router instance', () => {
      const router = createHealthRouter();
      expect(router).toBeDefined();
      expect((router as any).stack).toBeDefined();
    });

    it('should create router with observability service', () => {
      const mockObservabilityService = { recordMetric: jest.fn() };
      const router = createHealthRouter(mockObservabilityService as any);
      expect(router).toBeDefined();
    });
  });
});
