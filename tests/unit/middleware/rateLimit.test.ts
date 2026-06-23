/**
 * RateLimit Middleware Unit Tests
 * Tests for rate limiting middleware and utilities
 */

import { Request, Response, NextFunction } from 'express';
import {
  globalRateLimit,
  authRateLimit,
  apiRateLimit,
  integrationRateLimit,
  configRateLimit,
  rateLimitHeaders,
  getRateLimitInfo,
} from '../../../src/middleware/rateLimit';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('RateLimit Middleware', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let setMock: jest.Mock;

  beforeEach(() => {
    setMock = jest.fn();
    mockRequest = {
      ip: '127.0.0.1',
      path: '/api/test',
      method: 'GET',
      user: undefined,
      connection: { remoteAddress: '127.0.0.1' } as any,
      headers: {},
      get: jest.fn().mockReturnValue('test-agent'),
    };

    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      set: setMock,
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Rate Limiter Exports', () => {
    it('should export globalRateLimit', () => {
      expect(globalRateLimit).toBeDefined();
      expect(typeof globalRateLimit).toBe('function');
    });

    it('should export authRateLimit', () => {
      expect(authRateLimit).toBeDefined();
      expect(typeof authRateLimit).toBe('function');
    });

    it('should export apiRateLimit', () => {
      expect(apiRateLimit).toBeDefined();
      expect(typeof apiRateLimit).toBe('function');
    });

    it('should export integrationRateLimit', () => {
      expect(integrationRateLimit).toBeDefined();
      expect(typeof integrationRateLimit).toBe('function');
    });

    it('should export configRateLimit', () => {
      expect(configRateLimit).toBeDefined();
      expect(typeof configRateLimit).toBe('function');
    });
  });

  describe('rateLimitHeaders()', () => {
    it('should set rate limit headers when rateLimit info exists', () => {
      mockRequest.rateLimit = {
        limit: 100,
        used: 10,
        remaining: 90,
        resetTime: Date.now() + 60000,
      };

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Used': '10',
          'X-RateLimit-Remaining': '90',
        })
      );
      expect(mockNext).toHaveBeenCalled();
    });

    it('should not set headers when rateLimit info is missing', () => {
      mockRequest.rateLimit = undefined;

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setMock).not.toHaveBeenCalled();
      expect(mockNext).toHaveBeenCalled();
    });

    it('should call next even when headers are set', () => {
      mockRequest.rateLimit = {
        limit: 50,
        used: 5,
        remaining: 45,
        resetTime: Date.now() + 30000,
      };

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle invalid reset time', () => {
      mockRequest.rateLimit = {
        limit: 100,
        used: 10,
        remaining: 90,
        resetTime: NaN,
      };

      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(setMock).toHaveBeenCalledWith(
        expect.objectContaining({
          'X-RateLimit-Limit': '100',
          'X-RateLimit-Used': '10',
          'X-RateLimit-Remaining': '90',
          'X-RateLimit-Reset': undefined,
        })
      );
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('getRateLimitInfo()', () => {
    it('should extract rate limit info from request', () => {
      const futureTime = Date.now() + 60000;
      mockRequest.rateLimit = {
        limit: 100,
        used: 25,
        remaining: 75,
        resetTime: futureTime,
      };

      const info = getRateLimitInfo(mockRequest as Request);

      expect(info.limit).toBe(100);
      expect(info.used).toBe(25);
      expect(info.remaining).toBe(75);
      expect(info.resetTime).toBeInstanceOf(Date);
      expect(info.resetTime?.getTime()).toBe(futureTime);
    });

    it('should return undefined values when rateLimit is missing', () => {
      mockRequest.rateLimit = undefined;

      const info = getRateLimitInfo(mockRequest as Request);

      expect(info.limit).toBeUndefined();
      expect(info.used).toBeUndefined();
      expect(info.remaining).toBeUndefined();
      expect(info.resetTime).toBeNull();
    });

    it('should handle NaN reset time', () => {
      mockRequest.rateLimit = {
        limit: 100,
        used: 10,
        remaining: 90,
        resetTime: NaN,
      };

      const info = getRateLimitInfo(mockRequest as Request);

      expect(info.resetTime).toBeNull();
    });

    it('should handle zero values', () => {
      mockRequest.rateLimit = {
        limit: 100,
        used: 100,
        remaining: 0,
        resetTime: Date.now(),
      };

      const info = getRateLimitInfo(mockRequest as Request);

      expect(info.limit).toBe(100);
      expect(info.used).toBe(100);
      expect(info.remaining).toBe(0);
    });
  });

  describe('Rate Limiter Configurations', () => {
    describe('globalRateLimit', () => {
      it('should be a middleware function', () => {
        expect(typeof globalRateLimit).toBe('function');
        expect(globalRateLimit.length).toBe(3); // req, res, next
      });
    });

    describe('authRateLimit', () => {
      it('should be a middleware function', () => {
        expect(typeof authRateLimit).toBe('function');
        expect(authRateLimit.length).toBe(3);
      });
    });

    describe('apiRateLimit', () => {
      it('should be a middleware function', () => {
        expect(typeof apiRateLimit).toBe('function');
        expect(apiRateLimit.length).toBe(3);
      });
    });

    describe('integrationRateLimit', () => {
      it('should be a middleware function', () => {
        expect(typeof integrationRateLimit).toBe('function');
        expect(integrationRateLimit.length).toBe(3);
      });
    });

    describe('configRateLimit', () => {
      it('should be a middleware function', () => {
        expect(typeof configRateLimit).toBe('function');
        expect(configRateLimit.length).toBe(3);
      });
    });
  });
});
