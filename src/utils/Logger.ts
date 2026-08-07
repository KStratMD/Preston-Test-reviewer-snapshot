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
   * Emit an error level log message. An Error instance is attached to the
   * structured log context as `error`; a plain-object 2nd arg is merged into
   * the context (explicit `metadata` keys and the correlationId win); any
   * other defined value is attached verbatim as `error`. Previously only
   * Error instances were honored and everything else was silently dropped —
   * an AST sweep found 497 callsites relying on the `{ error }` object shape.
   */
  error(message: string, error?: unknown, metadata: LogMetadata = {}): void {
    if (this.shouldSuppress(message)) return;
    const context: LogMetadata = { ...this.baseContext, ...metadata, correlationId: this.correlationId };
    if (error instanceof Error) {
      context.error = error;
    } else if (isPlainObject(error)) {
      for (const [key, value] of Object.entries(error)) {
        // `key in context` keeps the merge additive-only — baseContext,
        // explicit metadata, and correlationId can't be clobbered, and
        // prototype-chain hits (`__proto__`, `constructor`, `toString`, …)
        // are skipped so a deserialized payload can't mutate the context's
        // prototype. UNSAFE_MERGE_KEYS catches `prototype`, which plain
        // objects don't inherit.
        if (UNSAFE_MERGE_KEYS.has(key) || key in context) continue;
        context[key] = value;
      }
    } else if (error !== undefined) {
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
 * Keys never merged from a 2nd-arg object into the log context. `__proto__`
 * and `constructor` are already excluded by the `key in context`
 * prototype-chain check; `prototype` is listed here because plain objects
 * don't inherit it.
 */
const UNSAFE_MERGE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A merge-eligible 2nd arg for Logger.error: object literals like
 * `{ error, vendorId }`. Arrays and class instances (non-Error) are NOT
 * merged — their enumerable keys are not meaningful log fields — and attach
 * verbatim as `context.error` instead.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
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
