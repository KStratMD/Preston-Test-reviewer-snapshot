import { metrics, type Meter, type Counter, type Histogram, type UpDownCounter } from '@opentelemetry/api';
import type { Logger } from 'pino';

export interface MetricsConfig {
  serviceName: string;
  enableCustomMetrics: boolean;
  metricsPrefix?: string;
}

export class MetricsService {
  private readonly meter: Meter;
  private readonly metricsPrefix: string;
  private initialized = false;

  // Business metrics
  private integrationRunsTotal!: Counter;
  private integrationRunDuration!: Histogram;
  private recordsProcessedTotal!: Counter;
  private authenticationAttemptsTotal!: Counter;
  private authenticationFailuresTotal!: Counter;
  private transformationDuration!: Histogram;
  private connectorOperationsTotal!: Counter;
  private connectorErrorsTotal!: Counter;
  private webhookEventsTotal!: Counter;

  // System metrics
  private activeIntegrations!: UpDownCounter;
  private queueDepth!: UpDownCounter;
  private connectionPoolSize!: UpDownCounter;
  private memoryUsage!: UpDownCounter;

  // Internal state trackers for system metrics
  private currentActiveIntegrations = 0;
  private currentQueueDepth = 0;
  private currentConnectionPoolSize = 0;
  private currentMemoryUsage = 0;

  constructor(
    private readonly config: MetricsConfig,
    private readonly logger: Logger,
  ) {
    this.metricsPrefix = config.metricsPrefix || 'integration_hub';
    this.meter = metrics.getMeter(config.serviceName, '1.0.0');
    this.initializeMetrics();
    this.initialized = true;
  }

  private initializeMetrics(): void {
    // Business metrics
    this.integrationRunsTotal = this.meter.createCounter(
      `${this.metricsPrefix}_integration_runs_total`,
      {
        description: 'Total number of integration runs',
        unit: '1',
      },
    );

    this.integrationRunDuration = this.meter.createHistogram(
      `${this.metricsPrefix}_integration_run_duration_ms`,
      {
        description: 'Duration of integration runs in milliseconds',
        unit: 'ms',
      },
    );

    this.recordsProcessedTotal = this.meter.createCounter(
      `${this.metricsPrefix}_records_processed_total`,
      {
        description: 'Total number of records processed',
        unit: '1',
      },
    );

    this.authenticationAttemptsTotal = this.meter.createCounter(
      `${this.metricsPrefix}_auth_attempts_total`,
      {
        description: 'Total number of authentication attempts',
        unit: '1',
      },
    );

    this.authenticationFailuresTotal = this.meter.createCounter(
      `${this.metricsPrefix}_auth_failures_total`,
      {
        description: 'Total number of authentication failures',
        unit: '1',
      },
    );

    this.transformationDuration = this.meter.createHistogram(
      `${this.metricsPrefix}_transformation_duration_ms`,
      {
        description: 'Duration of data transformations in milliseconds',
        unit: 'ms',
      },
    );

    this.connectorOperationsTotal = this.meter.createCounter(
      `${this.metricsPrefix}_connector_operations_total`,
      {
        description: 'Total number of connector operations',
        unit: '1',
      },
    );

    this.connectorErrorsTotal = this.meter.createCounter(
      `${this.metricsPrefix}_connector_errors_total`,
      {
        description: 'Total number of connector errors',
        unit: '1',
      },
    );

    this.webhookEventsTotal = this.meter.createCounter(
      `${this.metricsPrefix}_webhook_events_total`,
      {
        description: 'Total number of webhook events received',
        unit: '1',
      },
    );

    // System metrics
    this.activeIntegrations = this.meter.createUpDownCounter(
      `${this.metricsPrefix}_active_integrations`,
      {
        description: 'Number of currently active integrations',
        unit: '1',
      },
    );

    this.queueDepth = this.meter.createUpDownCounter(
      `${this.metricsPrefix}_queue_depth`,
      {
        description: 'Current depth of processing queues',
        unit: '1',
      },
    );

    this.connectionPoolSize = this.meter.createUpDownCounter(
      `${this.metricsPrefix}_connection_pool_size`,
      {
        description: 'Current size of connection pools',
        unit: '1',
      },
    );

    this.memoryUsage = this.meter.createUpDownCounter(
      `${this.metricsPrefix}_memory_usage_bytes`,
      {
        description: 'Current memory usage in bytes',
        unit: 'bytes',
      },
    );

    this.logger.info('Metrics service initialized with custom metrics');
  }

  async initialize(): Promise<void> {
    if (!this.initialized) {
      this.initializeMetrics();
      this.initialized = true;
    }
  }

  async shutdown(): Promise<void> {
    // No explicit shutdown behavior required for current OTEL bindings.
  }

  // Business metric methods
  recordIntegrationRun(
    integrationId: string,
    status: 'success' | 'failure' | 'cancelled',
    duration: number,
    recordsProcessed = 0,
  ): void {
    const labels = {
      integration_id: integrationId,
      status,
    };

    this.integrationRunsTotal.add(1, labels);
    this.integrationRunDuration.record(duration, labels);

    if (recordsProcessed > 0) {
      this.recordsProcessedTotal.add(recordsProcessed, {
        integration_id: integrationId,
        operation: 'sync',
      });
    }
  }

  recordAuthenticationAttempt(
    system: string,
    authType: string,
    success: boolean,
    _duration: number,
  ): void {
    const labels = {
      system,
      auth_type: authType,
    };

    this.authenticationAttemptsTotal.add(1, labels);

    if (!success) {
      this.authenticationFailuresTotal.add(1, labels);
    }
  }

  recordTransformation(
    transformationType: string,
    duration: number,
    recordCount: number,
    success: boolean,
  ): void {
    const labels = {
      transformation_type: transformationType,
      status: success ? 'success' : 'failure',
    };

    this.transformationDuration.record(duration, labels);

    if (success) {
      this.recordsProcessedTotal.add(recordCount, {
        operation: 'transformation',
        type: transformationType,
      });
    }
  }

  recordConnectorOperation(
    connectorType: string,
    operation: string,
    success: boolean,
    duration: number,
    recordCount?: number,
  ): void {
    const labels = {
      connector_type: connectorType,
      operation,
      status: success ? 'success' : 'failure',
    };

    this.connectorOperationsTotal.add(1, labels);

    if (!success) {
      this.connectorErrorsTotal.add(1, labels);
    }

    if (recordCount !== undefined) {
      this.recordsProcessedTotal.add(recordCount, {
        connector_type: connectorType,
        operation,
      });
    }
  }

  recordWebhookEvent(
    system: string,
    eventType: string,
    success: boolean,
  ): void {
    const labels = {
      system,
      event_type: eventType,
      status: success ? 'success' : 'failure',
    };

    this.webhookEventsTotal.add(1, labels);
  }

  // System metric methods
  setActiveIntegrations(count: number): void {
    const delta = count - this.currentActiveIntegrations;
    this.activeIntegrations.add(delta);
    this.currentActiveIntegrations = count;
  }

  incrementActiveIntegrations(): void {
    this.activeIntegrations.add(1);
    this.currentActiveIntegrations += 1;
  }

  decrementActiveIntegrations(): void {
    this.activeIntegrations.add(-1);
    this.currentActiveIntegrations = Math.max(0, this.currentActiveIntegrations - 1);
  }

  setQueueDepth(queueName: string, depth: number): void {
    // For simplicity, we'll use the total depth across all queues
    const delta = depth - this.currentQueueDepth;
    this.queueDepth.add(delta, {
      queue_name: queueName,
    });
    this.currentQueueDepth = depth;
  }

  updateConnectionPoolSize(poolName: string, size: number): void {
    const delta = size - this.currentConnectionPoolSize;
    this.connectionPoolSize.add(delta, {
      pool_name: poolName,
    });
    this.currentConnectionPoolSize = size;
  }

  updateMemoryUsage(): void {
    const memUsage = process.memoryUsage();
    const heapUsed = memUsage.heapUsed;
    const delta = heapUsed - this.currentMemoryUsage;
    this.memoryUsage.add(delta, {
      type: 'heap_used',
    });
    this.currentMemoryUsage = heapUsed;
  }

  // Helper methods to get current values (simplified - in production you'd track these properly)
  private getCurrentActiveIntegrations(): number {
    return this.currentActiveIntegrations;
  }

  private getCurrentQueueDepth(): number {
    return this.currentQueueDepth;
  }

  private getCurrentConnectionPoolSize(): number {
    return this.currentConnectionPoolSize;
  }

  private getCurrentMemoryUsage(): number {
    return this.currentMemoryUsage;
  }

  /**
   * Creates a timer for measuring operation duration
   */
  createTimer(): { end: () => number } {
    const start = Date.now();
    return {
      end: () => Date.now() - start,
    };
  }

  /**
   * Records custom metric
   */
  recordCustomMetric(
    name: string,
    value: number,
    labels: Record<string, string> = {},
    type: 'counter' | 'gauge' | 'histogram' = 'counter',
  ): void {
    if (!this.config.enableCustomMetrics) {
      return;
    }

    const metricName = `${this.metricsPrefix}_custom_${name}`;

    try {
      switch (type) {
      case 'counter':
        const counter = this.meter.createCounter(metricName);
        counter.add(value, labels);
        break;
      case 'gauge':
        const gauge = this.meter.createUpDownCounter(metricName);
        gauge.add(value, labels);
        break;
      case 'histogram':
        const histogram = this.meter.createHistogram(metricName);
        histogram.record(value, labels);
        break;
      }
    } catch (error) {
      this.logger.warn({ error, metricName, value, labels }, 'Failed to record custom metric');
    }
  }

  /**
   * Gets basic system metrics for health checks
   */
  getSystemMetrics(): {
    memoryUsage: NodeJS.MemoryUsage;
    uptime: number;
    cpuUsage: NodeJS.CpuUsage;
    } {
    return {
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      cpuUsage: process.cpuUsage(),
    };
  }
}

// Decorator for automatic metric recording
export function Metered(metricName?: string, recordDuration = true) {
  return function (target: unknown, propertyKey: string, descriptor: PropertyDescriptor) {
    const originalMethod = descriptor.value;
    const opName = metricName || `${target.constructor.name}.${propertyKey}`;

    descriptor.value = async function (...args: unknown[]) {
      const metricsService = (this as any).metricsService as MetricsService;

      if (!metricsService) {
        return originalMethod.apply(this, args);
      }

      const timer = metricsService.createTimer();
      let success = true;

      try {
        const result = await originalMethod.apply(this, args);
        return result;
      } catch (error) {
        success = false;
        throw error;
      } finally {
        if (recordDuration) {
          const duration = timer.end();
          metricsService.recordCustomMetric(
            `${opName}_duration_ms`,
            duration,
            {
              method: propertyKey,
              class: target.constructor.name,
              status: success ? 'success' : 'failure',
            },
            'histogram',
          );
        }

        metricsService.recordCustomMetric(
          `${opName}_calls_total`,
          1,
          {
            method: propertyKey,
            class: target.constructor.name,
            status: success ? 'success' : 'failure',
          },
          'counter',
        );
      }
    };

    return descriptor;
  };
}
