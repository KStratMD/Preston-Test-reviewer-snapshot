import { RetryService, RetryConfig } from '../RetryService';
import { Logger } from '../../utils/Logger';

// Mock Logger
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe('RetryService', () => {
  let retryService: RetryService;
  let randomSpy: jest.SpyInstance<number, []>;

  // Use a single top-level beforeEach for setup that applies to all tests
  beforeEach(() => {
    retryService = new RetryService(mockLogger);
    jest.useFakeTimers(); // Revert to modern timers
    jest.spyOn(global, 'setTimeout');
    randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  // A single top-level afterEach for cleanup
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    randomSpy.mockRestore();
  });

  describe('executeWithRetry', () => {
    let operation: jest.Mock;
    const defaultConfig: RetryConfig = {
      maxAttempts: 3,
      baseDelay: 100,
      maxDelay: 1000,
      exponentialBase: 2,
      jitter: false,
    };

    // Isolate the mock for this describe block
    beforeEach(() => {
      operation = jest.fn();
    });

    it('should return result on first successful attempt', async () => {
      operation.mockResolvedValue('success');
      const result = await retryService.executeWithRetry(operation, defaultConfig);

      expect(operation).toHaveBeenCalledTimes(1);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(1);
      expect(result.errors).toHaveLength(0);
    });

    it('should retry on failure and succeed on the second attempt', async () => {
      operation
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const promise = retryService.executeWithRetry(operation, defaultConfig);

      await jest.advanceTimersByTimeAsync(100); // Advance past baseDelay

      const result = await promise;

      expect(operation).toHaveBeenCalledTimes(2);
      expect(result.result).toBe('success');
      expect(result.attempts).toBe(2);
      expect(result.errors).toHaveLength(1);
      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
    });

    it('should throw the last error after all attempts fail', async () => {
      operation.mockRejectedValue(new Error('permanent failure'));

      const promise = retryService.executeWithRetry(operation, defaultConfig);
      // Attach the rejection handler BEFORE advancing timers to avoid unhandled rejection warnings
      const rejection = expect(promise).rejects.toThrow('permanent failure');

      await jest.runAllTimersAsync();

      await rejection;
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should not retry if retryCondition returns false', async () => {
      operation.mockRejectedValue(new Error('non-retryable error'));
      const configWithCondition: RetryConfig = {
        ...defaultConfig,
        retryCondition: () => false,
      };

      await expect(retryService.executeWithRetry(operation, configWithCondition)).rejects.toThrow('non-retryable error');
      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should calculate delay with jitter correctly', async () => {
        operation
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('success');

      const configWithJitter: RetryConfig = { ...defaultConfig, jitter: true };
      const promise = retryService.executeWithRetry(operation, configWithJitter);
      
      // With Math.random mocked to 0.5, jitter is 0. (0.5 - 0.5) * 2 * amount = 0
      await jest.advanceTimersByTimeAsync(100);

      await promise;

      expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 100);
    });
  });

  describe('retryable', () => {
    let myFn: jest.Mock;

    // Isolate the mock for this describe block
    beforeEach(() => {
        myFn = jest.fn();
    });

    it('should wrap a function to make it retryable', async () => {
      myFn
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue('final success');

      const retryableFn = retryService.retryable(myFn, { maxAttempts: 2, baseDelay: 50, maxDelay: 100, exponentialBase: 2, jitter: false });

      const promise = retryableFn('arg1', 'arg2');

      await jest.advanceTimersByTimeAsync(50);

      const result = await promise;

      expect(result).toBe('final success');
      expect(myFn).toHaveBeenCalledTimes(2);
      expect(myFn).toHaveBeenCalledWith('arg1', 'arg2');
    });
  });

  describe('static retryConditions', () => {
    describe('defaultRetryCondition', () => {
      it('should return false for auth/validation/not found errors', () => {
        expect(RetryService.defaultRetryCondition(new Error('unauthorized'))).toBe(false);
        expect(RetryService.defaultRetryCondition(new Error('validation failed'))).toBe(false);
        expect(RetryService.defaultRetryCondition(new Error('item not found'))).toBe(false);
      });

      it('should return true for other errors', () => {
        expect(RetryService.defaultRetryCondition(new Error('server error'))).toBe(true);
        expect(RetryService.defaultRetryCondition(new Error('network timeout'))).toBe(true);
      });
    });

    describe('httpRetryCondition', () => {
      it('should not retry on 4xx client errors (except 408, 429)', () => {
        expect(RetryService.httpRetryCondition({ status: 400 })).toBe(false);
        expect(RetryService.httpRetryCondition({ status: 401 })).toBe(false);
        expect(RetryService.httpRetryCondition({ status: 404 })).toBe(false);
      });

      it('should retry on 408 and 429', () => {
        expect(RetryService.httpRetryCondition({ status: 408 })).toBe(true);
        expect(RetryService.httpRetryCondition({ status: 429 })).toBe(true);
      });

      it('should retry on 5xx server errors', () => {
        expect(RetryService.httpRetryCondition({ status: 500 })).toBe(true);
        expect(RetryService.httpRetryCondition({ status: 503 })).toBe(true);
      });
    });

    describe('databaseRetryCondition', () => {
      it('should retry on connection and deadlock errors', () => {
        expect(RetryService.databaseRetryCondition(new Error('connection error'))).toBe(true);
        expect(RetryService.databaseRetryCondition(new Error('deadlock detected'))).toBe(true);
      });

      it('should not retry on syntax or constraint errors', () => {
        expect(RetryService.databaseRetryCondition(new Error('sql syntax error'))).toBe(false);
        expect(RetryService.databaseRetryCondition(new Error('unique constraint violation'))).toBe(false);
      });
    });
  });
});