import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';

export interface PoolConfig {
  name: string;
  maxConnections: number;
  minConnections: number;
  maxIdleTime: number; // milliseconds
  connectionTimeout: number; // milliseconds
  retryAttempts: number;
  retryDelay: number; // milliseconds
  healthCheckInterval: number; // milliseconds
}

export interface ConnectionMetrics {
  name: string;
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  waitingRequests: number;
  totalRequests: number;
  successfulConnections: number;
  failedConnections: number;
  averageConnectionTime: number;
  healthStatus: 'healthy' | 'degraded' | 'unhealthy';
}

export interface PoolConnection<T = any> {
  id: string;
  connection: T;
  createdAt: Date;
  lastUsed: Date;
  isActive: boolean;
  inUse: boolean;
}

/**
 * Generic connection pool manager for optimizing connections to databases and APIs
 */
@injectable()
export class ConnectionPoolManager {
  private readonly logger: Logger;
  private readonly pools = new Map<string, ConnectionPool<unknown>>();

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Create a connection pool
   */
  async createPool<T>(
    config: PoolConfig,
    connectionFactory: () => Promise<T>,
    connectionValidator?: (connection: T) => Promise<boolean>,
    connectionDestroyer?: (connection: T) => Promise<void>,
  ): Promise<string> {
    try {
      const pool = new ConnectionPool<T>(
        config,
        connectionFactory,
        this.logger,
        connectionValidator,
        connectionDestroyer,
      );

      await pool.initialize();
      this.pools.set(config.name, pool);

      this.logger.info('Connection pool created', {
        name: config.name,
        maxConnections: config.maxConnections,
        minConnections: config.minConnections,
      });

      return config.name;
    } catch (error) {
      this.logger.error('Failed to create connection pool', {
        name: config.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get a connection from pool
   */
  async getConnection<T>(poolName: string): Promise<PoolConnection<T>> {
    const pool = this.pools.get(poolName) as ConnectionPool<T>;

    if (!pool) {
      throw new Error(`Connection pool not found: ${poolName}`);
    }

    return pool.acquire();
  }

  /**
   * Release a connection back to pool
   */
  async releaseConnection(poolName: string, connectionId: string): Promise<void> {
    const pool = this.pools.get(poolName);

    if (!pool) {
      throw new Error(`Connection pool not found: ${poolName}`);
    }

    await pool.release(connectionId);
  }

  /**
   * Execute a function with a pooled connection
   */
  async withConnection<T, R>(
    poolName: string,
    operation: (connection: T) => Promise<R>,
  ): Promise<R> {
    const poolConnection = await this.getConnection<T>(poolName);

    try {
      const result = await operation(poolConnection.connection);
      await this.releaseConnection(poolName, poolConnection.id);
      return result;
    } catch (error) {
      await this.releaseConnection(poolName, poolConnection.id);
      throw error;
    }
  }

  /**
   * Get pool metrics
   */
  getPoolMetrics(poolName: string): ConnectionMetrics | null {
    const pool = this.pools.get(poolName);
    return pool ? pool.getMetrics() : null;
  }

  /**
   * Get all pool metrics
   */
  getAllPoolMetrics(): ConnectionMetrics[] {
    return Array.from(this.pools.values()).map(pool => pool.getMetrics());
  }

  /**
   * Destroy a pool
   */
  async destroyPool(poolName: string): Promise<void> {
    const pool = this.pools.get(poolName);

    if (pool) {
      await pool.destroy();
      this.pools.delete(poolName);

      this.logger.info('Connection pool destroyed', { name: poolName });
    }
  }

  /**
   * Destroy all pools
   */
  async destroyAllPools(): Promise<void> {
    const destroyPromises = Array.from(this.pools.keys()).map(name =>
      this.destroyPool(name),
    );

    await Promise.all(destroyPromises);

    this.logger.info('All connection pools destroyed');
  }
}

/**
 * Individual connection pool implementation
 */
class ConnectionPool<T> {
  private readonly config: PoolConfig;
  private readonly connectionFactory: () => Promise<T>;
  private readonly connectionValidator?: (connection: T) => Promise<boolean>;
  private readonly connectionDestroyer?: (connection: T) => Promise<void>;
  private readonly logger: Logger;

  private connections = new Map<string, PoolConnection<T>>();
  private waitingQueue: {
    resolve: (connection: PoolConnection<T>) => void;
    reject: (error: Error) => void;
    timestamp: number;
  }[] = [];

  private metrics = {
    totalRequests: 0,
    successfulConnections: 0,
    failedConnections: 0,
    connectionTimes: [] as number[],
  };

  private healthCheckTimer?: NodeJS.Timeout;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(
    config: PoolConfig,
    connectionFactory: () => Promise<T>,
    logger: Logger,
    connectionValidator?: (connection: T) => Promise<boolean>,
    connectionDestroyer?: (connection: T) => Promise<void>,
  ) {
    this.config = config;
    this.connectionFactory = connectionFactory;
    this.connectionValidator = connectionValidator;
    this.connectionDestroyer = connectionDestroyer;
    this.logger = logger;
  }

  /**
   * Initialize the pool
   */
  async initialize(): Promise<void> {
    // Create minimum connections
    const createPromises = Array.from({ length: this.config.minConnections }, () =>
      this.createConnection(),
    );

    await Promise.all(createPromises);

    // Start health check timer
    this.healthCheckTimer = setInterval(
      () => this.performHealthCheck(),
      this.config.healthCheckInterval,
    );

    // Start cleanup timer
    this.cleanupTimer = setInterval(
      () => this.cleanupIdleConnections(),
      this.config.maxIdleTime / 2,
    );

    this.logger.debug('Connection pool initialized', {
      name: this.config.name,
      initialConnections: this.connections.size,
    });
  }

  /**
   * Acquire a connection from the pool
   */
  async acquire(): Promise<PoolConnection<T>> {
    this.metrics.totalRequests++;

    return new Promise((resolve, reject) => {
      const startTime = Date.now();

      // Try to find an available connection
      const availableConnection = this.findAvailableConnection();

      if (availableConnection) {
        availableConnection.inUse = true;
        availableConnection.lastUsed = new Date();

        this.metrics.successfulConnections++;
        this.metrics.connectionTimes.push(Date.now() - startTime);

        resolve(availableConnection);
        return;
      }

      // If we can create more connections, do so
      if (this.connections.size < this.config.maxConnections) {
        this.createConnection()
          .then(connection => {
            connection.inUse = true;
            connection.lastUsed = new Date();

            this.metrics.successfulConnections++;
            this.metrics.connectionTimes.push(Date.now() - startTime);

            resolve(connection);
          })
          .catch(error => {
            this.metrics.failedConnections++;
            reject(error);
          });
        return;
      }

      // Add to waiting queue
      const timeout = setTimeout(() => {
        const index = this.waitingQueue.findIndex(item => item.resolve === resolve);
        if (index !== -1) {
          this.waitingQueue.splice(index, 1);
          this.metrics.failedConnections++;
          reject(new Error(`Connection timeout after ${this.config.connectionTimeout}ms`));
        }
      }, this.config.connectionTimeout);

      this.waitingQueue.push({
        resolve: (connection) => {
          clearTimeout(timeout);
          this.metrics.successfulConnections++;
          this.metrics.connectionTimes.push(Date.now() - startTime);
          resolve(connection);
        },
        reject: (error) => {
          clearTimeout(timeout);
          this.metrics.failedConnections++;
          reject(error);
        },
        timestamp: startTime,
      });
    });
  }

  /**
   * Release a connection back to the pool
   */
  async release(connectionId: string): Promise<void> {
    const connection = this.connections.get(connectionId);

    if (!connection) {
      this.logger.warn('Attempted to release unknown connection', {
        poolName: this.config.name,
        connectionId,
      });
      return;
    }

    connection.inUse = false;
    connection.lastUsed = new Date();

    // Check if anyone is waiting for a connection
    const waiting = this.waitingQueue.shift();
    if (waiting) {
      connection.inUse = true;
      connection.lastUsed = new Date();
      waiting.resolve(connection);
      return;
    }

    this.logger.debug('Connection released', {
      poolName: this.config.name,
      connectionId,
    });
  }

  /**
   * Get pool metrics
   */
  getMetrics(): ConnectionMetrics {
    const activeConnections = Array.from(this.connections.values())
      .filter(conn => conn.inUse).length;

    const idleConnections = this.connections.size - activeConnections;

    const averageConnectionTime = this.metrics.connectionTimes.length > 0
      ? this.metrics.connectionTimes.reduce((sum, time) => sum + time, 0) / this.metrics.connectionTimes.length
      : 0;

    // Determine health status
    let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    const successRate = this.metrics.totalRequests > 0
      ? this.metrics.successfulConnections / this.metrics.totalRequests
      : 1;

    if (successRate < 0.5) {
      healthStatus = 'unhealthy';
    } else if (successRate < 0.8 || this.waitingQueue.length > 10) {
      healthStatus = 'degraded';
    }

    return {
      name: this.config.name,
      totalConnections: this.connections.size,
      activeConnections,
      idleConnections,
      waitingRequests: this.waitingQueue.length,
      totalRequests: this.metrics.totalRequests,
      successfulConnections: this.metrics.successfulConnections,
      failedConnections: this.metrics.failedConnections,
      averageConnectionTime,
      healthStatus,
    };
  }

  /**
   * Destroy the pool
   */
  async destroy(): Promise<void> {
    // Clear timers
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
    }

    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    // Reject all waiting requests
    for (const waiting of this.waitingQueue) {
      waiting.reject(new Error('Connection pool is being destroyed'));
    }
    this.waitingQueue = [];

    // Close all connections
    const destroyPromises = Array.from(this.connections.values()).map(poolConnection =>
      this.destroyConnection(poolConnection),
    );

    await Promise.all(destroyPromises);
    this.connections.clear();

    this.logger.info('Connection pool destroyed', { name: this.config.name });
  }

  /**
   * Find an available connection
   */
  private findAvailableConnection(): PoolConnection<T> | null {
    for (const connection of this.connections.values()) {
      if (!connection.inUse && connection.isActive) {
        return connection;
      }
    }
    return null;
  }

  /**
   * Create a new connection
   */
  private async createConnection(): Promise<PoolConnection<T>> {
    const connectionId = `${this.config.name}_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
      const connection = await this.connectionFactory();

      const poolConnection: PoolConnection<T> = {
        id: connectionId,
        connection,
        createdAt: new Date(),
        lastUsed: new Date(),
        isActive: true,
        inUse: false,
      };

      this.connections.set(connectionId, poolConnection);

      this.logger.debug('Connection created', {
        poolName: this.config.name,
        connectionId,
        totalConnections: this.connections.size,
      });

      return poolConnection;
    } catch (error) {
      this.logger.error('Failed to create connection', {
        poolName: this.config.name,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Destroy a connection
   */
  private async destroyConnection(poolConnection: PoolConnection<T>): Promise<void> {
    try {
      if (this.connectionDestroyer) {
        await this.connectionDestroyer(poolConnection.connection);
      }

      this.connections.delete(poolConnection.id);

      this.logger.debug('Connection destroyed', {
        poolName: this.config.name,
        connectionId: poolConnection.id,
      });
    } catch (error) {
      this.logger.error('Failed to destroy connection', {
        poolName: this.config.name,
        connectionId: poolConnection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Perform health check on connections
   */
  private async performHealthCheck(): Promise<void> {
    if (!this.connectionValidator) {
      return;
    }

    const healthCheckPromises = Array.from(this.connections.values())
      .filter(conn => !conn.inUse)
      .map(async (poolConnection) => {
        try {
          const isHealthy = await this.connectionValidator!(poolConnection.connection);

          if (!isHealthy) {
            this.logger.warn('Unhealthy connection detected, destroying', {
              poolName: this.config.name,
              connectionId: poolConnection.id,
            });

            await this.destroyConnection(poolConnection);
          }
        } catch (error) {
          this.logger.warn('Health check failed, destroying connection', {
            poolName: this.config.name,
            connectionId: poolConnection.id,
            error: error instanceof Error ? error.message : String(error),
          });

          await this.destroyConnection(poolConnection);
        }
      });

    await Promise.allSettled(healthCheckPromises);
  }

  /**
   * Clean up idle connections
   */
  private async cleanupIdleConnections(): Promise<void> {
    const now = Date.now();
    const maxIdleTime = this.config.maxIdleTime;
    const minConnections = this.config.minConnections;

    const idleConnections = Array.from(this.connections.values())
      .filter(conn =>
        !conn.inUse &&
        (now - conn.lastUsed.getTime()) > maxIdleTime,
      )
      .sort((a, b) => a.lastUsed.getTime() - b.lastUsed.getTime());

    // Keep minimum connections
    const connectionsToRemove = idleConnections.slice(0,
      Math.max(0, this.connections.size - minConnections),
    );

    if (connectionsToRemove.length > 0) {
      const destroyPromises = connectionsToRemove.map(conn =>
        this.destroyConnection(conn),
      );

      await Promise.allSettled(destroyPromises);

      this.logger.debug('Idle connections cleaned up', {
        poolName: this.config.name,
        removedCount: connectionsToRemove.length,
        remainingCount: this.connections.size,
      });
    }
  }
}
