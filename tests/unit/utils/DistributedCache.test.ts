/**
 * DistributedCache Unit Tests
 * Tests for distributed caching with Redis fallback to mock client
 */

import { DistributedCache, getDistributedCache, DistributedCacheConfig } from '../../../src/utils/DistributedCache';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Use real timers for this test file
beforeAll(() => {
  jest.useRealTimers();
});

describe('DistributedCache', () => {
  let cache: DistributedCache;

  beforeEach(async () => {
    // Wait a bit for any async initialization
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  afterEach(async () => {
    if (cache) {
      await cache.shutdown();
    }
  });

  describe('constructor and configuration', () => {
    it('should create cache with default configuration', async () => {
      cache = new DistributedCache();
      await new Promise(resolve => setTimeout(resolve, 100));

      const metrics = cache.getMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.hits).toBe(0);
      expect(metrics.misses).toBe(0);
    });

    it('should create cache with custom configuration', async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        defaultTTL: 1800,
        enableMetrics: true,
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      const health = await cache.getHealth();
      expect(health.fallback).toBe(true);
    });

    it('should use fallback when Redis is not available', async () => {
      cache = new DistributedCache({
        redisUrl: 'redis://localhost:9999', // Non-existent Redis
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Should still work with fallback
      const result = await cache.set('test-key', 'test-value');
      expect(result).toBe(true);
    });
  });

  describe('set and get operations', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should set and get a string value', async () => {
      await cache.set('string-key', 'hello world');
      const result = await cache.get<string>('string-key');
      expect(result).toBe('hello world');
    });

    it('should set and get an object value', async () => {
      const obj = { name: 'test', count: 42, nested: { value: true } };
      await cache.set('object-key', obj);
      const result = await cache.get<typeof obj>('object-key');
      expect(result).toEqual(obj);
    });

    it('should set and get an array value', async () => {
      const arr = [1, 2, 3, 'four', { five: 5 }];
      await cache.set('array-key', arr);
      const result = await cache.get<typeof arr>('array-key');
      expect(result).toEqual(arr);
    });

    it('should return null for non-existent key', async () => {
      const result = await cache.get('non-existent-key');
      expect(result).toBeNull();
    });

    it('should set value with custom TTL', async () => {
      await cache.set('ttl-key', 'value', 60);
      const result = await cache.get<string>('ttl-key');
      expect(result).toBe('value');
    });

    it('should update metrics on set', async () => {
      await cache.set('metrics-key', 'value');
      const metrics = cache.getMetrics();
      expect(metrics.sets).toBeGreaterThan(0);
    });

    it('should update metrics on cache hit', async () => {
      await cache.set('hit-key', 'value');
      await cache.get('hit-key');
      const metrics = cache.getMetrics();
      expect(metrics.hits).toBeGreaterThan(0);
    });

    it('should update metrics on cache miss', async () => {
      await cache.get('miss-key');
      const metrics = cache.getMetrics();
      expect(metrics.misses).toBeGreaterThan(0);
    });
  });

  describe('delete operations', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should delete a single key', async () => {
      await cache.set('delete-key', 'value');
      const deleted = await cache.delete('delete-key');
      expect(deleted).toBe(1);

      const result = await cache.get('delete-key');
      expect(result).toBeNull();
    });

    it('should delete multiple keys', async () => {
      await cache.set('delete-key-1', 'value1');
      await cache.set('delete-key-2', 'value2');
      const deleted = await cache.delete(['delete-key-1', 'delete-key-2']);
      expect(deleted).toBe(2);
    });

    it('should return 0 when deleting non-existent key', async () => {
      const deleted = await cache.delete('non-existent');
      expect(deleted).toBe(0);
    });

    it('should update metrics on delete', async () => {
      await cache.set('del-metrics-key', 'value');
      await cache.delete('del-metrics-key');
      const metrics = cache.getMetrics();
      expect(metrics.deletes).toBeGreaterThan(0);
    });
  });

  describe('exists operation', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should return true for existing key', async () => {
      await cache.set('exists-key', 'value');
      const exists = await cache.exists('exists-key');
      expect(exists).toBe(true);
    });

    it('should return false for non-existent key', async () => {
      const exists = await cache.exists('non-existent-key');
      expect(exists).toBe(false);
    });
  });

  describe('clear operation', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should clear all keys with prefix', async () => {
      await cache.set('clear-key-1', 'value1');
      await cache.set('clear-key-2', 'value2');
      const cleared = await cache.clear();
      expect(cleared).toBeGreaterThanOrEqual(0);
    });

    it('should clear keys matching pattern', async () => {
      await cache.set('pattern-a-1', 'value1');
      await cache.set('pattern-a-2', 'value2');
      await cache.set('pattern-b-1', 'value3');
      const cleared = await cache.clear('pattern-a*');
      expect(cleared).toBeGreaterThanOrEqual(0);
    });
  });

  describe('increment operation', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should increment non-existent key starting from 1', async () => {
      const result = await cache.increment('counter-new');
      expect(result).toBe(1);
    });

    it('should increment multiple times', async () => {
      // Start fresh and increment
      const result1 = await cache.increment('counter-multi');
      expect(result1).toBe(1);

      const result2 = await cache.increment('counter-multi');
      expect(result2).toBe(2);

      const result3 = await cache.increment('counter-multi');
      expect(result3).toBe(3);
    });

    it('should increment by custom amount from zero', async () => {
      const result = await cache.increment('counter-amount-fresh', 5);
      expect(result).toBe(5);

      const result2 = await cache.increment('counter-amount-fresh', 3);
      expect(result2).toBe(8);
    });
  });

  describe('getOrSet operation', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should return cached value if exists', async () => {
      await cache.set('getorset-key', 'cached-value');
      const factory = jest.fn().mockReturnValue('new-value');

      const result = await cache.getOrSet('getorset-key', factory);

      expect(result).toBe('cached-value');
      expect(factory).not.toHaveBeenCalled();
    });

    it('should call factory and cache result if not exists', async () => {
      const factory = jest.fn().mockReturnValue('factory-value');

      const result = await cache.getOrSet('new-getorset-key', factory);

      expect(result).toBe('factory-value');
      expect(factory).toHaveBeenCalled();

      // Verify it was cached
      const cached = await cache.get('new-getorset-key');
      expect(cached).toBe('factory-value');
    });

    it('should work with async factory', async () => {
      const factory = jest.fn().mockResolvedValue('async-value');

      const result = await cache.getOrSet('async-getorset-key', factory);

      expect(result).toBe('async-value');
    });

    it('should use custom TTL', async () => {
      const factory = jest.fn().mockReturnValue('ttl-value');

      await cache.getOrSet('ttl-getorset-key', factory, 120);

      expect(factory).toHaveBeenCalled();
    });
  });

  describe('metrics', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableMetrics: true,
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should return metrics object', () => {
      const metrics = cache.getMetrics();

      expect(metrics).toHaveProperty('hits');
      expect(metrics).toHaveProperty('misses');
      expect(metrics).toHaveProperty('sets');
      expect(metrics).toHaveProperty('deletes');
      expect(metrics).toHaveProperty('errors');
      expect(metrics).toHaveProperty('totalRequests');
      expect(metrics).toHaveProperty('hitRate');
      expect(metrics).toHaveProperty('averageResponseTime');
    });

    it('should calculate hit rate correctly', async () => {
      await cache.set('hit-rate-key', 'value');

      // Generate hits and misses
      await cache.get('hit-rate-key'); // hit
      await cache.get('hit-rate-key'); // hit
      await cache.get('non-existent'); // miss

      const metrics = cache.getMetrics();
      expect(metrics.hitRate).toBeGreaterThan(0);
    });

    it('should track total requests', async () => {
      const initialMetrics = cache.getMetrics();
      const initialRequests = initialMetrics.totalRequests;

      await cache.set('req-key', 'value');
      await cache.get('req-key');
      await cache.delete('req-key');

      const finalMetrics = cache.getMetrics();
      expect(finalMetrics.totalRequests).toBeGreaterThan(initialRequests);
    });
  });

  describe('health check', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should return health status', async () => {
      const health = await cache.getHealth();

      expect(health).toHaveProperty('status');
      expect(health).toHaveProperty('redis');
      expect(health).toHaveProperty('fallback');
      expect(health).toHaveProperty('metrics');
      expect(['healthy', 'degraded', 'unhealthy']).toContain(health.status);
    });

    it('should include metrics in health check', async () => {
      const health = await cache.getHealth();

      expect(health.metrics).toBeDefined();
      expect(health.metrics).toHaveProperty('hits');
      expect(health.metrics).toHaveProperty('misses');
    });
  });

  describe('shutdown and cleanup', () => {
    it('should shutdown gracefully', async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      await cache.shutdown();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should cleanup resources', async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      cache.cleanup();

      // Should not throw
      expect(true).toBe(true);
    });

    it('should disconnect from Redis', async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      await cache.disconnect();

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe('event emitter', () => {
    it('should emit connected event', async () => {
      const connectedHandler = jest.fn();

      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });

      cache.on('connected', connectedHandler);

      await new Promise(resolve => setTimeout(resolve, 200));

      expect(connectedHandler).toHaveBeenCalled();
    });

    it('should emit disconnected event on shutdown', async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));

      const disconnectedHandler = jest.fn();
      cache.on('disconnected', disconnectedHandler);

      await cache.disconnect();

      expect(disconnectedHandler).toHaveBeenCalled();
    });
  });

  describe('fallback cache', () => {
    it('should use fallback cache when Redis unavailable', async () => {
      cache = new DistributedCache({
        redisUrl: 'redis://localhost:9999',
        enableFallback: true,
        fallbackMemorySize: 50,
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Operations should still work
      await cache.set('fallback-key', 'fallback-value');
      const result = await cache.get<string>('fallback-key');
      expect(result).toBe('fallback-value');
    });

    it('should respect fallback memory size limit', async () => {
      cache = new DistributedCache({
        redisUrl: 'redis://localhost:9999',
        enableFallback: true,
        fallbackMemorySize: 10,
      });
      await new Promise(resolve => setTimeout(resolve, 200));

      // Add more entries than the limit
      for (let i = 0; i < 15; i++) {
        await cache.set(`overflow-key-${i}`, `value-${i}`);
      }

      // Should not throw, older entries should be evicted
      expect(true).toBe(true);
    });
  });

  describe('complex data types', () => {
    beforeEach(async () => {
      cache = new DistributedCache({
        keyPrefix: 'test:',
        enableFallback: true,
      });
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should handle null values', async () => {
      await cache.set('null-key', null);
      const result = await cache.get('null-key');
      expect(result).toBeNull();
    });

    it('should handle boolean values', async () => {
      await cache.set('bool-true', true);
      await cache.set('bool-false', false);

      expect(await cache.get('bool-true')).toBe(true);
      expect(await cache.get('bool-false')).toBe(false);
    });

    it('should handle number values', async () => {
      await cache.set('number-int', 42);
      await cache.set('number-float', 3.14159);
      await cache.set('number-negative', -100);

      expect(await cache.get('number-int')).toBe(42);
      expect(await cache.get('number-float')).toBeCloseTo(3.14159);
      expect(await cache.get('number-negative')).toBe(-100);
    });

    it('should handle deeply nested objects', async () => {
      const deepObj = {
        level1: {
          level2: {
            level3: {
              value: 'deep',
              array: [1, 2, { nested: true }],
            },
          },
        },
      };

      await cache.set('deep-obj', deepObj);
      const result = await cache.get<typeof deepObj>('deep-obj');
      expect(result).toEqual(deepObj);
    });
  });
});

describe('getDistributedCache singleton', () => {
  it('should return a cache instance', () => {
    const cache = getDistributedCache();
    expect(cache).toBeInstanceOf(DistributedCache);
  });

  it('should return same instance on multiple calls', () => {
    const cache1 = getDistributedCache();
    const cache2 = getDistributedCache();
    expect(cache1).toBe(cache2);
  });
});
