import pino, { type Logger } from 'pino';
import type { TracingService } from './tracing';
import { safeCloseLogger } from '../utils/loggerAdapter';

export interface LoggingConfig {
  level: string;
  environment: string;
  enableFileLogging?: boolean;
  logDirectory?: string;
  enableConsole?: boolean;
  enableStructuredLogging?: boolean;
  correlationIdHeader?: string;
}

export interface LogContext {
  traceId?: string;
  spanId?: string;
  correlationId?: string;
  userId?: string;
  integrationId?: string;
  operationId?: string;
  [key: string]: unknown;
}

export class LoggingService {
  private readonly logger: Logger;
  private readonly tracingService?: TracingService;

  constructor(
    private readonly config: LoggingConfig,
    tracingService?: TracingService,
  ) {
    this.tracingService = tracingService;
    this.logger = this.createLogger();
  }

  private createLogger(): Logger {
    const baseConfig: pino.LoggerOptions = {
      level: this.config.level || 'info',
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => ({
          pid: bindings.pid,
          hostname: bindings.hostname,
          service: 'integration-hub',
          environment: this.config.environment,
        }),
      },
      timestamp: pino.stdTimeFunctions.isoTime,
      serializers: {
        error: pino.stdSerializers.err,
        req: pino.stdSerializers.req,
        res: pino.stdSerializers.res,
      },
    };

    const isJest = process.env.JEST_WORKER_ID !== undefined;

    // Configure output based on environment
    if (this.config.environment === 'production') {
      // Production: structured JSON logging
      (baseConfig as any).prettyPrint = false;
    } else if (this.config.environment === 'test' || isJest) {
      // Test/Jest: keep logs minimal and avoid worker threads/transports.
      // Use 'error' level so failures surface in test output (e.g., env validation),
      // but suppress lower-level noise.
      baseConfig.level = 'error';
      // Ensure no transport is configured under Jest to avoid thread-stream workers
      delete (baseConfig as any).transport;
    } else if (this.config.enableConsole !== false) {
      // Development: pretty printed logs
      baseConfig.transport = {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:standard',
          ignore: 'pid,hostname',
        },
      };
    }

    let logger = pino(baseConfig);

    // Add file logging if enabled
    if (this.config.enableFileLogging && !isJest) {
      const logDirectory = this.config.logDirectory || './logs';

      // Create multiple streams for different log levels
      const streams = [
        {
          level: 'info',
          stream: pino.destination({
            dest: `${logDirectory}/app.log`,
            sync: false,
          }),
        },
        {
          level: 'error',
          stream: pino.destination({
            dest: `${logDirectory}/error.log`,
            sync: false,
          }),
        },
        {
          level: 'warn',
          stream: pino.destination({
            dest: `${logDirectory}/warn.log`,
            sync: false,
          }),
        },
      ];

      logger = pino(baseConfig, pino.multistream(streams));
    }

    return logger;
  }

  /**
   * Creates a child logger with additional context
   */
  createChildLogger(context: LogContext): Logger {
    const enrichedContext = this.sanitizeContext(context);
    return this.logger.child(enrichedContext);
  }

  /**
   * Enriches log context with tracing information
   */
  private enrichContextWithTracing(context: LogContext): LogContext {
    const enriched = { ...context };

    if (this.tracingService) {
      const traceId = this.tracingService.getCurrentTraceId();
      const spanId = this.tracingService.getCurrentSpanId();

      if (traceId) enriched.traceId = traceId;
      if (spanId) enriched.spanId = spanId;
    }

    return enriched;
  }

  private redactSensitive(input: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
    if (input === null || input === undefined) return input;
    if (depth > 5) return '[redacted]'; // avoid deep recursion and nested secret bypasses
    const sensitiveKeys = new Set([
      'password', 'pass', 'pwd', 'secret', 'token', 'accesstoken', 'refreshtoken',
      'clientsecret', 'consumersecret', 'tokensecret', 'securitytoken',
      'privatekey', 'certificate', 'apikey', 'authorization', 'auth', 'jwt', 'bearer',
    ]);

    const mask = (v: unknown) => (typeof v === 'string' && v.length > 4 ? v.slice(0, 2) + '***' + v.slice(-2) : '***');

    // Error instances have no enumerable `message`/`stack` properties, so
    // treating them as ordinary objects would render `{}` and erase the cause
    // from structured production logs. Project only bounded, allow-listed
    // diagnostics before applying the same recursive redaction as other
    // context. Arbitrary error messages and stacks are deliberately excluded:
    // connector/driver errors can embed credentials in either string.
    if (input instanceof Error) {
      return this.redactSensitive(this.projectErrorForLogging(input), depth + 1, seen);
    }

    if (Array.isArray(input)) {
      return input.map(v => this.redactSensitive(v, depth + 1, seen));
    }

    if (typeof input === 'object') {
      const obj = input as Record<string, unknown>;
      if (seen.has(obj)) return '[redacted]';
      seen.add(obj);
      const out: Record<string, unknown> = Array.isArray(input) ? [] as unknown as Record<string, unknown> : {};
      for (const [k, v] of Object.entries(obj)) {
        const keyNormalized = k.toLowerCase().replace(/[-_]/g, '');
        if (keyNormalized === 'stack') {
          // Error stacks repeat arbitrary messages and may contain credentials.
          continue;
        } else if (keyNormalized === 'error' && typeof v === 'string') {
          out[k] = { name: 'NonErrorThrown' };
        } else if (sensitiveKeys.has(keyNormalized)) {
          out[k] = mask(v);
        } else if (typeof v === 'object' && v !== null) {
          out[k] = this.redactSensitive(v, depth + 1, seen);
        } else {
          out[k] = v;
        }
      }
      return out;
    }

    return input;
  }

  private projectErrorForLogging(error: Error): Record<string, unknown> {
    const source = error as Error & Record<string, unknown>;
    const projected: Record<string, unknown> = { name: error.name };

    for (const key of ['errorCode', 'statusCode', 'code', 'errno', 'syscall', 'fileName']) {
      const value = source[key];
      if (typeof value === 'string' || typeof value === 'number') {
        projected[key] = value;
      }
    }

    // CardinalityViolationError owns a sanitized report contract. Preserve
    // only its operator-safe fields; do not spread the error or expose finding
    // messages, samples, values, or fingerprints.
    if (error.name === 'CardinalityViolationError') {
      if (Array.isArray(source.findings)) {
        projected.findings = source.findings.map((finding: unknown) => {
          const item = finding as Record<string, unknown>;
          return {
            ...(typeof item.type === 'string' ? { type: item.type } : {}),
            ...(typeof item.key === 'string' ? { key: item.key } : {}),
            ...(typeof item.severity === 'string' ? { severity: item.severity } : {}),
            ...(typeof item.overrideable === 'boolean' ? { overrideable: item.overrideable } : {}),
          };
        });
      }
      if (Array.isArray(source.unavailableChecks)) {
        projected.unavailableChecks = source.unavailableChecks.filter(
          (value): value is string => typeof value === 'string',
        );
      }
    }

    if (Array.isArray(source.validationErrors)) {
      projected.validationErrors = source.validationErrors.filter(
        (value): value is string => typeof value === 'string',
      );
    }

    return projected;
  }

  private sanitizeContext(context: LogContext): LogContext {
    // Preserve tracing ids as-is; redact other sensitive fields
    const enriched = this.enrichContextWithTracing(context);
    return this.redactSensitive(enriched) as LogContext;
  }

  /**
   * Logs with automatic context enrichment
   */
  info(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.logger.info(this.enrichContextWithTracing({}), context);
    } else {
      this.logger.info(this.sanitizeContext(context), message);
    }
  }

  warn(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.logger.warn(this.enrichContextWithTracing({}), context);
    } else {
      this.logger.warn(this.sanitizeContext(context), message);
    }
  }

  error(context: LogContext | string | Error, message?: string): void {
    const safeMessage = this.sanitizeErrorMessage(message);
    if (typeof context === 'string') {
      this.logger.error(this.enrichContextWithTracing({}), this.sanitizeErrorMessage(context));
    } else if (context instanceof Error) {
      this.logger.error(this.sanitizeContext({ error: context }), safeMessage);
    } else {
      this.logger.error(this.sanitizeContext(context), safeMessage);
    }
  }

  private sanitizeErrorMessage(message?: string): string | undefined {
    if (typeof message !== 'string') return message;
    const stackMarker = message.search(/\n\s*at\s|\bSTACK:[ \t\r\n]*/i);
    return stackMarker >= 0 ? message.slice(0, stackMarker).trim() : message;
  }

  debug(context: LogContext | string, message?: string): void {
    if (typeof context === 'string') {
      this.logger.debug(this.enrichContextWithTracing({}), context);
    } else {
      this.logger.debug(this.sanitizeContext(context), message);
    }
  }

  /**
   * Logs integration operation start
   */
  logIntegrationStart(integrationId: string, operationType: string, additionalContext?: LogContext): void {
    this.info({
      integrationId,
      operationType,
      phase: 'start',
      ...additionalContext,
    }, `Starting ${operationType} operation for integration ${integrationId}`);
  }

  /**
   * Logs integration operation completion
   */
  logIntegrationComplete(
    integrationId: string,
    operationType: string,
    duration: number,
    recordsProcessed?: number,
    additionalContext?: LogContext,
  ): void {
    this.info({
      integrationId,
      operationType,
      phase: 'complete',
      duration,
      recordsProcessed,
      ...additionalContext,
    }, `Completed ${operationType} operation for integration ${integrationId} in ${duration}ms`);
  }

  /**
   * Logs integration operation failure
   */
  logIntegrationError(
    integrationId: string,
    operationType: string,
    error: Error,
    duration?: number,
    additionalContext?: LogContext,
  ): void {
    this.error({
      integrationId,
      operationType,
      phase: 'error',
      error,
      duration,
      ...additionalContext,
    }, `Failed ${operationType} operation for integration ${integrationId}`);
  }

  /**
   * Logs authentication events
   */
  logAuthEvent(
    system: string,
    event: 'success' | 'failure' | 'refresh',
    duration?: number,
    additionalContext?: LogContext,
  ): void {
    const level = event === 'failure' ? 'warn' : 'info';
    this[level]({
      system,
      authEvent: event,
      duration,
      ...additionalContext,
    }, `Authentication ${event} for ${system}${duration ? ` (${duration}ms)` : ''}`);
  }

  /**
   * Logs data transformation events
   */
  logTransformation(
    transformationType: string,
    recordCount: number,
    duration: number,
    additionalContext?: LogContext,
  ): void {
    this.info({
      transformationType,
      recordCount,
      duration,
      phase: 'transformation',
      ...additionalContext,
    }, `Transformed ${recordCount} records using ${transformationType} in ${duration}ms`);
  }

  /**
   * Logs connector operation events
   */
  logConnectorOperation(
    connectorType: string,
    operation: string,
    status: 'start' | 'success' | 'error',
    duration?: number,
    recordCount?: number,
    error?: Error,
    additionalContext?: LogContext,
  ): void {
    const context = {
      connectorType,
      operation,
      status,
      duration,
      recordCount,
      error,
      ...additionalContext,
    };

    const message = `${connectorType} connector ${operation} ${status}${duration ? ` (${duration}ms)` : ''}${recordCount ? ` - ${recordCount} records` : ''}`;

    if (status === 'error') {
      this.error(context, message);
    } else {
      this.info(context, message);
    }
  }

  /**
   * Gets the underlying Pino logger instance
   */
  getLogger(): Logger {
    return this.logger;
  }

  /**
   * Flushes all pending log writes
   */
  async flush(): Promise<void> {
    return new Promise((resolve) => {
      this.logger.flush(() => resolve());
    });
  }

  /**
   * Cleanup method to properly close logger streams and workers
   */
  async shutdown(): Promise<void> {
  await safeCloseLogger(this.logger);
    // Flush any remaining logs
    await this.flush();
  }
}

// Decorator for automatic operation logging
export function Logged(operationName?: string, includeArgs = false) {
  return function (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const opName = operationName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      const loggingService = (this as any).loggingService as LoggingService;

      if (!loggingService) {
        return originalMethod.apply(this, args);
      }

      const startTime = Date.now();
      const context: LogContext = {
        operation: opName,
        className: target.constructor.name,
        methodName: propertyKey,
      };

      if (includeArgs && args.length > 0) {
        context.arguments = args.map(arg =>
          typeof arg === 'object' ? JSON.stringify(arg) : String(arg),
        );
      }

      loggingService.info(context, `Starting operation ${opName}`);

      try {
        const result = await originalMethod.apply(this, args);
        const duration = Date.now() - startTime;

        loggingService.info({
          ...context,
          duration,
          status: 'success',
        }, `Completed operation ${opName} in ${duration}ms`);

        return result;
      } catch (error) {
        const duration = Date.now() - startTime;

        loggingService.error({
          ...context,
          duration,
          status: 'error',
          error: error as Error,
        }, `Failed operation ${opName} after ${duration}ms`);

        throw error;
      }
    };

    return descriptor;
  };
}
