import { IntegrationConfigSchema } from '../../../src/schemas/configurationSchemas';

/**
 * Cardinality-related behavior of the canonical persisted configuration schema:
 *   - draft freedom (duplicate source/target refinements removed);
 *   - field-value resolution validation (incomplete `select_one`, rejected
 *     `manual_review`, aggregate parameter rules);
 *   - config-level strategy validation;
 *   - the transport-only `_cardinality` envelope is rejected;
 *   - server-authored `cardinalityApproval` / `cardinalityValidation` are never
 *     trusted from client input (stripped on parse).
 */

type ConfigInput = Record<string, unknown>;

function baseConfig(overrides: ConfigInput = {}): ConfigInput {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Test Config',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Contact',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [
      { sourceField: 'FirstName', targetField: 'firstname', transformationType: 'direct', isRequired: true },
    ],
    sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
    ...overrides,
  };
}

describe('IntegrationConfigSchema — cardinality drafts and resolutions', () => {
  it('parses a draft with duplicate TARGET fields (draft freedom)', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          { sourceField: 'FirstName', targetField: 'name', transformationType: 'direct', isRequired: true },
          { sourceField: 'LastName', targetField: 'name', transformationType: 'direct', isRequired: false },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('parses a draft with duplicate SOURCE fields (draft freedom)', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          { sourceField: 'Name', targetField: 'firstname', transformationType: 'direct', isRequired: true },
          { sourceField: 'Name', targetField: 'lastname', transformationType: 'direct', isRequired: false },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a complete select_one field resolution', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'Amount',
            targetField: 'amount',
            transformationType: 'direct',
            isRequired: true,
            cardinality: {
              resolution: 'select_one',
              orderBy: [{ field: 'createdDate', direction: 'desc' }],
              tieBreak: { field: 'id', direction: 'asc' },
            },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an incomplete select_one (empty ordering)', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'Amount',
            targetField: 'amount',
            transformationType: 'direct',
            isRequired: true,
            cardinality: {
              resolution: 'select_one',
              orderBy: [],
              tieBreak: { field: 'id', direction: 'asc' },
            },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects manual_review as a field resolution kind', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'Amount',
            targetField: 'amount',
            transformationType: 'direct',
            isRequired: true,
            cardinality: { resolution: 'manual_review' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an aggregate join with no separator', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'Tags',
            targetField: 'tags',
            transformationType: 'direct',
            isRequired: false,
            cardinality: { resolution: 'aggregate', operator: 'join' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a separator on a non-join aggregate', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'Amount',
            targetField: 'total',
            transformationType: 'direct',
            isRequired: false,
            cardinality: { resolution: 'aggregate', operator: 'sum', separator: ',' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts a valid config-level separate_records strategy', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        cardinalityStrategies: [
          {
            resolution: 'separate_records',
            direction: 'source_to_target',
            relationshipPath: ['Contact', 'Account'],
            childConfigurationId: 'cfg-child',
            parentKeyMapping: { sourceField: 'AccountId', targetField: 'parentId' },
          },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an incomplete separate_records strategy (missing childConfigurationId)', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        cardinalityStrategies: [
          {
            resolution: 'separate_records',
            direction: 'source_to_target',
            relationshipPath: ['Contact', 'Account'],
            parentKeyMapping: { sourceField: 'AccountId', targetField: 'parentId' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });
});

describe('IntegrationConfigSchema — transport envelope and server-authored metadata', () => {
  it('rejects a config carrying the transport-only _cardinality envelope', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({ _cardinality: { samples: [{ a: 1 }] } }),
    );
    expect(result.success).toBe(false);
  });

  it('does not trust client-supplied cardinalityApproval / cardinalityValidation (stripped)', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        // Single server-authored record (never an array): the client cannot seed
        // it, so any supplied value — right shape or not — must be stripped.
        cardinalityApproval: {
          reason: 'client-injected',
          findingKeys: ['collision-1'],
          reportFingerprint: 'deadbeef',
          actorUserId: 'attacker',
          actorTenantId: 'tenant-a',
          approvedAt: '2026-07-26T00:00:00.000Z',
          analyzerVersion: '1',
        },
        cardinalityValidation: {
          analyzerVersion: '1',
          reportFingerprint: 'deadbeef',
          checkedAt: '2026-07-26T00:00:00.000Z',
          directions: ['source_to_target'],
          blockingFindingKeys: [],
          overriddenFindingKeys: [],
          unavailableChecks: [],
        },
      }),
    );
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual(
      expect.not.objectContaining({ cardinalityApproval: expect.anything() }),
    );
    expect(result.success && result.data).toEqual(
      expect.not.objectContaining({ cardinalityValidation: expect.anything() }),
    );
  });
});

describe('FieldMappingSchema / transformationConfig — strict boundaries', () => {
  it('rejects an unknown top-level key on a field mapping', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'FirstName',
            targetField: 'firstname',
            transformationType: 'direct',
            isRequired: true,
            unknownMappingKey: 'should be rejected',
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an unknown key inside transformationConfig', () => {
    const result = IntegrationConfigSchema.safeParse(
      baseConfig({
        fieldMappings: [
          {
            sourceField: 'FirstName',
            targetField: 'firstname',
            transformationType: 'direct',
            isRequired: true,
            transformationConfig: { type: 'direct', unknownConfigKey: 'should be rejected' },
          },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  // One real, documented legacy shape per transformationType — proves
  // strictness doesn't reject anything TransformationEngine/sample
  // integrations actually rely on. `concatenate` and `concatenation` are
  // pinned as distinct outer enum literals (both are accepted values of
  // FieldMapping.transformationType).
  const validLegacyMappings: Array<[string, ConfigInput]> = [
    ['direct (no transformationConfig)', {
      sourceField: 'FirstName', targetField: 'firstname', transformationType: 'direct', isRequired: true,
    }],
    ['concatenate (outer enum literal)', {
      sourceField: 'BillingStreet', targetField: 'address', transformationType: 'concatenate', isRequired: false,
      transformationConfig: { type: 'concatenation', fields: ['BillingStreet', 'BillingCity'], separator: ', ' },
    }],
    ['concatenation (outer enum literal)', {
      sourceField: 'BillingStreet', targetField: 'address', transformationType: 'concatenation', isRequired: false,
      transformationConfig: { type: 'concatenation', fields: ['BillingStreet', 'BillingCity'], separator: ', ' },
    }],
    ['split (minimal, type only)', {
      sourceField: 'FullName', targetField: 'firstName', transformationType: 'split', isRequired: false,
      transformationConfig: { type: 'split' },
    }],
    // Codex round 13 on PR #1253: a bare table NAME is not resolvable by performLookup(); the
    // reference shape is preserved, but it must carry the mappings that resolve it.
    ['lookup via lookupTable reference (with the mappings that resolve it)', {
      sourceField: 'Industry', targetField: 'category', transformationType: 'lookup', isRequired: false,
      transformationConfig: { type: 'lookup', lookupTable: 'industry_mapping', keyField: 'source_industry', valueField: 'target_category', mappings: { Technology: 'tech' } },
    }],
    ['lookup via inline mappings (TransformationEngine.performLookup legacy shape)', {
      sourceField: 'lifecycle', targetField: 'statusCode', transformationType: 'lookup', isRequired: false,
      transformationConfig: {
        type: 'lookup',
        lookupTable: '{"active":"A","inactive":"I"}',
        mappings: { active: 'A', inactive: 'I' },
        defaultValue: 'U',
        required: true,
      },
    }],
    ['expression (minimal, type only)', {
      sourceField: 'raw', targetField: 'derived', transformationType: 'expression', isRequired: false,
      transformationConfig: { type: 'expression', expression: 'parseInt(raw)' },
    }],
    ['conditional (minimal, type only)', {
      sourceField: 'status', targetField: 'active', transformationType: 'conditional', isRequired: false,
      transformationConfig: { type: 'conditional' },
    }],
    ['calculation', {
      sourceField: 'AnnualRevenue', targetField: 'creditlimit', transformationType: 'calculation', isRequired: false,
      transformationConfig: { type: 'calculation', expression: 'VALUE * 0.1' },
    }],
  ];

  it.each(validLegacyMappings)('accepts and losslessly preserves the documented legacy shape: %s', (_label, fieldMapping) => {
    const result = IntegrationConfigSchema.safeParse(baseConfig({ fieldMappings: [fieldMapping] }));
    expect(result.success).toBe(true);
    // Parsed behavior, not just parse success: every recognized field —
    // including the inline-mappings lookup's `mappings` / `defaultValue` /
    // `required` — must survive parsing unchanged rather than being
    // silently stripped by a boundary that's too narrow.
    expect(result.success && result.data.fieldMappings?.[0]).toEqual(fieldMapping);
  });
});

describe('Existing strict cardinality boundaries — unknown-key regression protection', () => {
  // These boundaries (FieldCardinalityResolutionSchema, OrderByEntrySchema,
  // CardinalityStrategySchema, parentKeyMapping) were already `.strict()`
  // before B3.3. No production change here — this closes the missing test
  // proof that they actually reject unknown keys, per independent review.
  const unknownKeyRejectionCases: Array<[string, ConfigInput]> = [
    ['aggregate field resolution', {
      fieldMappings: [
        {
          sourceField: 'Tags', targetField: 'tags', transformationType: 'direct', isRequired: false,
          cardinality: { resolution: 'aggregate', operator: 'sum', unknownKey: 'x' },
        },
      ],
    }],
    ['select_one field resolution', {
      fieldMappings: [
        {
          sourceField: 'Amount', targetField: 'amount', transformationType: 'direct', isRequired: true,
          cardinality: {
            resolution: 'select_one',
            orderBy: [{ field: 'createdDate', direction: 'desc' }],
            tieBreak: { field: 'id', direction: 'asc' },
            unknownKey: 'x',
          },
        },
      ],
    }],
    ['OrderByEntrySchema — unknown key in an orderBy entry', {
      fieldMappings: [
        {
          sourceField: 'Amount', targetField: 'amount', transformationType: 'direct', isRequired: true,
          cardinality: {
            resolution: 'select_one',
            orderBy: [{ field: 'createdDate', direction: 'desc', unknownKey: 'x' }],
            tieBreak: { field: 'id', direction: 'asc' },
          },
        },
      ],
    }],
    ['OrderByEntrySchema — unknown key in tieBreak', {
      fieldMappings: [
        {
          sourceField: 'Amount', targetField: 'amount', transformationType: 'direct', isRequired: true,
          cardinality: {
            resolution: 'select_one',
            orderBy: [{ field: 'createdDate', direction: 'desc' }],
            tieBreak: { field: 'id', direction: 'asc', unknownKey: 'x' },
          },
        },
      ],
    }],
    ['separate_records config-level strategy', {
      cardinalityStrategies: [
        {
          resolution: 'separate_records',
          direction: 'source_to_target',
          relationshipPath: ['Contact', 'Account'],
          childConfigurationId: 'cfg-child',
          parentKeyMapping: { sourceField: 'AccountId', targetField: 'parentId' },
          unknownKey: 'x',
        },
      ],
    }],
    ['fan_out config-level strategy', {
      cardinalityStrategies: [
        {
          resolution: 'fan_out',
          direction: 'source_to_target',
          relationshipPath: ['Contact', 'Account'],
          targetEntity: 'Order',
          targetKeyFields: ['id'],
          unknownKey: 'x',
        },
      ],
    }],
    ['nested parentKeyMapping', {
      cardinalityStrategies: [
        {
          resolution: 'separate_records',
          direction: 'source_to_target',
          relationshipPath: ['Contact', 'Account'],
          childConfigurationId: 'cfg-child',
          parentKeyMapping: { sourceField: 'AccountId', targetField: 'parentId', unknownKey: 'x' },
        },
      ],
    }],
  ];

  it.each(unknownKeyRejectionCases)('rejects an unknown key at: %s', (_label, overrides) => {
    const result = IntegrationConfigSchema.safeParse(baseConfig(overrides));
    expect(result.success).toBe(false);
  });
});
