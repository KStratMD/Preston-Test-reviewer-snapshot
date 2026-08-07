import { Logger } from "../utils/Logger";
import { EventEmitter } from "events";

const logger = new Logger("DistributedCache");

interface RedisSetOptions {
  EX?: number;
  PX?: number;
  KEEPTTL?: boolean;
}

type RedisEventHandler = (...args: unknown[]) => void;

interface RedisClient {
  connect(): Promise<void>;
  disconnect?(): Promise<void>;
  quit?(): Promise<void>;
  on(event: string, listener: RedisEventHandler): void;
  once?(event: string, listener: RedisEventHandler): void;
  removeAllListeners?(event?: string): void;
  set?(key: string, value: string, options?: RedisSetOptions): Promise<string | null | undefined>;
  get?(key: string): Promise<string | null>;
  del?(key: string | string[]): Promise<number>;
  exists?(key: string): Promise<number>;
  keys?(pattern: string): Promise<string[]>;
  incr?(key: string): Promise<number>;
  incrBy?(key: string, amount: number): Promise<number>;
  expire?(key: string, seconds: number): Promise<number>;
}

// Mock Redis client for when redis is not available
class MockRedisClient extends EventEmitter implements RedisClient {
  private readonly storage = new Map<string, { value: string; expires?: number }>();

  constructor() {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(20);
  }
  private isConnected = true;

  async connect(): Promise<void> {
    this.isConnected = true;
    this.emit("ready");
    logger.info("Mock Redis client connected");
  }

  async disconnect(): Promise<void> {
    this.isConnected = false;
    this.storage.clear();
    this.removeAllListeners();
    this.emit("end");
    logger.info("Mock Redis client disconnected");
  }

  async set(key: string, value: string, options?: RedisSetOptions): Promise<string> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const expires = options?.EX ? Date.now() + (options.EX * 1000) :
      options?.PX ? Date.now() + options.PX :
        options?.KEEPTTL ? this.storage.get(key)?.expires :
          undefined;

    this.storage.set(key, { value, expires });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const item = this.storage.get(key);
    if (!item) return null;

    if (item.expires && Date.now() > item.expires) {
      this.storage.delete(key);
      return null;
    }

    return item.value;
  }

  async del(key: string | string[]): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const keys = Array.isArray(key) ? key : [key];
    let deleted = 0;

    for (const k of keys) {
      if (this.storage.delete(k)) {
        deleted++;
      }
    }

    return deleted;
  }

  async exists(key: string): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");
    return this.storage.has(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const item = this.storage.get(key);
    if (!item) return -2;
    if (!item.expires) return -1;

    const remaining = Math.ceil((item.expires - Date.now()) / 1000);
    return remaining > 0 ? remaining : -2;
  }

  async keys(pattern: string): Promise<string[]> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const regex = new RegExp(pattern.replace(/\*/g, ".*"));
    return Array.from(this.storage.keys()).filter(key => regex.test(key));
  }

  async flushdb(): Promise<string> {
    if (!this.isConnected) throw new Error("Redis client not connected");
    this.storage.clear();
    return "OK";
  }

  async incr(key: string): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const current = await this.get(key);
    const value = current ? parseInt(current, 10) + 1 : 1;
    await this.set(key, value.toString());
    return value;
  }

  async incrBy(key: string, amount: number): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");
    const current = await this.get(key);
    const numeric = current ? parseInt(current, 10) : 0;
    const next = numeric + amount;
    await this.set(key, next.toString());
    return next;
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (!this.isConnected) throw new Error("Redis client not connected");

    const item = this.storage.get(key);
    if (!item) return 0;

    item.expires = Date.now() + (seconds * 1000);
    this.storage.set(key, item);
    return 1;
  }

  // Additional methods for compatibility
  async hset(key: string, field: string, value: string): Promise<number> {
    return await this.set(`${key}:${field}`, value) === "OK" ? 1 : 0;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.get(`${key}:${field}`);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const pattern = `${key}:*`;
    const keys = await this.keys(pattern);
    const result: Record<string, string> = {};

    for (const fullKey of keys) {
      const field = fullKey.substring(key.length + 1);
      const value = await this.get(fullKey);
      if (value !== null) {
        result[field] = value;
      }
    }

    return result;
  }
}

export interface DistributedCacheConfig {
  redisUrl?: string;
  keyPrefix?: string;
  defaultTTL?: number;
  maxRetries?: number;
  retryDelay?: number;
  compressionThreshold?: number;
  enableMetrics?: boolean;
  enableFallback?: boolean;
  fallbackMemorySize?: number;
  cluster?: {
    enabled: boolean;
    nodes?: string[];
    options?: unknown;
  };
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  errors: number;
  totalRequests: number;
  hitRate: number;
  averageResponseTime: number;
  lastError?: string;
  connectedNodes: number;
  memory: {
    used: number;
    peak: number;
    fragmentation: number;
  };
}

export interface CacheEntry<T = unknown> {
  value: T;
  compressed?: boolean;
  metadata?: {
    createdAt: number;
    accessedAt: number;
    hits: number;
  };
}

export class DistributedCache extends EventEmitter {
  private client: RedisClient | null = null;
  private readonly fallbackCache = new Map<string, { value: unknown; expires: number }>();
  private readonly config: Required<DistributedCacheConfig>;
  private readonly metrics: CacheMetrics;
  private isConnected = false;
  private reconnectTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(config: DistributedCacheConfig = {}) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(30);

    this.config = {
      redisUrl: config.redisUrl || "redis://localhost:6379",
      keyPrefix: config.keyPrefix || "app:cache:",
      defaultTTL: config.defaultTTL || 3600, // 1 hour
      maxRetries: config.maxRetries || 3,
      retryDelay: config.retryDelay || 1000,
      compressionThreshold: config.compressionThreshold || 1024, // 1KB
      enableMetrics: config.enableMetrics ?? true,
      enableFallback: config.enableFallback ?? true,
      fallbackMemorySize: config.fallbackMemorySize || 100, // 100 entries
      cluster: config.cluster || { enabled: false },
    };

    this.metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
      totalRequests: 0,
      hitRate: 0,
      averageResponseTime: 0,
      connectedNodes: 0,
      memory: {
        used: 0,
        peak: 0,
        fragmentation: 0,
      },
    };

    this.initializeClient().catch(async error => {
      logger.error("Failed to initialize DistributedCache, falling back to mock client", error);
      await this.useMockClient("Mock Redis client connected as fallback");
    });
    this.startCleanupTimer();
  }

  private async useMockClient(reason: string): Promise<void> {
    logger.warn(reason);
    const mockClient = new MockRedisClient();
    this.removeClientListeners(this.client);
    this.client = mockClient;
    await mockClient.connect();
    this.isConnected = true;
    this.metrics.connectedNodes = 1;
    this.emit("connected");
  }

  private registerClientEventHandlers(client: RedisClient): void {
    const safeOn = client.on.bind(client);

    safeOn("connect", () => {
      if (this.client !== client) return;
      logger.info("Redis client connecting");
    });

    safeOn("ready", () => {
      if (this.client !== client) return;
      this.isConnected = true;
      this.metrics.connectedNodes = this.config.cluster.enabled
        ? this.config.cluster.nodes?.length || 0
        : 1;
      logger.info("Redis client ready", {
        cluster: this.config.cluster.enabled,
        nodes: this.metrics.connectedNodes,
      });
      this.emit("connected");
    });

    safeOn("error", (error: unknown) => {
      if (this.client !== client) return;
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.errors++;
      this.metrics.lastError = errorMessage;
      logger.error("Redis client error", { error: errorMessage });
      this.emit("error", error instanceof Error ? error : new Error(errorMessage));
    });

    safeOn("end", () => {
      if (this.client !== client) return;
      this.isConnected = false;
      this.metrics.connectedNodes = 0;
      logger.warn("Redis client disconnected");
      this.emit("disconnected");
      this.scheduleReconnect();
    });
  }

  private async waitForClientReady(client: RedisClient): Promise<void> {
    const once = client.once?.bind(client);
    if (!once) {
      await client.connect();
      this.isConnected = true;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error("Redis connection timeout"));
      }, 5000);

      const handleReady = () => {
        clearTimeout(timeout);
        resolve();
      };

      const handleError = (error: unknown) => {
        clearTimeout(timeout);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      once("ready", handleReady);
      once("error", handleError);
    });
  }

  private async initializeClient(): Promise<void> {
    try {
      // Allow forcing mock Redis via environment variable for local/dev scenarios
      if (process.env.DISABLE_REDIS === "1" || /^(true|yes)$/i.test(process.env.DISABLE_REDIS || "")) {
        await this.useMockClient("DISABLE_REDIS set - using in-memory mock Redis client");
        return;
      }
      // In test environment, default to mock client unless explicitly configured
      if (process.env.NODE_ENV === "test" && !process.env.USE_REAL_REDIS) {
        await this.useMockClient("Test environment detected, using mock Redis client");
        return;
      }

      // Try to load Redis client (using ioredis instead of redis)
      let RedisCtor: new (options: Record<string, unknown>) => RedisClient;
      try {
        RedisCtor = (await import("ioredis")).default as unknown as new (options: Record<string, unknown>) => RedisClient;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        await this.useMockClient(`ioredis package not available, using mock client: ${errorMessage}`);
        return;
      }

      const urlParts = new URL(this.config.redisUrl);
      const redisClient = new RedisCtor({
        host: urlParts.hostname || "localhost",
        port: Number.parseInt(urlParts.port || "", 10) || 6379,
        password: urlParts.password || undefined,
        maxRetriesPerRequest: this.config.maxRetries,
        lazyConnect: false,
        retryStrategy: (retries: number) => {
          if (retries > this.config.maxRetries) {
            logger.warn("Redis reconnection failed after max retries, falling back to mock client");
            return null;
          }
          return Math.min(retries * this.config.retryDelay, 5000);
        },
        connectTimeout: 5000,
      });

      this.removeClientListeners(this.client);
      await this.safeDisconnectClient(this.client);
      this.client = redisClient;
      this.registerClientEventHandlers(redisClient);

      if (typeof redisClient.connect === "function") {
        await redisClient.connect();
      }

      await this.waitForClientReady(redisClient);
      this.isConnected = true;
      logger.info("Redis client initialized successfully");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error("Failed to initialize Redis client", { error: errorMessage });
      this.metrics.errors++;

      if (this.config.enableFallback) {
        await this.useMockClient("Falling back to mock Redis client");
      } else {
        throw error;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    this.reconnectTimer = setTimeout(async () => {
      try {
        logger.info("Attempting to reconnect to Redis");
        await this.initializeClient();
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Reconnection attempt failed", { error: errorMessage });
        this.scheduleReconnect();
      }
    }, this.config.retryDelay);
  }

  private async safeDisconnectClient(client: RedisClient | null = this.client): Promise<void> {
    if (!client) {
      return;
    }

    try {
      if (typeof client.disconnect === "function") {
        await Promise.resolve(client.disconnect());
      } else if (typeof client.quit === "function") {
        await Promise.resolve(client.quit());
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.debug("Error while disconnecting Redis client during fallback", { error: errorMessage });
    }
  }

  private removeClientListeners(client: RedisClient | null = this.client): void {
    client?.removeAllListeners?.();
  }

  private getKey(key: string): string {
    return `${this.config.keyPrefix}${key}`;
  }

  private async executeWithFallback<T>(
    operation: () => Promise<T>,
    fallbackOperation?: () => Promise<T> | T,
  ): Promise<T> {
    const startTime = Date.now();

    try {
      this.metrics.totalRequests++;
      const result = await operation();

      if (this.config.enableMetrics) {
        const responseTime = Date.now() - startTime;
        this.updateResponseTime(responseTime);
      }

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.metrics.errors++;
      this.metrics.lastError = errorMessage;
      logger.error("Cache operation failed", { error: errorMessage });

      if (this.config.enableFallback && fallbackOperation) {
        logger.debug("Using fallback cache operation");
        return await fallbackOperation();
      }

      throw error;
    }
  }

  private updateResponseTime(responseTime: number): void {
    const totalTime = this.metrics.averageResponseTime * (this.metrics.totalRequests - 1);
    this.metrics.averageResponseTime = (totalTime + responseTime) / this.metrics.totalRequests;
  }

  private compressValue(value: unknown): { data: string; compressed: boolean } {
    const serialized = JSON.stringify(value);

    if (serialized.length > this.config.compressionThreshold) {
      try {
        const zlib = require("zlib");
        const compressed = zlib.gzipSync(serialized).toString("base64");
        return { data: compressed, compressed: true };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.warn("Compression failed, storing uncompressed", { error: errorMessage });
      }
    }

    return { data: serialized, compressed: false };
  }

  private decompressValue(data: string, compressed: boolean): unknown {
    if (compressed) {
      try {
        const zlib = require("zlib");
        const decompressed = zlib.gunzipSync(Buffer.from(data, "base64")).toString();
        return JSON.parse(decompressed);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Decompression failed", { error: errorMessage });
        throw error;
      }
    }

    return JSON.parse(data);
  }

  public async set<T>(
    key: string,
    value: T,
    ttl: number = this.config.defaultTTL,
  ): Promise<boolean> {
    const cacheKey = this.getKey(key);
    const { data, compressed } = this.compressValue(value);

    const cacheEntry: CacheEntry<string> = {
      value: data,
      compressed,
      metadata: {
        createdAt: Date.now(),
        accessedAt: Date.now(),
        hits: 0,
      },
    };

    return this.executeWithFallback(
      async () => {
        const client = this.client;
        if (!client?.set) {
          throw new Error("Redis client does not support SET operation");
        }

        const result = await client.set(
          cacheKey,
          JSON.stringify(cacheEntry),
          { EX: ttl },
        );

        if (result === "OK") {
          this.metrics.sets++;
          return true;
        }
        return false;
      },
      () => {
        // Fallback to memory cache
        this.manageFallbackSize();
        this.fallbackCache.set(cacheKey, {
          value: cacheEntry,
          expires: Date.now() + (ttl * 1000),
        });
        this.metrics.sets++;
        return true;
      },
    );
  }

  public async get<T>(key: string): Promise<T | null> {
    const cacheKey = this.getKey(key);

    return this.executeWithFallback<T | null>(
      async () => {
        const client = this.client;
        if (!client?.get) {
          throw new Error("Redis client does not support GET operation");
        }

        const result = await client.get(cacheKey);

        if (result === null) {
          this.metrics.misses++;
          return null;
        }

        try {
          const cacheEntry: CacheEntry<string> = JSON.parse(result);

          // Update access metadata
          cacheEntry.metadata = cacheEntry.metadata || {
            createdAt: Date.now(),
            accessedAt: Date.now(),
            hits: 0,
          };
          cacheEntry.metadata.accessedAt = Date.now();
          cacheEntry.metadata.hits++;

          // Update the entry in Redis (fire and forget) - only if supported
          if (client.set) {
            client.set(cacheKey, JSON.stringify(cacheEntry), { KEEPTTL: true })
              .catch((error: Error) => logger.debug("Failed to update metadata", { error: error.message }));
          }

          const value = this.decompressValue(cacheEntry.value, cacheEntry.compressed || false);
          this.metrics.hits++;
          this.updateHitRate();
          return value as T;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Failed to deserialize cache entry", { error: errorMessage, key });
          this.metrics.misses++;
          return null;
        }
      },
      () => {
        // Fallback to memory cache
        const fallbackEntry = this.fallbackCache.get(cacheKey);

        if (!fallbackEntry || Date.now() > fallbackEntry.expires) {
          if (fallbackEntry) {
            this.fallbackCache.delete(cacheKey);
          }
          this.metrics.misses++;
          return null;
        }

        try {
          const cacheEntry = fallbackEntry.value as CacheEntry<string>;
          const value = this.decompressValue(cacheEntry.value, cacheEntry.compressed || false);
          this.metrics.hits++;
          this.updateHitRate();
          return value as T;
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          logger.error("Failed to deserialize fallback cache entry", { error: errorMessage, key });
          this.fallbackCache.delete(cacheKey);
          this.metrics.misses++;
          return null;
        }
      },
    );
  }

  public async delete(key: string | string[]): Promise<number> {
    const keys = Array.isArray(key) ? key : [key];
    const cacheKeys = keys.map(k => this.getKey(k));

    return this.executeWithFallback(
      async () => {
        const client = this.client;
        if (!client?.del) {
          throw new Error("Redis client does not support DEL operation");
        }
        const result = await client.del(cacheKeys);
        this.metrics.deletes += result;
        return result;
      },
      () => {
        let deleted = 0;
        for (const cacheKey of cacheKeys) {
          if (this.fallbackCache.delete(cacheKey)) {
            deleted++;
          }
        }
        this.metrics.deletes += deleted;
        return deleted;
      },
    );
  }

  public async exists(key: string): Promise<boolean> {
    const cacheKey = this.getKey(key);

    return this.executeWithFallback(
      async () => {
        const client = this.client;
        if (!client?.exists) {
          throw new Error("Redis client does not support EXISTS operation");
        }
        const result = await client.exists(cacheKey);
        return result === 1;
      },
      () => {
        const fallbackEntry = this.fallbackCache.get(cacheKey);
        if (!fallbackEntry) return false;

        if (Date.now() > fallbackEntry.expires) {
          this.fallbackCache.delete(cacheKey);
          return false;
        }

        return true;
      },
    );
  }

  public async clear(pattern?: string): Promise<number> {
    const searchPattern = pattern ? this.getKey(pattern) : `${this.config.keyPrefix}*`;

    return this.executeWithFallback(
      async () => {
        const client = this.client;
        if (!client?.keys || !client.del) {
          throw new Error("Redis client does not support key scanning");
        }
        const keys = await client.keys(searchPattern);
        if (keys.length === 0) return 0;

        const result = await client.del(keys);
        this.metrics.deletes += result;
        return result;
      },
      () => {
        const regex = new RegExp(searchPattern.replace(/\*/g, ".*"));
        let deleted = 0;

        for (const [key] of this.fallbackCache.entries()) {
          if (regex.test(key)) {
            this.fallbackCache.delete(key);
            deleted++;
          }
        }

        this.metrics.deletes += deleted;
        return deleted;
      },
    );
  }

  public async increment(key: string, amount = 1): Promise<number> {
    const cacheKey = this.getKey(key);

    return this.executeWithFallback(
      async () => {
        const client = this.client;
        if (amount === 1 && client?.incr) {
          return await client.incr(cacheKey);
        } else if (client?.incrBy) {
          return await client.incrBy(cacheKey, amount);
        } else {
          // Fallback for clients that don't support incr/incrBy
          const current = await this.get<number>(key) || 0;
          const newValue = current + amount;
          await this.set(key, newValue);
          return newValue;
        }
      },
      async () => {
        const current = await this.get<number>(key) || 0;
        const newValue = current + amount;
        await this.set(key, newValue);
        return newValue;
      },
    );
  }

  public async getOrSet<T>(
    key: string,
    factory: () => Promise<T> | T,
    ttl: number = this.config.defaultTTL,
  ): Promise<T> {
    const cached = await this.get<T>(key);

    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, ttl);
    return value;
  }

  private updateHitRate(): void {
    const total = this.metrics.hits + this.metrics.misses;
    this.metrics.hitRate = total > 0 ? (this.metrics.hits / total) * 100 : 0;
  }

  private manageFallbackSize(): void {
    if (this.fallbackCache.size >= this.config.fallbackMemorySize) {
      // Remove oldest entries (simple LRU)
      const entries = Array.from(this.fallbackCache.entries());
      const toRemove = Math.ceil(this.config.fallbackMemorySize * 0.1); // Remove 10%

      for (let i = 0; i < toRemove && i < entries.length; i++) {
        const entry = entries[i];
        if (entry) {
          this.fallbackCache.delete(entry[0]);
        }
      }
    }
  }

  private startCleanupTimer(): void {
    // In test environments we skip the interval to avoid Jest open handle warnings
    if (process.env.DASHBOARD_DISABLE_INTERVALS === "1" || process.env.NODE_ENV === "test") return;
    this.cleanupTimer = setInterval(() => {
      this.cleanupFallbackCache();
    }, 60000); // Clean up every minute
  }

  // Cleanup method to prevent memory leaks
  public cleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.fallbackCache.clear();
    this.removeAllListeners();
  }

  // Graceful shutdown method
  public async shutdown(): Promise<void> {
    logger.info("DistributedCache shutdown initiated");

    // Stop timers first
    this.cleanup();

    // Disconnect client gracefully
    if (this.client) {
      try {
        await this.safeDisconnectClient(this.client);
      } catch (error) {
        logger.warn("Error disconnecting Redis client", { error });
      }
    }

    this.isConnected = false;
    logger.info("DistributedCache shutdown completed");
  }

  private cleanupFallbackCache(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, entry] of this.fallbackCache.entries()) {
      if (now > entry.expires) {
        this.fallbackCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug("Cleaned up expired fallback cache entries", { cleaned });
    }
  }

  public getMetrics(): CacheMetrics {
    this.updateHitRate();
    return { ...this.metrics };
  }

  public async getHealth(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    redis: boolean;
    fallback: boolean;
    metrics: CacheMetrics;
  }> {
    let status: "healthy" | "degraded" | "unhealthy" = "healthy";

    if (!this.isConnected && !this.config.enableFallback) {
      status = "unhealthy";
    } else if (!this.isConnected) {
      status = "degraded";
    }

    return {
      status,
      redis: this.isConnected,
      fallback: this.config.enableFallback,
      metrics: this.getMetrics(),
    };
  }

  public async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.client && this.isConnected) {
      try {
        await this.safeDisconnectClient(this.client);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error("Error disconnecting from Redis", { error: errorMessage });
      }
    }

    this.isConnected = false;
    this.emit("disconnected");
  }
}

// Singleton instance
let cacheInstance: DistributedCache | null = null;

export function getDistributedCache(config?: DistributedCacheConfig): DistributedCache {
  if (!cacheInstance) {
    // If no config provided, use environment variables
    const defaultConfig: DistributedCacheConfig = {
      redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
      keyPrefix: process.env.REDIS_KEY_PREFIX || "integration-hub",
      maxRetries: parseInt(process.env.REDIS_MAX_RETRIES || "3"),
      retryDelay: parseInt(process.env.REDIS_RETRY_DELAY || "1000"),
    };
    cacheInstance = new DistributedCache(config || defaultConfig);
  }
  return cacheInstance;
}

// Decorator for caching method results
export function cachedDistributed(ttl = 3600, keyGenerator?: (...args: unknown[]) => string) {
  return function (_target: unknown, propertyName: string, descriptor: PropertyDescriptor) {
    const method = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const cache = getDistributedCache();
      const className = this.constructor.name;
      const key = keyGenerator ?
        keyGenerator(...args) :
        `${className}:${propertyName}:${JSON.stringify(args)}`;

      return cache.getOrSet(key, () => method.apply(this, args), ttl);
    };

    return descriptor;
  };
}
