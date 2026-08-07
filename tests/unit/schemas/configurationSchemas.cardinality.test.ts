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
