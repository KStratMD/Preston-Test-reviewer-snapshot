
import { env } from '../config/env';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import { inject, injectable } from 'inversify';
import Redis from 'ioredis';

// ioredis attaches commands dynamically via @ioredis/commands at runtime, but
// the Commander base class doesn't statically type them. List the subset we
// actually call here so we don't need a `Record<string, any>` escape hatch.
interface RedisCommands {
  del(...keys: string[]): Promise<number>;
  incrby(key: string, increment: number): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  info(section?: string): Promise<string>;
  dbsize(): Promise<number>;
  flushdb(): Promise<string>;
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<'OK'>;
}

type RedisClient = Redis & RedisCommands;

export interface CacheOptions {
  ttl?: number; // Time to live in seconds
  namespace?: string;
  serialize?: boolean;
  compress?: boolean;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalOperations: number;
  memoryUsage: number;
  keyCount: number;
}

export interface CacheKey {
  key: string;
  namespace: string;
  fullKey: string;
}

/**
 * Multi-level caching service with Redis backend
 * Provides in-memory L1 cache and Redis L2 cache with compression and serialization
 */
@injectable()
export class CacheService {
  private readonly logger: Logger;
  private memoryCache = new Map<string, { value: unknown; expires: number }>();
  private stats = {
    hits: 0,
    misses: 0,
    operations: 0,
  };

  private redis: RedisClient | null = null;

  // L1 cache configuration
  private readonly maxMemoryCacheSize = 1000; // Maximum number of items in memory
  private readonly defaultTTL = 3600; // 1 hour default TTL
  private readonly memoryTTL = 300; // 5 minutes for memory cache

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Initialize cache service
   */
  async initialize(): Promise<void> {
    try {
      // Initialize Redis connection. Cast to RedisClient because ioredis
      // attaches commands dynamically at runtime via @ioredis/commands and
      // the Redis class doesn't statically declare them.
      this.redis = new Redis({
        host: env.REDIS_HOST || 'localhost',
        port: env.REDIS_PORT || 6379,
        password: env.REDIS_PASSWORD,
        // ioredis doesn't support retryDelayOnFailover; use retryStrategy instead
        retryStrategy: () => 100,
        maxRetriesPerRequest: 3,
        lazyConnect: true,
      }) as RedisClient;

      this.redis.on('connect', () => {
        this.logger.info('Cache service connected to Redis');
      });

      this.redis.on('error', (error: Error) => {
        this.logger.error('Redis cache error', { error: error.message });
      });

      // Setup cleanup interval for memory cache
      setInterval(() => {
        this.cleanupMemoryCache();
      }, 60000); // Cleanup every minute

      this.logger.info('Cache service initialized');
    } catch (error) {
      this.logger.error('Failed to initialize cache service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get value from cache (checks L1 then L2)
   */
  async get<T>(key: string, options: CacheOptions = {}): Promise<T | null> {
    const cacheKey = this.buildCacheKey(key, options.namespace);
    this.stats.operations++;

    try {
      // Check L1 memory cache first
      const memoryValue = this.getFromMemory<T>(cacheKey.fullKey);
      if (memoryValue !== null) {
        this.stats.hits++;
        this.logger.debug('Cache hit (L1)', { key: cacheKey.key });
        return memoryValue;
      }

      // Check L2 Redis cache
      if (this.redis) {
        const redisValue = await this.getFromRedis<T>(cacheKey.fullKey, options);
        if (redisValue !== null) {
          // Store in L1 cache for future access
          this.setInMemory(cacheKey.fullKey, redisValue, this.memoryTTL);
          this.stats.hits++;
          this.logger.debug('Cache hit (L2)', { key: cacheKey.key });
          return redisValue;
        }
      }

      this.stats.misses++;
      this.logger.debug('Cache miss', { key: cacheKey.key });
      return null;
    } catch (error) {
      this.logger.error('Cache get error', {
        key: cacheKey.key,
        error: error instanceof Error ? error.message : String(error),
      });
      this.stats.misses++;
      return null;
    }
  }

  /**
   * Set value in cache (stores in both L1 and L2)
   */
  async set<T>(key: string, value: T, options: CacheOptions = {}): Promise<void> {
    const cacheKey = this.buildCacheKey(key, options.namespace);
    const ttl = options.ttl || this.defaultTTL;

    try {
      // Store in L1 memory cache
      const memoryTTL = Math.min(ttl, this.memoryTTL);
      this.setInMemory(cacheKey.fullKey, value, memoryTTL);

      // Store in L2 Redis cache
      if (this.redis) {
        await this.setInRedis(cacheKey.fullKey, value, ttl, options);
      }

      this.logger.debug('Cache set', {
        key: cacheKey.key,
        ttl,
        size: this.getValueSize(value),
      });
    } catch (error) {
      this.logger.error('Cache set error', {
        key: cacheKey.key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete value from cache (both L1 and L2)
   */
  async delete(key: string, options: CacheOptions = {}): Promise<void> {
    const cacheKey = this.buildCacheKey(key, options.namespace);

    try {
      // Delete from L1 memory cache
      this.memoryCache.delete(cacheKey.fullKey);

      // Delete from L2 Redis cache
      if (this.redis) {
        await this.redis.del(cacheKey.fullKey);
      }

      this.logger.debug('Cache delete', { key: cacheKey.key });
    } catch (error) {
      this.logger.error('Cache delete error', {
        key: cacheKey.key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get or set pattern - if not in cache, execute function and cache result
   */
  async getOrSet<T>(key: string, factory: () => Promise<T>, options: CacheOptions = {}): Promise<T> {
    // Try to get from cache first
    const cached = await this.get<T>(key, options);
    if (cached !== null) {
      return cached;
    }

    // Execute factory function and cache result
    const value = await factory();
    await this.set(key, value, options);
    return value;
  }

  /**
   * Increment counter in cache
   */
  async increment(key: string, by = 1, options: CacheOptions = {}): Promise<number> {
    const cacheKey = this.buildCacheKey(key, options.namespace);

    if (this.redis) {
      const result = await this.redis.incrby(cacheKey.fullKey, by);

      // Set TTL if specified
      if (options.ttl) {
        await this.redis.expire(cacheKey.fullKey, options.ttl);
      }

      return result;
    }

    throw new Error('Redis not available for increment operation');
  }

  /**
   * Get multiple keys at once
   */
  async getMultiple<T>(keys: string[], options: CacheOptions = {}): Promise<Map<string, T | null>> {
    const result = new Map<string, T | null>();

    // Process keys in batches to avoid overwhelming Redis
    const batchSize = 50;
    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);
      const batchResults = await Promise.all(batch.map(key => this.get<T>(key, options)));

      batch.forEach((key, index) => {
        const value = batchResults[index];
        if (value !== undefined) {
          result.set(key, value);
        }
      });
    }

    return result;
  }

  /**
   * Set multiple key-value pairs
   */
  async setMultiple<T>(entries: { key: string; value: T }[], options: CacheOptions = {}): Promise<void> {
    // Process in batches
    const batchSize = 50;
    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      await Promise.all(batch.map(entry => this.set(entry.key, entry.value, options)));
    }
  }

  /**
   * Clear cache by pattern
   */
  async clearByPattern(pattern: string, namespace?: string): Promise<number> {
    if (!this.redis) {
      return 0;
    }

    const fullPattern = namespace ? `${namespace}:${pattern}` : pattern;

    try {
      const keys = await this.redis.keys(fullPattern);

      if (keys.length === 0) {
        return 0;
      }

      // Delete from Redis
      await this.redis.del(...keys);

      // Delete matching keys from memory cache
      let memoryDeleted = 0;
      for (const [key] of this.memoryCache) {
        if (this.matchesPattern(key, fullPattern)) {
          this.memoryCache.delete(key);
          memoryDeleted++;
        }
      }

      this.logger.info('Cache cleared by pattern', {
        pattern: fullPattern,
        redisDeleted: keys.length,
        memoryDeleted,
      });

      return keys.length;
    } catch (error) {
      this.logger.error('Cache clear by pattern error', {
        pattern: fullPattern,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    const hitRate = this.stats.operations > 0 ? (this.stats.hits / this.stats.operations) * 100 : 0;

    let memoryUsage = 0;
    let keyCount = 0;

    if (this.redis) {
      try {
        const info = await this.redis.info('memory');
        const usedMemoryMatch = info.match(/used_memory:(\d+)/);
        memoryUsage = usedMemoryMatch ? parseInt(usedMemoryMatch[1], 10) : 0;

        keyCount = await this.redis.dbsize();
      } catch (error) {
        this.logger.debug('Failed to get Redis stats', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return {
      hits: this.stats.hits,
      misses: this.stats.misses,
      hitRate: Math.round(hitRate * 100) / 100,
      totalOperations: this.stats.operations,
      memoryUsage,
      keyCount: keyCount + this.memoryCache.size,
    };
  }

  /**
   * Flush all cache
   */
  async flush(): Promise<void> {
    try {
      // Clear memory cache
      this.memoryCache.clear();

      // Clear Redis cache
      if (this.redis) {
        await this.redis.flushdb();
      }

      // Reset stats
      this.stats = { hits: 0, misses: 0, operations: 0 };

      this.logger.info('Cache flushed');
    } catch (error) {
      this.logger.error('Cache flush error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get from memory cache
   */
  private getFromMemory<T>(key: string): T | null {
    const cached = this.memoryCache.get(key);

    if (!cached) {
      return null;
    }

    if (Date.now() > cached.expires) {
      this.memoryCache.delete(key);
      return null;
    }

    return cached.value as T;
  }

  /**
   * Set in memory cache
   */
  private setInMemory<T>(key: string, value: T, ttlSeconds: number): void {
    // Check memory cache size limit
    if (this.memoryCache.size >= this.maxMemoryCacheSize) {
      // Remove oldest entries (simple LRU)
      const keysToRemove = Array.from(this.memoryCache.keys()).slice(0, 100);
      keysToRemove.forEach(k => this.memoryCache.delete(k));
    }

    const expires = Date.now() + ttlSeconds * 1000;
    this.memoryCache.set(key, { value, expires });
  }

  /**
   * Get from Redis cache
   */
  private async getFromRedis<T>(key: string, options: CacheOptions): Promise<T | null> {
    if (!this.redis) {
      return null;
    }

    const value = await this.redis.get(key);

    if (!value) {
      return null;
    }

    try {
      let result: unknown = value;

      if (options.serialize !== false) {
        result = JSON.parse(value);
      }

      return result as T;
    } catch (error) {
      this.logger.warn('Failed to deserialize cached value', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Set in Redis cache
   */
  private async setInRedis<T>(key: string, value: T, ttlSeconds: number, options: CacheOptions): Promise<void> {
    if (!this.redis) {
      return;
    }

    let serializedValue: string;

    if (options.serialize !== false) {
      serializedValue = JSON.stringify(value);
    } else {
      serializedValue = value as string;
    }


    await this.redis.setex(key, ttlSeconds, serializedValue);
  }

  /**
   * Build cache key with namespace
   */
  private buildCacheKey(key: string, namespace?: string): CacheKey {
    const ns = namespace || 'default';
    const fullKey = `${ns}:${key}`;

    return {
      key,
      namespace: ns,
      fullKey,
    };
  }

  /**
   * Cleanup expired entries from memory cache
   */
  private cleanupMemoryCache(): void {
    const now = Date.now();
    let cleanedCount = 0;

    for (const [key, cached] of this.memoryCache) {
      if (now > cached.expires) {
        this.memoryCache.delete(key);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      this.logger.debug('Memory cache cleanup', {
        cleanedCount,
        remainingCount: this.memoryCache.size,
      });
    }
  }

  /**
   * Check if key matches pattern
   */
  private matchesPattern(key: string, pattern: string): boolean {
    // Simple glob pattern matching
    const regexPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(key);
  }

  /**
   * Get approximate size of value in bytes
   */
  private getValueSize(value: unknown): number {
    try {
      const serialized = JSON.stringify(value);
      return Buffer.byteLength(serialized, 'utf8');
    } catch {
      return 0;
    }
  }

  /**
   * Shutdown cache service
   */
  async shutdown(): Promise<void> {
    try {
      if (this.redis) {
        this.redis.disconnect();
        this.redis = null;
      }

      this.memoryCache.clear();

      this.logger.info('Cache service shutdown completed');
    } catch (error) {
      this.logger.error('Error during cache service shutdown', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

