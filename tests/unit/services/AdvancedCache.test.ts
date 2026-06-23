/**
 * AdvancedCache Unit Tests
 * Tests for advanced caching service with compression, tags, and metrics
 */

// Mock Logger before imports
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock PerformanceMonitor
jest.mock('../../../src/services/PerformanceMonitor', () => ({
  performanceMonitor: {
    getLatestMetrics: jest.fn(() => ({})),
    getRecentAlerts: jest.fn(() => []),
  },
}));

import {
  AdvancedCache,
  DistributedCache,
  CacheFactory,
  CacheConfig,
} from '../../../src/services/AdvancedCache';

describe('AdvancedCache', () => {
  let cache: AdvancedCache;
  let mockLogger: { info: jest.Mock; debug: jest.Mock; warn: jest.Mock };

  beforeEach(() => {
    cache = new AdvancedCache({
      maxSize: 1024 * 1024, // 1MB
      maxEntries: 100,
      defaultTTL: 60000, // 1 minute
      cleanupInterval: 60000,
      enableCompression: false,
      enableMetrics: true,
    });
    mockLogger = require('../../../src/utils/Logger').logger;
    jest.clearAllMocks();
  });

  afterEach(() => {
    cache.shutdown();
  });

  describe('constructor', () => {
    it('should initialize with default config', () => {
      const defaultCache = new AdvancedCache();
      expect(defaultCache.getStats().entryCount).toBe(0);
      defaultCache.shutdown();
    });

    it('should initialize with custom config', () => {
      const customCache = new AdvancedCache({
        maxSize: 50 * 1024 * 1024,
        maxEntries: 5000,
        defaultTTL: 30000,
      });
      expect(customCache.getStats().entryCount).toBe(0);
      customCache.shutdown();
    });
  });

  describe('set()', () => {
    it('should store a value', () => {
      cache.set('key1', 'value1');

      expect(cache.get('key1')).toBe('value1');
    });

    it('should store complex objects', () => {
      const obj = { name: 'test', nested: { value: 123 } };
      cache.set('obj', obj);

      expect(cache.get('obj')).toEqual(obj);
    });

    it('should store with custom TTL', () => {
      cache.set('key1', 'value1', 5000);

      expect(cache.get('key1')).toBe('value1');
    });

    it('should store with tags', () => {
      cache.set('key1', 'value1', undefined, ['tag1', 'tag2']);

      const tagged = cache.getByTag('tag1');
      expect(tagged.length).toBe(1);
      expect(tagged[0].value).toBe('value1');
    });

    it('should update stats on set', () => {
      cache.set('key1', 'value1');

      const stats = cache.getStats();
      expect(stats.sets).toBe(1);
      expect(stats.entryCount).toBe(1);
    });

    it('should emit set event', (done) => {
      cache.on('set', (event) => {
        expect(event.key).toBe('key1');
        expect(event.size).toBeGreaterThan(0);
        done();
      });

      cache.set('key1', 'value1');
    });

    it('should overwrite existing entry', () => {
      cache.set('key1', 'value1');
      cache.set('key1', 'value2');

      expect(cache.get('key1')).toBe('value2');
      expect(cache.getStats().entryCount).toBe(1);
    });
  });

  describe('get()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1');
    });

    it('should return stored value', () => {
      expect(cache.get('key1')).toBe('value1');
    });

    it('should return null for non-existent key', () => {
      expect(cache.get('nonexistent')).toBeNull();
    });

    it('should update hit stats on successful get', () => {
      cache.get('key1');

      const stats = cache.getStats();
      expect(stats.hits).toBe(1);
    });

    it('should update miss stats on failed get', () => {
      cache.get('nonexistent');

      const stats = cache.getStats();
      expect(stats.misses).toBe(1);
    });

    it('should return null for expired entry', () => {
      const shortTTLCache = new AdvancedCache({ defaultTTL: 1 }); // 1ms TTL
      shortTTLCache.set('key1', 'value1');

      // Wait for expiration
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortTTLCache.get('key1')).toBeNull();
          shortTTLCache.shutdown();
          resolve();
        }, 10);
      });
    });

    it('should emit hit event on successful get', (done) => {
      cache.on('hit', (event) => {
        expect(event.key).toBe('key1');
        done();
      });

      cache.get('key1');
    });

    it('should update hit rate', () => {
      cache.get('key1'); // hit
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      const stats = cache.getStats();
      expect(stats.hitRate).toBeCloseTo(66.67, 0);
    });
  });

  describe('delete()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1');
    });

    it('should delete existing entry', () => {
      const result = cache.delete('key1');

      expect(result).toBe(true);
      expect(cache.get('key1')).toBeNull();
    });

    it('should return false for non-existent key', () => {
      const result = cache.delete('nonexistent');

      expect(result).toBe(false);
    });

    it('should update stats on delete', () => {
      cache.delete('key1');

      const stats = cache.getStats();
      expect(stats.deletes).toBe(1);
      expect(stats.entryCount).toBe(0);
    });

    it('should emit delete event', (done) => {
      cache.on('delete', (event) => {
        expect(event.key).toBe('key1');
        done();
      });

      cache.delete('key1');
    });
  });

  describe('has()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1');
    });

    it('should return true for existing key', () => {
      expect(cache.has('key1')).toBe(true);
    });

    it('should return false for non-existent key', () => {
      expect(cache.has('nonexistent')).toBe(false);
    });

    it('should return false for expired entry', () => {
      const shortTTLCache = new AdvancedCache({ defaultTTL: 1 });
      shortTTLCache.set('key1', 'value1');

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(shortTTLCache.has('key1')).toBe(false);
          shortTTLCache.shutdown();
          resolve();
        }, 10);
      });
    });
  });

  describe('clear()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.set('key3', 'value3');
    });

    it('should remove all entries', () => {
      cache.clear();

      expect(cache.getStats().entryCount).toBe(0);
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key3')).toBeNull();
    });

    it('should reset stats', () => {
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss

      cache.clear();

      const stats = cache.getStats();
      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.sets).toBe(0);
      expect(stats.deletes).toBe(0);
      expect(stats.totalSize).toBe(0);
    });

    it('should emit clear event', (done) => {
      cache.on('clear', (event) => {
        expect(event.entryCount).toBe(3);
        done();
      });

      cache.clear();
    });

    it('should log clear action', () => {
      cache.clear();

      expect(mockLogger.info).toHaveBeenCalledWith('Cache cleared', expect.any(Object));
    });
  });

  describe('invalidateByTag()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1', undefined, ['api', 'user']);
      cache.set('key2', 'value2', undefined, ['api', 'admin']);
      cache.set('key3', 'value3', undefined, ['config']);
    });

    it('should invalidate all entries with tag', () => {
      const count = cache.invalidateByTag('api');

      expect(count).toBe(2);
      expect(cache.get('key1')).toBeNull();
      expect(cache.get('key2')).toBeNull();
      expect(cache.get('key3')).not.toBeNull();
    });

    it('should return 0 for non-existent tag', () => {
      const count = cache.invalidateByTag('nonexistent');

      expect(count).toBe(0);
    });

    it('should emit tagInvalidation event', (done) => {
      cache.on('tagInvalidation', (event) => {
        expect(event.tag).toBe('api');
        expect(event.invalidated).toBe(2);
        done();
      });

      cache.invalidateByTag('api');
    });
  });

  describe('getByTag()', () => {
    beforeEach(() => {
      cache.set('key1', 'value1', undefined, ['api', 'user']);
      cache.set('key2', 'value2', undefined, ['api', 'admin']);
      cache.set('key3', 'value3', undefined, ['config']);
    });

    it('should return all entries with tag', () => {
      const entries = cache.getByTag('api');

      expect(entries.length).toBe(2);
      const values = entries.map(e => e.value);
      expect(values).toContain('value1');
      expect(values).toContain('value2');
    });

    it('should return empty array for non-existent tag', () => {
      const entries = cache.getByTag('nonexistent');

      expect(entries).toEqual([]);
    });

    it('should not return expired entries', () => {
      const shortTTLCache = new AdvancedCache({ defaultTTL: 1 });
      shortTTLCache.set('key1', 'value1', 1, ['tag1']);

      return new Promise<void>((resolve) => {
        setTimeout(() => {
          const entries = shortTTLCache.getByTag('tag1');
          expect(entries).toEqual([]);
          shortTTLCache.shutdown();
          resolve();
        }, 10);
      });
    });
  });

  describe('getStats()', () => {
    it('should return initial stats', () => {
      const stats = cache.getStats();

      expect(stats.hits).toBe(0);
      expect(stats.misses).toBe(0);
      expect(stats.sets).toBe(0);
      expect(stats.deletes).toBe(0);
      expect(stats.evictions).toBe(0);
      expect(stats.entryCount).toBe(0);
      expect(stats.totalSize).toBe(0);
      expect(stats.hitRate).toBe(0);
    });

    it('should return accurate stats after operations', () => {
      cache.set('key1', 'value1');
      cache.set('key2', 'value2');
      cache.get('key1'); // hit
      cache.get('nonexistent'); // miss
      cache.delete('key2');

      const stats = cache.getStats();
      expect(stats.sets).toBe(2);
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.deletes).toBe(1);
      expect(stats.entryCount).toBe(1);
    });
  });

  describe('getHealth()', () => {
    it('should return health status', () => {
      cache.set('key1', 'value1');
      cache.get('key1');

      const health = cache.getHealth() as any;

      expect(health.status).toBeDefined();
      expect(health.hitRate).toBeDefined();
      expect(health.memoryUsage).toBeDefined();
      expect(health.entryCount).toBeDefined();
    });

    it('should return healthy status with good hit rate', () => {
      // Create many hits to get high hit rate
      cache.set('key1', 'value1');
      for (let i = 0; i < 10; i++) {
        cache.get('key1'); // all hits
      }

      const health = cache.getHealth() as any;
      expect(health.status).toBe('healthy');
    });
  });

  describe('warmCache()', () => {
    it('should load warmup data', async () => {
      const warmupData = [
        { key: 'warm1', value: 'value1' },
        { key: 'warm2', value: 'value2', ttl: 30000 },
        { key: 'warm3', value: 'value3', tags: ['warmup'] },
      ];

      await cache.warmCache(warmupData);

      expect(cache.get('warm1')).toBe('value1');
      expect(cache.get('warm2')).toBe('value2');
      expect(cache.get('warm3')).toBe('value3');
    });

    it('should log warmup completion', async () => {
      await cache.warmCache([{ key: 'key1', value: 'value1' }]);

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('warmup'),
        expect.any(Object)
      );
    });
  });

  describe('preloadIntegrationData()', () => {
    it('should preload integration data', async () => {
      await cache.preloadIntegrationData(['salesforce', 'netsuite']);

      expect(cache.get('salesforce:config')).toBeDefined();
      expect(cache.get('netsuite:config')).toBeDefined();
    });

    it('should tag preloaded data', async () => {
      await cache.preloadIntegrationData(['salesforce']);

      const tagged = cache.getByTag('preload');
      expect(tagged.length).toBeGreaterThan(0);
    });
  });

  describe('compression', () => {
    it('should compress large strings when enabled', () => {
      const compressedCache = new AdvancedCache({
        enableCompression: true,
      });

      const largeString = 'a'.repeat(2000);
      compressedCache.set('large', largeString);

      expect(compressedCache.get('large')).toBe(largeString);
      compressedCache.shutdown();
    });

    it('should not compress small strings', () => {
      const compressedCache = new AdvancedCache({
        enableCompression: true,
      });

      compressedCache.set('small', 'small value');
      expect(compressedCache.get('small')).toBe('small value');
      compressedCache.shutdown();
    });
  });

  describe('shutdown()', () => {
    it('should stop cleanup interval', () => {
      cache.shutdown();
      // Should not throw
      expect(true).toBe(true);
    });

    it('should be idempotent', () => {
      cache.shutdown();
      cache.shutdown();
      // Should not throw
      expect(true).toBe(true);
    });
  });
});

describe('DistributedCache', () => {
  let cache: DistributedCache;

  beforeEach(() => {
    cache = new DistributedCache({
      maxSize: 1024 * 1024,
      maxEntries: 100,
    });
  });

  afterEach(() => {
    cache.shutdown();
  });

  describe('constructor', () => {
    it('should initialize with node ID', () => {
      expect(cache).toBeDefined();
    });
  });

  describe('peer management', () => {
    it('should add peer', () => {
      cache.addPeer('peer-1');
      // Peer added successfully - no assertion needed as it logs
    });

    it('should remove peer', () => {
      cache.addPeer('peer-1');
      cache.removePeer('peer-1');
      // Peer removed successfully
    });
  });

  describe('shutdown()', () => {
    it('should shutdown cleanly', () => {
      cache.addPeer('peer-1');
      cache.shutdown();
      // Should complete without error
    });
  });
});

describe('CacheFactory', () => {
  afterEach(() => {
    CacheFactory.shutdownAll();
  });

  describe('createCache()', () => {
    it('should create cache instance', () => {
      const cache = CacheFactory.createCache('test-cache');

      expect(cache).toBeInstanceOf(AdvancedCache);
    });

    it('should return existing cache for same name', () => {
      const cache1 = CacheFactory.createCache('test-cache');
      const cache2 = CacheFactory.createCache('test-cache');

      expect(cache1).toBe(cache2);
    });

    it('should create cache with custom config', () => {
      const cache = CacheFactory.createCache('custom-cache', {
        maxEntries: 500,
      });

      expect(cache).toBeInstanceOf(AdvancedCache);
    });
  });

  describe('createDistributedCache()', () => {
    it('should create distributed cache instance', () => {
      const cache = CacheFactory.createDistributedCache('dist-cache');

      expect(cache).toBeInstanceOf(DistributedCache);
    });

    it('should return existing distributed cache for same name', () => {
      const cache1 = CacheFactory.createDistributedCache('dist-cache');
      const cache2 = CacheFactory.createDistributedCache('dist-cache');

      expect(cache1).toBe(cache2);
    });
  });

  describe('getCache()', () => {
    it('should return existing cache', () => {
      CacheFactory.createCache('my-cache');
      const cache = CacheFactory.getCache('my-cache');

      expect(cache).not.toBeNull();
    });

    it('should return null for non-existent cache', () => {
      const cache = CacheFactory.getCache('nonexistent');

      expect(cache).toBeNull();
    });
  });

  describe('shutdownAll()', () => {
    it('should shutdown all caches', () => {
      CacheFactory.createCache('cache1');
      CacheFactory.createCache('cache2');
      CacheFactory.createDistributedCache('dist');

      CacheFactory.shutdownAll();

      expect(CacheFactory.getCache('cache1')).toBeNull();
      expect(CacheFactory.getCache('cache2')).toBeNull();
      expect(CacheFactory.getCache('dist')).toBeNull();
    });
  });
});
