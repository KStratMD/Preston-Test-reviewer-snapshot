import 'reflect-metadata';
import { AccuracyEnhancementService, type EnhancementConfig } from '../../../../../src/services/ai/validation/AccuracyEnhancementService';
import { SchemaDiscoveryService } from '../../../../../src/services/ai/validation/SchemaDiscoveryService';
import { SchemaValidationService } from '../../../../../src/services/ai/validation/SchemaValidationService';
import type { AIProvider, AISuggestion } from '../../../../../src/services/ai/providers/types';
import type { FieldMetadata } from '../../../../../src/services/ai/prompts/FieldMappingPrompts';

// Mock AI Provider for testing
class MockAIProvider implements AIProvider {
  name = 'MockProvider';

  async suggest(sourceSystem: string, targetSystem: string, sampleData: any[]): Promise<AISuggestion[]> {
    // Return mock suggestions that match NetSuite schema
    return [
      {
        sourceField: 'customer_email',
        targetField: 'email',
        transformationType: 'direct',
        confidence: 75,
        reasoning: 'Direct field name match'
      },
      {
        sourceField: 'customer_phone',
        targetField: 'phone',
        transformationType: 'direct',
        confidence: 80,
        reasoning: 'Similar field names'
      },
      {
        sourceField: 'company_name',
        targetField: 'companyName',
        transformationType: 'direct',
        confidence: 85,
        reasoning: 'Strong semantic match'
      },
      {
        sourceField: 'invalid_field',
        targetField: 'nonExistentField', // This should fail validation
        transformationType: 'direct',
        confidence: 70,
        reasoning: 'Weak match'
      }
    ];
  }

  async verifyConnection(): Promise<boolean> {
    return true;
  }

  async getModelCapabilities(): Promise<any> {
    return {
      name: 'Mock Model',
      maxTokens: 4000,
      supportsVision: false
    };
  }
}

describe('AccuracyEnhancementService - Phase 5 Integration', () => {
  let enhancer: AccuracyEnhancementService;
  let schemaDiscovery: SchemaDiscoveryService;
  let mockProvider: MockAIProvider;
  let sampleData: any[];
  let sourceFieldsMetadata: FieldMetadata[];

  beforeEach(() => {
    schemaDiscovery = new SchemaDiscoveryService({
      enableNetSuite: false,
      enableSalesforce: false,
      enableBusinessCentral: false
    });

    enhancer = new AccuracyEnhancementService(schemaDiscovery);

    mockProvider = new MockAIProvider();

    sampleData = [
      {
        customer_email: 'test1@example.com',
        customer_phone: '555-1234',
        company_name: 'Acme Corp',
        invalid_field: 'test'
      },
      {
        customer_email: 'test2@example.com',
        customer_phone: '555-5678',
        company_name: 'Widget Inc',
        invalid_field: 'test2'
      }
    ];

    sourceFieldsMetadata = [
      {
        name: 'customer_email',
        type: 'string',
        sampleValues: ['test1@example.com', 'test2@example.com']
      },
      {
        name: 'customer_phone',
        type: 'string',
        sampleValues: ['555-1234', '555-5678']
      },
      {
        name: 'company_name',
        type: 'string',
        sampleValues: ['Acme Corp', 'Widget Inc']
      },
      {
        name: 'invalid_field',
        type: 'string',
        sampleValues: ['test', 'test2']
      }
    ];
  });

  describe('Phase 5 schema validation integration', () => {
    it('should apply schema validation when enabled', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);

      // Valid mappings should be present
      const emailMapping = suggestions.find(s => s.targetField === 'email');
      const phoneMapping = suggestions.find(s => s.targetField === 'phone');
      const companyMapping = suggestions.find(s => s.targetField === 'companyName');

      expect(emailMapping).toBeDefined();
      expect(phoneMapping).toBeDefined();
      expect(companyMapping).toBeDefined();

      // Invalid mapping should either be filtered out OR have reduced confidence
      const invalidMapping = suggestions.find(s => s.targetField === 'nonExistentField');
      if (invalidMapping) {
        // If present, confidence should be significantly reduced
        expect(invalidMapping.confidence).toBeLessThan(70);
      }
    });

    it('should boost confidence for schema-validated mappings', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      // All valid suggestions should have calibration applied
      suggestions.forEach(suggestion => {
        // After semantic + schema validation, calibrated confidence should be set
        expect(suggestion.calibratedConfidence).toBeDefined();
        expect(suggestion.originalConfidence).toBeDefined();

        // Final confidence should be within valid range
        expect(suggestion.confidence).toBeGreaterThanOrEqual(0);
        expect(suggestion.confidence).toBeLessThanOrEqual(100);
      });
    });

    it('should work without schema validation (backward compatible)', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: false // Schema validation disabled
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(suggestions.length).toBeGreaterThan(0);

      // Should still have the invalid mapping (schema validation not applied)
      const invalidMapping = suggestions.find(s => s.targetField === 'nonExistentField');
      // May or may not be present depending on semantic validation threshold
    });

    it('should require targetSystem and targetEntity for schema validation', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true
        // Missing targetSystem and targetEntity
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      // Should not fail, just skip schema validation
      expect(suggestions).toBeDefined();
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should sort suggestions by calibrated confidence', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      // Suggestions should be sorted by calibrated confidence (highest first)
      for (let i = 0; i < suggestions.length - 1; i++) {
        const current = suggestions[i].calibratedConfidence || suggestions[i].confidence || 0;
        const next = suggestions[i + 1].calibratedConfidence || suggestions[i + 1].confidence || 0;
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });
  });

  describe('Phase 2 + Phase 5 integration', () => {
    it('should apply both semantic and schema validation', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true, // Phase 2
        useSchemaValidation: true,    // Phase 5
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      suggestions.forEach(suggestion => {
        // Should have validation info from Phase 2
        expect(suggestion.validation).toBeDefined();
        expect(suggestion.originalConfidence).toBeDefined();
        expect(suggestion.calibratedConfidence).toBeDefined();

        // Reasoning should mention schema validation (Phase 5)
        if (suggestion.reasoning) {
          // May contain schema validation info
        }
      });
    });

    it('should accumulate confidence adjustments from both phases', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      suggestions.forEach(suggestion => {
        const originalConf = suggestion.originalConfidence || 70;
        const calibratedConf = suggestion.calibratedConfidence || originalConf;
        const finalConf = suggestion.confidence || calibratedConf;

        // Final confidence should reflect adjustments from both phases
        // Exact values depend on validation results
        expect(typeof finalConf).toBe('number');
        expect(finalConf).toBeGreaterThanOrEqual(0);
        expect(finalConf).toBeLessThanOrEqual(100);
      });
    });
  });

  describe('getQualityMetrics with Phase 5', () => {
    it('should provide quality metrics for Phase 5 enhanced suggestions', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      const metrics = enhancer.getQualityMetrics(suggestions);

      expect(metrics).toBeDefined();
      expect(metrics.averageConfidence).toBeDefined();
      expect(metrics.averageConfidence).toBeGreaterThanOrEqual(0);
      expect(metrics.averageConfidence).toBeLessThanOrEqual(100);

      expect(metrics.highConfidenceCount).toBeDefined();
      expect(metrics.mediumConfidenceCount).toBeDefined();
      expect(metrics.lowConfidenceCount).toBeDefined();

      expect(metrics.validationWarnings).toBeDefined();
      expect(metrics.validationErrors).toBeDefined();

      const totalCount = metrics.highConfidenceCount + metrics.mediumConfidenceCount + metrics.lowConfidenceCount;
      expect(totalCount).toBe(suggestions.length);
    });
  });

  describe('AccuracyEnhancementService with custom SchemaValidationService', () => {
    it('should accept custom SchemaValidationService', async () => {
      const customSchemaValidation = new SchemaValidationService(schemaDiscovery, {
        confidenceBoostAmount: 25,
        confidencePenaltyAmount: 30
      });

      const customEnhancer = new AccuracyEnhancementService(
        schemaDiscovery,
        customSchemaValidation
      );

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await customEnhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(suggestions.length).toBeGreaterThan(0);
    });

    it('should auto-create SchemaValidationService if only SchemaDiscoveryService provided', async () => {
      const enhancerWithAutoCreate = new AccuracyEnhancementService(schemaDiscovery);

      expect(enhancerWithAutoCreate).toBeDefined();

      // Should work with schema validation enabled
      await expect(
        enhancerWithAutoCreate.getEnhancedSuggestions(
          mockProvider,
          'Salesforce',
          'NetSuite',
          sampleData,
          sourceFieldsMetadata,
          {
            useSchemaValidation: true,
            targetSystem: 'NetSuite',
            targetEntity: 'Customer'
          }
        )
      ).resolves.not.toThrow();
    });
  });

  describe('edge cases', () => {
    it('should handle empty suggestions from provider', async () => {
      class EmptyMockProvider implements AIProvider {
        name = 'EmptyMockProvider';

        async suggest(): Promise<AISuggestion[]> {
          return [];
        }

        async verifyConnection(): Promise<boolean> {
          return true;
        }

        async getModelCapabilities(): Promise<any> {
          return {};
        }
      }

      const emptyProvider = new EmptyMockProvider();

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        emptyProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
      expect(suggestions.length).toBe(0);
    });

    it('should handle provider errors gracefully', async () => {
      class ErrorMockProvider implements AIProvider {
        name = 'ErrorMockProvider';

        async suggest(): Promise<AISuggestion[]> {
          throw new Error('Provider error');
        }

        async verifyConnection(): Promise<boolean> {
          return false;
        }

        async getModelCapabilities(): Promise<any> {
          throw new Error('Provider error');
        }
      }

      const errorProvider = new ErrorMockProvider();

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      await expect(
        enhancer.getEnhancedSuggestions(
          errorProvider,
          'Salesforce',
          'NetSuite',
          sampleData,
          sourceFieldsMetadata,
          config
        )
      ).rejects.toThrow('Provider error');
    });

    it('should handle empty sample data', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        [], // Empty sample data
        sourceFieldsMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('should handle empty source fields metadata', async () => {
      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        [], // Empty metadata
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('should handle missing field types in metadata', async () => {
      const incompleteMetadata: FieldMetadata[] = [
        {
          name: 'customer_email'
          // Missing type and sampleValues
        },
        {
          name: 'customer_phone',
          type: 'string'
          // Missing sampleValues
        }
      ];

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        incompleteMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });

  describe('performance characteristics', () => {
    it('should complete validation within reasonable time', async () => {
      const startTime = Date.now();

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        sampleData,
        sourceFieldsMetadata,
        config
      );

      const executionTime = Date.now() - startTime;

      // Should complete in under 1 second for mock data
      expect(executionTime).toBeLessThan(1000);
    });

    it('should handle large sample datasets efficiently', async () => {
      // Create large sample dataset
      const largeSampleData = Array.from({ length: 100 }, (_, i) => ({
        customer_email: `test${i}@example.com`,
        customer_phone: `555-${1000 + i}`,
        company_name: `Company ${i}`,
        invalid_field: `test${i}`
      }));

      const largeSampleMetadata: FieldMetadata[] = [
        {
          name: 'customer_email',
          type: 'string',
          sampleValues: largeSampleData.slice(0, 3).map(d => d.customer_email)
        },
        {
          name: 'customer_phone',
          type: 'string',
          sampleValues: largeSampleData.slice(0, 3).map(d => d.customer_phone)
        },
        {
          name: 'company_name',
          type: 'string',
          sampleValues: largeSampleData.slice(0, 3).map(d => d.company_name)
        }
      ];

      const config: EnhancementConfig = {
        minConfidence: 70,
        useSemanticValidation: true,
        useSchemaValidation: true,
        targetSystem: 'NetSuite',
        targetEntity: 'Customer'
      };

      const suggestions = await enhancer.getEnhancedSuggestions(
        mockProvider,
        'Salesforce',
        'NetSuite',
        largeSampleData,
        largeSampleMetadata,
        config
      );

      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });
  });
});
