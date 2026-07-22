import type { Request, Response, NextFunction } from 'express';
import type { ObservabilityService } from '../observability';
import { uuidv4 } from '../utils/uuid';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { logger } from '../utils/Logger';

declare global {
  namespace Express {
    interface Request {
      correlationId?: string;
      operationId?: string;
      startTime?: number;
      observabilityScope?: {
        logger: unknown;
        tracing: unknown;
        metrics: unknown;
      };
    }
  }
}

export interface ObservabilityMiddlewareConfig {
  correlationIdHeader?: string;
  enableRequestLogging?: boolean;
  enableMetrics?: boolean;
  enableTracing?: boolean;
  excludePaths?: string[];
}

export function createObservabilityMiddleware(
  observabilityService: ObservabilityService,
  config: ObservabilityMiddlewareConfig = {},
) {
  const {
    correlationIdHeader = 'x-correlation-id',
    enableRequestLogging = true,
    enableMetrics = true,
    enableTracing = true,
    excludePaths = ['/health', '/metrics', '/favicon.ico'],
  } = config;

  return (req: Request, res: Response, next: NextFunction): void => {
    if (process.env.NODE_ENV === 'test') {
      return next();
    }
    try {
      // Skip excluded paths
      if (excludePaths.some(path => req.path.startsWith(path))) {
        return next();
      }

    // Generate or extract correlation ID
    req.correlationId = req.headers[correlationIdHeader] as string || uuidv4();
    req.operationId = uuidv4();
    req.startTime = Date.now();

    // Create observability scope
    req.observabilityScope = observabilityService.createScope({
      correlationId: req.correlationId,
      operationId: req.operationId,
    });

    // Add correlation ID to response headers
    res.setHeader(correlationIdHeader, req.correlationId);

    if (enableRequestLogging) {
      (req.observabilityScope as any).logger.info({
        method: req.method,
        url: req.url,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        query: req.query,
        body: req.method !== 'GET' ? req.body : undefined,
      }, `Incoming ${req.method} request to ${req.url}`);
    }

    if (enableTracing) {
      // Start a span for the HTTP request
      const span = observabilityService.tracing.createSpan(`HTTP ${req.method} ${req.route?.path || req.path}`, {
        'http.method': req.method,
        'http.url': req.url,
        'http.user_agent': req.get('User-Agent') || '',
        'http.remote_addr': req.ip || '',
        'correlation.id': req.correlationId || '',
        'operation.id': req.operationId || '',
      });

      // Store span in response locals for cleanup
      res.locals.httpSpan = span;
    }

    // Hook into response finish event
    const originalSend = res.send;
    res.send = function (body) {
      const duration = Date.now() - (req.startTime || Date.now());

      if (enableRequestLogging) {
        const logLevel: 'error' | 'warn' | 'info' =
          res.statusCode >= 500 ? 'error' :
          res.statusCode >= 400 ? 'warn' : 'info';
        const responseSize = typeof body === 'string'
          ? Buffer.byteLength(body)
          : (Buffer.isBuffer(body) ? (body as Buffer).length : 0);

        (req.observabilityScope?.logger as Record<'error' | 'warn' | 'info', (ctx: unknown, msg: string) => void> | undefined)?.[logLevel]({
          method: req.method,
          url: req.url,
          statusCode: res.statusCode,
          duration,
          responseSize,
        }, `${req.method} ${req.url} ${res.statusCode} - ${duration}ms`);
      }

      if (enableMetrics) {
        // Record HTTP request metrics
        (req.observabilityScope as any)?.metrics.recordCustomMetric(
          'http_requests_total',
          1,
          {
            method: req.method,
            status_code: res.statusCode.toString(),
            route: req.route?.path || req.path,
          },
          'counter',
        );

        (req.observabilityScope as any)?.metrics.recordCustomMetric(
          'http_request_duration_ms',
          duration,
          {
            method: req.method,
            status_code: res.statusCode.toString(),
            route: req.route?.path || req.path,
          },
          'histogram',
        );
      }

      if (enableTracing && res.locals.httpSpan) {
        // Complete the HTTP span
        try {
          const responseSize = typeof body === 'string'
            ? Buffer.byteLength(body)
            : (Buffer.isBuffer(body) ? (body as Buffer).length : 0);
          res.locals.httpSpan.setAttributes?.({
            'http.status_code': res.statusCode,
            'http.response_size': responseSize,
          });
          if (res.statusCode >= 400) {
            res.locals.httpSpan.recordException?.(new Error(`HTTP ${res.statusCode}`));
          }
        } catch {/* ignore span attribute errors */}
        try {
          res.locals.httpSpan.end?.();
        } catch {/* ignore end errors */}
      }

      return originalSend.call(this, body);
    };

      next();
    } catch (err) {
      logger.error('[observabilityMiddleware] error', err);
      next(err as Error);
    }
  };
}

/**
 * Error handling middleware that enriches errors with observability context
 */
export function createObservabilityErrorMiddleware(
  _observabilityService: ObservabilityService,
) {
  return (error: Error, req: Request, res: Response, next: NextFunction): void => {
    const duration = Date.now() - (req.startTime || Date.now());

    // Log the error with full context
    if (req.observabilityScope) {
      (req.observabilityScope as any).logger.error({
        method: req.method,
        url: req.url,
        duration,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
        headers: req.headers,
        body: req.body,
      }, `Unhandled error in ${req.method} ${req.url}`);

      // Record error metrics
      (req.observabilityScope as any).metrics.recordCustomMetric(
        'http_errors_total',
        1,
        {
          method: req.method,
          route: req.route?.path || req.path,
          error_type: error.name,
        },
        'counter',
      );
    }

    // Record the error in the active span
    if (res.locals.httpSpan) {
      try { res.locals.httpSpan.recordException?.(error); } catch {/* ignore */}
      try {
        res.locals.httpSpan.setAttributes?.({
          'error': true,
          'error.name': error.name,
          'error.message': error.message,
        });
      } catch {/* ignore */}
    }

    next(error);
  };
}

/**
 * Middleware to extract user context for observability
 */
export function createUserContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract user information from JWT token or session
    const authHeader = req.headers.authorization;
    let userId: string | undefined;

    if (authHeader?.startsWith('Bearer ')) {
      try {
        const token = authHeader.substring(7);
        // Pin HS256 (A3) — symmetric JWT_SECRET tokens only.
        const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] }) as jwt.JwtPayload;

        // Extract user ID from common JWT payload fields
        userId = decoded.sub ||
                 decoded.userId ||
                 decoded.user_id ||
                 decoded.id ||
                 (typeof decoded.user === 'object' && decoded.user?.id) ||
                 (typeof decoded.user === 'string' ? decoded.user : undefined);

        // If no user ID found but token is valid, use a generic identifier
        if (!userId && decoded.iat) {
          userId = `user_${decoded.iat}`;
        }
      } catch (error) {
        // Invalid token - continue without user context
        // Log debug info for troubleshooting in development
        if (env.NODE_ENV === 'development') {
          logger.debug('JWT verification failed in observability middleware: ' + (error instanceof Error ? error.message : 'Unknown error'));
        }
      }
    }

    // Update observability scope with user context
    if (req.observabilityScope && userId) {
      req.observabilityScope = (req.observabilityScope as any).logger.child({ userId });
    }

    next();
  };
}

/**
 * Middleware to add integration-specific context
 */
export function createIntegrationContextMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    // Extract integration ID from route parameters
    const integrationId = req.params.integrationId || req.params.id;

    if (req.observabilityScope && integrationId) {
      // Update the observability scope with integration context
      req.observabilityScope.logger = (req.observabilityScope as any).logger.child({
        integrationId,
      });

      // Add integration context to active span
      if (res.locals.httpSpan) {
        res.locals.httpSpan.setAttributes({
          'integration.id': integrationId,
        });
      }
    }

    next();
  };
}
