import type { ObservabilityConfig } from '../observability';

export const observabilityConfig: ObservabilityConfig = {
  tracing: {
    enabled: process.env.ENABLE_TRACING !== 'false' && process.env.DISABLE_TELEMETRY !== 'true' && process.env.DISABLE_JAEGER !== 'true',
    serviceName: process.env.SERVICE_NAME || 'integration-hub',
    endpoint: process.env.JAEGER_ENDPOINT,
    samplingRate: parseFloat(process.env.TRACING_SAMPLE_RATE || '1.0'),
  },
  logging: {
    level: (process.env.LOG_LEVEL as 'debug' | 'info' | 'warn' | 'error') || 'info',
    format: process.env.NODE_ENV === 'production' ? 'json' : 'text',
    transports: process.env.ENABLE_FILE_LOGGING === 'true' ? ['console', 'file'] : ['console'],
  },
  metrics: {
    enabled: process.env.ENABLE_METRICS !== 'false',
    interval: parseInt(process.env.METRICS_INTERVAL || '60000'),
    prefix: process.env.METRICS_PREFIX || 'integration_hub',
    tags: {
      environment: process.env.NODE_ENV || 'development',
      service: process.env.SERVICE_NAME || 'integration-hub',
    },
  },
};

export const observabilityMiddlewareConfig = {
  correlationIdHeader: process.env.CORRELATION_ID_HEADER || 'x-correlation-id',
  enableRequestLogging: process.env.ENABLE_REQUEST_LOGGING !== 'false',
  enableMetrics: process.env.ENABLE_HTTP_METRICS !== 'false',
  enableTracing: process.env.ENABLE_HTTP_TRACING !== 'false',
  excludePaths: ['/health', '/metrics', '/favicon.ico', '/ping'],
};
