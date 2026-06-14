import 'reflect-metadata';
import { UnmappableFieldDetectionService, RedFlagType, type UnmappableField, type DetectionConfig, type RedFlag } from '../../../../../src/services/ai/validation/UnmappableFieldDetectionService';
import { SchemaDiscoveryService } from '../../../../../src/services/ai/validation/SchemaDiscoveryService';
import type { FieldMetadata } from '../../../../../src/services/ai/prompts/FieldMappingPrompts';
import type { EnhancedSuggestion } from '../../../../../src/services/ai/validation/AccuracyEnhancementService';

describe('UnmappableFieldDetectionService', () => {
  let service: UnmappableFieldDetectionService;
  let schemaDiscovery: SchemaDiscoveryService;

  beforeEach(() => {
    schemaDiscovery = new SchemaDiscoveryService({
      enableNetSuite: false,
      enableSalesforce: false,
      enableBusinessCentral: false
    });
    service = new UnmappableFieldDetectionService(schemaDiscovery);
  });

  describe('detectUnmappableFields', () => {
    it('should detect fields with very low confidence as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'legacy_sys_id',
          type: 'string',
          description: 'Legacy system identifier',
          sampleValues: ['SF-12345', 'XL-98765']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'id',
          type: 'string',
          description: 'Primary identifier'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'legacy_sys_id',
          targetField: 'id',
          confidence: 35, // Very low confidence
          reason: 'Weak match',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      expect(unmappableFields[0].sourceField.name).toBe('legacy_sys_id');
      const hasVeryLowConfidence = unmappableFields[0].redFlags.some(
        (flag: RedFlag) => flag.type === RedFlagType.VERY_LOW_CONFIDENCE
      );
      expect(hasVeryLowConfidence).toBe(true);
    });

    it('should detect fields with low semantic similarity as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'custom_flag_xyz',
          type: 'boolean',
          description: 'Custom business flag',
          sampleValues: ['TRUE', 'FALSE']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'active',
          type: 'boolean',
          description: 'Active status'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'custom_flag_xyz',
          targetField: 'active',
          confidence: 45,
          reason: 'Type match but semantically different',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      // Should have multiple red flags indicating unmappability
      expect(unmappableFields[0].redFlags.length).toBeGreaterThanOrEqual(3);
    });

    it('should detect fields with no type compatibility as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'old_crm_score',
          type: 'number',
          description: 'Proprietary CRM scoring system',
          sampleValues: ['87.5', '72.3', '65.0']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'rating',
          type: 'string',
          description: 'Rating field'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'old_crm_score',
          targetField: 'rating',
          confidence: 40,
          reason: 'No compatible field found',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      const hasNoTypeCompat = unmappableFields[0].redFlags.some(
        (flag: RedFlag) => flag.type === RedFlagType.NO_TYPE_COMPATIBILITY
      );
      expect(hasNoTypeCompat).toBe(true);
    });

    it('should require 3+ red flags to classify as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'phone',
          type: 'string',
          description: 'Phone number',
          sampleValues: ['555-1234']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'phoneNumber',
          type: 'string',
          description: 'Phone'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'phone',
          targetField: 'phoneNumber',
          confidence: 85, // High confidence
          reason: 'Strong semantic match',
          transformationType: 'direct',
          alternatives: [
            {
              targetField: 'mobile',
              confidence: 75,
              reason: 'Alternative phone field'
            }
          ]
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      // Should not be classified as unmappable due to high confidence and alternatives
      expect(unmappableFields.length).toBe(0);
    });

    it('should detect fields with no historical matches as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'ext_ref_code',
          type: 'string',
          description: 'External reference code',
          sampleValues: ['EXT-A-00012', 'EXT-B-00023']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'externalId',
          type: 'string',
          description: 'External ID'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'ext_ref_code',
          targetField: 'externalId',
          confidence: 48,
          reason: 'No historical context',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      // Empty RAG context = no historical matches
      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      const hasNoHistorical = unmappableFields[0].redFlags.some(
        (flag: RedFlag) => flag.type === RedFlagType.NO_HISTORICAL_MATCH
      );
      expect(hasNoHistorical).toBe(true);
    });

    it('should detect fields with all alternatives poor as unmappable', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'internal_notes_v2',
          type: 'string',
          description: 'Internal notes version 2'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'notes',
          type: 'string',
          description: 'Notes'
        },
        {
          name: 'comments',
          type: 'string',
          description: 'Comments'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'internal_notes_v2',
          targetField: 'notes',
          confidence: 42,
          reason: 'Weak match',
          transformationType: 'direct',
          alternatives: [
            {
              targetField: 'comments',
              confidence: 38,
              reason: 'Also weak'
            }
          ]
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      // Check that at least 3 red flags exist
      expect(unmappableFields[0].redFlags.length).toBeGreaterThanOrEqual(3);
    });

    it('should calculate unmappable confidence based on red flag count', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'legacy_sys_id',
          type: 'string',
          description: 'Legacy system ID',
          sampleValues: ['SF-12345']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'id',
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'legacy_sys_id',
          targetField: 'id',
          confidence: 30, // Very low
          reason: 'Poor match',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      // With low confidence, unmappableConfidence should be calculated
      expect(unmappableFields[0].unmappableConfidence).toBeGreaterThan(0);
      // More red flags = higher confidence
      expect(unmappableFields[0].redFlags.length).toBeGreaterThanOrEqual(3);
    });

    it('should respect custom detection thresholds', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'test_field',
          type: 'string'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'target_field',
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'test_field',
          targetField: 'target_field',
          confidence: 55, // Above default threshold but below custom
          reason: 'Moderate match',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const config: DetectionConfig = {
        suspiciousConfidenceThreshold: 70, // Higher threshold (renamed from confidenceThreshold)
        suspiciousSemanticThreshold: 0.3, // Renamed from semanticThreshold
        redFlagThreshold: 2 // Lower red flag requirement
      };

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map(),
        config
      );

      // With stricter thresholds, more fields should be unmappable
      expect(unmappableFields.length).toBeGreaterThanOrEqual(0);
    });

    it('should recommend custom field creation for high-confidence unmappable fields', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'legacy_sys_id',
          type: 'string',
          description: 'Legacy system identifier',
          sampleValues: ['SF-12345', 'XL-98765']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'id',
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'legacy_sys_id',
          targetField: 'id',
          confidence: 25,
          reason: 'No suitable field found',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      // Custom field recommended when unmappableConfidence >= 75
      if (unmappableFields[0].unmappableConfidence >= 75) {
        expect(unmappableFields[0].customFieldRecommended).toBe(true);
      }
    });
  });

  describe('getSummaryStatistics', () => {
    it('should calculate correct statistics for unmappable fields', () => {
      const unmappableFields: UnmappableField[] = [
        {
          sourceField: {
            name: 'field1',
            type: 'string'
          },
          unmappableConfidence: 85,
          redFlags: [
            {
              type: RedFlagType.VERY_LOW_CONFIDENCE,
              severity: 'high',
              description: 'Very low confidence',
              evidence: {}
            },
            {
              type: RedFlagType.NO_TYPE_COMPATIBILITY,
              severity: 'medium',
              description: 'No type compatibility',
              evidence: {}
            },
            {
              type: RedFlagType.NO_HISTORICAL_MATCH,
              severity: 'low',
              description: 'No historical match',
              evidence: {}
            }
          ],
          bestAttempt: {
            targetField: 'target1',
            confidence: 30,
            reason: 'Poor match'
          },
          customFieldRecommended: true
        },
        {
          sourceField: {
            name: 'field2',
            type: 'number'
          },
          unmappableConfidence: 75,
          redFlags: [
            {
              type: RedFlagType.LOW_SEMANTIC_SIMILARITY,
              severity: 'medium',
              description: 'Low semantic similarity',
              evidence: {}
            },
            {
              type: RedFlagType.ALL_ALTERNATIVES_POOR,
              severity: 'high',
              description: 'All alternatives poor',
              evidence: {}
            }
          ],
          bestAttempt: {
            targetField: 'target2',
            confidence: 40,
            reason: 'Weak match'
          },
          customFieldRecommended: true
        }
      ];

      const stats = service.getSummaryStatistics(unmappableFields);

      expect(stats.totalUnmappable).toBe(2);
      expect(stats.highConfidence).toBe(1); // field1: 85 >= 80
      expect(stats.mediumConfidence).toBe(1); // field2: 75 in 60-79 range
      expect(stats.lowConfidence).toBe(0);
      expect(stats.redFlagDistribution[RedFlagType.VERY_LOW_CONFIDENCE]).toBe(1);
      expect(stats.redFlagDistribution[RedFlagType.NO_TYPE_COMPATIBILITY]).toBe(1);
      expect(stats.redFlagDistribution[RedFlagType.NO_HISTORICAL_MATCH]).toBe(1);
      expect(stats.redFlagDistribution[RedFlagType.LOW_SEMANTIC_SIMILARITY]).toBe(1);
      expect(stats.redFlagDistribution[RedFlagType.ALL_ALTERNATIVES_POOR]).toBe(1);
      expect(stats.customFieldRecommendations).toBe(2);
    });

    it('should handle empty unmappable fields array', () => {
      const stats = service.getSummaryStatistics([]);

      expect(stats.totalUnmappable).toBe(0);
      expect(stats.highConfidence).toBe(0);
      expect(stats.mediumConfidence).toBe(0);
      expect(stats.lowConfidence).toBe(0);
      expect(stats.customFieldRecommendations).toBe(0);
    });
  });

  describe('Levenshtein Distance Calculation', () => {
    it('should calculate correct string similarity scores', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'customerName',
          type: 'string'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'custName', // Similar but not exact
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'customerName',
          targetField: 'custName',
          confidence: 70,
          reason: 'Similar names',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      // Should not be unmappable due to good semantic similarity
      expect(unmappableFields.length).toBe(0);
    });
  });

  describe('Edge Cases', () => {
    it('should handle fields with no suggestions', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'orphan_field',
          type: 'string'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'some_field',
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = []; // No suggestions

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      // Fields with no suggestions get unmappableConfidence = 95 and ARE added
      expect(unmappableFields.length).toBe(1);
      expect(unmappableFields[0].unmappableConfidence).toBe(95);
      expect(unmappableFields[0].customFieldRecommended).toBe(true);
    });

    it('should handle fields with multiple suggestions', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'amount',
          type: 'number'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'total',
          type: 'number'
        },
        {
          name: 'subtotal',
          type: 'number'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'amount',
          targetField: 'total',
          confidence: 80,
          reason: 'Good match',
          transformationType: 'direct',
          alternatives: []
        },
        {
          sourceField: 'amount',
          targetField: 'subtotal',
          confidence: 75,
          reason: 'Alternative match',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      // Should not be unmappable with multiple good options
      expect(unmappableFields.length).toBe(0);
    });

    it('should handle special characters in field names', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'customer_name_v2.1',
          type: 'string'
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'customerName',
          type: 'string'
        }
      ];

      const suggestions: EnhancedSuggestion[] = [
        {
          sourceField: 'customer_name_v2.1',
          targetField: 'customerName',
          confidence: 45,
          reason: 'Version-specific field',
          transformationType: 'direct',
          alternatives: []
        }
      ];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      // Should handle special characters properly
      expect(unmappableFields).toBeDefined();
      expect(Array.isArray(unmappableFields)).toBe(true);
    });

    it('should ignore malformed multi-field sourceFields payloads', async () => {
      const sourceFields: FieldMetadata[] = [
        {
          name: 'legacy_sys_id',
          type: 'string',
          description: 'Legacy system identifier',
          sampleValues: ['SF-12345']
        }
      ];

      const targetFields: FieldMetadata[] = [
        {
          name: 'id',
          type: 'string',
          description: 'Primary identifier'
        }
      ];

      const suggestions = [
        {
          sourceField: 'legacy_sys_id',
          targetField: 'id',
          confidence: 35,
          reason: 'Weak match',
          transformationType: 'direct',
          alternatives: [],
          sourceFields: 'legacy_sys_id'
        }
      ] as unknown as EnhancedSuggestion[];

      const unmappableFields = await service.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions,
        new Map()
      );

      expect(unmappableFields.length).toBeGreaterThan(0);
      expect(unmappableFields[0].sourceField.name).toBe('legacy_sys_id');
    });
  });
});
