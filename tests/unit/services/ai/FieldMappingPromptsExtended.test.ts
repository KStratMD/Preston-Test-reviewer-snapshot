/**
 * Comprehensive unit tests for FieldMappingPrompts
 * Covers: buildOptimizedFieldMappingPrompt, buildOptimizedQualityPrompt,
 *         buildConfidencePrompt, extractFieldMetadata, buildUnmappableClassificationPrompt
 */
import {
  buildOptimizedFieldMappingPrompt,
  buildOptimizedQualityPrompt,
  buildConfidencePrompt,
  extractFieldMetadata,
  buildUnmappableClassificationPrompt,
  COMMON_MAPPING_EXAMPLES,
  SYSTEM_MAPPING_RULES,
} from '../../../../src/services/ai/prompts/FieldMappingPrompts';

describe('FieldMappingPrompts', () => {
  describe('COMMON_MAPPING_EXAMPLES', () => {
    it('should have at least 10 examples', () => {
      expect(COMMON_MAPPING_EXAMPLES.length).toBeGreaterThanOrEqual(10);
    });

    it('should have required fields on each example', () => {
      for (const ex of COMMON_MAPPING_EXAMPLES) {
        expect(ex.sourceField).toBeDefined();
        expect(ex.targetField).toBeDefined();
        expect(ex.transformationType).toBeDefined();
        expect(ex.confidence).toBeGreaterThan(0);
        expect(ex.reasoning).toBeDefined();
      }
    });
  });

  describe('SYSTEM_MAPPING_RULES', () => {
    it('should contain salesforce-netsuite rules', () => {
      expect(SYSTEM_MAPPING_RULES['salesforce-netsuite']).toBeDefined();
      expect(SYSTEM_MAPPING_RULES['salesforce-netsuite'].rules.length).toBeGreaterThan(0);
    });

    it('should contain businesscentral-netsuite rules', () => {
      expect(SYSTEM_MAPPING_RULES['businesscentral-netsuite']).toBeDefined();
    });
  });

  describe('buildOptimizedFieldMappingPrompt', () => {
    const fields = [
      { name: 'customer_name', type: 'string', sampleValues: ['Acme Corp'] },
      { name: 'email', type: 'string', sampleValues: ['test@test.com'] },
    ];
    const sampleData = [
      { customer_name: 'Acme Corp', email: 'test@test.com' },
    ];

    it('should include source and target system names', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, sampleData);
      expect(prompt).toContain('Salesforce');
      expect(prompt).toContain('NetSuite');
    });

    it('should include system-specific rules when available', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, sampleData);
      expect(prompt).toContain('SYSTEM-SPECIFIC RULES');
      expect(prompt).toContain('Salesforce "Account" maps to NetSuite "Customer"');
    });

    it('should not include system rules for unknown system pair', () => {
      const prompt = buildOptimizedFieldMappingPrompt('UnknownA', 'UnknownB', fields, sampleData);
      expect(prompt).not.toContain('SYSTEM-SPECIFIC RULES');
    });

    it('should include few-shot examples', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, sampleData);
      expect(prompt).toContain('EXAMPLE 1');
      expect(prompt).toContain('customer_email');
    });

    it('should include field metadata', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, sampleData);
      expect(prompt).toContain('customer_name');
      expect(prompt).toContain('email');
      expect(prompt).toContain('string');
    });

    it('should include sample values from data', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, sampleData);
      expect(prompt).toContain('Acme Corp');
    });

    it('should include transformation types guide', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, []);
      expect(prompt).toContain('direct');
      expect(prompt).toContain('lookup');
      expect(prompt).toContain('calculation');
      expect(prompt).toContain('concatenation');
    });

    it('should include confidence scoring guidelines', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, []);
      expect(prompt).toContain('CONFIDENCE SCORING GUIDELINES');
      expect(prompt).toContain('95-100%');
    });

    it('should include messy data handling instructions', () => {
      const prompt = buildOptimizedFieldMappingPrompt('Salesforce', 'NetSuite', fields, []);
      expect(prompt).toContain('MESSY DATA HANDLING');
    });
  });

  describe('buildOptimizedQualityPrompt', () => {
    const suggestions = [
      { sourceField: 'name', targetField: 'companyName', transformationType: 'direct' },
      { sourceField: 'email', targetField: 'email', transformationType: 'direct' },
    ];

    it('should include system names', () => {
      const prompt = buildOptimizedQualityPrompt(suggestions, 'Salesforce', 'NetSuite');
      expect(prompt).toContain('Salesforce');
      expect(prompt).toContain('NetSuite');
    });

    it('should list mapping summary', () => {
      const prompt = buildOptimizedQualityPrompt(suggestions, 'Salesforce', 'NetSuite');
      expect(prompt).toContain('name → companyName');
      expect(prompt).toContain('email → email');
    });

    it('should include evaluation criteria', () => {
      const prompt = buildOptimizedQualityPrompt(suggestions, 'SF', 'NS');
      expect(prompt).toContain('Completeness');
      expect(prompt).toContain('Accuracy');
      expect(prompt).toContain('Risk Assessment');
      expect(prompt).toContain('Best Practices');
    });

    it('should include JSON response format', () => {
      const prompt = buildOptimizedQualityPrompt(suggestions, 'SF', 'NS');
      expect(prompt).toContain('"overallScore"');
    });
  });

  describe('buildConfidencePrompt', () => {
    it('should include field details', () => {
      const prompt = buildConfidencePrompt('customer_name', 'companyName', 'string', 'string', ['Acme']);
      expect(prompt).toContain('customer_name');
      expect(prompt).toContain('companyName');
      expect(prompt).toContain('string');
    });

    it('should include sample values', () => {
      const prompt = buildConfidencePrompt('email', 'email', 'string', 'string', ['test@test.com', 'a@b.com']);
      expect(prompt).toContain('test@test.com');
      expect(prompt).toContain('a@b.com');
    });

    it('should filter null/undefined values', () => {
      const prompt = buildConfidencePrompt('f', 't', 'string', 'string', [null, undefined, 'valid']);
      expect(prompt).toContain('valid');
    });

    it('should limit to 5 samples', () => {
      const values = Array.from({ length: 10 }, (_, i) => `val${i}`);
      const prompt = buildConfidencePrompt('f', 't', 'string', 'string', values);
      expect(prompt).toContain('val4');
      expect(prompt).not.toContain('val5');
    });
  });

  describe('extractFieldMetadata', () => {
    it('should return empty for empty data', () => {
      expect(extractFieldMetadata([])).toEqual([]);
      expect(extractFieldMetadata(null as any)).toEqual([]);
    });

    it('should extract field names and types', () => {
      const data = [
        { name: 'John', age: 30, active: true, email: 'john@test.com' },
        { name: 'Jane', age: 25, active: false, email: 'jane@test.com' },
      ];
      const fields = extractFieldMetadata(data);
      expect(fields.length).toBe(4);

      const nameField = fields.find(f => f.name === 'name');
      expect(nameField!.type).toBe('string');

      const ageField = fields.find(f => f.name === 'age');
      expect(ageField!.type).toBe('integer');

      const activeField = fields.find(f => f.name === 'active');
      expect(activeField!.type).toBe('boolean');

      const emailField = fields.find(f => f.name === 'email');
      expect(emailField!.type).toBe('email');
    });

    it('should detect date type from string values', () => {
      const data = [{ date: '2025-01-15T10:30:00Z' }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].type).toBe('date');
    });

    it('should detect phone type', () => {
      const data = [{ phone: '+1 555-123-4567' }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].type).toBe('phone');
    });

    it('should detect decimal type', () => {
      const data = [{ price: 19.99 }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].type).toBe('decimal');
    });

    it('should detect nullable fields', () => {
      const data = [{ a: 'value' }, { a: null }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].nullable).toBe(true);
    });

    it('should detect unique fields', () => {
      const data = [{ id: 1 }, { id: 2 }, { id: 3 }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].unique).toBe(true);
    });

    it('should detect non-unique fields', () => {
      const data = [{ status: 'active' }, { status: 'active' }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].unique).toBe(false);
    });

    it('should include sample values (max 3)', () => {
      const data = [{ x: 'a' }, { x: 'b' }, { x: 'c' }, { x: 'd' }];
      const fields = extractFieldMetadata(data);
      expect(fields[0].sampleValues!.length).toBe(3);
    });

    it('should handle array and object types', () => {
      const data = [{ tags: ['a', 'b'], meta: { key: 'val' } }];
      const fields = extractFieldMetadata(data);
      expect(fields.find(f => f.name === 'tags')!.type).toBe('array');
      expect(fields.find(f => f.name === 'meta')!.type).toBe('object');
    });
  });

  describe('buildUnmappableClassificationPrompt', () => {
    it('should include field details', () => {
      const prompt = buildUnmappableClassificationPrompt(
        'customer_tier', 'string', 'Customer loyalty level',
        ['Gold', 'Silver'], 'Salesforce', 'NetSuite', 85, ['no_match']
      );
      expect(prompt).toContain('customer_tier');
      expect(prompt).toContain('string');
      expect(prompt).toContain('Customer loyalty level');
      expect(prompt).toContain('Gold');
      expect(prompt).toContain('Salesforce');
      expect(prompt).toContain('NetSuite');
      expect(prompt).toContain('85');
      expect(prompt).toContain('no_match');
    });

    it('should handle undefined description', () => {
      const prompt = buildUnmappableClassificationPrompt(
        'field', 'string', undefined,
        [], 'SF', 'NS', 50, []
      );
      expect(prompt).toContain('Not provided');
    });

    it('should handle empty red flags', () => {
      const prompt = buildUnmappableClassificationPrompt(
        'field', 'string', 'desc',
        [], 'SF', 'NS', 50, []
      );
      expect(prompt).toContain('None');
    });

    it('should include all four categories', () => {
      const prompt = buildUnmappableClassificationPrompt(
        'f', 't', 'd', [], 'SF', 'NS', 50, []
      );
      expect(prompt).toContain('business_field');
      expect(prompt).toContain('system_metadata');
      expect(prompt).toContain('technical_field');
      expect(prompt).toContain('garbage');
    });

    it('should include classification examples', () => {
      const prompt = buildUnmappableClassificationPrompt(
        'f', 't', 'd', [], 'SF', 'NS', 50, []
      );
      expect(prompt).toContain('customer_loyalty_tier');
      expect(prompt).toContain('_internal_record_id');
    });
  });
});
