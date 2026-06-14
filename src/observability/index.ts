export { LoggingService, Logged } from './logging';
export type { LoggingConfig, LogContext } from './types';
import type {
  MetricsService as IMetricsService,
  TracingService as ITracingService,
  ObservabilityConfig,
  IObservabilityService,
  ObservabilityScope,
  LogContext,
  Logger
} from './types';

export type { ObservabilityConfig, IObservabilityService, ObservabilityScope } from './types';

let MetricsServiceImport: typeof import('./metrics').MetricsService | null = null;
let MeteredDecorator: typeof import('./metrics').Metered | null = null;
try {
  if (!process.env.DEMO_NO_OTEL) {
    const metricsMod = require('./metrics');
    MetricsServiceImport = metricsMod.MetricsService;
    MeteredDecorator = metricsMod.Metered;
  }
} catch (_err) {
  MetricsServiceImport = null;
  MeteredDecorator = null;
}

export const Metered: typeof MeteredDecorator = MeteredDecorator ?? ((metricName?: string) => () => {}) as any;

let TracingServiceImport: typeof import('./tracing').TracingService | null = null;
try {
  // Make tracing optional in demo environments where OTEL packages are not installed
  if (!process.env.DEMO_NO_OTEL) {
    TracingServiceImport = require('./tracing').TracingService;
  }
} catch (err) {
  TracingServiceImport = null;
}

import { LoggingService } from './logging';

export class ObservabilityService implements IObservabilityService {
  public readonly tracing: ITracingService;
  public readonly logging: Logger;
  public readonly metrics: IMetricsService;

  constructor(config: ObservabilityConfig) {
    // Initialize logging first (no dependencies)
    this.logging = new LoggingService(config.logging as any) as unknown as Logger;

    // Initialize tracing with logger if available, otherwise use a no-op
    if (TracingServiceImport) {
      this.tracing = new TracingServiceImport(config.tracing as any, (this.logging as any).getLogger()) as ITracingService;
    } else {
      // Minimal no-op tracing implementation for demo runs
      this.tracing = {
        initialize: async () => { (this.logging as any).info('Tracing disabled (DEMO_NO_OTEL=1 or missing packages)'); },
        shutdown: async () => {},
        createSpan: () => ({
          end: () => {},
          setAttribute: () => {},
          setStatus: () => {},
          recordException: () => {}
        }),
        traceOperation: async (_name: string, op: () => Promise<unknown>) => op(),
        addSpanAttributes: () => {},
        recordSpanEvent: () => {},
        getCurrentTraceId: () => undefined,
        getCurrentSpanId: () => undefined,
      } as ITracingService;
    }

    // Initialize metrics with logger if available, otherwise use a no-op
    if (MetricsServiceImport) {
      this.metrics = new MetricsServiceImport(config.metrics as any, (this.logging as any).getLogger()) as unknown as IMetricsService;
    } else {
      this.metrics = {
        recordIntegrationRun: () => {},
        recordAuthenticationAttempt: () => {},
        recordTransformation: () => {},
        recordConnectorOperation: () => {},
        recordWebhookEvent: () => {},
        setActiveIntegrations: () => {},
        incrementActiveIntegrations: () => {},
        decrementActiveIntegrations: () => {},
        setQueueDepth: () => {},
        updateConnectionPoolSize: () => {},
        updateMemoryUsage: () => {},
        createTimer: () => ({ end: () => 0 }),
        recordCustomMetric: () => {},
        initialize: async () => {},
        shutdown: async () => {},
      } as IMetricsService;
    }
  }

  async initialize(): Promise<void> {
    await this.tracing.initialize();
    await this.metrics.initialize();
    (this.logging as any).info('Observability services initialized');
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.tracing.shutdown(),
      this.metrics.shutdown(),
      (this.logging as any).flush(),
    ]);
  }

  /**
   * Creates a scoped observability context for operations
   */
  createScope(context: LogContext): ObservabilityScope {
    const childLogger = (this.logging as any).createChildLogger(context);

    return {
      logger: childLogger,
      tracing: this.tracing,
      metrics: this.metrics,
    };
  }
}