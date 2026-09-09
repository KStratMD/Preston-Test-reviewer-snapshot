import 'reflect-metadata';
import { register } from 'prom-client';
import {
  SerializedAssetMetrics,
  SERIALIZED_ASSET_METRIC_NAMES,
} from '../../../../src/services/serializedAsset/SerializedAssetMetrics';

/**
 * Task 7 (2026-07-27 NetSuite serialized-asset sync plan) — metrics wrapper.
 *
 * The brief fixes BOTH halves of this contract:
 *   - the eight metric names, verbatim;
 *   - "a bounded `outcome` label only" — no tenant id, no configuration id,
 *     no inventory number, and above all no serial number (decision 8), which
 *     is why every recorder method takes a closed-set outcome literal rather
 *     than an arbitrary string.
 *
 * The label-cardinality assertions below are the enforcement: a future edit
 * that adds `tenant_id` (unbounded) or interpolates unit data into a label
 * fails here rather than in production Prometheus.
 */

type MetricJson = { name: string; values: { labels: Record<string, string>; value: number }[] };

async function metric(name: string): Promise<MetricJson> {
  const all = (await register.getMetricsAsJSON()) as unknown as MetricJson[];
  const found = all.find((m) => m.name === name);
  if (!found) throw new Error(`metric '${name}' was not registered`);
  return found;
}

async function valueFor(name: string, outcome: string): Promise<number | undefined> {
  const m = await metric(name);
  return m.values.find((v) => v.labels.outcome === outcome)?.value;
}

describe('SerializedAssetMetrics (Task 7)', () => {
  let metrics: SerializedAssetMetrics;

  beforeEach(() => {
    register.clear();
    metrics = new SerializedAssetMetrics();
  });

  afterEach(() => {
    register.clear();
  });

  it('registers exactly the eight metric names the plan fixes, verbatim', async () => {
    const all = (await register.getMetricsAsJSON()) as unknown as MetricJson[];
    const names = all.map((m) => m.name).sort();

    expect(names).toEqual(
      [
        'serialized_asset_units_read',
        'serialized_asset_units_upserted',
        'serialized_asset_units_deferred',
        'serialized_asset_units_quarantined',
        'serialized_asset_retries_attempted',
        'serialized_asset_deferred_recovered',
        'serialized_asset_governance_rejections',
        'serialized_asset_readiness_failures',
      ].sort(),
    );
  });

  it('exports the metric-name list so downstream audits do not re-spell them', () => {
    expect([...SERIALIZED_ASSET_METRIC_NAMES].sort()).toEqual(
      [
        'serialized_asset_units_read',
        'serialized_asset_units_upserted',
        'serialized_asset_units_deferred',
        'serialized_asset_units_quarantined',
        'serialized_asset_retries_attempted',
        'serialized_asset_deferred_recovered',
        'serialized_asset_governance_rejections',
        'serialized_asset_readiness_failures',
      ].sort(),
    );
  });

  it('every metric carries the bounded `outcome` label and nothing else', async () => {
    metrics.recordUnitsRead('new', 1);
    metrics.recordUnitsRead('deferred', 1);
    metrics.recordUnitUpserted('created');
    metrics.recordUnitDeferred('parent_missing');
    metrics.recordUnitQuarantined('invalid_shape');
    metrics.recordRetryAttempted('due');
    metrics.recordDeferredRecovered('deleted');
    metrics.recordGovernanceRejection('blocked');
    metrics.recordReadinessFailure('not_ready');

    const all = (await register.getMetricsAsJSON()) as unknown as MetricJson[];
    for (const m of all) {
      for (const sample of m.values) {
        expect(Object.keys(sample.labels).sort()).toEqual(['outcome']);
      }
    }
  });

  it('recordUnitsRead accumulates by count and never emits a zero-count sample', async () => {
    metrics.recordUnitsRead('new', 3);
    metrics.recordUnitsRead('new', 2);
    metrics.recordUnitsRead('deferred', 0);

    expect(await valueFor('serialized_asset_units_read', 'new')).toBe(5);
    expect(await valueFor('serialized_asset_units_read', 'deferred')).toBeUndefined();
  });

  it('recordUnitUpserted separates created / updated / unknown / previewed', async () => {
    metrics.recordUnitUpserted('created');
    metrics.recordUnitUpserted('created');
    metrics.recordUnitUpserted('updated');
    metrics.recordUnitUpserted('unknown');
    metrics.recordUnitUpserted('previewed');

    expect(await valueFor('serialized_asset_units_upserted', 'created')).toBe(2);
    expect(await valueFor('serialized_asset_units_upserted', 'updated')).toBe(1);
    expect(await valueFor('serialized_asset_units_upserted', 'unknown')).toBe(1);
    expect(await valueFor('serialized_asset_units_upserted', 'previewed')).toBe(1);
  });

  it('recordUnitDeferred uses the deferred-store reason enum plus the dry-run outcome', async () => {
    metrics.recordUnitDeferred('parent_missing');
    metrics.recordUnitDeferred('transient_dependency_failure');
    metrics.recordUnitDeferred('previewed');

    expect(await valueFor('serialized_asset_units_deferred', 'parent_missing')).toBe(1);
    expect(await valueFor('serialized_asset_units_deferred', 'transient_dependency_failure')).toBe(1);
    expect(await valueFor('serialized_asset_units_deferred', 'previewed')).toBe(1);
  });

  it('recordUnitQuarantined distinguishes the four quarantine classes', async () => {
    metrics.recordUnitQuarantined('invalid_shape');
    metrics.recordUnitQuarantined('ambiguous_parent');
    metrics.recordUnitQuarantined('conflicting_duplicate');
    metrics.recordUnitQuarantined('conflicting_duplicate');
    metrics.recordUnitQuarantined('attempts_exhausted');

    expect(await valueFor('serialized_asset_units_quarantined', 'invalid_shape')).toBe(1);
    expect(await valueFor('serialized_asset_units_quarantined', 'ambiguous_parent')).toBe(1);
    expect(await valueFor('serialized_asset_units_quarantined', 'conflicting_duplicate')).toBe(2);
    expect(await valueFor('serialized_asset_units_quarantined', 'attempts_exhausted')).toBe(1);
  });

  it('recordRetryAttempted distinguishes due / forced / previewed', async () => {
    metrics.recordRetryAttempted('due');
    metrics.recordRetryAttempted('forced');
    metrics.recordRetryAttempted('previewed');

    expect(await valueFor('serialized_asset_retries_attempted', 'due')).toBe(1);
    expect(await valueFor('serialized_asset_retries_attempted', 'forced')).toBe(1);
    expect(await valueFor('serialized_asset_retries_attempted', 'previewed')).toBe(1);
  });

  it('recordDeferredRecovered and recordGovernanceRejection and recordReadinessFailure increment', async () => {
    metrics.recordDeferredRecovered('deleted');
    metrics.recordGovernanceRejection('blocked');
    metrics.recordGovernanceRejection('pending_approval');
    metrics.recordGovernanceRejection('loop_detected');
    metrics.recordReadinessFailure('not_ready');
    metrics.recordReadinessFailure('undeterminable');

    expect(await valueFor('serialized_asset_deferred_recovered', 'deleted')).toBe(1);
    expect(await valueFor('serialized_asset_governance_rejections', 'blocked')).toBe(1);
    expect(await valueFor('serialized_asset_governance_rejections', 'pending_approval')).toBe(1);
    expect(await valueFor('serialized_asset_governance_rejections', 'loop_detected')).toBe(1);
    expect(await valueFor('serialized_asset_readiness_failures', 'not_ready')).toBe(1);
    expect(await valueFor('serialized_asset_readiness_failures', 'undeterminable')).toBe(1);
  });
});
