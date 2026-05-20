/**
 * FlowTemplate — declarative governed flow contract.
 *
 * A FlowTemplate describes a source-event → target-write integration as data,
 * not as imperative orchestration code. `FlowExecutor.execute(template, event, ctx)`
 * is the single runtime that walks every template through the same governance,
 * dispatch, and result-shaping pipeline.
 *
 * Narrow PR 14 scope (this PR):
 *   - Single-row operations only: 'create' | 'update' | 'delete'.
 *   - One sample template ships in `src/flows/templates/samples/`.
 *   - Hard deps deferred: LineageRecorder (PR 12) and OwnershipResolver (PR 13)
 *     are NOT plumbed into FlowContext yet. The merged remediation plan's
 *     three-template gallery (OTC + PTP + Payouts) and the `bulk_upsert`
 *     operation land in PR 14b once those services exist.
 *
 * The DSL keeps the surface intentionally small. Adding fields here implies
 * adding executor code AND a CI-gate clause AND test coverage — keep the
 * default answer to "no".
 */

import type { OutboundContext, OutboundDecision } from '../../services/governance/OutboundGovernanceService';

export type FlowCategory =
  | 'order_to_cash'
  | 'procure_to_pay'
  | 'payouts'
  | 'reconciliation'
  | 'master_data_sync';

/**
 * Operation-discriminated target. Each variant carries the fields that
 * operation actually needs — `delete` needs a way to resolve the target id;
 * `create`/`update` do not. `bulk_upsert` is intentionally absent in the
 * narrow PR 14 scope.
 */
export type FlowTarget =
  | {
      system: string;
      recordType: string;
      operation: 'create' | 'update';
    }
  | {
      system: string;
      recordType: string;
      operation: 'delete';
      /**
       * Yield the target record id from the source event. Lineage uses this
       * when the connector's delete response carries no `id` to echo back.
       *
       * **Must be declared as an inline callable** — arrow function, function
       * expression, or method shorthand. The
       * `scripts/check-flow-template-instrumentation.mjs` CI gate rejects
       * identifier references (e.g. `resolveTargetRecordId: someHelper`) so
       * the constructor pattern is visible at the template declaration site.
       * If you need to share resolution logic across templates, factor it
       * out into a helper and call it from inside the inline arrow:
       *
       * ```ts
       * resolveTargetRecordId: async (event, ctx) => someHelper(event, ctx)
       * ```
       *
       * The resolver MUST return a non-empty string (whitespace-only and
       * empty strings are rejected). It MUST be idempotent — today
       * FlowExecutor invokes it exactly once per `execute()` (the
       * pre-governance result is threaded through both enqueue + dispatch
       * via `preResolvedDeleteId`), but a future retry loop or split call
       * path could invoke it again on the same event; a non-idempotent
       * resolver would then produce a mismatch between the persisted
       * approval row and the dispatch call.
       */
      resolveTargetRecordId: (event: unknown, ctx: FlowContext) => Promise<string>;
    };

/**
 * Result of an optional `validate` hook. `ok: false` short-circuits the
 * executor before any connector write.
 *
 * Shape note: both fields always present (errors is `[]` when ok). The
 * discriminated-union variant (`{ok: true} | {ok: false; errors: string[]}`)
 * doesn't narrow cleanly under this repo's `strict: false` tsconfig — see the
 * project handoff memory on strict TS narrowing. The flat shape keeps callers
 * simple AND survives the compiler.
 */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/**
 * Retry policy applied to the dispatch step. The executor itself is not yet
 * a retry loop in PR 14 narrowed — these fields are persisted on the template
 * so PR 14b's retry implementation can read them without a template revision.
 */
export interface FlowRetryPolicy {
  maxAttempts: number;
  backoffMs: number;
  /**
   * Stable per-event key used by future at-most-once dispatch. Today only the
   * registry consistency CI gate reads this — the executor itself does NOT
   * yet act on the key.
   *
   * **Must be declared as an inline callable** — arrow function, function
   * expression, or method shorthand. The CI gate
   * (`scripts/check-flow-template-instrumentation.mjs`) rejects identifier
   * references (e.g. `idempotencyKey: makeKey`) so the per-template key
   * derivation is visible at the template declaration site. If you need to
   * share key-derivation logic across templates, factor it out into a helper
   * and invoke it from inside the inline arrow:
   *
   * ```ts
   * idempotencyKey: (event) => makeKey(event as MyEventType)
   * ```
   */
  idempotencyKey: (event: unknown) => string;
}

/**
 * What the executor passes into template hooks. PR 14b adds `lineageRecorder`
 * (PR 12) and `ownershipResolver` (PR 13). Today FlowContext is intentionally
 * thin so the executor wires only what already exists.
 *
 * Connector contract (Codex 5.5 HIGH on PR #825): the CALLER is responsible
 * for resolving + initializing the target connector and passing it as
 * `connector`. FlowExecutor will NOT call `ConnectorManager.getConnector` or
 * `connector.initialize` itself — the route handler / orchestrator that
 * invokes `execute()` already has the integration config id + auth handle in
 * scope; replicating that resolution inside the executor would either need a
 * second wide constructor (auth service, integration config lookup, etc.) or
 * silently produce uninitialized connectors that fail at the first HTTP
 * call. The executor verifies `connector.systemType === template.target.system`
 * and rejects with `{status: 'failed'}` on mismatch.
 */
import type { IConnector } from '../../interfaces/IConnector';

export interface FlowContext {
  tenantId: string;
  /**
   * Caller identity for governance / audit. Falls back to SYSTEM_IDENTITY at
   * the executor boundary when the caller does not supply a userId; never
   * read raw here without acknowledging the route-vs-system distinction.
   */
  userId?: string;
  correlationId: string;
  /**
   * Pre-initialized target connector. The caller resolves this via
   * `ConnectorManager.getConnector(systemType, configId)` and invokes
   * `.initialize(authConfig)` BEFORE calling `FlowExecutor.execute()`.
   * FlowExecutor asserts `connector.systemType === template.target.system`
   * to catch caller errors before they reach the wire.
   */
  connector: IConnector;
}

/**
 * The declarative template itself.
 */
export interface FlowTemplate<TSourceEvent = unknown, TTargetRecord extends Record<string, unknown> = Record<string, unknown>> {
  /** Stable identifier, kebab-case + version suffix (e.g. 'sample-hubspot-to-netsuite-contact-v1'). */
  id: string;
  category: FlowCategory;
  version: string;

  source: { system: string; eventType: string };
  target: FlowTarget;

  /** Build the target record from the source event. */
  transform(event: TSourceEvent, ctx: FlowContext): Promise<TTargetRecord>;
  /**
   * Optional pre-write validation. `ok: false` short-circuits the executor
   * and returns `{status: 'blocked', reason: 'validation', findings: errors}`
   * without invoking the connector. (A thrown exception inside `validate`
   * falls through to `{status: 'failed'}` — distinct from a clean
   * "validation said no" outcome.)
   */
  validate?(record: TTargetRecord, ctx: FlowContext): Promise<ValidationResult>;
  /** Risk hint forwarded to OutboundGovernanceService — DLP scan may override. */
  riskClassification(record: TTargetRecord, ctx: FlowContext): 'low' | 'medium' | 'high';

  retryPolicy: FlowRetryPolicy;

  /** Operator-facing description shown in PR 10/11/12 surfaces when those ship. */
  description: string;
  /** Plain-English audit-trail-style notes about what governance does on this template. */
  governanceCallouts: string[];
}

// Re-export for callers that compose template authoring with governance types.
export type { OutboundContext, OutboundDecision };
