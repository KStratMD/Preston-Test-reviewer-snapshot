import {
  canonicalJson,
  sha256Hex,
  computeSampleDigest,
  computeReportFingerprint,
  computeCombinedFingerprint,
} from '../../../../src/services/cardinality/fingerprint';

/**
 * Sample-bound fingerprints (docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Analysis inputs and fingerprint"). The load-bearing invariant: a change to
 * samples MUST change the report fingerprint, so an override of an observed
 * collision cannot silently authorize a different sample set.
 */

describe('canonicalJson', () => {
  it('produces identical output regardless of top-level key insertion order', () => {
    const a = canonicalJson({ b: 2, a: 1, c: 3 });
    const b = canonicalJson({ c: 3, a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it('sorts keys recursively inside nested objects and arrays of objects', () => {
    const a = canonicalJson({
      outer: { z: 1, y: { q: 1, p: 2 } },
      list: [{ b: 1, a: 2 }, { d: 3, c: 4 }],
    });
    const b = canonicalJson({
      list: [{ a: 2, b: 1 }, { c: 4, d: 3 }],
      outer: { y: { p: 2, q: 1 }, z: 1 },
    });
    expect(a).toBe(b);
  });

  it('preserves array element order (order is semantically meaningful for arrays)', () => {
    const a = canonicalJson([{ id: 1 }, { id: 2 }]);
    const b = canonicalJson([{ id: 2 }, { id: 1 }]);
    expect(a).not.toBe(b);
  });

  it('treats null and undefined-object-input as distinct from an empty object', () => {
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson({})).toBe('{}');
  });
});

describe('sha256Hex', () => {
  it('returns a 64-character lowercase hex digest', () => {
    const digest = sha256Hex('hello world');
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    expect(sha256Hex('same input')).toBe(sha256Hex('same input'));
  });

  it('changes when the input changes', () => {
    expect(sha256Hex('input a')).not.toBe(sha256Hex('input b'));
  });
});

describe('computeSampleDigest', () => {
  it('is deterministic regardless of per-row key insertion order', () => {
    const rowsA = [{ id: '1', accountId: 'A' }];
    const rowsB = [{ accountId: 'A', id: '1' }];
    expect(computeSampleDigest(rowsA)).toBe(computeSampleDigest(rowsB));
  });

  it('changes when a sample value changes', () => {
    const before = computeSampleDigest([{ id: '1', accountId: 'A' }]);
    const after = computeSampleDigest([{ id: '1', accountId: 'B' }]);
    expect(before).not.toBe(after);
  });

  it('changes when a row is added or removed', () => {
    const one = computeSampleDigest([{ id: '1' }]);
    const two = computeSampleDigest([{ id: '1' }, { id: '2' }]);
    expect(one).not.toBe(two);
  });

  it('returns a consistent digest for both undefined and empty samples', () => {
    expect(computeSampleDigest(undefined)).toBe(computeSampleDigest([]));
  });
});

describe('computeReportFingerprint', () => {
  const base = {
    analyzerVersion: '1.0.0',
    direction: 'source_to_target' as const,
    plan: { sourceEntity: 'Contact', targetEntity: 'Customer' },
    evidence: { status: 'available' },
    sampleDigest: computeSampleDigest([{ id: '1', accountId: 'A' }]),
  };

  it('is deterministic for identical input', () => {
    expect(computeReportFingerprint(base)).toBe(computeReportFingerprint({ ...base }));
  });

  it('changes when the sample digest changes — the sample-binding invariant', () => {
    const originalFingerprint = computeReportFingerprint(base);
    const changedSampleDigest = computeSampleDigest([{ id: '1', accountId: 'DIFFERENT' }]);
    const changedFingerprint = computeReportFingerprint({ ...base, sampleDigest: changedSampleDigest });
    expect(changedFingerprint).not.toBe(originalFingerprint);
  });

  it('changes when the analyzer version changes', () => {
    const a = computeReportFingerprint(base);
    const b = computeReportFingerprint({ ...base, analyzerVersion: '1.0.1' });
    expect(a).not.toBe(b);
  });

  it('changes when the direction changes', () => {
    const a = computeReportFingerprint(base);
    const b = computeReportFingerprint({ ...base, direction: 'target_to_source' });
    expect(a).not.toBe(b);
  });

  it('changes when the plan changes', () => {
    const a = computeReportFingerprint(base);
    const b = computeReportFingerprint({ ...base, plan: { ...base.plan, targetEntity: 'Account' } });
    expect(a).not.toBe(b);
  });

  it('changes when the evidence changes', () => {
    const a = computeReportFingerprint(base);
    const b = computeReportFingerprint({ ...base, evidence: { status: 'unavailable' } });
    expect(a).not.toBe(b);
  });
});

describe('computeCombinedFingerprint', () => {
  it('is order-independent — combining is computed from sorted direction/fingerprint pairs', () => {
    const forward = { direction: 'source_to_target' as const, fingerprint: 'aaa' };
    const backward = { direction: 'target_to_source' as const, fingerprint: 'bbb' };
    expect(computeCombinedFingerprint([forward, backward])).toBe(
      computeCombinedFingerprint([backward, forward]),
    );
  });

  it('changes when a direction fingerprint changes', () => {
    const forward = { direction: 'source_to_target' as const, fingerprint: 'aaa' };
    const backward = { direction: 'target_to_source' as const, fingerprint: 'bbb' };
    const a = computeCombinedFingerprint([forward, backward]);
    const b = computeCombinedFingerprint([forward, { ...backward, fingerprint: 'ccc' }]);
    expect(a).not.toBe(b);
  });

  it('changes when only one direction is present versus both', () => {
    const forward = { direction: 'source_to_target' as const, fingerprint: 'aaa' };
    const backward = { direction: 'target_to_source' as const, fingerprint: 'bbb' };
    const single = computeCombinedFingerprint([forward]);
    const both = computeCombinedFingerprint([forward, backward]);
    expect(single).not.toBe(both);
  });
});
