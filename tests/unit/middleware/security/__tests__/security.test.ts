import { createInputSanitizer } from '../sanitization';
import { createRequestSizeValidator } from '../validation';
import { createSQLInjectionProtection } from '../protection';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('Security Middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Input Sanitization', () => {
    it('should sanitize script tags from body', () => {
      const middleware = createInputSanitizer(mockLogger);
      const req = {
        body: { name: '<script>alert("xss")</script>John' },
        query: {},
        params: {},
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(req.body.name).toBe('John');
      expect(next).toHaveBeenCalled();
    });

    it('should sanitize JavaScript URLs', () => {
      const middleware = createInputSanitizer(mockLogger);
      const req = {
        body: { url: 'javascript:alert("xss")' },
        query: {},
        params: {},
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(req.body.url).toBe('');
      expect(next).toHaveBeenCalled();
    });

    it('should handle nested objects', () => {
      const middleware = createInputSanitizer(mockLogger);
      const req = {
        body: { 
          user: { 
            name: '<script>evil</script>Clean Name',
            details: {
              bio: 'onclick="alert()"Good person'
            }
          }
        },
        query: {},
        params: {},
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(req.body.user.name).toBe('Clean Name');
      expect(req.body.user.details.bio).toBe('Good person');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Request Size Validation', () => {
    it('should allow requests within size limit', () => {
      const middleware = createRequestSizeValidator(mockLogger, 1024);
      const req = {
        headers: { 'content-length': '500' },
        ip: '127.0.0.1',
        path: '/test',
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should reject requests exceeding size limit', () => {
      const middleware = createRequestSizeValidator(mockLogger, 1024);
      const req = {
        headers: { 'content-length': '2048' },
        ip: '127.0.0.1',
        path: '/test',
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Request size limit exceeded',
        expect.objectContaining({
          contentLength: 2048,
          maxAllowed: 1024,
        })
      );
    });

    it('should allow requests without content-length header', () => {
      const middleware = createRequestSizeValidator(mockLogger, 1024);
      const req = {
        headers: {},
        ip: '127.0.0.1',
        path: '/test',
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });
  });

  describe('SQL Injection Protection', () => {
    it('should allow clean requests', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: { name: 'John Doe', age: 30 },
        query: { search: 'products' },
        params: { id: '123' },
        ip: '127.0.0.1',
        path: '/api/users',
        method: 'POST',
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
    });

    it('should detect SQL injection in body', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: { search: "'; DROP TABLE users; --" },
        query: {},
        params: {},
        ip: '127.0.0.1',
        path: '/api/search',
        method: 'POST',
        get: jest.fn(() => 'test-agent'),
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Potential SQL injection attempt detected',
        expect.objectContaining({
          ip: '127.0.0.1',
          path: '/api/search',
        })
      );
    });

    it('should detect SQL injection in query parameters', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: {},
        query: { filter: 'name=admin OR 1=1' },
        params: {},
        ip: '127.0.0.1',
        path: '/api/users',
        method: 'GET',
        get: jest.fn(() => 'test-agent'),
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Potential SQL injection attempt detected',
        expect.any(Object)
      );
    });

    it('should handle nested objects in injection detection', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: { 
          user: { 
            name: 'John',
            filter: { query: 'SELECT * FROM secrets' }
          }
        },
        query: {},
        params: {},
        ip: '127.0.0.1',
        path: '/api/users',
        method: 'POST',
        get: jest.fn(() => 'test-agent'),
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith(expect.any(Error));
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should not flag benign phrases containing and/or', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: { description: 'This and/or that should not be flagged.' },
        query: { q: 'search for apples and oranges' },
        params: { note: 'bread and butter' },
        ip: '127.0.0.1',
        path: '/api/search',
        method: 'GET',
        get: jest.fn(() => 'test-agent'),
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });

    it('should not flag numeric equality in plain text', () => {
      const middleware = createSQLInjectionProtection(mockLogger);
      const req = {
        body: { text: 'version 1=1 is not a statement, just text' },
        query: { note: 'set alarm for 1=1 PM is nonsensical text' },
        params: {},
        ip: '127.0.0.1',
        path: '/api/notes',
        method: 'POST',
        get: jest.fn(() => 'test-agent'),
      } as any;
      const res = {} as any;
      const next = jest.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalledWith();
      expect(mockLogger.error).not.toHaveBeenCalled();
    });
  });

  describe('Combined Security Stack', () => {
    it('should process request through multiple middleware', () => {
      const sanitizer = createInputSanitizer(mockLogger);
      const sizeValidator = createRequestSizeValidator(mockLogger, 1024);
      const sqlProtection = createSQLInjectionProtection(mockLogger);

      const req = {
        body: { name: '<script>alert(1)</script>Clean Name' },
        query: {},
        params: {},
        headers: { 'content-length': '100' },
        ip: '127.0.0.1',
        path: '/api/test',
        method: 'POST',
      } as any;
      const res = {} as any;
      const next = jest.fn();

      // Process through sanitization first
      sanitizer(req, res, next);
      expect(req.body.name).toBe('Clean Name');

      // Then size validation
      sizeValidator(req, res, next);

      // Finally SQL injection protection
      sqlProtection(req, res, next);

      expect(next).toHaveBeenCalledTimes(3);
      expect(next).toHaveBeenCalledWith(); // All should pass
    });
  });
});