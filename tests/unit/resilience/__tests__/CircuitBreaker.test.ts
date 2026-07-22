
import { CircuitBreaker, CircuitState } from '../CircuitBreaker';

// Mock logger to prevent console noise during tests
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

const successfulAsyncFn = jest.fn().mockResolvedValue('success');
const failingAsyncFn = jest.fn().mockRejectedValue(new Error('failure'));

describe('CircuitBreaker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    successfulAsyncFn.mockClear();
    failingAsyncFn.mockClear();
    mockLogger.info.mockClear();
    mockLogger.warn.mockClear();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should start in a CLOSED state', () => {
    const breaker = new CircuitBreaker('test');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should allow execution and remain CLOSED on success', async () => {
    const breaker = new CircuitBreaker('test');
    const result = await breaker.execute(successfulAsyncFn);
    expect(result).toBe('success');
    expect(successfulAsyncFn).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
  });

  it('should count failures and remain CLOSED below threshold', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 3, minimumRequests: 1 });
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(failingAsyncFn).toHaveBeenCalledTimes(1);
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(breaker.getStats().failureCount).toBe(1);
  });

  it('should transition to OPEN state after reaching failure threshold', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 2, minimumRequests: 2, logger: mockLogger });

    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');

    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('is now OPEN'));
  });

  it('should not open before minimumRequests is met', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 2, minimumRequests: 3 });

    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');

    expect(breaker.getState()).toBe(CircuitState.CLOSED); // Still closed

    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN); // Now open
  });


  it('should reject calls immediately when in OPEN state', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, minimumRequests: 1 });

    // Trip the breaker
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Attempt to execute again
    await expect(breaker.execute(successfulAsyncFn)).rejects.toThrow('Circuit breaker test is OPEN');
    expect(successfulAsyncFn).not.toHaveBeenCalled();
  });

  it('should transition to HALF_OPEN state after resetTimeout', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, minimumRequests: 1, resetTimeout: 5000, logger: mockLogger });

    // Trip the breaker
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time
    jest.advanceTimersByTime(5000);

    // It should now be HALF_OPEN, so it will attempt the execution
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN); // Fails again, so back to OPEN
    expect(mockLogger.info).toHaveBeenCalledWith('Circuit breaker test moving to HALF_OPEN state');
  });

  it('should transition to CLOSED state on success in HALF_OPEN state', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, minimumRequests: 1, resetTimeout: 5000, logger: mockLogger });

    // Trip the breaker
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time to move to HALF_OPEN
    jest.advanceTimersByTime(5000);

    // Execute successfully
    const result = await breaker.execute(successfulAsyncFn);
    expect(result).toBe('success');
    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    expect(mockLogger.info).toHaveBeenCalledWith('Circuit breaker test is now CLOSED');
    expect(breaker.getStats().failureCount).toBe(0);
  });

  it('should transition back to OPEN state on failure in HALF_OPEN state', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, minimumRequests: 1, resetTimeout: 5000, logger: mockLogger });

    // Trip the breaker
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    // Advance time to move to HALF_OPEN
    jest.advanceTimersByTime(5000);

    // Fail again
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('is now OPEN'));
  });

  it('should reset all stats and state when reset() is called', async () => {
    const breaker = new CircuitBreaker('test', { failureThreshold: 1, minimumRequests: 1, logger: mockLogger });

    // Trip the breaker
    await expect(breaker.execute(failingAsyncFn)).rejects.toThrow('failure');
    expect(breaker.getState()).toBe(CircuitState.OPEN);

    breaker.reset();

    expect(breaker.getState()).toBe(CircuitState.CLOSED);
    const stats = breaker.getStats();
    expect(stats.failureCount).toBe(0);
    expect(stats.successCount).toBe(0);
    expect(stats.requestCount).toBe(0);
    expect(mockLogger.info).toHaveBeenCalledWith('Circuit breaker test has been reset');
  });
});
