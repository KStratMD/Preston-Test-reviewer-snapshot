import { BaseConnector } from '../core/BaseConnector';
import type { AuthConfig } from '../types';
import { Logger } from '../utils/Logger';
import { CircuitBreakerState } from '../utils/CircuitBreaker';
import type { AxiosRequestConfig } from 'axios';
import { UnauthorizedAppError } from '../errors/AppError';

// This test uses real timers because it tests retry logic and circuit breakers
// that depend on actual time passage
jest.useRealTimers();

// Mock axios to control HTTP responses
const mockAxiosInstance = {
  interceptors: {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  },
  request: jest.fn(),
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  delete: jest.fn(),
  defaults: {},
};

jest.mock('axios', () => ({
  create: jest.fn(() => mockAxiosInstance),
  isAxiosError: jest.fn(),
}));

// Import the mocked axios
import axios from 'axios';
const mockAxios = axios as jest.Mocked<typeof axios>;

// Mock implementation of BaseConnector for testing
class TestConnector extends BaseConnector {
  constructor(logger: Logger) {
    super('TEST', 'test-system', logger);
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

  // Expose protected methods for testing
  public async testMakeRequest(config: any) {
    return this.makeRequest(config);
  }

  public setAuthenticated(isAuthenticated: boolean) {
    this.isAuthenticated = isAuthenticated;
  }
}

describe.each(['ordinary', 'sensitive'] as const)('%s transport retry policy', transport => {
  let connector: TestConnector;
  let logger: Logger;
  const wait = jest.fn<Promise<void>, [number]>().mockResolvedValue(undefined);
  const success = { data: { ok: true }, status: 201, headers: { etag: 'version' } };
  const failure = (status: number, retryAfter?: string) => ({ isAxiosError: true, response: { status, headers: { 'retry-after': retryAfter }, data: { message: 'response-secret' } }, config: { url: '/url-secret', data: 'payload-secret' } });
  const send = (config: AxiosRequestConfig = { method: 'GET', url: '/probe' }) => transport === 'sensitive'
    ? connector['makeSensitiveRequest'](config, '/redacted')
    : connector['makeRequest'](config);

  beforeEach(() => {
    logger = new Logger();
    for (const method of ['info', 'warn', 'error', 'debug'] as const) jest.spyOn(logger, method).mockImplementation(() => {});
    connector = new TestConnector(logger);
    connector.setAuthenticated(true);
    connector['delay'] = wait;
    wait.mockClear();
    mockAxiosInstance.request.mockReset();
    mockAxios.isAxiosError.mockImplementation((error: unknown): error is import('axios').AxiosError => Boolean(error && typeof error === 'object' && 'isAxiosError' in error));
  });
  afterEach(() => jest.restoreAllMocks());

  it('does not retry terminal 404', async () => {
    mockAxiosInstance.request.mockRejectedValue(failure(404));
    await expect(send()).rejects.toThrow('Resource not found');
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    expect(wait).not.toHaveBeenCalled();
  });

  it('honors and bounds Retry-After, preserving the response and safe log tag', async () => {
    mockAxiosInstance.request.mockRejectedValueOnce(failure(429, '999999')).mockResolvedValueOnce(success);
    expect(await send()).toEqual(transport === 'sensitive' ? success : success.data);
    expect(wait).toHaveBeenCalledWith(60000);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    if (transport === 'sensitive') expect(mockAxiosInstance.request).toHaveBeenLastCalledWith(expect.objectContaining({ safeLogUrl: '/redacted' }));
  });

  it.each([429, 500, 503, 'network'] as const)('never replays an unkeyed POST or PATCH on %s', async status => {
    for (const method of ['POST', 'PATCH']) {
      mockAxiosInstance.request.mockReset().mockRejectedValue(status === 'network' ? { isAxiosError: true, request: {} } : failure(status));
      await expect(send({ method, url: '/orders', data: {} })).rejects.toThrow();
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    }
    expect(wait).not.toHaveBeenCalled();
  });

  it.each([408, 425])('replays an unkeyed write rejected before processing on %i', async status => {
    mockAxiosInstance.request.mockRejectedValueOnce(failure(status)).mockResolvedValueOnce(success);
    await send({ method: 'POST', url: '/orders' });
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
  });

  it.each(['Idempotency-Key', 'idempotency-key', 'explicit'])('replays a keyed write using %s', async key => {
    for (const status of [429, 500]) {
      mockAxiosInstance.request.mockReset().mockRejectedValueOnce(failure(status)).mockResolvedValueOnce(success);
      const config: AxiosRequestConfig & { idempotent?: boolean } = { method: 'POST', url: '/orders' };
      if (key === 'explicit') config.idempotent = true;
      else config.headers = { [key]: 'stable-key' };
      await send(config);
      expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    }
  });

  it('bounds GET retries and never waits after the last failure', async () => {
    mockAxiosInstance.request.mockRejectedValue(failure(503));
    await expect(send()).rejects.toThrow('Service unavailable');
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it('reauthenticates once through the guard and then succeeds', async () => {
    connector.authenticate.mockImplementation(async () => {
      expect(connector['isAuthenticating']).toBe(true);
      return true;
    });
    mockAxiosInstance.request.mockRejectedValueOnce(failure(401)).mockResolvedValueOnce(success);
    await send();
    expect(connector.authenticate).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    expect(connector['isAuthenticating']).toBe(false);
  });

  it('a second 401 is terminal', async () => {
    connector.authenticate.mockImplementation(async () => { connector.setAuthenticated(true); return true; });
    mockAxiosInstance.request.mockRejectedValue(failure(401));
    await expect(send()).rejects.toBeInstanceOf(UnauthorizedAppError);
    expect(connector.authenticate).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    expect(connector['isAuthenticated']).toBe(false);
  });

  it.each(['POST', 'PATCH'])('deliberately replays an unkeyed %s once after a 401 auth challenge', async method => {
    mockAxiosInstance.request.mockRejectedValueOnce(failure(401)).mockResolvedValueOnce(success);
    await send({ method, url: '/orders', data: { order: 'test' } });
    expect(connector.authenticate).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
    expect(wait).not.toHaveBeenCalled();
  });

  it('a nested authentication 401 is terminal', async () => {
    connector.setAuthenticated(false);
    connector.authenticate.mockImplementation(async () => { await send({ method: 'POST', url: '/token' }); return true; });
    mockAxiosInstance.request.mockRejectedValue(failure(401));
    await expect(send()).rejects.toBeInstanceOf(UnauthorizedAppError);
    expect(connector.authenticate).toHaveBeenCalledTimes(1);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(1);
    expect(connector['isAuthenticating']).toBe(false);
    expect(connector['isAuthenticated']).toBe(false);
  });

  it.each([false, true])('fails closed when authenticate returns false (already authenticated: %s)', async alreadyAuthenticated => {
    connector.setAuthenticated(alreadyAuthenticated);
    connector.authenticate.mockResolvedValue(false);
    mockAxiosInstance.request.mockRejectedValueOnce(failure(401)).mockResolvedValue(success);
    await expect(send()).rejects.toBeInstanceOf(UnauthorizedAppError);
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(alreadyAuthenticated ? 1 : 0);
    expect(connector.authenticate).toHaveBeenCalledTimes(1);
    expect(connector['isAuthenticating']).toBe(false);
    expect(connector['isAuthenticated']).toBe(false);
  });

  if (transport === 'sensitive') {
    it.each(['retry', 'reauth', 'authentication'])('keeps secrets out of errors and logs after %s failure', async path => {
      const raw = Object.assign(new Error('message-secret'), failure(path === 'retry' ? 503 : 401));
      if (path === 'authentication') {
        connector.setAuthenticated(false);
        connector.authenticate.mockRejectedValue(raw);
      } else mockAxiosInstance.request.mockRejectedValue(raw);
      let caught: unknown;
      try { await send({ method: 'GET', url: '/url-secret', data: 'payload-secret' }); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(Error);
      const rendered = require('node:util').inspect({ caught, logs: ['info', 'warn', 'error', 'debug'].map(method => (logger[method as keyof Logger] as jest.Mock).mock.calls) }, { depth: 10 });
      expect(rendered).toContain(path === 'retry' ? 'Service unavailable' : 'Authentication failed');
      expect(rendered).not.toMatch(/message-secret|response-secret|url-secret|payload-secret/);
      expect((caught as Error & { cause?: unknown }).cause).toBeUndefined();
      if (path !== 'retry') {
        expect(caught).toBeInstanceOf(UnauthorizedAppError);
        expect(connector['isAuthenticated']).toBe(false);
      }
    });
  }
});

describe('BaseConnector', () => {
  let connector: TestConnector;
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger();
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    jest.spyOn(logger, 'warn').mockImplementation(() => {});
    jest.spyOn(logger, 'error').mockImplementation(() => {});
    connector = new TestConnector(logger);
    // Reset mocks
    mockAxios.isAxiosError.mockReset();
    mockAxiosInstance.request.mockReset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('should initialize with correct properties', () => {
    expect(connector.systemType).toBe('TEST');
    expect(connector.systemId).toBe('test-system');
    expect(connector['logger']).toBeDefined();
    expect(connector['isAuthenticated']).toBe(false);
    expect(connector['httpClient']).toBeDefined();
  });

  it('should set and get authentication config', async () => {
    const authConfig = { type: 'api_key', credentials: { apiKey: '123' } };
    // Cast to any to bypass AuthConfig signature constraints
    await connector.initialize(authConfig as AuthConfig);
    expect(connector.authConfig).toEqual(authConfig);
  });

  it('should handle successful API requests', async () => {
    const mockResponse = { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config: {} };
    mockAxiosInstance.request.mockResolvedValueOnce(mockResponse);

    const result = await connector['makeRequest']({ method: 'GET', url: '/test' });
    expect(result).toEqual(mockResponse.data); // makeRequest returns response.data
    expect(mockAxiosInstance.request).toHaveBeenCalledWith({
      method: 'GET',
      url: '/test',
    });
  });

  it('should handle API request errors', async () => {
    const mockError = new Error('Request failed');
    mockAxiosInstance.request.mockRejectedValueOnce(mockError);

    await expect(connector['makeRequest']({ method: 'GET', url: '/test' }))
      .rejects.toThrow('Request setup error'); // BaseConnector wraps errors
  });

  it('should handle rate limiting and retry', async () => {
    const rateLimitError = { response: { status: 429 } };
    const mockResponse = { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config: {} };

    mockAxiosInstance.request
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce(mockResponse);

    const result = await connector['makeRequest']({ method: 'GET', url: '/test' });
    expect(result).toEqual(mockResponse.data); // makeRequest returns response.data
    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(2);
  });

  it('should throw error if max retries exceeded', async () => {
    const rateLimitError = { response: { status: 429 } };

    mockAxiosInstance.request.mockRejectedValue(rateLimitError); // Always rate limited

    await expect(connector['makeRequest']({ method: 'GET', url: '/test' }))
      .rejects.toThrow('Request setup error'); // BaseConnector wraps errors

    expect(mockAxiosInstance.request).toHaveBeenCalledTimes(3); // Initial + 2 retries (default maxRetries=2)
  });

  describe('Authentication', () => {
    it('should call authenticate if not already authenticated', async () => {
      connector.setAuthenticated(false);
      const mockResponse = { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config: {} };
      mockAxiosInstance.request.mockResolvedValueOnce(mockResponse);
      await connector.testMakeRequest({});
      expect(connector.authenticate).toHaveBeenCalled();
    });

    it('should not call authenticate if already authenticated', async () => {
      connector.setAuthenticated(true);
      const mockResponse = { data: { success: true }, status: 200, statusText: 'OK', headers: {}, config: {} };
      mockAxiosInstance.request.mockResolvedValueOnce(mockResponse);
      await connector.testMakeRequest({});
      expect(connector.authenticate).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors correctly', async () => {
      const axiosError = {
        response: { status: 500, data: { message: 'Internal Server Error' }, statusText: 'Internal Server Error' },
        isAxiosError: true,
      };
      mockAxios.isAxiosError.mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValue(axiosError);
      await expect(connector.testMakeRequest({})).rejects.toThrow('Server error: Internal Server Error');
    });

    it('should handle network errors', async () => {
      const networkError = { request: {}, isAxiosError: true };
      mockAxios.isAxiosError.mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValue(networkError);
      await expect(connector.testMakeRequest({})).rejects.toThrow('Network error: No response received');
    });

    it('should handle request setup errors', async () => {
      mockAxiosInstance.request.mockRejectedValue(new Error('Request setup error'));
      await expect(connector.testMakeRequest({})).rejects.toThrow('Request setup error: Request setup error');
    });
  });

  describe('Circuit Breaker', () => {
    it('should open circuit after multiple failures', async () => {
      // Create network errors that the circuit breaker will count as failures
      const networkError = new Error('Network error: Connection failed');
      mockAxiosInstance.request.mockRejectedValue(networkError);

      // Trigger enough failures to open circuit (default threshold is 5)
      for (let i = 0; i < 5; i++) {
        try {
          await connector.testMakeRequest({});
        } catch (e) {
          // Expected to fail
        }
      }

      expect((connector as any).circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);
    }, 30000);

    it('should not open circuit for non-retryable errors', async () => {
      const authError = {
        response: { status: 401, data: { message: 'Auth error' }, statusText: 'Unauthorized' },
        isAxiosError: true,
      };
      mockAxios.isAxiosError.mockReturnValue(true);
      mockAxiosInstance.request.mockRejectedValue(authError);
      await expect(connector.testMakeRequest({})).rejects.toThrow('Authentication failed: Auth error');
      expect((connector as any).circuitBreaker.getState()).toBe(CircuitBreakerState.CLOSED);
    });

    it('should reset circuit after timeout', async () => {
      // Manually trigger failures to open circuit
      const circuitBreaker = (connector as any).circuitBreaker;
      for (let i = 0; i < 5; i++) {
        try {
          await circuitBreaker.execute(async () => Promise.reject(new Error('Network error')));
        } catch (e) {
          // Expected to fail
        }
      }
      expect(circuitBreaker.getState()).toBe(CircuitBreakerState.OPEN);

      // Fast-forward time to simulate timeout
      const mockDateNow = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 70000);

      mockAxiosInstance.request.mockRejectedValue(new Error('Still failing'));
      await expect(connector.testMakeRequest({})).rejects.toThrow();

      mockDateNow.mockRestore();
    });
  });
});
