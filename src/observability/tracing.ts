import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import * as ResourceModule from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { trace, context, SpanStatusCode, SpanKind } from '@opentelemetry/api';
import type { Logger } from 'pino';

export interface TracingConfig {
  serviceName: string;
  serviceVersion: string;
  environment: string;
  otlpEndpoint?: string;
  prometheusEndpoint?: string;
  enableConsoleExporter?: boolean;
}

export class TracingService {
  private sdk: NodeSDK | null = null;
  private readonly tracer = trace.getTracer('integration-hub');
  private isInitialized = false;

  constructor(
    private readonly config: TracingConfig,
    private readonly logger: Logger,
  ) {}

  async initialize(): Promise<void> {
    if (this.isInitialized) {
      this.logger.warn('Tracing service already initialized');
      return;
    }

    // Check if telemetry is disabled
    if (process.env.DISABLE_TELEMETRY === 'true' || process.env.DISABLE_JAEGER === 'true') {
      this.logger.info('Telemetry/Jaeger disabled via environment variable');
      this.isInitialized = true;
      return;
    }

    try {
      // Use dynamic fallback to avoid type/export mismatches across versions
      const ResourceAny = (ResourceModule as unknown as { Resource?: unknown; default?: unknown } as any).Resource || (ResourceModule as any).default?.Resource || (ResourceModule as any).default;
      const resource = ResourceAny?.default?.().merge(new ResourceAny({
        [SemanticResourceAttributes.SERVICE_NAME]: this.config.serviceName,
        [SemanticResourceAttributes.SERVICE_VERSION]: this.config.serviceVersion,
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: this.config.environment,
      })) ?? undefined;

      const instrumentations = getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-fs': {
          enabled: false, // Disable to reduce noise
        },
      });

      // Remove metric reader for now to avoid compatibility issues
      // const metricReader = new PeriodicExportingMetricReader({
      //   exporter: new PrometheusExporter({
      //     endpoint: this.config.prometheusEndpoint || '/metrics',
      //   }),
      //   exportIntervalMillis: 5000,
      // });

      // OTLP/HTTP replaces the deprecated JaegerExporter (jaeger-client chain);
      // Jaeger >=1.35 ingests OTLP natively on port 4318. When no endpoint is
      // configured, pass no `url` so the exporter applies its own spec-standard
      // resolution (OTEL_EXPORTER_OTLP_TRACES_ENDPOINT / OTEL_EXPORTER_OTLP_ENDPOINT
      // env vars, then the http://localhost:4318/v1/traces default).
      const traceExporter = new OTLPTraceExporter(
        this.config.otlpEndpoint ? { url: this.config.otlpEndpoint } : {},
      );

      this.sdk = new NodeSDK({
        resource,
        instrumentations,
        traceExporter,
      });

      await this.sdk.start();
      this.isInitialized = true;

      this.logger.info({
        service: this.config.serviceName,
        version: this.config.serviceVersion,
        environment: this.config.environment,
      }, 'OpenTelemetry tracing initialized successfully');

    } catch (error) {
      this.logger.warn({ error }, 'Failed to initialize OpenTelemetry tracing - continuing without tracing');
      this.isInitialized = true; // Mark as initialized to prevent retries
    }
  }

  async shutdown(): Promise<void> {
    if (this.sdk) {
      try {
        await this.sdk.shutdown();
        this.logger.info('OpenTelemetry tracing shut down successfully');
      } catch (error) {
        this.logger.warn({ error }, 'Error shutting down OpenTelemetry tracing');
      }
    } else {
      this.logger.debug('No SDK to shutdown (telemetry was disabled or failed to initialize)');
    }
  }

  /**
   * Creates a new span for tracing operations
   */
  createSpan(name: string, attributes?: Record<string, string | number | boolean>) {
    return this.tracer.startSpan(name, {
      kind: SpanKind.INTERNAL,
      attributes,
    });
  }

  /**
   * Traces an async operation with automatic span management
   */
  async traceOperation<T>(
    operationName: string,
    operation: () => Promise<T>,
    attributes?: Record<string, string | number | boolean>,
  ): Promise<T> {
    const span = this.createSpan(operationName, attributes);

    try {
      const result = await context.with(trace.setSpan(context.active(), span), operation);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown error',
      });
      span.recordException(error as Error);
      throw error;
    } finally {
      span.end();
    }
  }

  /**
   * Adds attributes to the current active span
   */
  addSpanAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      Object.entries(attributes).forEach(([key, value]) => {
        span.setAttribute(key, value);
      });
    }
  }

  /**
   * Records an event in the current active span
   */
  recordSpanEvent(name: string, attributes?: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.addEvent(name, attributes);
    }
  }

  /**
   * Gets the current trace ID for correlation with logs
   */
  getCurrentTraceId(): string | undefined {
    const span = trace.getActiveSpan();
    if (span) {
      return span.spanContext().traceId;
    }
    return undefined;
  }

  /**
   * Gets the current span ID for correlation with logs
   */
  getCurrentSpanId(): string | undefined {
    const span = trace.getActiveSpan();
    if (span) {
      return span.spanContext().spanId;
    }
    return undefined;
  }
}

// Decorator for automatic method tracing
export function Traced(operationName?: string) {
  return function (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    // Using runtime constructor name for labeling only
    const spanName = operationName || `${(target as unknown as { constructor: { name?: string } }).constructor.name ?? 'Unknown'}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      const tracingService = (this as unknown as { tracingService?: TracingService }).tracingService as TracingService | undefined;

      if (!tracingService) {
        return originalMethod.apply(this, args);
      }

      return tracingService.traceOperation(
        spanName,
        () => originalMethod.apply(this, args as unknown[]),
        {
          'method.name': propertyKey,
          'class.name': (target as unknown as { constructor: { name?: string } }).constructor.name ?? 'Unknown',
      },
    );
    };

    return descriptor;
  };
}
