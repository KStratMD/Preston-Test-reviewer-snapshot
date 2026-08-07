import { canonicalJson } from './fingerprint';

/**
 * Sample profiling math for the cardinality preflight and activation gate.
 *
 * See docs/superpowers/specs/2026-07-26-cardinality-preflight-design.md
 * "Sample profiling" / "Simulation report". This module is pure: no logging,
 * persistence, clock reads, or environment access.
 *
 * PRIVACY (non-negotiable): rows are grouped internally by their canonical
 * composite key, but that key never leaves the module. Only row indexes and
 * report-local collision-group identifiers (`collision-1`, `collision-2`, ...)
 * are exported — never a raw parent/key value nor a reusable per-key hash.
 */

/** How the declared resolution handles children, for advisory count math. */
export type SampleResolutionMode =
  | 'flatten'
  | 'select_one'
  | 'aggregate'
  | 'fan_out'
  | 'separate_records';

export interface SampleProfilingInput {
  samples: Record<string, unknown>[];
  parentKeys: string[];
  targetKeys: string[];
  resolution: SampleResolutionMode;
}

/** A set of sample rows sharing one composite target key, by row index only. */
export interface SampleCollisionGroup {
  groupId: string;
  rowIndexes: number[];
}

export interface SampleProfile {
  inputRowCount: number;
  distinctParentCount: number;
  childrenPerParent: { min: number; median: number; p95: number; max: number };
  expectedTargetRecordCount: number;
  rejectedRecordCount: number;
  droppedChildCount: number;
  compressedChildCount: number;
  collisionGroups: SampleCollisionGroup[];
  collisionRowIndexes: number[];
  collisionCount: number;
  assumptions: string[];
  unavailableChecks: string[];
}

/**
 * The canonical composite key for a set of key fields, or `null` when any
 * component is missing (absent, `undefined`, or `null`). Empty strings are
 * present values and do not reject the row. The returned string is used only as
 * an in-memory grouping key and is never exported.
 */
function compositeKey(row: Record<string, unknown>, keys: string[]): string | null {
  const values: unknown[] = [];
  for (const key of keys) {
    const value = row[key];
    if (value === undefined || value === null) return null;
    values.push(value);
  }
  return canonicalJson(values);
}

/**
 * Linear-interpolation percentile over an ascending-sorted numeric array (the
 * NumPy default / "inclusive" method). Empty input yields 0.
 */
function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (rank - lo) * (sortedAsc[hi] - sortedAsc[lo]);
}

const EMPTY_DISTRIBUTION = { min: 0, median: 0, p95: 0, max: 0 } as const;

export function profileSamples(input: SampleProfilingInput): SampleProfile {
  const { samples, parentKeys, targetKeys, resolution } = input;
  const inputRowCount = samples.length;
  const assumptions: string[] = [];
  const unavailableChecks: string[] = [];

  const hasParentKeys = parentKeys.length > 0;
  const hasTargetKeys = targetKeys.length > 0;
  if (!hasParentKeys) unavailableChecks.push('children_per_parent');
  if (!hasTargetKeys) unavailableChecks.push('target_key_uniqueness');

  // A row is valid only when every declared parent AND target key is present;
  // rejected rows are excluded from all downstream math.
  const parentByRow: (string | null)[] = [];
  const targetByRow: (string | null)[] = [];
  let rejectedRecordCount = 0;

  samples.forEach((row, index) => {
    const parentKey = hasParentKeys ? compositeKey(row, parentKeys) : '';
    const targetKey = hasTargetKeys ? compositeKey(row, targetKeys) : '';
    const rejected = (hasParentKeys && parentKey === null) || (hasTargetKeys && targetKey === null);
    if (rejected) {
      rejectedRecordCount += 1;
      parentByRow[index] = null;
      targetByRow[index] = null;
      return;
    }
    parentByRow[index] = parentKey;
    targetByRow[index] = targetKey;
  });

  // Children-per-parent distribution over valid rows.
  const childCountByParent = new Map<string, number>();
  parentByRow.forEach((parentKey) => {
    if (parentKey === null) return;
    childCountByParent.set(parentKey, (childCountByParent.get(parentKey) ?? 0) + 1);
  });
  const distinctParentCount = childCountByParent.size;
  const counts = [...childCountByParent.values()].sort((a, b) => a - b);
  const childrenPerParent =
    counts.length === 0
      ? { ...EMPTY_DISTRIBUTION }
      : {
          min: counts[0],
          median: percentile(counts, 50),
          p95: percentile(counts, 95),
          max: counts[counts.length - 1],
        };

  // Composite target-key collisions over valid rows, grouped by first row index.
  const rowsByTargetKey = new Map<string, number[]>();
  targetByRow.forEach((targetKey, index) => {
    if (targetKey === null) return;
    const bucket = rowsByTargetKey.get(targetKey);
    if (bucket) bucket.push(index);
    else rowsByTargetKey.set(targetKey, [index]);
  });
  const collisionBuckets = [...rowsByTargetKey.values()]
    .filter((rowIndexes) => rowIndexes.length > 1)
    .sort((a, b) => a[0] - b[0]);
  const collisionGroups: SampleCollisionGroup[] = collisionBuckets.map((rowIndexes, groupIndex) => ({
    groupId: `collision-${groupIndex + 1}`,
    rowIndexes,
  }));
  const collisionRowIndexes = collisionBuckets.flat().sort((a, b) => a - b);

  // Advisory expected-count / dropped / compressed math.
  const validRowCount = inputRowCount - rejectedRecordCount;
  const perChild = resolution === 'fan_out' || resolution === 'separate_records';
  const expectedTargetRecordCount = perChild ? validRowCount : distinctParentCount;
  const collapsed = Math.max(0, validRowCount - distinctParentCount);
  const droppedChildCount = resolution === 'flatten' || resolution === 'select_one' ? collapsed : 0;
  const compressedChildCount = resolution === 'aggregate' ? collapsed : 0;
  assumptions.push(`resolution_mode:${resolution}`);

  return {
    inputRowCount,
    distinctParentCount,
    childrenPerParent,
    expectedTargetRecordCount,
    rejectedRecordCount,
    droppedChildCount,
    compressedChildCount,
    collisionGroups,
    collisionRowIndexes,
    collisionCount: collisionGroups.length,
    assumptions,
    unavailableChecks,
  };
}
