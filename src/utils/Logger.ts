import crypto from "crypto";
import { env } from "../config";
import { LoggingService, type LogContext } from "../observability/logging";

/**
 * Log metadata structure used across the application.
 */
export interface LogMetadata extends LogContext, Record<string, unknown> {}

type LevelAdjustableLogger = { level?: string };

/**
 * Wrapper around the Pino based LoggingService providing a drop-in
 * replacement for the previous winston implementation. It maintains the
 * same method signatures so existing modules can remain unchanged while the
 * underlying logging provider is consolidated.
 */
export class Logger {
  private readonly service: LoggingService;
  private readonly baseContext: LogContext;
  private correlationId?: string;

  constructor(context = "IntegrationHub", service?: LoggingService) {
    this.service = service ?? new LoggingService({
      level: env.LOG_LEVEL || "info",
      environment: env.NODE_ENV || "development",
      enableConsole: true,
    });

    this.baseContext = { context };
  }

  /**
   * Adjust log level at runtime.
   */
  setLevel(level: string): void {
    try {
      const underlying = this.service.getLogger() as unknown;
      if (underlying && typeof underlying === "object" && "level" in (underlying as LevelAdjustableLogger)) {
        (underlying as LevelAdjustableLogger).level = level;
      }
    } catch {
      // no-op if underlying logger does not support dynamic level
    }
  }

  private shouldSuppress(message: string): boolean {
    try {
      const isTest = process.env.NODE_ENV === 'test';
      const silence = process.env.SILENCE_ROUTE_SETUP !== '0';
      if (!isTest || !silence) return false;
      return typeof message === 'string' && message.includes('[routes]');
    } catch {
      return false;
    }
  }

  /**
   * Emit an info level log message.
   */
  info(message: string, metadata: LogMetadata = {}): void {
    if (this.shouldSuppress(message)) return;
    this.service.info({ ...this.baseContext, ...metadata, correlationId: this.correlationId }, message);
  }

  /**
   * Emit a warn level log message.
   */
  warn(message: string, metadata: LogMetadata = {}): void {
    if (this.shouldSuppress(message)) return;
    this.service.warn({ ...this.baseContext, ...metadata, correlationId: this.correlationId }, message);
  }

  /**
   * Emit an error level log message. If an Error instance is provided it will
   * be attached to the structured log context.
   */
  error(message: string, error?: unknown, metadata: LogMetadata = {}): void {
    if (this.shouldSuppress(message)) return;
    const context: LogMetadata = { ...this.baseContext, ...metadata, correlationId: this.correlationId };
    if (error instanceof Error) {
      context.error = error;
    }
    this.service.error(context, message);
  }

  /**
   * Emit a debug level log message.
   */
  debug(message: string, metadata: LogMetadata = {}): void {
    this.service.debug({ ...this.baseContext, ...metadata, correlationId: this.correlationId }, message);
  }

  /**
   * Create a logger instance bound to a correlation identifier. If no id is
   * supplied one will be generated.
   */
  withCorrelationId(correlationId?: string): Logger {
    const hasRandomUUID = typeof (crypto as unknown as { randomUUID?: () => string }).randomUUID === "function";
    const id = correlationId ?? (
      hasRandomUUID ? (crypto as unknown as { randomUUID: () => string }).randomUUID() : Date.now().toString()
    );
    const child = new Logger(this.baseContext.context as string, this.service);
    child.correlationId = id;
    return child;
  }

  /**
   * Retrieve the active correlation identifier for this logger.
   */
  getCorrelationId(): string | undefined {
    return this.correlationId;
  }
}

/**
 * Factory to create a logger with a specific context.
 */
export function createLogger(context = "IntegrationHub"): Logger {
  return new Logger(context);
}

/**
 * Default singleton logger for backward compatibility.
 */
export const logger: Logger = createLogger();
