/**
 * Compile-time test for FlowTemplate type tightening (PR 13, Codex round 3
 * finding #2; restructured per Codex round 4 finding #3).
 *
 * Uses direct typed-assignment pattern rather than embedding bad values in
 * nested object literals — the @ts-expect-error directive only applies to
 * the NEXT line, so it has to be IMMEDIATELY ABOVE the offending statement.
 * Putting it above a multi-line literal and expecting it to "reach" into a
 * nested property a few lines down doesn't work and produces either
 * "Unused '@ts-expect-error' directive" OR an unsuppressed real type error.
 *
 * If TypeScript ever accepts the bad value (because someone widened the
 * type back to string), the @ts-expect-error becomes a compile error,
 * surfacing the regression.
 */
import type { FlowTemplate } from '../../../../src/flows/templates/FlowTemplate';
import type { CanonicalEntity, SourceSystem } from '../../../../src/governance/sourceOfTruth/SourceOfTruthManifest';

describe('FlowTemplate type contract', () => {
  it('accepts a fully valid template (positive case)', () => {
    const tpl: FlowTemplate<{ id: string }, Record<string, unknown>> = {
      id: 'test-v1',
      category: 'master_data_sync',
      version: '1.0.0',
      source: { system: 'hubspot', eventType: 'created' },
      target: { system: 'netsuite', recordType: 'Contact', canonicalEntity: 'contact', operation: 'create' },
      description: 'fixture',
      governanceCallouts: [],
      transform: async () => ({}),
      riskClassification: () => 'low',
      retryPolicy: { maxAttempts: 1, backoffMs: 0, idempotencyKey: (e) => 'k' },
    };
    expect(tpl.id).toBe('test-v1');
  });

  it('rejects invalid SourceSystem at compile time', () => {
    // @ts-expect-error — 'made_up_system' is not a SourceSystem
    const _badSystem: SourceSystem = 'made_up_system';
    // The mere act of declaring the assignment is what we're testing.
    // The runtime assertion just keeps jest happy.
    expect(typeof _badSystem).toBe('string');
  });

  it('rejects invalid CanonicalEntity at compile time', () => {
    // @ts-expect-error — 'made_up_entity' is not a CanonicalEntity
    const _badEntity: CanonicalEntity = 'made_up_entity';
    expect(typeof _badEntity).toBe('string');
  });

  it('accepts known SourceSystem values', () => {
    const okSystems: SourceSystem[] = ['netsuite', 'hubspot', 'salesforce', 'shopify'];
    expect(okSystems).toHaveLength(4);
  });

  it('accepts known CanonicalEntity values', () => {
    const okEntities: CanonicalEntity[] = ['customer', 'vendor', 'invoice', 'sales_order'];
    expect(okEntities).toHaveLength(4);
  });
});
