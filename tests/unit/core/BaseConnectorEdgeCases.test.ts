/**
 * BaseConnector Edge Cases and Error Handling Tests
 * Targets uncovered branches in BaseConnector.ts (lines 92-106, 153-183, 196-508)
 * Goal: Increase BaseConnector coverage from 42% to 70%+
 */

// This test uses real timers because it tests retry logic and circuit breakers
jest.useRealTimers();

import { BaseConnector } from '../../../src/core/BaseConnector';
import { DataRecord, AuthConfig } from '../../../src/types';
import { Logger } from '../../../src/utils/Logger';
import { AxiosError } from 'axios';

// Concrete implementation for testing
class TestableConnector extends BaseConnector {
  constructor(logger: Logger) {
    super('TEST', 'test-connector', logger);
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
  public testSanitizeString(input: string): string {
    return this['sanitizeString'](input);
  }

  public testSanitizeObject(obj: unknown): unknown {
    return this['sanitizeObject'](obj);
  }

  public testHandleApiError(error: unknown): Error {
    return this['handleApiError'](error);
  }

  public testValidateDataRecord(data: DataRecord): void {
    return this['validateDataRecord'](data);
  }

  public testValidateEntityType(entityType: string): void {
    return this['validateEntityType'](entityType);
  }

  public testValidateId(id: string): void {
    return this['validateId'](id);
  }

  public async testRetry<T>(
    operation: () => Promise<T>,
    maxAttempts?: number,
    baseDelay?: number,
    exponentialBackoff?: boolean
  ): Promise<T> {
    return this['retry'](operation, maxAttempts, baseDelay, exponentialBackoff);
  }
}

describe('BaseConnector - Edge Cases and Error Handling', () => {
  let connector: TestableConnector;
  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as Logger;

  beforeEach(() => {
    connector = new TestableConnector(mockLogger);
    jest.clearAllMocks();
  });

  describe('String Sanitization', () => {
    it('should sanitize HTML entities in strings', () => {
      const input = '<script>alert("XSS")</script>';
      const result = connector.testSanitizeString(input);
      expect(result).not.toContain('<script>');
      expect(result).toContain('&lt;');
      expect(result).toContain('&gt;');
    });

    it('should remove control characters from strings', () => {
      const input = 'Hello\u0000World\u001F\u007F\u009F';
      const result = connector.testSanitizeString(input);
      expect(result).toBe('HelloWorld');
    });

    it('should handle quotes and ampersands', () => {
      const input = 'Bob & Alice said "Hello"';
      const result = connector.testSanitizeString(input);
      expect(result).toContain('&amp;');
      expect(result).toContain('&quot;');
    });

    it('should trim whitespace', () => {
      const input = '   spaces   ';
      const result = connector.testSanitizeString(input);
      expect(result).toBe('spaces');
    });

    it('should truncate strings exceeding max length', () => {
      const input = 'a'.repeat(100000); // Very long string
      const result = connector.testSanitizeString(input);
      expect(result.length).toBeLessThanOrEqual(10000);
    });
  });

  describe('Object Sanitization', () => {
    it('should sanitize nested objects', () => {
      const input = {
        name: '<script>Bad</script>',
        nested: {
          value: 'Test & Value',
        },
      };
      const result = connector.testSanitizeObject(input);
      expect((result as any).name).toContain('&lt;');
      expect((result as any).nested.value).toContain('&amp;');
    });

    it('should sanitize arrays', () => {
      const input = ['<bad>', 'good', 'Test & Co'];
      const result = connector.testSanitizeObject(input);
      expect(result).toHaveLength(3);
      expect((result as any)[0]).toContain('&lt;');
      expect((result as any)[2]).toContain('&amp;');
    });

    it('should handle null and undefined', () => {
      expect(connector.testSanitizeObject(null)).toBeNull();
      expect(connector.testSanitizeObject(undefined)).toBeUndefined();
    });

    it('should handle numbers and booleans', () => {
      expect(connector.testSanitizeObject(42)).toBe(42);
      expect(connector.testSanitizeObject(true)).toBe(true);
    });

    it('should sanitize object keys', () => {
      const input = {
        '<bad>key': 'value',
      };
      const result = connector.testSanitizeObject(input) as Record<string, unknown>;
      const keys = Object.keys(result);
      expect(keys[0]).toContain('&lt;');
    });
  });

  describe('API Error Handling', () => {
    it('should handle 401 Unauthorized errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 401,
          statusText: 'Unauthorized',
          data: { message: 'Invalid credentials' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Authentication failed');
    });

    it('should handle 403 Forbidden errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: { message: 'Access denied' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Access forbidden');
    });

    it('should handle 404 Not Found errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 404,
          statusText: 'Not Found',
          data: { message: 'Resource not found' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Resource not found');
    });

    it('should handle 400 Bad Request errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 400,
          statusText: 'Bad Request',
          data: { message: 'Invalid input' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Bad request');
    });

    it('should handle 503 Service Unavailable errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 503,
          statusText: 'Service Unavailable',
          data: { message: 'Service down' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Service unavailable');
    });

    it('should handle 5xx server errors', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
          data: { message: 'Server error' },
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result.message).toContain('Server error');
    });

    it('should handle errors without response data', () => {
      const axiosError = {
        isAxiosError: true,
        response: {
          status: 500,
          statusText: 'Internal Server Error',
        },
      } as any as AxiosError;

      const result = connector.testHandleApiError(axiosError);
      expect(result).toBeDefined();
    });

    it('should handle non-Axios errors', () => {
      const genericError = new Error('Network failure');
      const result = connector.testHandleApiError(genericError);
      expect(result.message).toContain('Network failure');
    });
  });

  describe('Data Validation', () => {
    it('should validate data records with all required fields', () => {
      const validRecord: DataRecord = {
        id: 'test-123',
        externalId: 'ext-123',
        fields: { name: 'Test' },
        metadata: {
          source: 'test',
          lastModified: new Date(),
          version: '1.0',
        },
      };

      expect(() => connector.testValidateDataRecord(validRecord)).not.toThrow();
    });

    it('should throw when data record is not an object', () => {
      expect(() => connector.testValidateDataRecord(null as any)).toThrow('must be an object');
      expect(() => connector.testValidateDataRecord('string' as any)).toThrow('must be an object');
    });

    it('should throw when id is not a string', () => {
      const invalidRecord = {
        id: 123, // number instead of string
        externalId: 'ext-123',
        fields: {},
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      } as any;

      expect(() => connector.testValidateDataRecord(invalidRecord)).toThrow('id must be a string');
    });

    it('should throw when externalId is not a string', () => {
      const invalidRecord = {
        id: 'test-123',
        externalId: 456, // number instead of string
        fields: {},
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      } as any;

      expect(() => connector.testValidateDataRecord(invalidRecord)).toThrow('externalId must be a string');
    });

    it('should validate entity type is non-empty', () => {
      expect(() => connector.testValidateEntityType('')).toThrow('non-empty string');
    });

    it('should validate entity type is a string', () => {
      expect(() => connector.testValidateEntityType(null as any)).toThrow('non-empty string');
      expect(() => connector.testValidateEntityType(undefined as any)).toThrow('non-empty string');
    });

    it('should validate id is non-empty', () => {
      expect(() => connector.testValidateId('')).toThrow('non-empty string');
    });

    it('should validate id is a string', () => {
      expect(() => connector.testValidateId(null as any)).toThrow('non-empty string');
      expect(() => connector.testValidateId(123 as any)).toThrow('non-empty string');
    });
  });

  describe('Retry Logic', () => {
    it('should retry failed operations with exponential backoff', async () => {
      let attemptCount = 0;
      const operation = jest.fn(async () => {
        attemptCount++;
        if (attemptCount < 3) {
          throw new Error('Temporary failure');
        }
        return 'success';
      });

      const result = await connector.testRetry(operation, 3, 100, true);
      expect(result).toBe('success');
      expect(attemptCount).toBe(3);
    });

    it('should throw after max attempts', async () => {
      const operation = jest.fn(async () => {
        throw new Error('Persistent failure');
      });

      await expect(connector.testRetry(operation, 2, 50, true)).rejects.toThrow('Persistent failure');
      expect(operation).toHaveBeenCalledTimes(2);
    });

    it('should use fixed delay when exponential backoff is disabled', async () => {
      let attemptCount = 0;
      const operation = jest.fn(async () => {
        attemptCount++;
        if (attemptCount < 2) {
          throw new Error('Temporary failure');
        }
        return 'success';
      });

      const startTime = Date.now();
      await connector.testRetry(operation, 3, 50, false);
      const duration = Date.now() - startTime;

      // With fixed delay, should be around 50ms for one retry
      expect(duration).toBeGreaterThanOrEqual(40);
      expect(duration).toBeLessThan(200);
    });
  });
});
