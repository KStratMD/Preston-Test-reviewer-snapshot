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
  isAxiosError: jest.fn(() => false),
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

