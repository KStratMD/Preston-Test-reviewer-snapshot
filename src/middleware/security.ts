import type { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';
import type { Logger } from '../utils/Logger';
import { BadRequestAppError, UnauthorizedAppError } from '../errors/AppError';
import { VALIDATION_CONSTANTS } from '../constants/systemConstants';
import { stripControlCharacters } from '../utils/sanitization';
import { timingSafeCompare, maskSensitiveData } from '../utils/securityHelpers';

/**
 * Comprehensive input sanitization middleware
 */
export function sanitizeInput(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Sanitize string inputs to prevent XSS and injection attacks
    const sanitizeValue = (value: unknown): unknown => {
      if (typeof value === 'string') {
        const cleaned = stripControlCharacters(
          value
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags
            .replace(/javascript:/gi, '') // Remove javascript: URLs
            .replace(/on\w+\s*=/gi, ''), // Remove event handlers
        );

        return cleaned
          .trim()
          .substring(0, VALIDATION_CONSTANTS.MAX_STRING_LENGTH);
      }

      if (Array.isArray(value)) {
        return value.map(sanitizeValue);
      }

      if (value && typeof value === 'object') {
        const sanitized: Record<string, unknown> = {};
        for (const [key, val] of Object.entries(value)) {
          // Sanitize keys as well
          const cleanKey = sanitizeValue(key) as string;
          sanitized[cleanKey] = sanitizeValue(val);
        }
        return sanitized;
      }

      return value;
    };

    try {
      if (req.body) {
        req.body = sanitizeValue(req.body);
      }
    } catch (error) {
      logger.error('Input sanitization failed for body', error);
    }

    try {
      if (req.query && typeof req.query === 'object') {
        // Create a new sanitized query object instead of trying to reassign
        const sanitizedQuery = sanitizeValue(req.query) as Record<string, unknown>;
        Object.keys(req.query).forEach(key => {
          delete req.query[key];
        });
        Object.assign(req.query, sanitizedQuery);
      }
    } catch (error) {
      logger.error('Input sanitization failed for query', error);
    }

    try {
      if (req.params && typeof req.params === 'object') {
        // Create a new sanitized params object instead of trying to reassign
        const sanitizedParams = sanitizeValue(req.params) as Record<string, unknown>;
        Object.keys(req.params).forEach(key => {
          delete req.params[key];
        });
        Object.assign(req.params, sanitizedParams);
      }
    } catch (error) {
      logger.error('Input sanitization failed for params', error);
    }

    next();
  };
}

/**
 * Request size validation middleware
 */
export function validateRequestSize(logger: Logger, maxSizeBytes: number = 10 * 1024 * 1024) { // 10MB default
  return (req: Request, _res: Response, next: NextFunction) => {
    const contentLength = req.headers['content-length'];

    if (contentLength && parseInt(contentLength) > maxSizeBytes) {
      logger.warn('Request size limit exceeded', {
        contentLength: parseInt(contentLength),
        maxAllowed: maxSizeBytes,
        ip: req.ip,
        path: req.path,
      });

      return next(new BadRequestAppError(`Request too large. Maximum size: ${maxSizeBytes / (1024 * 1024)}MB`));
    }

    next();
  };
}

/**
 * SQL injection prevention middleware
 */
export function preventSQLInjection(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const sqlPatterns = [
      /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|UNION|SCRIPT)\b)/gi,
      /(;|\||&|\$|\?|<|>|%|!|\*)/g,
      /('|\\\\|--|\/\*)/g,
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
        userAgent: req.get('User-Agent'),
        body: maskSensitiveData(req.body),
        query: maskSensitiveData(req.query),
        params: maskSensitiveData(req.params),
      });

      return next(new BadRequestAppError('Invalid input detected'));
    }

    next();
  };
}

/**
 * API key validation middleware
 * SECURITY: Uses timing-safe comparison to prevent timing attacks
 */
export function validateApiKey(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      logger.warn('Missing API key', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('API key is required'));
    }

    // In production, validate against database or secure store
    const validApiKeys = process.env.VALID_API_KEYS?.split(',') || [];

    // SECURITY: Use timing-safe comparison to prevent timing attacks
    const isValid = validApiKeys.some(validKey => timingSafeCompare(apiKey, validKey.trim()));

    if (!isValid) {
      // SECURITY: Don't log partial API key - could aid in brute force
      logger.error('Invalid API key attempt', {
        ip: req.ip,
        path: req.path,
        userAgent: req.get('User-Agent'),
      });

      return next(new UnauthorizedAppError('Invalid API key'));
    }

    next();
  };
}

/**
 * Content-Type validation middleware
 */
export function validateContentType(logger: Logger, allowedTypes: string[] = ['application/json']) {
  return (req: Request, _res: Response, next: NextFunction) => {
    // Skip validation for GET, DELETE, and OPTIONS requests
    if (['GET', 'DELETE', 'OPTIONS', 'HEAD'].includes(req.method)) {
      return next();
    }

    const contentType = req.headers['content-type'];

    if (!contentType) {
      return next(new BadRequestAppError('Content-Type header is required'));
    }

    const isAllowed = allowedTypes.some(type =>
      contentType.toLowerCase().includes(type.toLowerCase()),
    );

    if (!isAllowed) {
      logger.warn('Invalid content type', {
        contentType,
        allowedTypes,
        ip: req.ip,
        path: req.path,
      });

      return next(new BadRequestAppError(
        `Invalid Content-Type. Allowed types: ${allowedTypes.join(', ')}`,
      ));
    }

    next();
  };
}

/**
 * Request origin validation middleware
 */
export function validateOrigin(logger: Logger) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const origin = req.get('Origin') || req.get('Referer');
    const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000', 'https://localhost:3000'];

    // Allow requests without origin (direct API calls)
    if (!origin) {
      return next();
    }

    const isAllowed = allowedOrigins.some(allowed => origin.startsWith(allowed));

    if (!isAllowed) {
      logger.warn('Request from unauthorized origin', {
        origin,
        allowedOrigins: allowedOrigins.length,
        ip: req.ip,
        path: req.path,
      });

      return next(new BadRequestAppError('Request origin not allowed'));
    }

    next();
  };
}

/**
 * Enhanced security headers with CSP
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ['\'self\''],
      styleSrc: ['\'self\'', '\'unsafe-inline\'', 'fonts.googleapis.com'],
      scriptSrc: ['\'self\''],
      imgSrc: ['\'self\'', 'data:', 'https:'],
      connectSrc: ['\'self\''],
      fontSrc: ['\'self\'', 'fonts.gstatic.com'],
      objectSrc: ['\'none\''],
      mediaSrc: ['\'self\''],
      frameSrc: ['\'none\''],
      baseUri: ['\'self\''],
      formAction: ['\'self\''],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow for API usage
  hsts: {
    maxAge: 31536000, // 1 year
    includeSubDomains: true,
    preload: true,
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
});

/**
 * Audit logging middleware for security events
 */
export function auditLogger(logger: Logger) {
  return (req: Request, res: Response, next: NextFunction) => {
    const startTime = Date.now();

    // Log request
    logger.info('API Request', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      contentLength: req.get('Content-Length'),
      timestamp: new Date().toISOString(),
    });

    // Override res.json to log responses
    const originalJson = res.json;
    res.json = function(body: unknown) {
      const duration = Date.now() - startTime;

      logger.info('API Response', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        ip: req.ip,
        timestamp: new Date().toISOString(),
      });

      // Log security-relevant events
      if (res.statusCode >= 400) {
        const hasErrorOrMessage =
          typeof body === 'object' && body !== null && ('error' in (body as any) || 'message' in (body as any));
        const errMsg = hasErrorOrMessage
          ? (body as { error?: unknown; message?: unknown }).error ||
            (body as { error?: unknown; message?: unknown }).message
          : 'Unknown error';
        logger.warn('API Error Response', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          error: errMsg,
          ip: req.ip,
          userAgent: req.get('User-Agent'),
        });
      }

      return originalJson.call(this, body);
    };

    next();
  };
}

/**
 * Combined security middleware stack
 */
export function createSecurityMiddleware(logger: Logger) {
  return [
    securityHeaders,
    auditLogger(logger),
    validateRequestSize(logger),
    sanitizeInput(logger),
    preventSQLInjection(logger),
    validateContentType(logger),
    validateOrigin(logger),
  ];
}

/**
 * High-security middleware for sensitive endpoints
 */
export function createHighSecurityMiddleware(logger: Logger) {
  return [
    ...createSecurityMiddleware(logger),
    validateApiKey(logger),
  ];
}
