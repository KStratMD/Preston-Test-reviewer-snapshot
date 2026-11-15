/**
 * Health Routes Unit Tests
 * Tests for health check API endpoints
 */

import { Request, Response } from 'express';

const mockEnv = { HOSTED_DEMO: false };
const mockServerConfig = { env: 'test', port: 3000 };

// The V8 heap ceiling drives every health/readiness memory decision.
jest.mock('node:v8', () => ({
  getHeapStatistics: jest.fn(),
}));

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
  env: mockEnv,
  serverConfig: mockServerConfig,
}));

import { getHeapStatistics } from 'node:v8';
import { createHealthRouter } from '../../../src/routes/health';

/** Production's observed V8 ceiling: ~2.05 GiB. */
const HEAP_SIZE_LIMIT = 2197815296;

/**
 * Set the whole stats object, so a test can omit `heap_size_limit` entirely.
 * Do not funnel this through a defaulted parameter: passing `undefined` to one
 * would silently substitute the real ceiling and the missing-field case would
 * never be exercised.
 */
const mockHeapStats = (stats: Partial<ReturnType<typeof getHeapStatistics>>) => {
  (getHeapStatistics as jest.MockedFunction<typeof getHeapStatistics>).mockReturnValue(
    stats as ReturnType<typeof getHeapStatistics>
  );
};

const mockHeapSizeLimit = (limit: number = HEAP_SIZE_LIMIT) => mockHeapStats({ heap_size_limit: limit });

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
    mockServerConfig.env = 'test';
    mockHeapSizeLimit();
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
      mockEnv.HOSTED_DEMO = false;
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

    it('uses the validated hosted-demo flag instead of reparsing process.env', async () => {
      process.env.JWT_SECRET = 'a-secret-that-is-at-least-32-characters-long';
      process.env.HOSTED_DEMO = 'true';
      mockEnv.HOSTED_DEMO = false;
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
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
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

  describe('heap pressure is measured against the V8 ceiling', () => {
    const originalEnv = process.env;
    let memoryUsageSpy: jest.SpyInstance;

    /**
     * Production's observed shape: a compact heap (~96% of heapTotal, which drove
     * the old predicate to critical/503) that is ~3% of the 2.05 GiB ceiling.
     */
    const PRODUCTION_HEAP_USED = 73 * 1024 * 1024;
    const PRODUCTION_HEAP_TOTAL = 76 * 1024 * 1024;

    /**
     * heapTotal can never exceed the ceiling, so heapUsed/heapTotal is always >=
     * heapUsed/heap_size_limit. A heap the new predicate calls critical was always
     * critical under the old one too — the endpoint that actually changes verdict
     * at high pressure is readiness, which used a separate 95% threshold.
     */
    const atCeiling = (usedFraction: number, totalFraction = 1) => ({
      heapUsed: Math.round(HEAP_SIZE_LIMIT * usedFraction),
      heapTotal: Math.round(HEAP_SIZE_LIMIT * totalFraction),
    });

    const mockMemoryUsage = (heapUsed: number, heapTotal: number) => {
      memoryUsageSpy.mockReturnValue({
        rss: 160 * 1024 * 1024,
        heapTotal,
        heapUsed,
        external: 4 * 1024 * 1024,
        arrayBuffers: 1024 * 512,
      });
    };

    beforeEach(() => {
      process.env = { ...originalEnv };
      process.env.JWT_SECRET = 'a-secret-that-is-at-least-32-characters-long';
      mockEnv.HOSTED_DEMO = false;
      memoryUsageSpy = jest.spyOn(process, 'memoryUsage');
      mockServerConfig.env = 'production';
    });

    afterEach(() => {
      process.env = originalEnv;
      memoryUsageSpy.mockRestore();
    });

    it('reports healthy for a compact heap that the old heapTotal ratio called critical', async () => {
      // heapUsed/heapTotal here is ~95%, which previously produced `critical`.
      // Against the 2.05 GiB ceiling it is ~3%.
      mockMemoryUsage(PRODUCTION_HEAP_USED, PRODUCTION_HEAP_TOTAL);

      const handler = getRouteHandler('get', '/health');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          checks: expect.objectContaining({
            memory: expect.objectContaining({
              status: 'healthy',
              heapLimitUtilizationPercent: 3,
              heapSizeLimit: HEAP_SIZE_LIMIT,
              heapTotal: PRODUCTION_HEAP_TOTAL,
            }),
          }),
        })
      );
    });

    it('reports warning between the warning and critical thresholds', async () => {
      // A tightly-sized heap at 80% of the ceiling: the old ratio read ~98%.
      const { heapUsed, heapTotal } = atCeiling(0.8, 0.82);
      mockMemoryUsage(heapUsed, heapTotal);

      const handler = getRouteHandler('get', '/health');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'degraded',
          checks: expect.objectContaining({
            memory: expect.objectContaining({ status: 'warning', heapLimitUtilizationPercent: 80 }),
          }),
        })
      );
    });

    it('reports critical when genuinely near the ceiling, still over HTTP 200', async () => {
      const { heapUsed, heapTotal } = atCeiling(0.95, 0.97);
      mockMemoryUsage(heapUsed, heapTotal);

      const handler = getRouteHandler('get', '/health');
      await handler(mockReq as Request, mockRes as Response);

      // The /health HTTP-200-always contract is deliberately unchanged.
      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'unhealthy',
          checks: expect.objectContaining({
            memory: expect.objectContaining({ status: 'critical', heapLimitUtilizationPercent: 95 }),
          }),
        })
      );
    });

    it('stays ready for a compact heap that previously returned 503', async () => {
      mockMemoryUsage(PRODUCTION_HEAP_USED, PRODUCTION_HEAP_TOTAL);

      const handler = getRouteHandler('get', '/health/ready');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({ status: 'ready' }));
    });

    it('reports not-ready when heap pressure is genuinely critical', async () => {
      // V8 has grown the heap to its ceiling and is using 91% of it. The old
      // readiness check read 91% of heapTotal, under its 95% bar, and said ready.
      const { heapUsed, heapTotal } = atCeiling(0.91);
      mockMemoryUsage(heapUsed, heapTotal);

      const handler = getRouteHandler('get', '/health/ready');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockStatus).toHaveBeenCalledWith(503);
      expect(mockJson).toHaveBeenCalledWith(expect.objectContaining({ status: 'not-ready' }));
    });

    it('classifies on the exact ratio, not the rounded reported percentage', async () => {
      // 90.4% is over the 90% critical threshold but rounds down to 90. Rounding
      // before comparing would classify `warning` (90 fails `> 90` but passes
      // `> 75`), not `healthy` — and `warning` is not `critical`, so readiness
      // would wrongly stay ready. That readiness half is what this test locks.
      const { heapUsed, heapTotal } = atCeiling(0.904);
      mockMemoryUsage(heapUsed, heapTotal);

      const healthHandler = getRouteHandler('get', '/health');
      await healthHandler(mockReq as Request, mockRes as Response);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({
            memory: expect.objectContaining({
              status: 'critical',
              // still reported rounded
              heapLimitUtilizationPercent: 90,
            }),
          }),
        })
      );

      mockStatus.mockClear();
      const readyHandler = getRouteHandler('get', '/health/ready');
      await readyHandler(mockReq as Request, mockRes as Response);
      expect(mockStatus).toHaveBeenCalledWith(503);
    });

    it.each([
      ['a zero ceiling', { heap_size_limit: 0 }],
      ['a missing ceiling', {}],
    ])('reports warning rather than healthy for %s', async (_label, stats) => {
      // Without the guard: 0 divides to Infinity (critical) and a missing field
      // to NaN, which loses every comparison and falls through to healthy — a
      // probe reporting healthy on data it could not read.
      mockHeapStats(stats);
      mockMemoryUsage(PRODUCTION_HEAP_USED, PRODUCTION_HEAP_TOTAL);

      const handler = getRouteHandler('get', '/health');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'degraded',
          checks: expect.objectContaining({
            memory: expect.objectContaining({
              status: 'warning',
              heapSizeLimit: null,
              heapSizeLimitMB: null,
              heapLimitUtilizationPercent: null,
            }),
          }),
        })
      );
    });

    it.each([
      ['a zero ceiling', { heap_size_limit: 0 }],
      ['a missing ceiling', {}],
    ])('stays ready for %s', async (_label, stats) => {
      // An unreadable diagnostic is not evidence of memory distress, so it must
      // not take the process out of rotation — only warn on /health.
      //
      // The zero-ceiling row is the one that can actually fail: without the
      // guard it divides to Infinity, classifies `critical`, and readiness drops
      // to 503. The missing-ceiling row cannot fail on readiness alone — NaN
      // loses every comparison and falls through to `healthy`, which is still
      // ready — so it is kept only to document the contract. The classification
      // itself is what the `reports warning rather than healthy` cases above
      // pin down for that row.
      mockHeapStats(stats);
      mockMemoryUsage(PRODUCTION_HEAP_USED, PRODUCTION_HEAP_TOTAL);

      const handler = getRouteHandler('get', '/health/ready');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockStatus).toHaveBeenCalledWith(200);
    });

    it('keeps the deprecated memoryUsagePercent field on its original semantics', async () => {
      // Retained for external consumers predating heapLimitUtilizationPercent.
      // It must stay heapUsed/heapTotal — repointing it at the ceiling ratio
      // would silently move any existing external alert threshold.
      mockMemoryUsage(PRODUCTION_HEAP_USED, PRODUCTION_HEAP_TOTAL);

      const handler = getRouteHandler('get', '/health');
      await handler(mockReq as Request, mockRes as Response);

      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({
            memory: expect.objectContaining({
              // ~96% of heapTotal, but only ~3% of the ceiling: the two fields
              // disagree by design, which is the whole point of the fix.
              memoryUsagePercent: 96,
              heapLimitUtilizationPercent: 3,
              status: 'healthy',
            }),
          }),
        })
      );
    });

    it('keeps /ready, /health/ready and /health on one classification', async () => {
      // Just above the critical threshold: every consumer must agree.
      const { heapUsed, heapTotal } = atCeiling(0.91);
      mockMemoryUsage(heapUsed, heapTotal);

      for (const path of ['/health/ready', '/ready']) {
        mockStatus.mockClear();
        const handler = getRouteHandler('get', path);
        await handler(mockReq as Request, mockRes as Response);
        expect(mockStatus).toHaveBeenCalledWith(503);
      }

      mockJson.mockClear();
      const healthHandler = getRouteHandler('get', '/health');
      await healthHandler(mockReq as Request, mockRes as Response);
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({
          checks: expect.objectContaining({
            memory: expect.objectContaining({ status: 'critical' }),
          }),
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
