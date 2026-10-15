/**
 * Base test class providing common setup and utilities
 */

import { resetMocks, mockContainer, mockTYPES } from './mockContainer';

export abstract class BaseTest {
  protected beforeEachSetup() {
    // Reset all mocks before each test
    resetMocks();

    // Set up clean test environment
    this.setupTestEnvironment();

    // Configure DI mocks
    this.setupDependencyInjection();
  }

  protected afterEachCleanup() {
    // Clean up any test artifacts
    jest.clearAllMocks();

    // Reset timers if using fake timers
    if (jest.isMockFunction(setTimeout)) {
      jest.useRealTimers();
    }
  }

  private setupTestEnvironment() {
    // Ensure test environment variables
    process.env.NODE_ENV = 'test';
    process.env.DEMO_MODE = '1';

    // Suppress console output in tests unless specifically needed
    if (!process.env.VERBOSE_TESTS) {
      jest.spyOn(console, 'log').mockImplementation(() => {});
      jest.spyOn(console, 'warn').mockImplementation(() => {});
    }
  }

  private setupDependencyInjection() {
    // Mock the inversify container
    jest.doMock('../../inversify/inversify.config', () => ({
      container: mockContainer,
    }));

    // Mock the TYPES
    jest.doMock('../../inversify/types', () => ({
      TYPES: mockTYPES,
    }));
  }

  /**
   * Helper to run tests with fake timers
   */
  protected withFakeTimers(testFn: () => Promise<void> | void) {
    return async () => {
      jest.useFakeTimers();
      try {
        await testFn();
      } finally {
        jest.useRealTimers();
      }
    };
  }

  /**
   * Helper to run tests with real timers (for actual async operations)
   */
  protected withRealTimers(testFn: () => Promise<void> | void) {
    return async () => {
      jest.useRealTimers();
      await testFn();
    };
  }

  /**
   * Helper to create isolated test with custom mocks
   */
  protected withCustomMocks(mocks: Record<string, unknown>, testFn: () => Promise<void> | void) {
    return async () => {
      // Apply custom mocks
      Object.entries(mocks).forEach(([path, mock]) => {
        jest.doMock(path, () => mock);
      });

      try {
        await testFn();
      } finally {
        // Clean up custom mocks
        Object.keys(mocks).forEach(path => {
          jest.dontMock(path);
        });
      }
    };
  }
}

/**
 * Test utilities for common operations
 */
export class TestUtils {
  /**
   * Wait for condition with timeout (for integration tests)
   */
  static async waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 5000,
    intervalMs = 100
  ): Promise<void> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      if (await condition()) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }

    throw new Error(`Condition not met within ${timeoutMs}ms`);
  }

  /**
   * Create a mock request object
   */
  static createMockRequest(overrides: unknown = {}): unknown {
    return {
      method: 'GET',
      path: '/test',
      url: '/test',
      headers: {},
      query: {},
      body: {},
      params: {},
      user: null,
      ...(overrides as any),
    };
  }

  /**
   * Create a mock response object
   */
  static createMockResponse(): unknown {
    const res: unknown = {};
    (res as any).status = jest.fn().mockReturnValue(res);
    (res as any).json = jest.fn().mockReturnValue(res);
    (res as any).send = jest.fn().mockReturnValue(res);
    (res as any).end = jest.fn().mockReturnValue(res);
    (res as any).set = jest.fn().mockReturnValue(res);
    (res as any).cookie = jest.fn().mockReturnValue(res);
    (res as any).redirect = jest.fn().mockReturnValue(res);
    return res;
  }

  /**
   * Create a mock next function
   */
  static createMockNext(): jest.Mock {
    return jest.fn();
  }

  /**
   * Assert that an async function throws
   */
  static async expectThrows(fn: () => Promise<unknown>, expectedError?: string | RegExp): Promise<void> {
    try {
      await fn();
      throw new Error('Expected function to throw, but it did not');
    } catch (error) {
      if (expectedError) {
        if (typeof expectedError === 'string') {
          expect((error as Error).message).toContain(expectedError);
        } else {
          expect((error as Error).message).toMatch(expectedError);
        }
      }
    }
  }
}