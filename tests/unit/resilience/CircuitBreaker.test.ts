/**
 * CircuitBreaker Unit Tests
 * Tests for circuit breaker pattern implementation
 */

import { CircuitBreaker, CircuitState, CircuitBreakerOptions } from '../../../src/resilience/CircuitBreaker';
import { Logger } from '../../../src/utils/Logger';

describe('CircuitBreaker', () => {
  let circuitBreaker: CircuitBreaker;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  describe('constructor', () => {
    it('should use default options', () => {
      circuitBreaker = new CircuitBreaker('test');

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(circuitBreaker.getStats().failureCount).toBe(0);
    });

    it('should accept custom options', () => {
      const options: CircuitBreakerOptions = {
        failureThreshold: 3,
        resetTimeout: 30000,
        monitoringPeriod: 5000,
        minimumRequests: 2,
        logger: mockLogger,
      };

      circuitBreaker = new CircuitBreaker('test', options);

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('execute()', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 3,
        resetTimeout: 60000,
        minimumRequests: 2,
        logger: mockLogger,
      });
    });

    it('should execute function when circuit is closed', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      const result = await circuitBreaker.execute(fn);

      expect(result).toBe('result');
      expect(fn).toHaveBeenCalled();
    });

    it('should track success count', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      await circuitBreaker.execute(fn);

      expect(circuitBreaker.getStats().successCount).toBe(1);
      expect(circuitBreaker.getStats().requestCount).toBe(1);
    });

    it('should track failure count on error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');

      expect(circuitBreaker.getStats().failureCount).toBe(1);
      expect(circuitBreaker.getStats().requestCount).toBe(1);
    });

    it('should throw when circuit is open', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Trigger circuit to open
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Next call should immediately reject
      await expect(circuitBreaker.execute(fn)).rejects.toThrow('Circuit breaker test is OPEN');
    });

    it('should not open circuit before minimum requests', async () => {
      const cb = new CircuitBreaker('test', {
        failureThreshold: 2,
        minimumRequests: 5,
        logger: mockLogger,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Only 3 failures but minimum requests is 5
      for (let i = 0; i < 3; i++) {
        await expect(cb.execute(fn)).rejects.toThrow('fail');
      }

      expect(cb.getState()).toBe(CircuitState.CLOSED);
    });

    it('should open circuit after threshold exceeded', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Need minimum 2 requests, failure threshold is 3
      // But we need both conditions met
      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');
      }

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Circuit breaker test is now OPEN')
      );
    });
  });

  describe('half-open state', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 2,
        resetTimeout: 10000,
        minimumRequests: 2,
        logger: mockLogger,
      });
    });

    it('should transition to half-open after reset timeout', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('fail');
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      // Advance time past reset timeout
      jest.advanceTimersByTime(10001);

      // Next execution should move to half-open and execute
      await circuitBreaker.execute(successFn);

      expect(successFn).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('moving to HALF_OPEN')
      );
    });

    it('should close circuit on success in half-open state', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('fail');
      }

      // Advance time past reset timeout
      jest.advanceTimersByTime(10001);

      // Execute successfully in half-open state
      await circuitBreaker.execute(successFn);

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('is now CLOSED')
      );
    });

    it('should open circuit on failure in half-open state', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('fail');
      }

      // Advance time past reset timeout
      jest.advanceTimersByTime(10001);

      // Fail in half-open state
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow('fail');

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should reset counters when moving from half-open to closed', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('success');

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(circuitBreaker.execute(failFn)).rejects.toThrow('fail');
      }

      // Advance time past reset timeout and succeed
      jest.advanceTimersByTime(10001);
      await circuitBreaker.execute(successFn);

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.requestCount).toBe(0);
    });
  });

  describe('getState()', () => {
    it('should return CLOSED initially', () => {
      circuitBreaker = new CircuitBreaker('test');

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should return OPEN when circuit is open', async () => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        minimumRequests: 1,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(circuitBreaker.execute(fn)).rejects.toThrow();

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('getStats()', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 5,
        minimumRequests: 1,
        logger: mockLogger,
      });
    });

    it('should return initial stats', () => {
      const stats = circuitBreaker.getStats();

      expect(stats.state).toBe(CircuitState.CLOSED);
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.requestCount).toBe(0);
      expect(stats.lastFailureTime).toBeUndefined();
      expect(stats.nextAttemptTime).toBeUndefined();
    });

    it('should track success statistics', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      await circuitBreaker.execute(fn);
      await circuitBreaker.execute(fn);
      await circuitBreaker.execute(fn);

      const stats = circuitBreaker.getStats();
      expect(stats.successCount).toBe(3);
      expect(stats.requestCount).toBe(3);
      expect(stats.failureCount).toBe(0);
    });

    it('should track failure statistics', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      for (let i = 0; i < 3; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow();
      }

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(3);
      expect(stats.requestCount).toBe(3);
      expect(stats.lastFailureTime).toBeDefined();
    });

    it('should track nextAttemptTime when open', async () => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        minimumRequests: 1,
        resetTimeout: 60000,
        logger: mockLogger,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));
      await expect(circuitBreaker.execute(fn)).rejects.toThrow();

      const stats = circuitBreaker.getStats();
      expect(stats.nextAttemptTime).toBeDefined();
      expect(stats.nextAttemptTime).toBeGreaterThan(Date.now());
    });
  });

  describe('reset()', () => {
    beforeEach(() => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 2,
        minimumRequests: 2,
        logger: mockLogger,
      });
    });

    it('should reset circuit to closed state', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      // Open the circuit
      for (let i = 0; i < 2; i++) {
        await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');
      }
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);

      circuitBreaker.reset();

      expect(circuitBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should clear all counters', async () => {
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));
      const successFn = jest.fn().mockResolvedValue('result');

      await circuitBreaker.execute(successFn);
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();

      circuitBreaker.reset();

      const stats = circuitBreaker.getStats();
      expect(stats.failureCount).toBe(0);
      expect(stats.successCount).toBe(0);
      expect(stats.requestCount).toBe(0);
      expect(stats.lastFailureTime).toBeUndefined();
      expect(stats.nextAttemptTime).toBeUndefined();
    });

    it('should log reset', () => {
      circuitBreaker.reset();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Circuit breaker test has been reset'
      );
    });
  });

  describe('edge cases', () => {
    it('should handle mixed success and failure', async () => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 3,
        minimumRequests: 3,
        logger: mockLogger,
      });

      const successFn = jest.fn().mockResolvedValue('success');
      const failFn = jest.fn().mockRejectedValue(new Error('fail'));

      await circuitBreaker.execute(successFn);
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();
      await circuitBreaker.execute(successFn);
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();
      await expect(circuitBreaker.execute(failFn)).rejects.toThrow();

      // 3 failures but only 2 successes + 3 failures = 5 total requests
      // Need 3 failures with at least 3 requests - should open
      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should handle immediately thrown errors', async () => {
      circuitBreaker = new CircuitBreaker('test');

      const fn = jest.fn().mockImplementation(() => {
        throw new Error('sync error');
      });

      await expect(circuitBreaker.execute(fn)).rejects.toThrow('sync error');
      expect(circuitBreaker.getStats().failureCount).toBe(1);
    });

    it('should work without logger', async () => {
      circuitBreaker = new CircuitBreaker('test', {
        failureThreshold: 1,
        minimumRequests: 1,
      });

      const fn = jest.fn().mockRejectedValue(new Error('fail'));

      await expect(circuitBreaker.execute(fn)).rejects.toThrow('fail');

      expect(circuitBreaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('CircuitState enum', () => {
    it('should have CLOSED state', () => {
      expect(CircuitState.CLOSED).toBe('CLOSED');
    });

    it('should have OPEN state', () => {
      expect(CircuitState.OPEN).toBe('OPEN');
    });

    it('should have HALF_OPEN state', () => {
      expect(CircuitState.HALF_OPEN).toBe('HALF_OPEN');
    });
  });
});
