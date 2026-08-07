import { TransformationEngine } from '../../../src/services/TransformationEngine';
import type { FieldMapping, TransformationRule } from '../../../src/types';

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

const buildEngine = () => new TransformationEngine(createLogger() as any);

describe('TransformationEngine', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('applies diverse field mappings and surfaces warnings/errors', async () => {
    const engine = buildEngine();

    const mappings: FieldMapping[] = [
      {
        sourceField: 'amount',
        targetField: 'totalAmount',
        transformationType: 'calculation',
        isRequired: true,
        transformationConfig: { expression: 'parseInt(amount)' }
      },
      {
        sourceField: 'firstName',
        targetField: 'customerName',
        transformationType: 'concatenation',
        isRequired: false,
        transformationConfig: { fields: ['firstName', 'lastName'], separator: ' ' }
      },
      {
        sourceField: 'lifecycle',
        targetField: 'statusCode',
        transformationType: 'lookup',
        isRequired: false,
        transformationConfig: {
          lookupTable: '{"active":"A","inactive":"I"}',
          defaultValue: 'U'
        }
      },
      {
        sourceField: 'missingOptional',
        targetField: 'optionalField',
        transformationType: 'direct',
        isRequired: false
      },
      {
        sourceField: 'missingButDefaulted',
        targetField: 'defaultedField',
        transformationType: 'direct',
        isRequired: false,
        defaultValue: 'fallback'
      },
      {
        sourceField: 'missingRequired',
        targetField: 'requiredField',
        transformationType: 'direct',
        isRequired: true
      }
    ];

    const sourceRecord: any = {
      id: '1',
      fields: {
        amount: '42',
        firstName: 'Jordan',
        lastName: 'Case',
        lifecycle: 'active'
      }
    };

    const result = await engine.transform({
      sourceData: sourceRecord,
      mappings,
      rules: []
    });

    expect(result.success).toBe(false);
    expect(result.transformedData.fields.totalAmount).toBe(42);
    expect(result.transformedData.fields.customerName).toBe('Jordan Case');
    expect(result.transformedData.fields.statusCode).toBe('A');
    expect(result.transformedData.fields.defaultedField).toBe('fallback');
    expect(result.errors.some(err => err.field === 'requiredField')).toBe(true);
    expect(result.warnings.some(msg => msg.includes('missingOptional'))).toBe(true);
  });

  it('executes transformation rules across types', async () => {
    const engine = buildEngine();

    const rules: TransformationRule[] = [
      {
        id: 'rule-field-mapping',
        name: 'copy',
        type: 'field_mapping',
        action: 'set_field_value',
        parameters: {
          sourceField: 'firstName',
          targetField: 'firstNameUpper',
          transformFunction: 'uppercase'
        } as any
      },
      {
        id: 'rule-conditional',
        name: 'status',
        type: 'conditional_logic',
        action: 'set_field_value',
        parameters: {
          targetField: 'customerStatus',
          conditions: [
            {
              operator: 'and',
              conditions: [
                { field: 'score', operator: 'greater_than', value: 500 },
                { field: 'region', operator: 'equals', value: 'US' }
              ],
              result: 'Preferred'
            }
          ],
          defaultValue: 'Standard'
        } as any
      },
      {
        id: 'rule-validation-new',
        name: 'email-format',
        type: 'data_validation',
        action: 'validate',
        parameters: {
          field: 'email',
          validationType: 'format',
          validationConfig: { pattern: '^[^@]+@[^@]+\\.[^@]+$' }
        } as any
      },
      {
        id: 'rule-validation-legacy',
        name: 'legacy-required',
        type: 'data_validation',
        action: 'validate',
        parameters: {
          rules: [
            { field: 'company', type: 'required', value: {}, message: 'Company required' }
          ]
        } as any
      },
      {
        id: 'rule-business',
        name: 'set-tier',
        type: 'business_logic',
        action: 'enrich',
        parameters: {
          type: 'business_logic',
          expression: '100',
          context: { targetField: 'customerTier' }
        } as any
      },
      {
        id: 'rule-enrichment',
        name: 'enrich',
        type: 'enrichment',
        action: 'enrich',
        parameters: {
          type: 'enrichment',
          enrichmentSource: 'crm',
          mappings: { enrichedField1: 'enrichment.one', enrichedField2: 'enrichment.two' }
        } as any
      },
      {
        id: 'rule-data-enrichment',
        name: 'tenure',
        type: 'data_enrichment',
        action: 'calculate_field',
        parameters: {
          targetField: 'tenureDays',
          calculation: 'date_diff',
          sourceField: 'joinDate',
          referenceDate: '2024-01-10T00:00:00Z',
          unit: 'days'
        } as any
      }
    ];

    const context = {
      sourceData: {
        id: '1',
        fields: {
          firstName: 'Jordan',
          score: 650,
          region: 'US',
          email: 'customer@example.com',
          company: 'Example Inc',
          annualRevenue: 250000,
          joinDate: '2023-12-31T00:00:00Z'
        }
      } as any,
      mappings: [
        {
          sourceField: 'firstName',
          targetField: 'firstName',
          transformationType: 'direct',
          isRequired: false
        }
      ],
      rules
    };

    const result = await engine.transform(context);

    expect(result.success).toBe(true);
    const fields = result.transformedData.fields as Record<string, unknown>;
    expect(fields.firstNameUpper).toBe('JORDAN');
    expect(fields.customerStatus).toBe('Preferred');
    expect(fields.enrichment).toEqual({ one: 'value1', two: 'value2' });
    expect(fields.tenureDays).toBeGreaterThan(0);
    expect(fields.customerTier).toBe(100);
  });

  it('handles validation failures and lookup shortages gracefully', async () => {
    const engine = buildEngine();

    const mappings: FieldMapping[] = [
      {
        sourceField: 'status',
        targetField: 'statusCode',
        transformationType: 'lookup',
        isRequired: true,
        transformationConfig: {
          lookupTable: '{"Active":"A"}',
          required: true
        }
      }
    ];

    const rules: TransformationRule[] = [
      {
        id: 'range-validation',
        name: 'score-range',
        type: 'data_validation',
        action: 'validate',
        parameters: {
          field: 'score',
          validationType: 'range',
          validationConfig: { min: 0, max: 100 }
        }
      }
    ];

    await expect(
      engine.transform({
        sourceData: {
          id: '1',
          fields: { status: 'Unknown', score: 200 }
        } as any,
        mappings,
        rules
      })
    ).resolves.toMatchObject({
      success: false
    });
  });

  it('supports conditional data enrichment branches', async () => {
    const engine = buildEngine();
    const rule: TransformationRule = {
      id: 'conditional-enrichment',
      name: 'banding',
      type: 'data_enrichment',
      action: 'calculate_field',
      parameters: {
        targetField: 'band',
        calculation: 'conditional',
        conditions: [
          { field: 'usage', operator: 'less_than', value: 1000, result: 'Bronze' },
          { field: 'usage', operator: 'greater_equal', value: 1000, result: 'Gold' }
        ]
      }
    };

    const result = await engine.transform({
      sourceData: {
        id: '1',
        fields: { usage: 1500 }
      } as any,
      mappings: [],
      rules: [rule]
    });

    expect(result.transformedData.fields.band).toBe('Gold');
  });

  it('throws for malformed calculation expressions', () => {
    const engine = buildEngine();
    const performCalculation = (engine as any).performCalculation.bind(engine);

    expect(() =>
      performCalculation(5, { expression: '1 +' }, { fields: {} })
    ).toThrow(/Malformed calculation expression/);
  });

  it('validates transformation rules', async () => {
    const engine = buildEngine();
    const validateRules = (engine as any).validateRules.bind(engine);

    const validRules: TransformationRule[] = [
      {
        id: 'rule1',
        type: 'field_mapping',
        action: 'set_field_value',
        parameters: { sourceField: 'a', targetField: 'b' },
      },
    ];

    const invalidRules: TransformationRule[] = [
      {
        id: '',
        type: 'field_mapping',
        action: 'set_field_value',
        parameters: { sourceField: 'a', targetField: 'b' },
      },
      {
        id: 'rule2',
        type: 'field_mapping',
        action: 'set_field_value',
        parameters: undefined,
      },
    ];

    const result1 = await validateRules(validRules);
    expect(result1.isValid).toBe(true);

    const result2 = await validateRules(invalidRules);
    expect(result2.isValid).toBe(false);
    expect(result2.errors.length).toBe(2);
  });

  it('throws for null source record', async () => {
    const engine = buildEngine();
    await expect(engine.transformRecord(null as any, [], [])).rejects.toThrow(
      'Source record cannot be null or undefined'
    );
  });

  it('handles various field mapping scenarios', async () => {
    const engine = buildEngine();

    const mappings: FieldMapping[] = [
      {
        sourceField: ['a', 'b'],
        targetField: 'c',
        transformationType: 'direct',
        isRequired: true,
      },
      {
        sourceField: 'd',
        targetField: 'e',
        transformationType: 'lookup',
        isRequired: false,
        transformationConfig: {},
      },
      {
        sourceField: 'f',
        targetField: 'g',
        transformationType: 'calculation',
        isRequired: false,
        transformationConfig: undefined,
      },
      {
        sourceField: 'h',
        targetField: 'i',
        transformationType: 'unknown' as any,
        isRequired: false,
      },
    ];

    const sourceRecord: any = {
      id: '1',
      fields: {
        a: '1',
      },
    };

    const result = await engine.transform({
      sourceData: sourceRecord,
      mappings,
      rules: [],
    });

    expect(result.success).toBe(false);
    expect(result.errors.length).toBe(3);
  });

  it('handles unknown rule type and invalid condition', async () => {
    const engine = buildEngine();

    const rules: TransformationRule[] = [
      {
        id: 'rule1',
        type: 'unknown' as any,
        action: 'action1',
        parameters: {},
      },
      {
        id: 'rule2',
        type: 'field_mapping',
        action: 'action2',
        condition: 'a b c',
        parameters: { sourceField: 'a', targetField: 'b' },
      },
    ];

    const result = await engine.transform({
      sourceData: { id: '1', fields: { a: '1' } } as any,
      mappings: [],
      rules,
    });

    expect(result.success).toBe(true);
    expect(result.warnings.length).toBe(1);
  });
});
