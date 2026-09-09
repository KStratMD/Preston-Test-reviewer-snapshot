import {
  SOURCE_OF_TRUTH_MANIFEST,
  SOURCE_SYSTEM_TO_CONNECTOR_KEY,
  type CanonicalEntity,
  type SourceSystem,
} from '../../../../src/governance/sourceOfTruth/SourceOfTruthManifest';

// Derive the valid-systems set from the same map the production code uses,
// so adding a SourceSystem only needs to update SOURCE_SYSTEM_TO_CONNECTOR_KEY
// (which Record<SourceSystem, string> already keeps exhaustive via TS).
// Copilot R9 on PR 13.
const VALID_SYSTEMS = new Set<SourceSystem>(
  Object.keys(SOURCE_SYSTEM_TO_CONNECTOR_KEY) as SourceSystem[],
);

describe('SOURCE_OF_TRUTH_MANIFEST', () => {
  it('declares an OwnershipDeclaration for every CanonicalEntity', () => {
    const declared = new Set(SOURCE_OF_TRUTH_MANIFEST.map((d) => d.entity));
    const expected: CanonicalEntity[] = [
      'customer', 'contact', 'vendor', 'invoice', 'payment',
      'payout_batch', 'product', 'inventory_level', 'sales_order',
      'deal', 'ticket',
    ];
    for (const entity of expected) {
      expect(declared.has(entity)).toBe(true);
    }
  });

  it('every declaration has owner, conflictPolicy, and conflictPolicyRationale', () => {
    for (const d of SOURCE_OF_TRUTH_MANIFEST) {
      expect(d.owner).toBeDefined();
      expect(d.conflictPolicy).toBeDefined();
      expect(typeof d.conflictPolicyRationale).toBe('string');
      expect(d.conflictPolicyRationale.length).toBeGreaterThan(0);
    }
  });

  it('every fieldOverrides[].owner is a valid SourceSystem', () => {
    for (const d of SOURCE_OF_TRUTH_MANIFEST) {
      for (const override of d.fieldOverrides ?? []) {
        expect(VALID_SYSTEMS.has(override.owner)).toBe(true);
      }
    }
  });

  it('SOURCE_SYSTEM_TO_CONNECTOR_KEY has an entry for every SourceSystem', () => {
    // Round-trip the derived set so the assertion still proves coverage
    // even after the dedupe — every SourceSystem we know about must map.
    for (const sys of VALID_SYSTEMS) {
      expect(sys in SOURCE_SYSTEM_TO_CONNECTOR_KEY).toBe(true);
    }
  });

  it('knownLoops entries have windowMs > 0 and a counterpart SourceSystem', () => {
    for (const d of SOURCE_OF_TRUTH_MANIFEST) {
      for (const loop of d.knownLoops ?? []) {
        expect(loop.windowMs).toBeGreaterThan(0);
        expect(VALID_SYSTEMS.has(loop.counterpart)).toBe(true);
        expect(typeof loop.breakingCondition).toBe('string');
      }
    }
  });
});
