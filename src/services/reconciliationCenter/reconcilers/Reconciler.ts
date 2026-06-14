import type { ReconciliationDiscrepancy } from '../invoiceComparison';

export interface ReconcilerRunContext {
  tenantId: string;
  /**
   * reconciliation_schedules.integration_config_id. The DB column is NOT NULL since
   * migration 056, so the dispatch path always passes a string; this stays
   * `string | null` as defense-in-depth for the direct-validation path (the
   * `missing_schedule_config_ref` guard).
   */
  integrationConfigId: string | null;
}

export type ReconcilerConfigReason =
  | 'missing_schedule_config_ref'
  | 'config_not_found'
  | 'config_system_pair_mismatch'
  | 'config_missing_auth';

/** Thrown when a schedule's integration config is absent, mismatched, or missing auth. */
export class ReconcilerConfigError extends Error {
  readonly reasonCode: ReconcilerConfigReason;
  constructor(reasonCode: ReconcilerConfigReason, detail?: string) {
    super(`reconciliation: ${reasonCode}${detail ? ` (${detail})` : ''}`);
    this.name = 'ReconcilerConfigError';
    this.reasonCode = reasonCode;
  }
}

/** A cadence handler that fetches from two systems and returns discrepancies. */
export interface Reconciler {
  /** Matches reconciliation_schedules.handler_key. */
  readonly key: string;
  /**
   * Static (synchronous, no-network) validation of the schedule's integration
   * config. Throws ReconcilerConfigError on an absent/mismatched/auth-missing
   * config. Throws-only by contract: callers that only need the validation
   * outcome (the schedule-creation/update path) consume it through this
   * interface. Concrete handlers MAY return a richer resolved-config value
   * (legal covariance over `void`) which their own run() reuses.
   */
  validateConfig(ctx: ReconcilerRunContext): void;
  run(ctx: ReconcilerRunContext): Promise<ReconciliationDiscrepancy[]>;
}

export class UnknownReconcilerError extends Error {
  readonly handlerKey: string;
  constructor(handlerKey: string) {
    super(`no reconciler registered for handler_key: ${handlerKey}`);
    this.name = 'UnknownReconcilerError';
    this.handlerKey = handlerKey;
  }
}

export class ReconcilerRegistry {
  private readonly byKey = new Map<string, Reconciler>();

  register(reconciler: Reconciler): void {
    this.byKey.set(reconciler.key, reconciler);
  }

  /** True iff a reconciler is registered under `key`. (Schedule creation/update validate via `get` + `validateConfig`.) */
  has(key: string): boolean {
    return this.byKey.has(key);
  }

  /** Throws UnknownReconcilerError if the key isn't registered (dispatch fails the run). */
  get(key: string): Reconciler {
    const reconciler = this.byKey.get(key);
    if (!reconciler) throw new UnknownReconcilerError(key);
    return reconciler;
  }
}
