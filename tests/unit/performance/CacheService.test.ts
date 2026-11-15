/**
 * CacheService Unit Tests
 * Tests for multi-level caching with Redis backend
 */

import 'reflect-metadata';
import { CacheService, CacheOptions } from '../../../src/performance/CacheService';
import { Logger } from '../../../src/utils/Logger';

// Mock ioredis
const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  del: jest.fn(),
  incrby: jest.fn(),
  expire: jest.fn(),
  keys: jest.fn().mockResolvedValue([]),
  info: jest.fn().mockResolvedValue('used_memory:1000'),
  dbsize: jest.fn().mockResolvedValue(10),
  flushdb: jest.fn(),
  disconnect: jest.fn(),
  on: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

describe('CacheService', () => {
  let cacheService: CacheService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    cacheService = new CacheService(mockLogger);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('initialize()', () => {
    it('should initialize cache service', async () => {
      await cacheService.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith('Cache service initialized');
    });

    it('should set up Redis event handlers', async () => {
      await cacheService.initialize();

      expect(mockRedis.on).toHaveBeenCalledWith('connect', expect.any(Function));
      expect(mockRedis.on).toHaveBeenCalledWith('error', expect.any(Function));
    });

    it('should set up memory cache cleanup interval', async () => {
      await cacheService.initialize();

      // Advance timers and check that cleanup is scheduled
      expect(jest.getTimerCount()).toBeGreaterThan(0);
    });
  });

  describe('get()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should return null for cache miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      const result = await cacheService.get('non-existent');

      expect(result).toBeNull();
    });

    it('should return value from L1 memory cache', async () => {
      // First set a value
      await cacheService.set('test-key', { data: 'value' });

      // Then get it - should come from memory
      const result = await cacheService.get<{ data: string }>('test-key');

      expect(result).toEqual({ data: 'value' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cache hit (L1)',
        expect.any(Object)
      );
    });

    it('should return value from L2 Redis cache', async () => {
      mockRedis.get.mockResolvedValueOnce(JSON.stringify({ data: 'redis-value' }));

      const result = await cacheService.get<{ data: string }>('redis-key');

      expect(result).toEqual({ data: 'redis-value' });
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Cache hit (L2)',
        expect.any(Object)
      );
    });

    it('should use namespace in cache key', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await cacheService.get('key', { namespace: 'my-namespace' });

      expect(mockRedis.get).toHaveBeenCalledWith('my-namespace:key');
    });

    it('should handle deserialization error', async () => {
      mockRedis.get.mockResolvedValueOnce('not-valid-json{');

      const result = await cacheService.get('bad-json');

      expect(result).toBeNull();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Failed to deserialize cached value',
        expect.any(Object)
      );
    });

    it('should track cache miss statistics', async () => {
      mockRedis.get.mockResolvedValueOnce(null);

      await cacheService.get('miss-key');

      const stats = await cacheService.getStats();
      expect(stats.misses).toBe(1);
    });

    it('should handle get error gracefully', async () => {
      mockRedis.get.mockRejectedValueOnce(new Error('Redis error'));

      const result = await cacheService.get('error-key');

      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Cache get error',
        expect.any(Object)
      );
    });
  });

  describe('set()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should set value in both L1 and L2 cache', async () => {
      await cacheService.set('test-key', { data: 'value' });

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'default:test-key',
        3600, // default TTL
        JSON.stringify({ data: 'value' })
      );
    });

    it('should use custom TTL', async () => {
      await cacheService.set('test-key', 'value', { ttl: 60 });

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'default:test-key',
        60,
        JSON.stringify('value')
      );
    });

    it('should use namespace', async () => {
      await cacheService.set('key', 'value', { namespace: 'custom' });

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'custom:key',
        3600,
        JSON.stringify('value')
      );
    });

    it('should skip serialization when serialize is false', async () => {
      await cacheService.set('key', 'raw-string', { serialize: false });

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'default:key',
        3600,
        'raw-string'
      );
    });

    it('should handle set error', async () => {
      mockRedis.setex.mockRejectedValueOnce(new Error('Redis error'));

      await expect(
        cacheService.set('key', 'value')
      ).rejects.toThrow('Redis error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Cache set error',
        expect.any(Object)
      );
    });
  });

  describe('delete()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should delete from both L1 and L2 cache', async () => {
      // First set a value
      await cacheService.set('delete-key', 'value');

      // Then delete it
      await cacheService.delete('delete-key');

      expect(mockRedis.del).toHaveBeenCalledWith('default:delete-key');
    });

    it('should use namespace', async () => {
      await cacheService.delete('key', { namespace: 'custom' });

      expect(mockRedis.del).toHaveBeenCalledWith('custom:key');
    });

    it('should handle delete error', async () => {
      mockRedis.del.mockRejectedValueOnce(new Error('Redis error'));

      await expect(
        cacheService.delete('key')
      ).rejects.toThrow('Redis error');
    });
  });

  describe('getOrSet()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should return cached value if present', async () => {
      // Pre-populate cache
      await cacheService.set('existing-key', { cached: true });

      const factory = jest.fn().mockResolvedValue({ fresh: true });

      const result = await cacheService.getOrSet('existing-key', factory);

      expect(result).toEqual({ cached: true });
      expect(factory).not.toHaveBeenCalled();
    });

    it('should call factory and cache result on miss', async () => {
      mockRedis.get.mockResolvedValueOnce(null);
      const factory = jest.fn().mockResolvedValue({ fresh: true });

      const result = await cacheService.getOrSet('new-key', factory);

      expect(result).toEqual({ fresh: true });
      expect(factory).toHaveBeenCalled();
      expect(mockRedis.setex).toHaveBeenCalled();
    });
  });

  describe('increment()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should increment counter', async () => {
      mockRedis.incrby.mockResolvedValueOnce(5);

      const result = await cacheService.increment('counter');

      expect(result).toBe(5);
      expect(mockRedis.incrby).toHaveBeenCalledWith('default:counter', 1);
    });

    it('should increment by custom amount', async () => {
      mockRedis.incrby.mockResolvedValueOnce(10);

      const result = await cacheService.increment('counter', 5);

      expect(result).toBe(10);
      expect(mockRedis.incrby).toHaveBeenCalledWith('default:counter', 5);
    });

    it('should set TTL if specified', async () => {
      mockRedis.incrby.mockResolvedValueOnce(1);

      await cacheService.increment('counter', 1, { ttl: 60 });

      expect(mockRedis.expire).toHaveBeenCalledWith('default:counter', 60);
    });
  });

  describe('getMultiple()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should get multiple keys', async () => {
      mockRedis.get
        .mockResolvedValueOnce(JSON.stringify('value1'))
        .mockResolvedValueOnce(JSON.stringify('value2'))
        .mockResolvedValueOnce(null);

      const result = await cacheService.getMultiple<string>(['key1', 'key2', 'key3']);

      expect(result.get('key1')).toBe('value1');
      expect(result.get('key2')).toBe('value2');
      expect(result.get('key3')).toBeNull();
    });
  });

  describe('setMultiple()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should set multiple key-value pairs', async () => {
      const entries = [
        { key: 'key1', value: 'value1' },
        { key: 'key2', value: 'value2' },
      ];

      await cacheService.setMultiple(entries);

      expect(mockRedis.setex).toHaveBeenCalledTimes(2);
    });
  });

  describe('clearByPattern()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should clear keys matching pattern', async () => {
      mockRedis.keys.mockResolvedValueOnce(['key1', 'key2']);

      const deleted = await cacheService.clearByPattern('key*');

      expect(deleted).toBe(2);
      expect(mockRedis.del).toHaveBeenCalledWith('key1', 'key2');
    });

    it('should return 0 when no keys match', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);

      const deleted = await cacheService.clearByPattern('nonexistent*');

      expect(deleted).toBe(0);
    });

    it('should use namespace in pattern', async () => {
      mockRedis.keys.mockResolvedValueOnce([]);

      await cacheService.clearByPattern('key*', 'my-namespace');

      expect(mockRedis.keys).toHaveBeenCalledWith('my-namespace:key*');
    });

    it('should clear matching keys from memory cache', async () => {
      // Set some values in memory
      await cacheService.set('match1', 'value1', { namespace: 'test' });
      await cacheService.set('match2', 'value2', { namespace: 'test' });

      mockRedis.keys.mockResolvedValueOnce(['test:match*']);

      await cacheService.clearByPattern('match*', 'test');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cache cleared by pattern',
        expect.any(Object)
      );
    });
  });

  describe('getStats()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should return cache statistics', async () => {
      // Perform some operations
      mockRedis.get.mockResolvedValue(null);
      await cacheService.get('miss1');
      await cacheService.get('miss2');
      await cacheService.set('hit1', 'value');
      await cacheService.get('hit1'); // L1 hit

      const stats = await cacheService.getStats();

      expect(stats.misses).toBe(2);
      expect(stats.hits).toBe(1);
      expect(stats.totalOperations).toBe(3);
      expect(stats.hitRate).toBeGreaterThan(0);
    });

    it('should include Redis memory usage', async () => {
      mockRedis.info.mockResolvedValueOnce('used_memory:5000');
      mockRedis.dbsize.mockResolvedValueOnce(100);

      const stats = await cacheService.getStats();

      expect(stats.memoryUsage).toBe(5000);
      expect(stats.keyCount).toBeGreaterThanOrEqual(100);
    });

    it('should handle Redis stats error gracefully', async () => {
      mockRedis.info.mockRejectedValueOnce(new Error('Redis error'));

      const stats = await cacheService.getStats();

      expect(stats.memoryUsage).toBe(0);
    });
  });

  describe('flush()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should clear all cache and reset stats', async () => {
      // Add some data
      await cacheService.set('key1', 'value1');
      await cacheService.set('key2', 'value2');

      await cacheService.flush();

      expect(mockRedis.flushdb).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Cache flushed');

      const stats = await cacheService.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
    });

    it('should handle flush error', async () => {
      mockRedis.flushdb.mockRejectedValueOnce(new Error('Redis error'));

      await expect(cacheService.flush()).rejects.toThrow('Redis error');
    });
  });

  describe('shutdown()', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should disconnect Redis and clear memory', async () => {
      await cacheService.shutdown();

      expect(mockRedis.disconnect).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('Cache service shutdown completed');
    });
  });

  describe('memory cache management', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should expire entries from memory cache', async () => {
      // Set with very short TTL
      await cacheService.set('expiring', 'value', { ttl: 1 });

      // Verify it exists initially
      const before = await cacheService.get<string>('expiring');
      expect(before).toBe('value');

      // Advance time past expiration
      jest.advanceTimersByTime(310000); // 5+ minutes (memory TTL)

      // Clear Redis mock so we know memory returned null
      mockRedis.get.mockResolvedValueOnce(null);

      const after = await cacheService.get<string>('expiring');
      expect(after).toBeNull();
    });
  });

  describe('edge cases', () => {
    beforeEach(async () => {
      await cacheService.initialize();
    });

    it('should handle null values', async () => {
      await cacheService.set('null-key', null);

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(null));

      const result = await cacheService.get('null-key');
      // null is cached and returned as null, but get() returns null for both "not found" and "stored null"
      expect(result).toBeNull();
    });

    it('should handle complex objects', async () => {
      const complexObject = {
        nested: {
          array: [1, 2, { key: 'value' }],
          date: '2024-01-01',
        },
        count: 42,
      };

      await cacheService.set('complex', complexObject);

      expect(mockRedis.setex).toHaveBeenCalledWith(
        'default:complex',
        3600,
        JSON.stringify(complexObject)
      );
    });

    it('should handle empty strings', async () => {
      await cacheService.set('empty', '');

      mockRedis.get.mockResolvedValueOnce(JSON.stringify(''));

      const result = await cacheService.get<string>('empty');
      // Empty string is falsy but JSON.parse('""') returns ''
      expect(result).toBe('');
    });
  });
});
