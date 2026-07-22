import 'reflect-metadata';
import { SchemaValidationService, type SchemaValidationConfig } from '../../../../../src/services/ai/validation/SchemaValidationService';
import { SchemaDiscoveryService } from '../../../../../src/services/ai/validation/SchemaDiscoveryService';
import type { AISuggestion } from '../../../../../src/services/ai/providers/types';
import type { SystemType, EntityType } from '../../../../../src/services/ai/validation/types';

describe('SchemaValidationService', () => {
  let schemaDiscovery: SchemaDiscoveryService;
  let validationService: SchemaValidationService;

  beforeEach(() => {
    schemaDiscovery = new SchemaDiscoveryService({
      enableNetSuite: false,
      enableSalesforce: false,
      enableBusinessCentral: false
    });

    validationService = new SchemaValidationService(schemaDiscovery);
  });

  describe('validateMapping - field existence', () => {
    it('should validate mapping to existing field', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(result.confidenceBoost).toBeDefined();
      expect(result.confidenceBoost).toBeGreaterThan(0);
      expect(result.metadata?.fieldExists).toBe(true);
    });

    it('should detect non-existent target field', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'nonExistentField',
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result).toBeDefined();
      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('does not exist');
      expect(result.confidencePenalty).toBeDefined();
      expect(result.confidencePenalty).toBeGreaterThan(0);
      expect(result.metadata?.fieldExists).toBe(false);
    });

    it('should suggest similar fields for typos', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'emial', // Typo
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result).toBeDefined();
      expect(result.valid).toBe(false);

      // Should suggest 'email' as alternative if similar enough
      if (result.alternativeSuggestions && result.alternativeSuggestions.length > 0) {
        const emailSuggestion = result.alternativeSuggestions.find(f => f.name === 'email');
        expect(emailSuggestion).toBeDefined();
      }
    });

    it('should handle case-insensitive field matching', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'EMAIL', // Different case
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.fieldExists).toBe(true);
    });
  });

  describe('validateMapping - type compatibility', () => {
    it('should validate compatible types (string to string)', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'company_name',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string' // Source field type
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.typeCompatible).toBe(true);
    });

    it('should detect type incompatibility (number to string)', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'account_id',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'number', // Source is number
        [12345, 67890]
      );

      // Number to string conversion is possible but should warn
      expect(result.warnings).toBeDefined();
      expect(result.metadata?.typeCompatible).toBeDefined();
    });

    it('should allow date to string conversion', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'created_date',
        targetField: 'email', // For testing purposes
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'date'
      );

      expect(result).toBeDefined();
      // Date can be converted to string
      expect(result.metadata?.typeCompatible).toBeDefined();
    });

    it('should handle missing type information gracefully', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'unknown_field',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 85
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
        // No source type provided
      );

      expect(result).toBeDefined();
      expect(result.metadata?.typeCompatible).toBe(true); // Assume compatible when unknown
    });
  });

  describe('validateMapping - format validation', () => {
    it('should validate email format in sample values', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 85
      };

      const sampleValues = ['test@example.com', 'user@domain.org', 'admin@company.net'];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.formatValid).toBe(true);
    });

    it('should detect invalid email format', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 85
      };

      const sampleValues = ['not-an-email', 'also-invalid', 'bad@format'];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      // Should warn about format issues
      expect(result.warnings).toBeDefined();
      expect(result.metadata?.formatValid).toBe(false);
    });

    it('should validate phone format in sample values', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_phone',
        targetField: 'phone',
        transformationType: 'direct',
        confidence: 85
      };

      const sampleValues = ['+1-555-1234', '(555) 555-5555', '555-5555'];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.formatValid).toBe(true);
    });

    it('should allow 80% of samples to match format', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 85
      };

      // 4 out of 5 are valid (80%)
      const sampleValues = [
        'valid1@example.com',
        'valid2@example.com',
        'valid3@example.com',
        'valid4@example.com',
        'invalid'
      ];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.formatValid).toBe(true);
    });
  });

  describe('validateMapping - length constraints', () => {
    it('should validate field length constraints', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'company_name',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85
      };

      const sampleValues = ['Short Name', 'Another Company', 'Valid Length'];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      expect(result.valid).toBe(true);
      expect(result.metadata?.lengthValid).toBe(true);
    });

    it('should detect length constraint violations', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'long_description',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85
      };

      // Create a value that exceeds typical maxLength (255)
      const veryLongString = 'A'.repeat(300);
      const sampleValues = [veryLongString];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      // Should warn about length issues
      expect(result.warnings).toBeDefined();
      expect(result.metadata?.lengthValid).toBe(false);
    });

    it('should handle null values in length validation', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'company_name',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85
      };

      const sampleValues = [null, 'Valid Name', undefined, 'Another Valid'];

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer',
        'string',
        sampleValues
      );

      // Null values should not cause failures
      expect(result.valid).toBe(true);
    });
  });

  describe('validateMappings - batch validation', () => {
    it('should validate multiple mappings in batch', async () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'customer_email',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 85
        },
        {
          sourceField: 'customer_phone',
          targetField: 'phone',
          transformationType: 'direct',
          confidence: 80
        },
        {
          sourceField: 'company_name',
          targetField: 'companyName',
          transformationType: 'direct',
          confidence: 90
        }
      ];

      const results = await validationService.validateMappings(
        suggestions,
        'NetSuite',
        'Customer'
      );

      expect(results).toBeDefined();
      expect(results.size).toBe(3);

      const emailResult = results.get('customer_email');
      const phoneResult = results.get('customer_phone');
      const nameResult = results.get('company_name');

      expect(emailResult).toBeDefined();
      expect(phoneResult).toBeDefined();
      expect(nameResult).toBeDefined();
    });

    it('should include source field types in batch validation', async () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'customer_email',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 85
        }
      ];

      const sourceFieldTypes = {
        'customer_email': 'string'
      };

      const results = await validationService.validateMappings(
        suggestions,
        'NetSuite',
        'Customer',
        sourceFieldTypes
      );

      expect(results.size).toBe(1);
      const result = results.get('customer_email');
      expect(result?.metadata?.typeCompatible).toBe(true);
    });

    it('should include sample data in batch validation', async () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'customer_email',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 85
        }
      ];

      const sampleData = [
        { customer_email: 'test1@example.com' },
        { customer_email: 'test2@example.com' }
      ];

      const results = await validationService.validateMappings(
        suggestions,
        'NetSuite',
        'Customer',
        {},
        sampleData
      );

      expect(results.size).toBe(1);
      const result = results.get('customer_email');
      expect(result?.valid).toBe(true);
    });
  });

  describe('applyValidationResults', () => {
    it('should boost confidence for valid mappings', () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'customer_email',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 70
        }
      ];

      const validationResults = new Map();
      validationResults.set('customer_email', {
        valid: true,
        confidenceBoost: 15,
        metadata: { fieldExists: true, typeCompatible: true, formatValid: true, lengthValid: true }
      });

      const enhanced = validationService.applyValidationResults(suggestions, validationResults);

      expect(enhanced).toBeDefined();
      expect(enhanced.length).toBe(1);
      expect(enhanced[0].confidence).toBe(85); // 70 + 15
      expect(enhanced[0].reasoning).toContain('Schema validated');
      expect(enhanced[0].reasoning).toContain('+15%');
    });

    it('should penalize confidence for invalid mappings', () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'invalid_field',
          targetField: 'nonexistent',
          transformationType: 'direct',
          confidence: 80
        }
      ];

      const validationResults = new Map();
      validationResults.set('invalid_field', {
        valid: false,
        confidencePenalty: 20,
        error: 'Field does not exist',
        metadata: { fieldExists: false, typeCompatible: false, formatValid: false, lengthValid: false }
      });

      const enhanced = validationService.applyValidationResults(suggestions, validationResults);

      expect(enhanced).toBeDefined();
      expect(enhanced.length).toBe(1);
      expect(enhanced[0].confidence).toBe(60); // 80 - 20
    });

    it('should not modify confidence below 0', () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'bad_field',
          targetField: 'invalid',
          transformationType: 'direct',
          confidence: 10
        }
      ];

      const validationResults = new Map();
      validationResults.set('bad_field', {
        valid: false,
        confidencePenalty: 50,
        metadata: { fieldExists: false, typeCompatible: false, formatValid: false, lengthValid: false }
      });

      const enhanced = validationService.applyValidationResults(suggestions, validationResults);

      expect(enhanced[0].confidence).toBe(0); // Should not go below 0
    });

    it('should not modify confidence above 100', () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'perfect_match',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 95
        }
      ];

      const validationResults = new Map();
      validationResults.set('perfect_match', {
        valid: true,
        confidenceBoost: 20,
        metadata: { fieldExists: true, typeCompatible: true, formatValid: true, lengthValid: true }
      });

      const enhanced = validationService.applyValidationResults(suggestions, validationResults);

      expect(enhanced[0].confidence).toBe(100); // Should not go above 100
    });

    it('should append warnings to reasoning', () => {
      const suggestions: AISuggestion[] = [
        {
          sourceField: 'customer_email',
          targetField: 'email',
          transformationType: 'direct',
          confidence: 80,
          reasoning: 'Good match based on name'
        }
      ];

      const validationResults = new Map();
      validationResults.set('customer_email', {
        valid: true,
        warnings: ['Format validation warning', 'Type mismatch warning'],
        metadata: { fieldExists: true, typeCompatible: true, formatValid: true, lengthValid: true }
      });

      const enhanced = validationService.applyValidationResults(suggestions, validationResults);

      expect(enhanced[0].reasoning).toContain('Good match based on name');
      expect(enhanced[0].reasoning).toContain('Warnings:');
      expect(enhanced[0].reasoning).toContain('Format validation warning');
      expect(enhanced[0].reasoning).toContain('Type mismatch warning');
    });
  });

  describe('configuration options', () => {
    it('should apply custom confidence boost amount', async () => {
      const config: SchemaValidationConfig = {
        confidenceBoostAmount: 25
      };

      const service = new SchemaValidationService(schemaDiscovery, config);

      const suggestion: AISuggestion = {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 70
      };

      const result = await service.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result.valid).toBe(true);
      expect(result.confidenceBoost).toBe(25);
    });

    it('should apply custom confidence penalty amount', async () => {
      const config: SchemaValidationConfig = {
        confidencePenaltyAmount: 30
      };

      const service = new SchemaValidationService(schemaDiscovery, config);

      const suggestion: AISuggestion = {
        sourceField: 'invalid',
        targetField: 'nonexistent',
        transformationType: 'direct',
        confidence: 80
      };

      const result = await service.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result.valid).toBe(false);
      expect(result.confidencePenalty).toBe(30);
    });

    it('should use default configuration when none provided', () => {
      const service = new SchemaValidationService(schemaDiscovery);

      expect(service).toBeDefined();
    });
  });

  describe('error handling', () => {
    it('should handle schema discovery errors gracefully', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'test',
        targetField: 'test',
        transformationType: 'direct',
        confidence: 80
      };

      // Use invalid system to trigger error
      const result = await validationService.validateMapping(
        suggestion,
        'InvalidSystem' as SystemType,
        'Customer'
      );

      // Should return permissive result on error
      expect(result).toBeDefined();
      expect(result.valid).toBe(true);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain('Schema validation error');
    });
  });

  describe('Levenshtein distance algorithm', () => {
    it('should find similar field names for typos', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'test',
        targetField: 'phoen', // Typo of 'phone'
        transformationType: 'direct',
        confidence: 80
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result.valid).toBe(false);

      // Should suggest phone as alternative if similarity > 60%
      if (result.alternativeSuggestions && result.alternativeSuggestions.length > 0) {
        const phoneAlternative = result.alternativeSuggestions.find(f => f.name === 'phone');
        expect(phoneAlternative).toBeDefined();
      }
    });

    it('should limit alternative suggestions to top 3', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'test',
        targetField: 'e', // Very short, might match many fields
        transformationType: 'direct',
        confidence: 80
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      if (result.alternativeSuggestions) {
        expect(result.alternativeSuggestions.length).toBeLessThanOrEqual(3);
      }
    });

    it('should not suggest alternatives below 60% similarity', async () => {
      const suggestion: AISuggestion = {
        sourceField: 'test',
        targetField: 'completelydifferentfieldname',
        transformationType: 'direct',
        confidence: 80
      };

      const result = await validationService.validateMapping(
        suggestion,
        'NetSuite',
        'Customer'
      );

      expect(result.valid).toBe(false);
      // Should not have alternatives if nothing is >60% similar
      if (result.alternativeSuggestions) {
        expect(result.alternativeSuggestions.length).toBe(0);
      }
    });
  });
});
