import { EventEmitter } from "events";
import { logger } from "./Logger";

export interface CacheConfig {
  defaultTtl?: number; // seconds
  maxSize?: number;
  cleanupInterval?: number; // seconds
  compressionThreshold?: number; // bytes
}

export interface CacheEntry<T> {
  value: T;
  expires: number;
  hits: number;
  lastAccessed: number;
  size: number;
}

export class MemoryCache<T = unknown> extends EventEmitter {
  private readonly cache = new Map<string, CacheEntry<T>>();
  private readonly config: Required<CacheConfig>;
  private cleanupTimer: NodeJS.Timeout | null = null;
  private readonly stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    totalSize: 0,
  };

  constructor(config: CacheConfig = {}) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(20);

    this.config = {
      defaultTtl: config.defaultTtl ?? 300, // 5 minutes
      maxSize: config.maxSize ?? 1000,
      cleanupInterval: config.cleanupInterval ?? 60, // 1 minute
      compressionThreshold: config.compressionThreshold ?? 1024, // 1KB
    };

    this.startCleanup();
  }

  public set(key: string, value: T, ttl?: number): void {
    const size = this.calculateSize(value);
    const expires = Date.now() + (ttl ?? this.config.defaultTtl) * 1000;

    // Check if we need to evict entries
    while (this.cache.size >= this.config.maxSize) {
      this.evictLRU();
    }

    // Remove existing entry if it exists
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.stats.totalSize -= existing.size;
    }

    const entry: CacheEntry<T> = {
      value,
      expires,
      hits: 0,
      lastAccessed: Date.now(),
      size,
    };

    this.cache.set(key, entry);
    this.stats.sets++;
    this.stats.totalSize += size;

    logger.debug("Cache entry set", {
      key: this.sanitizeKey(key),
      size,
      ttl: ttl || this.config.defaultTtl,
      totalEntries: this.cache.size,
      totalSize: this.stats.totalSize,
    });

    this.emit("set", key, value);
  }

  public get(key: string): T | undefined {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      logger.debug("Cache miss", { key: this.sanitizeKey(key) });
      return undefined;
    }

    if (entry.expires < Date.now()) {
      this.delete(key);
      this.stats.misses++;
      logger.debug("Cache miss (expired)", { key: this.sanitizeKey(key) });
      return undefined;
    }

    entry.hits++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;

    logger.debug("Cache hit", {
      key: this.sanitizeKey(key),
      hits: entry.hits,
      age: Date.now() - (entry.expires - this.config.defaultTtl * 1000),
    });

    this.emit("hit", key, entry.value);
    return entry.value;
  }

  public has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expires < Date.now()) {
      this.delete(key);
      return false;
    }

    return true;
  }

  public delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    this.cache.delete(key);
    this.stats.deletes++;
    this.stats.totalSize -= entry.size;

    logger.debug("Cache entry deleted", {
      key: this.sanitizeKey(key),
      size: entry.size,
      totalEntries: this.cache.size,
    });

    this.emit("delete", key);
    return true;
  }

  public clear(): void {
    const size = this.cache.size;
    this.cache.clear();
    this.stats.totalSize = 0;

    logger.info("Cache cleared", { entriesRemoved: size });
    this.emit("clear");
  }

  public getStats() {
    const hitRate = this.stats.hits + this.stats.misses > 0
      ? this.stats.hits / (this.stats.hits + this.stats.misses)
      : 0;

    return {
      ...this.stats,
      hitRate: Math.round(hitRate * 100) / 100, // Round to 2 decimal places
      entries: this.cache.size,
      averageEntrySize: this.cache.size > 0 ? this.stats.totalSize / this.cache.size : 0,
      memoryUsage: this.stats.totalSize,
    };
  }

  public getKeys(): string[] {
    return Array.from(this.cache.keys());
  }

  public getEntries(): { key: string; entry: CacheEntry<T> }[] {
    return Array.from(this.cache.entries()).map(([key, entry]) => ({ key, entry }));
  }

  // LRU eviction
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Date.now();

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      const entry = this.cache.get(oldestKey)!;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
      this.stats.totalSize -= entry.size;

      logger.debug("Cache entry evicted (LRU)", {
        key: this.sanitizeKey(oldestKey),
        age: Date.now() - oldestTime,
        hits: entry.hits,
      });

      this.emit("evict", oldestKey, entry.value);
    }
  }

  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval * 1000);
  }

  private cleanup(): void {
    const now = Date.now();
    const expiredKeys: string[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.expires < now) {
        expiredKeys.push(key);
      }
    }

    let cleanedSize = 0;
    for (const key of expiredKeys) {
      const entry = this.cache.get(key);
      if (entry) {
        cleanedSize += entry.size;
        this.cache.delete(key);
        this.stats.totalSize -= entry.size;
      }
    }

    if (expiredKeys.length > 0) {
      logger.debug("Cache cleanup completed", {
        expiredEntries: expiredKeys.length,
        cleanedSize,
        remainingEntries: this.cache.size,
      });
    }
  }

  private calculateSize(value: T): number {
    try {
      return JSON.stringify(value).length;
    } catch {
      return 1; // Fallback for non-serializable values
    }
  }

  private sanitizeKey(key: string): string {
    // Truncate very long keys for logging
    return key.length > 100 ? `${key.substring(0, 97)}...` : key;
  }

  public async shutdown(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.clear();
    this.removeAllListeners();
    logger.info("Memory cache shutdown completed");
  }

  /**
   * Synchronous destroy alias for shutdown, stops cleanup and clears cache
   */
  public destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clear();
    this.removeAllListeners();
    logger.info("Memory cache destroyed");
  }
}

// Cache decorators and utilities
export class CacheManager {
  private readonly caches = new Map<string, MemoryCache>();

  public getCache<T>(name: string, config?: CacheConfig): MemoryCache<T> {
    if (!this.caches.has(name)) {
      this.caches.set(name, new MemoryCache<T>(config));
      logger.info("Cache created", { name, config });
    }
    return this.caches.get(name)! as MemoryCache<T>;
  }

  public getAllStats(): Record<string, unknown> {
    const stats: Record<string, unknown> = {};
    for (const [name, cache] of this.caches.entries()) {
      stats[name] = cache.getStats();
    }
    return stats;
  }

  public async shutdown(): Promise<void> {
    const shutdownPromises = Array.from(this.caches.values()).map(async cache => cache.shutdown());
    await Promise.all(shutdownPromises);
    this.caches.clear();
    logger.info("Cache manager shutdown completed");
  }
}

// Memoization decorator
export function cached(cacheKey: (args: unknown[]) => string, ttl?: number) {
  return function(_target: unknown, _propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;
    const cache = new MemoryCache();

    descriptor.value = async function(...args: unknown[]) {
      const key = cacheKey(args);
      const cached = cache.get(key);

      if (cached !== undefined) {
        return cached;
      }

      const result = await method.apply(this, args);
      cache.set(key, result, ttl);
      return result;
    };

    return descriptor;
  };
}

// Cache warming utilities
export class CacheWarmer {
  constructor(private readonly cache: MemoryCache) {}

  public async warmUp<T>(
    keys: string[],
    fetcher: (key: string) => Promise<T>,
    options: { batchSize?: number; delay?: number; ttl?: number } = {},
  ): Promise<void> {
    const { batchSize = 10, delay = 100, ttl } = options;

    logger.info("Starting cache warm-up", { keys: keys.length, batchSize });

    for (let i = 0; i < keys.length; i += batchSize) {
      const batch = keys.slice(i, i + batchSize);

      const promises = batch.map(async (key) => {
        try {
          const value = await fetcher(key);
          this.cache.set(key, value, ttl);
        } catch (error) {
          logger.warn("Cache warm-up failed for key", { key, error });
        }
      });

      await Promise.all(promises);

      if (delay > 0 && i + batchSize < keys.length) {
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }

    logger.info("Cache warm-up completed", {
      totalKeys: keys.length,
      cacheSize: this.cache.getStats().entries,
    });
  }
}
