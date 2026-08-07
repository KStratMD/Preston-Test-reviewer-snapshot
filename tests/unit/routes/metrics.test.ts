/**
 * Metrics Routes Unit Tests
 * Tests for Prometheus metrics API endpoint
 */

import { Request, Response } from 'express';

// Mock prom-client before importing the route
const mockMetrics = 'prometheus_metrics_here';
const mockContentType = 'text/plain; version=0.0.4; charset=utf-8';

jest.mock('prom-client', () => ({
  Counter: jest.fn().mockImplementation(() => ({
    inc: jest.fn(),
    labels: jest.fn().mockReturnThis(),
  })),
  register: {
    metrics: jest.fn().mockResolvedValue(mockMetrics),
    contentType: mockContentType,
  },
  collectDefaultMetrics: jest.fn(),
}));

// Disable default metrics collection in tests
process.env.PROM_DISABLE_DEFAULT_METRICS = '1';

import {
  createMetricsRouter,
  syncRunsCounter,
  syncErrorsCounter,
  __resetMetricsReviewCacheForTests,
} from '../../../src/routes/metrics';

describe('Metrics Routes', () => {
  let router: ReturnType<typeof createMetricsRouter>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockSet: jest.Mock;
  let mockEnd: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    router = createMetricsRouter();
    mockSet = jest.fn();
    mockEnd = jest.fn();
    mockRes = {
      set: mockSet,
      end: mockEnd,
    };
    mockReq = {};
  });

  // Returns the TERMINAL handler for method+path — routes may chain multiple
  // middleware for the same method (e.g. `/` now runs metricsScrapeAuth
  // before the Prometheus handler), so grab the last match, not the first.
  const getRouteHandler = (method: string, path: string) => {
    const routes = (router as any).stack || [];
    for (const layer of routes) {
      if (layer.route && layer.route.path === path) {
        const methodHandlers = layer.route.stack.filter(
          (s: any) => s.method === method
        );
        if (methodHandlers.length > 0) {
          return methodHandlers[methodHandlers.length - 1].handle;
        }
      }
    }
    return null;
  };

  describe('GET /', () => {
    it('should return Prometheus metrics', async () => {
      const handler = getRouteHandler('get', '/');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockSet).toHaveBeenCalledWith('Content-Type', mockContentType);
      expect(mockEnd).toHaveBeenCalledWith(mockMetrics);
    });

    it('should set correct content type for Prometheus', async () => {
      const handler = getRouteHandler('get', '/');
      if (handler) {
        await handler(mockReq as Request, mockRes as Response);
      }

      expect(mockSet).toHaveBeenCalledWith(
        'Content-Type',
        expect.stringContaining('text/plain')
      );
    });
  });

  describe('Counter exports', () => {
    it('should export syncRunsCounter', () => {
      expect(syncRunsCounter).toBeDefined();
    });

    it('should export syncErrorsCounter', () => {
      expect(syncErrorsCounter).toBeDefined();
    });
  });

  describe('createMetricsRouter', () => {
    it('should create a router instance', () => {
      const router = createMetricsRouter();
      expect(router).toBeDefined();
      expect((router as any).stack).toBeDefined();
    });

    it('should have the metrics endpoint registered', () => {
      const router = createMetricsRouter();
      const handler = getRouteHandler('get', '/');
      expect(handler).toBeDefined();
    });

    it('should have the /review JSON sub-route registered', () => {
      createMetricsRouter();
      const handler = getRouteHandler('get', '/review');
      expect(handler).toBeDefined();
    });
  });

  describe('GET /review (reviewer JSON payload)', () => {
    let mockStatus: jest.Mock;
    let mockSend: jest.Mock;
    let reviewRes: Partial<Response>;

    beforeEach(() => {
      __resetMetricsReviewCacheForTests();
      mockSend = jest.fn();
      mockStatus = jest.fn().mockReturnValue({ send: mockSend });
      reviewRes = {
        set: jest.fn(),
        status: mockStatus,
      };
    });

    it('sets application/json Content-Type and 200 status', async () => {
      const handler = getRouteHandler('get', '/review');
      expect(handler).toBeDefined();
      await handler(mockReq as Request, reviewRes as Response);
      expect(reviewRes.set).toHaveBeenCalledWith(
        'Content-Type',
        'application/json; charset=utf-8',
      );
      expect(mockStatus).toHaveBeenCalledWith(200);
    });

    it('returns the documented reviewer-evidence shape', async () => {
      const handler = getRouteHandler('get', '/review');
      await handler(mockReq as Request, reviewRes as Response);
      expect(mockSend).toHaveBeenCalledTimes(1);
      const body = JSON.parse(mockSend.mock.calls[0][0]);
      expect(body.schema_version).toBe(1);
      expect(body.dlp_patterns_endpoint).toBe('/api/compliance/dlp-patterns');
      expect(body.link_to_evidence).toBe('EVALUATION.md');
      expect(typeof body.served_at).toBe('string');
      expect(new Date(body.served_at).toString()).not.toBe('Invalid Date');
      expect(typeof body.payload_loaded_at).toBe('string');
      expect(typeof body.build_sha).toBe('string');
      expect(body.build_sha.length).toBeGreaterThan(0);
      expect(Array.isArray(body.proof_cards)).toBe(true);
    });

    it('proof_cards are sourced from docs/review/proof-cards', async () => {
      const handler = getRouteHandler('get', '/review');
      await handler(mockReq as Request, reviewRes as Response);
      const body = JSON.parse(mockSend.mock.calls[0][0]);
      expect(body.proof_cards.length).toBeGreaterThan(0);
      for (const card of body.proof_cards) {
        expect(typeof card.component).toBe('string');
        expect(card.card_path).toMatch(/^docs\/review\/proof-cards\/.+\.md$/);
        expect(typeof card.status).toBe('string');
      }
      // _template.md must be excluded from the index — it is a fixture, not evidence.
      expect(
        body.proof_cards.find(
          (c: { card_path: string }) => c.card_path.endsWith('/_template.md'),
        ),
      ).toBeUndefined();
    });

    it('build_sha honors BUILD_SHA env var when set', async () => {
      const previous = process.env.BUILD_SHA;
      process.env.BUILD_SHA = 'unit-test-sha-xyz';
      __resetMetricsReviewCacheForTests();
      try {
        const handler = getRouteHandler('get', '/review');
        await handler(mockReq as Request, reviewRes as Response);
        const body = JSON.parse(mockSend.mock.calls[0][0]);
        expect(body.build_sha).toBe('unit-test-sha-xyz');
      } finally {
        if (previous === undefined) {
          delete process.env.BUILD_SHA;
        } else {
          process.env.BUILD_SHA = previous;
        }
      }
    });

    it('reuses cached proof-card load on a second request within TTL', async () => {
      const handler = getRouteHandler('get', '/review');
      await handler(mockReq as Request, reviewRes as Response);
      const firstBody = JSON.parse(mockSend.mock.calls[0][0]);
      const firstLoadedAt = firstBody.payload_loaded_at;

      await new Promise((r) => setTimeout(r, 5));

      const secondRes: Partial<Response> = {
        set: jest.fn(),
        status: jest.fn().mockReturnValue({ send: mockSend }),
      };
      await handler(mockReq as Request, secondRes as Response);
      const secondBody = JSON.parse(mockSend.mock.calls[1][0]);
      // payload_loaded_at is stamped when the cache was filled, so it MUST be
      // identical across two close-together requests; served_at SHOULD differ.
      expect(secondBody.payload_loaded_at).toBe(firstLoadedAt);
      expect(secondBody.served_at).not.toBe(firstBody.served_at);
    });
  });
});
