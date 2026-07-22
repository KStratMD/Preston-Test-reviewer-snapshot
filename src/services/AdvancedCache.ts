import { EventEmitter } from 'events';
import { logger } from '../utils/Logger';
import { performanceMonitor } from './PerformanceMonitor';

export interface CacheEntry<T = any> {
  value: T;
  timestamp: number;
  ttl: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
  tags: string[];
}

export interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  totalSize: number;
  entryCount: number;
  hitRate: number;
  averageAccessTime: number;
}

export interface CacheConfig {
  maxSize: number; // Maximum cache size in bytes
  maxEntries: number; // Maximum number of entries
  defaultTTL: number; // Default TTL in milliseconds
  cleanupInterval: number; // Cleanup interval in milliseconds
  enableCompression: boolean;
  enableMetrics: boolean;
}

export class AdvancedCache extends EventEmitter {
  private cache = new Map<string, CacheEntry>();
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
    totalSize: 0,
    entryCount: 0,
    hitRate: 0,
    averageAccessTime: 0
  };
  private accessTimes: number[] = [];
  private cleanupInterval?: NodeJS.Timeout;
  private config: CacheConfig;

  constructor(config: Partial<CacheConfig> = {}) {
    super();
    
    this.config = {
      maxSize: 100 * 1024 * 1024, // 100MB
      maxEntries: 10000,
      defaultTTL: 60 * 60 * 1000, // 1 hour
      cleanupInterval: 5 * 60 * 1000, // 5 minutes
      enableCompression: true,
      enableMetrics: true,
      ...config
    };

    this.startCleanup();
  }



  private startCleanup(): void {
    if (process.env.NODE_ENV === 'test') {
      // Disable cleanup tasks during tests to prevent timeouts
      return;
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.config.cleanupInterval);
  }

  public shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = undefined;
    }
  }

  private cleanup(): void {
    const now = Date.now();
    let evicted = 0;
    let freedSize = 0;

    // Remove expired entries
    for (const [key, entry] of this.cache.entries()) {
      if (now > entry.timestamp + entry.ttl) {
        freedSize += entry.size;
        this.cache.delete(key);
        evicted++;
      }
    }

    // If still over limits, use LRU eviction
    if (this.cache.size > this.config.maxEntries || this.stats.totalSize > this.config.maxSize) {
      const entries = Array.from(this.cache.entries())
        .sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);

      while ((this.cache.size > this.config.maxEntries || this.stats.totalSize > this.config.maxSize) && entries.length > 0) {
        const [key, entry] = entries.shift()!;
        freedSize += entry.size;
        this.cache.delete(key);
        evicted++;
      }
    }

    this.stats.evictions += evicted;
    this.stats.totalSize -= freedSize;
    this.stats.entryCount = this.cache.size;

    if (evicted > 0) {
      logger.debug('Cache cleanup completed', { evicted, freedSize });
      this.emit('cleanup', { evicted, freedSize });
    }
  }

  private calculateSize(value: unknown): number {
    try {
      return JSON.stringify(value).length * 2; // Rough estimate (UTF-16)
    } catch {
      return 1000; // Default size for non-serializable objects
    }
  }

  private compressValue(value: unknown): unknown {
    if (!this.config.enableCompression) return value;
    
    // Simple compression for strings
    if (typeof value === 'string' && value.length > 1000) {
      try {
        const zlib = require('zlib');
        return {
          __compressed: true,
          data: zlib.deflateSync(value).toString('base64')
        };
      } catch {
        return value;
      }
    }
    
    return value;
  }

  private decompressValue(value: unknown): unknown {
    if (!value || typeof value !== 'object' || !(value as any).__compressed) {
      return value;
    }

    try {
      const zlib = require('zlib');
      return zlib.inflateSync(Buffer.from((value as any).data, 'base64')).toString();
    } catch {
      return value;
    }
  }

  public set<T>(key: string, value: T, ttl?: number, tags: string[] = []): void {
    const start = performance.now();
    
    const compressedValue = this.compressValue(value);
    const size = this.calculateSize(compressedValue);
    const now = Date.now();

    const entry: CacheEntry<T> = {
      value: compressedValue as T,
      timestamp: now,
      ttl: ttl || this.config.defaultTTL,
      accessCount: 0,
      lastAccessed: now,
      size,
      tags
    };

    // Remove existing entry if it exists
    if (this.cache.has(key)) {
      const existing = this.cache.get(key)!;
      this.stats.totalSize -= existing.size;
    }

    this.cache.set(key, entry);
    this.stats.sets++;
    this.stats.totalSize += size;
    this.stats.entryCount = this.cache.size;

    if (this.config.enableMetrics) {
      const duration = performance.now() - start;
      this.recordAccessTime(duration);
    }

    this.emit('set', { key, size, ttl: entry.ttl });

    // Trigger cleanup if over limits
    if (this.cache.size > this.config.maxEntries || this.stats.totalSize > this.config.maxSize) {
      setImmediate(() => this.cleanup());
    }
  }

  public get<T>(key: string): T | null {
    const start = performance.now();
    
    const entry = this.cache.get(key);
    
    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Check if expired
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      this.stats.totalSize -= entry.size;
      this.stats.entryCount = this.cache.size;
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Update access statistics
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.stats.hits++;
    this.updateHitRate();

    if (this.config.enableMetrics) {
      const duration = performance.now() - start;
      this.recordAccessTime(duration);
    }

    const decompressedValue = this.decompressValue(entry.value);
    this.emit('hit', { key, accessCount: entry.accessCount });

    return decompressedValue as T;
  }

  public delete(key: string): boolean {
    const entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.stats.deletes++;
      this.stats.totalSize -= entry.size;
      this.stats.entryCount = this.cache.size;
      this.emit('delete', { key, size: entry.size });
      return true;
    }
    return false;
  }

  public clear(): void {
    const entryCount = this.cache.size;
    const totalSize = this.stats.totalSize;

    this.cache.clear();
    this.stats.totalSize = 0;
    this.stats.entryCount = 0;
    this.stats.hits = 0;
    this.stats.misses = 0;
    this.stats.sets = 0;
    this.stats.deletes = 0;
    this.stats.evictions = 0;
    this.stats.hitRate = 0;

    this.emit('clear', { entryCount, totalSize });
    logger.info('Cache cleared', { entryCount, totalSize });
  }

  public has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    
    // Check if expired
    if (Date.now() > entry.timestamp + entry.ttl) {
      this.cache.delete(key);
      this.stats.totalSize -= entry.size;
      this.stats.entryCount = this.cache.size;
      return false;
    }
    
    return true;
  }

  public invalidateByTag(tag: string): number {
    let invalidated = 0;
    
    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.includes(tag)) {
        this.cache.delete(key);
        this.stats.totalSize -= entry.size;
        invalidated++;
      }
    }

    this.stats.entryCount = this.cache.size;
    this.emit('tagInvalidation', { tag, invalidated });

    return invalidated;
  }

  public getByTag(tag: string): { key: string; value: unknown }[] {
    const results: { key: string; value: unknown }[] = [];

    for (const [key, entry] of this.cache.entries()) {
      if (entry.tags.includes(tag) && Date.now() <= entry.timestamp + entry.ttl) {
        results.push({
          key,
          value: this.decompressValue(entry.value)
        });
      }
    }

    return results;
  }

  private recordAccessTime(duration: number): void {
    this.accessTimes.push(duration);
    
    // Keep only last 1000 access times
    if (this.accessTimes.length > 1000) {
      this.accessTimes = this.accessTimes.slice(-1000);
    }
    
    // Update average
    this.stats.averageAccessTime = this.accessTimes.reduce((a, b) => a + b, 0) / this.accessTimes.length;
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  public getStats(): CacheStats {
    return { ...this.stats };
  }

  public getHealth(): unknown {
    const stats = this.getStats();
    const latest = this.getLatestMetrics();
    
    return {
      status: stats.hitRate > 70 && stats.totalSize < this.config.maxSize * 0.9 ? 'healthy' : 'degraded',
      hitRate: stats.hitRate,
      memoryUsage: (stats.totalSize / this.config.maxSize) * 100,
      entryCount: stats.entryCount,
      averageAccessTime: stats.averageAccessTime,
      recentAlerts: this.getRecentAlerts(10).length
    };
  }

  // Advanced cache warming
  public async warmCache(warmupData: { key: string; value: unknown; ttl?: number; tags?: string[] }[]): Promise<void> {
    logger.info('Starting cache warmup', { entries: warmupData.length });
    
    for (const item of warmupData) {
      this.set(item.key, item.value, item.ttl, item.tags || []);
    }
    
    logger.info('Cache warmup completed', { 
      entries: warmupData.length,
      totalSize: this.stats.totalSize 
    });
  }

  // Cache preloading for predictive caching
  public async preloadIntegrationData(integrations: string[]): Promise<void> {
    logger.info('Preloading integration cache data', { integrations });
    
    // This would typically fetch commonly accessed data
    const preloadPromises = integrations.map(async (integration) => {
      try {
        // Simulate preloading common queries
        const commonQueries = [
          `${integration}:config`,
          `${integration}:schema`,
          `${integration}:status`
        ];
        
        for (const query of commonQueries) {
          // In a real implementation, you'd fetch actual data here
          this.set(query, { preloaded: true, integration }, undefined, [integration, 'preload']);
        }
      } catch (error) {
        logger.warn('Failed to preload integration data', { integration, error: (error as Error).message });
      }
    });
    
    await Promise.all(preloadPromises);
    logger.info('Integration cache preloading completed');
  }

  private getLatestMetrics(): unknown {
    return performanceMonitor.getLatestMetrics();
  }

  private getRecentAlerts(minutes: number): unknown[] {
    return performanceMonitor.getRecentAlerts(minutes);
  }
}

// Enhanced distributed cache with clustering support
export class DistributedCache extends AdvancedCache {
  private nodeId: string;
  private peers = new Set<string>();
  private syncInterval?: NodeJS.Timeout;

  constructor(config: Partial<CacheConfig> = {}) {
    super(config);
    this.nodeId = `node-${Math.random().toString(36).slice(2, 2 + 9)}`;
    this.setupDistributedSync();
  }

  private setupDistributedSync(): void {
    if (process.env.NODE_ENV === 'test') {
      // Disable distributed sync during tests to prevent timeouts
      return;
    }

    this.syncInterval = setInterval(() => {
      this.syncWithPeers();
    }, 30000); // Sync every 30 seconds
  }

  private async syncWithPeers(): Promise<void> {
    // Placeholder for distributed cache synchronization
    logger.debug('Syncing cache with peers', { 
      nodeId: this.nodeId, 
      peers: Array.from(this.peers) 
    });
  }

  public addPeer(peerId: string): void {
    this.peers.add(peerId);
    logger.info('Added cache peer', { peerId, totalPeers: this.peers.size });
  }

  public removePeer(peerId: string): void {
    this.peers.delete(peerId);
    logger.info('Removed cache peer', { peerId, totalPeers: this.peers.size });
  }

  public override shutdown(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }
    super.shutdown();
    logger.info('Distributed cache shutdown completed');
  }
}

// Cache factory for different cache types
export class CacheFactory {
  private static instances = new Map<string, AdvancedCache>();

  public static createCache(name: string, config: Partial<CacheConfig> = {}): AdvancedCache {
    if (this.instances.has(name)) {
      return this.instances.get(name)!;
    }

    const cache = new AdvancedCache(config);
    this.instances.set(name, cache);
    
    logger.info('Created cache instance', { name, config });
    return cache;
  }

  public static createDistributedCache(name: string, config: Partial<CacheConfig> = {}): DistributedCache {
    if (this.instances.has(name)) {
      const existing = this.instances.get(name)!;
      if (existing instanceof DistributedCache) {
        return existing;
      }
    }

    const cache = new DistributedCache(config);
    this.instances.set(name, cache);
    
    logger.info('Created distributed cache instance', { name, config });
    return cache;
  }

  public static getCache(name: string): AdvancedCache | null {
    return this.instances.get(name) || null;
  }

  public static shutdownAll(): void {
    for (const [name, cache] of this.instances.entries()) {
      cache.shutdown();
      logger.info('Shutdown cache instance', { name });
    }
    this.instances.clear();
  }
}

// Global cache instances
export const integrationCache = CacheFactory.createCache('integrations', {
  maxSize: 50 * 1024 * 1024, // 50MB
  defaultTTL: 30 * 60 * 1000, // 30 minutes
  enableCompression: true
});

export const responseCache = CacheFactory.createCache('responses', {
  maxSize: 25 * 1024 * 1024, // 25MB
  defaultTTL: 5 * 60 * 1000, // 5 minutes
  enableCompression: false // Responses are usually small
});

export const configCache = CacheFactory.createCache('config', {
  maxSize: 10 * 1024 * 1024, // 10MB
  defaultTTL: 60 * 60 * 1000, // 1 hour
  enableCompression: false
});

// Distributed cache for multi-node deployments
export const distributedCache = CacheFactory.createDistributedCache('distributed', {
  maxSize: 100 * 1024 * 1024, // 100MB
  defaultTTL: 60 * 60 * 1000, // 1 hour
  enableCompression: true
});

// Legacy compatibility
export function getDistributedCache(): DistributedCache {
  return distributedCache;
}