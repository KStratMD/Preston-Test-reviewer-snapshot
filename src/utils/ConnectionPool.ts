import { EventEmitter } from "events";
import { logger } from "./Logger";

export interface ConnectionPoolOptions {
  min: number;
  max: number;
  acquireTimeoutMs: number;
  createTimeoutMs: number;
  destroyTimeoutMs: number;
  idleTimeoutMs: number;
  reapIntervalMs: number;
  validateConnection?: (resource: unknown) => Promise<boolean>;
  onResourceCreate?: (resource: unknown) => void;
  onResourceDestroy?: (resource: unknown) => void;
  onResourceAcquire?: (resource: unknown) => void;
  onResourceRelease?: (resource: unknown) => void;
}

export interface PooledResource<T> {
  resource: T;
  created: Date;
  lastUsed: Date;
  timesUsed: number;
  inUse: boolean;
  id: string;
}

export interface PoolStats {
  totalResources: number;
  availableResources: number;
  inUseResources: number;
  pendingAcquires: number;
  totalCreated: number;
  totalDestroyed: number;
  totalAcquired: number;
  totalReleased: number;
  totalErrors: number;
  averageCreateTime: number;
  averageAcquireTime: number;
}

export abstract class ConnectionPool<T> extends EventEmitter {
  private readonly pool: PooledResource<T>[] = [];
  private pendingAcquires: {
    resolve: (resource: T) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
    requestTime: number;
  }[] = [];

  private reaperInterval: NodeJS.Timeout | undefined;
  private isShuttingDown = false;
  private resourceCounter = 0;

  // Statistics
  private readonly stats = {
    totalCreated: 0,
    totalDestroyed: 0,
    totalAcquired: 0,
    totalReleased: 0,
    totalErrors: 0,
    createTimes: [] as number[],
    acquireTimes: [] as number[],
  };

  constructor(private readonly options: ConnectionPoolOptions) {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(25);

    // Set up event listeners for statistics
    this.on("resourceCreated", () => this.stats.totalCreated++);
    this.on("resourceDestroyed", () => this.stats.totalDestroyed++);
    this.on("resourceAcquired", () => this.stats.totalAcquired++);
    this.on("resourceReleased", () => this.stats.totalReleased++);
    this.on("error", () => this.stats.totalErrors++);

    this.initialize();
    this.startReaper();
  }

  private async initialize(): Promise<void> {
    try {
      // Create minimum number of connections
      const createPromises = Array(this.options.min)
        .fill(null)
        .map(async () => this.createPooledResource());

      await Promise.all(createPromises);

      logger.info("Connection pool initialized", {
        min: this.options.min,
        max: this.options.max,
        initialSize: this.pool.length,
      });
    } catch (error) {
      logger.error("Failed to initialize connection pool", error);
      throw error;
    }
  }

  private async createPooledResource(): Promise<PooledResource<T>> {
    if (this.isShuttingDown) {
      throw new Error("Pool is shutting down");
    }

    const startTime = Date.now();

    try {
      const resource = await Promise.race([
        this.create(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Create timeout")), this.options.createTimeoutMs),
        ),
      ]);

      const createTime = Date.now() - startTime;
      this.stats.createTimes.push(createTime);

      // Keep only last 100 measurements
      if (this.stats.createTimes.length > 100) {
        this.stats.createTimes.shift();
      }

      const pooled: PooledResource<T> = {
        resource,
        created: new Date(),
        lastUsed: new Date(),
        timesUsed: 0,
        inUse: false,
        id: `resource_${++this.resourceCounter}`,
      };

      this.pool.push(pooled);

      if (this.options.onResourceCreate) {
        this.options.onResourceCreate(resource);
      }

      this.emit("resourceCreated", resource);

      logger.debug("Resource created", {
        resourceId: pooled.id,
        createTime,
        poolSize: this.pool.length,
      });

      return pooled;
    } catch (error) {
      this.emit("error", error);
      logger.error("Failed to create resource", error);
      throw error;
    }
  }

  public async acquire(): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error("Pool is shutting down");
    }

    const requestTime = Date.now();

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const index = this.pendingAcquires.findIndex(p => p.resolve === resolve);
        if (index >= 0) {
          this.pendingAcquires.splice(index, 1);
        }
        reject(new Error(`Acquire timeout after ${this.options.acquireTimeoutMs}ms`));
      }, this.options.acquireTimeoutMs);

      this.pendingAcquires.push({
        resolve: (resource: T) => {
          clearTimeout(timeout);
          const acquireTime = Date.now() - requestTime;
          this.stats.acquireTimes.push(acquireTime);

          if (this.stats.acquireTimes.length > 100) {
            this.stats.acquireTimes.shift();
          }

          resolve(resource);
        },
        reject: (error: Error) => {
          clearTimeout(timeout);
          reject(error);
        },
        timeout,
        requestTime,
      });

      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    while (this.pendingAcquires.length > 0) {
      // Try to find an available resource
      let pooled = this.pool.find(p => !p.inUse);

      if (!pooled && this.pool.length < this.options.max) {
        // Create new resource if under limit
        try {
          pooled = await this.createPooledResource();
        } catch (error) {
          // If creation fails, reject the oldest pending acquire
          const pending = this.pendingAcquires.shift();
          if (pending) {
            clearTimeout(pending.timeout);
            pending.reject(error as Error);
          }
          continue;
        }
      }

      if (!pooled) {
        // No resources available and at max capacity
        break;
      }

      // Validate resource if validator is provided
      if (this.options.validateConnection) {
        try {
          const isValid = await this.options.validateConnection(pooled.resource);
          if (!isValid) {
            await this.destroyPooledResource(pooled);
            continue; // Try again with next iteration
          }
        } catch (error) {
          logger.warn("Resource validation failed", { resourceId: pooled.id, error });
          await this.destroyPooledResource(pooled);
          continue;
        }
      }

      // Assign resource to pending request
      const pending = this.pendingAcquires.shift();
      if (!pending) break;

      pooled.inUse = true;
      pooled.lastUsed = new Date();
      pooled.timesUsed++;

      if (this.options.onResourceAcquire) {
        this.options.onResourceAcquire(pooled.resource);
      }

      this.emit("resourceAcquired", pooled.resource);

      logger.debug("Resource acquired", {
        resourceId: pooled.id,
        timesUsed: pooled.timesUsed,
        pendingRequests: this.pendingAcquires.length,
      });

      pending.resolve(pooled.resource);
    }
  }

  public release(resource: T): void {
    const pooled = this.pool.find(p => p.resource === resource);

    if (!pooled) {
      logger.warn("Attempted to release unknown resource");
      return;
    }

    if (!pooled.inUse) {
      logger.warn("Attempted to release resource that is not in use", {
        resourceId: pooled.id,
      });
      return;
    }

    pooled.inUse = false;
    pooled.lastUsed = new Date();

    if (this.options.onResourceRelease) {
      this.options.onResourceRelease(resource);
    }

    this.emit("resourceReleased", resource);

    logger.debug("Resource released", {
      resourceId: pooled.id,
      availableResources: this.getAvailableCount(),
    });

    // Process any pending requests
    this.processQueue();
  }

  private async destroyPooledResource(pooled: PooledResource<T>): Promise<void> {
    try {
      const index = this.pool.indexOf(pooled);
      if (index >= 0) {
        this.pool.splice(index, 1);
      }

      await Promise.race([
        this.destroy(pooled.resource),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Destroy timeout")), this.options.destroyTimeoutMs),
        ),
      ]);

      if (this.options.onResourceDestroy) {
        this.options.onResourceDestroy(pooled.resource);
      }

      this.emit("resourceDestroyed", pooled.resource);

      logger.debug("Resource destroyed", {
        resourceId: pooled.id,
        poolSize: this.pool.length,
      });
    } catch (error) {
      logger.error("Failed to destroy resource", { resourceId: pooled.id, error });
      this.emit("error", error);
    }
  }

  private startReaper(): void {
    if (this.reaperInterval) {
      return; // Already running
    }

    this.reaperInterval = setInterval(() => {
      this.reapIdleResources();
    }, this.options.reapIntervalMs);
  }

  private async reapIdleResources(): Promise<void> {
    const now = Date.now();
    const toDestroy: PooledResource<T>[] = [];

    // Find idle resources
    for (const pooled of this.pool) {
      if (!pooled.inUse) {
        const idleTime = now - pooled.lastUsed.getTime();

        if (idleTime > this.options.idleTimeoutMs && this.pool.length > this.options.min) {
          toDestroy.push(pooled);
        }
      }
    }

    // Destroy idle resources
    for (const pooled of toDestroy) {
      await this.destroyPooledResource(pooled);
    }

    if (toDestroy.length > 0) {
      logger.debug("Reaped idle resources", {
        destroyed: toDestroy.length,
        remaining: this.pool.length,
      });
    }
  }

  private stopReaper(): void {
    if (this.reaperInterval) {
      clearInterval(this.reaperInterval);
      this.reaperInterval = undefined;
    }
  }

  public getStats(): PoolStats {
    const availableCount = this.getAvailableCount();
    const inUseCount = this.getInUseCount();

    return {
      totalResources: this.pool.length,
      availableResources: availableCount,
      inUseResources: inUseCount,
      pendingAcquires: this.pendingAcquires.length,
      totalCreated: this.stats.totalCreated,
      totalDestroyed: this.stats.totalDestroyed,
      totalAcquired: this.stats.totalAcquired,
      totalReleased: this.stats.totalReleased,
      totalErrors: this.stats.totalErrors,
      averageCreateTime: this.getAverageTime(this.stats.createTimes),
      averageAcquireTime: this.getAverageTime(this.stats.acquireTimes),
    };
  }

  private getAverageTime(times: number[]): number {
    if (times.length === 0) return 0;
    return times.reduce((sum, time) => sum + time, 0) / times.length;
  }

  private getAvailableCount(): number {
    return this.pool.filter(p => !p.inUse).length;
  }

  private getInUseCount(): number {
    return this.pool.filter(p => p.inUse).length;
  }

  // Abstract methods that must be implemented by subclasses
  abstract create(): Promise<T>;
  abstract destroy(resource: T): Promise<void>;

  async drain(): Promise<void> {
    this.isShuttingDown = true;
    this.stopReaper();

    // Reject all pending acquires
    for (const pending of this.pendingAcquires) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("Pool is draining"));
    }
    this.pendingAcquires = [];

    // Destroy all pooled resources
    const resources = this.pool.splice(0);
    await Promise.all(
      resources.map(async pooled => this.destroyPooledResource(pooled)),
    );

    logger.info("Connection pool drained", {
      resourcesDestroyed: resources.length,
    });
  }
}
