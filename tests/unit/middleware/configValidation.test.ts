/**
 * ConfigValidation Middleware Unit Tests
 * Tests for configuration validation middleware
 */

import { Request, Response, NextFunction } from 'express';
import {
  validateConfigurationMiddleware,
  validateConfigurationUpdateMiddleware,
  validateConfigurationIdMiddleware,
  configurationValidationErrorHandler,
  ValidatedRequest,
} from '../../../src/middleware/configValidation';
import { ValidationError } from '../../../src/errors/ConfigurationErrors';

// Mock the schemas
jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn(),
  validateSystemAuthentication: jest.fn(),
}));

import {
  validateIntegrationConfig,
  validateSystemAuthentication,
} from '../../../src/schemas/configurationSchemas';

const mockValidateIntegrationConfig = validateIntegrationConfig as jest.Mock;
const mockValidateSystemAuthentication = validateSystemAuthentication as jest.Mock;

describe('ConfigValidation Middleware', () => {
  let mockRequest: Partial<ValidatedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let mockLogger: jest.Mocked<{ info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }>;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      body: {},
      params: {},
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
    };

    mockNext = jest.fn();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    jest.clearAllMocks();
  });

  describe('validateConfigurationMiddleware()', () => {
    it('should return 400 if configuration data is missing', () => {
      mockRequest.body = null;

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Configuration data is required',
          code: 'MISSING_CONFIG',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 400 if validation fails', () => {
      mockRequest.body = {
        id: 'test-config',
        name: 'Test Config',
      };

      mockValidateIntegrationConfig.mockReturnValue({
        isValid: false,
        errors: ['Missing required field: sourceSystem'],
        warnings: ['Deprecated option used'],
        fieldErrors: { sourceSystem: 'Required' },
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Configuration validation failed',
          code: 'VALIDATION_ERROR',
          details: expect.objectContaining({
            errors: ['Missing required field: sourceSystem'],
            warnings: ['Deprecated option used'],
          }),
        })
      );
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should return 400 if source authentication validation fails', () => {
      mockRequest.body = {
        id: 'test-config',
        sourceSystem: 'salesforce',
        sourceAuthentication: { type: 'oauth2' },
      };

      mockValidateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      mockValidateSystemAuthentication.mockReturnValue({
        isValid: false,
        errors: ['Missing client_id', 'Missing client_secret'],
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Authentication configuration validation failed',
          code: 'AUTH_VALIDATION_ERROR',
          details: expect.objectContaining({
            errors: expect.arrayContaining([
              'Source: Missing client_id',
              'Source: Missing client_secret',
            ]),
          }),
        })
      );
    });

    it('should return 400 if target authentication validation fails', () => {
      mockRequest.body = {
        id: 'test-config',
        targetSystem: 'netsuite',
        targetAuthentication: { type: 'oauth1' },
      };

      mockValidateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      mockValidateSystemAuthentication.mockReturnValue({
        isValid: false,
        errors: ['Missing consumer_key'],
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'AUTH_VALIDATION_ERROR',
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Target: Missing consumer_key']),
          }),
        })
      );
    });

    it('should pass validation with warnings', () => {
      mockRequest.body = {
        id: 'test-config',
        name: 'Test Config',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
      };

      mockValidateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: ['Consider enabling retry mechanism'],
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Configuration validation completed with warnings',
        expect.objectContaining({
          warnings: ['Consider enabling retry mechanism'],
        })
      );
      expect((mockRequest as ValidatedRequest).validatedConfig).toEqual(mockRequest.body);
    });

    it('should pass validation successfully', () => {
      mockRequest.body = {
        id: 'test-config',
        name: 'Test Config',
        sourceSystem: 'salesforce',
        targetSystem: 'netsuite',
      };

      mockValidateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration validation successful',
        expect.objectContaining({
          configId: 'test-config',
          sourceSystem: 'salesforce',
          targetSystem: 'netsuite',
        })
      );
      expect((mockRequest as ValidatedRequest).validatedConfig).toEqual(mockRequest.body);
      expect((mockRequest as ValidatedRequest).validationResult).toBeDefined();
    });

    it('should handle errors gracefully', () => {
      mockRequest.body = { id: 'test' };

      mockValidateIntegrationConfig.mockImplementation(() => {
        throw new Error('Unexpected schema error');
      });

      const middleware = validateConfigurationMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Internal validation error',
          code: 'VALIDATION_INTERNAL_ERROR',
        })
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe('validateConfigurationUpdateMiddleware()', () => {
    it('should return 400 if update data is missing', () => {
      mockRequest.body = null;

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Update data is required',
          code: 'MISSING_UPDATES',
        })
      );
    });

    it('should return 400 if update data is empty', () => {
      mockRequest.body = {};

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'MISSING_UPDATES',
        })
      );
    });

    it('should validate invalid configuration ID format', () => {
      mockRequest.body = {
        id: 'invalid@id!',
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'UPDATE_VALIDATION_ERROR',
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Invalid configuration ID format']),
          }),
        })
      );
    });

    it('should validate empty configuration name', () => {
      mockRequest.body = {
        name: '',
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Configuration name cannot be empty']),
          }),
        })
      );
    });

    it('should validate configuration name exceeding max length', () => {
      mockRequest.body = {
        name: 'a'.repeat(201),
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Configuration name cannot exceed 200 characters']),
          }),
        })
      );
    });

    it('should validate invalid sync direction', () => {
      mockRequest.body = {
        syncDirection: 'invalid',
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Invalid sync direction']),
          }),
        })
      );
    });

    it('should accept valid sync directions', () => {
      const validDirections = ['unidirectional', 'bidirectional', 'source_to_target', 'target_to_source'];

      validDirections.forEach(direction => {
        mockRequest.body = { syncDirection: direction };
        mockNext.mockClear();

        const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
        middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });

    it('should validate invalid sync mode', () => {
      mockRequest.body = {
        syncMode: 'invalid',
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Invalid sync mode']),
          }),
        })
      );
    });

    it('should accept valid sync modes', () => {
      const validModes = ['realtime', 'batch', 'manual'];

      validModes.forEach(mode => {
        mockRequest.body = { syncMode: mode };
        mockNext.mockClear();

        const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
        middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });

    it('should validate batch size out of range (too small)', () => {
      mockRequest.body = {
        batchSize: 0,
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Batch size must be between 1 and 10,000']),
          }),
        })
      );
    });

    it('should validate batch size out of range (too large)', () => {
      mockRequest.body = {
        batchSize: 10001,
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Batch size must be between 1 and 10,000']),
          }),
        })
      );
    });

    it('should accept valid batch size', () => {
      mockRequest.body = {
        batchSize: 500,
      };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should validate source authentication updates', () => {
      mockRequest.body = {
        sourceSystem: 'salesforce',
        sourceAuthentication: { type: 'oauth2' },
      };

      mockValidateSystemAuthentication.mockReturnValue({
        isValid: false,
        errors: ['Missing credentials'],
      });

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Source authentication: Missing credentials']),
          }),
        })
      );
    });

    it('should validate target authentication updates', () => {
      mockRequest.body = {
        targetSystem: 'netsuite',
        targetAuthentication: { type: 'oauth1' },
      };

      mockValidateSystemAuthentication.mockReturnValue({
        isValid: false,
        errors: ['Invalid credentials format'],
      });

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: expect.objectContaining({
            errors: expect.arrayContaining(['Target authentication: Invalid credentials format']),
          }),
        })
      );
    });

    it('should pass valid updates', () => {
      mockRequest.body = {
        name: 'Updated Config',
        syncMode: 'batch',
        batchSize: 100,
      };
      mockRequest.params = { id: 'config-123' };

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Configuration update validation successful',
        expect.objectContaining({
          updatedFields: ['name', 'syncMode', 'batchSize'],
          configId: 'config-123',
        })
      );
      expect((mockRequest as ValidatedRequest).validatedConfig).toEqual(mockRequest.body);
    });

    it('should handle errors gracefully', () => {
      mockRequest.body = { name: 'Test' };

      // Force an error by making Object.keys throw
      const originalKeys = Object.keys;
      Object.keys = jest.fn().mockImplementation((obj) => {
        if (obj === mockRequest.body) {
          throw new Error('Unexpected error');
        }
        return originalKeys(obj);
      });

      const middleware = validateConfigurationUpdateMiddleware(mockLogger as any);
      middleware(mockRequest as ValidatedRequest, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(mockLogger.error).toHaveBeenCalled();

      // Restore
      Object.keys = originalKeys;
    });
  });

  describe('validateConfigurationIdMiddleware()', () => {
    it('should return 400 if configuration ID is missing', () => {
      mockRequest.params = {};

      const middleware = validateConfigurationIdMiddleware(mockLogger as any);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Configuration ID is required',
          code: 'MISSING_CONFIG_ID',
        })
      );
    });

    it('should return 400 if configuration ID format is invalid', () => {
      mockRequest.params = { id: 'invalid@id!' };

      const middleware = validateConfigurationIdMiddleware(mockLogger as any);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Invalid configuration ID format',
          code: 'INVALID_CONFIG_ID',
        })
      );
    });

    it('should accept valid configuration IDs', () => {
      const validIds = [
        'config-123',
        'config_456',
        'CONFIG123',
        'abc-def_ghi',
        '12345',
      ];

      validIds.forEach(id => {
        mockRequest.params = { id };
        mockNext.mockClear();

        const middleware = validateConfigurationIdMiddleware(mockLogger as any);
        middleware(mockRequest as Request, mockResponse as Response, mockNext);

        expect(mockNext).toHaveBeenCalled();
      });
    });

    it('should reject configuration IDs with special characters', () => {
      const invalidIds = [
        'config.id',
        'config/id',
        'config:id',
        'config id',
        'config@id',
        'config#id',
      ];

      invalidIds.forEach(id => {
        mockRequest.params = { id };
        statusMock.mockClear();
        jsonMock.mockClear();

        const middleware = validateConfigurationIdMiddleware(mockLogger as any);
        middleware(mockRequest as Request, mockResponse as Response, mockNext);

        expect(statusMock).toHaveBeenCalledWith(400);
      });
    });
  });

  describe('configurationValidationErrorHandler()', () => {
    it('should handle ValidationError', () => {
      const error = new ValidationError('Field validation failed');

      configurationValidationErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Field validation failed',
          code: 'CONFIGURATION_VALIDATION_ERROR',
        })
      );
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should handle ValidationError with details', () => {
      const error = new ValidationError('Validation failed') as ValidationError & { details: string[] };
      error.details = ['Error 1', 'Error 2'];

      configurationValidationErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          details: ['Error 1', 'Error 2'],
        })
      );
    });

    it('should pass non-ValidationError to next handler', () => {
      const error = new Error('Some other error');

      configurationValidationErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(error);
      expect(statusMock).not.toHaveBeenCalled();
    });

    it('should pass TypeError to next handler', () => {
      const error = new TypeError('Type mismatch');

      configurationValidationErrorHandler(
        error,
        mockRequest as Request,
        mockResponse as Response,
        mockNext
      );

      expect(mockNext).toHaveBeenCalledWith(error);
    });
  });
});
