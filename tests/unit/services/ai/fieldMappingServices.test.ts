import { SchemaAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/SchemaAnalysisService';
import { MappingValidationService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingValidationService';
import { MappingQualityService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingQualityService';
import type {
  FieldDefinition,
  EnhancedFieldMapping,
  FieldMappingInput
} from '../../../../src/services/ai/orchestrator/interfaces';
import type { MappingSuggestion } from '../../../../src/services/ai/orchestrator/agents/fieldMappingTypes';

describe('Field Mapping helper services', () => {
  describe('SchemaAnalysisService', () => {
    const service = new SchemaAnalysisService();

    it('infers relationships, constraints, and custom fields', async () => {
      const fields: FieldDefinition[] = [
        { name: 'customer', type: 'string', description: 'Customer name' },
        { name: 'customer_id', type: 'string', required: true },
        { name: 'primary_email', type: 'email' },
        { name: 'custom__c', type: 'string', description: 'Custom flag' }
      ];

      const schema = await service.analyzeSchema(fields, 'TestSystem');

      expect(schema.systemName).toBe('TestSystem');
      expect(schema.relationships).toEqual([
        {
          fromField: 'customer_id',
          toField: 'customer',
          relationship: 'many_to_one',
          required: true
        }
      ]);
      expect(schema.constraints).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: 'customer_id', type: 'required' }),
          expect.objectContaining({ field: 'primary_email', type: 'format', rule: 'email_format' })
        ])
      );
      expect(schema.customFields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 'TestSystem_custom__c',
            name: 'custom__c',
            description: 'Custom flag'
          })
        ])
      );
    });
  });

  describe('MappingValidationService', () => {
    const service = new MappingValidationService();

    const suggestion = (overrides: Partial<MappingSuggestion> = {}): MappingSuggestion => ({
      sourceField: 'email',
      targetField: 'email_address',
      confidence: 0.9,
      reasoning: ['AI match', 'High similarity'],
      transformation: { type: 'direct' },
      alternatives: [],
      qualityMetrics: {
        semanticSimilarity: 0.9,
        dataTypeCompatibility: 1,
        businessLogicAlignment: 0.8,
        historicalSuccess: 0.7,
        riskAssessment: 'low'
      },
      origin: 'llm',
      ...overrides
    });

    const input: FieldMappingInput = {
      sourceFields: [{ name: 'email', type: 'string' }],
      targetFields: [{ name: 'email_address', type: 'string' }],
      sampleData: [
        { sourceValues: { email: 'test@example.com' } },
        { sourceValues: { email: 'invalid' } }
      ]
    };

    it('filters and enriches suggestions using sample data', () => {
      const validated = service.validateMappings(
        [suggestion(), suggestion({ confidence: 0.3 })],
        input,
        0.5
      );

      expect(validated).toHaveLength(1);
      expect(validated[0]).toMatchObject({
        sourceField: 'email',
        targetField: 'email_address',
        validationRules: expect.arrayContaining(['Validate email format']),
        dataQualityImpact: expect.any(Number)
      });
    });

    it('retains explicit alternatives without fabricating new ones', () => {
      const validated = service.validateMappings(
        [suggestion({ alternatives: [{ targetField: 'email', confidence: 0.6, transformationType: 'direct', explanation: 'Backup' }] })],
        input,
        0.5
      );

      const enhanced = service.generateAlternatives(validated);
      expect(enhanced[0].alternatives).toHaveLength(1);
    });
  });

  describe('MappingQualityService', () => {
    const service = new MappingQualityService();

    const mappings: EnhancedFieldMapping[] = [
      {
        sourceField: 'email',
        targetField: 'email_address',
        confidence: 0.9,
        transformationType: 'direct',
        alternatives: [],
        validationRules: [],
        businessRule: '',
        dataQualityImpact: 0.2,
        origin: 'llm'
      },
      {
        sourceField: 'phone',
        targetField: 'contact_phone',
        confidence: 0.6,
        transformationType: 'conditional',
        alternatives: [],
        validationRules: [],
        businessRule: '',
        dataQualityImpact: 0.8,
        origin: 'heuristic'
      }
    ];

    const context: FieldMappingInput = {
      sourceFields: [
        { name: 'email', type: 'string' },
        { name: 'phone', type: 'string' },
        { name: 'address', type: 'string' }
      ],
      targetFields: [
        { name: 'email_address', type: 'string' },
        { name: 'contact_phone', type: 'string' }
      ]
    };

    it('calculates average confidence', () => {
      const score = service.calculateOverallQuality(mappings);
      expect(score).toBeCloseTo((0.9 + 0.6) / 2);
    });

    it('produces actionable recommendations', () => {
      const recommendations = service.generateRecommendations(mappings, context);
      expect(recommendations).toEqual(
        expect.arrayContaining([
          '1 source fields remain unmapped - review for completeness',
          '1 mappings have low confidence - consider manual review',
          '1 mappings may impact data quality - implement validation'
        ])
      );
    });
  });
});
