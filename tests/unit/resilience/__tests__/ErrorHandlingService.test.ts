
import { ErrorHandlingService, ErrorContext, ErrorClassification } from '../ErrorHandlingService';
import { Logger } from '../../utils/Logger';
import { AuditLogRepository } from '../../database/repositories/AuditLogRepository';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

const mockAuditLogRepository = {
  create: jest.fn(),
} as unknown as AuditLogRepository;

describe('ErrorHandlingService', () => {
  let service: ErrorHandlingService;
  const context: ErrorContext = { operation: 'testOp', service: 'testService' };

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ErrorHandlingService(mockLogger, mockAuditLogRepository);
  });

  describe('classifyError', () => {
    it('should classify authentication errors', () => {
      const err = new Error('invalid token');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('auth');
      expect(classification.severity).toBe('medium');
      expect(classification.retryable).toBe(false);
    });

    it('should classify validation errors', () => {
      const err = new Error('validation failed: id is required');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('validation');
      expect(classification.severity).toBe('low');
    });

    it('should classify network errors', () => {
      const err = new Error('econnreset');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('network');
      expect(classification.severity).toBe('medium');
      expect(classification.retryable).toBe(true);
    });

    it('should classify external service errors from message', () => {
      const err = new Error('salesforce api limit exceeded');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('external');
      expect(classification.severity).toBe('high');
    });

    it('should classify system errors from message', () => {
      const err = new Error('fatal internal error');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('system');
      expect(classification.severity).toBe('critical');
    });

    it('should classify user errors', () => {
      const err = new Error('item with id 123 not found');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('user');
    });

    it('should classify unknown errors', () => {
      const err = new Error('a strange and unique error');
      const classification = service.classifyError(err);
      expect(classification.category).toBe('unknown');
    });

    it('should handle non-Error objects', () => {
        const err = 'just a string error';
        const classification = service.classifyError(err);
        expect(classification.category).toBe('unknown');
        expect(classification.technicalMessage).toBe('just a string error');
      });
  });

  describe('handleError', () => {
    it('should call logger with correct level based on severity', async () => {
      const err = new Error('low severity error');
      jest.spyOn(service, 'classifyError').mockReturnValue({ category: 'user', severity: 'low' } as ErrorClassification);
      await service.handleError(err, context);
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should record an audit log for critical errors', async () => {
      const err = new Error('critical system error');
      jest.spyOn(service, 'classifyError').mockReturnValue({ category: 'system', severity: 'critical' } as ErrorClassification);
      await service.handleError(err, context);
      expect(mockAuditLogRepository.create).toHaveBeenCalledTimes(1);
    });

    it('should record an audit log for auth errors', async () => {
        const err = new Error('invalid credentials');
        jest.spyOn(service, 'classifyError').mockReturnValue({ category: 'auth', severity: 'medium' } as ErrorClassification);
        await service.handleError(err, context);
        expect(mockAuditLogRepository.create).toHaveBeenCalledTimes(1);
      });

    it('should not record an audit log for low-severity errors', async () => {
      const err = new Error('simple user error');
      jest.spyOn(service, 'classifyError').mockReturnValue({ category: 'user', severity: 'low' } as ErrorClassification);
      await service.handleError(err, context);
      expect(mockAuditLogRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('formatErrorResponse', () => {
    it('should format an error response correctly', () => {
      const classification: ErrorClassification = {
        category: 'validation',
        severity: 'low',
        retryable: false,
        userMessage: 'Invalid input.',
        technicalMessage: 'id is missing'
      };
      const response = service.formatErrorResponse(new Error(), classification, 'corr-123');

      expect(response.error.code).toMatch(/VALIDATION_LOW_/);
      expect(response.error.message).toBe('Invalid input.');
      expect(response.error.correlationId).toBe('corr-123');
    });
  });

  describe('withErrorHandling', () => {
    it('should call handleError when the wrapped function throws', async () => {
        const errorToThrow = new Error('Function failed');
        const failingFn = jest.fn().mockRejectedValue(errorToThrow);
        const handleErrorSpy = jest.spyOn(service, 'handleError');

        const wrappedFn = service.withErrorHandling(failingFn, context);

        await expect(wrappedFn()).rejects.toThrow('Function failed');
        expect(handleErrorSpy).toHaveBeenCalledWith(errorToThrow, context);
    });

    it('should return the result of the wrapped function on success', async () => {
        const succeedingFn = jest.fn().mockResolvedValue('success');
        const handleErrorSpy = jest.spyOn(service, 'handleError');

        const wrappedFn = service.withErrorHandling(succeedingFn, context);

        const result = await wrappedFn();

        expect(result).toBe('success');
        expect(handleErrorSpy).not.toHaveBeenCalled();
    });
  });
});
