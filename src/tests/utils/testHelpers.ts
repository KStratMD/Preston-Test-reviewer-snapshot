/**
 * Test utility functions for robust async testing
 */

import type { Logger } from '../../utils/Logger';

export interface WaitForOptions {
  timeout?: number;
  interval?: number;
  timeoutMsg?: string;
}

/**
 * Wait for a condition to be true with proper error handling
 */
export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  options: WaitForOptions = {}
): Promise<void> {
  const {
    timeout = 5000,
    interval = 100,
    timeoutMsg = 'Condition was not met within timeout'
  } = options;

  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    const result = await condition();
    if (result) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }

  throw new Error(timeoutMsg);
}

/**
 * Wait for a specific value to be available
 */
export async function waitForValue<T>(
  getValue: () => T | Promise<T>,
  expectedValue: T,
  options: WaitForOptions = {}
): Promise<T> {
  await waitFor(async () => {
    const value = await getValue();
    return value === expectedValue;
  }, {
    ...options,
    timeoutMsg: options.timeoutMsg || `Expected value ${expectedValue} was not received within timeout`
  });

  return await getValue();
}

/**
 * Wait for an array to reach a specific length
 */
export async function waitForLength<T>(
  getArray: () => T[] | Promise<T[]>,
  expectedLength: number,
  options: WaitForOptions = {}
): Promise<T[]> {
  await waitFor(async () => {
    const array = await getArray();
    return array.length === expectedLength;
  }, {
    ...options,
    timeoutMsg: options.timeoutMsg || `Array did not reach length ${expectedLength} within timeout`
  });

  return await getArray();
}

/**
 * Wait for metrics to be collected by the performance monitor
 */
export async function waitForMetrics(
  monitor: unknown,
  minMetricsCount = 1,
  options: WaitForOptions = {}
): Promise<void> {
  await waitFor(() => {
    const metrics = (monitor as any).getAllMetrics?.() || (monitor as any).getMetrics?.() || [];
    return metrics.length >= minMetricsCount;
  }, {
    timeout: 3000,
    interval: 50,
    timeoutMsg: `Performance monitor did not collect ${minMetricsCount} metrics within timeout`,
    ...options
  });
}

/**
 * Wait for cache operations to complete
 */
export async function waitForCacheOperation(
  cache: unknown,
  key: string,
  operation: 'set' | 'get' | 'delete',
  options: WaitForOptions = {}
): Promise<void> {
  await waitFor(async () => {
    try {
      switch (operation) {
        case 'get':
          return await (cache as any).get(key) !== undefined;
        case 'set':
        case 'delete':
          // For set/delete, just verify the cache is responsive
          await (cache as any).get('__test__');
          return true;
        default:
          return false;
      }
    } catch {
      return false;
    }
  }, {
    timeout: 2000,
    interval: 50,
    timeoutMsg: `Cache ${operation} operation did not complete within timeout`,
    ...options
  });
}

/**
 * Create a mock function that resolves after a specific number of calls
 */
export function createAsyncMock<T = any>(
  returnValue: T,
  callsBeforeResolve = 1
): jest.Mock<Promise<T>> {
  let callCount = 0;

  return jest.fn().mockImplementation(async () => {
    callCount++;
    if (callCount >= callsBeforeResolve) {
      return returnValue;
    }
    throw new Error(`Mock not ready, call ${callCount}/${callsBeforeResolve}`);
  });
}

/**
 * Create a mock logger for testing
 */
export function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
    setCorrelationId: jest.fn().mockReturnThis(),
    withCorrelationId: jest.fn().mockReturnThis(),
    getCorrelationId: jest.fn().mockReturnValue('test-correlation-id'),
  } as unknown as jest.Mocked<Logger>;
}

/**
 * Flush all pending promises and timers
 */
export async function flushPromises(): Promise<void> {
  await new Promise(resolve => setImmediate(resolve));
}