import { MemoryCache } from '../../utils/MemoryCache';

describe('MemoryCache', () => {
  let cache: MemoryCache<string>;

  beforeEach(() => {
    cache = new MemoryCache<string>({
      maxSize: 3,
      defaultTtl: 1, // 1 second TTL for testing
      cleanupInterval: 0.1, // 0.1 seconds cleanup interval
    });
  });

  afterEach(async () => {
    await cache.clear();
    cache.destroy();
  });

  describe('Basic Operations', () => {
    it('should store and retrieve values', () => {
      cache.set('key1', 'value1');
      const result = cache.get('key1');

      expect(result).toBe('value1');
    });

    it('should return undefined for non-existent keys', () => {
      const result = cache.get('nonexistent');

      expect(result).toBeUndefined();
    });

    it('should handle has() method correctly', () => {
      cache.set('key1', 'value1');

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should delete keys correctly', () => {
      cache.set('key1', 'value1');
      expect(cache.has('key1')).toBe(true);

      cache.delete('key1');
      expect(cache.has('key1')).toBe(false);
    });
  });

  describe('TTL (Time To Live)', () => {
    it('should expire entries after TTL', async () => {
      cache.set('key1', 'value1', 0.05); // 0.05 seconds TTL

      expect(cache.get('key1')).toBe('value1');

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 60));

      expect(cache.get('key1')).toBeUndefined();
    });

    it('should use default TTL when not specified', async () => {
      cache.set('key1', 'value1');

      expect(cache.get('key1')).toBe('value1');

      // Wait longer than default TTL
      await new Promise(resolve => setTimeout(resolve, 1100));

      expect(cache.get('key1')).toBeUndefined();
    });
  });

  describe('Size Limits', () => {
    it('should enforce maximum size limit', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');

      // All should be present
      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);

      // Adding fourth item should evict oldest
      cache.set('key4', 'value4');

      expect(cache.has('key1')).toBe(false); // Evicted
      expect(cache.has('key2')).toBe(true);
      expect(cache.has('key3')).toBe(true);
      expect(cache.has('key4')).toBe(true);
    });
  });

  describe('Statistics', () => {
    it('should track cache statistics', () => {
      cache.set('key1', 'value1');
      cache.get('key1'); // Hit
      cache.get('nonexistent'); // Miss

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.entries).toBe(1);
    });

    it('should calculate hit rate correctly', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      cache.get('key1'); // Hit
      cache.get('key2'); // Hit
      cache.get('nonexistent'); // Miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(0.67, 2);
    });
  });

  describe('Clear Cache', () => {
    it('should clear all entries from the cache', async () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      await cache.clear();

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);
      expect(cache.getStats().entries).toBe(0);
    });
  });

  describe('Concurrency', () => {
    it('should handle concurrent reads and writes', async () => {
      const promises = [];

      for (let i = 0; i < 100; i++) {
        promises.push(cache.set(`key${i}`, `value${i}`));
        promises.push(cache.get(`key${i % 50}`)); // Some hits, some misses
      }

      await Promise.all(promises);

      // Check final state
      expect(cache.getStats().entries).toBe(3); // Max size
    });
  });

  describe('Cleanup', () => {
    it('should clear all entries', async () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      expect(cache.has('key1')).toBe(true);
      expect(cache.has('key2')).toBe(true);

      await cache.clear();

      expect(cache.has('key1')).toBe(false);
      expect(cache.has('key2')).toBe(false);
    });

    it('should cleanup expired entries automatically', async () => {
      const shortTtlCache = new MemoryCache<string>({
        maxSize: 10,
        defaultTtl: 0.05, // 0.05 seconds TTL
        cleanupInterval: 0.025, // Cleanup every 0.025 seconds
      });

      shortTtlCache.set('key1', 'value1');
      expect(shortTtlCache.has('key1')).toBe(true);

      // Wait for cleanup cycle
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(shortTtlCache.has('key1')).toBe(false);

      shortTtlCache.destroy();
    });
  });

  describe('Edge Cases', () => {
    it('should handle undefined and null values', () => {
      cache.set('undefined', undefined as any);
      cache.set('null', null as any);

      expect(cache.get('undefined')).toBeUndefined();
      expect(cache.get('null')).toBeNull();
    });

    it('should handle empty string keys', () => {
      cache.set('', 'empty-key-value');

      expect(cache.get('')).toBe('empty-key-value');
    });
  });
});
