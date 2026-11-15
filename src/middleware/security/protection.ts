import type { Request, Response, NextFunction } from 'express';
import type { Logger } from '../../utils/Logger';
import { BadRequestAppError, UnauthorizedAppError } from '../../errors/AppError';
import { maskSensitiveData } from '../../utils/securityHelpers';

/**
 * SQL injection prevention middleware
 */
export function createSQLInjectionProtection(logger: Logger) {
  const sqlPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi,
    /(;|\||&|\$|\?|<|>|%|!|\*)/g,
    /('|\\\\|--|\/\*)/g,
    // Common boolean tautologies and injection fragments
    /(\bor\s+\d+\s*=\s*\d+\b|\band\s+\d+\s*=\s*\d+\b)/gi,
    /(\bor\s+true\s*=\s*true\b|\band\s+true\s*=\s*true\b)/gi,
  ];

  const checkForSQLInjection = (obj: unknown, path = ''): boolean => {
    if (typeof obj === 'string') {
      return sqlPatterns.some(pattern => pattern.test(obj));
    }

    if (Array.isArray(obj)) {
      return obj.some((item, index) => checkForSQLInjection(item, `${path}[${index}]`));
    }

    if (obj && typeof obj === 'object') {
      return Object.entries(obj).some(([key, value]) =>
        checkForSQLInjection(value, path ? `${path}.${key}` : key),
      );
    }

    return false;
  };

  return (req: Request, _res: Response, next: NextFunction) => {
    // Check body, query, and params for SQL injection patterns
    const suspicious = [
      req.body && checkForSQLInjection(req.body, 'body'),
      req.query && checkForSQLInjection(req.query, 'query'),
      req.params && checkForSQLInjection(req.params, 'params'),
    ].some(Boolean);

    if (suspicious) {
      // SECURITY: Mask sensitive data before logging to prevent credential exposure
      logger.error('Potential SQL injection attempt detected', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userAgent: req.get('User-Agent') || 'unknown',
        body: maskSensitiveData(req.body),
        query: maskSensitiveData(req.query),
        params: maskSensitiveData(req.params),
      });

      return next(new Error('Invalid input detected'));
    }

    next();
  };
}

/**
 * XSS protection middleware
 */
export function createXSSProtection(logger: Logger) {
  const xssPatterns = [
    /<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi,
    /javascript\s*:/gi,
    /on\w+\s*=/gi,
    /<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi,
    /<object\b[^<]*(?:(?!<\/object>)<[^<]*)*<\/object>/gi,
    /<embed\b[^>]*>/gi,
  ];

  const checkForXSS = (obj: unknown, path = ''): boolean => {
    if (typeof obj === 'string') {
      return xssPatterns.some(pattern => pattern.test(obj));
    }

    if (Array.isArray(obj)) {
      return obj.some((item, index) => checkForXSS(item, `${path}[${index}]`));
    }

    if (obj && typeof obj === 'object') {
      return Object.entries(obj).some(([key, value]) =>
        checkForXSS(value, path ? `${path}.${key}` : key),
      );
    }

    return false;
  };

  return (req: Request, _res: Response, next: NextFunction) => {
    const suspicious = [
      req.body && checkForXSS(req.body, 'body'),
      req.query && checkForXSS(req.query, 'query'),
      req.params && checkForXSS(req.params, 'params'),
    ].some(Boolean);

    if (suspicious) {
      // SECURITY: Mask sensitive data before logging
      logger.error('Potential XSS attempt detected', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userAgent: req.get('User-Agent') || 'unknown',
        body: maskSensitiveData(req.body),
        query: maskSensitiveData(req.query),
        params: maskSensitiveData(req.params),
      });

      return next(new BadRequestAppError('Malicious input detected'));
    }

    next();
  };
}

/**
 * Path traversal protection middleware
 */
export function createPathTraversalProtection(logger: Logger) {
  const dangerousPatterns = [
    /\.\./g, // Directory traversal
    /\/\.\.\//g, // Unix path traversal
    /\\\.\.\\/g, // Windows path traversal
    /%2e%2e/gi, // URL encoded ..
    /%252e%252e/gi, // Double URL encoded ..
    /\0/g, // Null bytes
  ];

  const checkForPathTraversal = (obj: unknown, path = ''): boolean => {
    if (typeof obj === 'string') {
      return dangerousPatterns.some(pattern => pattern.test(obj));
    }

    if (Array.isArray(obj)) {
      return obj.some((item, index) => checkForPathTraversal(item, `${path}[${index}]`));
    }

    if (obj && typeof obj === 'object') {
      return Object.entries(obj).some(([key, value]) =>
        checkForPathTraversal(value, path ? `${path}.${key}` : key),
      );
    }

    return false;
  };

  return (req: Request, _res: Response, next: NextFunction) => {
    const suspicious = [
      req.body && checkForPathTraversal(req.body, 'body'),
      req.query && checkForPathTraversal(req.query, 'query'),
      req.params && checkForPathTraversal(req.params, 'params'),
      req.url && checkForPathTraversal(req.url, 'url'),
    ].some(Boolean);

    if (suspicious) {
      logger.error('Potential path traversal attempt detected', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        userAgent: req.get('User-Agent') || 'unknown',
        url: req.url,
      });

      return next(new BadRequestAppError('Invalid path detected'));
    }

    next();
  };
}

/**
 * Rate limiting protection (simple in-memory implementation)
 */
export function createRateLimitProtection(
  logger: Logger,
  options: {
    windowMs?: number;
    maxRequests?: number;
    keyGenerator?: (req: Request) => string;
  } = {}
) {
  const {
    windowMs = 15 * 60 * 1000, // 15 minutes
    maxRequests = 100,
    keyGenerator = (req: Request) => req.ip || 'unknown',
  } = options;

  const requests = new Map<string, { count: number; resetTime: number }>();

  // Clean up expired entries periodically (test-friendly)
  const shouldSkipInterval = process.env.JEST_WORKER_ID !== undefined;
  const intervalMs = Math.min(windowMs, 60_000);
  let cleanupHandle: NodeJS.Timeout | undefined;
  if (!shouldSkipInterval) {
    cleanupHandle = setInterval(() => {
      const now = Date.now();
      for (const [key, data] of requests.entries()) {
        if (now > data.resetTime) {
          requests.delete(key);
        }
      }
    }, intervalMs);
    if (cleanupHandle.unref) cleanupHandle.unref();
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const key = keyGenerator(req);
    const now = Date.now();
    
    let requestData = requests.get(key);
    
    if (!requestData || now > requestData.resetTime) {
      requestData = {
        count: 1,
        resetTime: now + windowMs,
      };
    } else {
      requestData.count++;
    }
    
    requests.set(key, requestData);
    
    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, maxRequests - requestData.count));
    res.setHeader('X-RateLimit-Reset', new Date(requestData.resetTime).toISOString());
    
    if (requestData.count > maxRequests) {
      logger.warn('Rate limit exceeded', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent') || 'unknown',
        count: requestData.count,
        limit: maxRequests,
      });
      
      res.status(429).json({
        error: 'Too Many Requests',
        message: `Rate limit exceeded. Try again after ${new Date(requestData.resetTime).toISOString()}`,
      });
      return;
    }
    
    next();
  };
}

/**
 * CSRF protection middleware (validates CSRF tokens)
 */
export function createCSRFProtection(logger: Logger, tokenSecret: string) {
  const crypto = require('crypto');
  
  const generateToken = (sessionId: string): string => {
    const hmac = crypto.createHmac('sha256', tokenSecret);
    hmac.update(sessionId + Date.now().toString());
    return hmac.digest('hex');
  };
  
  const validateToken = (token: string, sessionId: string): boolean => {
    try {
      // Simple validation - in production, use more sophisticated token validation
      const hmac = crypto.createHmac('sha256', tokenSecret);
      hmac.update(sessionId);
      const expectedToken = hmac.digest('hex');
      return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expectedToken));
    } catch {
      return false;
    }
  };

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip CSRF for safe methods
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next();
    }

    const token = req.headers['x-csrf-token'] as string || req.body._csrf;
    const sessionId = req.session?.id || req.headers['x-session-id'] as string;

    if (!sessionId) {
      logger.warn('CSRF validation failed: No session ID', {
        ip: req.ip,
        path: req.path,
        method: req.method,
      });
      
      return next(new UnauthorizedAppError('Session required'));
    }

    if (!token) {
      logger.warn('CSRF validation failed: No token provided', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        sessionId,
      });
      
      return next(new UnauthorizedAppError('CSRF token required'));
    }

    if (!validateToken(token, sessionId)) {
      logger.error('CSRF validation failed: Invalid token', {
        ip: req.ip,
        path: req.path,
        method: req.method,
        sessionId,
        userAgent: req.get('User-Agent') || 'unknown',
      });
      
      return next(new UnauthorizedAppError('Invalid CSRF token'));
    }

    next();
  };
}