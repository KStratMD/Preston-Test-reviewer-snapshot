import { injectable } from 'inversify';
import { Counter, register } from 'prom-client';

/**
 * Prometheus counters for the `netsuite_serialized_asset` execution profile
 * (Task 7, 2026-07-27 NetSuite serialized-asset sync plan).
 *
 * Two hard constraints from the plan shape this whole module:
 *
 *  1. The eight metric names are FIXED by the brief and are spelled here
 *     verbatim (no `_total` suffix, no per-deployment prefix).
 *
 *  2. "a bounded `outcome` label only" — decision 8 forbids a serial number
 *     (or any other unit datum) from reaching a metric label, and an
 *     unbounded label is also a Prometheus cardinality hazard. Every recorder
 *     method therefore takes a CLOSED UNION literal rather than a `string`,
 *     which makes a leak a compile error rather than a review catch. There is
 *     deliberately no `tenant_id` label: tenant attribution for this profile
 *     lives in the audit trail, not in the metric series.
 *
 * `SerializedAssetMetricsRecorder` is the interface `SerializedAssetSyncService`
 * depends on, so the service can be unit-tested without touching the global
 * prom-client registry.
 */

export type SerializedAssetUnitsReadOutcome = 'new' | 'deferred';

/** `previewed` is the dry-run outcome — a preview can never inflate a real upsert series. */
export type SerializedAssetUpsertOutcome = 'created' | 'updated' | 'unknown' | 'previewed';

/** Mirrors `DeferredSerializedUnitReason` plus the dry-run outcome. */
export type SerializedAssetDeferOutcome =
  | 'parent_missing'
  | 'transient_dependency_failure'
  | 'write_failed'
  | 'previewed';

/**
 * `attempts_exhausted` is the explicit give-up signal: a deferred row that has
 * burned through the attempt ceiling is refused without consuming any further
 * target-system API budget, and needs an operator rather than another retry.
 */
export type SerializedAssetQuarantineOutcome =
  | 'invalid_shape'
  | 'ambiguous_parent'
  | 'conflicting_duplicate'
  | 'attempts_exhausted'
  | 'undecodable_payload';

export type SerializedAssetRetryOutcome = 'due' | 'forced' | 'previewed';

export type SerializedAssetRecoveredOutcome = 'deleted' | 'previewed';

export type SerializedAssetGovernanceRejectionOutcome =
  | 'blocked'
  | 'pending_approval'
  | 'loop_detected';

/**
 * `not_ready` is a determinate refusal (a blocker was found); `undeterminable`
 * is the fail-closed 503 case where readiness could not be evaluated at all.
 * Collapsing the two would make an outage indistinguishable from a genuinely
 * disabled tenant on the dashboard — the same distinction
 * `SerializedAssetReadinessService` preserves at the service layer.
 */
export type SerializedAssetReadinessFailureOutcome = 'not_ready' | 'undeterminable';

/** The eight names, exported so audits/dashboards never re-spell them. */
export const SERIALIZED_ASSET_METRIC_NAMES = [
  'serialized_asset_units_read',
  'serialized_asset_units_upserted',
  'serialized_asset_units_deferred',
  'serialized_asset_units_quarantined',
  'serialized_asset_retries_attempted',
  'serialized_asset_deferred_recovered',
  'serialized_asset_governance_rejections',
  'serialized_asset_readiness_failures',
] as const;

export interface SerializedAssetMetricsRecorder {
  recordUnitsRead(outcome: SerializedAssetUnitsReadOutcome, count: number): void;
  recordUnitUpserted(outcome: SerializedAssetUpsertOutcome): void;
  recordUnitDeferred(outcome: SerializedAssetDeferOutcome): void;
  recordUnitQuarantined(outcome: SerializedAssetQuarantineOutcome): void;
  recordRetryAttempted(outcome: SerializedAssetRetryOutcome): void;
  recordDeferredRecovered(outcome: SerializedAssetRecoveredOutcome): void;
  recordGovernanceRejection(outcome: SerializedAssetGovernanceRejectionOutcome): void;
  recordReadinessFailure(outcome: SerializedAssetReadinessFailureOutcome): void;
}

@injectable()
export class SerializedAssetMetrics implements SerializedAssetMetricsRecorder {
  private unitsRead!: Counter<string>;
  private unitsUpserted!: Counter<string>;
  private unitsDeferred!: Counter<string>;
  private unitsQuarantined!: Counter<string>;
  private retriesAttempted!: Counter<string>;
  private deferredRecovered!: Counter<string>;
  private governanceRejections!: Counter<string>;
  private readinessFailures!: Counter<string>;

  constructor() {
    this.unitsRead = new Counter({
      name: 'serialized_asset_units_read',
      help: 'Serialized units read per run, by source (fresh listing vs deferred backlog)',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.unitsUpserted = new Counter({
      name: 'serialized_asset_units_upserted',
      help: 'Serialized units upserted into Salesforce Asset, by upsert outcome',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.unitsDeferred = new Counter({
      name: 'serialized_asset_units_deferred',
      help: 'Serialized units written to the deferred-work store, by reason',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.unitsQuarantined = new Counter({
      name: 'serialized_asset_units_quarantined',
      help: 'Serialized units refused without deferral, by quarantine class',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.retriesAttempted = new Counter({
      name: 'serialized_asset_retries_attempted',
      help: 'Deferred rows pulled back into a run, by retry authorization',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.deferredRecovered = new Counter({
      name: 'serialized_asset_deferred_recovered',
      help: 'Deferred rows cleared after a confirmed Salesforce upsert',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.governanceRejections = new Counter({
      name: 'serialized_asset_governance_rejections',
      help: 'Asset writes refused by guardedWrite, by refusal class',
      labelNames: ['outcome'],
      registers: [register],
    });
    this.readinessFailures = new Counter({
      name: 'serialized_asset_readiness_failures',
      help: 'Runs refused by the non-overrideable runtime readiness re-check',
      labelNames: ['outcome'],
      registers: [register],
    });
  }

  /**
   * Guards `count <= 0` so a run that read nothing does not materialize a
   * permanently-zero series (prom-client creates the child on `inc(0)`).
   * Non-finite counts are dropped for the same reason.
   */
  recordUnitsRead(outcome: SerializedAssetUnitsReadOutcome, count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.unitsRead.labels({ outcome }).inc(count);
  }

  recordUnitUpserted(outcome: SerializedAssetUpsertOutcome): void {
    this.unitsUpserted.labels({ outcome }).inc();
  }

  recordUnitDeferred(outcome: SerializedAssetDeferOutcome): void {
    this.unitsDeferred.labels({ outcome }).inc();
  }

  recordUnitQuarantined(outcome: SerializedAssetQuarantineOutcome): void {
    this.unitsQuarantined.labels({ outcome }).inc();
  }

  recordRetryAttempted(outcome: SerializedAssetRetryOutcome): void {
    this.retriesAttempted.labels({ outcome }).inc();
  }

  recordDeferredRecovered(outcome: SerializedAssetRecoveredOutcome): void {
    this.deferredRecovered.labels({ outcome }).inc();
  }

  recordGovernanceRejection(outcome: SerializedAssetGovernanceRejectionOutcome): void {
    this.governanceRejections.labels({ outcome }).inc();
  }

  recordReadinessFailure(outcome: SerializedAssetReadinessFailureOutcome): void {
    this.readinessFailures.labels({ outcome }).inc();
  }
}
