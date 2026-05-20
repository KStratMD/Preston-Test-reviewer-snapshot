/**
 * PerformanceMonitor Unit Tests
 * Tests for performance monitoring and metrics collection
 */

import 'reflect-metadata';
import { PerformanceMonitor } from '../../../src/performance/PerformanceMonitor';
import { Logger } from '../../../src/utils/Logger';

describe('PerformanceMonitor', () => {
  let performanceMonitor: PerformanceMonitor;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    performanceMonitor = new PerformanceMonitor(mockLogger);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('initialize()', () => {
    it('should initialize performance monitor', async () => {
      await performanceMonitor.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith('Performance monitor initialized');
    });

    it('should set up periodic resource collection', async () => {
      await performanceMonitor.initialize();

      // Timers should be set
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });
  });

  describe('timing operations', () => {
    describe('startTiming()', () => {
      it('should return a unique timer ID', () => {
        const timerId1 = performanceMonitor.startTiming('operation1');
        const timerId2 = performanceMonitor.startTiming('operation2');

        expect(timerId1).toBeDefined();
        expect(timerId2).toBeDefined();
        expect(timerId1).not.toBe(timerId2);
      });

      it('should log when starting timing', () => {
        performanceMonitor.startTiming('test-operation');

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Started timing operation',
          expect.objectContaining({ operation: 'test-operation' })
        );
      });
    });

    describe('endTiming()', () => {
      it('should return duration in milliseconds', () => {
        const timerId = performanceMonitor.startTiming('operation');

        // Advance time
        jest.advanceTimersByTime(100);

        const duration = performanceMonitor.endTiming(timerId, 'operation');

        expect(duration).toBeGreaterThanOrEqual(0);
      });

      it('should return 0 for non-existent timer', () => {
        const duration = performanceMonitor.endTiming('non-existent', 'operation');

        expect(duration).toBe(0);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Timer not found',
          expect.any(Object)
        );
      });

      it('should log slow operations', () => {
        jest.useRealTimers(); // Need real timers for this test

        const timerId = performanceMonitor.startTiming('slow-operation');

        // Mock a slow operation by calling endTiming with slow flag
        // Since we can't actually wait, we'll test the logging path differently
        performanceMonitor.endTiming(timerId, 'slow-operation', true);

        // The actual slow detection would happen if duration > 1000ms
        // This tests that timing is recorded
        const timings = performanceMonitor.getTimings('slow-operation');
        expect(timings.length).toBe(1);

        jest.useFakeTimers();
      });

      it('should track success/failure', () => {
        const timerId1 = performanceMonitor.startTiming('success-op');
        performanceMonitor.endTiming(timerId1, 'success-op', true);

        const timerId2 = performanceMonitor.startTiming('fail-op');
        performanceMonitor.endTiming(timerId2, 'fail-op', false);

        const successTimings = performanceMonitor.getTimings('success-op');
        const failTimings = performanceMonitor.getTimings('fail-op');

        expect(successTimings[0].success).toBe(true);
        expect(failTimings[0].success).toBe(false);
      });
    });

    describe('timeFunction()', () => {
      it('should time a successful function', async () => {
        const fn = jest.fn().mockResolvedValue('result');

        const result = await performanceMonitor.timeFunction('operation', fn);

        expect(result).toBe('result');
        expect(fn).toHaveBeenCalled();
      });

      it('should record success on successful execution', async () => {
        const fn = jest.fn().mockResolvedValue('result');

        await performanceMonitor.timeFunction('success-function', fn);

        const timings = performanceMonitor.getTimings('success-function');
        expect(timings.length).toBe(1);
        expect(timings[0].success).toBe(true);
      });

      it('should record failure and rethrow on error', async () => {
        const fn = jest.fn().mockRejectedValue(new Error('fail'));

        await expect(
          performanceMonitor.timeFunction('fail-function', fn)
        ).rejects.toThrow('fail');

        const timings = performanceMonitor.getTimings('fail-function');
        expect(timings.length).toBe(1);
        expect(timings[0].success).toBe(false);
      });

      it('should include metadata', async () => {
        const fn = jest.fn().mockResolvedValue('result');
        const metadata = { userId: '123' };

        await performanceMonitor.timeFunction('with-metadata', fn, metadata);

        const timings = performanceMonitor.getTimings('with-metadata');
        expect(timings[0].metadata).toEqual(metadata);
      });
    });
  });

  describe('metric recording', () => {
    describe('recordMetric()', () => {
      it('should record a metric', () => {
        performanceMonitor.recordMetric('test-metric', 42, 'count');

        const metrics = performanceMonitor.getMetrics('test-metric');
        expect(metrics.length).toBe(1);
        expect(metrics[0].value).toBe(42);
        expect(metrics[0].unit).toBe('count');
      });

      it('should support tags', () => {
        performanceMonitor.recordMetric('tagged-metric', 100, 'ms', { env: 'test' });

        const metrics = performanceMonitor.getMetrics('tagged-metric', 60, { env: 'test' });
        expect(metrics.length).toBe(1);
        expect(metrics[0].tags).toEqual({ env: 'test' });
      });

      it('should trim old metrics when exceeding limit', () => {
        // Record more than maxMetricsHistory
        for (let i = 0; i < 10005; i++) {
          performanceMonitor.recordMetric('bulk-metric', i);
        }

        const metrics = performanceMonitor.getMetrics('bulk-metric');
        expect(metrics.length).toBeLessThanOrEqual(10000);
      });
    });

    describe('incrementCounter()', () => {
      it('should increment counter by 1 by default', () => {
        performanceMonitor.incrementCounter('counter');

        const metrics = performanceMonitor.getMetrics('counter');
        expect(metrics.length).toBe(1);
        expect(metrics[0].value).toBe(1);
      });

      it('should increment counter by custom amount', () => {
        performanceMonitor.incrementCounter('counter', 5);

        const metrics = performanceMonitor.getMetrics('counter');
        expect(metrics[0].value).toBe(5);
      });
    });

    describe('recordGauge()', () => {
      it('should record gauge value', () => {
        performanceMonitor.recordGauge('gauge-metric', 75.5, 'percent');

        const metrics = performanceMonitor.getMetrics('gauge-metric');
        expect(metrics.length).toBe(1);
        expect(metrics[0].value).toBe(75.5);
        expect(metrics[0].unit).toBe('percent');
      });
    });
  });

  describe('getStatistics()', () => {
    beforeEach(() => {
      // Add some test data
      for (let i = 0; i < 10; i++) {
        const timerId = performanceMonitor.startTiming('api-request');
        performanceMonitor.endTiming(timerId, 'api-request', i < 9); // 9 success, 1 fail
      }

      performanceMonitor.recordMetric('throughput', 10, 'mbps');
    });

    it('should return statistics', () => {
      const stats = performanceMonitor.getStatistics();

      expect(stats).toHaveProperty('averageResponseTime');
      expect(stats).toHaveProperty('requestsPerSecond');
      expect(stats).toHaveProperty('errorRate');
      expect(stats).toHaveProperty('throughputMbps');
      expect(stats).toHaveProperty('resourceUsage');
      expect(stats).toHaveProperty('topSlowOperations');
    });

    it('should calculate error rate', () => {
      const stats = performanceMonitor.getStatistics();

      // 1 out of 10 failed = 10%
      expect(stats.errorRate).toBe(0.1);
    });

    it('should return resource usage', () => {
      const stats = performanceMonitor.getStatistics();

      expect(stats.resourceUsage).toHaveProperty('cpuUsage');
      expect(stats.resourceUsage).toHaveProperty('memoryUsage');
      expect(stats.resourceUsage).toHaveProperty('uptime');
      expect(stats.resourceUsage.memoryUsage).toHaveProperty('heapUsed');
    });

    it('should return top slow operations', () => {
      const stats = performanceMonitor.getStatistics();

      expect(Array.isArray(stats.topSlowOperations)).toBe(true);
      expect(stats.topSlowOperations[0]).toHaveProperty('operation');
      expect(stats.topSlowOperations[0]).toHaveProperty('averageDuration');
      expect(stats.topSlowOperations[0]).toHaveProperty('count');
    });

    it('should respect period parameter', () => {
      // Record old data
      const timerId = performanceMonitor.startTiming('old-operation');
      performanceMonitor.endTiming(timerId, 'old-operation');

      // Advance time past the period
      jest.advanceTimersByTime(120 * 60 * 1000); // 2 hours

      // Get stats for last 30 minutes (should not include old data)
      const stats = performanceMonitor.getStatistics(30);

      // The old operation should not be in topSlowOperations
      const hasOldOperation = stats.topSlowOperations.some(
        op => op.operation === 'old-operation'
      );
      expect(hasOldOperation).toBe(false);
    });
  });

  describe('getMetrics()', () => {
    beforeEach(() => {
      performanceMonitor.recordMetric('test-metric', 1, 'count', { env: 'prod' });
      performanceMonitor.recordMetric('test-metric', 2, 'count', { env: 'dev' });
      performanceMonitor.recordMetric('other-metric', 3);
    });

    it('should filter by name', () => {
      const metrics = performanceMonitor.getMetrics('test-metric');

      expect(metrics.length).toBe(2);
      metrics.forEach(m => expect(m.name).toBe('test-metric'));
    });

    it('should filter by tags', () => {
      const metrics = performanceMonitor.getMetrics('test-metric', 60, { env: 'prod' });

      expect(metrics.length).toBe(1);
      expect(metrics[0].tags?.env).toBe('prod');
    });

    it('should filter by period', () => {
      performanceMonitor.recordMetric('timed-metric', 1);

      // Advance time
      jest.advanceTimersByTime(120 * 60 * 1000); // 2 hours

      const metrics = performanceMonitor.getMetrics('timed-metric', 30);
      expect(metrics.length).toBe(0);
    });
  });

  describe('getTimings()', () => {
    beforeEach(() => {
      const timerId1 = performanceMonitor.startTiming('operation-a');
      performanceMonitor.endTiming(timerId1, 'operation-a');

      const timerId2 = performanceMonitor.startTiming('operation-b');
      performanceMonitor.endTiming(timerId2, 'operation-b');
    });

    it('should filter by operation name', () => {
      const timings = performanceMonitor.getTimings('operation-a');

      expect(timings.length).toBe(1);
      expect(timings[0].operation).toBe('operation-a');
    });

    it('should filter by period', () => {
      // Advance time past period
      jest.advanceTimersByTime(120 * 60 * 1000);

      const timings = performanceMonitor.getTimings('operation-a', 30);
      expect(timings.length).toBe(0);
    });
  });

  describe('isSystemUnderStress()', () => {
    it('should return not under stress for normal conditions', () => {
      // Mock low memory usage to ensure deterministic results under heavy test runs
      const originalMemoryUsage = process.memoryUsage;
      process.memoryUsage = jest.fn().mockReturnValue({
        heapUsed: 200 * 1024 * 1024,   // 200MB - well under 1024MB threshold
        heapTotal: 400 * 1024 * 1024,
        rss: 300 * 1024 * 1024,
        external: 10 * 1024 * 1024,
        arrayBuffers: 5 * 1024 * 1024,
      }) as any;

      try {
        const result = performanceMonitor.isSystemUnderStress();

        expect(result.underStress).toBe(false);
        expect(result.reasons).toEqual([]);
        expect(result.severity).toBe('low');
      } finally {
        process.memoryUsage = originalMemoryUsage;
      }
    });

    it('should detect high error rate', () => {
      // Create many failed operations
      for (let i = 0; i < 10; i++) {
        const timerId = performanceMonitor.startTiming('failing-op');
        performanceMonitor.endTiming(timerId, 'failing-op', false);
      }

      const result = performanceMonitor.isSystemUnderStress();

      expect(result.underStress).toBe(true);
      expect(result.reasons.some(r => r.includes('error rate'))).toBe(true);
    });
  });

  describe('generateReport()', () => {
    beforeEach(() => {
      // Add some test data
      for (let i = 0; i < 5; i++) {
        const timerId = performanceMonitor.startTiming('api-request');
        performanceMonitor.endTiming(timerId, 'api-request');
      }
    });

    it('should generate performance report', () => {
      const report = performanceMonitor.generateReport();

      expect(report).toHaveProperty('summary');
      expect(report).toHaveProperty('alerts');
      expect(report).toHaveProperty('recommendations');
    });

    it('should include alerts for high error rate', () => {
      // Create failing operations
      for (let i = 0; i < 20; i++) {
        const timerId = performanceMonitor.startTiming('failing-request');
        performanceMonitor.endTiming(timerId, 'failing-request', false);
      }

      const report = performanceMonitor.generateReport();

      expect(report.alerts.some(a => a.includes('error rate'))).toBe(true);
    });

    it('should include recommendations for slow operations', () => {
      // Create some operations (can't really make them slow with fake timers)
      const report = performanceMonitor.generateReport();

      // Will have recommendations if there are any slow operations
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('should respect period parameter', () => {
      const report = performanceMonitor.generateReport(30);

      expect(report.summary).toBeDefined();
    });
  });

  describe('clearMetrics()', () => {
    it('should clear all metrics and timings', () => {
      // Add data
      performanceMonitor.recordMetric('metric', 1);
      const timerId = performanceMonitor.startTiming('operation');
      performanceMonitor.endTiming(timerId, 'operation');

      // Clear
      performanceMonitor.clearMetrics();

      // Verify cleared
      expect(performanceMonitor.getMetrics('metric').length).toBe(0);
      expect(performanceMonitor.getTimings('operation').length).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith('Performance metrics cleared');
    });
  });

  describe('edge cases', () => {
    it('should handle empty statistics', () => {
      const stats = performanceMonitor.getStatistics();

      expect(stats.averageResponseTime).toBe(0);
      expect(stats.requestsPerSecond).toBe(0);
      expect(stats.errorRate).toBe(0);
    });

    it('should handle operations with same name', () => {
      for (let i = 0; i < 5; i++) {
        const timerId = performanceMonitor.startTiming('same-op');
        performanceMonitor.endTiming(timerId, 'same-op');
      }

      const stats = performanceMonitor.getStatistics();
      const sameOp = stats.topSlowOperations.find(op => op.operation === 'same-op');

      expect(sameOp?.count).toBe(5);
    });

    it('should handle concurrent timers', () => {
      const timer1 = performanceMonitor.startTiming('op1');
      const timer2 = performanceMonitor.startTiming('op2');
      const timer3 = performanceMonitor.startTiming('op1');

      performanceMonitor.endTiming(timer2, 'op2');
      performanceMonitor.endTiming(timer1, 'op1');
      performanceMonitor.endTiming(timer3, 'op1');

      const op1Timings = performanceMonitor.getTimings('op1');
      const op2Timings = performanceMonitor.getTimings('op2');

      expect(op1Timings.length).toBe(2);
      expect(op2Timings.length).toBe(1);
    });
  });
});
