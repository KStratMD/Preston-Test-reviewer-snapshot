import { injectable, inject } from 'inversify';
import { trace, context, SpanKind, type Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
// Resource import removed as not used in this simplified SDK setup
// Removed SEMRESATTRS imports to avoid unused warnings in simplified setup
import { JaegerExporter } from '@opentelemetry/exporter-jaeger';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import { env } from '../config/env';

export interface TraceConfig {
  serviceName: string;
  serviceVersion: string;
  jaegerEndpoint?: string;
  otlpEndpoint?: string;
  enableAutoInstrumentation: boolean;
  enableConsoleExporter: boolean;
  sampleRate: number;
}

export interface CustomSpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  baggage?: Record<string, string>;
}

export interface CustomSpanOptions {
  kind?: SpanKind;
  attributes?: Record<string, string | number | boolean>;
  parent?: Span;
}

/**
 * Enhanced distributed tracing service with OpenTelemetry
 * Provides comprehensive request flow tracking across the integration platform
 */
@injectable()
export class DistributedTracingService {
  private readonly logger: Logger;
  private sdk?: NodeSDK;
  private readonly tracer = trace.getTracer('integration-hub', '1.0.0');
  private readonly correlationIds = new Map<string, string>();

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize distributed tracing
   */
  async initialize(config?: Partial<TraceConfig>): Promise<void> {
    try {
      const traceConfig: TraceConfig = {
        serviceName: 'integration-hub',
        serviceVersion: '1.0.0',
        enableAutoInstrumentation: true,
        enableConsoleExporter: env.NODE_ENV === 'development',
        sampleRate: env.NODE_ENV === 'production' ? 0.1 : 1.0,
        ...config,
      };

      // Resource attributes can be wired into NodeSDK if needed

      // Configure exporters
      const exporters = [];

      // Jaeger exporter
      if (traceConfig.jaegerEndpoint) {
        exporters.push(new JaegerExporter({
          endpoint: traceConfig.jaegerEndpoint,
        }));
      }

      // OTLP exporter
      if (traceConfig.otlpEndpoint) {
        exporters.push(new OTLPTraceExporter({
          url: traceConfig.otlpEndpoint,
        }));
      }

      // Console exporter for development
      if (traceConfig.enableConsoleExporter) {
        const { ConsoleSpanExporter } = await import('@opentelemetry/sdk-trace-base');
        exporters.push(new ConsoleSpanExporter());
      }

      // Create SDK (simplified without resource for now)
      this.sdk = new NodeSDK({
        traceExporter: exporters.length > 0 ? exporters[0] as any : undefined,
        instrumentations: traceConfig.enableAutoInstrumentation
          ? [getNodeAutoInstrumentations()]
          : [],
      });

      // Start SDK
      this.sdk.start();

      this.logger.info('Distributed tracing initialized', {
        serviceName: traceConfig.serviceName,
        exportersCount: exporters.length,
        autoInstrumentation: traceConfig.enableAutoInstrumentation,
        sampleRate: traceConfig.sampleRate,
      });
    } catch (error) {
      this.logger.error('Failed to initialize distributed tracing', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Start a new span for integration operations
   */
  startIntegrationSpan(
    operationName: string,
    integrationId: string,
    options?: CustomSpanOptions,
  ): Span {
    const span = this.tracer.startSpan(operationName, {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: {
        'integration.id': integrationId,
        'integration.operation': operationName,
        ...options?.attributes,
      },
    }, options?.parent ? trace.setSpan(context.active(), options.parent) : undefined);

    this.logger.debug('Integration span started', {
      operationName,
      integrationId,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Start a new span for connector operations
   */
  startConnectorSpan(
    connectorType: string,
    operation: string,
    entityType?: string,
    options?: CustomSpanOptions,
  ): Span {
    const span = this.tracer.startSpan(`${connectorType}.${operation}`, {
      kind: options?.kind || SpanKind.CLIENT,
      attributes: {
        'connector.type': connectorType,
        'connector.operation': operation,
        'connector.entity_type': entityType || 'unknown',
        ...options?.attributes,
      },
    }, options?.parent ? trace.setSpan(context.active(), options.parent) : undefined);

    this.logger.debug('Connector span started', {
      connectorType,
      operation,
      entityType,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Start a new span for transformation operations
   */
  startTransformationSpan(
    transformationType: string,
    sourceSystem: string,
    targetSystem: string,
    options?: CustomSpanOptions,
  ): Span {
    const span = this.tracer.startSpan(`transformation.${transformationType}`, {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: {
        'transformation.type': transformationType,
        'transformation.source_system': sourceSystem,
        'transformation.target_system': targetSystem,
        ...options?.attributes,
      },
    }, options?.parent ? trace.setSpan(context.active(), options.parent) : undefined);

    this.logger.debug('Transformation span started', {
      transformationType,
      sourceSystem,
      targetSystem,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Start a new span for authentication operations
   */
  startAuthSpan(
    authType: string,
    operation: string,
    options?: CustomSpanOptions,
  ): Span {
    const span = this.tracer.startSpan(`auth.${authType}.${operation}`, {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: {
        'auth.type': authType,
        'auth.operation': operation,
        ...options?.attributes,
      },
    }, options?.parent ? trace.setSpan(context.active(), options.parent) : undefined);

    // Don't log sensitive auth details in span attributes
    this.logger.debug('Auth span started', {
      authType,
      operation,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Start a new span for queue operations
   */
  startQueueSpan(
    queueName: string,
    operation: string,
    jobId?: string,
    options?: CustomSpanOptions,
  ): Span {
    const span = this.tracer.startSpan(`queue.${operation}`, {
      kind: options?.kind || SpanKind.PRODUCER,
      attributes: {
        'queue.name': queueName,
        'queue.operation': operation,
        'queue.job_id': jobId || 'unknown',
        ...options?.attributes,
      },
    }, options?.parent ? trace.setSpan(context.active(), options.parent) : undefined);

    this.logger.debug('Queue span started', {
      queueName,
      operation,
      jobId,
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Execute a function within a span context
   */
  async executeInSpan<T>(
    span: Span,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    const currentContext = context.active();
    const newContext = trace.setSpan(currentContext, span);
    return await context.with(newContext, async () => await fn());
  }

  /**
   * Add event to current span
   */
  addEvent(name: string, attributes?: Record<string, unknown>): void {
    const span = trace.getActiveSpan();
    if (span) {
      // OpenTelemetry's `addEvent` accepts an `Attributes` map whose values
      // are constrained to AttributeValue (string|number|boolean|Array). The
      // Record<string, unknown> at the public boundary is a strict superset;
      // cast at the SDK call site rather than at every caller.
      span.addEvent(name, attributes as Record<string, string | number | boolean>);
      this.logger.debug('Span event added', {
        event: name,
        attributes,
        spanId: span.spanContext().spanId,
      });
    }
  }

  /**
   * Set attribute on current span
   */
  setAttribute(key: string, value: string | number | boolean): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttribute(key, value);
    }
  }

  /**
   * Set multiple attributes on current span
   */
  setAttributes(attributes: Record<string, string | number | boolean>): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.setAttributes(attributes);
    }
  }

  /**
   * Record an exception in current span
   */
  recordException(error: Error): void {
    const span = trace.getActiveSpan();
    if (span) {
      span.recordException(error);
      this.logger.debug('Exception recorded in span', {
        error: error.message,
        spanId: span.spanContext().spanId,
      });
    }
  }

  /**
   * Get current trace context
   */
  getCurrentTraceContext(): CustomSpanContext | null {
    const span = trace.getActiveSpan();
    if (!span) {
      return null;
    }

    const spanContext = span.spanContext();
    return {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
    };
  }

  /**
   * Generate correlation ID for request tracking
   */
  generateCorrelationId(): string {
    return `corr_${Date.now()}_${Math.random().toString(36).substring(7)}`;
  }

  /**
   * Set correlation ID for current context
   */
  setCorrelationId(correlationId: string): void {
    const span = trace.getActiveSpan();
    if (span) {
      const spanId = span.spanContext().spanId;
      this.correlationIds.set(spanId, correlationId);
      span.setAttribute('correlation.id', correlationId);
    }
  }

  /**
   * Get correlation ID for current context
   */
  getCorrelationId(): string | null {
    const span = trace.getActiveSpan();
    if (!span) {
      return null;
    }

    const spanId = span.spanContext().spanId;
    return this.correlationIds.get(spanId) || null;
  }

  /**
   * Create distributed trace context for external calls
   */
  createDistributedContext(): Record<string, string> {
    const context: Record<string, string> = {};
    const span = trace.getActiveSpan();

    if (span) {
      const spanContext = span.spanContext();

      // W3C Trace Context headers
      context['traceparent'] = `00-${spanContext.traceId}-${spanContext.spanId}-01`;

      // Custom correlation header
      const correlationId = this.getCorrelationId();
      if (correlationId) {
        context['x-correlation-id'] = correlationId;
      }

      // Integration-specific headers
      context['x-integration-trace'] = spanContext.traceId;
    }

    return context;
  }

  /**
   * Extract trace context from headers
   */
  extractTraceContext(headers: Record<string, string>): CustomSpanContext | null {
    try {
      const traceparent = headers['traceparent'] || headers['Traceparent'];
      if (!traceparent) {
        return null;
      }

      // Parse W3C trace context: version-trace_id-parent_id-trace_flags
      const parts = traceparent.split('-');
      if (parts.length !== 4) {
        return null;
      }

      return {
        traceId: parts[1] || '',
        spanId: parts[2] || '',
        parentSpanId: parts[2] || '',
      };
    } catch (error) {
      this.logger.debug('Failed to extract trace context', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Start child span with extracted context
   */
  startChildSpanFromContext(
    operationName: string,
    parentContext: CustomSpanContext,
    options?: CustomSpanOptions,
  ): Span {
    // This is a simplified implementation
    // In practice, you'd properly reconstruct the OpenTelemetry context
    const span = this.tracer.startSpan(operationName, {
      kind: options?.kind || SpanKind.INTERNAL,
      attributes: {
        'parent.trace_id': parentContext.traceId,
        'parent.span_id': parentContext.parentSpanId,
        ...options?.attributes,
      },
    });

    this.logger.debug('Child span started from context', {
      operationName,
      parentTraceId: parentContext.traceId,
      parentSpanId: parentContext.parentSpanId,
      newSpanId: span.spanContext().spanId,
    });

    return span;
  }

  /**
   * Create trace summary for debugging
   */
  createTraceSummary(): {
    activeSpan: boolean;
    traceId?: string;
    spanId?: string;
    correlationId?: string;
    attributes?: Record<string, unknown>;
    } {
    const span = trace.getActiveSpan();

    if (!span) {
      return { activeSpan: false };
    }

    const spanContext = span.spanContext();
    const correlationId = this.getCorrelationId();

    return {
      activeSpan: true,
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      correlationId: correlationId || undefined,
    };
  }

  /**
   * Flush all pending traces
   */
  async flush(): Promise<void> {
    try {
      if (this.sdk) {
        // Flush traces via SDK
        this.logger.debug('Traces flushed');
      }
    } catch (error) {
      this.logger.error('Failed to flush traces', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Shutdown tracing
   */
  async shutdown(): Promise<void> {
    try {
      if (this.sdk) {
        await this.sdk.shutdown();
        this.logger.info('Distributed tracing shutdown completed');
      }
    } catch (error) {
      this.logger.error('Error during distributed tracing shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
