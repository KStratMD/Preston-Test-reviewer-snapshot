/**
 * Performance Monitor Unit Tests
 * Tests for production monitoring utility
 */

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Clear singleton between tests
beforeEach(() => {
  jest.resetModules();
});

describe('PerformanceMonitor', () => {
  let PerformanceMonitor: any;

  beforeEach(async () => {
    // Clear any singleton instance
    jest.resetModules();
    const module = await import('../../../src/utils/monitoring');
    PerformanceMonitor = module.PerformanceMonitor;
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = PerformanceMonitor.getInstance();
      const instance2 = PerformanceMonitor.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('recordHttpRequest', () => {
    it('should record HTTP request metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordHttpRequest('GET', '/api/test', 200, 100);
      
      const metrics = monitor.getMetrics();
      expect(metrics['http_GET_/api/test_200']).toBe(1);
      expect(metrics['http_GET_/api/test_200_duration']).toBe(100);
    });

    it('should increment count for same request', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordHttpRequest('GET', '/api/test', 200, 100);
      monitor.recordHttpRequest('GET', '/api/test', 200, 150);
      
      const metrics = monitor.getMetrics();
      expect(metrics['http_GET_/api/test_200']).toBe(2);
      expect(metrics['http_GET_/api/test_200_duration']).toBe(150); // Last duration
    });
  });

  describe('recordIntegrationExecution', () => {
    it('should record integration execution metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordIntegrationExecution('int-123', 'success', 500, 100);
      
      const metrics = monitor.getMetrics();
      expect(metrics['integration_int-123_success']).toBe(1);
      expect(metrics['integration_int-123_success_duration']).toBe(500);
      expect(metrics['integration_int-123_success_records']).toBe(100);
    });

    it('should track different statuses separately', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordIntegrationExecution('int-123', 'success', 500);
      monitor.recordIntegrationExecution('int-123', 'error', 100);
      
      const metrics = monitor.getMetrics();
      expect(metrics['integration_int-123_success']).toBe(1);
      expect(metrics['integration_int-123_error']).toBe(1);
    });
  });

  describe('recordError', () => {
    it('should record error metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordError('timeout', 'api-call', 'int-123');
      
      const metrics = monitor.getMetrics();
      expect(metrics['error_timeout_api-call']).toBe(1);
    });

    it('should increment error count', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordError('timeout', 'api-call');
      monitor.recordError('timeout', 'api-call');
      
      const metrics = monitor.getMetrics();
      expect(metrics['error_timeout_api-call']).toBe(2);
    });
  });

  describe('recordConnectionChange', () => {
    it('should track connection increases', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordConnectionChange(1, 'database');
      
      const metrics = monitor.getMetrics();
      expect(metrics['connections_database']).toBe(1);
    });

    it('should track connection decreases', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordConnectionChange(1, 'database');
      monitor.recordConnectionChange(1, 'database');
      monitor.recordConnectionChange(-1, 'database');
      
      const metrics = monitor.getMetrics();
      expect(metrics['connections_database']).toBe(1);
    });

    it('should not go below zero', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordConnectionChange(-1, 'database');
      
      const metrics = monitor.getMetrics();
      expect(metrics['connections_database']).toBe(0);
    });
  });

  describe('recordCustomMetric', () => {
    it('should record custom metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordCustomMetric('queue_size', 50, { queue: 'main' });
      
      const metrics = monitor.getMetrics();
      expect(metrics['custom_queue_size']).toBe(50);
    });
  });

  describe('getMetrics', () => {
    it('should return all recorded metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      monitor.recordHttpRequest('GET', '/test', 200, 100);
      monitor.recordError('timeout', 'op');
      
      const metrics = monitor.getMetrics();
      expect(Object.keys(metrics).length).toBeGreaterThan(0);
    });
  });

  describe('getExpressMiddleware', () => {
    it('should return middleware function', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const middleware = monitor.getExpressMiddleware();
      
      expect(typeof middleware).toBe('function');
    });

    it('should call next', () => {
      const monitor = PerformanceMonitor.getInstance();
      const middleware = monitor.getExpressMiddleware();
      
      const mockReq = { method: 'GET', path: '/test' };
      const mockRes = { on: jest.fn() };
      const mockNext = jest.fn();
      
      middleware(mockReq as any, mockRes as any, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('startSpan', () => {
    it('should create a span object', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const span = monitor.startSpan('test-operation');
      
      expect(span).toBeDefined();
      expect(span.name).toBe('test-operation');
      expect(typeof span.end).toBe('function');
      expect(typeof span.recordException).toBe('function');
      expect(typeof span.setStatus).toBe('function');
    });

    it('should end span without error', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const span = monitor.startSpan('test-operation');
      
      expect(() => span.end()).not.toThrow();
    });

    it('should record exception', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const span = monitor.startSpan('test-operation');
      const error = new Error('test error');
      
      expect(() => span.recordException(error)).not.toThrow();
    });

    it('should set status', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const span = monitor.startSpan('test-operation');
      
      expect(() => span.setStatus({ code: 1 })).not.toThrow();
    });
  });

  describe('withSpan', () => {
    it('should execute function within span context', () => {
      const monitor = PerformanceMonitor.getInstance();
      const span = monitor.startSpan('test-operation');
      
      const result = monitor.withSpan(span, () => 'result');
      
      expect(result).toBe('result');
    });
  });

  describe('endSpan', () => {
    it('should end span without error', () => {
      const monitor = PerformanceMonitor.getInstance();
      const span = monitor.startSpan('test-operation');
      
      expect(() => monitor.endSpan(span)).not.toThrow();
    });

    it('should end span with error', () => {
      const monitor = PerformanceMonitor.getInstance();
      const span = monitor.startSpan('test-operation');
      const error = new Error('test error');
      
      expect(() => monitor.endSpan(span, error)).not.toThrow();
    });
  });

  describe('getHealthMetrics', () => {
    it('should return health metrics', () => {
      const monitor = PerformanceMonitor.getInstance();
      
      const health = monitor.getHealthMetrics();
      
      expect(health).toHaveProperty('telemetryEnabled');
      expect(health).toHaveProperty('metricsCollected');
      expect(health).toHaveProperty('uptime');
      expect(health).toHaveProperty('memory');
      expect(health).toHaveProperty('metrics');
    });
  });

  describe('shutdown', () => {
    it('should shutdown without error', async () => {
      const monitor = PerformanceMonitor.getInstance();
      
      await expect(monitor.shutdown()).resolves.not.toThrow();
    });

    it('should clear metrics on shutdown', async () => {
      const monitor = PerformanceMonitor.getInstance();
      monitor.recordHttpRequest('GET', '/test', 200, 100);
      
      await monitor.shutdown();
      
      const metrics = monitor.getMetrics();
      expect(Object.keys(metrics).length).toBe(0);
    });
  });
});
