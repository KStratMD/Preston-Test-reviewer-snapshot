import type { 
  IObservabilityService, 
  TracingService, 
  MetricsService, 
  Logger,
  ObservabilityScope,
  LogContext,
  Span
} from './types';

/**
 * Minimal demo observability adapter used in lightweight/demo runs.
 * Provides the small API surface the middleware and routes expect so tests
 * and demo runs don't need heavy OTEL packages.
 */
export class DemoObservabilityAdapter implements IObservabilityService {
  async initialize(): Promise<void> {}
  async shutdown(): Promise<void> {}

  tracing: TracingService = {
    initialize: async () => {},
    shutdown: async () => {},
    createSpan: (_name?: string, _attrs?: Record<string, unknown>): Span => ({
      setAttribute: (_key: string, _value: string | number | boolean) => {},
      setStatus: (_status: { code: number; message?: string }) => {},
      recordException: (_error: Error) => {},
      end: () => {},
    }),
    traceOperation: async <T>(_name: string, op: () => Promise<T>): Promise<T> => op(),
    addSpanAttributes: (_: Record<string, unknown>) => {},
    recordSpanEvent: (_: string, __?: Record<string, unknown>) => {},
    getCurrentTraceId: () => undefined,
    getCurrentSpanId: () => undefined,
  };

  metrics: MetricsService = {
    recordIntegrationRun: (
      _integrationId: string,
      _status: 'success' | 'failure' | 'cancelled',
      _duration: number,
      _recordsProcessed?: number,
    ) => {},
    recordAuthenticationAttempt: (_system: string, _success: boolean) => {},
    recordTransformation: (_integrationId: string, _count: number) => {},
    recordConnectorOperation: (_connector: string, _operation: string, _duration: number) => {},
    recordWebhookEvent: (_integrationId: string, _event: string) => {},
    setActiveIntegrations: (_count: number) => {},
    incrementActiveIntegrations: () => {},
    decrementActiveIntegrations: () => {},
    setQueueDepth: (_queue: string, _depth: number) => {},
    updateConnectionPoolSize: (_connector: string, _size: number) => {},
    updateMemoryUsage: () => {},
    createTimer: () => ({ end: () => 0 }),
    recordCustomMetric: (_name: string, _value: number, _tags?: Record<string, string>) => {},
    initialize: async () => {},
    shutdown: async () => {},
  };

  private createMockLogger = (): Logger => ({
    info: (_message: string, _context?: LogContext) => {},
    warn: (_message: string, _context?: LogContext) => {},
    error: (_message: string, _error?: Error | unknown, _context?: LogContext) => {},
    debug: (_message: string, _context?: LogContext) => {},
    child: (_context: LogContext) => this.createMockLogger(),
  });

  logging: Logger = this.createMockLogger();

  createScope(_context: LogContext): ObservabilityScope {
    return {
      logger: this.createMockLogger(),
      tracing: this.tracing,
      metrics: this.metrics,
    };
  }
}