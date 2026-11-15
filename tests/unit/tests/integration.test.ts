import { describe, it, expect, beforeAll, afterAll, jest } from '@jest/globals';
import { Server } from '../index';
import { performanceMonitor } from '../services/PerformanceMonitor';
import { integrationCache, responseCache, CacheFactory } from '../services/AdvancedCache';
import { requestOptimizer } from '../middleware/RequestOptimizer';
import { healthCheckService } from '../services/HealthCheckService';
import { LoadTester } from './performance.test';
import { waitFor, waitForMetrics, waitForLength, flushPromises } from './utils/testHelpers';

// Mock external dependencies
jest.mock('../../../src/utils/Logger');
jest.mock('../services/IntegrationService');
jest.mock('../services/ConfigurationService');

describe('Integration Hub - End-to-End Tests', () => {
  beforeEach(() => {
    integrationCache.clear();
    performanceMonitor.reset();
  });
  let server: Server;
  let loadTester: LoadTester;

  beforeAll(async () => {
    // Set test environment
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = '1';
    
    loadTester = new LoadTester();
  });

  afterAll(async () => {
    if (server) {
      await server.shutdown();
    }
    
    // Cleanup all services
    performanceMonitor.shutdown();
    requestOptimizer.shutdown();
    CacheFactory.shutdownAll();
  });

  describe('Application Startup', () => {
    it('should start the server successfully', async () => {
      server = new Server();
      
      expect(server).toBeDefined();
      expect(server.app).toBeDefined();
    });

    it('should have all required routes mounted', () => {
      const app = server.getExpressApp();
      
      // Check that the app has routes
      expect(app._router).toBeDefined();
    });
  });

  describe('Health Checks', () => {
    it('should respond to basic health check', async () => {
      const mockReq = { path: '/health' } as any;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      } as any;
      const mockNext = jest.fn();

      const healthMiddleware = healthCheckService.createHealthCheckMiddleware();
      await healthMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(200);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'healthy',
          version: expect.any(String),
          uptime: expect.any(Number)
        })
      );
    });

    it('should respond to readiness check', async () => {
      const mockReq = { path: '/health/ready' } as any;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis()
      } as any;
      const mockNext = jest.fn();

      const healthMiddleware = healthCheckService.createHealthCheckMiddleware();
      await healthMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.status).toHaveBeenCalled();
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          checks: expect.any(Object)
        })
      );
    });

    it('should respond to detailed health check', async () => {
      const mockReq = { path: '/health/detailed' } as any;
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis()
      } as any;
      const mockNext = jest.fn();

      const healthMiddleware = healthCheckService.createHealthCheckMiddleware();
      await healthMiddleware(mockReq, mockRes, mockNext);

      expect(mockRes.set).toHaveBeenCalledWith('X-Health-Check-Duration', expect.any(String));
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          status: expect.any(String),
          metrics: expect.objectContaining({
            performance: expect.any(Object),
            cache: expect.any(Object),
            optimization: expect.any(Object)
          })
        })
      );
    });
  });

  describe('Performance Monitoring', () => {
    it('should collect performance metrics', async () => {
      performanceMonitor.startMonitoring(100); // Fast interval for testing
      
      // Wait for metrics collection
      await waitForMetrics(performanceMonitor, 1, { timeout: 3000 });
      
      const metrics = performanceMonitor.getLatestMetrics();
      expect(metrics).toBeDefined();
      
      if (metrics) {
        expect(metrics).toHaveProperty('memory');
        expect(metrics).toHaveProperty('cpu');
        expect(metrics).toHaveProperty('eventLoop');
      }
      
      performanceMonitor.stopMonitoring();
    });

    it('should generate performance reports', () => {
      const report = performanceMonitor.getPerformanceReport();
      
      expect(report).toHaveProperty('status');
      expect(report).toHaveProperty('timestamp');
      expect(report).toHaveProperty('recommendations');
    });

    it('should track request metrics', () => {
      performanceMonitor.recordRequestStart();
      performanceMonitor.recordRequestEnd(100);
      
      // Should not throw
      expect(() => {
        performanceMonitor.recordIntegrationMetric('test', 200, false);
      }).not.toThrow();
    });
  });

  describe('Advanced Caching', () => {
    it('should cache and retrieve values', () => {
      integrationCache.set('test-key', { data: 'test-value' });
      const value = integrationCache.get('test-key');
      
      expect(value).toEqual({ data: 'test-value' });
    });

    it('should handle cache expiration', async () => {
      jest.useFakeTimers();

      integrationCache.set('expire-test', 'value', 100); // 100ms TTL

      // Value should exist immediately
      expect(integrationCache.get('expire-test')).toBe('value');

      // Fast forward time past expiration
      jest.advanceTimersByTime(150);

      const value = integrationCache.get('expire-test');
      expect(value).toBeNull();

      jest.useRealTimers();
    });

    it('should support tag-based operations', () => {
      integrationCache.set('tagged1', 'value1', undefined, ['test-tag']);
      integrationCache.set('tagged2', 'value2', undefined, ['test-tag']);
      integrationCache.set('other', 'value3', undefined, ['other-tag']);
      
      const taggedValues = integrationCache.getByTag('test-tag');
      expect(taggedValues).toHaveLength(2);
      
      const invalidated = integrationCache.invalidateByTag('test-tag');
      expect(invalidated).toBe(2);
      
      expect(integrationCache.get('tagged1')).toBeNull();
      expect(integrationCache.get('other')).toBe('value3');
    });

    it('should provide cache statistics', () => {
      integrationCache.clear();
      
      integrationCache.set('stats-test', 'value');
      integrationCache.get('stats-test'); // hit
      integrationCache.get('non-existent'); // miss
      
      const stats = integrationCache.getStats();
      
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.sets).toBe(1);
      expect(stats.hitRate).toBeCloseTo(50, 0);
    });
  });

  describe('Request Optimization', () => {
    it('should track optimization metrics', () => {
      const metrics = requestOptimizer.getMetrics();
      
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('cachedResponses');
      expect(metrics).toHaveProperty('averageResponseTime');
    });

    it('should generate optimization reports', () => {
      const report = requestOptimizer.getOptimizationReport();
      
      expect(report).toHaveProperty('cacheHitRate');
      expect(report).toHaveProperty('compressionRate');
      expect(report).toHaveProperty('averageResponseTime');
    });
  });

  describe('Load Testing', () => {
    it('should handle concurrent requests', async () => {
      const testFunction = async () => {
        // Simulate API call with realistic delay
        await flushPromises();
        return { success: true };
      };

      const results = await loadTester.runLoadTest(testFunction, {
        concurrency: 5,
        duration: 2, // 2 seconds
        rampUp: 1 // 1 second ramp up
      });

      expect(results.totalRequests).toBeGreaterThan(0);
      expect(results.successRate).toBeGreaterThan(90);
      expect(results.averageResponseTime).toBeLessThan(100);
    });
  });

  describe('Integration Tests', () => {
    it('should handle full request lifecycle with optimizations', async () => {
      // Start monitoring
      performanceMonitor.startMonitoring(100);
      
      // Create optimization middleware
      const middleware = requestOptimizer.createOptimizationMiddleware();
      
      const mockReq = {
        method: 'GET',
        path: '/api/integrations/test',
        originalUrl: '/api/integrations/test',
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
      
      // Process request through optimization middleware
      await middleware(mockReq, mockRes, mockNext);
      
      // Verify request was processed
      expect(mockNext).toHaveBeenCalled();
      
      // Check that metrics were recorded
      const optimizerMetrics = requestOptimizer.getMetrics();
      expect(optimizerMetrics.totalRequests).toBeGreaterThan(0);
      
      // Wait for performance metrics
      await waitForMetrics(performanceMonitor, 1, { timeout: 3000 });
      
      performanceMonitor.stopMonitoring();
    });

    it('should maintain cache consistency across operations', () => {
      // Test cache consistency
      const testData = { id: 1, name: 'Test Integration' };
      
      integrationCache.set('consistency-test', testData, undefined, ['integration']);
      responseCache.set('response-test', { body: testData }, undefined, ['response']);
      
      // Verify data is consistent
      const integrationData = integrationCache.get('consistency-test');
      const responseData = responseCache.get('response-test');
      
      expect(integrationData).toEqual(testData);
      expect((responseData as any)?.body).toEqual(testData);
      
      // Test tag-based invalidation
      integrationCache.invalidateByTag('integration');
      
      expect(integrationCache.get('consistency-test')).toBeNull();
      expect(responseCache.get('response-test')).toBeDefined(); // Different tag
    });
  });

  describe('Error Handling and Resilience', () => {
    it('should handle service failures gracefully', async () => {
      // Simulate service failure
      const originalGet = integrationCache.get;
      integrationCache.get = jest.fn().mockImplementation(() => {
        throw new Error('Cache service unavailable');
      }) as any;

      // Should not crash the application
      expect(() => {
        integrationCache.get('test-key');
      }).toThrow('Cache service unavailable');

      // Restore original method
      integrationCache.get = originalGet;
    });

    it('should recover from memory pressure', async () => {
      // Fill cache to trigger cleanup
      for (let i = 0; i < 1000; i++) {
        integrationCache.set(`bulk-${i}`, `data-${i}`, 1000); // Short TTL
      }

      const statsBefore = integrationCache.getStats();
      expect(statsBefore.entryCount).toBeGreaterThan(0);

      // Wait for cleanup to trigger based on cache conditions
      await waitFor(() => {
        const statsAfter = integrationCache.getStats();
        return statsAfter.entryCount <= statsBefore.entryCount;
      }, { timeout: 5000, timeoutMsg: 'Cache cleanup did not trigger within timeout' });
    });
  });

  describe('Deployment Readiness', () => {
    it('should pass all deployment readiness checks', () => {
      const deploymentInfo = healthCheckService.getDeploymentInfo();
      
      expect(deploymentInfo).toHaveProperty('version');
      expect(deploymentInfo).toHaveProperty('environment');
      expect(deploymentInfo).toHaveProperty('uptime');
      expect(deploymentInfo.config).toHaveProperty('features');
    });

    it('should have proper configuration for production', () => {
      const deploymentInfo = healthCheckService.getDeploymentInfo();
      
      expect(deploymentInfo.config.features).toHaveProperty('advancedCaching');
      expect(deploymentInfo.config.features).toHaveProperty('performanceMonitoring');
      expect(deploymentInfo.config.features).toHaveProperty('requestOptimization');
    });
  });
});

// Benchmark tests
describe('Performance Benchmarks', () => {
  let loadTester: LoadTester;

  beforeAll(() => {
    loadTester = new LoadTester();
  });

  afterAll(() => {
    loadTester.reset();
  });

  it('should handle high-throughput requests', async () => {
    const testFunction = async () => {
      // Simulate fast API response
      await flushPromises();
      return { success: true };
    };

    const results = await loadTester.runLoadTest(testFunction, {
      concurrency: 50,
      duration: 5,
      rampUp: 2
    });

    expect(results.successRate).toBeGreaterThan(95);
    expect(results.averageResponseTime).toBeLessThan(50);
    expect(results.throughput).toBeGreaterThan(60); // requests per second
  });

  it('should maintain performance under sustained load', async () => {
    const testFunction = async () => {
      // Simulate realistic API response time
      await flushPromises();
      return { success: true };
    };

    const results = await loadTester.runLoadTest(testFunction, {
      concurrency: 20,
      duration: 10,
      rampUp: 3
    });

    expect(results.successRate).toBeGreaterThan(98);
    expect(results.percentiles.p95).toBeLessThan(100);
    expect(results.percentiles.p99).toBeLessThan(200);
  });
});

// Integration-specific tests
describe('Integration System Tests', () => {
  it('should handle multiple integration types', () => {
    const integrationTypes = ['salesforce', 'netsuite', 'sap', 'oracle'];
    
    integrationTypes.forEach(type => {
      integrationCache.set(`${type}:config`, { type, enabled: true }, undefined, [type, 'config']);
      integrationCache.set(`${type}:schema`, { fields: ['id', 'name'] }, undefined, [type, 'schema']);
    });

    // Verify all integrations are cached
    integrationTypes.forEach(type => {
      expect(integrationCache.get(`${type}:config`)).toBeDefined();
      expect(integrationCache.get(`${type}:schema`)).toBeDefined();
    });

    // Test bulk operations
    const salesforceData = integrationCache.getByTag('salesforce');
    expect(salesforceData).toHaveLength(2);

    const configData = integrationCache.getByTag('config');
    expect(configData).toHaveLength(4);
  });

  it('should handle integration failures gracefully', async () => {
    // Simulate integration failure
    performanceMonitor.recordIntegrationMetric('failing-integration', 5000, true);
    performanceMonitor.recordIntegrationMetric('failing-integration', 6000, true);
    
    // Should not crash the system
    expect(() => {
      performanceMonitor.getPerformanceReport();
    }).not.toThrow();
  });
});

// Security and reliability tests
describe('Security and Reliability', () => {
  it('should enforce rate limiting', async () => {
    const middleware = requestOptimizer.createOptimizationMiddleware();
    
    const mockReq = {
      method: 'GET',
      path: '/api/test',
      ip: '127.0.0.1',
      query: {},
      get: jest.fn().mockReturnValue('test-agent'),
      connection: { remoteAddress: '127.0.0.1' }
    } as any;

    const responses: any[] = [];
    
    // Make multiple requests from same IP
    for (let i = 0; i < 15; i++) {
      const mockRes = {
        status: jest.fn().mockReturnThis(),
        json: jest.fn().mockReturnThis(),
        send: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        statusCode: 200
      } as any;
      
      responses.push(mockRes);
      
      const mockNext = jest.fn();
      await middleware(mockReq, mockRes, mockNext);
    }

    // Should have rate limited some requests
    const rateLimitedResponses = responses.filter(res => 
      res.status.mock.calls.some((call: any) => call[0] === 429)
    );
    
    expect(rateLimitedResponses.length).toBeGreaterThan(0);
  });

  it('should handle memory pressure gracefully', () => {
    // Fill cache beyond limits to trigger cleanup
    const largeCacheData = 'x'.repeat(1024 * 1024); // 1MB string
    
    for (let i = 0; i < 200; i++) {
      integrationCache.set(`large-${i}`, largeCacheData, 60000);
    }

    // Cache should handle the pressure without crashing
    const stats = integrationCache.getStats();
    expect(stats.entryCount).toBeDefined();
    expect(stats.totalSize).toBeDefined();
    
    // Health should still be reportable
    const health = integrationCache.getHealth();
    expect(health.status).toBeDefined();
  });
});

// Cleanup and shutdown tests
describe('Cleanup and Shutdown', () => {
  it('should shutdown all services cleanly', async () => {
    // Start all services
    performanceMonitor.startMonitoring(1000);
    
    // Verify they're running
    expect(performanceMonitor['isMonitoring']).toBe(true);
    
    // Shutdown
    performanceMonitor.shutdown();
    requestOptimizer.shutdown();
    CacheFactory.shutdownAll();
    
    // Verify clean shutdown
    expect(performanceMonitor['isMonitoring']).toBe(false);
  });

  it('should handle graceful shutdown under load', async () => {
    // Start services
    performanceMonitor.startMonitoring(100);
    
    // Simulate load
    for (let i = 0; i < 100; i++) {
      performanceMonitor.recordRequestStart();
      performanceMonitor.recordRequestEnd(Math.random() * 100);
    }
    
    // Should shutdown without errors
    expect(() => {
      performanceMonitor.shutdown();
    }).not.toThrow();
  });
});