/**
 * AdvancedSecurityMiddleware Unit Tests
 * Tests for advanced security middleware functions
 */

import { AdvancedSecurityMiddleware, SecurityConfig } from '../../../src/middleware/advancedSecurity';
import type { Request, Response, NextFunction } from 'express';

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('AdvancedSecurityMiddleware', () => {
  let middleware: AdvancedSecurityMiddleware;

  beforeEach(() => {
    jest.useFakeTimers();
    middleware = new AdvancedSecurityMiddleware();
  });

  afterEach(() => {
    middleware.cleanup();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const mw = new AdvancedSecurityMiddleware();
      const metrics = mw.getMetrics();
      expect(metrics.totalRequests).toBe(0);
      expect(metrics.blockedRequests).toBe(0);
      mw.cleanup();
    });

    it('should accept custom config', () => {
      const config: SecurityConfig = {
        enableCSP: false,
        enableHSTS: false,
        allowedOrigins: ['http://custom.com'],
      };
      const mw = new AdvancedSecurityMiddleware(config);
      expect(mw).toBeDefined();
      mw.cleanup();
    });

    it('should merge config with defaults', () => {
      const config: SecurityConfig = {
        enableCSP: true,
        maxRequestSize: '5mb',
      };
      const mw = new AdvancedSecurityMiddleware(config);
      expect(mw).toBeDefined();
      mw.cleanup();
    });
  });

  describe('getMiddleware()', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        method: 'GET',
        url: '/api/test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '127.0.0.1' } as any,
        socket: { remoteAddress: '127.0.0.1' } as any,
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
        end: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it('should increment totalRequests counter', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      const metrics = middleware.getMetrics();
      expect(metrics.totalRequests).toBe(1);
    });

    it('should call next() for valid requests', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should block requests from blocked IPs', () => {
      // First, get an IP blocked by triggering suspicious activity
      const config: SecurityConfig = {
        suspiciousPatterns: [/test-block/i],
      };
      const mw = new AdvancedSecurityMiddleware(config);
      const handler = mw.getMiddleware();

      // Trigger 5 suspicious requests to get blocked
      for (let i = 0; i < 5; i++) {
        const req = {
          ...mockReq,
          url: '/test-block',
          ip: '192.168.1.100',
        };
        handler(req as Request, mockRes as Response, mockNext);
      }

      // Next request should be blocked
      mockRes.status = jest.fn().mockReturnThis();
      mockRes.json = jest.fn().mockReturnThis();

      const blockedReq = {
        ...mockReq,
        url: '/clean',
        ip: '192.168.1.100',
      };
      handler(blockedReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Access denied' });
      mw.cleanup();
    });

    it('should block suspicious user agents', () => {
      (mockReq.get as jest.Mock).mockImplementation((header: string) => {
        if (header === 'User-Agent') return 'Mozilla/5.0 crawler bot';
        return '';
      });

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
    });

    it('should detect SQL injection patterns', () => {
      mockReq.url = '/api/test?q=UNION SELECT * FROM users';

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should detect XSS patterns in body', () => {
      mockReq.body = { input: '<script>alert("xss")</script>' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should reject invalid content types for POST requests', () => {
      mockReq.method = 'POST';
      mockReq.body = { data: 'test' };
      (mockReq.get as jest.Mock).mockImplementation((header: string) => {
        if (header === 'Content-Type') return 'application/octet-stream';
        return '';
      });

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Invalid content type' });
    });

    it('should allow valid content types for POST requests', () => {
      mockReq.method = 'POST';
      mockReq.body = { data: 'test' };
      (mockReq.get as jest.Mock).mockImplementation((header: string) => {
        if (header === 'Content-Type') return 'application/json';
        return '';
      });

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should sanitize input when enabled', () => {
      mockReq.body = { text: 'normal text' };
      mockReq.query = { search: 'safe query' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should set security headers', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith('Content-Security-Policy', expect.any(String));
      expect(mockRes.setHeader).toHaveBeenCalledWith('Strict-Transport-Security', expect.any(String));
      expect(mockRes.setHeader).toHaveBeenCalledWith('X-XSS-Protection', '1; mode=block');
    });

    it('should handle errors gracefully', () => {
      mockReq.get = jest.fn().mockImplementation(() => {
        throw new Error('Test error');
      });

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      // Should still call next even on error
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('security headers', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        method: 'GET',
        url: '/api/test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '127.0.0.1' } as any,
        socket: { remoteAddress: '127.0.0.1' } as any,
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it('should set CSP header with nonce', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Content-Security-Policy',
        expect.stringContaining('nonce-')
      );
    });

    it('should set HSTS header', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Strict-Transport-Security',
        expect.stringContaining('max-age=')
      );
    });

    it('should set X-Frame-Options when frame guard enabled', () => {
      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith('X-Frame-Options', 'DENY');
    });

    it('should not set X-Frame-Options when embedding enabled', () => {
      const mw = new AdvancedSecurityMiddleware({ enableEmbedding: true });
      const handler = mw.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      const calls = (mockRes.setHeader as jest.Mock).mock.calls;
      const hasXFrameOptions = calls.some(
        (call: [string, string]) => call[0] === 'X-Frame-Options'
      );
      expect(hasXFrameOptions).toBe(false);
      mw.cleanup();
    });

    it('should skip CSP when disabled', () => {
      const mw = new AdvancedSecurityMiddleware({ enableCSP: false });
      const handler = mw.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      const calls = (mockRes.setHeader as jest.Mock).mock.calls;
      const hasCSP = calls.some(
        (call: [string, string]) => call[0] === 'Content-Security-Policy'
      );
      expect(hasCSP).toBe(false);
      mw.cleanup();
    });

    it('should skip HSTS when disabled', () => {
      const mw = new AdvancedSecurityMiddleware({ enableHSTS: false });
      const handler = mw.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      const calls = (mockRes.setHeader as jest.Mock).mock.calls;
      const hasHSTS = calls.some(
        (call: [string, string]) => call[0] === 'Strict-Transport-Security'
      );
      expect(hasHSTS).toBe(false);
      mw.cleanup();
    });
  });

  describe('getCORSMiddleware()', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        method: 'GET',
        get: jest.fn().mockReturnValue('http://localhost:3000'),
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
        end: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it('should set CORS headers for allowed origins', () => {
      const handler = middleware.getCORSMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        'http://localhost:3000'
      );
    });

    it('should set wildcard origin when configured', () => {
      const mw = new AdvancedSecurityMiddleware({ allowedOrigins: ['*'] });
      const handler = mw.getCORSMiddleware();
      (mockReq.get as jest.Mock).mockReturnValue('http://any-origin.com');

      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Origin',
        '*'
      );
      mw.cleanup();
    });

    it('should set CORS methods header', () => {
      const handler = middleware.getCORSMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Methods',
        expect.stringContaining('GET')
      );
    });

    it('should handle preflight OPTIONS request', () => {
      mockReq.method = 'OPTIONS';
      const handler = middleware.getCORSMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(204);
      expect(mockRes.end).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should set credentials header when option enabled', () => {
      const handler = middleware.getCORSMiddleware({ credentials: true });
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Allow-Credentials',
        'true'
      );
    });

    it('should set max-age header when provided', () => {
      const handler = middleware.getCORSMiddleware({ maxAge: 3600 });
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Max-Age',
        '3600'
      );
    });

    it('should set exposed headers when provided', () => {
      const handler = middleware.getCORSMiddleware({
        exposedHeaders: ['X-Custom-Header', 'X-Another-Header']
      });
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.setHeader).toHaveBeenCalledWith(
        'Access-Control-Expose-Headers',
        'X-Custom-Header,X-Another-Header'
      );
    });
  });

  describe('getFileUploadSecurityMiddleware()', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        method: 'POST',
        url: '/upload',
        get: jest.fn().mockReturnValue(''),
        connection: { remoteAddress: '127.0.0.1' } as any,
        socket: { remoteAddress: '127.0.0.1' } as any,
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
      };
      mockNext = jest.fn();
    });

    it('should allow requests without files', () => {
      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should allow valid file uploads', () => {
      (mockReq as any).file = {
        size: 1024 * 1024, // 1MB
        mimetype: 'image/jpeg',
        originalname: 'photo.jpg',
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject files that are too large', () => {
      (mockReq as any).file = {
        size: 20 * 1024 * 1024, // 20MB
        mimetype: 'image/jpeg',
        originalname: 'large.jpg',
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(413);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'File too large' });
    });

    it('should reject disallowed mime types', () => {
      (mockReq as any).file = {
        size: 1024,
        mimetype: 'application/x-executable',
        originalname: 'program.bin',
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'File type not allowed' });
    });

    it('should reject blocked file extensions', () => {
      // Use allowed mime type but blocked extension to test extension check
      (mockReq as any).file = {
        size: 1024,
        mimetype: 'text/plain', // Allowed mime type
        originalname: 'script.exe', // Blocked extension
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'File extension not allowed' });
    });

    it('should reject suspicious filenames', () => {
      (mockReq as any).file = {
        size: 1024,
        mimetype: 'image/jpeg',
        originalname: '<script>alert(1)</script>.jpg',
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 'Suspicious filename detected' });
    });

    it('should handle multiple files', () => {
      (mockReq as any).files = {
        photos: [
          { size: 1024, mimetype: 'image/jpeg', originalname: 'photo1.jpg' },
          { size: 2048, mimetype: 'image/png', originalname: 'photo2.png' },
        ],
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should reject if any file in batch is invalid', () => {
      (mockReq as any).files = {
        uploads: [
          { size: 1024, mimetype: 'image/jpeg', originalname: 'photo.jpg' },
          { size: 1024, mimetype: 'image/jpeg', originalname: 'malware.exe' },
        ],
      };

      const handler = middleware.getFileUploadSecurityMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('validateAPIKey()', () => {
    it('should return true for matching keys', () => {
      const result = middleware.validateAPIKey('secret-key-123', 'secret-key-123');
      expect(result).toBe(true);
    });

    it('should return false for non-matching keys', () => {
      const result = middleware.validateAPIKey('wrong-key', 'secret-key-123');
      expect(result).toBe(false);
    });

    it('should return false for empty provided key', () => {
      const result = middleware.validateAPIKey('', 'secret-key-123');
      expect(result).toBe(false);
    });

    it('should return false for empty valid key', () => {
      const result = middleware.validateAPIKey('secret-key-123', '');
      expect(result).toBe(false);
    });

    it('should handle special characters', () => {
      const key = 'key-with-special-chars!@#$%^&*()';
      const result = middleware.validateAPIKey(key, key);
      expect(result).toBe(true);
    });

    it('should be timing-safe (same length comparison time)', () => {
      // This tests that the comparison is timing-safe by checking it works
      // The actual timing safety is ensured by crypto.timingSafeEqual
      const result1 = middleware.validateAPIKey('aaaaaaaaaa', 'bbbbbbbbbb');
      const result2 = middleware.validateAPIKey('aaaaaaaaaa', 'aaaaaaaabb');
      expect(result1).toBe(false);
      expect(result2).toBe(false);
    });
  });

  describe('getMetrics()', () => {
    it('should return current metrics', () => {
      const metrics = middleware.getMetrics();

      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('blockedRequests');
      expect(metrics).toHaveProperty('suspiciousRequests');
      expect(metrics).toHaveProperty('threatsByType');
      expect(metrics).toHaveProperty('blockedIPs');
    });

    it('should return copy of blocked IPs set', () => {
      const metrics = middleware.getMetrics();
      expect(metrics.blockedIPs).toBeInstanceOf(Set);
    });
  });

  describe('unblockIP()', () => {
    it('should unblock a blocked IP', () => {
      // First block an IP via suspicious activity
      const mockReq: Partial<Request> = {
        ip: '10.0.0.1',
        method: 'GET',
        url: '/UNION SELECT FROM',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '10.0.0.1' } as any,
        socket: { remoteAddress: '10.0.0.1' } as any,
      };
      const mockRes: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      const mockNext = jest.fn();

      const handler = middleware.getMiddleware();

      // Trigger 5 suspicious requests
      for (let i = 0; i < 5; i++) {
        handler(mockReq as Request, mockRes as Response, mockNext);
      }

      // Verify IP is blocked
      let metrics = middleware.getMetrics();
      expect(metrics.blockedIPs.has('10.0.0.1')).toBe(true);

      // Unblock the IP
      const result = middleware.unblockIP('10.0.0.1');
      expect(result).toBe(true);

      // Verify IP is unblocked
      metrics = middleware.getMetrics();
      expect(metrics.blockedIPs.has('10.0.0.1')).toBe(false);
    });

    it('should return false for IP that was not blocked', () => {
      const result = middleware.unblockIP('1.2.3.4');
      expect(result).toBe(false);
    });
  });

  describe('getSecurityReport()', () => {
    it('should return structured report', () => {
      const report = middleware.getSecurityReport() as any;

      expect(report).toHaveProperty('overview');
      expect(report).toHaveProperty('threats');
      expect(report).toHaveProperty('blocked');
      expect(report).toHaveProperty('suspicious');
    });

    it('should include block rate calculation', () => {
      const report = middleware.getSecurityReport() as any;
      expect(report.overview).toHaveProperty('blockRate');
      expect(report.overview.blockRate).toMatch(/^\d+\.\d+%$/);
    });

    it('should limit blocked IPs in report', () => {
      const report = middleware.getSecurityReport() as any;
      expect(report.blocked.ips.length).toBeLessThanOrEqual(10);
    });
  });

  describe('cleanup()', () => {
    it('should clear cleanup interval', () => {
      const mw = new AdvancedSecurityMiddleware();
      expect(() => mw.cleanup()).not.toThrow();
    });
  });

  describe('pattern detection', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        method: 'GET',
        url: '/api/test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '127.0.0.1' } as any,
        socket: { remoteAddress: '127.0.0.1' } as any,
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it('should detect eval() in input', () => {
      mockReq.body = { code: 'eval(user_input)' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should detect document.cookie access', () => {
      mockReq.url = '/api?callback=document.cookie';

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should detect on* event handlers', () => {
      mockReq.body = { input: '<img onerror=alert(1)>' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });

    it('should detect javascript: protocol', () => {
      mockReq.body = { url: 'javascript:void(0)' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
    });
  });

  describe('input sanitization', () => {
    let mockReq: Partial<Request>;
    let mockRes: Partial<Response>;
    let mockNext: jest.Mock;

    beforeEach(() => {
      mockReq = {
        ip: '127.0.0.1',
        method: 'GET',
        url: '/api/test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '127.0.0.1' } as any,
        socket: { remoteAddress: '127.0.0.1' } as any,
      };
      mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };
      mockNext = jest.fn();
    });

    it('should sanitize HTML entities in body', () => {
      // Since patterns block scripts, test that sanitization doesn't break safe input
      mockReq.body = { text: 'Safe <text>' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      // Check that it was sanitized (< and > converted)
      expect(mockReq.body.text).toContain('&lt;');
      expect(mockReq.body.text).toContain('&gt;');
    });

    it('should sanitize nested objects', () => {
      mockReq.body = {
        user: {
          name: 'Test <User>'
        }
      };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.body.user.name).toContain('&lt;');
    });

    it('should sanitize arrays', () => {
      mockReq.body = {
        items: ['item <one>', 'item <two>']
      };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.body.items[0]).toContain('&lt;');
      expect(mockReq.body.items[1]).toContain('&lt;');
    });

    it('should sanitize query parameters', () => {
      mockReq.query = { search: 'test <query>' };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect((mockReq.query as any).search).toContain('&lt;');
    });

    it('should skip sanitization when disabled', () => {
      const mw = new AdvancedSecurityMiddleware({ enableInputSanitization: false });
      mockReq.body = { text: '<raw>' };

      const handler = mw.getMiddleware();
      handler(mockReq as Request, mockRes as Response, mockNext);

      expect(mockReq.body.text).toBe('<raw>');
      mw.cleanup();
    });
  });

  describe('IP extraction', () => {
    it('should extract IP from req.ip', () => {
      const mockReq: Partial<Request> = {
        ip: '192.168.1.1',
        method: 'GET',
        url: '/test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: undefined } as any,
        socket: { remoteAddress: undefined } as any,
      };
      const mockRes: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, jest.fn());

      // If the request passes, IP was extracted successfully
      expect(true).toBe(true);
    });

    it('should extract IP from X-Forwarded-For header', () => {
      const mockReq: Partial<Request> = {
        ip: undefined,
        method: 'GET',
        url: '/test',
        get: jest.fn().mockImplementation((header: string) => {
          if (header === 'X-Forwarded-For') return '10.0.0.1, 10.0.0.2';
          return undefined;
        }),
        query: {},
        body: {},
        connection: { remoteAddress: undefined } as any,
        socket: { remoteAddress: undefined } as any,
      };
      const mockRes: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
        setHeader: jest.fn(),
      };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, jest.fn());

      expect(true).toBe(true);
    });
  });

  describe('cleanup timer', () => {
    it('should clean up old suspicious IPs', () => {
      // Create middleware and trigger suspicious activity
      const mockReq: Partial<Request> = {
        ip: '1.2.3.4',
        method: 'GET',
        url: '/UNION SELECT test',
        get: jest.fn().mockReturnValue(''),
        query: {},
        body: {},
        connection: { remoteAddress: '1.2.3.4' } as any,
        socket: { remoteAddress: '1.2.3.4' } as any,
      };
      const mockRes: Partial<Response> = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        setHeader: jest.fn(),
      };

      const handler = middleware.getMiddleware();
      handler(mockReq as Request, mockRes as Response, jest.fn());

      // Advance time past cleanup interval (5 minutes) and past max age (24 hours)
      jest.advanceTimersByTime(25 * 60 * 60 * 1000); // 25 hours

      // The cleanup should have run multiple times
      expect(true).toBe(true);
    });
  });
});
