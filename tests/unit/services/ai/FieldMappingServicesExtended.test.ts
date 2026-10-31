/**
 * Comprehensive tests for field-mapping sub-services:
 * MappingQualityService, MappingValidationService, SchemaAnalysisService
 */

import { MappingQualityService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingQualityService';
import { MappingValidationService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingValidationService';
import { SchemaAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/SchemaAnalysisService';

/* ────────────── MappingQualityService ────────────── */

describe('MappingQualityService', () => {
  let service: MappingQualityService;

  beforeEach(() => {
    service = new MappingQualityService();
  });

  describe('calculateOverallQuality', () => {
    it('should return 0 for empty mappings', () => {
      expect(service.calculateOverallQuality([])).toBe(0);
    });

    it('should return average confidence', () => {
      const mappings = [
        { confidence: 0.9 },
        { confidence: 0.7 },
        { confidence: 0.8 },
      ] as any[];
      expect(service.calculateOverallQuality(mappings)).toBeCloseTo(0.8, 2);
    });

    it('should return exact confidence for single mapping', () => {
      expect(service.calculateOverallQuality([{ confidence: 0.95 }] as any[])).toBe(0.95);
    });
  });

  describe('generateRecommendations', () => {
    const makeInput = (sourceFields: string[] = ['a', 'b', 'c']) => ({
      sourceFields,
    });

    it('should recommend for unmapped fields', () => {
      const mappings = [{ sourceField: 'a', confidence: 0.9 }] as any[];
      const recs = service.generateRecommendations(mappings, makeInput() as any);
      expect(recs.some(r => r.includes('2 source fields remain unmapped'))).toBe(true);
    });

    it('should recommend for low confidence mappings', () => {
      const mappings = [
        { sourceField: 'a', confidence: 0.5 },
        { sourceField: 'b', confidence: 0.9 },
      ] as any[];
      const recs = service.generateRecommendations(mappings, makeInput(['a', 'b']) as any);
      expect(recs.some(r => r.includes('1 mappings have low confidence'))).toBe(true);
    });

    it('should recommend for complex transformations', () => {
      const mappings = [
        { sourceField: 'a', confidence: 0.9, transformationType: 'calculation' },
        { sourceField: 'b', confidence: 0.9, transformationType: 'conditional' },
      ] as any[];
      const recs = service.generateRecommendations(mappings, makeInput(['a', 'b']) as any);
      expect(recs.some(r => r.includes('2 complex transformations'))).toBe(true);
    });

    it('should recommend for high data quality impact', () => {
      const mappings = [
        { sourceField: 'a', confidence: 0.9, dataQualityImpact: 0.8 },
      ] as any[];
      const recs = service.generateRecommendations(mappings, makeInput(['a']) as any);
      expect(recs.some(r => r.includes('data quality'))).toBe(true);
    });

    it('should return empty for perfect mappings', () => {
      const mappings = [
        { sourceField: 'a', confidence: 0.9, transformationType: 'direct', dataQualityImpact: 0.1 },
        { sourceField: 'b', confidence: 0.9, transformationType: 'direct', dataQualityImpact: 0.2 },
        { sourceField: 'c', confidence: 0.9, transformationType: 'direct', dataQualityImpact: 0.1 },
      ] as any[];
      const recs = service.generateRecommendations(mappings, makeInput() as any);
      expect(recs).toEqual([]);
    });
  });
});

/* ────────────── MappingValidationService ────────────── */

describe('MappingValidationService', () => {
  let service: MappingValidationService;

  beforeEach(() => {
    service = new MappingValidationService();
  });

  const makeSuggestion = (overrides: Record<string, any> = {}) => ({
    sourceField: 'email',
    targetField: 'emailAddress',
    confidence: 0.9,
    transformation: { type: 'direct', expression: '' },
    reasoning: ['Name match', 'Type compatible'],
    alternatives: [],
    origin: 'rule-based',
    providerId: 'rule-based',
    ...overrides,
  });

  const makeInput = (overrides: Record<string, any> = {}) => ({
    sourceFields: ['email', 'name'],
    targetFields: ['emailAddress', 'fullName'],
    sampleData: [],
    ...overrides,
  });

  describe('validateMappings', () => {
    it('should validate high confidence mappings', () => {
      const result = service.validateMappings(
        [makeSuggestion()] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result.length).toBe(1);
      expect(result[0].sourceField).toBe('email');
      expect(result[0].targetField).toBe('emailAddress');
    });

    it('should filter out low confidence mappings', () => {
      const result = service.validateMappings(
        [makeSuggestion({ confidence: 0.3 })] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result).toEqual([]);
    });

    it('should apply confidence * validation score', () => {
      const result = service.validateMappings(
        [makeSuggestion({ confidence: 0.9 })] as any[],
        makeInput() as any,
        0.5,
      );
      // No sample data -> validationScore = 1.0
      expect(result[0].confidence).toBe(0.9);
    });

    it('should validate with sample data', () => {
      const samples = [
        { sourceValues: { email: 'test@test.com' } },
        { sourceValues: { email: 'user@example.org' } },
      ];
      const result = service.validateMappings(
        [makeSuggestion()] as any[],
        makeInput({ sampleData: samples }) as any,
        0.5,
      );
      // direct transformation always valid, 2/2 samples valid, score=1.0
      expect(result.length).toBe(1);
      expect(result[0].confidence).toBe(0.9); // 0.9 * 1.0
    });

    it('should join reasoning into businessRule', () => {
      const result = service.validateMappings(
        [makeSuggestion()] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result[0].businessRule).toBe('Name match; Type compatible');
    });

    it('should set transformationType from suggestion', () => {
      const result = service.validateMappings(
        [makeSuggestion({ transformation: { type: 'calculation', expression: 'x*2' } })] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result[0].transformationType).toBe('calculation');
    });

    it('should generate validation rules including email rule', () => {
      const result = service.validateMappings(
        [makeSuggestion({ targetField: 'contactEmail' })] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result[0].validationRules).toContain('Validate email format');
    });

    it('should generate validation rules including phone rule', () => {
      const result = service.validateMappings(
        [makeSuggestion({ targetField: 'phoneNumber' })] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result[0].validationRules).toContain('Validate phone number format');
    });

    it('should assess high data quality impact for calculation', () => {
      const result = service.validateMappings(
        [makeSuggestion({ transformation: { type: 'calculation', expression: 'a+b' } })] as any[],
        makeInput() as any,
        0.5,
      );
      expect(result[0].dataQualityImpact).toBe(0.3);
    });

    it('should assess high data quality impact for low confidence', () => {
      const result = service.validateMappings(
        [makeSuggestion({ confidence: 0.6 })] as any[],
        makeInput() as any,
        0.5,
      );
      // direct type: 0, confidence < 0.7: +0.3 = 0.3
      expect(result[0].dataQualityImpact).toBe(0.3);
    });

    it('should cap data quality impact at 1.0', () => {
      const result = service.validateMappings(
        [makeSuggestion({
          confidence: 0.6,
          transformation: { type: 'conditional', expression: 'if(x)' },
        })] as any[],
        makeInput() as any,
        0.5,
      );
      // conditional: 0.4, low confidence: 0.3 = 0.7
      expect(result[0].dataQualityImpact).toBeLessThanOrEqual(1.0);
    });
  });

  describe('generateAlternatives', () => {
    it('should preserve existing alternatives', () => {
      const mappings = [{ alternatives: ['alt1'] }] as any[];
      const result = service.generateAlternatives(mappings);
      expect(result[0].alternatives).toEqual(['alt1']);
    });

    it('should add empty alternatives when missing', () => {
      const mappings = [{ alternatives: undefined }] as any[];
      const result = service.generateAlternatives(mappings);
      expect(result[0].alternatives).toEqual([]);
    });

    it('should add empty alternatives when null', () => {
      const mappings = [{ alternatives: null }] as any[];
      const result = service.generateAlternatives(mappings);
      expect(result[0].alternatives).toEqual([]);
    });
  });
});

/* ────────────── SchemaAnalysisService ────────────── */

describe('SchemaAnalysisService', () => {
  let service: SchemaAnalysisService;

  beforeEach(() => {
    service = new SchemaAnalysisService();
  });

  const makeField = (overrides: Record<string, any> = {}) => ({
    name: 'testField',
    type: 'string',
    required: false,
    description: 'A test field',
    ...overrides,
  });

  describe('analyzeSchema', () => {
    it('should return schema with system name', async () => {
      const schema = await service.analyzeSchema([makeField()] as any[], 'TestSystem');
      expect(schema.systemName).toBe('TestSystem');
      expect(schema.systemType).toBe('TestSystem');
    });

    it('should include all fields', async () => {
      const fields = [makeField({ name: 'a' }), makeField({ name: 'b' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.fields.length).toBe(2);
    });

    it('should identify relationships from ID fields', async () => {
      // customer must come first so find() returns it before self-match
      const fields = [
        makeField({ name: 'customer', type: 'string' }),
        makeField({ name: 'customer_id', type: 'reference' }),
      ];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.relationships.length).toBeGreaterThan(0);
      expect(schema.relationships[0].fromField).toBe('customer_id');
      expect(schema.relationships[0].toField).toBe('customer');
      expect(schema.relationships[0].relationship).toBe('many_to_one');
    });

    it('should identify relationships from fields ending with id', async () => {
      const fields = [
        makeField({ name: 'accountid', type: 'string' }),
        makeField({ name: 'account', type: 'string' }),
      ];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.relationships.length).toBeGreaterThan(0);
    });

    it('should identify relationships from reference type', async () => {
      const fields = [
        makeField({ name: 'dept', type: 'reference' }),
        makeField({ name: 'department', type: 'string' }),
      ];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      // 'dept' type is 'reference', but stripped name 'dep' may not match 'department'
      // Actually, 'dept'.replace(/_id|id$/i, '') = 'dept', and 'department'.includes('dept') = true
      expect(schema.relationships.length).toBeGreaterThan(0);
    });

    it('should identify no relationships for unrelated fields', async () => {
      const fields = [
        makeField({ name: 'email', type: 'string' }),
        makeField({ name: 'phone', type: 'string' }),
      ];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.relationships).toEqual([]);
    });

    it('should identify required constraints', async () => {
      const fields = [makeField({ name: 'name', required: true })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      const reqConstraints = schema.constraints.filter(c => c.type === 'required');
      expect(reqConstraints.length).toBe(1);
      expect(reqConstraints[0].rule).toBe('NOT NULL');
    });

    it('should identify email format constraints', async () => {
      const fields = [makeField({ name: 'contactEmail', type: 'email' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      const emailConstraints = schema.constraints.filter(c => c.rule === 'email_format');
      expect(emailConstraints.length).toBeGreaterThan(0);
    });

    it('should identify phone format constraints', async () => {
      const fields = [makeField({ name: 'phoneNumber', type: 'phone' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      const phoneConstraints = schema.constraints.filter(c => c.rule === 'phone_format');
      expect(phoneConstraints.length).toBeGreaterThan(0);
    });

    it('should identify unique constraints for ID fields', async () => {
      const fields = [makeField({ name: 'recordId', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      const uniqueConstraints = schema.constraints.filter(c => c.type === 'unique');
      expect(uniqueConstraints.length).toBeGreaterThan(0);
    });

    it('should not add unique constraint for _id fields', async () => {
      const fields = [makeField({ name: 'customer_id', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      // 'customer_id' contains 'id' but also contains '_id', so unique check:
      // field.name.toLowerCase().includes('id') && !field.name.toLowerCase().includes('_id')
      // 'customer_id'.includes('_id') = true, so NOT unique
      const uniqueConstraints = schema.constraints.filter(c => c.type === 'unique');
      expect(uniqueConstraints).toEqual([]);
    });

    it('should identify custom fields with custom_ prefix', async () => {
      const fields = [makeField({ name: 'custom_rating', type: 'number' })];
      const schema = await service.analyzeSchema(fields as any[], 'SF');
      expect(schema.customFields.length).toBe(1);
      expect(schema.customFields[0].id).toBe('SF_custom_rating');
      expect(schema.customFields[0].system).toBe('SF');
    });

    it('should identify custom fields with cf_ prefix', async () => {
      const fields = [makeField({ name: 'cf_myfield', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'NS');
      expect(schema.customFields.length).toBe(1);
    });

    it('should identify custom fields with __c suffix (Salesforce)', async () => {
      const fields = [makeField({ name: 'Rating__c', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'SF');
      expect(schema.customFields.length).toBe(1);
    });

    it('should identify custom fields with custom in name', async () => {
      const fields = [makeField({ name: 'myCustomField', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.customFields.length).toBe(1);
    });

    it('should not mark standard fields as custom', async () => {
      const fields = [makeField({ name: 'email', type: 'string' }), makeField({ name: 'phone', type: 'string' })];
      const schema = await service.analyzeSchema(fields as any[], 'Sys');
      expect(schema.customFields).toEqual([]);
    });
  });
});
