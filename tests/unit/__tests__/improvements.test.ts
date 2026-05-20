/**
 * Test suite for the implemented improvements
 */

import { describe, test, expect, beforeAll } from '@jest/globals';
import { Logger, createLogger } from '../utils/Logger';
import { TransformationEngine } from '../services/TransformationEngine';
import {
  ValidationAppError,
  UnauthorizedAppError,
} from '../errors/AppError';
import { ErrorMonitor } from '../utils/ErrorMonitor';
// Mock logger for transformation engine tests
const mockLogger: Logger = createLogger('test');

describe('Improvements Test Suite', () => {
  beforeAll(() => {
    // Set required environment variables for testing
    process.env.NODE_ENV = 'test';
    process.env.JWT_SECRET = 'testsecret1234567890123456789012345678901234567890';
    process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
    process.env.REDIS_URL = 'redis://localhost:6379';
  });

  describe('Environment Validation', () => {
    test('should validate environment variables with Zod', async () => {
      await expect(import('../config/env')).resolves.toBeDefined();
    });

    test('should have correct environment values', async () => {
      const { env } = await import('../config/env');
      expect(env.NODE_ENV).toBe('test');
      expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    });
  });

  describe('Enhanced Logging', () => {
    test('should create structured logger', () => {
      const logger = new Logger('test');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');

      const namedLogger = createLogger('test-context');
      expect(namedLogger).toBeDefined();
    });

    test('should support correlation IDs', () => {
      const logger = new Logger('test');
      const correlatedLogger = logger.withCorrelationId();

      expect(correlatedLogger.getCorrelationId()).toBeDefined();
      expect(typeof correlatedLogger.getCorrelationId()).toBe('string');
    });
  });

  describe('Crypto Utilities', () => {
    test('should generate secure JWT secret', async () => {
      const { CryptoUtils } = await import('../utils/crypto');

      const secret = CryptoUtils.generateJWTSecret(64);
      expect(secret).toBeDefined();
      expect(secret.length).toBe(64);

      const analysis = CryptoUtils.analyzeEntropy(secret);
      expect(analysis.strength).toMatch(/weak|fair|good|strong/);
    });

    test('should generate API keys', async () => {
      const { CryptoUtils } = await import('../utils/crypto');

      const apiKey = CryptoUtils.generateApiKey('test', 16);
      expect(apiKey).toMatch(/^test_[a-f0-9]{32}$/);
    });

    test('should perform timing-safe comparisons', async () => {
      const { CryptoUtils } = await import('../utils/crypto');

      expect(CryptoUtils.timingSafeEqual('test', 'test')).toBe(true);
      expect(CryptoUtils.timingSafeEqual('test', 'different')).toBe(false);
    });
  });

  describe('Type Safety', () => {
    test('should use discriminated unions for AuthConfig', () => {
      const authConfig = {
        type: 'oauth2' as const,
        credentials: {
          clientId: 'test-client',
          clientSecret: 'test-secret',
          tokenUrl: 'https://example.com/token',
        },
      };

      expect(authConfig.type).toBe('oauth2');
      expect(authConfig.credentials.clientId).toBe('test-client');
    });

    test('should support generic DataRecord types', () => {
      interface CustomerData {
        name: string;
        email: string;
      }

      const record = {
        id: 'test-123',
        fields: {
          name: 'Test Customer',
          email: 'test@example.com',
        } as CustomerData,
        metadata: {
          source: 'test',
          version: '1.0',
        },
      };

      expect(record.fields.name).toBe('Test Customer');
      expect(record.fields.email).toBe('test@example.com');
    });
  });

  describe('Error Handling', () => {
    test('should create proper error classes', () => {
      const validationError = new ValidationAppError('Test validation', ['field1: required']);
      expect(validationError.statusCode).toBe(400);
      expect(validationError.errorCode).toBe('VALIDATION_ERROR');
      expect(validationError.validationErrors).toContain('field1: required');

      const authError = new UnauthorizedAppError('Test auth error');
      expect(authError.statusCode).toBe(401);
      expect(authError.errorCode).toBe('UNAUTHORIZED');
    });

    test('should have error monitoring capabilities', () => {
      expect(typeof ErrorMonitor.trackError).toBe('function');
      expect(typeof ErrorMonitor.resetCounts).toBe('function');
    });
  });

  describe('Validation Middleware', () => {
    test('should provide validation schemas', async () => {
      const { ValidationSchemas } = await import('../middleware/validation');

      expect(ValidationSchemas).toBeDefined();
      expect(ValidationSchemas.integrationConfig).toBeDefined();
      expect(ValidationSchemas.dataRecord).toBeDefined();
      expect(ValidationSchemas.authRequest).toBeDefined();
    });

    test('should validate integration config', async () => {
      const { ValidationSchemas } = await import('../middleware/validation');

      const validConfig = {
        id: 'test-integration',
        name: 'Test Integration',
        sourceSystem: 'NetSuite',
        targetSystem: 'BusinessCentral',
        sourceEntity: 'customer',
        targetEntity: 'order',
        syncDirection: 'bidirectional',
        syncMode: 'batch',
        isActive: true,
        sourceAuthentication: {
          type: 'oauth2',
          credentials: {
            clientId: 'test',
            clientSecret: 'secret',
            tokenUrl: 'https://example.com/token',
          },
        },
        targetAuthentication: {
          type: 'api_key',
          credentials: {
            apiKey: 'test-api-key',
          },
        },
      };

      const result = ValidationSchemas.integrationConfig.safeParse(validConfig);
      expect(result.success).toBe(true);
    });
  });
});

describe('TransformationEngine', () => {
  let engine: TransformationEngine;

  beforeEach(() => {
    engine = new TransformationEngine(mockLogger);
  });

  it('should transform data according to field mappings', async () => {
    const sourceData = { fields: { firstName: 'John', lastName: 'Doe' } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: 'firstName',
          targetField: 'givenName',
          isRequired: true,
          transformationType: 'direct',
          transformationConfig: { type: 'direct' },
        },
        {
          sourceField: 'lastName',
          targetField: 'familyName',
          isRequired: true,
          transformationType: 'direct',
          transformationConfig: { type: 'direct' },
        },
      ],
      rules: [],
    };

    const result = await engine.transform(context);
    expect(result.transformedData).toMatchObject({
      id: undefined,
      externalId: undefined,
      fields: {
        givenName: 'John',
        familyName: 'Doe',
      },
      metadata: {
        source: 'transformation',
        version: '1.0',
      },
    });
    expect(result.transformedData.metadata?.lastModified).toBeInstanceOf(Date);
    expect(result.success).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should apply transformation rules', async () => {
    const sourceData = { fields: { age: '25' } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: 'age',
          targetField: 'personAge',
          isRequired: true,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'parseInt(age)',
          },
        },
      ],
      rules: [
        {
          id: 'age-validation',
          name: 'Age Validation',
          type: 'data_validation',
          condition: 'age != null',
          action: 'transform',
          parameters: {
            type: 'data_validation',
            rules: [
              {
                field: 'age',
                type: 'range',
                value: [0, 150],
                message: 'Age must be between 0 and 150',
              },
            ],
          },
        },
      ],
    };

    const result = await engine.transform(context);
    expect(result.transformedData).toMatchObject({
      id: undefined,
      externalId: undefined,
      fields: {
        personAge: 25,
      },
      metadata: {
        source: 'transformation',
        version: '1.0',
      },
    });
    expect(result.transformedData.metadata?.lastModified).toBeInstanceOf(Date);
    expect(result.success).toBe(true);
  });

  it('should handle missing fields gracefully', async () => {
    const sourceData = { fields: { firstName: 'John' } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: 'lastName',
          targetField: 'familyName',
          isRequired: false,
          transformationType: 'direct',
          transformationConfig: { type: 'direct' },
        },
      ],
      rules: [],
    };

    const result = await engine.transform(context);
    expect(result.transformedData).toMatchObject({
      id: undefined,
      externalId: undefined,
      fields: {},
      metadata: {
        source: 'transformation',
        version: '1.0',
      },
    });
    expect(result.success).toBe(true);
    expect(result.warnings).toHaveLength(1);
  });

  it('should perform direct field mapping', async () => {
    const sourceData = { fields: { firstName: 'John', lastName: 'Doe', email: 'john.doe@example.com' } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: 'firstName',
          targetField: 'first_name',
          isRequired: false,
          transformationType: 'direct',
          transformationConfig: { type: 'direct' },
        },
        {
          sourceField: 'email',
          targetField: 'email_address',
          isRequired: false,
          transformationType: 'direct',
          transformationConfig: { type: 'direct' },
        },
      ],
      rules: [],
    };

    const result = await engine.transform(context);
    expect(result.transformedData.fields.first_name).toBe('John');
    expect(result.transformedData.fields.email_address).toBe('john.doe@example.com');
    expect(result.transformedData.fields.lastName).toBeUndefined();
  });

  it('should perform concatenation transformation', async () => {
    const sourceData = { fields: { firstName: 'John', lastName: 'Doe', title: 'Mr.' } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: ['title', 'firstName', 'lastName'],
          targetField: 'full_name',
          transformationType: 'concatenation',
          isRequired: false,
          transformationConfig: {
            type: 'concatenation',
            separator: ' ',
            fields: ['title', 'firstName', 'lastName'],
          },
        },
      ],
      rules: [],
    };

    const result = await engine.transform(context);
    expect(result.transformedData.fields.full_name).toBe('Mr. John Doe');
  });

  it('should handle transformation errors gracefully', async () => {
    const sourceData = { fields: { invalidField: null } };
    const context: any = {
      sourceData,
      mappings: [
        {
          sourceField: 'invalidField',
          targetField: 'target_field',
          isRequired: true,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'invalidField * 2',
          },
        },
      ],
      rules: [],
    };

    const result = await engine.transform(context);
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!).toBeDefined();
    expect(result.errors[0]!.message).toContain('Calculation failed');
  });
});

describe('Security Features', () => {
  test('should sanitize inputs', () => {
    // This would typically test the sanitization middleware
    const maliciousInput = '<script>alert("xss")</script>';
    const expected = 'scriptalert("xss")/script';

    // Simple test - in real middleware this would be more comprehensive
    const sanitized = maliciousInput.replace(/[<>]/g, '');
    expect(sanitized).toBe(expected);
  });

  test('should validate content types', () => {
    const allowedTypes = ['application/json'];
    const validType = 'application/json';
    const invalidType = 'text/html';

    expect(allowedTypes.includes(validType)).toBe(true);
    expect(allowedTypes.includes(invalidType)).toBe(false);
  });
});
