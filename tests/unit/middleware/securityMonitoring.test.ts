/**
 * SecurityMonitoring Middleware Unit Tests
 * Tests for security monitoring middleware functions
 */

import type { Request, Response, NextFunction } from 'express';
import {
  setSecurityMonitorInstance,
  monitorAuthentication,
  monitorAuthorization,
  monitorRateLimit,
  monitorMaliciousPayloads,
  monitorAPIAbuse,
  blockQuarantinedIPs,
  createSecurityMonitoringMiddleware,
  monitorConfigurationChanges,
} from '../../../src/middleware/securityMonitoring';
import type { SecurityMonitor } from '../../../src/services/SecurityMonitor';

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

describe('SecurityMonitoring Middleware', () => {
  let mockSecurityMonitor: jest.Mocked<SecurityMonitor>;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    mockSecurityMonitor = {
      recordEvent: jest.fn(),
      isIPQuarantined: jest.fn().mockReturnValue(false),
      getSecurityReport: jest.fn(),
      getRecentEvents: jest.fn(),
      quarantineIP: jest.fn(),
    } as any;

    setSecurityMonitorInstance(mockSecurityMonitor);

    mockReq = {
      user: {
        id: 'user-123',
        roles: ['user'],
      },
      path: '/api/test',
      method: 'GET',
      ip: '127.0.0.1',
      body: {},
      headers: {},
      params: {},
      get: jest.fn().mockReturnValue('Mozilla/5.0'),
    } as any;

    const originalJson = jest.fn().mockReturnThis();
    mockRes = {
      status: jest.fn().mockReturnThis(),
      json: originalJson,
      statusCode: 200,
    };

    mockNext = jest.fn();
  });

  describe('setSecurityMonitorInstance()', () => {
    it('should set the security monitor instance', () => {
      expect(() => setSecurityMonitorInstance(mockSecurityMonitor)).not.toThrow();
    });
  });

  describe('monitorAuthentication()', () => {
    it('should call next for all requests', () => {
      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should record authentication failure on 401', () => {
      mockRes.statusCode = 401;

      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      // Trigger the wrapped json function
      (mockRes.json as Function)({ error: 'Unauthorized' });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'authentication_failure',
          severity: 'medium',
        })
      );
    });

    it('should record authentication failure on 403', () => {
      mockRes.statusCode = 403;

      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ error: 'Forbidden' });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'authentication_failure',
        })
      );
    });

    it('should detect suspicious user agent on auth success', () => {
      mockRes.statusCode = 200;
      mockReq.path = '/auth/login';
      (mockReq.get as jest.Mock).mockReturnValue('curl'); // Short user agent

      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ success: true });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          details: expect.objectContaining({
            reason: 'Suspicious user agent in authentication',
          }),
        })
      );
    });

    it('should not record event for normal successful requests', () => {
      mockRes.statusCode = 200;
      mockReq.path = '/api/data';

      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ data: 'test' });

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      mockSecurityMonitor.recordEvent.mockImplementation(() => {
        throw new Error('Monitor error');
      });
      mockRes.statusCode = 401;

      const middleware = monitorAuthentication();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(() => (mockRes.json as Function)({})).not.toThrow();
    });
  });

  describe('monitorAuthorization()', () => {
    it('should record authorization failure on 403', () => {
      mockRes.statusCode = 403;

      const middleware = monitorAuthorization();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ error: 'Forbidden' });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'authorization_failure',
          severity: 'medium',
        })
      );
    });

    it('should not record event for successful requests', () => {
      mockRes.statusCode = 200;

      const middleware = monitorAuthorization();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ data: 'test' });

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });

    it('should include user roles in event details', () => {
      mockRes.statusCode = 403;
      mockReq.user = { id: 'user-123', roles: ['user', 'editor'] } as any;

      const middleware = monitorAuthorization();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ error: 'Forbidden' });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            userRoles: ['user', 'editor'],
          }),
        })
      );
    });
  });

  describe('monitorRateLimit()', () => {
    it('should record rate limit exceeded on 429', () => {
      mockRes.statusCode = 429;

      const middleware = monitorRateLimit();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ error: 'Rate limit exceeded' });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'rate_limit_exceeded',
          severity: 'high',
        })
      );
    });

    it('should not record event for normal requests', () => {
      mockRes.statusCode = 200;

      const middleware = monitorRateLimit();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ data: 'test' });

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });
  });

  describe('monitorMaliciousPayloads()', () => {
    it('should detect SQL injection in body', () => {
      mockReq.body = { query: 'SELECT * FROM users; DROP TABLE users;' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'injection_attempt',
          severity: 'critical',
          details: expect.objectContaining({
            attackType: 'SQL Injection',
          }),
        })
      );
    });

    it('should detect UNION SELECT injection', () => {
      mockReq.body = { input: '1 UNION SELECT * FROM passwords' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'injection_attempt',
        })
      );
    });

    it('should detect XSS in body', () => {
      mockReq.body = { comment: '<script>alert("xss")</script>' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'xss_attempt',
          severity: 'high',
          details: expect.objectContaining({
            attackType: 'Cross-Site Scripting (XSS)',
          }),
        })
      );
    });

    it('should detect javascript: protocol XSS', () => {
      mockReq.body = { url: 'javascript:alert(1)' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'xss_attempt',
        })
      );
    });

    it('should detect on-event handler XSS', () => {
      mockReq.body = { input: '<img onerror=alert(1)>' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'xss_attempt',
        })
      );
    });

    it('should detect large file uploads to unexpected endpoints', () => {
      mockReq.headers = {
        'content-type': 'multipart/form-data',
        'content-length': '200000000', // 200MB
      };
      mockReq.path = '/api/data';

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          details: expect.objectContaining({
            reason: 'Large file upload to unexpected endpoint',
          }),
        })
      );
    });

    it('should allow large uploads to upload endpoints', () => {
      mockReq.headers = {
        'content-type': 'multipart/form-data',
        'content-length': '200000000',
      };
      mockReq.path = '/api/upload/files';
      mockReq.body = {};

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      // Should not record suspicious activity for upload endpoint
      const suspiciousCalls = mockSecurityMonitor.recordEvent.mock.calls.filter(
        call => call[0].type === 'suspicious_activity'
      );
      expect(suspiciousCalls.length).toBe(0);
    });

    it('should not record event for normal payloads', () => {
      mockReq.body = { name: 'John Doe', email: 'john@example.com' };

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });

    it('should handle null body', () => {
      mockReq.body = null;

      const middleware = monitorMaliciousPayloads();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      mockReq.body = { test: 'data' };
      mockSecurityMonitor.recordEvent.mockImplementation(() => {
        throw new Error('Monitor error');
      });

      const middleware = monitorMaliciousPayloads();

      expect(() => middleware(mockReq as Request, mockRes as Response, mockNext)).not.toThrow();
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('monitorAPIAbuse()', () => {
    it('should detect unauthenticated automation tools', () => {
      (mockReq.get as jest.Mock).mockReturnValue('curl/7.64.1');
      mockReq.user = undefined;
      mockReq.path = '/api/data';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'api_abuse',
          details: expect.objectContaining({
            reason: 'Automated tool detected without authentication',
          }),
        })
      );
    });

    it('should detect Python requests library', () => {
      (mockReq.get as jest.Mock).mockReturnValue('python-requests/2.25.1');
      mockReq.user = undefined;
      mockReq.path = '/api/data';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'api_abuse',
        })
      );
    });

    it('should allow automation tools with authentication', () => {
      (mockReq.get as jest.Mock).mockReturnValue('curl/7.64.1');
      mockReq.user = { id: 'user-123' } as any;

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      const abuseCalls = mockSecurityMonitor.recordEvent.mock.calls.filter(
        call => call[0].type === 'api_abuse'
      );
      expect(abuseCalls.length).toBe(0);
    });

    it('should allow automation for health endpoints', () => {
      (mockReq.get as jest.Mock).mockReturnValue('curl/7.64.1');
      mockReq.user = undefined;
      mockReq.path = '/health/check';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      const abuseCalls = mockSecurityMonitor.recordEvent.mock.calls.filter(
        call => call[0].type === 'api_abuse'
      );
      expect(abuseCalls.length).toBe(0);
    });

    it('should flag access to sensitive endpoints', () => {
      mockReq.path = '/admin/settings';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
          details: expect.objectContaining({
            reason: 'Access to sensitive endpoint',
          }),
        })
      );
    });

    it('should flag access to config endpoints', () => {
      mockReq.path = '/config/database';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
        })
      );
    });

    it('should flag access to .env file', () => {
      mockReq.path = '/.env';

      const middleware = monitorAPIAbuse();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'suspicious_activity',
        })
      );
    });
  });

  describe('blockQuarantinedIPs()', () => {
    it('should block quarantined IPs', () => {
      mockSecurityMonitor.isIPQuarantined.mockReturnValue(true);

      const middleware = blockQuarantinedIPs();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Access Denied',
          code: 'IP_QUARANTINED',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should allow non-quarantined IPs', () => {
      mockSecurityMonitor.isIPQuarantined.mockReturnValue(false);

      const middleware = blockQuarantinedIPs();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalled();
    });

    it('should handle errors gracefully', () => {
      mockSecurityMonitor.isIPQuarantined.mockImplementation(() => {
        throw new Error('Monitor error');
      });

      const middleware = blockQuarantinedIPs();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('createSecurityMonitoringMiddleware()', () => {
    it('should return array of middleware functions', () => {
      const middlewareStack = createSecurityMonitoringMiddleware();

      expect(Array.isArray(middlewareStack)).toBe(true);
      expect(middlewareStack.length).toBe(6);
      middlewareStack.forEach(mw => {
        expect(typeof mw).toBe('function');
      });
    });
  });

  describe('monitorConfigurationChanges()', () => {
    it('should record configuration changes on success', () => {
      mockReq.path = '/api/config/settings';
      mockReq.method = 'PUT';
      mockReq.params = { id: 'setting-123' };
      mockRes.statusCode = 200;

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ success: true });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'configuration_change',
          severity: 'medium',
          details: expect.objectContaining({
            method: 'PUT',
            resourceId: 'setting-123',
          }),
        })
      );
    });

    it('should record integration changes', () => {
      mockReq.path = '/api/integrations/salesforce';
      mockReq.method = 'POST';
      mockRes.statusCode = 201;

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ success: true });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'configuration_change',
        })
      );
    });

    it('should record DELETE operations', () => {
      mockReq.path = '/api/config/feature-flags';
      mockReq.method = 'DELETE';
      mockRes.statusCode = 204;

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ deleted: true });

      expect(mockSecurityMonitor.recordEvent).toHaveBeenCalled();
    });

    it('should not record GET requests', () => {
      mockReq.path = '/api/config/settings';
      mockReq.method = 'GET';

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ data: {} });

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });

    it('should not record failed changes', () => {
      mockReq.path = '/api/config/settings';
      mockReq.method = 'PUT';
      mockRes.statusCode = 500;

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      (mockRes.json as Function)({ error: 'Failed' });

      expect(mockSecurityMonitor.recordEvent).not.toHaveBeenCalled();
    });

    it('should not wrap json for non-config endpoints', () => {
      mockReq.path = '/api/users';
      mockReq.method = 'POST';
      const originalJson = mockRes.json;

      const middleware = monitorConfigurationChanges();
      middleware(mockReq as Request, mockRes as Response, mockNext);

      // json should not be wrapped
      expect(mockRes.json).toBe(originalJson);
    });
  });
});
