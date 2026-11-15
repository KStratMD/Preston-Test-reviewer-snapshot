/**
 * Validation Middleware Unit Tests
 * Tests for request validation middleware
 */

import { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import {
  ValidationSchemas,
  validate,
  validateBody,
  validateQuery,
  validateParams,
  validateFileUpload,
  sanitizeInput,
  validateContentType,
  validationMiddleware,
  validateRequest,
} from '../../../src/middleware/validation';

// Mock Logger
jest.mock('../../../src/utils/Logger', () => ({
  Logger: jest.fn().mockImplementation(() => ({
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  })),
}));

// Mock env
jest.mock('../../../src/config', () => ({
  env: {
    RATE_LIMIT_WINDOW_MS: 60000,
    RATE_LIMIT_MAX_REQUESTS: 100,
  },
}));

describe('Validation Middleware', () => {
  let mockRequest: Partial<Request & { files?: any }>;
  let mockResponse: Partial<Response>;
  let mockNext: jest.Mock;
  let jsonMock: jest.Mock;
  let statusMock: jest.Mock;

  beforeEach(() => {
    jsonMock = jest.fn().mockReturnThis();
    statusMock = jest.fn().mockReturnValue({ json: jsonMock });

    mockRequest = {
      body: {},
      query: {},
      params: {},
      header: jest.fn(),
    };

    mockResponse = {
      status: statusMock,
      json: jsonMock,
    };

    mockNext = jest.fn();
    jest.clearAllMocks();
  });

  describe('ValidationSchemas', () => {
    it('should have integrationConfig schema', () => {
      expect(ValidationSchemas.integrationConfig).toBeDefined();
    });

    it('should have partialIntegrationConfig schema', () => {
      expect(ValidationSchemas.partialIntegrationConfig).toBeDefined();
    });

    it('should have integrationRun schema', () => {
      expect(ValidationSchemas.integrationRun).toBeDefined();
    });

    it('should have dataRecord schema', () => {
      expect(ValidationSchemas.dataRecord).toBeDefined();
    });

    it('should have bulkOperation schema', () => {
      expect(ValidationSchemas.bulkOperation).toBeDefined();
    });

    it('should have queryParams schema', () => {
      expect(ValidationSchemas.queryParams).toBeDefined();
    });

    it('should have authRequest schema', () => {
      expect(ValidationSchemas.authRequest).toBeDefined();
    });

    it('should have apiKeyRequest schema', () => {
      expect(ValidationSchemas.apiKeyRequest).toBeDefined();
    });
  });

  describe('validate()', () => {
    const testSchema = z.object({
      body: z.object({
        name: z.string(),
      }),
      query: z.object({}).optional(),
      params: z.object({}).optional(),
    });

    it('should call next on valid input', () => {
      mockRequest.body = { name: 'test' };

      const middleware = validate(testSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
      expect(mockNext).not.toHaveBeenCalledWith(expect.any(Error));
    });

    it('should call next with ValidationAppError on invalid input', () => {
      mockRequest.body = { name: 123 }; // Invalid - should be string

      const middleware = validate(testSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid input',
        })
      );
    });

    it('should assign parsed values back to request', () => {
      mockRequest.body = { name: 'test' };
      mockRequest.query = {};
      mockRequest.params = {};

      const middleware = validate(testSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body).toEqual({ name: 'test' });
    });
  });

  describe('validateBody()', () => {
    const bodySchema = z.object({
      email: z.string().email(),
      age: z.number().positive(),
    });

    it('should pass valid body', () => {
      mockRequest.body = { email: 'test@example.com', age: 25 };

      const middleware = validateBody(bodySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 400 for invalid email', () => {
      mockRequest.body = { email: 'invalid', age: 25 };

      const middleware = validateBody(bodySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid request body',
        })
      );
    });

    it('should return 400 for negative age', () => {
      mockRequest.body = { email: 'test@example.com', age: -5 };

      const middleware = validateBody(bodySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
    });

    it('should update request body with parsed data', () => {
      mockRequest.body = { email: 'test@example.com', age: 25 };

      const middleware = validateBody(bodySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body).toEqual({ email: 'test@example.com', age: 25 });
    });
  });

  describe('validateQuery()', () => {
    const querySchema = z.object({
      page: z.coerce.number().min(1),
      limit: z.coerce.number().max(100),
    });

    it('should pass valid query', () => {
      mockRequest.query = { page: '1', limit: '10' };

      const middleware = validateQuery(querySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 400 for invalid page', () => {
      mockRequest.query = { page: '0', limit: '10' };

      const middleware = validateQuery(querySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid request query',
        })
      );
    });

    it('should coerce string to number', () => {
      mockRequest.query = { page: '5', limit: '20' };

      const middleware = validateQuery(querySchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.query).toEqual({ page: 5, limit: 20 });
    });
  });

  describe('validateParams()', () => {
    const paramsSchema = z.object({
      id: z.string().uuid(),
    });

    it('should pass valid params', () => {
      mockRequest.params = { id: '123e4567-e89b-12d3-a456-426614174000' };

      const middleware = validateParams(paramsSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 400 for invalid UUID', () => {
      mockRequest.params = { id: 'not-a-uuid' };

      const middleware = validateParams(paramsSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Invalid request params',
        })
      );
    });
  });

  describe('validateFileUpload()', () => {
    const allowedTypes = ['image/jpeg', 'image/png'];
    const maxSize = 5 * 1024 * 1024; // 5MB

    it('should return 400 if no files uploaded', () => {
      mockRequest.files = undefined;

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith({
        error: 'No files were uploaded.',
      });
    });

    it('should return 400 if files object is empty', () => {
      mockRequest.files = {};

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
    });

    it('should pass valid file upload', () => {
      mockRequest.files = {
        file: { mimetype: 'image/jpeg', size: 1024 * 1024 },
      };

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 400 for invalid file type', () => {
      mockRequest.files = {
        file: { mimetype: 'application/pdf', size: 1024 },
      };

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Invalid file type'),
        })
      );
    });

    it('should return 400 for file exceeding size limit', () => {
      mockRequest.files = {
        file: { mimetype: 'image/jpeg', size: 10 * 1024 * 1024 },
      };

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('File size exceeds'),
        })
      );
    });

    it('should handle array of files', () => {
      mockRequest.files = {
        files: [{ mimetype: 'image/png', size: 1024 }],
      };

      const middleware = validateFileUpload(allowedTypes, maxSize);
      middleware(mockRequest as any, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('sanitizeInput()', () => {
    it('should trim string values in body', () => {
      mockRequest.body = {
        name: '  John Doe  ',
        email: ' test@example.com ',
      };

      sanitizeInput(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.name).toBe('John Doe');
      expect(mockRequest.body.email).toBe('test@example.com');
      expect(mockNext).toHaveBeenCalled();
    });

    it('should not modify non-string values', () => {
      mockRequest.body = {
        name: 'John',
        age: 30,
        active: true,
      };

      sanitizeInput(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockRequest.body.age).toBe(30);
      expect(mockRequest.body.active).toBe(true);
    });

    it('should handle null body', () => {
      mockRequest.body = null;

      sanitizeInput(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should handle undefined body', () => {
      mockRequest.body = undefined;

      sanitizeInput(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('validateContentType()', () => {
    const allowedTypes = ['application/json', 'application/xml'];

    it('should pass for allowed content type', () => {
      (mockRequest.header as jest.Mock).mockReturnValue('application/json');

      const middleware = validateContentType(allowedTypes);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should pass for content type with charset', () => {
      (mockRequest.header as jest.Mock).mockReturnValue('application/json; charset=utf-8');

      const middleware = validateContentType(allowedTypes);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 415 for unsupported content type', () => {
      (mockRequest.header as jest.Mock).mockReturnValue('text/plain');

      const middleware = validateContentType(allowedTypes);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(415);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Unsupported Media Type'),
        })
      );
    });

    it('should return 415 when content type is missing', () => {
      (mockRequest.header as jest.Mock).mockReturnValue(undefined);

      const middleware = validateContentType(allowedTypes);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(415);
    });
  });

  describe('validationMiddleware()', () => {
    const schema = z.object({
      title: z.string().min(1),
      count: z.number().positive(),
    });

    it('should call next on valid body', () => {
      mockRequest.body = { title: 'Test', count: 5 };

      const middleware = validationMiddleware(schema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });

    it('should return 400 on validation failure', () => {
      mockRequest.body = { title: '', count: 5 };

      const middleware = validationMiddleware(schema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(400);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation failed',
          details: expect.any(Array),
        })
      );
    });

    it('should return 500 on unexpected error', () => {
      mockRequest.body = undefined;

      // Force a non-ZodError
      const badSchema = {
        parse: jest.fn().mockImplementation(() => {
          throw new Error('Unexpected error');
        }),
      } as any;

      const middleware = validationMiddleware(badSchema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(statusMock).toHaveBeenCalledWith(500);
      expect(jsonMock).toHaveBeenCalledWith(
        expect.objectContaining({
          success: false,
          error: 'Validation error',
        })
      );
    });
  });

  describe('validateRequest()', () => {
    it('should return a validation middleware', () => {
      const schema = z.object({ name: z.string() });
      const middleware = validateRequest(schema);

      expect(typeof middleware).toBe('function');
    });

    it('should validate request body', () => {
      const schema = z.object({ name: z.string() });
      mockRequest.body = { name: 'Test' };

      const middleware = validateRequest(schema);
      middleware(mockRequest as Request, mockResponse as Response, mockNext);

      expect(mockNext).toHaveBeenCalled();
    });
  });

  describe('Schema Validation Tests', () => {
    describe('integrationConfig schema', () => {
      it('should validate valid integration config', () => {
        const validConfig = {
          id: 'test-integration',
          name: 'Test Integration',
          sourceSystem: 'salesforce',
          targetSystem: 'netsuite',
          sourceEntity: 'Contact',
          targetEntity: 'Customer',
          syncDirection: 'source_to_target',
          syncMode: 'batch',
          sourceAuthentication: {
            type: 'oauth2',
            credentials: {
              clientId: 'client123',
              clientSecret: 'secret456',
            },
          },
        };

        const result = ValidationSchemas.integrationConfig.safeParse(validConfig);
        expect(result.success).toBe(true);
      });

      it('should reject invalid ID format', () => {
        const invalidConfig = {
          id: 'invalid id!', // Invalid characters
          name: 'Test',
          sourceSystem: 'sf',
          targetSystem: 'ns',
          sourceEntity: 'Contact',
          targetEntity: 'Customer',
          syncDirection: 'bidirectional',
          syncMode: 'batch',
          sourceAuthentication: { type: 'api_key', credentials: { key: 'test' } },
        };

        const result = ValidationSchemas.integrationConfig.safeParse(invalidConfig);
        expect(result.success).toBe(false);
      });
    });

    describe('queryParams schema', () => {
      it('should validate and transform query params', () => {
        const queryParams = {
          page: '2',
          limit: '50',
          sortOrder: 'desc',
        };

        const result = ValidationSchemas.queryParams.safeParse(queryParams);
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.page).toBe(2);
          expect(result.data.limit).toBe(50);
        }
      });

      it('should apply defaults', () => {
        const result = ValidationSchemas.queryParams.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
          expect(result.data.page).toBe(1);
          expect(result.data.limit).toBe(20);
          expect(result.data.sortOrder).toBe('asc');
        }
      });

      it('should reject limit over 100', () => {
        const result = ValidationSchemas.queryParams.safeParse({ limit: '200' });
        expect(result.success).toBe(false);
      });
    });

    describe('authRequest schema', () => {
      it('should validate valid auth request', () => {
        const result = ValidationSchemas.authRequest.safeParse({
          username: 'user',
          password: 'pass',
        });
        expect(result.success).toBe(true);
      });

      it('should reject empty username', () => {
        const result = ValidationSchemas.authRequest.safeParse({
          username: '',
          password: 'pass',
        });
        expect(result.success).toBe(false);
      });

      it('should reject empty password', () => {
        const result = ValidationSchemas.authRequest.safeParse({
          username: 'user',
          password: '',
        });
        expect(result.success).toBe(false);
      });
    });

    describe('apiKeyRequest schema', () => {
      it('should validate valid api key request', () => {
        const result = ValidationSchemas.apiKeyRequest.safeParse({
          name: 'My API Key',
          role: 'editor',
        });
        expect(result.success).toBe(true);
      });

      it('should reject invalid role', () => {
        const result = ValidationSchemas.apiKeyRequest.safeParse({
          name: 'My API Key',
          role: 'superadmin',
        });
        expect(result.success).toBe(false);
      });
    });
  });
});
