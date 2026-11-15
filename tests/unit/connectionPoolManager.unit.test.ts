import { ConnectionPoolManager, type PoolConfig } from '../../src/performance/ConnectionPoolManager';
import type { Logger } from '../../src/utils/Logger';

const createLogger = (): Logger => ({
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis(),
} as unknown as Logger);

describe('ConnectionPoolManager', () => {
  let manager: ConnectionPoolManager;
  let logger: Logger;

  beforeEach(() => {
    logger = createLogger();
    manager = new ConnectionPoolManager(logger);
  });

  afterEach(async () => {
    await manager.destroyAllPools();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const baseConfig: PoolConfig = {
    name: 'base',
    maxConnections: 2,
    minConnections: 0,
    maxIdleTime: 200,
    connectionTimeout: 50,
    retryAttempts: 3,
    retryDelay: 10,
    healthCheckInterval: 100,
  };

  it('acquires and releases connections', async () => {
    jest.useFakeTimers();
    const factory = jest.fn().mockResolvedValue({});

    await manager.createPool({ ...baseConfig, name: 'acquire' }, factory);

    const conn = await manager.getConnection('acquire');
    expect(factory).toHaveBeenCalledTimes(1);
    await manager.releaseConnection('acquire', conn.id);

    const metrics = manager.getPoolMetrics('acquire');
    expect(metrics?.activeConnections).toBe(0);
    expect(metrics?.idleConnections).toBe(1);
  });

  it('retries acquiring connection when factory fails initially', async () => {
    jest.useFakeTimers();
    const factory = jest
      .fn()
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValue({});

    const config = { ...baseConfig, name: 'retry' };
    await manager.createPool(config, factory);

    const acquireWithRetry = async () => {
      for (let attempt = 0; attempt < config.retryAttempts; attempt++) {
        try {
          return await manager.getConnection('retry');
        } catch (err) {
          if (attempt === config.retryAttempts - 1) throw err;
          await jest.advanceTimersByTimeAsync(config.retryDelay);
        }
      }
      throw new Error('Unable to acquire');
    };

    const conn = await acquireWithRetry();
    expect(factory).toHaveBeenCalledTimes(2);
    await manager.releaseConnection('retry', conn.id);
  });

  it('destroys unhealthy connections during health checks', async () => {
    jest.useFakeTimers();
    const factory = jest.fn().mockResolvedValue({});
    const validator = jest.fn().mockResolvedValue(false);

    const config = { ...baseConfig, name: 'health', healthCheckInterval: 50 };
    await manager.createPool(config, factory, validator);

    const conn = await manager.getConnection('health');
    await manager.releaseConnection('health', conn.id);

    await jest.advanceTimersByTimeAsync(60);
    expect(validator).toHaveBeenCalled();
    const metrics = manager.getPoolMetrics('health');
    expect(metrics?.totalConnections).toBe(0);
  });

  it('cleans up idle connections after timeout', async () => {
    jest.useFakeTimers();
    const factory = jest.fn().mockResolvedValue({});

    const config = { ...baseConfig, name: 'idle', maxIdleTime: 100 };
    await manager.createPool(config, factory);

    const conn = await manager.getConnection('idle');
    await manager.releaseConnection('idle', conn.id);

    await jest.advanceTimersByTimeAsync(200);
    const metrics = manager.getPoolMetrics('idle');
    expect(metrics?.totalConnections).toBe(0);
  });
});
