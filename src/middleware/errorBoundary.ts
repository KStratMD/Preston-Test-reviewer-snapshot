import type { Request, Response, NextFunction } from 'express';
import { Logger } from '../utils/Logger';
import {
  ValidationAppError,
  UnauthorizedAppError,
  ForbiddenAppError,
  NotFoundAppError,
  BadRequestAppError,
  ServiceUnavailableAppError,
} from '../errors/AppError';

const logger = new Logger('ErrorBoundary');

const REDIS_PORT_CANDIDATES = new Set([6379, 6380, 6381]);
const REDIS_ADDRESS_CANDIDATES = new Set(['127.0.0.1', 'localhost', '::1']);

function flattenErrorCauses(value: unknown, depth = 0): unknown[] {
  if (value == null || depth > 4) {
    // Return the raw value so the caller can still inspect it
    return [value];
  }

  if (value instanceof AggregateError) {
    const inner = Array.isArray(value.errors)
      ? value.errors.flatMap(err => flattenErrorCauses(err, depth + 1))
      : [];
    return [value, ...inner];
  }

  if (Array.isArray((value as { errors?: unknown[] })?.errors)) {
    const errors = (value as { errors: unknown[] }).errors;
    return [value, ...errors.flatMap(err => flattenErrorCauses(err, depth + 1))];
  }

  if (Array.isArray(value)) {
    return value.flatMap(err => flattenErrorCauses(err, depth + 1));
  }

  return [value];
}

function getNumericPort(port: unknown): number | undefined {
  if (typeof port === 'number') {
    return Number.isFinite(port) ? port : undefined;
  }
  if (typeof port === 'string') {
    const parsed = Number.parseInt(port, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function getLower(value: unknown): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.toLowerCase();
  }
  if (value instanceof Error && typeof value.message === 'string') {
    return value.message.toLowerCase();
  }
  return '';
}

function isRedisConnectionNoise(errorLike: unknown): boolean {
  if (!errorLike) {
    return false;
  }

  const code = typeof (errorLike as { code?: unknown }).code === 'string'
    ? String((errorLike as { code?: string }).code).toUpperCase()
    : '';
  const addressRaw = (errorLike as { address?: unknown }).address;
  const address = typeof addressRaw === 'string' ? addressRaw.toLowerCase() : '';
  const port = getNumericPort((errorLike as { port?: unknown }).port);
  const message = getLower(errorLike);
  const raw = typeof errorLike === 'string'
    ? errorLike.toLowerCase()
    : message;
  const combined = `${code} ${address} ${port ?? ''} ${raw}`.trim();

  const looksLikeRedisPort = typeof port === 'number' && REDIS_PORT_CANDIDATES.has(port);
  const looksLikeRedisAddress = address.length > 0 && REDIS_ADDRESS_CANDIDATES.has(address);

  if (looksLikeRedisPort || looksLikeRedisAddress) {
    if (code === 'ECONNREFUSED' || code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'NR_CLOSED') {
      return true;
    }
  }

  if (message.includes('redis') || combined.includes('redis')) {
    if (message.includes('econnrefused') || message.includes('connection refused')) return true;
    if (message.includes('connect econn')) return true;
    if (message.includes('timeout') || message.includes('timed out')) return true;
    if (message.includes('nr_closed') || message.includes('connection closed')) return true;
  }

  if (combined.includes('127.0.0.1:6379') || combined.includes('localhost:6379') || combined.includes(':6379')) {
    if (combined.includes('econnrefused') || combined.includes('timed out') || combined.includes('nr_closed')) {
      return true;
    }
  }

  return false;
}

function isIgnorableRedisError(error: unknown): boolean {
  const flattened = flattenErrorCauses(error).filter(e => e !== undefined && e !== null);
  if (flattened.length === 0) {
    return false;
  }

  return flattened.every(err => isRedisConnectionNoise(err));
}

/**
 * Async error handler wrapper
 */
export function asyncHandler<T extends Request, U extends Response>(
  fn: (req: T, res: U, next: NextFunction) => Promise<void>,
) {
  return (req: T, res: U, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Global error handling middleware
 */
export function globalErrorHandler() {
  return (error: Error, req: Request, res: Response, _next: NextFunction) => {
    // Log the error
    logger.error('Unhandled error', {
      error: error.message,
      stack: error.stack,
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
      body: req.body,
    });

    // Don't log password fields or other sensitive data
    const sanitizedBody = req.body ? sanitizeLogData(req.body) : undefined;

    logger.error('Request context', {
      method: req.method,
      path: req.path,
      query: req.query,
      params: req.params,
      body: sanitizedBody,
      headers: {
        'content-type': req.get('Content-Type'),
        'user-agent': req.get('User-Agent'),
        'origin': req.get('Origin'),
      },
    });

    // Handle different error types
    if (error instanceof ValidationAppError) {
      return res.status(400).json({
        error: 'Validation Error',
        message: error.message,
        details: error.validationErrors || [],
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error instanceof UnauthorizedAppError) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error instanceof ForbiddenAppError) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error instanceof NotFoundAppError) {
      return res.status(404).json({
        error: 'Not Found',
        message: error.message || 'Resource not found',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error instanceof BadRequestAppError) {
      return res.status(400).json({
        error: 'Bad Request',
        message: error.message,
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error instanceof ServiceUnavailableAppError) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'Service temporarily unavailable',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Handle Joi validation errors
    if ('isJoi' in error && error.isJoi) {
      const joiError = error as Error & { isJoi: boolean; details: { message: string }[] };
      return res.status(400).json({
        error: 'Validation Error',
        message: 'Request validation failed',
        details: joiError.details.map((detail: { message: string }) => detail.message),
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Handle MongoDB/Database errors
    if (error.name === 'MongoError' || error.name === 'CastError') {
      return res.status(400).json({
        error: 'Database Error',
        message: 'Invalid data format',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Handle JWT errors
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        error: 'Invalid Token',
        message: 'Authentication token is invalid',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        error: 'Token Expired',
        message: 'Authentication token has expired',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Handle network/timeout errors
    if ('code' in error && (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT')) {
      return res.status(503).json({
        error: 'Service Unavailable',
        message: 'External service is temporarily unavailable',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Handle file system errors
    if ('code' in error && error.code === 'ENOENT') {
      return res.status(404).json({
        error: 'File Not Found',
        message: 'Requested file or resource not found',
        timestamp: new Date().toISOString(),
        path: req.path,
      });
    }

    // Default to 500 Internal Server Error
    const isDevelopment = process.env.NODE_ENV === 'development';

    return res.status(500).json({
      error: 'Internal Server Error',
      message: isDevelopment ? error.message : 'An unexpected error occurred',
      ...(isDevelopment && { stack: error.stack }),
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  };
}

/**
 * 404 handler for undefined routes
 */
export function notFoundHandler() {
  return (req: Request, res: Response, _next: NextFunction) => {
    logger.warn('Route not found', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });

    res.status(404).json({
      error: 'Not Found',
      message: `Route ${req.method} ${req.path} not found`,
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  };
}

/**
 * Circuit breaker for external service calls
 */
export class CircuitBreakerMiddleware {
  private readonly failures = new Map<string, number>();
  private readonly lastFailureTime = new Map<string, number>();

  constructor(
    private readonly failureThreshold = 5,
    private readonly resetTimeoutMs = 60000, // 1 minute
  ) {}

  wrap(serviceName: string) {
    return (_req: Request, res: Response, next: NextFunction) => {
      const failures = this.failures.get(serviceName) || 0;
      const lastFailure = this.lastFailureTime.get(serviceName) || 0;

      // Check if circuit should reset
      if (Date.now() - lastFailure > this.resetTimeoutMs) {
        this.failures.set(serviceName, 0);
      }

      // If too many failures, reject immediately
      if (failures >= this.failureThreshold) {
        logger.warn('Circuit breaker open', {
          serviceName,
          failures,
          threshold: this.failureThreshold,
        });

        return next(new ServiceUnavailableAppError(
          `Service ${serviceName} is temporarily unavailable`,
        ));
      }

      // Add success/failure tracking to response
      const originalSend = res.send;
      res.send = ((body: unknown) => {
        if (res.statusCode >= 500) {
          // Record failure
          const newFailures = failures + 1;
          this.failures.set(serviceName, newFailures);
          this.lastFailureTime.set(serviceName, Date.now());

          logger.warn('Service failure recorded', {
            serviceName,
            failures: newFailures,
            statusCode: res.statusCode,
          });
        } else if (res.statusCode < 400) {
          // Reset on success
          this.failures.set(serviceName, 0);
        }

        return originalSend.call(res, body);
      }).bind(this);

      next();
    };
  }
}

/**
 * Request timeout handler
 */
export function timeoutHandler(timeoutMs = 30000) {
  return (req: Request, res: Response, next: NextFunction) => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('Request timeout', {
          method: req.method,
          path: req.path,
          timeout: timeoutMs,
          ip: req.ip,
        });

        res.status(408).json({
          error: 'Request Timeout',
          message: 'Request took too long to process',
          timeout: timeoutMs,
          timestamp: new Date().toISOString(),
          path: req.path,
        });
      }
    }, timeoutMs);

    // Clear timeout when response is sent
    res.on('finish', () => clearTimeout(timeout));
    res.on('close', () => clearTimeout(timeout));

    next();
  };
}

/**
 * Sanitize sensitive data from logs
 */
function sanitizeLogData(data: unknown): unknown {
  if (typeof data === 'string') {
    return data;
  }

  if (Array.isArray(data)) {
    return data.map(sanitizeLogData);
  }

  if (data && typeof data === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('password') ||
          lowerKey.includes('secret') ||
          lowerKey.includes('token') ||
          lowerKey.includes('key')) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = sanitizeLogData(value);
      }
    }
    return sanitized;
  }

  return data;
}

/**
 * Process uncaught exceptions and unhandled rejections
 */
export function setupGlobalErrorHandlers(shutdownCallback?: () => Promise<void>) {
  // Set max listeners for process to prevent warnings
  process.setMaxListeners(20);

  process.on('uncaughtException', (error: unknown) => {
    if (isIgnorableRedisError(error)) {
      try {
        const message = error instanceof Error ? error.message : getLower(error) || 'Redis connection error';
        logger.warn('Ignoring uncaught Redis connection error (continuing in stub mode)', {
          error: message,
        });
      } catch (logErr) {
        // If logger fails during error handling, write directly to stderr
        try {
          process.stderr.write(`[WARN] Ignoring uncaught Redis connection error: ${logErr}\n`);
        } catch (_) { /* ignore */ }
      }
      return;
    }

    // Always print raw error to stderr first so we have a visible stack trace
    try {
      const errorStr = error instanceof Error
        ? `${error.message}\n${error.stack}`
        : String(error);
      process.stderr.write(`[ERROR] Uncaught Exception (raw): ${errorStr}\n`);
    } catch (_) {
      /* ignore stderr write errors */
    }

    // Log uncaught exceptions via logger but guard against logger itself throwing.
    try {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      try {
        logger.error('Uncaught Exception', { error: message, stack });
      } catch (logErr) {
        // If logger fails, fall back to stderr to ensure visibility
        try {
          process.stderr.write(`[ERROR] Failed to write uncaught exception to logger: ${logErr}\n`);
        } catch (_) { /* ignore */ }
        try {
          process.stderr.write(`[ERROR] Uncaught Exception: ${message}\n${stack || ''}\n`);
        } catch (_) { /* ignore */ }
      }
    } catch (_) {
      // Defensive no-op if even stringifying the error fails
      try {
        process.stderr.write('[ERROR] Uncaught Exception (could not stringify error)\n');
      } catch (_) { /* ignore */ }
    } finally {
      // Attempt graceful shutdown if callback provided
      if (shutdownCallback) {
        try {
          shutdownCallback().catch(() => process.exit(1)).finally(() => process.exit(1));
        } catch (_) {
          process.exit(1);
        }
      } else {
        // Give time for logs to flush, then exit
        setTimeout(() => {
          try { process.exit(1); } catch (_) { /* ignore */ }
        }, 1000);
      }
    }
  });

  process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>) => {
    // Print raw reason to stderr first to ensure visibility
    try {
      const reasonStr = reason instanceof Error
        ? `${reason.message}\n${reason.stack}`
        : String(reason);
      process.stderr.write(`[ERROR] Unhandled Promise Rejection (raw): ${reasonStr}\n`);
    } catch (_) { /* ignore */ }

    try {
      const msg = reason instanceof Error ? reason.message : String(reason);
      const stack = reason instanceof Error ? reason.stack : undefined;
      try {
        logger.error('Unhandled Promise Rejection', { reason: msg, stack });
      } catch (logErr) {
        try {
          process.stderr.write(`[ERROR] Failed to write unhandled rejection to logger: ${logErr}\n`);
        } catch (_) { /* ignore */ }
        try {
          process.stderr.write(`[ERROR] Unhandled Promise Rejection: ${msg}\n${stack || ''}\n`);
        } catch (_) { /* ignore */ }
      }
    } catch (_) {
      try {
        process.stderr.write('[ERROR] Unhandled Promise Rejection (could not stringify reason)\n');
      } catch (_) { /* ignore */ }
    }

    // Don't exit on unhandled rejection - just log it for now
    try {
      logger.warn('Continuing execution after unhandled rejection...');
    } catch (logErr) {
      try {
        process.stderr.write(`[WARN] Continuing execution after unhandled rejection (logger warn failed): ${logErr}\n`);
      } catch (_) { /* ignore */ }
    }
  });
}

// Export circuit breaker instance
export const circuitBreaker = new CircuitBreakerMiddleware();
