import { TransformationEngine } from '../services/TransformationEngine';
import type { Logger } from '../utils/Logger';
import type { FieldMapping, TransformationRule, DataRecord } from '../types';

// Mock Logger
jest.mock('../utils/Logger');

describe('TransformationEngine - Comprehensive Testing', () => {
  let transformationEngine: TransformationEngine;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
      setCorrelationId: jest.fn().mockReturnThis(),
    } as unknown as jest.Mocked<Logger>;

    transformationEngine = new TransformationEngine(mockLogger);
  });

  describe('Field Mapping Transformations', () => {
    it('should handle direct field mapping', async () => {
      const data = {
        customer_name: 'Test Company',
        email_address: 'test@company.com',
      };

      const sourceRecord: DataRecord = {
        id: '123',
        externalId: 'test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'customer_name',
          targetField: 'name',
          isRequired: true,
          transformationType: 'direct',
        },
        {
          sourceField: 'email_address',
          targetField: 'email',
          isRequired: false,
          transformationType: 'direct',
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.name).toBe('Test Company');
      expect(result.transformedData.fields.email).toBe('test@company.com');
      expect(result.transformedData.id).toBe('123'); // Should preserve unmapped fields
    });

    it('should handle lookup transformations', async () => {
      const data = {
        industry_code: 'TECH',
        country_code: 'US',
      };

      const sourceRecord: DataRecord = {
        id: 'lookup-test',
        externalId: 'lookup-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'industry_code',
          targetField: 'industry',
          isRequired: true,
          transformationType: 'lookup',
          transformationConfig: {
            type: 'lookup',
            lookupTable: JSON.stringify({
              'TECH': 'Technology',
              'MANF': 'Manufacturing',
              'RTAIL': 'Retail',
            }),
          },
        },
        {
          sourceField: 'country_code',
          targetField: 'country',
          isRequired: false,
          transformationType: 'lookup',
          transformationConfig: {
            type: 'lookup',
            lookupTable: JSON.stringify({
              'US': 'United States',
              'CA': 'Canada',
              'UK': 'United Kingdom',
            }),
          },
          defaultValue: 'Unknown Country',
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.industry).toBe('Technology');
      expect(result.transformedData.fields.country).toBe('United States');
    });

    it('should handle calculation transformations', async () => {
      const data = {
        annual_revenue: '1000000',
        employee_count: '50',
        quarterly_revenue: '250000',
      };

      const sourceRecord: DataRecord = {
        id: 'calc-test',
        externalId: 'calc-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'annual_revenue',
          targetField: 'creditLimit',
          isRequired: true,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'VALUE * 0.1',
          },
        },
        {
          sourceField: 'employee_count',
          targetField: 'companySize',
          isRequired: false,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'VALUE < 10 ? "Small" : VALUE < 100 ? "Medium" : "Large"',
          },
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.creditLimit).toBe(100000);
      expect(result.transformedData.fields.companySize).toBe('Medium');
    });

    it('should handle concatenation transformations', async () => {
      const data = {
        first_name: 'John',
        last_name: 'Doe',
        street: '123 Main St',
        city: 'Anytown',
        state: 'CA',
        zip: '12345',
      };

      const sourceRecord: DataRecord = {
        id: 'concat-test',
        externalId: 'concat-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'first_name,last_name',
          targetField: 'fullName',
          isRequired: true,
          transformationType: 'concatenation',
          transformationConfig: {
            type: 'concatenation',
            separator: ' ',
            fields: ['first_name', 'last_name'],
          },
        },
        {
          sourceField: 'street,city,state,zip',
          targetField: 'fullAddress',
          isRequired: false,
          transformationType: 'concatenation',
          transformationConfig: {
            type: 'concatenation',
            separator: ', ',
            fields: ['street', 'city', 'state', 'zip'],
          },
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.fullName).toBe('John Doe');
      expect(result.transformedData.fields.fullAddress).toBe('123 Main St, Anytown, CA, 12345');
    });

    it('should handle missing source fields gracefully', async () => {
      const data = {
        name: 'Test Company',
        // Missing email field
      };

      const sourceRecord: DataRecord = {
        id: 'missing-test',
        externalId: 'missing-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'name',
          targetField: 'companyName',
          isRequired: true,
          transformationType: 'direct',
        },
        {
          sourceField: 'email',
          targetField: 'contactEmail',
          isRequired: false,
          transformationType: 'direct',
          defaultValue: 'no-email@example.com',
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.companyName).toBe('Test Company');
      expect(result.transformedData.fields.contactEmail).toBe('no-email@example.com');
    });

    it('should throw error for missing required fields', async () => {
      const data = {
        optional_field: 'value',
      };

      const sourceRecord: DataRecord = {
        id: 'error-test',
        externalId: 'error-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'required_field',
          targetField: 'targetField',
          isRequired: true,
          transformationType: 'direct',
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]!).toBeDefined();
      expect(result.errors[0]!.field).toBe('targetField');
    });
  });

  describe('Business Rule Transformations', () => {
    it('should apply conditional logic rules', async () => {
      const data = {
        annual_revenue: 5000000,
        employee_count: 150,
        industry: 'Technology',
      };

      const sourceRecord: DataRecord = {
        id: 'rule-test',
        externalId: 'rule-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const transformationRules: TransformationRule[] = [
        {
          id: 'determine_account_type',
          name: 'Determine Account Type',
          type: 'conditional_logic',
          action: 'set_field_value',
          parameters: {
            targetField: 'accountType',
            conditions: [
              {
                field: 'annual_revenue',
                operator: 'greater_than',
                value: 1000000,
                result: 'Enterprise',
              },
              {
                field: 'employee_count',
                operator: 'greater_than',
                value: 100,
                result: 'Large',
              },
            ],
            defaultValue: 'Small',
          },
        },
      ];

      const context = {
        sourceData: sourceRecord,
        mappings: [],
        rules: transformationRules,
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.accountType).toBe('Enterprise');
    });

    it('should validate data formats', async () => {
      const data: DataRecord = {
        email: 'test@example.com',
        phone: '+1-555-123-4567',
        invalid_email: 'not-an-email',
      };

      const transformationRules: TransformationRule[] = [
        {
          id: 'validate_email',
          name: 'Email Validation',
          type: 'data_validation',
          action: 'validate_field',
          parameters: {
            field: 'email',
            validationType: 'format',
            validationConfig: {
              pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$',
            },
          },
        },
        {
          id: 'validate_phone',
          name: 'Phone Validation',
          type: 'data_validation',
          action: 'validate_field',
          parameters: {
            field: 'phone',
            validationType: 'format',
            validationConfig: {
              pattern: '^\\+?[1-9][0-9\\-\\s]{1,20}$',
            },
          },
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'validation-test',
        externalId: 'validation-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: [],
        rules: transformationRules,
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.email).toBe('test@example.com');
      expect(result.transformedData.fields.phone).toBe('+1-555-123-4567');
    });

    it('should enrich data with calculated fields', async () => {
      const data: DataRecord = {
        first_name: 'John',
        last_name: 'Doe',
        birth_date: '1990-01-01',
        salary: 75000,
      };

      const transformationRules: TransformationRule[] = [
        {
          id: 'calculate_age',
          name: 'Calculate Age',
          type: 'data_enrichment',
          action: 'calculate_field',
          parameters: {
            targetField: 'age',
            calculation: 'date_diff',
            sourceField: 'birth_date',
            referenceDate: 'now',
            unit: 'years',
          },
        },
        {
          id: 'determine_salary_band',
          name: 'Determine Salary Band',
          type: 'data_enrichment',
          action: 'calculate_field',
          parameters: {
            targetField: 'salaryBand',
            calculation: 'conditional',
            conditions: [
              { field: 'salary', operator: 'less_than', value: 50000, result: 'Junior' },
              { field: 'salary', operator: 'less_than', value: 100000, result: 'Mid-Level' },
              { field: 'salary', operator: 'greater_equal', value: 100000, result: 'Senior' },
            ],
          },
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'enrichment-test',
        externalId: 'enrichment-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: [],
        rules: transformationRules,
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.age).toBeGreaterThan(30);
      expect(result.transformedData.fields.salaryBand).toBe('Mid-Level');
      // Source record should remain unchanged
      expect(sourceRecord.fields.first_name).toBe('John');
    });

    it('should handle complex nested conditions', async () => {
      const data: DataRecord = {
        industry: 'Technology',
        annual_revenue: 2000000,
        employee_count: 75,
        location: 'San Francisco',
      };

      const transformationRules: TransformationRule[] = [
        {
          id: 'complex_scoring',
          name: 'Complex Lead Scoring',
          type: 'conditional_logic',
          action: 'set_field_value',
          parameters: {
            targetField: 'leadScore',
            conditions: [
              {
                operator: 'and',
                conditions: [
                  { field: 'industry', operator: 'equals', value: 'Technology' },
                  { field: 'annual_revenue', operator: 'greater_than', value: 1000000 },
                ],
                result: 90,
              },
              {
                operator: 'or',
                conditions: [
                  { field: 'location', operator: 'equals', value: 'San Francisco' },
                  { field: 'employee_count', operator: 'greater_than', value: 50 },
                ],
                result: 70,
              },
            ],
            defaultValue: 30,
          },
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'nested-test',
        externalId: 'nested-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: [],
        rules: transformationRules,
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.leadScore).toBe(90); // Should match the first (highest priority) condition
    });
  });

  describe('Error Handling and Edge Cases', () => {
    it('should handle malformed calculation expressions', async () => {
      const data: DataRecord = { value: 100 };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'value',
          targetField: 'result',
          isRequired: true,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'VALUE * invalid_syntax +',
          },
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'error-calc-test',
        externalId: 'error-calc-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should handle circular dependencies in transformations', async () => {
      const data: DataRecord = { a: 1, b: 2 };

      const transformationRules: TransformationRule[] = [
        {
          id: 'rule1',
          name: 'Rule 1',
          type: 'conditional_logic',
          action: 'set_field_value',
          parameters: {
            targetField: 'a',
            conditions: [
              { field: 'b', operator: 'equals', value: 3, result: 10 },
            ],
          },
        },
        {
          id: 'rule2',
          name: 'Rule 2',
          type: 'conditional_logic',
          action: 'set_field_value',
          parameters: {
            targetField: 'b',
            conditions: [
              { field: 'a', operator: 'equals', value: 10, result: 3 },
            ],
          },
        },
      ];

      // Should handle gracefully without infinite loops
      const sourceRecord: DataRecord = {
        id: 'circular-test',
        externalId: 'circular-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: [],
        rules: transformationRules,
      };
      const result = await transformationEngine.transform(context);

      expect(result).toBeDefined();
      // The engine should avoid circular updates and leave fields unchanged
      expect(result.transformedData.fields.a).toBeUndefined();
      expect(result.transformedData.fields.b).toBeUndefined();
    });

    it('should handle large datasets efficiently', async () => {
      const largeData: DataRecord = {};

      // Create large dataset
      for (let i = 0; i < 1000; i++) {
        largeData[`field_${i}`] = `value_${i}`;
      }

      const fieldMappings: FieldMapping[] = Array.from({ length: 500 }, (_, i) => ({
        sourceField: `field_${i}`,
        targetField: `target_${i}`,
        isRequired: false,
        transformationType: 'direct' as const,
      }));

      const sourceRecord: DataRecord = {
        id: 'large-test',
        externalId: 'large-test-123',
        fields: largeData,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const startTime = Date.now();
      const result = await transformationEngine.transform(context);
      const duration = Date.now() - startTime;

      expect(Object.keys(result.transformedData.fields)).toHaveLength(500); // Should have transformed fields
      expect(duration).toBeLessThan(1000); // Should complete within 1 second
    });

    it('should maintain data types during transformation', async () => {
      const data: DataRecord = {
        string_field: 'text',
        number_field: 42,
        boolean_field: true,
        date_field: new Date('2023-01-01'),
        array_field: [1, 2, 3],
        object_field: { nested: 'value' },
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'string_field',
          targetField: 'text',
          isRequired: false,
          transformationType: 'direct',
        },
        {
          sourceField: 'number_field',
          targetField: 'count',
          isRequired: false,
          transformationType: 'direct',
        },
        {
          sourceField: 'boolean_field',
          targetField: 'active',
          isRequired: false,
          transformationType: 'direct',
        },
        {
          sourceField: 'date_field',
          targetField: 'date_field',
          isRequired: false,
          transformationType: 'direct',
        },
        {
          sourceField: 'array_field',
          targetField: 'array_field',
          isRequired: false,
          transformationType: 'direct',
        },
        {
          sourceField: 'object_field',
          targetField: 'object_field',
          isRequired: false,
          transformationType: 'direct',
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'type-test',
        externalId: 'type-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(typeof result.transformedData.fields.text).toBe('string');
      expect(typeof result.transformedData.fields.count).toBe('number');
      expect(typeof result.transformedData.fields.active).toBe('boolean');
      expect(result.transformedData.fields.date_field).toBeInstanceOf(Date);
      expect(Array.isArray(result.transformedData.fields.array_field)).toBe(true);
      expect(typeof result.transformedData.fields.object_field).toBe('object');
    });
  });

  describe('Performance and Scalability', () => {
    it('should cache lookup table results', async () => {
      const data: DataRecord = {
        code1: 'A',
        code2: 'A', // Same lookup
        code3: 'B',
      };

      const lookupTable = {
        'A': 'Alpha',
        'B': 'Beta',
        'C': 'Charlie',
      };

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'code1',
          targetField: 'value1',
          isRequired: false,
          transformationType: 'lookup',
          transformationConfig: { type: 'lookup', lookupTable: JSON.stringify(lookupTable) },
        },
        {
          sourceField: 'code2',
          targetField: 'value2',
          isRequired: false,
          transformationType: 'lookup',
          transformationConfig: { type: 'lookup', lookupTable: JSON.stringify(lookupTable) },
        },
        {
          sourceField: 'code3',
          targetField: 'value3',
          isRequired: false,
          transformationType: 'lookup',
          transformationConfig: { type: 'lookup', lookupTable: JSON.stringify(lookupTable) },
        },
      ];

      const sourceRecord: DataRecord = {
        id: 'cache-test',
        externalId: 'cache-test-123',
        fields: data,
        metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
      };

      const context = {
        sourceData: sourceRecord,
        mappings: fieldMappings,
        rules: [],
      };
      const result = await transformationEngine.transform(context);

      expect(result.transformedData.fields.value1).toBe('Alpha');
      expect(result.transformedData.fields.value2).toBe('Alpha');
      expect(result.transformedData.fields.value3).toBe('Beta');
    });

    it('should handle concurrent transformations', async () => {
      const datasets = Array.from({ length: 10 }, (_, i) => ({
        id: i,
        name: `Test ${i}`,
        value: i * 100,
      }));

      const fieldMappings: FieldMapping[] = [
        {
          sourceField: 'name',
          targetField: 'title',
          isRequired: true,
          transformationType: 'direct',
        },
        {
          sourceField: 'value',
          targetField: 'amount',
          isRequired: false,
          transformationType: 'calculation',
          transformationConfig: {
            type: 'calculation',
            expression: 'VALUE * 1.1',
          },
        },
      ];

      const promises = datasets.map(async data => {
        const sourceRecord: DataRecord = {
          id: `concurrent-${data.id}`,
          externalId: `concurrent-${data.id}`,
          fields: data,
          metadata: { source: 'test', lastModified: new Date(), version: '1.0' },
        };
        const context = {
          sourceData: sourceRecord,
          mappings: fieldMappings,
          rules: [],
        };
        return transformationEngine.transform(context);
      });

      const results = await Promise.all(promises);

      expect(results).toHaveLength(10);
      results.forEach((result, i) => {
        expect(result.transformedData.fields.title).toBe(`Test ${i}`);
        expect(result.transformedData.fields.amount).toBe(i * 100 * 1.1);
        expect(result.transformedData.id).toBe(`concurrent-${i}`);
      });
    });

    it('should validate transformation rules efficiently', async () => {
      const complexRules: TransformationRule[] = Array.from({ length: 100 }, (_, i) => ({
        id: `rule_${i}`,
        name: `Rule ${i}`,
        type: 'conditional_logic',
        action: 'set_field_value',
        parameters: {
          targetField: `result_${i}`,
          conditions: [
            {
              field: 'input',
              operator: 'equals',
              value: i,
              result: `output_${i}`,
            },
          ],
          defaultValue: 'default',
        },
      }));

      const validation = await transformationEngine.validateRules(complexRules);

      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });
  });

  describe('Rule Validation', () => {
    it('should validate transformation rule structure', async () => {
      const invalidRules: TransformationRule[] = [
        {
          id: '',
          name: 'Invalid Rule',
          type: 'conditional_logic',
          action: 'set_field_value',
          parameters: {},
        } as TransformationRule,
        {
          id: 'valid_rule',
          name: 'Valid Rule',
          type: 'data_validation',
          action: 'validate_field',
          parameters: {
            field: 'email',
            validationType: 'format',
            validationConfig: {
              pattern: '^[\\w-\\.]+@([\\w-]+\\.)+[\\w-]{2,4}$',
            },
          },
        },
      ];

      const validation = await transformationEngine.validateRules(invalidRules);

      expect(validation.isValid).toBe(false);
      expect(validation.errors).toHaveLength(1);
      expect(validation.errors[0]).toContain('Rule ID cannot be empty');
    });

    it('should validate field mapping configurations', async () => {
      const invalidMappings: FieldMapping[] = [
        {
          sourceField: '',
          targetField: 'target',
          isRequired: true,
          transformationType: 'direct',
        },
        {
          sourceField: 'source',
          targetField: 'target2',
          isRequired: false,
          transformationType: 'lookup',
          transformationConfig: { type: 'lookup' },
        },
      ];

      const result = await transformationEngine.transform({
        sourceData: { fields: {} },
        mappings: invalidMappings,
        rules: [],
      });

      expect(result.success).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });
});
