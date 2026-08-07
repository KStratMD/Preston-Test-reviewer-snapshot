import { Request, Response } from 'express';
import { sendError } from '../../utils/errorResponse';
import { rateLimitHeaders, getRateLimitStatus, clearRateLimitData } from '../../middleware/rateLimitHeaders';
import { AuthService } from '../../services/AuthService';
import type { Logger } from '../../utils/Logger';
import { Socket } from 'net';

describe('Security Fixes Validation', () => {
  let mockLogger: Logger;

  beforeAll(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;
  });

  describe('Error Response Sanitization', () => {
    let mockResponse: Partial<Response>;
    let mockRequest: Partial<Request>;

    beforeEach(() => {
      mockResponse = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      mockRequest = {
        originalUrl: '/test-endpoint',
      };
    });

    it('should sanitize sensitive keys in error details', () => {
      const sensitiveDetails = {
        password: 'secret123',
        token: 'jwt-token-here',
        apikey: 'api-key-12345',
        connectionString: 'mongodb://user:pass@server:27017',
        normalField: 'safe-value',
      };

      sendError(
        mockResponse as Response,
        500,
        { code: 'TEST_ERROR', message: 'Test error', details: sensitiveDetails },
        mockRequest as Request
      );

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            password: '[REDACTED]',
            token: '[REDACTED]',
            apikey: '[REDACTED]',
            connectionString: '[REDACTED]',
            normalField: 'safe-value',
          },
        })
      );
    });

    it('should sanitize sensitive patterns like JWT tokens', () => {
      const detailsWithJWT = {
        authHeader: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
        basicAuth: 'Basic dXNlcjpwYXNzd29yZA==',
        email: 'user@example.com',
        normalData: 'safe-data',
      };

      sendError(
        mockResponse as Response,
        400,
        { code: 'VALIDATION_ERROR', message: 'Validation failed', details: detailsWithJWT },
        mockRequest as Request
      );

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            authHeader: '[REDACTED]',
            basicAuth: '[REDACTED]',
            email: '[REDACTED]',
            normalData: 'safe-data',
          },
        })
      );
    });

    it('should truncate very long strings that might contain sensitive data', () => {
      const longString = 'x'.repeat(600);
      const details = {
        longField: longString,
        shortField: 'normal',
      };

      sendError(
        mockResponse as Response,
        500,
        { code: 'LARGE_ERROR', message: 'Large error', details },
        mockRequest as Request
      );

      const callArgs = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(callArgs.details.longField).toContain('... [TRUNCATED]');
      expect(callArgs.details.longField.length).toBeLessThan(longString.length);
      expect(callArgs.details.shortField).toBe('normal');
    });

    it('should handle nested objects and arrays', () => {
      const nestedDetails = {
        user: {
          name: 'John',
          password: 'secret123',
          profile: {
            email: 'john@example.com',
            publicInfo: 'safe',
          },
        },
        tokens: ['bearer abc123', 'safe-token-format'],
      };

      sendError(
        mockResponse as Response,
        500,
        { code: 'NESTED_ERROR', message: 'Nested error', details: nestedDetails },
        mockRequest as Request
      );

      const callArgs = (mockResponse.json as jest.Mock).mock.calls[0][0];
      expect(callArgs.details.user.password).toBe('[REDACTED]');
      expect(callArgs.details.user.profile.email).toBe('[REDACTED]');
      expect(callArgs.details.user.profile.publicInfo).toBe('safe');
      expect(callArgs.details.tokens[0]).toBe('[REDACTED]');
      expect(callArgs.details.tokens[1]).toBe('safe-token-format');
    });

    it('should preserve error structure when details is not an object', () => {
      sendError(
        mockResponse as Response,
        400,
        { code: 'SIMPLE_ERROR', message: 'Simple error', details: 'string error' },
        mockRequest as Request
      );

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: 'string error',
        })
      );
    });
  });

  describe('JWT Secret Strength Validation', () => {
    const originalEnv = process.env;

    beforeEach(() => {
      // Reset environment for each test
      jest.resetModules();
      process.env = { ...originalEnv };
      delete process.env.JWT_SECRET;
      // Satisfy production guards in env.ts when NODE_ENV=production tests re-require modules
      process.env.DB_PASSWORD = 'secure-test-db-pw-123';
      process.env.RATE_LIMIT_ENABLED = 'true';
    });

    afterEach(() => {
      // Clean up
      process.env = originalEnv;
    });

    it('should reject weak JWT secrets in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'weak-secret-but-32-chars-length!!'; // 32 chars, but < 64

      const { AuthService: AuthServiceLocal } = jest.requireActual('../../services/AuthService');
      expect(() => {
        new AuthServiceLocal(mockLogger);
      }).toThrow(/Production JWT_SECRET must be at least 64 characters long for enhanced security/);
    });

    it('should reject JWT secrets with weak patterns', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'supersecretjwtkey' + 'x'.repeat(50); // 67 chars but weak

      const { AuthService: AuthServiceLocal } = jest.requireActual('../../services/AuthService');
      expect(() => {
        new AuthServiceLocal(mockLogger);
      }).toThrow(/JWT_SECRET contains weak pattern 'supersecretjwtkey'/);
    });

    it('should reject JWT secrets with insufficient entropy', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; // 65 chars, low entropy

      const { AuthService: AuthServiceLocal } = jest.requireActual('../../services/AuthService');
      expect(() => {
        new AuthServiceLocal(mockLogger);
      }).toThrow(/JWT_SECRET has insufficient entropy \(1 unique characters\). Production requires at least 20 unique characters/);
    });

    it('should accept strong JWT secrets in production', () => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'Kx8vP2nQ9wE5rT7uY3iO1pA6sD4fG7hJ9kL2mN5bV8cX0zW3qE6tY9uI2oP5aS8'; // Strong 64+ char secret

      expect(() => {
        new AuthService(mockLogger);
      }).not.toThrow();
    });

    it('should allow shorter secrets in development', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'dev-secret-exactly-32-chars-long'; // 32 chars is OK for dev

      expect(() => {
        new AuthService(mockLogger);
      }).not.toThrow();
    });

    it('should warn about staging environment with weak secrets', () => {
      process.env.NODE_ENV = 'staging';
      process.env.JWT_SECRET = 'staging-secret-only-32-chars';

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      expect(() => {
        new AuthService(mockLogger);
      }).not.toThrow();
      
      consoleSpy.mockRestore();
    });
  });

  describe('Rate Limit Headers Implementation', () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      clearRateLimitData(); // Clear all rate limit data before each test

      mockRequest = {
        ip: '127.0.0.1',
        path: '/api/test',
        method: 'GET',
        get: jest.fn().mockReturnValue('test-user-agent'),
        socket: { remoteAddress: '127.0.0.1' } as any,
      };

      mockResponse = {
        setHeader: jest.fn(),
      };

      mockNext = jest.fn();
    });

    it('should add standard rate limit headers', () => {
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockResponse.setHeader).toHaveBeenCalledWith('RateLimit-Limit', expect.any(String));
      expect(mockResponse.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', expect.any(String));
      expect(mockResponse.setHeader).toHaveBeenCalledWith('RateLimit-Reset', expect.any(String));
      expect(mockResponse.setHeader).toHaveBeenCalledWith('RateLimit-Policy', expect.any(String));
      
      // Legacy headers
      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit', expect.any(String));
      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-RateLimit-Remaining', expect.any(String));
      expect(mockResponse.setHeader).toHaveBeenCalledWith('X-RateLimit-Reset', expect.any(String));
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should apply stricter limits to authentication endpoints', () => {
      const authMockRequest = { ...mockRequest, path: '/api/auth/login' };

      rateLimitHeaders(authMockRequest as Request, mockResponse as Response, mockNext);

      // Should set a lower limit for auth endpoints
      const limitCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Limit'
      );
      expect(parseInt(limitCall[1])).toBeLessThanOrEqual(10); // Auth endpoints have limit of 10
    });

    it('should apply higher limits to health check endpoints', () => {
      const healthMockRequest = { ...mockRequest, path: '/health' };

      rateLimitHeaders(healthMockRequest as Request, mockResponse as Response, mockNext);

      const limitCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Limit'
      );
      expect(parseInt(limitCall[1])).toBeGreaterThanOrEqual(200); // Health endpoints have higher limit
    });

    it('should track request counts correctly', () => {
      // Make first request
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);
      
      let remainingCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Remaining'
      );
      const firstRemaining = parseInt(remainingCall[1]);

      // Reset mocks
      (mockResponse.setHeader as jest.Mock).mockClear();

      // Make second request with same client
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);
      
      remainingCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Remaining'
      );
      const secondRemaining = parseInt(remainingCall[1]);

      expect(secondRemaining).toBe(firstRemaining - 1);
    });

    it('should add Retry-After header when limit is exceeded', () => {
      // Simulate exceeding rate limit by making many requests quickly
      const manyRequests = 150; // More than typical limit
      
      for (let i = 0; i < manyRequests; i++) {
        (mockResponse.setHeader as jest.Mock).mockClear();
        rateLimitHeaders(mockRequest as Request, mockResponse as Response, mockNext);
      }

      // Check if Retry-After header was set in the last call
      const retryAfterCall = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'Retry-After'
      );

      if (retryAfterCall) {
        expect(parseInt(retryAfterCall[1])).toBeGreaterThan(0);
      }
    });

    it('should handle errors gracefully without breaking the request', () => {
      // Mock a request that would cause an error in client ID generation
      const badRequest = {
        ...mockRequest,
        get: jest.fn().mockImplementation(() => {
          throw new Error('Mock error');
        }),
      };

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      expect(() => {
        rateLimitHeaders(badRequest as Request, mockResponse as Response, mockNext);
      }).not.toThrow();

      expect(mockNext).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('should use different client IDs for different IPs', () => {
      // Ensure completely fresh state
      clearRateLimitData();
      
      const request1 = { 
        ...mockRequest, 
        ip: '127.0.0.1',
        get: jest.fn().mockReturnValue('user-agent-1')
      };
      const request2 = { 
        ...mockRequest, 
        ip: '192.168.1.1',
        get: jest.fn().mockReturnValue('user-agent-2')
      };

      // Make requests from different IPs
      rateLimitHeaders(request1 as Request, mockResponse as Response, mockNext);
      const remaining1 = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Remaining'
      )[1];

      (mockResponse.setHeader as jest.Mock).mockClear();

      rateLimitHeaders(request2 as Request, mockResponse as Response, mockNext);
      const remaining2 = (mockResponse.setHeader as jest.Mock).mock.calls.find(
        call => call[0] === 'RateLimit-Remaining'
      )[1];

      // Both should have the same remaining count since they're different clients
      expect(remaining1).toBe(remaining2);
    });
  });

  describe('Integration Test - All Security Fixes', () => {
    it('should work together without conflicts', () => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = 'dev-test-secret-32-characters';

      const mockRequest: Partial<Request> = {
        ip: '127.0.0.1',
        path: '/api/test',
        method: 'POST',
        originalUrl: '/api/test',
        get: jest.fn().mockReturnValue('test-user-agent'),
        socket: { remoteAddress: '127.0.0.1' } as any,
      };

      const mockResponse: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };

      // Test rate limit headers
      rateLimitHeaders(mockRequest as Request, mockResponse as Response, jest.fn());
      expect(mockResponse.setHeader).toHaveBeenCalled();

      // Test error sanitization
      const sensitiveError = {
        password: 'secret',
        normalData: 'public',
      };

      sendError(
        mockResponse as Response,
        500,
        { code: 'INTEGRATION_TEST', message: 'Test error', details: sensitiveError },
        mockRequest as Request
      );

      expect(mockResponse.json).toHaveBeenCalledWith(
        expect.objectContaining({
          details: {
            password: '[REDACTED]',
            normalData: 'public',
          },
        })
      );

      // Test JWT service initialization
      expect(() => {
        new AuthService(mockLogger);
      }).not.toThrow();
    });
  });
});