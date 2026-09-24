/**
 * MemoryCache Unit Tests
 * Tests for in-memory caching utility
 */

// Mock logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { MemoryCache, CacheManager, CacheWarmer } from '../../../src/utils/MemoryCache';

describe('MemoryCache', () => {
  let cache: MemoryCache<string>;

  beforeEach(() => {
    cache = new MemoryCache<string>({
      defaultTtl: 10,
      maxSize: 5,
      cleanupInterval: 60,
    });
  });

  afterEach(() => {
    cache.destroy();
  });

  describe('set and get', () => {
    it('should set and retrieve a value', () => {
      cache.set('key1', 'value1');
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return undefined for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('should overwrite existing value', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');
      expect(cache.get('key1')).toBe('value2');
    });

    it('should respect custom TTL', async () => {
      cache.set('key1', 'value1', 0.1); // 100ms TTL
      expect(cache.get('key1')).toBe('value1');
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should evict LRU entries when max size reached', () => {
      for (let i = 0; i < 6; i++) {
        cache.set(`key${i}`, `value${i}`);
      }
      // First entry should be evicted
      expect(cache.get('key0')).toBeUndefined();
      expect(cache.get('key5')).toBe('value5');
    });
  });

  describe('has', () => {
    it('should return true for existing key', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return false for expired key', async () => {
      cache.set('key1', 'value1', 0.1); // 100ms TTL
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('delete', () => {
    it('should delete existing key', () => {
      cache.set('key1', 'value1');
      expect(cache.delete('key1')).toBe(true);
      expect(cache.get('key1')).toBeUndefined();
    });

    it('should return false for non-existent key', () => {
      expect(cache.delete('nonexistent')).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all entries', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.clear();
      expect(cache.get('key1')).toBeUndefined();
      expect(cache.get('key2')).toBeUndefined();
    });
  });

  describe('getStats', () => {
    it('should track hits and misses', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(2);
      expect(stats.misses).toBe(1);
      expect(stats.sets).toBe(1);
    });

    it('should calculate hit rate', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.67, 1);
    });

    it('should track total size', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'longer value here');

      const stats = cache.getStats();
      expect(stats.totalSize).toBeGreaterThan(0);
    });
  });

  describe('getKeys', () => {
    it('should return all keys', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      const keys = cache.getKeys();
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
    });
  });

  describe('getEntries', () => {
    it('should return all entries', () => {
      cache.set('key1', 'value1');

      const entries = cache.getEntries();
      expect(entries.length).toBe(1);
      expect(entries[0].key).toBe('key1');
      expect(entries[0].entry.value).toBe('value1');
    });
  });

  describe('events', () => {
    it('should emit set event', (done) => {
      cache.on('set', (key, value) => {
        expect(key).toBe('key1');
        expect(value).toBe('value1');
        done();
      });
      cache.set('key1', 'value1');
    });

    it('should emit hit event', (done) => {
      cache.set('key1', 'value1');
      cache.on('hit', (key, value) => {
        expect(key).toBe('key1');
        expect(value).toBe('value1');
        done();
      });
      cache.get('key1');
    });

    it('should emit delete event', (done) => {
      cache.set('key1', 'value1');
      cache.on('delete', (key) => {
        expect(key).toBe('key1');
        done();
      });
      cache.delete('key1');
    });

    it('should emit clear event', (done) => {
      cache.set('key1', 'value1');
      cache.on('clear', () => {
        done();
      });
      cache.clear();
    });

    it('should emit evict event', (done) => {
      cache.on('evict', (key) => {
        expect(key).toBe('key0');
        done();
      });
      // Fill to max and then add one more
      for (let i = 0; i < 6; i++) {
        cache.set(`key${i}`, `value${i}`);
      }
    });
  });

  describe('shutdown', () => {
    it('should clear cache and stop cleanup', async () => {
      cache.set('key1', 'value1');
      await cache.shutdown();
      expect(cache.getStats().entries).toBe(0);
    });
  });

  describe('destroy', () => {
    it('should clear cache and stop cleanup synchronously', () => {
      cache.set('key1', 'value1');
      cache.destroy();
      expect(cache.getStats().entries).toBe(0);
    });
  });
});

describe('CacheManager', () => {
  let manager: CacheManager;

  beforeEach(() => {
    manager = new CacheManager();
  });

  afterEach(async () => {
    await manager.shutdown();
  });

  it('should create named caches', () => {
    const cache1 = manager.getCache<string>('cache1');
    const cache2 = manager.getCache<number>('cache2');

    cache1.set('key', 'value');
    cache2.set('key', 123);

    expect(cache1.get('key')).toBe('value');
    expect(cache2.get('key')).toBe(123);
  });

  it('should return same cache for same name', () => {
    const cache1 = manager.getCache('test');
    const cache2 = manager.getCache('test');
    expect(cache1).toBe(cache2);
  });

  it('should get stats for all caches', () => {
    const cache1 = manager.getCache('cache1');
    const cache2 = manager.getCache('cache2');

    cache1.set('key', 'value');
    cache2.set('key', 'value');

    const stats = manager.getAllStats();
    expect(stats).toHaveProperty('cache1');
    expect(stats).toHaveProperty('cache2');
  });

  it('should shutdown all caches', async () => {
    const cache1 = manager.getCache('cache1');
    cache1.set('key', 'value');

    await manager.shutdown();
    // Shutdown clears caches map, getAllStats should be empty
    expect(Object.keys(manager.getAllStats()).length).toBe(0);
  });
});

describe('CacheWarmer', () => {
  let cache: MemoryCache<string>;
  let warmer: CacheWarmer;

  beforeEach(() => {
    cache = new MemoryCache({ defaultTtl: 300 });
    warmer = new CacheWarmer(cache);
  });

  afterEach(() => {
    cache.destroy();
  });

  it('should warm up cache with fetched data', async () => {
    const fetcher = jest.fn().mockImplementation(async (key) => `value-${key}`);

    await warmer.warmUp(['key1', 'key2', 'key3'], fetcher, { batchSize: 2 });

    expect(cache.get('key1')).toBe('value-key1');
    expect(cache.get('key2')).toBe('value-key2');
    expect(cache.get('key3')).toBe('value-key3');
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('should handle fetch errors gracefully', async () => {
    const fetcher = jest.fn()
      .mockResolvedValueOnce('value1')
      .mockRejectedValueOnce(new Error('Fetch error'))
      .mockResolvedValueOnce('value3');

    await warmer.warmUp(['key1', 'key2', 'key3'], fetcher);

    expect(cache.get('key1')).toBe('value1');
    expect(cache.get('key2')).toBeUndefined();
    expect(cache.get('key3')).toBe('value3');
  });

  it('should use custom TTL', async () => {
    const fetcher = jest.fn().mockResolvedValue('value');

    await warmer.warmUp(['key1'], fetcher, { ttl: 1 });

    expect(cache.get('key1')).toBe('value');
  });
});
