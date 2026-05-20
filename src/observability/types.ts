export interface LogContext {
  integrationId?: string;
  operationId?: string;
  userId?: string;
  correlationId?: string;
  [key: string]: unknown;
}

export interface LoggingConfig {
  level: 'debug' | 'info' | 'warn' | 'error';
  format?: 'json' | 'text';
  transports?: string[];
}

export interface MetricsConfig {
  enabled: boolean;
  interval?: number;
  prefix?: string;
  tags?: Record<string, string>;
}

export interface TracingConfig {
  enabled: boolean;
  serviceName: string;
  endpoint?: string;
  samplingRate?: number;
}

export interface ObservabilityConfig {
  tracing: TracingConfig;
  logging: LoggingConfig;
  metrics: MetricsConfig;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, error?: Error | unknown, context?: LogContext): void;
  child(context: LogContext): Logger;
}

export interface Timer {
  end(): number;
}

export interface MetricsService {
  recordIntegrationRun(
    integrationId: string,
    status: 'success' | 'failure' | 'cancelled',
    duration: number,
    recordsProcessed?: number,
  ): void;
  recordAuthenticationAttempt(system: string, success: boolean): void;
  recordTransformation(integrationId: string, count: number): void;
  recordConnectorOperation(connector: string, operation: string, duration: number): void;
  recordWebhookEvent(integrationId: string, event: string): void;
  setActiveIntegrations(count: number): void;
  incrementActiveIntegrations(): void;
  decrementActiveIntegrations(): void;
  setQueueDepth(queue: string, depth: number): void;
  updateConnectionPoolSize(connector: string, size: number): void;
  updateMemoryUsage(): void;
  createTimer(): Timer;
  recordCustomMetric(name: string, value: number, tags?: Record<string, string>): void;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
}

export interface Span {
  end(): void;
  setAttribute(key: string, value: string | number | boolean): void;
  setStatus(status: { code: number; message?: string }): void;
  recordException(error: Error): void;
}

export interface TracingService {
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  createSpan(name: string, attributes?: Record<string, unknown>): Span;
  traceOperation<T>(name: string, operation: () => Promise<T>): Promise<T>;
  addSpanAttributes(attributes: Record<string, unknown>): void;
  recordSpanEvent(name: string, attributes?: Record<string, unknown>): void;
  getCurrentTraceId(): string | undefined;
  getCurrentSpanId(): string | undefined;
}

export interface ObservabilityScope {
  logger: Logger;
  tracing: TracingService;
  metrics: MetricsService;
}

export interface IObservabilityService {
  readonly tracing: TracingService;
  readonly logging: Logger;
  readonly metrics: MetricsService;
  initialize(): Promise<void>;
  shutdown(): Promise<void>;
  createScope(context: LogContext): ObservabilityScope;
}