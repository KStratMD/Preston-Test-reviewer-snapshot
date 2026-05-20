/**
 * ConnectionPool Unit Tests
 * Tests for generic connection pool with resource lifecycle management
 */

import {
  ConnectionPool,
  ConnectionPoolOptions,
  PooledResource,
  PoolStats,
} from '../../../src/utils/ConnectionPool';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Use real timers for this test
beforeAll(() => {
  jest.useRealTimers();
});

// Test resource type
interface TestResource {
  id: number;
  data: string;
  isValid: boolean;
}

// Concrete implementation for testing
class TestConnectionPool extends ConnectionPool<TestResource> {
  private resourceIdCounter = 0;
  public createCalls = 0;
  public destroyCalls = 0;
  public shouldFailCreate = false;
  public createDelay = 0;
  public destroyDelay = 0;

  async create(): Promise<TestResource> {
    this.createCalls++;
    
    if (this.shouldFailCreate) {
      throw new Error('Create failed');
    }
    
    if (this.createDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.createDelay));
    }
    
    return {
      id: ++this.resourceIdCounter,
      data: `resource-${this.resourceIdCounter}`,
      isValid: true,
    };
  }

  async destroy(resource: TestResource): Promise<void> {
    this.destroyCalls++;
    
    if (this.destroyDelay > 0) {
      await new Promise(resolve => setTimeout(resolve, this.destroyDelay));
    }
    
    resource.isValid = false;
  }
}

// Default test options
function createTestOptions(overrides: Partial<ConnectionPoolOptions> = {}): ConnectionPoolOptions {
  return {
    min: 1,
    max: 5,
    acquireTimeoutMs: 5000,
    createTimeoutMs: 3000,
    destroyTimeoutMs: 2000,
    idleTimeoutMs: 30000,
    reapIntervalMs: 60000,
    ...overrides,
  };
}

describe('ConnectionPool', () => {
  let pool: TestConnectionPool;

  afterEach(async () => {
    if (pool) {
      await pool.drain();
      // Give some time for cleanup
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  });

  describe('initialization', () => {
    it('should create resources via acquire when needed', async () => {
      // Note: initialization is async without await in constructor
      // So we test that resources are created when acquired
      pool = new TestConnectionPool(createTestOptions({ min: 0, max: 10 }));

      // Acquire will create a resource
      const resource = await pool.acquire();

      expect(resource).toBeDefined();
      expect(pool.createCalls).toBeGreaterThanOrEqual(1);

      pool.release(resource);
    });

    it('should emit resourceCreated events during initialization', async () => {
      const createdHandler = jest.fn();

      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      pool.on('resourceCreated', createdHandler);

      // Wait for async initialization - min: 1 should create 1 resource
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(createdHandler).toHaveBeenCalled();
    });
  });

  describe('acquire', () => {
    it('should acquire a resource from the pool', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource = await pool.acquire();
      
      expect(resource).toBeDefined();
      expect(resource.id).toBeDefined();
      expect(resource.data).toBeDefined();
    });

    it('should create new resource if pool is empty but under max', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 0, max: 5 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const initialCreateCalls = pool.createCalls;
      const resource = await pool.acquire();
      
      expect(resource).toBeDefined();
      expect(pool.createCalls).toBe(initialCreateCalls + 1);
    });

    it('should emit resourceAcquired event', async () => {
      const acquiredHandler = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      pool.on('resourceAcquired', acquiredHandler);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.acquire();
      
      expect(acquiredHandler).toHaveBeenCalled();
    });

    it('should track statistics on acquire', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.acquire();
      
      const stats = pool.getStats();
      expect(stats.totalAcquired).toBeGreaterThan(0);
    });

    it('should timeout if no resources available', async () => {
      pool = new TestConnectionPool(createTestOptions({
        min: 0,
        max: 1,
        acquireTimeoutMs: 100,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Acquire the only resource
      const resource = await pool.acquire();
      
      // Try to acquire another - should timeout
      await expect(pool.acquire()).rejects.toThrow('Acquire timeout');
      
      pool.release(resource);
    });

    it('should throw if pool is shutting down', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.drain();
      
      await expect(pool.acquire()).rejects.toThrow('Pool is shutting down');
    });
  });

  describe('release', () => {
    it('should release resource back to pool', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource = await pool.acquire();
      const statsBefore = pool.getStats();
      expect(statsBefore.inUseResources).toBeGreaterThan(0);
      
      pool.release(resource);
      
      const statsAfter = pool.getStats();
      expect(statsAfter.inUseResources).toBe(statsBefore.inUseResources - 1);
    });

    it('should emit resourceReleased event', async () => {
      const releasedHandler = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      pool.on('resourceReleased', releasedHandler);
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource = await pool.acquire();
      pool.release(resource);
      
      expect(releasedHandler).toHaveBeenCalledWith(resource);
    });

    it('should handle releasing unknown resource gracefully', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const unknownResource: TestResource = {
        id: 999,
        data: 'unknown',
        isValid: true,
      };
      
      // Should not throw
      pool.release(unknownResource);
    });

    it('should handle releasing already released resource', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource = await pool.acquire();
      pool.release(resource);
      
      // Second release should not throw
      pool.release(resource);
    });

    it('should make resource available for next acquire', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 1, max: 1 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource1 = await pool.acquire();
      pool.release(resource1);
      
      const resource2 = await pool.acquire();
      expect(resource2).toBe(resource1); // Same resource
    });
  });

  describe('getStats', () => {
    it('should return pool statistics', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 2 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = pool.getStats();
      
      expect(stats).toHaveProperty('totalResources');
      expect(stats).toHaveProperty('availableResources');
      expect(stats).toHaveProperty('inUseResources');
      expect(stats).toHaveProperty('pendingAcquires');
      expect(stats).toHaveProperty('totalCreated');
      expect(stats).toHaveProperty('totalDestroyed');
      expect(stats).toHaveProperty('totalAcquired');
      expect(stats).toHaveProperty('totalReleased');
      expect(stats).toHaveProperty('totalErrors');
      expect(stats).toHaveProperty('averageCreateTime');
      expect(stats).toHaveProperty('averageAcquireTime');
    });

    it('should track available vs in-use resources', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 3 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const statsBefore = pool.getStats();
      expect(statsBefore.availableResources).toBeGreaterThanOrEqual(3);
      expect(statsBefore.inUseResources).toBe(0);
      
      const resource = await pool.acquire();
      
      const statsAfter = pool.getStats();
      expect(statsAfter.inUseResources).toBe(1);
      expect(statsAfter.availableResources).toBe(statsBefore.availableResources - 1);
      
      pool.release(resource);
    });

    it('should calculate average create time', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 3 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const stats = pool.getStats();
      expect(stats.averageCreateTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('drain', () => {
    it('should drain all resources from pool', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 3 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const statsBefore = pool.getStats();
      expect(statsBefore.totalResources).toBeGreaterThanOrEqual(3);
      
      await pool.drain();
      
      const statsAfter = pool.getStats();
      expect(statsAfter.totalResources).toBe(0);
    });

    it('should destroy all resources on drain', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 3 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const initialDestroyCalls = pool.destroyCalls;
      
      await pool.drain();
      
      expect(pool.destroyCalls).toBeGreaterThan(initialDestroyCalls);
    });

    it('should reject pending acquires on drain', async () => {
      pool = new TestConnectionPool(createTestOptions({
        min: 0,
        max: 1,
        acquireTimeoutMs: 5000,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      // Acquire the only resource
      const resource = await pool.acquire();
      
      // Start another acquire that will wait
      const acquirePromise = pool.acquire();
      
      // Drain the pool
      await pool.drain();
      
      await expect(acquirePromise).rejects.toThrow('Pool is draining');
    });
  });

  describe('validation', () => {
    it('should validate resources before acquiring', async () => {
      const validateFn = jest.fn().mockResolvedValue(true);
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        validateConnection: validateFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.acquire();
      
      expect(validateFn).toHaveBeenCalled();
    });

    it('should destroy and recreate invalid resources', async () => {
      let validationCallCount = 0;
      const validateFn = jest.fn().mockImplementation(() => {
        validationCallCount++;
        // First validation fails, subsequent ones pass
        return Promise.resolve(validationCallCount > 1);
      });
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        max: 5,
        validateConnection: validateFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.acquire();
      
      // Should have called validate and then created a new resource
      expect(validateFn).toHaveBeenCalled();
      expect(pool.destroyCalls).toBeGreaterThan(0);
    });
  });

  describe('callbacks', () => {
    it('should call onResourceCreate callback', async () => {
      const onCreateFn = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        onResourceCreate: onCreateFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      expect(onCreateFn).toHaveBeenCalled();
    });

    it('should call onResourceAcquire callback', async () => {
      const onAcquireFn = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        onResourceAcquire: onAcquireFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.acquire();
      
      expect(onAcquireFn).toHaveBeenCalled();
    });

    it('should call onResourceRelease callback', async () => {
      const onReleaseFn = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        onResourceRelease: onReleaseFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource = await pool.acquire();
      pool.release(resource);
      
      expect(onReleaseFn).toHaveBeenCalledWith(resource);
    });

    it('should call onResourceDestroy callback', async () => {
      const onDestroyFn = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        onResourceDestroy: onDestroyFn,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await pool.drain();
      
      expect(onDestroyFn).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('should emit error event on create failure', async () => {
      const errorHandler = jest.fn();
      
      pool = new TestConnectionPool(createTestOptions({ min: 0 }));
      pool.on('error', errorHandler);
      pool.shouldFailCreate = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await expect(pool.acquire()).rejects.toThrow('Create failed');
      
      expect(errorHandler).toHaveBeenCalled();
    });

    it('should track errors in statistics', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 0 }));
      pool.shouldFailCreate = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      
      try {
        await pool.acquire();
      } catch {
        // Expected
      }
      
      const stats = pool.getStats();
      expect(stats.totalErrors).toBeGreaterThan(0);
    });
  });

  describe('timeout handling', () => {
    it('should timeout on slow create', async () => {
      pool = new TestConnectionPool(createTestOptions({
        min: 0,
        createTimeoutMs: 50,
      }));
      pool.createDelay = 200;
      await new Promise(resolve => setTimeout(resolve, 100));
      
      await expect(pool.acquire()).rejects.toThrow('Create timeout');
    });
  });

  describe('concurrent access', () => {
    it('should handle multiple concurrent acquires', async () => {
      pool = new TestConnectionPool(createTestOptions({ min: 0, max: 5 }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const acquirePromises = [
        pool.acquire(),
        pool.acquire(),
        pool.acquire(),
      ];
      
      const resources = await Promise.all(acquirePromises);
      
      expect(resources.length).toBe(3);
      expect(new Set(resources.map(r => r.id)).size).toBe(3); // All unique
      
      // Release all
      resources.forEach(r => pool.release(r));
    });

    it('should queue requests when at max capacity', async () => {
      pool = new TestConnectionPool(createTestOptions({
        min: 1,
        max: 1,
        acquireTimeoutMs: 1000,
      }));
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const resource1 = await pool.acquire();
      
      // Second acquire should wait
      const acquire2Promise = pool.acquire();
      
      // Stats should show pending acquire
      const stats = pool.getStats();
      expect(stats.pendingAcquires).toBe(1);
      
      // Release first resource
      pool.release(resource1);
      
      // Second acquire should now complete
      const resource2 = await acquire2Promise;
      expect(resource2).toBeDefined();
      
      pool.release(resource2);
    });
  });
});

describe('ConnectionPool events', () => {
  let pool: TestConnectionPool;

  afterEach(async () => {
    if (pool) {
      await pool.drain();
    }
  });

  it('should emit resourceCreated event', async () => {
    const handler = jest.fn();
    
    pool = new TestConnectionPool(createTestOptions({ min: 1 }));
    pool.on('resourceCreated', handler);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    expect(handler).toHaveBeenCalled();
  });

  it('should emit resourceDestroyed event', async () => {
    const handler = jest.fn();
    
    pool = new TestConnectionPool(createTestOptions({ min: 1 }));
    pool.on('resourceDestroyed', handler);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    await pool.drain();
    
    expect(handler).toHaveBeenCalled();
  });

  it('should emit resourceAcquired event', async () => {
    const handler = jest.fn();
    
    pool = new TestConnectionPool(createTestOptions({ min: 1 }));
    pool.on('resourceAcquired', handler);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const resource = await pool.acquire();
    
    expect(handler).toHaveBeenCalledWith(resource);
    
    pool.release(resource);
  });

  it('should emit resourceReleased event', async () => {
    const handler = jest.fn();
    
    pool = new TestConnectionPool(createTestOptions({ min: 1 }));
    pool.on('resourceReleased', handler);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const resource = await pool.acquire();
    pool.release(resource);
    
    expect(handler).toHaveBeenCalledWith(resource);
  });
});
