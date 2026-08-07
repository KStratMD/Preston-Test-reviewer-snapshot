import {
  CardinalityOverrideRequestSchema,
  CardinalitySaveEnvelopeSchema,
  CardinalityPreflightRequestSchema,
} from '../../../src/schemas/cardinalityTransportSchemas';

/**
 * Strict transport envelopes: the audited override request, the `_cardinality`
 * save envelope, and the preflight request. These never carry credentials,
 * tenant/actor identity, relationship graphs, or persisted metadata.
 */

describe('CardinalityOverrideRequestSchema', () => {
  const valid = {
    reason: 'These two child contacts intentionally collapse to one customer record.',
    findingKeys: ['collision-1', 'collision-2'],
    reportFingerprint: 'a'.repeat(64),
  };

  it('accepts a well-formed override request', () => {
    expect(CardinalityOverrideRequestSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects a reason shorter than 10 characters', () => {
    expect(CardinalityOverrideRequestSchema.safeParse({ ...valid, reason: 'too short' }).success).toBe(false);
  });

  it('rejects a reason longer than 2,000 characters', () => {
    expect(
      CardinalityOverrideRequestSchema.safeParse({ ...valid, reason: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });

  it('rejects an empty finding-key scope', () => {
    expect(CardinalityOverrideRequestSchema.safeParse({ ...valid, findingKeys: [] }).success).toBe(false);
  });

  it('rejects more than 200 finding keys', () => {
    const findingKeys = Array.from({ length: 201 }, (_, i) => `collision-${i}`);
    expect(CardinalityOverrideRequestSchema.safeParse({ ...valid, findingKeys }).success).toBe(false);
  });

  it('rejects duplicate finding keys', () => {
    expect(
      CardinalityOverrideRequestSchema.safeParse({ ...valid, findingKeys: ['collision-1', 'collision-1'] }).success,
    ).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(CardinalityOverrideRequestSchema.safeParse({ ...valid, tenantId: 'tenant-a' }).success).toBe(false);
  });
});

describe('CardinalitySaveEnvelopeSchema', () => {
  it('accepts an envelope with an override and bounded samples', () => {
    const result = CardinalitySaveEnvelopeSchema.safeParse({
      override: {
        reason: 'Intentional flatten of the child collection into a single scalar.',
        findingKeys: ['collision-1'],
        reportFingerprint: 'b'.repeat(64),
      },
      samples: [{ id: '1', accountId: 'A' }, { id: '2', accountId: 'A' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts an empty envelope', () => {
    expect(CardinalitySaveEnvelopeSchema.safeParse({}).success).toBe(true);
  });

  it('rejects sample rows carrying prototype-pollution keys', () => {
    const result = CardinalitySaveEnvelopeSchema.safeParse({
      samples: JSON.parse('[{"__proto__": {"admin": true}, "id": "1"}]'),
    });
    expect(result.success).toBe(false);
  });

  it('rejects more than 1,000 sample rows', () => {
    const samples = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }));
    expect(CardinalitySaveEnvelopeSchema.safeParse({ samples }).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(CardinalitySaveEnvelopeSchema.safeParse({ tenantId: 'tenant-a' }).success).toBe(false);
  });
});

describe('CardinalityPreflightRequestSchema', () => {
  const baseRequest = {
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Contact',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target' as const,
    fieldMappings: [
      { sourceField: 'FirstName', targetField: 'firstname', transformationType: 'direct', isRequired: true },
    ],
    keyDeclarations: { sourceRecordKeys: ['Id'], parentKeys: ['AccountId'], targetKeys: ['externalId'] },
  };

  it('accepts a valid plan projection without samples', () => {
    expect(CardinalityPreflightRequestSchema.safeParse(baseRequest).success).toBe(true);
  });

  it('accepts samples when parent and target keys are declared', () => {
    const result = CardinalityPreflightRequestSchema.safeParse({
      ...baseRequest,
      samples: [{ Id: '1', AccountId: 'A', externalId: 'X' }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects samples when parent keys are not declared', () => {
    const result = CardinalityPreflightRequestSchema.safeParse({
      ...baseRequest,
      keyDeclarations: { sourceRecordKeys: ['Id'], parentKeys: [], targetKeys: ['externalId'] },
      samples: [{ Id: '1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects samples when target keys are not declared', () => {
    const result = CardinalityPreflightRequestSchema.safeParse({
      ...baseRequest,
      keyDeclarations: { sourceRecordKeys: ['Id'], parentKeys: ['AccountId'], targetKeys: [] },
      samples: [{ Id: '1' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects credential-bearing top-level fields (strict)', () => {
    expect(
      CardinalityPreflightRequestSchema.safeParse({ ...baseRequest, sourceAuthentication: { apiKey: 'k' } }).success,
    ).toBe(false);
  });
});
