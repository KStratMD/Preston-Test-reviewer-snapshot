/**
 * ErrorHandlingService Unit Tests
 * Tests for centralized error handling, classification, and logging
 */

import 'reflect-metadata';
import { ErrorHandlingService, ErrorContext, ErrorClassification } from '../../../src/resilience/ErrorHandlingService';
import { Logger } from '../../../src/utils/Logger';
import { AuditLogRepository } from '../../../src/database/repositories/AuditLogRepository';

describe('ErrorHandlingService', () => {
  let errorHandlingService: ErrorHandlingService;
  let mockLogger: jest.Mocked<Logger>;
  let mockAuditLogRepository: jest.Mocked<AuditLogRepository>;

  beforeEach(() => {
    mockLogger = {
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as any;

    mockAuditLogRepository = {
      create: jest.fn().mockResolvedValue({ id: 1 }),
    } as any;

    errorHandlingService = new ErrorHandlingService(mockLogger, mockAuditLogRepository);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('classifyError()', () => {
    describe('auth errors', () => {
      it('should classify unauthorized errors', () => {
        const error = new Error('Unauthorized access denied');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
        expect(classification.severity).toBe('medium');
        expect(classification.retryable).toBe(false);
      });

      it('should classify forbidden errors', () => {
        const error = new Error('Forbidden resource');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
        expect(classification.retryable).toBe(false);
      });

      it('should classify authentication errors', () => {
        const error = new Error('Authentication failed');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
      });

      it('should classify token errors', () => {
        const error = new Error('Token expired');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
      });

      it('should classify credential errors', () => {
        const error = new Error('Invalid credential');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
      });

      it('should classify permission errors', () => {
        const error = new Error('Permission denied');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
      });

      it('should classify invalid key errors', () => {
        const error = new Error('Invalid key provided');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('auth');
      });
    });

    describe('validation errors', () => {
      it('should classify validation errors', () => {
        const error = new Error('Validation failed');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
        expect(classification.severity).toBe('low');
        expect(classification.retryable).toBe(false);
      });

      it('should classify invalid input errors', () => {
        const error = new Error('Invalid input format');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
      });

      it('should classify required field errors', () => {
        const error = new Error('Required field missing');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
      });

      it('should classify schema errors', () => {
        const error = new Error('Schema validation error');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
      });

      it('should classify bad request errors', () => {
        const error = new Error('Bad request received');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
      });

      it('should classify malformed errors', () => {
        const error = new Error('Malformed JSON');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('validation');
      });
    });

    describe('network errors', () => {
      it('should classify network errors', () => {
        const error = new Error('Network error occurred');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
        expect(classification.severity).toBe('medium');
        expect(classification.retryable).toBe(true);
      });

      it('should classify connection errors', () => {
        const error = new Error('Connection refused');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
        expect(classification.retryable).toBe(true);
      });

      it('should classify timeout errors', () => {
        const error = new Error('Request timeout');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
      });

      it('should classify DNS errors', () => {
        const error = new Error('DNS lookup failed');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
      });

      it('should classify ECONNREFUSED errors', () => {
        const error = new Error('ECONNREFUSED');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
      });

      it('should classify ETIMEDOUT errors', () => {
        const error = new Error('ETIMEDOUT');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('network');
      });
    });

    describe('external service errors', () => {
      it('should classify Salesforce errors', () => {
        const error = new Error('Salesforce API error');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('external');
        expect(classification.severity).toBe('high');
        expect(classification.retryable).toBe(true);
      });

      it('should classify NetSuite errors', () => {
        const error = new Error('NetSuite API error occurred');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('external');
      });

      it('should classify rate limit errors', () => {
        const error = new Error('Rate limit exceeded');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('external');
      });

      it('should classify service unavailable errors', () => {
        const error = new Error('Service unavailable');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('external');
      });

      it('should classify quota exceeded errors', () => {
        const error = new Error('API quota exceeded');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('external');
      });
    });

    describe('system errors', () => {
      it('should classify out of memory errors', () => {
        const error = new Error('Out of memory');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('system');
        expect(classification.severity).toBe('critical');
        expect(classification.retryable).toBe(false);
      });

      it('should classify database errors', () => {
        const error = new Error('Database query failed');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('system');
      });

      it('should classify fatal errors', () => {
        const error = new Error('Fatal error occurred');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('system');
      });

      it('should classify internal errors', () => {
        const error = new Error('Internal error');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('system');
      });
    });

    describe('user errors', () => {
      it('should classify not found errors', () => {
        const error = new Error('Resource not found');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('user');
        expect(classification.severity).toBe('low');
        expect(classification.retryable).toBe(false);
      });

      it('should classify does not exist errors', () => {
        const error = new Error('Entity does not exist');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('user');
      });

      it('should classify already exists errors', () => {
        const error = new Error('Resource already exists');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('user');
      });

      it('should classify duplicate errors', () => {
        const error = new Error('Duplicate entry');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('user');
      });

      it('should classify conflict errors', () => {
        const error = new Error('Conflict detected');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('user');
      });
    });

    describe('unknown errors', () => {
      it('should classify unknown errors with default classification', () => {
        const error = new Error('Something unexpected happened');
        const classification = errorHandlingService.classifyError(error);

        expect(classification.category).toBe('unknown');
        expect(classification.severity).toBe('medium');
        expect(classification.retryable).toBe(false);
      });

      it('should handle non-Error values', () => {
        const classification = errorHandlingService.classifyError('string error');

        expect(classification.category).toBe('unknown');
        expect(classification.technicalMessage).toBe('string error');
      });

      it('should handle null', () => {
        const classification = errorHandlingService.classifyError(null);

        expect(classification.category).toBe('unknown');
        expect(classification.technicalMessage).toBe('null');
      });

      it('should handle undefined', () => {
        const classification = errorHandlingService.classifyError(undefined);

        expect(classification.category).toBe('unknown');
        expect(classification.technicalMessage).toBe('undefined');
      });
    });
  });

  describe('handleError()', () => {
    const testContext: ErrorContext = {
      operation: 'test-operation',
      service: 'test-service',
      userId: 'user-123',
      tenantId: 'tenant-456',
      correlationId: 'corr-789',
    };

    it('should classify and return error classification', async () => {
      const error = new Error('Network timeout');

      const classification = await errorHandlingService.handleError(error, testContext);

      expect(classification.category).toBe('network');
      expect(classification.retryable).toBe(true);
    });

    it('should log the error', async () => {
      const error = new Error('Test error');

      await errorHandlingService.handleError(error, testContext);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          context: testContext,
        })
      );
    });

    it('should record audit log for auth errors', async () => {
      const error = new Error('Unauthorized');

      await errorHandlingService.handleError(error, testContext);

      expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'user-123',
          tenant_id: 'tenant-456',
          action: 'error_occurred',
          resource_type: 'error',
        })
      );
    });

    it('should record audit log for critical errors', async () => {
      const error = new Error('Out of memory');

      await errorHandlingService.handleError(error, testContext);

      expect(mockAuditLogRepository.create).toHaveBeenCalled();
    });

    it('should not record audit log for non-critical, non-auth errors', async () => {
      const error = new Error('Validation failed');

      await errorHandlingService.handleError(error, testContext);

      expect(mockAuditLogRepository.create).not.toHaveBeenCalled();
    });

    it('should handle audit log creation failure gracefully', async () => {
      mockAuditLogRepository.create.mockRejectedValueOnce(new Error('DB error'));
      const error = new Error('Unauthorized');

      // Should not throw
      const classification = await errorHandlingService.handleError(error, testContext);

      expect(classification.category).toBe('auth');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'ErrorHandlingService failed to record audit log for error',
        expect.any(Object)
      );
    });

    it('should use default values for missing context fields', async () => {
      const error = new Error('Unauthorized');
      const minimalContext: ErrorContext = {
        operation: 'test',
        service: 'test-service',
      };

      await errorHandlingService.handleError(error, minimalContext);

      expect(mockAuditLogRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          user_id: 'system',
          tenant_id: '__system__',
          resource_id: 'unknown',
        })
      );
    });
  });

  describe('formatErrorResponse()', () => {
    it('should format error response', () => {
      const error = new Error('Test error');
      const classification: ErrorClassification = {
        category: 'validation',
        severity: 'low',
        retryable: false,
        userMessage: 'Invalid input',
        technicalMessage: 'Test error',
      };

      const response = errorHandlingService.formatErrorResponse(error, classification, 'corr-123');

      expect(response.error.code).toMatch(/^VALIDATION_LOW_\d+$/);
      expect(response.error.message).toBe('Invalid input');
      expect(response.error.correlationId).toBe('corr-123');
      expect(response.error.timestamp).toBeDefined();
    });

    it('should include error details', () => {
      const error = new Error('Test error');
      error.name = 'TestError';
      const classification: ErrorClassification = {
        category: 'user',
        severity: 'low',
        retryable: false,
        userMessage: 'User message',
        technicalMessage: 'Tech message',
      };

      const response = errorHandlingService.formatErrorResponse(error, classification);

      expect(response.error.details).toEqual({
        category: 'user',
        severity: 'low',
        retryable: false,
        type: 'TestError',
      });
    });

    it('should include stack trace for system errors', () => {
      const error = new Error('System error');
      const classification: ErrorClassification = {
        category: 'system',
        severity: 'critical',
        retryable: false,
        userMessage: 'System error occurred',
        technicalMessage: 'System error',
      };

      const response = errorHandlingService.formatErrorResponse(error, classification);

      expect(response.error.details?.stack).toBeDefined();
    });

    it('should not include stack trace for non-system errors', () => {
      const error = new Error('User error');
      const classification: ErrorClassification = {
        category: 'user',
        severity: 'low',
        retryable: false,
        userMessage: 'User message',
        technicalMessage: 'User error',
      };

      const response = errorHandlingService.formatErrorResponse(error, classification);

      expect(response.error.details?.stack).toBeUndefined();
    });

    it('should handle non-Error values', () => {
      const classification: ErrorClassification = {
        category: 'unknown',
        severity: 'medium',
        retryable: false,
        userMessage: 'Unknown error',
        technicalMessage: 'string error',
      };

      const response = errorHandlingService.formatErrorResponse('string error', classification);

      expect(response.error.details?.type).toBeUndefined();
    });
  });

  describe('createContext()', () => {
    it('should create context with operation and service', () => {
      const context = ErrorHandlingService.createContext('operation', 'service');

      expect(context.operation).toBe('operation');
      expect(context.service).toBe('service');
    });

    it('should create context with all optional fields', () => {
      const context = ErrorHandlingService.createContext('op', 'svc', {
        userId: 'user1',
        tenantId: 'tenant1',
        correlationId: 'corr1',
        metadata: { key: 'value' },
      });

      expect(context.userId).toBe('user1');
      expect(context.tenantId).toBe('tenant1');
      expect(context.correlationId).toBe('corr1');
      expect(context.metadata).toEqual({ key: 'value' });
    });

    it('should handle undefined options', () => {
      const context = ErrorHandlingService.createContext('op', 'svc');

      expect(context.userId).toBeUndefined();
      expect(context.tenantId).toBeUndefined();
      expect(context.correlationId).toBeUndefined();
      expect(context.metadata).toBeUndefined();
    });
  });

  describe('withErrorHandling()', () => {
    const testContext: ErrorContext = {
      operation: 'test',
      service: 'test',
    };

    it('should return result for successful operations', async () => {
      const fn = jest.fn().mockResolvedValue('success');

      const wrapped = errorHandlingService.withErrorHandling(fn, testContext);
      const result = await wrapped();

      expect(result).toBe('success');
    });

    it('should pass arguments to wrapped function', async () => {
      const fn = jest.fn().mockResolvedValue('result');

      const wrapped = errorHandlingService.withErrorHandling(fn, testContext);
      await wrapped('arg1', 'arg2');

      expect(fn).toHaveBeenCalledWith('arg1', 'arg2');
    });

    it('should handle errors and rethrow', async () => {
      const error = new Error('Test error');
      const fn = jest.fn().mockRejectedValue(error);

      const wrapped = errorHandlingService.withErrorHandling(fn, testContext);

      await expect(wrapped()).rejects.toThrow('Test error');
    });

    it('should log errors before rethrowing', async () => {
      const error = new Error('Test error');
      const fn = jest.fn().mockRejectedValue(error);

      const wrapped = errorHandlingService.withErrorHandling(fn, testContext);

      try {
        await wrapped();
      } catch {
        // Expected
      }

      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  describe('logging levels', () => {
    const context: ErrorContext = {
      operation: 'test',
      service: 'test',
    };

    it('should log critical errors with error level', async () => {
      const error = new Error('Fatal system error');

      await errorHandlingService.handleError(error, context);

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log high severity errors with error level', async () => {
      const error = new Error('Salesforce API down');

      await errorHandlingService.handleError(error, context);

      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should log medium severity errors with warn level', async () => {
      const error = new Error('Network timeout');

      await errorHandlingService.handleError(error, context);

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should log low severity errors with info level', async () => {
      const error = new Error('Validation failed');

      await errorHandlingService.handleError(error, context);

      expect(mockLogger.info).toHaveBeenCalled();
    });
  });

  describe('error code generation', () => {
    it('should generate unique error codes', () => {
      const error = new Error('Test');
      const classification: ErrorClassification = {
        category: 'validation',
        severity: 'low',
        retryable: false,
        userMessage: 'User msg',
        technicalMessage: 'Tech msg',
      };

      const response1 = errorHandlingService.formatErrorResponse(error, classification);
      const response2 = errorHandlingService.formatErrorResponse(error, classification);

      // Codes should have same prefix but potentially different timestamps
      expect(response1.error.code).toMatch(/^VALIDATION_LOW_/);
      expect(response2.error.code).toMatch(/^VALIDATION_LOW_/);
    });

    it('should include category and severity in error code', () => {
      const error = new Error('Auth error');
      const classification: ErrorClassification = {
        category: 'auth',
        severity: 'medium',
        retryable: false,
        userMessage: 'Auth failed',
        technicalMessage: 'Auth error',
      };

      const response = errorHandlingService.formatErrorResponse(error, classification);

      expect(response.error.code).toContain('AUTH');
      expect(response.error.code).toContain('MEDIUM');
    });
  });
});
