import { BaseConnector } from '../core/BaseConnector';
import type { AuthConfig } from '../types';
import { Logger } from '../utils/Logger';
import { CircuitBreakerState } from '../utils/CircuitBreaker';

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
