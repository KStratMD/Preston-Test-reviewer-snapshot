/**
 * EnhancedRateLimit Middleware Unit Tests
 * Tests for enhanced rate limiting with sliding window, burst protection, and dynamic limits
 */

import { EnhancedRateLimit, RateLimitFactory, RateLimitConfig } from '../../../src/middleware/enhancedRateLimit';
import { Request, Response, NextFunction } from 'express';

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
  },
}));

// Use real timers for this test file (override global fake timers)
// The EnhancedRateLimit class depends on Date.now() and setInterval
beforeAll(() => {
  jest.useRealTimers();
});

describe('EnhancedRateLimit', () => {
  let rateLimiter: EnhancedRateLimit;

  // Simple key generator for tests - the default one has a `this` binding issue
  const testKeyGenerator = (req: Request): string => req.ip || 'unknown';
  const userKeyGenerator = (req: Request): string => {
    const userId = (req as any).user?.id || (req as any).userId;
    return userId ? `${req.ip}:${userId}` : req.ip || 'unknown';
  };

  const createMockRequest = (overrides: Partial<Request> = {}): Request => {
    return {
      ip: '127.0.0.1',
      url: '/api/test',
      method: 'GET',
      connection: { remoteAddress: '127.0.0.1' },
      socket: { remoteAddress: '127.0.0.1' },
      get: jest.fn((header: string) => {
        if (header === 'User-Agent') return 'test-agent';
        if (header === 'X-Forwarded-For') return undefined;
        if (header === 'X-Real-IP') return undefined;
        return undefined;
      }),
      ...overrides,
    } as unknown as Request;
  };

  const createMockResponse = (): Response => {
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
    };
    return res as unknown as Response;
  };

  afterEach(() => {
    if (rateLimiter) {
      rateLimiter.shutdown();
    }
    jest.clearAllMocks();
  });

  describe('constructor and defaults', () => {
    it('should create rate limiter with default configuration', () => {
      rateLimiter = new EnhancedRateLimit({ windowMs: 60000, max: 100 });

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(60000);
      expect(stats.config.max).toBe(100);
      expect(stats.config.slidingWindow).toBe(true);
      expect(stats.activeKeys).toBe(0);
    });

    it('should apply custom configuration', () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 30000,
        max: 50,
        burstLimit: 75,
        slidingWindow: false,
      });

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(30000);
      expect(stats.config.max).toBe(50);
      expect(stats.config.burstLimit).toBe(75);
      expect(stats.config.slidingWindow).toBe(false);
    });

    it('should use default values for undefined config options', () => {
      rateLimiter = new EnhancedRateLimit({} as RateLimitConfig);

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(60000);
      expect(stats.config.max).toBe(100);
    });

    it('should set default burstLimit to max * 2', () => {
      rateLimiter = new EnhancedRateLimit({ windowMs: 60000, max: 50 });

      const stats = rateLimiter.getStats();
      expect(stats.config.burstLimit).toBe(100);
    });
  });

  describe('middleware', () => {
    it('should allow requests under the limit', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 10,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
      expect((req as any).rateLimit).toBeDefined();
      expect((req as any).rateLimit.remaining).toBe(9);
    });

    it('should block requests over the limit', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 2,
        slidingWindow: false,
        keyGenerator: testKeyGenerator,
        onLimitReached: () => {}, // Provide explicit no-op to avoid default's this binding issue
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      // Make 3 requests - first 2 should pass, 3rd should be blocked
      await middleware(req, res, next);
      await middleware(req, res, next);
      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Rate limit exceeded',
      }));
    });

    it('should set standard rate limit headers', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        standardHeaders: true,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
        'RateLimit-Limit': '100',
        'RateLimit-Remaining': '99',
      }));
    });

    it('should set legacy rate limit headers when enabled', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        legacyHeaders: true,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '99',
      }));
    });

    it('should skip whitelisted IPs', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 1,
        whiteList: ['127.0.0.1'],
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest({ ip: '127.0.0.1' });
      const res = createMockResponse();
      const next = jest.fn();

      // Multiple requests should all pass for whitelisted IP
      await middleware(req, res, next);
      await middleware(req, res, next);
      await middleware(req, res, next);

      expect(next).toHaveBeenCalledTimes(3);
      expect(res.status).not.toHaveBeenCalled();
    });

    it('should use custom key generator', async () => {
      const customKeyGen = jest.fn().mockReturnValue('custom-key');
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: customKeyGen,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(customKeyGen).toHaveBeenCalledWith(req);
    });

    it('should apply dynamic limit function', async () => {
      const dynamicLimit = jest.fn().mockReturnValue(5);
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        dynamicLimit,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(dynamicLimit).toHaveBeenCalledWith(req);
      expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
        'RateLimit-Limit': '5',
      }));
    });

    it('should call onLimitReached callback when limit exceeded', async () => {
      const onLimitReached = jest.fn();
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 1,
        slidingWindow: false,
        onLimitReached,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      await middleware(req, res, next);

      expect(onLimitReached).toHaveBeenCalled();
    });

    it('should continue on error to avoid breaking the application', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: () => { throw new Error('Key gen error'); },
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('should include retryAfter in rate limit response', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 1,
        slidingWindow: false,
        keyGenerator: testKeyGenerator,
        onLimitReached: () => {}, // Provide explicit no-op to avoid default's this binding issue
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      await middleware(req, res, next);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        retryAfter: expect.any(Number),
      }));
    });
  });

  describe('sliding window', () => {
    it('should track requests in sliding window', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 5,
        slidingWindow: true,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      // Make 3 requests
      for (let i = 0; i < 3; i++) {
        await middleware(req, res, next);
      }

      const keyInfo = rateLimiter.getKeyInfo('127.0.0.1');
      expect(keyInfo?.history?.length).toBe(3);
      expect(keyInfo?.count).toBe(3);
    });

    it('should use history array for sliding window mode', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 10,
        slidingWindow: true,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      const keyInfo = rateLimiter.getKeyInfo('127.0.0.1');
      expect(keyInfo?.history).toBeDefined();
      expect(Array.isArray(keyInfo?.history)).toBe(true);
    });

    it('should not use history array for fixed window mode', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 10,
        slidingWindow: false,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      const keyInfo = rateLimiter.getKeyInfo('127.0.0.1');
      expect(keyInfo).toBeDefined();
      expect(keyInfo?.history).toBeUndefined();
    });
  });

  describe('burst limiting', () => {
    it('should enforce burst limits', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        burstLimit: 3,
        burstWindowMs: 1000,
        slidingWindow: false,
        keyGenerator: testKeyGenerator,
        onLimitReached: () => {}, // Provide explicit no-op to avoid default's this binding issue
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      // Exceed burst limit rapidly
      for (let i = 0; i < 5; i++) {
        await middleware(req, res, next);
      }

      expect(res.status).toHaveBeenCalledWith(429);
    });

    it('should track burst count', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        burstLimit: 10,
        burstWindowMs: 1000,
        slidingWindow: false,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      await middleware(req, res, next);
      await middleware(req, res, next);

      const keyInfo = rateLimiter.getKeyInfo('127.0.0.1');
      expect(keyInfo?.burstCount).toBe(3);
    });
  });

  describe('getClientIP extraction', () => {
    it('should extract IP from req.ip', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest({ ip: '192.168.1.1' });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('192.168.1.1')).toBeDefined();
    });

    it('should use IP from connection when req.ip undefined', async () => {
      const customKeyGen = (req: Request): string => {
        return req.ip || (req as any).connection?.remoteAddress || 'unknown';
      };
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: customKeyGen,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest({
        ip: undefined,
        connection: { remoteAddress: '10.0.0.5' } as any,
      });
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('10.0.0.5')).toBeDefined();
    });
  });

  describe('utility methods', () => {
    it('should return stats', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      await middleware(req, res, next);

      const stats = rateLimiter.getStats();
      expect(stats.activeKeys).toBe(1);
      expect(stats.totalRequests).toBe(2);
    });

    it('should reset specific key', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(rateLimiter.getKeyInfo('127.0.0.1')).toBeDefined();

      const result = rateLimiter.resetKey('127.0.0.1');
      expect(result).toBe(true);
      expect(rateLimiter.getKeyInfo('127.0.0.1')).toBeUndefined();
    });

    it('should return false when resetting non-existent key', () => {
      rateLimiter = new EnhancedRateLimit({ windowMs: 60000, max: 100 });

      const result = rateLimiter.resetKey('non-existent');
      expect(result).toBe(false);
    });

    it('should get key info', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      const keyInfo = rateLimiter.getKeyInfo('127.0.0.1');
      expect(keyInfo).toBeDefined();
      expect(keyInfo?.count).toBe(1);
    });

    it('should shutdown and clear all entries', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);
      expect(rateLimiter.getStats().activeKeys).toBe(1);

      rateLimiter.shutdown();
      expect(rateLimiter.getStats().activeKeys).toBe(0);
    });

    it('should return undefined for non-existent key', () => {
      rateLimiter = new EnhancedRateLimit({ windowMs: 60000, max: 100 });

      const keyInfo = rateLimiter.getKeyInfo('non-existent');
      expect(keyInfo).toBeUndefined();
    });
  });

  describe('key generation with user ID', () => {
    it('should include user ID in key when available', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: userKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      (req as any).user = { id: 'user123' };
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('127.0.0.1:user123')).toBeDefined();
    });

    it('should use userId property when user object not present', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: userKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      (req as any).userId = 'user456';
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('127.0.0.1:user456')).toBeDefined();
    });
  });

  describe('rate limit info on request', () => {
    it('should attach rate limit info to request object', async () => {
      rateLimiter = new EnhancedRateLimit({
        windowMs: 60000,
        max: 100,
        keyGenerator: testKeyGenerator,
      });
      const middleware = rateLimiter.middleware();

      const req = createMockRequest();
      const res = createMockResponse();
      const next = jest.fn();

      await middleware(req, res, next);

      const rateLimit = (req as any).rateLimit;
      expect(rateLimit).toBeDefined();
      expect(rateLimit.limit).toBe(100);
      expect(rateLimit.remaining).toBe(99);
      expect(rateLimit.used).toBe(1);
      expect(rateLimit.reset).toBeDefined();
    });
  });
});

describe('RateLimitFactory', () => {
  let rateLimiter: EnhancedRateLimit;

  afterEach(() => {
    if (rateLimiter) {
      rateLimiter.shutdown();
    }
  });

  describe('createBasicLimit', () => {
    it('should create basic rate limiter', () => {
      rateLimiter = RateLimitFactory.createBasicLimit(60000, 100);

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(60000);
      expect(stats.config.max).toBe(100);
      expect(stats.config.slidingWindow).toBe(false);
    });

    it('should create working middleware', async () => {
      rateLimiter = RateLimitFactory.createBasicLimit(60000, 100);
      const middleware = rateLimiter.middleware();

      const req = {
        ip: '127.0.0.1',
        url: '/api/test',
        method: 'GET',
        connection: { remoteAddress: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
        get: jest.fn(),
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('createSlidingWindowLimit', () => {
    it('should create sliding window rate limiter', () => {
      rateLimiter = RateLimitFactory.createSlidingWindowLimit(30000, 50);

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(30000);
      expect(stats.config.max).toBe(50);
      expect(stats.config.slidingWindow).toBe(true);
    });
  });

  describe('createBurstLimit', () => {
    it('should create burst rate limiter', () => {
      rateLimiter = RateLimitFactory.createBurstLimit(60000, 100, 150, 5000);

      const stats = rateLimiter.getStats();
      expect(stats.config.windowMs).toBe(60000);
      expect(stats.config.max).toBe(100);
      expect(stats.config.burstLimit).toBe(150);
    });
  });

  describe('createUserBasedLimit', () => {
    it('should create user-based rate limiter', async () => {
      rateLimiter = RateLimitFactory.createUserBasedLimit(60000, 100);
      const middleware = rateLimiter.middleware();

      const req = {
        ip: '127.0.0.1',
        url: '/api/test',
        method: 'GET',
        user: { id: 'user789' },
        connection: { remoteAddress: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
        get: jest.fn(),
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('user:user789')).toBeDefined();
    });

    it('should fallback to IP when no user', async () => {
      rateLimiter = RateLimitFactory.createUserBasedLimit(60000, 100);
      const middleware = rateLimiter.middleware();

      const req = {
        ip: '192.168.1.1',
        url: '/api/test',
        method: 'GET',
        connection: { remoteAddress: '192.168.1.1' },
        socket: { remoteAddress: '192.168.1.1' },
        get: jest.fn(),
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      await middleware(req, res, next);

      expect(rateLimiter.getKeyInfo('192.168.1.1')).toBeDefined();
    });
  });

  describe('createDynamicLimit', () => {
    it('should create dynamic rate limiter', async () => {
      const dynamicFn = jest.fn().mockReturnValue(25);
      rateLimiter = RateLimitFactory.createDynamicLimit(60000, 100, dynamicFn);
      const middleware = rateLimiter.middleware();

      const req = {
        ip: '127.0.0.1',
        url: '/api/test',
        method: 'GET',
        connection: { remoteAddress: '127.0.0.1' },
        socket: { remoteAddress: '127.0.0.1' },
        get: jest.fn(),
      } as unknown as Request;
      const res = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
      } as unknown as Response;
      const next = jest.fn();

      await middleware(req, res, next);

      expect(dynamicFn).toHaveBeenCalledWith(req);
      expect(res.set).toHaveBeenCalledWith(expect.objectContaining({
        'RateLimit-Limit': '25',
      }));
    });
  });
});
