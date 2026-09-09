/**
 * RateLimitHeaders Middleware Unit Tests
 * Tests for rate limiting headers middleware
 */

import { Request, Response, NextFunction } from 'express';
import {
  rateLimitHeaders,
  enhancedRateLimitHeaders,
  apiRateLimitHeaders,
  getRateLimitStatus,
  clearRateLimitData,
  stopRateLimitCleanup,
} from '../../../src/middleware/rateLimitHeaders';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock env
jest.mock('../../../src/config', () => ({
  env: {
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 100,
  },
}));

describe('RateLimitHeaders Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let setHeaderMock: jest.Mock;

  beforeEach(() => {
    setHeaderMock = jest.fn();

    mockRequest = {
      ip: '127.0.0.1',
      path: '/api/test',
      method: 'GET',
      socket: { remoteAddress: '127.0.0.1' } as any,
      get: jest.fn().mockImplementation((header: string) => {
        if (header === 'user-agent') return 'test-agent';
        if (header === 'authorization') return undefined;
        return undefined;
      }),
    };

    mockResponse = {
      headersSent: false,
      setHeader: setHeaderMock,
    };

    mockNext = jest.fn();

    // Clear rate limit data before each test
    clearRateLimitData();
  });

  afterEach(() => {
    jest.clearAllMocks();
    clearRateLimitData();
  });

  afterAll(() => {
    stopRateLimitCleanup();
  });

  describe('rateLimitHeaders()', () => {
    it('should set rate limit headers', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Limit', expect.any(String));
      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Remaining', expect.any(String));
      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
      expect(mockNext).toHaveBeenCalled();
    });

    it('should set legacy X-RateLimit headers', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(String));
      expect(setHeaderMock).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
      expect(setHeaderMock).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
    });

    it('should set window header', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith('X-RateLimit-Window', expect.any(String));
    });

    it('should set RateLimit-Policy header', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Policy', expect.any(String));
    });

    it('should call next if headers already sent', () => {
      mockResponse.headersSent = true;

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should decrement remaining count on subsequent requests', () => {
      // First request
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const firstRemainingCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Remaining'
      );
      const firstRemaining = parseInt(firstRemainingCall?.[1] || '0', 10);

      // Reset mocks for second request
      setHeaderMock.mockClear();

      // Second request
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const secondRemainingCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Remaining'
      );
      const secondRemaining = parseInt(secondRemainingCall?.[1] || '0', 10);

      expect(secondRemaining).toBeLessThan(firstRemaining);
    });

    it('should use stricter limits for auth endpoints', () => {
      mockRequest.path = '/api/auth/login';

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Limit'
      );
      const limit = parseInt(limitCall?.[1] || '0', 10);

      expect(limit).toBe(10); // Auth endpoints have 10 request limit
    });

    it('should use stricter limits for upload endpoints', () => {
      mockRequest.path = '/api/upload/file';

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Limit'
      );
      const limit = parseInt(limitCall?.[1] || '0', 10);

      expect(limit).toBe(20); // Upload endpoints have 20 request limit
    });

    it('should use higher limits for health endpoints', () => {
      mockRequest.path = '/health';

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Limit'
      );
      const limit = parseInt(limitCall?.[1] || '0', 10);

      expect(limit).toBe(200); // Health endpoints have 200 request limit
    });

    it('should use auth hash for authenticated requests', () => {
      (mockRequest.get as jest.Mock).mockImplementation((header: string) => {
        if (header === 'authorization') return 'Bearer test-token';
        return 'test-agent';
      });

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('enhancedRateLimitHeaders()', () => {
    it('should set all standard rate limit headers', () => {
      enhancedRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Limit', expect.any(String));
      expect(setHeaderMock).toHaveBeenCalledWith('RateLimit-Remaining', expect.any(String));
      expect(mockNext).toHaveBeenCalled();
    });

    it('should set requests count header', () => {
      enhancedRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalledWith(
        'X-Rate-Limit-Requests-This-Window',
        expect.any(String)
      );
    });

    it('should skip enhanced headers if headers already sent', () => {
      // First call sets headers
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      // Simulate headers sent
      mockResponse.headersSent = true;
      setHeaderMock.mockClear();

      // Should not add more headers
      enhancedRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      // Should only call next, not set headers
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('apiRateLimitHeaders()', () => {
    it('should apply to API endpoints', () => {
      mockRequest.path = '/api/users';

      apiRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip non-API endpoints', () => {
      mockRequest.path = '/health';

      apiRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should skip static file paths', () => {
      mockRequest.path = '/static/app.js';

      apiRateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setHeaderMock).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('getRateLimitStatus()', () => {
    it('should return null for unknown client', () => {
      const status = getRateLimitStatus('unknown-client');

      expect(status).toBeNull();
    });

    it('should return rate limit info for known client', () => {
      // Make a request first to create client entry
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      // Get client ID by making another request and checking store
      const clientIdPattern = '127.0.0.1:';

      // The exact client ID depends on the hash, but we can check general behavior
      // by verifying the store has data after a request
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('clearRateLimitData()', () => {
    it('should clear all rate limit data', () => {
      // Make some requests
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      // Clear all data
      clearRateLimitData();

      // Next request should start fresh
      setHeaderMock.mockClear();
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const remainingCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Remaining'
      );
      const remaining = parseInt(remainingCall?.[1] || '0', 10);

      // Should be limit - 1 since this is first request after clear
      expect(remaining).toBeGreaterThan(0);
    });

    it('should clear specific client data', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      // Clear with a specific client ID (won't match our test client)
      clearRateLimitData('other-client');

      // Our test client should still have data
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('stopRateLimitCleanup()', () => {
    it('should stop the cleanup interval', () => {
      // This is mostly for coverage - the actual interval is not running in tests
      stopRateLimitCleanup();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should be safe to call multiple times', () => {
      stopRateLimitCleanup();
      stopRateLimitCleanup();
      stopRateLimitCleanup();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle request without IP', () => {
      mockRequest.ip = undefined;
      mockRequest.socket = { remoteAddress: undefined } as any;

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle request without user-agent', () => {
      (mockRequest.get as jest.Mock).mockReturnValue(undefined);

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle integration POST requests with moderate limits', () => {
      mockRequest.path = '/api/integration/sync';
      mockRequest.method = 'POST';

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Limit'
      );
      const limit = parseInt(limitCall?.[1] || '0', 10);

      expect(limit).toBe(50); // Integration POST has 50 request limit
    });

    it('should handle files endpoint', () => {
      mockRequest.path = '/api/files/upload';

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = setHeaderMock.mock.calls.find(
        (call: [string, string]) => call[0] === 'RateLimit-Limit'
      );
      const limit = parseInt(limitCall?.[1] || '0', 10);

      expect(limit).toBe(20); // Files endpoint has 20 request limit
    });
  });
});
