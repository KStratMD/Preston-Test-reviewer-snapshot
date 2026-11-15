import { RetryService, type RetryConfig } from '../../../src/resilience/RetryService';
import type { Logger } from '../../../src/utils/Logger';

describe('RetryService HTTP replay policy', () => {
  const config: RetryConfig = { maxAttempts: 3, baseDelay: 10, maxDelay: 100, exponentialBase: 2, jitter: false };
  let service: RetryService;
  let sleep: jest.SpyInstance;
  const failure = (status: number, retryAfter?: string) => ({ response: { status, headers: { 'retry-after': retryAfter } } });

  beforeEach(() => {
    service = new RetryService({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger);
    sleep = jest.spyOn(service as unknown as { sleep(ms: number): Promise<void> }, 'sleep').mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it.each([404, 401, 429, 503])('does not retry %i with the default unsafe context', async status => {
    const error = failure(status);
    const operation = jest.fn().mockRejectedValue(error);
    await expect(service.executeWithRetry(operation, config)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([401, 404])('does not retry %i even with safe replay', async status => {
    const error = failure(status);
    const operation = jest.fn().mockRejectedValue(error);
    await expect(service.executeWithRetry(operation, { ...config, replay: 'safe' })).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it.each([408, 425])('retries %i because it was rejected before processing', async status => {
    const operation = jest.fn().mockRejectedValueOnce(failure(status)).mockResolvedValue('ok');
    await expect(service.executeWithRetry(operation, config)).resolves.toMatchObject({ result: 'ok', attempts: 2 });
  });

  it('retries a safe 503 and caps Retry-After at maxDelay', async () => {
    const operation = jest.fn().mockRejectedValueOnce(failure(503, '60')).mockResolvedValue('ok');
    await expect(service.executeWithRetry(operation, { ...config, replay: 'safe' })).resolves.toMatchObject({ result: 'ok', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('threads safe replay through the convenience method', async () => {
    const operation = jest.fn().mockRejectedValueOnce(failure(502)).mockRejectedValueOnce(failure(502)).mockResolvedValue('ok');
    await expect(service.retry(operation, 3, 10, 'ctx', 'safe')).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('does not replay ambiguous network failures by default', async () => {
    const error = { request: {} };
    const operation = jest.fn().mockRejectedValue(error);
    await expect(service.executeWithRetry(operation, config)).rejects.toBe(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('keeps custom veto before HTTP inspection', async () => {
    const error = Object.defineProperty({}, 'response', { get: () => { throw new Error('classifier must not inspect a vetoed error'); } });
    const operation = jest.fn().mockRejectedValue(error);
    const retryCondition = jest.fn().mockReturnValue(false);
    await expect(service.executeWithRetry(operation, { ...config, replay: 'safe', retryCondition })).rejects.toBe(error);
    expect(retryCondition).toHaveBeenCalledWith(error);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('preserves non-HTTP retry behavior', async () => {
    const operation = jest.fn().mockRejectedValueOnce(new Error('temporary file failure')).mockResolvedValue('ok');
    await expect(service.executeWithRetry(operation, config)).resolves.toMatchObject({ result: 'ok', attempts: 2 });
    expect(sleep).toHaveBeenCalledWith(10);
  });

  it.each(['network', 'api'] as const)('%s preset requires the caller to opt into safe HTTP replay', async name => {
    const preset = RetryService.getDefaultConfigs()[name];
    for (const error of [failure(503), failure(429), { request: {} }]) {
      const operation = jest.fn().mockRejectedValue(error);
      await expect(service.executeWithRetry(operation, preset)).rejects.toBe(error);
      expect(operation).toHaveBeenCalledTimes(1);
    }
    expect(sleep).not.toHaveBeenCalled();
    const safeOperation = jest.fn().mockRejectedValueOnce(failure(503)).mockResolvedValue('ok');
    await expect(service.executeWithRetry(safeOperation, { ...preset, replay: 'safe' })).resolves.toMatchObject({ result: 'ok', attempts: 2 });
    expect(safeOperation).toHaveBeenCalledTimes(2);
  });
});
