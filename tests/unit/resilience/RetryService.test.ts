/**
 * RetryService Unit Tests
 * Tests for retry logic with exponential backoff and jitter
 */

import 'reflect-metadata';
import { RetryService, RetryConfig } from '../../../src/resilience/RetryService';
import { Logger } from '../../../src/utils/Logger';

describe('RetryService', () => {
  let retryService: RetryService;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    jest.useFakeTimers();

    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    retryService = new RetryService(mockLogger);
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  describe('executeWithRetry()', () => {
    const defaultConfig: RetryConfig = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      exponentialBase: 2,
      jitter: false,
    };

    it('should succeed on first attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig, 'test-context');
      jest.advanceTimersByTime(0);
      const result = await promise;

      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should retry on failure and succeed', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Temporary failure'))
        .mockResolvedValueOnce('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig, 'test-context');

      // First attempt fails
      await jest.advanceTimersByTimeAsync(0);

      // Wait for backoff delay (1000ms)
      await jest.advanceTimersByTimeAsync(1000);

      const result = await promise;

      expect(result.result).toBe('success');
      expect(result.attempts).toBe(2);
      expect(result.errors.length).toBe(1);
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should throw after max attempts exhausted', async () => {
      // Use real timers for this test with short delays
      jest.useRealTimers();

      const shortConfig: RetryConfig = {
        maxAttempts: 3,
        baseDelay: 10, // Very short delay for fast test
        maxDelay: 50,
        exponentialBase: 2,
        jitter: false,
      };

      const operation = jest.fn().mockImplementation(() => Promise.reject(new Error('Persistent failure')));

      await expect(
        retryService.executeWithRetry(operation, shortConfig, 'test-context')
      ).rejects.toThrow('Persistent failure');

      expect(operation).toHaveBeenCalledTimes(3);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'All retry attempts exhausted',
        expect.any(Object)
      );

      // Restore fake timers for other tests
      jest.useFakeTimers();
    });

    it('should stop retrying when retry condition returns false', async () => {
      const operation = jest.fn().mockImplementation(() => {
        return Promise.reject(new Error('unauthorized'));
      });

      const config: RetryConfig = {
        ...defaultConfig,
        retryCondition: (error) => {
          if (error instanceof Error && error.message.includes('unauthorized')) {
            return false;
          }
          return true;
        },
      };

      await expect(
        retryService.executeWithRetry(operation, config, 'test-context')
      ).rejects.toThrow('unauthorized');
      expect(operation).toHaveBeenCalledTimes(1); // No retries
    });

    it('should log debug message for each attempt', async () => {
      const operation = jest.fn().mockResolvedValue('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig, 'my-context');
      await promise;

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Executing operation with retry',
        expect.objectContaining({
          context: 'my-context',
          attempt: 1,
          maxAttempts: 3,
        })
      );
    });

    it('should log success on completion', async () => {
      const operation = jest.fn().mockResolvedValue('result');

      await retryService.executeWithRetry(operation, defaultConfig, 'success-context');

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Operation succeeded',
        expect.objectContaining({
          context: 'success-context',
          attempt: 1,
        })
      );
    });

    it('should log warning on each failed attempt', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('First fail'))
        .mockResolvedValueOnce('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig, 'warn-context');
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      await promise;

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Operation attempt failed',
        expect.objectContaining({
          context: 'warn-context',
          attempt: 1,
          error: 'First fail',
        })
      );
    });

    it('should calculate exponential backoff correctly', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockResolvedValueOnce('success');

      const config: RetryConfig = {
        ...defaultConfig,
        jitter: false, // Disable jitter for predictable delays
      };

      const promise = retryService.executeWithRetry(operation, config, 'test');

      // First attempt fails immediately
      await jest.advanceTimersByTimeAsync(0);

      // First backoff: baseDelay * 2^0 = 1000ms
      await jest.advanceTimersByTimeAsync(1000);

      // Second backoff: baseDelay * 2^1 = 2000ms
      await jest.advanceTimersByTimeAsync(2000);

      await promise;

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should respect maxDelay cap', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Fail 1'))
        .mockRejectedValueOnce(new Error('Fail 2'))
        .mockRejectedValueOnce(new Error('Fail 3'))
        .mockRejectedValueOnce(new Error('Fail 4'))
        .mockResolvedValueOnce('success');

      const config: RetryConfig = {
        maxAttempts: 5,
        baseDelay: 1000,
        maxDelay: 3000, // Cap at 3 seconds
        exponentialBase: 2,
        jitter: false,
      };

      const promise = retryService.executeWithRetry(operation, config, 'test');

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000); // 1st backoff: 1000ms
      await jest.advanceTimersByTimeAsync(2000); // 2nd backoff: 2000ms
      await jest.advanceTimersByTimeAsync(3000); // 3rd backoff: capped at 3000ms
      await jest.advanceTimersByTimeAsync(3000); // 4th backoff: capped at 3000ms

      await promise;

      expect(operation).toHaveBeenCalledTimes(5);
    });

    it('should track errors in result', async () => {
      const error1 = new Error('Error 1');
      const error2 = new Error('Error 2');

      const operation = jest.fn()
        .mockRejectedValueOnce(error1)
        .mockRejectedValueOnce(error2)
        .mockResolvedValueOnce('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig, 'test');
      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(1000);
      await jest.advanceTimersByTimeAsync(2000);

      const result = await promise;

      expect(result.errors).toContain(error1);
      expect(result.errors).toContain(error2);
      expect(result.errors.length).toBe(2);
    });
  });

  describe('retry()', () => {
    it('should use default config', async () => {
      const operation = jest.fn().mockResolvedValue('result');

      const result = await retryService.retry(operation);

      expect(result).toBe('result');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should use custom maxAttempts', async () => {
      // Use real timers for this test
      jest.useRealTimers();

      let callCount = 0;
      const operation = jest.fn().mockImplementation(() => {
        callCount++;
        return Promise.reject(new Error('Always fails'));
      });

      await expect(
        retryService.retry(operation, 2, 10, 'test') // Short 10ms delay
      ).rejects.toThrow('Always fails');

      expect(callCount).toBe(2);

      // Restore fake timers
      jest.useFakeTimers();
    });

    it('should use custom baseDelay', async () => {
      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');

      const promise = retryService.retry(operation, 3, 500, 'test');

      await jest.advanceTimersByTimeAsync(0);
      // With jitter enabled, delay will be around 500ms +/- 10%
      await jest.advanceTimersByTimeAsync(600);

      await promise;

      expect(operation).toHaveBeenCalledTimes(2);
    });
  });

  describe('retryable()', () => {
    const config: RetryConfig = {
      maxAttempts: 3,
      baseDelay: 100,
      maxDelay: 1000,
      exponentialBase: 2,
      jitter: false,
    };

    it('should create a retryable function', async () => {
      const originalFn = jest.fn().mockResolvedValue('result');

      const retryableFn = retryService.retryable(originalFn, config);
      const result = await retryableFn('arg1', 'arg2');

      expect(result).toBe('result');
      expect(originalFn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should retry the wrapped function on failure', async () => {
      const originalFn = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');

      const retryableFn = retryService.retryable(originalFn, config);
      const promise = retryableFn();

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);

      const result = await promise;

      expect(result).toBe('success');
      expect(originalFn).toHaveBeenCalledTimes(2);
    });

    it('should preserve function arguments across retries', async () => {
      const originalFn = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');

      const retryableFn = retryService.retryable(originalFn, config);
      const promise = retryableFn('a', 'b', 'c');

      await jest.advanceTimersByTimeAsync(0);
      await jest.advanceTimersByTimeAsync(100);

      await promise;

      expect(originalFn).toHaveBeenNthCalledWith(1, 'a', 'b', 'c');
      expect(originalFn).toHaveBeenNthCalledWith(2, 'a', 'b', 'c');
    });
  });

  describe('defaultRetryCondition()', () => {
    it('should not retry on unauthorized errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Unauthorized access'))).toBe(false);
      expect(RetryService.defaultRetryCondition(new Error('unauthorized'))).toBe(false);
    });

    it('should not retry on forbidden errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Forbidden resource'))).toBe(false);
    });

    it('should not retry on authentication errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Authentication failed'))).toBe(false);
      expect(RetryService.defaultRetryCondition(new Error('Invalid credentials provided'))).toBe(false);
    });

    it('should not retry on validation errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Validation error'))).toBe(false);
      expect(RetryService.defaultRetryCondition(new Error('Bad request'))).toBe(false);
      expect(RetryService.defaultRetryCondition(new Error('Invalid input'))).toBe(false);
    });

    it('should not retry on not found errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Resource not found'))).toBe(false);
      expect(RetryService.defaultRetryCondition(new Error('Entity does not exist'))).toBe(false);
    });

    it('should retry on network errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Network timeout'))).toBe(true);
      expect(RetryService.defaultRetryCondition(new Error('Connection reset'))).toBe(true);
    });

    it('should retry on generic errors', () => {
      expect(RetryService.defaultRetryCondition(new Error('Something went wrong'))).toBe(true);
    });

    it('should retry on non-Error values', () => {
      expect(RetryService.defaultRetryCondition('string error')).toBe(true);
      expect(RetryService.defaultRetryCondition(null)).toBe(true);
      expect(RetryService.defaultRetryCondition({ code: 500 })).toBe(true);
    });
  });

  describe('httpRetryCondition()', () => {
    it('should not retry on 4xx errors', () => {
      expect(RetryService.httpRetryCondition({ status: 400 })).toBe(false);
      expect(RetryService.httpRetryCondition({ status: 401 })).toBe(false);
      expect(RetryService.httpRetryCondition({ status: 403 })).toBe(false);
      expect(RetryService.httpRetryCondition({ status: 404 })).toBe(false);
    });

    it('should retry on 408 Request Timeout', () => {
      expect(RetryService.httpRetryCondition({ status: 408 })).toBe(true);
    });

    it('should retry on 429 Too Many Requests', () => {
      expect(RetryService.httpRetryCondition({ status: 429 })).toBe(true);
    });

    it('should retry on 5xx errors', () => {
      expect(RetryService.httpRetryCondition({ status: 500 })).toBe(true);
      expect(RetryService.httpRetryCondition({ status: 502 })).toBe(true);
      expect(RetryService.httpRetryCondition({ status: 503 })).toBe(true);
      expect(RetryService.httpRetryCondition({ status: 504 })).toBe(true);
    });

    it('should fallback to defaultRetryCondition for non-HTTP errors', () => {
      expect(RetryService.httpRetryCondition(new Error('Network error'))).toBe(true);
      expect(RetryService.httpRetryCondition(new Error('unauthorized'))).toBe(false);
    });
  });

  describe('databaseRetryCondition()', () => {
    it('should retry on connection errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('Connection refused'))).toBe(true);
      expect(RetryService.databaseRetryCondition(new Error('Connection timeout'))).toBe(true);
    });

    it('should retry on timeout errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('Query timeout'))).toBe(true);
    });

    it('should retry on network errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('Network error'))).toBe(true);
    });

    it('should retry on deadlock errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('Deadlock detected'))).toBe(true);
      expect(RetryService.databaseRetryCondition(new Error('Lock timeout exceeded'))).toBe(true);
    });

    it('should not retry on syntax errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('SQL syntax error'))).toBe(false);
    });

    it('should not retry on constraint errors', () => {
      expect(RetryService.databaseRetryCondition(new Error('Constraint violation'))).toBe(false);
      expect(RetryService.databaseRetryCondition(new Error('Duplicate key error'))).toBe(false);
    });

    it('should fallback to defaultRetryCondition', () => {
      expect(RetryService.databaseRetryCondition(new Error('unauthorized'))).toBe(false);
      expect(RetryService.databaseRetryCondition(new Error('Generic error'))).toBe(true);
    });
  });

  describe('getDefaultConfigs()', () => {
    it('should return network config', () => {
      const configs = RetryService.getDefaultConfigs();

      expect(configs.network).toBeDefined();
      expect(configs.network.maxAttempts).toBe(3);
      expect(configs.network.baseDelay).toBe(1000);
      expect(configs.network.jitter).toBe(true);
      expect(configs.network.retryCondition).toBe(RetryService.httpRetryCondition);
    });

    it('should return database config', () => {
      const configs = RetryService.getDefaultConfigs();

      expect(configs.database).toBeDefined();
      expect(configs.database.maxAttempts).toBe(3);
      expect(configs.database.baseDelay).toBe(500);
      expect(configs.database.retryCondition).toBe(RetryService.databaseRetryCondition);
    });

    it('should return api config', () => {
      const configs = RetryService.getDefaultConfigs();

      expect(configs.api).toBeDefined();
      expect(configs.api.maxAttempts).toBe(5);
      expect(configs.api.maxDelay).toBe(30000);
    });

    it('should return queue config', () => {
      const configs = RetryService.getDefaultConfigs();

      expect(configs.queue).toBeDefined();
      expect(configs.queue.baseDelay).toBe(2000);
      expect(configs.queue.maxDelay).toBe(15000);
    });

    it('should return file config with custom retry condition', () => {
      const configs = RetryService.getDefaultConfigs();

      expect(configs.file).toBeDefined();
      expect(configs.file.jitter).toBe(false);
      expect(configs.file.exponentialBase).toBe(1.5);
      expect(configs.file.retryCondition).toBeDefined();

      // Test the file retry condition
      const retryCondition = configs.file.retryCondition!;
      expect(retryCondition(new Error('EBUSY'))).toBe(true);
      expect(retryCondition(new Error('EMFILE'))).toBe(true);
      expect(retryCondition(new Error('temporary file error'))).toBe(true);
      expect(retryCondition(new Error('Permission denied'))).toBe(false);
      expect(retryCondition('non-error')).toBe(false);
    });
  });

  describe('jitter', () => {
    it('should apply jitter when enabled', async () => {
      // Mock Math.random to return a specific value
      const mockRandom = jest.spyOn(Math, 'random').mockReturnValue(0.5);

      const config: RetryConfig = {
        maxAttempts: 3,
        baseDelay: 1000,
        maxDelay: 10000,
        exponentialBase: 2,
        jitter: true,
      };

      const operation = jest.fn()
        .mockRejectedValueOnce(new Error('Fail'))
        .mockResolvedValueOnce('success');

      const promise = retryService.executeWithRetry(operation, config, 'test');

      await jest.advanceTimersByTimeAsync(0);
      // With jitter: baseDelay = 1000, jitter = 0 (since random=0.5, jitter=(0.5-0.5)*2*100=0)
      await jest.advanceTimersByTimeAsync(1100);

      await promise;

      expect(operation).toHaveBeenCalledTimes(2);
      mockRandom.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('should handle operation that throws non-Error', async () => {
      // Use real timers for this test
      jest.useRealTimers();

      const operation = jest.fn().mockImplementation(() => Promise.reject('string error'));

      const config: RetryConfig = {
        maxAttempts: 2,
        baseDelay: 10, // Short delay
        maxDelay: 50,
        exponentialBase: 2,
        jitter: false,
      };

      await expect(
        retryService.executeWithRetry(operation, config, 'test')
      ).rejects.toBe('string error');

      // Restore fake timers
      jest.useFakeTimers();
    });

    it('should work with single attempt (no retries)', async () => {
      const operation = jest.fn().mockImplementation(() => Promise.reject(new Error('Fail')));

      const config: RetryConfig = {
        maxAttempts: 1,
        baseDelay: 100,
        maxDelay: 1000,
        exponentialBase: 2,
        jitter: false,
      };

      await expect(
        retryService.executeWithRetry(operation, config, 'test')
      ).rejects.toThrow('Fail');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should handle context being undefined', async () => {
      const operation = jest.fn().mockResolvedValue('result');

      const config: RetryConfig = {
        maxAttempts: 1,
        baseDelay: 100,
        maxDelay: 1000,
        exponentialBase: 2,
        jitter: false,
      };

      const result = await retryService.executeWithRetry(operation, config);

      expect(result.result).toBe('result');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Executing operation with retry',
        expect.objectContaining({ context: undefined })
      );
    });
  });
});
