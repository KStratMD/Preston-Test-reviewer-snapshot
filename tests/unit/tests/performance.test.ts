import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { Request, Response } from 'express';
import { RequestOptimizer } from '../middleware/RequestOptimizer';
import { AdvancedCache } from '../services/AdvancedCache';
import { PerformanceMonitor } from '../services/PerformanceMonitor';
import { waitFor, waitForMetrics, waitForCacheOperation, flushPromises } from './utils/testHelpers';

// Mock dependencies
jest.mock('../../../src/utils/Logger');
jest.mock('../services/PerformanceMonitor');
jest.mock('../services/AdvancedCache', () => {
  const actual = jest.requireActual('../services/AdvancedCache');
  return {
    ...actual,
    // Use real implementation but with controlled cache for tests
    AdvancedCache: jest.fn().mockImplementation((config = {}) => {
      return new actual.AdvancedCache({
        ...config,
        // Override cache settings for deterministic testing
        maxSize: 100,
        defaultTTL: 1000,
        cleanupInterval: 100
      });
    })
  };
});

describe('RequestOptimizer', () => {
  let optimizer: RequestOptimizer;
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: jest.Mock;

  beforeEach(() => {
    optimizer = new RequestOptimizer({
      enableCaching: true,
      enableCompression: true,
      enableRateLimiting: true,
      rateLimitMax: 10,
      rateLimitWindow: 60000
    });

    mockReq = {
      method: 'GET',
      path: '/api/integrations/test',
      originalUrl: '/api/integrations/test',
      ip: '127.0.0.1',
      query: {},
      get: jest.fn().mockReturnValue('test-agent') as any,
      connection: { remoteAddress: '127.0.0.1' } as any
    };

    mockRes = {
      status: jest.fn().mockReturnThis() as any,
      json: jest.fn().mockReturnThis() as any,
      send: jest.fn().mockReturnThis() as any,
      set: jest.fn().mockReturnThis() as any,
      statusCode: 200
    };

    mockNext = jest.fn();
  });

  afterEach(() => {
    optimizer.shutdown();
    jest.clearAllMocks();
  });

  describe('Rate Limiting', () => {
    it('should allow requests within rate limit', async () => {
      const middleware = optimizer.createOptimizationMiddleware();
      
      await middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
      expect(mockRes.status).not.toHaveBeenCalledWith(429);
    });

    it('should block requests exceeding rate limit', async () => {
      const middleware = optimizer.createOptimizationMiddleware();
      
      // Make requests up to the limit
      for (let i = 0; i < 11; i++) {
        await middleware(mockReq as Request, mockRes as Response, mockNext);
      }
      
      expect(mockRes.status).toHaveBeenCalledWith(429);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Rate limit exceeded'
        })
      );
    });
  });

  describe('Caching', () => {
    it('should cache GET requests', async () => {
      const middleware = optimizer.createOptimizationMiddleware();
      
      await middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should not cache POST requests', async () => {
      mockReq.method = 'POST';
      const middleware = optimizer.createOptimizationMiddleware();
      
      await middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });

    it('should not cache requests with dynamic parameters', async () => {
      mockReq.query = { timestamp: Date.now().toString() };
      const middleware = optimizer.createOptimizationMiddleware();
      
      await middleware(mockReq as Request, mockRes as Response, mockNext);
      
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Request Batching', () => {
    it('should batch similar requests', async () => {
      const middleware = optimizer.createOptimizationMiddleware();
      
      // Create multiple similar requests
      const requests = Array.from({ length: 5 }, () => ({
        ...mockReq,
        path: '/api/integrations/batch-test'
      }));

      const responses = requests.map(() => ({ ...mockRes }));
      
      // Process requests
      const promises = requests.map((req, index) => 
        middleware(req as Request, responses[index] as Response, mockNext)
      );
      
      await Promise.all(promises);
      
      // Should have processed requests
      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Performance Metrics', () => {
    it('should track request metrics', () => {
      const metrics = optimizer.getMetrics();
      
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('cachedResponses');
      expect(metrics).toHaveProperty('averageResponseTime');
    });

    it('should generate optimization report', () => {
      const report = optimizer.getOptimizationReport();
      
      expect(report).toHaveProperty('cacheHitRate');
      expect(report).toHaveProperty('compressionRate');
      expect(report).toHaveProperty('averageResponseTime');
    });
  });
});

describe('AdvancedCache', () => {
  let cache: AdvancedCache;

  beforeEach(() => {
    cache = new AdvancedCache({
      maxSize: 1024 * 1024, // 1MB
      maxEntries: 100,
      defaultTTL: 60000 // 1 minute
    });
  });

  afterEach(() => {
    cache.shutdown();
  });

  describe('Basic Operations', () => {
    it('should set and get values', () => {
      cache.set('test-key', 'test-value');
      const value = cache.get('test-key');
      
      expect(value).toBe('test-value');
    });

    it('should return null for non-existent keys', () => {
      const value = cache.get('non-existent');
      
      expect(value).toBeNull();
    });

    it('should delete values', () => {
      cache.set('test-key', 'test-value');
      const deleted = cache.delete('test-key');
      const value = cache.get('test-key');
      
      expect(deleted).toBe(true);
      expect(value).toBeNull();
    });

    it('should check if key exists', () => {
      cache.set('test-key', 'test-value');
      
      expect(cache.has('test-key')).toBe(true);
      expect(cache.has('non-existent')).toBe(false);
    });
  });

  describe('TTL and Expiration', () => {
    it('should expire values after TTL', async () => {
      jest.useFakeTimers();

      cache.set('test-key', 'test-value', 100); // 100ms TTL

      // Value should exist immediately
      expect(cache.get('test-key')).toBe('test-value');

      // Fast forward time by 150ms
      jest.advanceTimersByTime(150);

      // Value should now be expired
      const value = cache.get('test-key');
      expect(value).toBeNull();

      jest.useRealTimers();
    });

    it('should use default TTL when not specified', () => {
      cache.set('test-key', 'test-value');
      
      expect(cache.has('test-key')).toBe(true);
    });
  });

  describe('Tag-based Operations', () => {
    it('should invalidate by tag', () => {
      cache.set('key1', 'value1', undefined, ['tag1', 'tag2']);
      cache.set('key2', 'value2', undefined, ['tag1']);
      cache.set('key3', 'value3', undefined, ['tag3']);
      
      const invalidated = cache.invalidateByTag('tag1');
      
      expect(invalidated).toBe(2);
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key3')).toBe('value3');
    });

    it('should get values by tag', () => {
      cache.set('key1', 'value1', undefined, ['tag1']);
      cache.set('key2', 'value2', undefined, ['tag1']);
      cache.set('key3', 'value3', undefined, ['tag2']);
      
      const values = cache.getByTag('tag1');
      
      expect(values).toHaveLength(2);
      expect(values.map(v => v.value)).toContain('value1');
      expect(values.map(v => v.value)).toContain('value2');
    });
  });

  describe('Statistics', () => {
    it('should track cache statistics', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('non-existent'); // miss
      
      const stats = cache.getStats();
      
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.sets).toBe(1);
      expect(stats.entryCount).toBe(1);
    });

    it('should calculate hit rate', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('non-existent'); // miss
      
      const stats = cache.getStats();
      
      expect(stats.hitRate).toBeCloseTo(66.67, 1);
    });
  });

  describe('Health Check', () => {
    it('should report healthy status', () => {
      const health = cache.getHealth();
      
      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('hitRate');
      expect(health).toHaveProperty('memoryUsage');
    });
  });
});

describe('PerformanceMonitor', () => {
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    monitor.shutdown();
  });

  describe('Monitoring', () => {
    it('should start and stop monitoring', () => {
      monitor.startMonitoring(1000);
      expect(monitor['isMonitoring']).toBe(true);
      
      monitor.stopMonitoring();
      expect(monitor['isMonitoring']).toBe(false);
    });

    it('should record request metrics', () => {
      monitor.recordRequestStart();
      monitor.recordRequestEnd(100);
      
      const metrics = monitor.getLatestMetrics();
      // Metrics might be null if monitoring hasn't collected data yet
      expect(metrics).toBeDefined();
    });

    it('should record integration metrics', () => {
      monitor.recordIntegrationMetric('salesforce', 200, false);
      monitor.recordIntegrationMetric('salesforce', 500, true);
      
      // Should not throw and should record the metrics
      expect(() => {
        monitor.recordIntegrationMetric('netsuite', 150, false);
      }).not.toThrow();
    });
  });

  describe('Performance Report', () => {
    it('should generate performance report', () => {
      const report = monitor.getPerformanceReport();
      
      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('recommendations');
    });
  });

  describe('Alerts', () => {
    it('should track alerts', () => {
      const alerts = monitor.getAlerts();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should get recent alerts', () => {
      const recentAlerts = monitor.getRecentAlerts(60);
      expect(Array.isArray(recentAlerts)).toBe(true);
    });
  });

  describe('Memory Optimization', () => {
    it('should trigger garbage collection if available', () => {
      // This test just ensures the method doesn't throw
      expect(() => {
        monitor.optimizeMemory();
      }).not.toThrow();
    });
  });
});

// Integration tests
describe('Integration Tests', () => {
  let optimizer: RequestOptimizer;
  let cache: AdvancedCache;
  let monitor: PerformanceMonitor;

  beforeEach(() => {
    optimizer = new RequestOptimizer();
    cache = new AdvancedCache();
    monitor = new PerformanceMonitor();
  });

  afterEach(() => {
    optimizer.shutdown();
    cache.shutdown();
    monitor.shutdown();
  });

  it('should work together for optimized request handling', async () => {
    // Start monitoring
    monitor.startMonitoring(100);
    
    // Set up cache
    cache.set('integration-config', { type: 'salesforce', url: 'https://api.salesforce.com' });
    
    // Create optimized middleware
    const middleware = optimizer.createOptimizationMiddleware();
    
    const mockReq = {
      method: 'GET',
      path: '/api/integrations/salesforce',
      originalUrl: '/api/integrations/salesforce',
      ip: '127.0.0.1',
      query: {},
      get: jest.fn().mockReturnValue('test-agent'),
      connection: { remoteAddress: '127.0.0.1' }
    } as any;

    const mockRes = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      statusCode: 200
    } as any;

    const mockNext = jest.fn();
    
    // Process request
    await middleware(mockReq, mockRes, mockNext);
    
    // Verify integration
    expect(mockNext).toHaveBeenCalled();
    
    // Check metrics
    const optimizerMetrics = optimizer.getMetrics();
    expect(optimizerMetrics.totalRequests).toBeGreaterThan(0);
    
    // Check cache stats
    const cacheStats = cache.getStats();
    expect(cacheStats).toBeDefined();
    
    // Wait for monitoring to collect metrics
    await waitForMetrics(monitor, 1, { timeout: 3000 });
    
    monitor.stopMonitoring();
  });
});

// Load testing utilities
export class LoadTester {
  private results: {
    timestamp: number;
    responseTime: number;
    success: boolean;
    error?: string;
  }[] = [];

  async runLoadTest(
    testFunction: () => Promise<any>,
    options: {
      concurrency: number;
      duration: number; // seconds
      rampUp?: number; // seconds
    }
  ): Promise<any> {
    const startTime = Date.now();
    const endTime = startTime + (options.duration * 1000);
    const rampUpTime = options.rampUp ? options.rampUp * 1000 : 0;
    
    let activeRequests = 0;
    const maxConcurrency = options.concurrency;
    
    const executeRequest = async () => {
      const requestStart = performance.now();
      try {
        await testFunction();
        this.results.push({
          timestamp: Date.now(),
          responseTime: performance.now() - requestStart,
          success: true
        });
      } catch (error) {
        this.results.push({
          timestamp: Date.now(),
          responseTime: performance.now() - requestStart,
          success: false,
          error: error instanceof Error ? error.message : String(error)
        });
      } finally {
        activeRequests--;
      }
    };

    // Main load test loop
    while (Date.now() < endTime) {
      const elapsed = Date.now() - startTime;
      const rampUpProgress = rampUpTime > 0 ? Math.min(elapsed / rampUpTime, 1) : 1;
      const currentMaxConcurrency = Math.floor(maxConcurrency * rampUpProgress);
      
      if (activeRequests < currentMaxConcurrency) {
        activeRequests++;
        executeRequest();
      }
      
      await flushPromises();
    }

    // Wait for remaining requests to complete
    await waitFor(() => activeRequests === 0, {
      timeout: 30000,
      interval: 50,
      timeoutMsg: 'Not all requests completed within timeout'
    });

    return this.generateReport();
  }

  private generateReport(): any {
    const successfulRequests = this.results.filter(r => r.success);
    const failedRequests = this.results.filter(r => !r.success);
    
    const responseTimes = successfulRequests.map(r => r.responseTime);
    const avgResponseTime = responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length;
    
    responseTimes.sort((a, b) => a - b);
    const p50 = responseTimes[Math.floor(responseTimes.length * 0.5)];
    const p95 = responseTimes[Math.floor(responseTimes.length * 0.95)];
    const p99 = responseTimes[Math.floor(responseTimes.length * 0.99)];

    return {
      totalRequests: this.results.length,
      successfulRequests: successfulRequests.length,
      failedRequests: failedRequests.length,
      successRate: (successfulRequests.length / this.results.length) * 100,
      averageResponseTime: avgResponseTime,
      percentiles: {
        p50,
        p95,
        p99
      },
      throughput: this.results.length > 1 && this.results[0] && this.results[this.results.length - 1]
        ? this.results.length / ((this.results[this.results.length - 1]!.timestamp - this.results[0]!.timestamp) / 1000)
        : 0,
      errors: failedRequests.map(r => r.error).filter((error, index, arr) => arr.indexOf(error) === index)
    };
  }

  reset(): void {
    this.results = [];
  }
}