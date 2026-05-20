/**
 * moduleHttpClient Unit Tests
 * Tests for module HTTP client utility functions
 */

import {
  useRealModuleApis,
  fetchModuleData,
  fetchModuleDataBatch,
  isModuleApiAvailable,
} from '../../../src/utils/moduleHttpClient';
import type { Logger } from '../../../src/utils/Logger';

// Mock global fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('moduleHttpClient', () => {
  let mockLogger: Logger;
  const originalEnv = process.env.USE_REAL_MODULE_APIS;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as unknown as Logger;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
    if (originalEnv !== undefined) {
      process.env.USE_REAL_MODULE_APIS = originalEnv;
    } else {
      delete process.env.USE_REAL_MODULE_APIS;
    }
  });

  describe('useRealModuleApis()', () => {
    it('should return true when USE_REAL_MODULE_APIS is "true"', () => {
      process.env.USE_REAL_MODULE_APIS = 'true';
      expect(useRealModuleApis()).toBe(true);
    });

    it('should return false when USE_REAL_MODULE_APIS is "false"', () => {
      process.env.USE_REAL_MODULE_APIS = 'false';
      expect(useRealModuleApis()).toBe(false);
    });

    it('should return false when USE_REAL_MODULE_APIS is not set', () => {
      delete process.env.USE_REAL_MODULE_APIS;
      expect(useRealModuleApis()).toBe(false);
    });

    it('should return false for any value other than "true"', () => {
      process.env.USE_REAL_MODULE_APIS = 'TRUE';
      expect(useRealModuleApis()).toBe(false);

      process.env.USE_REAL_MODULE_APIS = '1';
      expect(useRealModuleApis()).toBe(false);
    });
  });

  describe('fetchModuleData()', () => {
    const endpoint = 'http://api.example.com/data';
    const fallbackData = { name: 'fallback' };

    describe('when USE_REAL_MODULE_APIS is false', () => {
      beforeEach(() => {
        delete process.env.USE_REAL_MODULE_APIS;
      });

      it('should return fallback data without making HTTP request', async () => {
        const result = await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(result).toEqual(fallbackData);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      it('should not log anything', async () => {
        await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(mockLogger.warn).not.toHaveBeenCalled();
        expect(mockLogger.info).not.toHaveBeenCalled();
      });
    });

    describe('when USE_REAL_MODULE_APIS is true', () => {
      beforeEach(() => {
        process.env.USE_REAL_MODULE_APIS = 'true';
      });

      it('should fetch data from endpoint', async () => {
        const apiData = { name: 'from-api' };
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve(apiData),
        });

        const result = await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(result).toEqual(apiData);
        expect(mockFetch).toHaveBeenCalledWith(
          endpoint,
          expect.objectContaining({
            method: 'GET',
            headers: expect.objectContaining({
              'Accept': 'application/json',
              'Content-Type': 'application/json',
            }),
          })
        );
      });

      it('should return fallback data on HTTP error', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
        });

        const result = await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(result).toEqual(fallbackData);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Module API unavailable, using fallback data',
          expect.objectContaining({ endpoint })
        );
      });

      it('should return fallback data on network error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        const result = await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(result).toEqual(fallbackData);
        expect(mockLogger.warn).toHaveBeenCalled();
      });

      it('should include custom headers', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });

        await fetchModuleData(endpoint, fallbackData, mockLogger, {
          headers: { 'Authorization': 'Bearer token123' },
        });

        expect(mockFetch).toHaveBeenCalledWith(
          endpoint,
          expect.objectContaining({
            headers: expect.objectContaining({
              'Authorization': 'Bearer token123',
            }),
          })
        );
      });

      it('should log success when logSuccess option is true', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });

        await fetchModuleData(endpoint, fallbackData, mockLogger, {
          logSuccess: true,
        });

        expect(mockLogger.info).toHaveBeenCalledWith(
          'Module API data fetched successfully',
          { endpoint }
        );
      });

      it('should not log success when logSuccess option is false', async () => {
        mockFetch.mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({}),
        });

        await fetchModuleData(endpoint, fallbackData, mockLogger, {
          logSuccess: false,
        });

        expect(mockLogger.info).not.toHaveBeenCalled();
      });

      it('should handle timeout via AbortController', async () => {
        // Simulate a slow response that gets aborted
        mockFetch.mockImplementationOnce((_url, options) => {
          return new Promise((resolve, reject) => {
            // Listen for abort signal
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                reject(new Error('Aborted'));
              });
            }
          });
        });

        const resultPromise = fetchModuleData(endpoint, fallbackData, mockLogger, {
          timeoutMs: 50,
        });

        // Advance timers to trigger abort
        jest.advanceTimersByTime(60);

        const result = await resultPromise;
        expect(result).toEqual(fallbackData);
      });

      it('should handle non-Error thrown values', async () => {
        mockFetch.mockRejectedValueOnce('string error');

        const result = await fetchModuleData(endpoint, fallbackData, mockLogger);

        expect(result).toEqual(fallbackData);
        expect(mockLogger.warn).toHaveBeenCalled();
      });
    });
  });

  describe('fetchModuleDataBatch()', () => {
    beforeEach(() => {
      delete process.env.USE_REAL_MODULE_APIS;
    });

    it('should fetch multiple endpoints in parallel', async () => {
      const requests = [
        { endpoint: 'http://api.example.com/data1', fallbackData: { id: 1 } },
        { endpoint: 'http://api.example.com/data2', fallbackData: { id: 2 } },
        { endpoint: 'http://api.example.com/data3', fallbackData: { id: 3 } },
      ];

      const results = await fetchModuleDataBatch(requests, mockLogger);

      expect(results).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    });

    it('should return results in same order as requests', async () => {
      process.env.USE_REAL_MODULE_APIS = 'true';

      mockFetch
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ name: 'first' }) })
        .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ name: 'second' }) });

      const requests = [
        { endpoint: 'http://api.example.com/first', fallbackData: { name: 'fallback1' } },
        { endpoint: 'http://api.example.com/second', fallbackData: { name: 'fallback2' } },
      ];

      const results = await fetchModuleDataBatch(requests, mockLogger);

      expect(results[0]).toEqual({ name: 'first' });
      expect(results[1]).toEqual({ name: 'second' });
    });

    it('should handle empty requests array', async () => {
      const results = await fetchModuleDataBatch([], mockLogger);

      expect(results).toEqual([]);
    });

    it('should pass options to all requests', async () => {
      process.env.USE_REAL_MODULE_APIS = 'true';

      mockFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });

      const requests = [
        { endpoint: 'http://api.example.com/data1', fallbackData: {} },
        { endpoint: 'http://api.example.com/data2', fallbackData: {} },
      ];

      await fetchModuleDataBatch(requests, mockLogger, {
        headers: { 'X-Custom': 'value' },
      });

      expect(mockFetch).toHaveBeenCalledTimes(2);
      mockFetch.mock.calls.forEach((call) => {
        expect(call[1].headers).toMatchObject({ 'X-Custom': 'value' });
      });
    });
  });

  describe('isModuleApiAvailable()', () => {
    const endpoint = 'http://api.example.com/health';

    describe('when USE_REAL_MODULE_APIS is false', () => {
      beforeEach(() => {
        delete process.env.USE_REAL_MODULE_APIS;
      });

      it('should return false without making HTTP request', async () => {
        const result = await isModuleApiAvailable(endpoint, mockLogger);

        expect(result).toBe(false);
        expect(mockFetch).not.toHaveBeenCalled();
      });
    });

    describe('when USE_REAL_MODULE_APIS is true', () => {
      beforeEach(() => {
        process.env.USE_REAL_MODULE_APIS = 'true';
      });

      it('should return true when endpoint is reachable', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        const result = await isModuleApiAvailable(endpoint, mockLogger);

        expect(result).toBe(true);
        expect(mockFetch).toHaveBeenCalledWith(
          endpoint,
          expect.objectContaining({ method: 'HEAD' })
        );
      });

      it('should return false when endpoint returns non-ok status', async () => {
        mockFetch.mockResolvedValueOnce({ ok: false });

        const result = await isModuleApiAvailable(endpoint, mockLogger);

        expect(result).toBe(false);
      });

      it('should return false when fetch throws error', async () => {
        mockFetch.mockRejectedValueOnce(new Error('Network error'));

        const result = await isModuleApiAvailable(endpoint, mockLogger);

        expect(result).toBe(false);
      });

      it('should use default timeout of 2000ms', async () => {
        mockFetch.mockResolvedValueOnce({ ok: true });

        await isModuleApiAvailable(endpoint, mockLogger);

        // AbortController signal should be passed
        expect(mockFetch).toHaveBeenCalledWith(
          endpoint,
          expect.objectContaining({
            signal: expect.any(AbortSignal),
          })
        );
      });

      it('should use custom timeout when provided', async () => {
        mockFetch.mockImplementationOnce((_url, options) => {
          return new Promise((resolve, reject) => {
            // Listen for abort signal
            if (options?.signal) {
              options.signal.addEventListener('abort', () => {
                reject(new Error('Aborted'));
              });
            }
          });
        });

        const resultPromise = isModuleApiAvailable(endpoint, mockLogger, 50);

        // Advance timers to trigger abort
        jest.advanceTimersByTime(60);

        const result = await resultPromise;
        expect(result).toBe(false);
      });
    });
  });
});
