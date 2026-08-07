import { BaseConnector } from '../../../src/core/BaseConnector';
import { AuthConfig } from '../../../src/types';
import { Logger } from '../../../src/utils/Logger';
import { CircuitBreakerState, CircuitBreakerOptions } from '../../../src/utils/CircuitBreaker';

// Mock HTTP client returned by axios.create
const mockHttpClient = {
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
  request: jest.fn(),
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockHttpClient),
  // Shape-based (not hardcoded false): existing callers pass plain Errors
  // with no `.isAxiosError` property (still false), while the new
  // sensitive-transport tests craft axios-error-shaped fixtures that need
  // this to resolve true — backward compatible with every existing test.
  isAxiosError: jest.fn((error: unknown) => Boolean(error && (error as Record<string, unknown>).isAxiosError)),
}));

class TestConnector extends BaseConnector {
  constructor(logger: Logger, options?: Partial<CircuitBreakerOptions>) {
    super('TEST', 'test', logger, options);
  }

  async initialize(config: AuthConfig): Promise<void> {
    this.authConfig = config;
  }

  authenticate = jest.fn().mockResolvedValue(true);
  getSystemInfo = jest.fn();
  create = jest.fn();
  read = jest.fn();
  update = jest.fn();
  delete = jest.fn();
  list = jest.fn();
  search = jest.fn();

  protected async delay(_ms: number): Promise<void> {
    // override to avoid real delays in tests
  }

  public async execute(config: any) {
    return this['makeRequest'](config);
  }

  public async executeSensitive(config: any, safeLogUrl: string) {
    return this['makeSensitiveRequest'](config, safeLogUrl);
  }
}

/** Fails if any logger.{debug,info,warn,error} call argument contains any of `canaries`. */
function assertNoCanaryLogged(mockLogger: Logger, ...canaries: string[]): void {
  const allCalls = [
    ...(mockLogger.debug as jest.Mock).mock.calls,
    ...(mockLogger.info as jest.Mock).mock.calls,
    ...(mockLogger.warn as jest.Mock).mock.calls,
    ...(mockLogger.error as jest.Mock).mock.calls,
  ];
  const serialized = JSON.stringify(allCalls);
  for (const canary of canaries) {
    expect(serialized).not.toContain(canary);
  }
}

describe('BaseConnector reliability features', () => {
  let connector: TestConnector;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('retry logic', () => {
    beforeEach(() => {
      connector = new TestConnector(logger);
      connector.maxRetries = 3;
    });

    it('retries transient failures before succeeding', async () => {
      mockHttpClient.request
        .mockRejectedValueOnce(new Error('Network error'))
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue({ data: { ok: true } });

      const result = await connector.execute({ method: 'GET', url: '/test' });

      expect(result).toEqual({ ok: true });
      expect(mockHttpClient.request).toHaveBeenCalledTimes(3);
    });
  });

  describe('circuit breaker state transitions', () => {
    beforeEach(() => {
      jest.useFakeTimers();
      connector = new TestConnector(logger, { failureThreshold: 2, resetTimeout: 1000 });
      connector.maxRetries = 1; // fail fast for circuit breaker
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('opens, half-opens, and closes the circuit breaker', async () => {
      mockHttpClient.request.mockRejectedValue(new Error('Network error'));

      await expect(connector.execute({ method: 'GET', url: '/test' })).rejects.toThrow('Network error');
      await expect(connector.execute({ method: 'GET', url: '/test' })).rejects.toThrow('Network error');

      expect(connector['circuitBreaker'].getState()).toBe(CircuitBreakerState.OPEN);

      await expect(connector.execute({ method: 'GET', url: '/test' })).rejects.toThrow('Circuit breaker is OPEN');

      mockHttpClient.request.mockReset();
      mockHttpClient.request.mockResolvedValue({ data: { ok: true } });

      jest.advanceTimersByTime(1000);

      await connector.execute({ method: 'GET', url: '/test' });
      expect(connector['circuitBreaker'].getState()).toBe(CircuitBreakerState.HALF_OPEN);

      await connector.execute({ method: 'GET', url: '/test' });
      await connector.execute({ method: 'GET', url: '/test' });

      expect(connector['circuitBreaker'].getState()).toBe(CircuitBreakerState.CLOSED);
    });
  });
});

/**
 * Task 4 (2026-07-27 NetSuite serialized-asset sync plan) — sensitive
 * transport for the Salesforce Asset External-ID upsert path.
 * `makeRequest()` returns only `response.data` and its interceptors log the
 * literal request URL, so it cannot safely carry an External ID. These tests
 * pin that a canary planted in the real URL/body/raw-axios-error never
 * reaches a `logger.*` call argument or a thrown error message, while HTTP
 * status is preserved so callers can distinguish 201 (created) from 204
 * (updated).
 */
describe('BaseConnector sensitive request transport (makeSensitiveRequest)', () => {
  const CANARY_URL = '/sobjects/Asset/External_Id__c/SECRET-SERIAL-CANARY';
  const CANARY_VALUE = 'SECRET-SERIAL-CANARY';
  const CANARY_BODY = { SerialNumber: CANARY_VALUE };
  const SAFE_LOG_URL = '/sobjects/Asset/External_Id__c/[REDACTED]';

  let connector: TestConnector;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new TestConnector(logger);
    connector.maxRetries = 1;
    (connector as any).isAuthenticated = true;
  });

  it('returns data, status, and headers on success (status preserved)', async () => {
    mockHttpClient.request.mockResolvedValue({
      data: { id: 'a1x000000000001' },
      status: 201,
      headers: { 'x-test': '1' },
    });

    const result = await connector.executeSensitive(
      { method: 'PATCH', url: CANARY_URL, data: CANARY_BODY },
      SAFE_LOG_URL,
    );

    expect(result).toEqual({ data: { id: 'a1x000000000001' }, status: 201, headers: { 'x-test': '1' } });
  });

  it('preserves a 204 status with no distinguishing body', async () => {
    mockHttpClient.request.mockResolvedValue({ data: '', status: 204, headers: {} });

    const result = await connector.executeSensitive(
      { method: 'PATCH', url: CANARY_URL, data: CANARY_BODY },
      SAFE_LOG_URL,
    );

    expect(result.status).toBe(204);
  });

  it('tags the outgoing axios config with safeLogUrl without altering the real url/data', async () => {
    mockHttpClient.request.mockResolvedValue({ data: {}, status: 204, headers: {} });

    await connector.executeSensitive({ method: 'PATCH', url: CANARY_URL, data: CANARY_BODY }, SAFE_LOG_URL);

    expect(mockHttpClient.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'PATCH',
        url: CANARY_URL,
        data: CANARY_BODY,
        safeLogUrl: SAFE_LOG_URL,
      }),
    );
  });

  it('maps a 401 to an authentication failure, flips isAuthenticated false, and logs nothing', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 401',
      response: { status: 401, data: { message: CANARY_VALUE } },
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
    };
    mockHttpClient.request.mockRejectedValue(axiosError);

    await expect(
      connector.executeSensitive({ method: 'PATCH', url: CANARY_URL, data: CANARY_BODY }, SAFE_LOG_URL),
    ).rejects.toThrow('Authentication failed');

    expect((connector as any).isAuthenticated).toBe(false);
    assertNoCanaryLogged(logger, CANARY_URL, CANARY_VALUE);
  });

  it('maps a 403 to an access-forbidden failure and logs nothing', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 403',
      response: { status: 403, data: { message: CANARY_VALUE } },
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
    };
    mockHttpClient.request.mockRejectedValue(axiosError);

    await expect(
      connector.executeSensitive({ method: 'PATCH', url: CANARY_URL, data: CANARY_BODY }, SAFE_LOG_URL),
    ).rejects.toThrow('Access forbidden');

    assertNoCanaryLogged(logger, CANARY_URL, CANARY_VALUE);
  });

  it('never embeds the real URL, body, or raw axios error in the thrown error message', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 404',
      response: { status: 404, data: { message: CANARY_VALUE } },
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
    };
    mockHttpClient.request.mockRejectedValue(axiosError);

    let caught: Error | undefined;
    try {
      await connector.executeSensitive({ method: 'PATCH', url: CANARY_URL, data: CANARY_BODY }, SAFE_LOG_URL);
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeDefined();
    expect(caught!.message).not.toContain(CANARY_URL);
    expect(caught!.message).not.toContain(CANARY_VALUE);
    assertNoCanaryLogged(logger, CANARY_URL, CANARY_VALUE);
  });

  it('maps a network error (no response) to a service-unavailable failure', async () => {
    const axiosError = {
      isAxiosError: true,
      message: 'Network Error',
      request: {},
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
    };
    mockHttpClient.request.mockRejectedValue(axiosError);

    await expect(
      connector.executeSensitive({ method: 'PATCH', url: CANARY_URL, data: CANARY_BODY }, SAFE_LOG_URL),
    ).rejects.toThrow();
    assertNoCanaryLogged(logger, CANARY_URL, CANARY_VALUE);
  });
});

/**
 * Task 4 — the request/response interceptors registered by every
 * `BaseConnector` (shared by ordinary and sensitive requests alike, per the
 * plan's "same axios client" requirement) must redact when the failing/
 * logged config carries a `safeLogUrl` tag, and must otherwise behave
 * exactly as before (ordinary, untagged requests are unaffected).
 */
describe('BaseConnector interceptor redaction', () => {
  const CANARY_URL = '/sobjects/Asset/External_Id__c/SECRET-SERIAL-CANARY';
  const CANARY_VALUE = 'SECRET-SERIAL-CANARY';
  const CANARY_BODY = { SerialNumber: CANARY_VALUE };
  const SAFE_LOG_URL = '/sobjects/Asset/External_Id__c/[REDACTED]';

  let connector: TestConnector;
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    jest.clearAllMocks();
    connector = new TestConnector(logger);
  });

  function lastRequestInterceptorHandlers(): [any, any] {
    const calls = mockHttpClient.interceptors.request.use.mock.calls;
    return calls[calls.length - 1] as [any, any];
  }

  function lastResponseInterceptorHandlers(): [any, any] {
    const calls = mockHttpClient.interceptors.response.use.mock.calls;
    return calls[calls.length - 1] as [any, any];
  }

  it('debug-logs the safeLogUrl instead of the real url when the config is tagged', () => {
    const [onFulfilled] = lastRequestInterceptorHandlers();
    const taggedConfig = { method: 'patch', url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL };

    onFulfilled(taggedConfig);

    const debugCalls = JSON.stringify((logger.debug as jest.Mock).mock.calls);
    expect(debugCalls).toContain(SAFE_LOG_URL);
    expect(debugCalls).not.toContain(CANARY_URL);
  });

  it('keeps ordinary (untagged) request debug-logging unchanged', () => {
    const [onFulfilled] = lastRequestInterceptorHandlers();
    const plainConfig = { method: 'get', url: '/sobjects/Account' };

    onFulfilled(plainConfig);

    expect(logger.debug).toHaveBeenCalledWith('Making GET request to /sobjects/Account');
  });

  it('redacts a rejected axios error on the response interceptor when the failing config was tagged', async () => {
    const [, onRejected] = lastResponseInterceptorHandlers();
    const axiosError = {
      isAxiosError: true,
      message: 'Request failed with status code 500',
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
      response: { status: 500, data: { detail: CANARY_VALUE } },
    };

    await expect(onRejected(axiosError)).rejects.toBe(axiosError);

    const errorCalls = JSON.stringify((logger.error as jest.Mock).mock.calls);
    expect(errorCalls).toContain(SAFE_LOG_URL);
    expect(errorCalls).not.toContain(CANARY_URL);
    expect(errorCalls).not.toContain(CANARY_VALUE);
  });

  it('redacts a rejected axios error on the request interceptor when the failing config was tagged', async () => {
    const [, onRejected] = lastRequestInterceptorHandlers();
    const axiosError = {
      isAxiosError: true,
      message: 'Request setup failed',
      config: { url: CANARY_URL, data: CANARY_BODY, safeLogUrl: SAFE_LOG_URL },
    };

    await expect(onRejected(axiosError)).rejects.toBe(axiosError);

    const errorCalls = JSON.stringify((logger.error as jest.Mock).mock.calls);
    expect(errorCalls).toContain(SAFE_LOG_URL);
    expect(errorCalls).not.toContain(CANARY_URL);
  });

  it('keeps ordinary (untagged) response-error logging unchanged (raw error object)', async () => {
    const [, onRejected] = lastResponseInterceptorHandlers();
    const plainError = new Error('boom');

    await expect(onRejected(plainError)).rejects.toBe(plainError);

    expect(logger.error).toHaveBeenCalledWith('Response interceptor error', plainError);
  });
});

