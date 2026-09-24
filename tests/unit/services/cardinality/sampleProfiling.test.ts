import { profileSamples } from '../../../../src/services/cardinality/sampleProfiling';

/**
 * Sample profiling math (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Sample profiling" / "Simulation report"). The privacy invariant is enforced
 * at the report level in CardinalityAnalysisService.test.ts; here we assert the
 * distribution/collision/count math and that only row indexes + report-local
 * group IDs are exported.
 */

describe('profileSamples — children-per-parent distribution', () => {
  it('computes min/median/p95/max over per-parent child counts', () => {
    // Parent A: 4 children, B: 2, C: 1, D: 3 → counts [4,2,1,3] sorted [1,2,3,4]
    const samples = [
      { accountId: 'A', externalId: 'a1' },
      { accountId: 'A', externalId: 'a2' },
      { accountId: 'A', externalId: 'a3' },
      { accountId: 'A', externalId: 'a4' },
      { accountId: 'B', externalId: 'b1' },
      { accountId: 'B', externalId: 'b2' },
      { accountId: 'C', externalId: 'c1' },
      { accountId: 'D', externalId: 'd1' },
      { accountId: 'D', externalId: 'd2' },
      { accountId: 'D', externalId: 'd3' },
    ];
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });

    expect(profile.distinctParentCount).toBe(4);
    expect(profile.childrenPerParent.min).toBe(1);
    expect(profile.childrenPerParent.max).toBe(4);
    // linear-interpolation percentile over sorted [1,2,3,4]
    expect(profile.childrenPerParent.median).toBeCloseTo(2.5, 5);
    expect(profile.childrenPerParent.p95).toBeCloseTo(3.85, 5);
  });

  it('does not choke on empty samples — returns a zeroed profile', () => {
    const profile = profileSamples({
      samples: [],
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });
    expect(profile.inputRowCount).toBe(0);
    expect(profile.distinctParentCount).toBe(0);
    expect(profile.childrenPerParent).toEqual({ min: 0, median: 0, p95: 0, max: 0 });
    expect(profile.collisionGroups).toEqual([]);
  });
});

describe('profileSamples — composite key uniqueness and collisions', () => {
  it('detects colliding rows on a composite target key and orders groups by first row index', () => {
    const samples = [
      { accountId: 'A', region: 'US', externalId: 'X' }, // 0
      { accountId: 'B', region: 'US', externalId: 'Y' }, // 1 - unique
      { accountId: 'A', region: 'US', externalId: 'X' }, // 2 - collides with 0
      { accountId: 'C', region: 'EU', externalId: 'Z' }, // 3
      { accountId: 'C', region: 'EU', externalId: 'Z' }, // 4 - collides with 3
      { accountId: 'A', region: 'US', externalId: 'X' }, // 5 - collides with 0,2
    ];
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId', 'region'],
      resolution: 'flatten',
    });

    expect(profile.collisionCount).toBe(2);
    expect(profile.collisionGroups).toEqual([
      { groupId: 'collision-1', rowIndexes: [0, 2, 5] },
      { groupId: 'collision-2', rowIndexes: [3, 4] },
    ]);
    expect(profile.collisionRowIndexes).toEqual([0, 2, 3, 4, 5]);
  });

  it('treats distinct composite keys as unique even when one component repeats', () => {
    const samples = [
      { externalId: 'X', region: 'US' },
      { externalId: 'X', region: 'EU' },
    ];
    const profile = profileSamples({
      samples,
      parentKeys: [],
      targetKeys: ['externalId', 'region'],
      resolution: 'flatten',
    });
    expect(profile.collisionCount).toBe(0);
    expect(profile.collisionGroups).toEqual([]);
  });
});

describe('profileSamples — missing-key rejection', () => {
  it('rejects rows missing any required key component and excludes them from all math', () => {
    const samples = [
      { accountId: 'A', externalId: 'X' }, // valid
      { accountId: 'A', externalId: 'X' }, // valid, collides
      { accountId: 'A' }, // missing target key → rejected
      { externalId: 'Y' }, // missing parent key → rejected
    ];
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });
    expect(profile.rejectedRecordCount).toBe(2);
    expect(profile.distinctParentCount).toBe(1);
    expect(profile.collisionGroups).toEqual([{ groupId: 'collision-1', rowIndexes: [0, 1] }]);
  });

  it('treats null and undefined key values as missing but keeps empty strings', () => {
    const samples = [
      { accountId: null, externalId: 'X' }, // rejected
      { accountId: 'A', externalId: undefined }, // rejected
      { accountId: '', externalId: '' }, // valid (empty strings are present)
    ];
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });
    expect(profile.rejectedRecordCount).toBe(2);
    expect(profile.distinctParentCount).toBe(1);
  });
});

describe('profileSamples — expected counts, dropped, and compressed', () => {
  const samples = [
    { accountId: 'A', externalId: 'a1' },
    { accountId: 'A', externalId: 'a2' },
    { accountId: 'A', externalId: 'a3' },
    { accountId: 'B', externalId: 'b1' },
  ]; // 4 valid rows, 2 distinct parents

  it('flatten drops the extra children and targets one record per parent', () => {
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });
    expect(profile.expectedTargetRecordCount).toBe(2);
    expect(profile.droppedChildCount).toBe(2);
    expect(profile.compressedChildCount).toBe(0);
  });

  it('aggregate compresses the extra children into the parent record', () => {
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'aggregate',
    });
    expect(profile.expectedTargetRecordCount).toBe(2);
    expect(profile.droppedChildCount).toBe(0);
    expect(profile.compressedChildCount).toBe(2);
  });

  it('fan_out keeps one target record per child', () => {
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'fan_out',
    });
    expect(profile.expectedTargetRecordCount).toBe(4);
    expect(profile.droppedChildCount).toBe(0);
    expect(profile.compressedChildCount).toBe(0);
  });
});

describe('profileSamples — export privacy', () => {
  it('never exports raw key values or per-key hashes — only indexes and group IDs', () => {
    const samples = [
      { accountId: 'SECRET_PARENT', externalId: 'SECRET_KEY' },
      { accountId: 'SECRET_PARENT', externalId: 'SECRET_KEY' },
    ];
    const profile = profileSamples({
      samples,
      parentKeys: ['accountId'],
      targetKeys: ['externalId'],
      resolution: 'flatten',
    });
    const serialized = JSON.stringify(profile);
    expect(serialized).not.toContain('SECRET_PARENT');
    expect(serialized).not.toContain('SECRET_KEY');
    expect(profile.collisionGroups[0].groupId).toBe('collision-1');
  });
});
