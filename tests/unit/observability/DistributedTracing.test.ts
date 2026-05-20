/**
 * DistributedTracingService Unit Tests
 * Tests for distributed tracing functionality
 */

import 'reflect-metadata';
import type { Logger } from '../../../src/utils/Logger';

// Define mockSpan before mocking
const mockSpan = {
  spanContext: jest.fn().mockReturnValue({
    traceId: 'abc123def456',
    spanId: 'span789',
  }),
  addEvent: jest.fn(),
  setAttribute: jest.fn(),
  setAttributes: jest.fn(),
  recordException: jest.fn(),
  end: jest.fn(),
};

const mockTracer = {
  startSpan: jest.fn().mockReturnValue(mockSpan),
};

// Mock OpenTelemetry API
jest.mock('@opentelemetry/api', () => ({
  trace: {
    getTracer: jest.fn().mockReturnValue(mockTracer),
    getActiveSpan: jest.fn(),
    setSpan: jest.fn().mockImplementation((_ctx, span) => ({ span })),
  },
  context: {
    active: jest.fn().mockReturnValue({}),
    with: jest.fn().mockImplementation((_ctx, fn) => fn()),
  },
  SpanKind: {
    INTERNAL: 0,
    SERVER: 1,
    CLIENT: 2,
    PRODUCER: 3,
    CONSUMER: 4,
  },
}));

jest.mock('@opentelemetry/sdk-node', () => ({
  NodeSDK: jest.fn().mockImplementation(() => ({
    start: jest.fn(),
    shutdown: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('@opentelemetry/exporter-jaeger', () => ({
  JaegerExporter: jest.fn(),
}));

jest.mock('@opentelemetry/exporter-trace-otlp-http', () => ({
  OTLPTraceExporter: jest.fn(),
}));

jest.mock('@opentelemetry/auto-instrumentations-node', () => ({
  getNodeAutoInstrumentations: jest.fn().mockReturnValue([]),
}));

jest.mock('@opentelemetry/sdk-trace-base', () => ({
  ConsoleSpanExporter: jest.fn(),
}));

jest.mock('../../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
  },
}));

// Import after mocks are set up
import { DistributedTracingService } from '../../../src/observability/DistributedTracing';
import { SpanKind } from '@opentelemetry/api';

describe('DistributedTracingService', () => {
  let service: DistributedTracingService;
  let mockLogger: Logger;
  let traceMock: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Reset mockSpan mock return values
    mockSpan.spanContext.mockReturnValue({
      traceId: 'abc123def456',
      spanId: 'span789',
    });

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;

    service = new DistributedTracingService(mockLogger);

    // Get reference to trace mock
    traceMock = require('@opentelemetry/api').trace;
    traceMock.getTracer.mockReturnValue(mockTracer);
    mockTracer.startSpan.mockReturnValue(mockSpan);
  });

  describe('constructor', () => {
    it('should initialize with logger', () => {
      expect(service).toBeDefined();
    });
  });

  describe('initialize()', () => {
    it('should initialize with default config', async () => {
      await service.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Distributed tracing initialized',
        expect.any(Object)
      );
    });

    it('should initialize with custom config', async () => {
      await service.initialize({
        serviceName: 'custom-service',
        serviceVersion: '2.0.0',
        sampleRate: 0.5,
      });

      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should initialize with Jaeger endpoint', async () => {
      await service.initialize({
        jaegerEndpoint: 'http://jaeger:14268',
      });

      const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
      expect(JaegerExporter).toHaveBeenCalledWith(
        expect.objectContaining({ endpoint: 'http://jaeger:14268' })
      );
    });

    it('should initialize with OTLP endpoint', async () => {
      await service.initialize({
        otlpEndpoint: 'http://collector:4318',
      });

      const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
      expect(OTLPTraceExporter).toHaveBeenCalledWith(
        expect.objectContaining({ url: 'http://collector:4318' })
      );
    });

    it('should initialize with console exporter', async () => {
      await service.initialize({
        enableConsoleExporter: true,
      });

      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should handle initialization error', async () => {
      const { NodeSDK } = require('@opentelemetry/sdk-node');
      NodeSDK.mockImplementationOnce(() => {
        throw new Error('Init failed');
      });

      await expect(service.initialize()).rejects.toThrow('Init failed');
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('startIntegrationSpan()', () => {
    it('should start span with operation name and integration ID', () => {
      const span = service.startIntegrationSpan('sync', 'integration-123');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'sync',
        expect.objectContaining({
          kind: SpanKind.INTERNAL,
          attributes: expect.objectContaining({
            'integration.id': 'integration-123',
            'integration.operation': 'sync',
          }),
        }),
        undefined
      );
      expect(span).toBe(mockSpan);
    });

    it('should accept custom options', () => {
      service.startIntegrationSpan('read', 'int-456', {
        kind: SpanKind.CLIENT,
        attributes: { custom: 'value' },
      });

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'read',
        expect.objectContaining({
          kind: SpanKind.CLIENT,
          attributes: expect.objectContaining({
            custom: 'value',
          }),
        }),
        undefined // No parent span provided, so context is undefined
      );
    });

    it('should log span start', () => {
      service.startIntegrationSpan('test', 'test-id');

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Integration span started',
        expect.objectContaining({
          operationName: 'test',
          integrationId: 'test-id',
        })
      );
    });
  });

  describe('startConnectorSpan()', () => {
    it('should start span with connector type and operation', () => {
      const span = service.startConnectorSpan('salesforce', 'fetchRecords', 'Account');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'salesforce.fetchRecords',
        expect.objectContaining({
          kind: SpanKind.CLIENT,
          attributes: expect.objectContaining({
            'connector.type': 'salesforce',
            'connector.operation': 'fetchRecords',
            'connector.entity_type': 'Account',
          }),
        }),
        undefined
      );
      expect(span).toBeDefined();
    });

    it('should use unknown for missing entity type', () => {
      service.startConnectorSpan('netsuite', 'create');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          attributes: expect.objectContaining({
            'connector.entity_type': 'unknown',
          }),
        }),
        undefined
      );
    });
  });

  describe('startTransformationSpan()', () => {
    it('should start span with transformation details', () => {
      const span = service.startTransformationSpan(
        'fieldMapping',
        'salesforce',
        'netsuite'
      );

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'transformation.fieldMapping',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'transformation.type': 'fieldMapping',
            'transformation.source_system': 'salesforce',
            'transformation.target_system': 'netsuite',
          }),
        }),
        undefined
      );
      expect(span).toBeDefined();
    });
  });

  describe('startAuthSpan()', () => {
    it('should start span with auth details', () => {
      const span = service.startAuthSpan('oauth2', 'tokenRefresh');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'auth.oauth2.tokenRefresh',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'auth.type': 'oauth2',
            'auth.operation': 'tokenRefresh',
          }),
        }),
        undefined
      );
      expect(span).toBeDefined();
    });
  });

  describe('startQueueSpan()', () => {
    it('should start span with queue details', () => {
      const span = service.startQueueSpan('syncQueue', 'enqueue', 'job-123');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'queue.enqueue',
        expect.objectContaining({
          kind: SpanKind.PRODUCER,
          attributes: expect.objectContaining({
            'queue.name': 'syncQueue',
            'queue.operation': 'enqueue',
            'queue.job_id': 'job-123',
          }),
        }),
        undefined
      );
      expect(span).toBeDefined();
    });

    it('should use unknown for missing job ID', () => {
      service.startQueueSpan('testQueue', 'dequeue');

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          attributes: expect.objectContaining({
            'queue.job_id': 'unknown',
          }),
        }),
        undefined
      );
    });
  });

  describe('executeInSpan()', () => {
    it('should execute function within span context', async () => {
      const result = await service.executeInSpan(mockSpan as any, () => 'result');

      expect(result).toBe('result');
    });

    it('should execute async function', async () => {
      const result = await service.executeInSpan(mockSpan as any, async () => {
        return Promise.resolve('async result');
      });

      expect(result).toBe('async result');
    });
  });

  describe('addEvent()', () => {
    it('should add event to active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.addEvent('test-event', { key: 'value' });

      expect(mockSpan.addEvent).toHaveBeenCalledWith('test-event', { key: 'value' });
    });

    it('should not throw when no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      expect(() => service.addEvent('test-event')).not.toThrow();
    });
  });

  describe('setAttribute()', () => {
    it('should set attribute on active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.setAttribute('key', 'value');

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('key', 'value');
    });

    it('should handle numeric values', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.setAttribute('count', 42);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('count', 42);
    });

    it('should handle boolean values', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.setAttribute('enabled', true);

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('enabled', true);
    });
  });

  describe('setAttributes()', () => {
    it('should set multiple attributes on active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.setAttributes({ key1: 'value1', key2: 42 });

      expect(mockSpan.setAttributes).toHaveBeenCalledWith({ key1: 'value1', key2: 42 });
    });
  });

  describe('recordException()', () => {
    it('should record exception on active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      const error = new Error('Test error');
      service.recordException(error);

      expect(mockSpan.recordException).toHaveBeenCalledWith(error);
    });

    it('should log exception recording', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.recordException(new Error('Test'));

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Exception recorded in span',
        expect.any(Object)
      );
    });
  });

  describe('getCurrentTraceContext()', () => {
    it('should return trace context when span is active', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      const context = service.getCurrentTraceContext();

      expect(context).toEqual({
        traceId: 'abc123def456',
        spanId: 'span789',
      });
    });

    it('should return null when no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      const context = service.getCurrentTraceContext();

      expect(context).toBeNull();
    });
  });

  describe('generateCorrelationId()', () => {
    it('should generate unique correlation ID', () => {
      const id1 = service.generateCorrelationId();
      const id2 = service.generateCorrelationId();

      expect(id1).toMatch(/^corr_\d+_\w+$/);
      expect(id1).not.toBe(id2);
    });
  });

  describe('setCorrelationId()', () => {
    it('should set correlation ID on active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(mockSpan);

      service.setCorrelationId('corr-123');

      expect(mockSpan.setAttribute).toHaveBeenCalledWith('correlation.id', 'corr-123');
    });

    it('should not throw when no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      expect(() => service.setCorrelationId('corr-123')).not.toThrow();
    });
  });

  describe('getCorrelationId()', () => {
    it('should return correlation ID for span', () => {
      traceMock.getActiveSpan.mockReturnValue(mockSpan);

      service.setCorrelationId('corr-456');
      const id = service.getCorrelationId();

      expect(id).toBe('corr-456');
    });

    it('should return null when no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      const id = service.getCorrelationId();

      expect(id).toBeNull();
    });

    it('should return null when no correlation ID set', () => {
      const differentSpan = {
        spanContext: jest.fn().mockReturnValue({ spanId: 'different-span' }),
      };
      traceMock.getActiveSpan.mockReturnValueOnce(differentSpan);

      const id = service.getCorrelationId();

      expect(id).toBeNull();
    });
  });

  describe('createDistributedContext()', () => {
    it('should create context with trace headers', () => {
      traceMock.getActiveSpan.mockReturnValue(mockSpan);

      const context = service.createDistributedContext();

      expect(context.traceparent).toMatch(/^00-abc123def456-span789-01$/);
      expect(context['x-integration-trace']).toBe('abc123def456');
    });

    it('should include correlation ID when set', () => {
      traceMock.getActiveSpan.mockReturnValue(mockSpan);
      service.setCorrelationId('corr-789');

      const context = service.createDistributedContext();

      expect(context['x-correlation-id']).toBe('corr-789');
    });

    it('should return empty object when no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      const context = service.createDistributedContext();

      expect(context).toEqual({});
    });
  });

  describe('extractTraceContext()', () => {
    it('should extract trace context from headers', () => {
      const headers = {
        traceparent: '00-abc123-def456-01',
      };

      const context = service.extractTraceContext(headers);

      expect(context).toEqual({
        traceId: 'abc123',
        spanId: 'def456',
        parentSpanId: 'def456',
      });
    });

    it('should handle uppercase Traceparent header', () => {
      const headers = {
        Traceparent: '00-trace-span-01',
      };

      const context = service.extractTraceContext(headers);

      expect(context).toEqual({
        traceId: 'trace',
        spanId: 'span',
        parentSpanId: 'span',
      });
    });

    it('should return null when traceparent missing', () => {
      const headers = {};

      const context = service.extractTraceContext(headers);

      expect(context).toBeNull();
    });

    it('should return null for invalid traceparent format', () => {
      const headers = {
        traceparent: 'invalid-format',
      };

      const context = service.extractTraceContext(headers);

      expect(context).toBeNull();
    });
  });

  describe('startChildSpanFromContext()', () => {
    it('should start child span with parent context', () => {
      const parentContext = {
        traceId: 'parent-trace',
        spanId: 'parent-span',
        parentSpanId: 'grandparent-span',
      };

      const span = service.startChildSpanFromContext('childOp', parentContext);

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'childOp',
        expect.objectContaining({
          attributes: expect.objectContaining({
            'parent.trace_id': 'parent-trace',
            'parent.span_id': 'grandparent-span',
          }),
        })
      );
      expect(span).toBeDefined();
    });

    it('should accept custom options', () => {
      const parentContext = {
        traceId: 'trace',
        spanId: 'span',
      };

      service.startChildSpanFromContext('op', parentContext, {
        kind: SpanKind.SERVER,
        attributes: { extra: 'attr' },
      });

      expect(mockTracer.startSpan).toHaveBeenCalledWith(
        'op',
        expect.objectContaining({
          kind: SpanKind.SERVER,
          attributes: expect.objectContaining({
            extra: 'attr',
          }),
        })
      );
    });
  });

  describe('createTraceSummary()', () => {
    it('should create summary when span is active', () => {
      traceMock.getActiveSpan.mockReturnValue(mockSpan);
      service.setCorrelationId('corr-summary');

      const summary = service.createTraceSummary();

      expect(summary.activeSpan).toBe(true);
      expect(summary.traceId).toBe('abc123def456');
      expect(summary.spanId).toBe('span789');
      expect(summary.correlationId).toBe('corr-summary');
    });

    it('should indicate no active span', () => {
      traceMock.getActiveSpan.mockReturnValueOnce(null);

      const summary = service.createTraceSummary();

      expect(summary.activeSpan).toBe(false);
      expect(summary.traceId).toBeUndefined();
    });
  });

  describe('flush()', () => {
    it('should flush traces', async () => {
      await service.initialize();

      await expect(service.flush()).resolves.not.toThrow();
      expect(mockLogger.debug).toHaveBeenCalledWith('Traces flushed');
    });

    it('should handle flush error', async () => {
      // Initialize first
      await service.initialize();

      // Access private sdk property for testing
      (service as any).sdk = {
        shutdown: jest.fn().mockRejectedValue(new Error('Flush failed')),
      };

      // flush doesn't actually use sdk.shutdown, just logs
      await service.flush();
      expect(mockLogger.debug).toHaveBeenCalled();
    });
  });

  describe('shutdown()', () => {
    it('should shutdown SDK', async () => {
      await service.initialize();

      await expect(service.shutdown()).resolves.not.toThrow();
      expect(mockLogger.info).toHaveBeenCalledWith('Distributed tracing shutdown completed');
    });

    it('should handle shutdown error', async () => {
      await service.initialize();

      // Mock SDK to throw on shutdown
      (service as any).sdk = {
        shutdown: jest.fn().mockRejectedValue(new Error('Shutdown failed')),
      };

      await service.shutdown();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Error during distributed tracing shutdown',
        expect.any(Object)
      );
    });

    it('should handle shutdown when SDK not initialized', async () => {
      await expect(service.shutdown()).resolves.not.toThrow();
    });
  });
});
