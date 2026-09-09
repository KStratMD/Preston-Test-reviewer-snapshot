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
        transformationConfig: { type: 'calculation', expression: 'parseInt(amount)' }
      },
      {
        sourceField: 'firstName',
        targetField: 'customerName',
        transformationType: 'concatenation',
        isRequired: false,
        transformationConfig: { type: 'concatenation', fields: ['firstName', 'lastName'], separator: ' ' }
      },
      {
        sourceField: 'lifecycle',
        targetField: 'statusCode',
        transformationType: 'lookup',
        isRequired: false,
        transformationConfig: {
          type: 'lookup',
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
          type: 'lookup',
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

  it('rejects a structurally invalid mapping set as ONE general error and executes nothing (Task A2)', async () => {
    // Before Task A2 these four mappings produced three per-field errors and
    // the invalid `unknown` type passed its value through. The contract now
    // rejects the SET up front: an array sourceField, a `{}` lookup config,
    // a calculation with no config, and an unknown type are all structural.
    const engine = buildEngine();

    const mappings: FieldMapping[] = [
      { sourceField: ['a', 'b'] as any, targetField: 'c', transformationType: 'direct', isRequired: true },
      { sourceField: 'd', targetField: 'e', transformationType: 'lookup', isRequired: false, transformationConfig: {} as any },
      { sourceField: 'f', targetField: 'g', transformationType: 'calculation', isRequired: false, transformationConfig: undefined },
      { sourceField: 'h', targetField: 'i', transformationType: 'unknown' as any, isRequired: false },
    ];

    const result = await engine.transform({ sourceData: { id: '1', fields: { a: '1' } } as any, mappings, rules: [] });

    expect(result.success).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].field).toBe('general');
    for (const idx of [0, 1, 2, 3]) expect(result.errors[0].message).toContain(`[${idx}] `);
    expect(result.transformedData.fields).toEqual({ a: '1' });
  });

  it('surfaces runtime failures per field for a structurally valid set', async () => {
    // The runtime-failure coverage the previous test carried: a required lookup
    // whose key is absent, and a calculation whose source field is missing.
    const engine = buildEngine();

    const mappings: FieldMapping[] = [
      { sourceField: 'd', targetField: 'e', transformationType: 'lookup', isRequired: false, transformationConfig: { type: 'lookup', lookupTable: '{"known":"K"}', required: true } },
      { sourceField: 'f', targetField: 'g', transformationType: 'calculation', isRequired: true, transformationConfig: { type: 'calculation', expression: 'parseInt(f)' } },
    ];

    const result = await engine.transform({ sourceData: { id: '1', fields: { d: 'unknown-key' } } as any, mappings, rules: [] });

    expect(result.success).toBe(false);
    // 'g' appears twice: the calculation branch's own error, then validateRequiredFields()
    // notes the required target never got a value. Both are real; neither is masked.
    expect(result.errors.map((e) => e.field).sort()).toEqual(['e', 'g', 'g']);
    expect(result.errors.find((e) => e.field === 'e')?.message).toMatch(/Lookup value not found/);
    expect(result.errors.find((e) => e.field === 'g')?.message).toMatch(/Calculation failed: f is missing/);
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

    // Codex round 13 on PR #1253: an unknown rule type used to be a warning beside
    // success:true; it is an error attributed to the rule. The invalid condition on
    // rule2 is still the one warning.
    // ... and an unparseable condition is an error against ITS rule, never a
    // silent skip (the one warning the old assertion counted was rule1's).
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      expect.objectContaining({ rule: 'rule1', severity: 'error', message: expect.stringMatching(/declared but not executable/) }),
      expect.objectContaining({ rule: 'rule2', severity: 'error', message: expect.stringMatching(/rule condition 'a b c' could not be parsed/) }),
    ]);
    expect(result.warnings).toEqual([]);
  });
});
