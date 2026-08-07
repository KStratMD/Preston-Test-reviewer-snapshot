import pLimit from 'p-limit';
import { connectorKeyForSystem } from '../../connectors/connectorIdentity';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import {
  LoopDetectedError,
  OwnershipPendingApprovalError,
  WriteBlockedError,
} from '../../governance/sourceOfTruth/ConflictResolutionPolicy';
import { ServiceUnavailableAppError } from '../../errors/AppError';
import { canonicalJson, sha256Hex } from '../cardinality/fingerprint';
import { assertSalesforceSerializedAssetReadCapabilities } from '../../types/serializedAsset';
import { errorNameOf } from './errorName';
import { normalizeBatch } from './NetSuiteSerializedUnitReader';
import { requireReadySerializedAssetProfile } from './SerializedAssetProfileValidator';
import { SalesforceAssetPayloadBuilder } from './SalesforceAssetPayloadBuilder';
import { SalesforceProductResolver } from './SalesforceProductResolver';
import type { ProductResolution } from './SalesforceProductResolver';
import type { GuardedWriteContext, GuardedWriteDeps } from '../../governance/sourceOfTruth/guardedWrite';
import type { CallerSystem, SourceSystem } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import type { IConnector, ListOptions } from '../../interfaces/IConnector';
import type { DataRecord, IntegrationConfig } from '../../types';
import type { ReadySerializedAssetProfileConfig, SerializedUnit } from '../../types/serializedAsset';
import type { Logger } from '../../utils/Logger';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type {
  DeferredSerializedUnit,
  DeferredSerializedUnitInput,
  DeferredSerializedUnitPage,
  DeferredSerializedUnitReason,
  UndecodableDeferredRow,
} from './DeferredSerializedUnitRepository';
import type {
  SerializedAssetReadinessBlocker,
  SerializedAssetReadinessEvaluator,
  SerializedAssetReadinessResult,
} from './SerializedAssetReadinessService';
import type { SerializedAssetMetricsRecorder } from './SerializedAssetMetrics';

/**
 * Bounded orchestration for the `netsuite_serialized_asset` execution profile
 * (Task 7, 2026-07-27 NetSuite serialized-asset sync plan). This is the only
 * place a NetSuite `inventorynumber` becomes a Salesforce `Asset`.
 *
 * Everything data-shaped is delegated to the pure/adapter modules that already
 * shipped — normalization (Task 3), Product2 resolution + payload construction
 * (Task 4), durable deferral (Task 2), live readiness (Task 6). What lives here
 * is sequencing, deduplication, bounded fan-out, retry policy, and privacy.
 *
 * ── Privacy (decision 8), by construction, not by discipline ────────────────
 * A serial number may appear in exactly two places: the outbound Salesforce
 * payload, and `deferred_serialized_units.normalized_payload`. Everything this
 * module emits — logger arguments, metric labels, audit details, thrown error
 * messages, the returned result — is built from either a fixed constant, a
 * closed-set enum, or `unitReference()` (a one-way SHA-256 digest). No unit
 * datum is ever interpolated into a string here, and no underlying error object
 * is ever logged or re-thrown: a NetSuite/Salesforce/Postgres error can echo
 * the row that caused it (a Postgres unique/CHECK violation `DETAIL` carries
 * the WHOLE failing row, `normalized_payload` included), so only the error's
 * CLASS NAME is ever recorded.
 *
 * ── Runtime readiness (non-overrideable) ───────────────────────────────────
 * Activation-time readiness is not sufficient on its own. `ConfigurationService.
 * loadConfigurations` performs only a shallow presence check when restoring
 * configs from disk, so a config restored at startup never passed readiness in
 * THIS process; and a Salesforce field can lose its External ID flag, its
 * uniqueness, or the principal's permission at any time after activation. So
 * `run()` re-evaluates readiness against the live tenant-owned connector before
 * touching anything. The result is held in a RUN-SCOPED local — computed once
 * per `run()` (so a 500-unit batch does not re-describe per unit) and never
 * memoized on the instance (so the next run observes schema drift).
 *
 * ── Concurrency posture ────────────────────────────────────────────────────
 * WITHIN a run: deduplication by `inventoryNumberId` guarantees at most one
 * work item per key, and all deferral writes additionally pass through a
 * run-scoped serialization gate, so this service never has two in-flight
 * writers for the same `(tenant, configuration, inventory number)` key.
 * ACROSS runs: there is no lease or row lock by design, so two overlapping
 * executions may each issue an upsert for the same unit. The guarantee is
 * CONVERGENCE (Salesforce External-ID upsert is idempotent; the deferred store
 * is unique by key), not call-count uniqueness. `persistDeferral` therefore
 * retries once: `upsertDeferred` is select-then-write, so under READ COMMITTED
 * two concurrent writers can both miss the SELECT and the loser takes a unique
 * violation — on the retry it finds the winner's row and takes the UPDATE arm.
 */

// ---------------------------------------------------------------------------
// Fixed vocabulary
// ---------------------------------------------------------------------------

/**
 * The profile is NetSuite -> Salesforce by definition and
 * `requireReadySerializedAssetProfile` refuses anything else, so these are
 * literals rather than a mapping over `config.sourceSystem`/`.targetSystem`.
 * That also keeps them correctly typed as manifest vocabulary without a cast.
 */
const SERIALIZED_ASSET_CALLER_SYSTEM: CallerSystem = 'netsuite';
const SERIALIZED_ASSET_TARGET_SYSTEM: SourceSystem = 'salesforce';

/**
 * Governance entity name. Deliberately NOT a `CanonicalEntity` — a serialized
 * physical unit is not one of the manifest's declared entities, so the
 * ownership resolver returns `no_policy_declared` and the audit row carries
 * the `ownership_no_policy_declared` flag. Declaring it in the manifest is a
 * separate, deliberate policy decision.
 */
const SERIALIZED_ASSET_ENTITY = 'serialized_asset';

// Deliberately NO `TARGET_ENTITY = 'Asset'` constant. Decision 14 requires the
// mutation's first argument and `resume.entityType` to be STRING LITERALS at
// the callsite: `check-write-descriptor-equivalence.mjs` bails to `[skipped]`
// on a non-literal, which would silently disable the gate on the one write
// this whole profile exists to make. A constant here would be an inviting
// substitution for a future editor, so it does not exist.

const MAX_BATCH_SIZE = 1000;
const DEFAULT_BATCH_SIZE = 100;
const MAX_CONCURRENCY = 16;
const DEFAULT_CONCURRENCY = 4;

/**
 * Source-sweep bounds. `batchSize` is the PAGE size, not the run size: without
 * paging, every unit past the first page would never sync at all (5,000
 * inventory numbers at `batchSize: 100` would strand 4,900 forever) while the
 * same first page was re-upserted on every run.
 *
 * The sweep is still bounded, as the plan requires — at most
 * `MAX_SOURCE_PAGES` pages and `MAX_UNITS_PER_RUN` units, whichever binds
 * first. When a cap truncates the sweep the run REPORTS it via
 * `result.truncated` rather than logging it silently.
 *
 * Crucially, that follow-up run makes PROGRESS: the sweep resumes from the
 * durable cursor (migration 059) and wraps to the beginning once the source is
 * exhausted, so every row is eventually reached. Before the cursor existed the
 * sweep always restarted at offset 0, which made `truncated: true` honest but
 * its implied remedy useless — the next run re-swept the identical window and
 * everything past the bound was unreachable on EVERY run.
 */
const MAX_SOURCE_PAGES = 20;
const MAX_UNITS_PER_RUN = 5000;

/**
 * Deterministic page ordering, which is what makes offset paging sound.
 * `NetSuiteConnector.list`/`listPage` now forward `sortBy`/`sortOrder` to the
 * REST record service (they were previously declared on `ListOptions` but
 * dropped, so a requested ordering silently had no effect).
 *
 * Why it matters beyond tidiness: without a stable order, an upstream insert or
 * delete between two page fetches can shift a row across a page boundary so it
 * is returned by NO page — a silent DROP. Deduplication collapses the opposite
 * case (a row returned twice) but cannot recover a row that was never returned.
 *
 * Residual risk, stated plainly: a stable order does NOT make offset paging
 * safe. Deleting an already-read row upstream shifts every later row back by
 * one, so the row that slides across the page boundary is returned by no page
 * — it is skipped even with the sort fully honoured and `hasMore`
 * authoritative, and the run still reports `truncated: false`. Ordering only
 * removes the arbitrary-reshuffle case; it does not remove this one. Only
 * KEYSET paging (`WHERE id > lastId`) closes it properly, and that is
 * deliberately not implemented here.
 *
 * What actually recovers a skipped row is the WRAP: the sweep returns to
 * offset 0 once the source is exhausted and re-reads everything, so the row is
 * picked up on a later cycle rather than lost permanently. That makes the gap
 * a latency problem, not a data-loss one.
 */
const SOURCE_PAGE_SORT_FIELD = 'id';

/** One extra attempt only — see `persistDeferral`'s doc comment. */
const DEFERRAL_PERSIST_ATTEMPTS = 2;

/**
 * Attempt ceiling for a deferred row. Backoff saturates long before this (the
 * exponent caps at 2^11 x 1 minute = 34.13h, which `computeDeferredBackoffMs`
 * clamps to its 24h ceiling), so a row that reaches 24 attempts has been
 * retried across roughly two weeks — ~34h of doubling for attempts 1-11 plus
 * 13 saturated 24h waits — and is not going to resolve itself. Past the ceiling the row is ABANDONED: it is
 * never dispatched again — consuming no further Salesforce API budget — but its
 * schedule is still advanced once per encounter so `listDue` stops returning it
 * on every run, and it is reported as an `attempts_exhausted` quarantine so an
 * operator has an explicit give-up signal instead of a silent forever-retry.
 */
const MAX_DEFERRAL_ATTEMPTS = 24;

// ---------------------------------------------------------------------------
// Fixed, content-free diagnostic text (decision 8)
// ---------------------------------------------------------------------------

const LOG_WRITE_FAILED = 'Serialized-asset sync: Asset upsert failed';
const LOG_DEFERRAL_PERSIST_FAILED = 'Serialized-asset sync: deferred-work write failed';
const LOG_DEFERRAL_DELETE_FAILED = 'Serialized-asset sync: deferred-work cleanup failed after a confirmed upsert';
const LOG_DEFERRAL_TOUCH_FAILED = 'Serialized-asset sync: deferred-work retry-schedule advance failed';
const LOG_QUARANTINE_AUDIT_FAILED = 'Serialized-asset sync: quarantine audit row could not be written';
const LOG_FOREIGN_DEFERRED_ROW = 'Serialized-asset sync: refused a deferred row outside the run scope';

const STAGE_MESSAGES: Record<SerializedAssetRunStage, string> = {
  source_listing: 'Serialized-asset sync failed: the NetSuite inventory-number listing could not be read',
  deferred_listing: 'Serialized-asset sync failed: the deferred-work backlog could not be read',
  readiness: 'Serialized-asset sync failed: the runtime readiness re-check could not be completed',
};

const REFUSAL_MESSAGES: Record<SerializedAssetRunRefusal, string> = {
  actor_tenant_mismatch:
    'Serialized-asset sync refused: the acting tenant does not own this configuration',
};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SerializedAssetRunStage = 'source_listing' | 'deferred_listing' | 'readiness';
export type SerializedAssetRunRefusal = 'actor_tenant_mismatch';

/**
 * A stage-level failure. Carries a fixed message plus the underlying error's
 * CLASS NAME only — never its message, and never a `cause` chain, because the
 * upstream error may quote the record that caused it.
 */
export class SerializedAssetRunStageError extends Error {
  public readonly stage: SerializedAssetRunStage;
  public readonly errorName: string;

  constructor(stage: SerializedAssetRunStage, errorName: string) {
    super(STAGE_MESSAGES[stage]);
    this.name = 'SerializedAssetRunStageError';
    this.stage = stage;
    this.errorName = errorName;
  }
}

/** The run never started: a caller-side precondition failed. */
export class SerializedAssetRunRefusedError extends Error {
  public readonly refusal: SerializedAssetRunRefusal;

  constructor(refusal: SerializedAssetRunRefusal) {
    super(REFUSAL_MESSAGES[refusal]);
    this.name = 'SerializedAssetRunRefusedError';
    this.refusal = refusal;
  }
}

/**
 * The live readiness re-check refused the run. Carries the readiness service's
 * sanitized blockers verbatim — those are field-NAME-level messages built from
 * describe metadata, never from unit data.
 */
export class SerializedAssetRunNotReadyError extends Error {
  public readonly blockers: SerializedAssetReadinessBlocker[];

  constructor(blockers: SerializedAssetReadinessBlocker[]) {
    super('Serialized-asset sync refused: the live Salesforce readiness re-check did not pass');
    this.name = 'SerializedAssetRunNotReadyError';
    this.blockers = blockers;
  }
}

export type SerializedAssetRunFailureCategory =
  | 'invalid_shape'
  | 'ambiguous_parent'
  | 'conflicting_duplicate'
  | 'attempts_exhausted'
  | 'governance_rejected'
  | 'write_failed'
  | 'deferral_persist_failed'
  /**
   * A durable deferred row whose stored payload no longer decodes. Reported on
   * every run that reads it rather than dropped, because nothing else in the
   * design ever surfaces a corrupt row: it can never be dispatched, so it can
   * never fail a write, and it is not a normalization failure (it was a valid
   * unit when it was persisted).
   */
  | 'undecodable_payload';

/**
 * One per-unit outcome the caller can act on. `unitRef` is the one-way digest
 * from `unitReference()`; `recordIndex` is present only for records that failed
 * normalization (there is no unit, therefore no key, to digest). Deliberately
 * carries neither `SerializedAssetFailure.recordHash` (which digests the WHOLE
 * raw record including the serial, so pairing it with other run context would
 * narrow it) nor any field name or value.
 */
export interface SerializedAssetRunFailure {
  unitRef?: string;
  recordIndex?: number;
  category: SerializedAssetRunFailureCategory;
}

/** Counts for a run that actually wrote. */
export interface SerializedAssetSyncExecutedResult {
  mode: 'executed';
  unitsRead: number;
  upserted: number;
  deferred: number;
  quarantined: number;
  failed: number;
  deferredRecovered: number;
  retriesAttempted: number;
  governanceRejections: number;
  duplicatesCollapsed: number;
  /**
   * A source-sweep bound stopped the listing with rows still behind it, so this
   * run did NOT see the whole source. Callers should schedule a follow-up run
   * rather than treating the counts as a complete pass.
   */
  truncated: boolean;
  failures: SerializedAssetRunFailure[];
}

/**
 * Counts for a `dryRun: true` preview. Structurally distinct from the executed
 * shape — different discriminator AND different field names — so a preview can
 * never be mistaken for a completed run by a dashboard, an audit consumer, or
 * a caller that forgot to check `mode`.
 */
export interface SerializedAssetSyncPreviewResult {
  mode: 'previewed';
  unitsRead: number;
  wouldUpsert: number;
  wouldDefer: number;
  quarantined: number;
  failed: number;
  wouldRecoverDeferred: number;
  retriesPreviewed: number;
  duplicatesCollapsed: number;
  /** Same meaning as on the executed shape — a preview can be partial too. */
  truncated: boolean;
  failures: SerializedAssetRunFailure[];
}

export type SerializedAssetSyncResult =
  | SerializedAssetSyncExecutedResult
  | SerializedAssetSyncPreviewResult;

export interface SerializedAssetSyncOptions {
  batchSize: number;
  concurrency: number;
  dryRun: boolean;
  /**
   * Decision 11: an early retry that ignores `next_attempt_at`. This service
   * TRUSTS the flag — authorizing it (verified tenant administrator) is the
   * route layer's job (Task 9). Ordinary runs leave it false and honor the
   * schedule.
   */
  forceDeferredRetry: boolean;
}

export interface SerializedAssetSyncActor {
  tenantId: string;
  userId: string;
  correlationId: string;
}

export interface SerializedAssetSyncInput {
  config: IntegrationConfig;
  sourceConnector: IConnector;
  targetConnector: IConnector;
  options: SerializedAssetSyncOptions;
  actor: SerializedAssetSyncActor;
}

/**
 * The deferred-store surface this service uses. Narrowed to four methods (of
 * `DeferredSerializedUnitRepository`, which satisfies it structurally) so the
 * orchestrator cannot reach for anything else and so tests need no database.
 */
export interface SerializedAssetDeferredStore {
  upsertDeferred(input: DeferredSerializedUnitInput, now: Date): Promise<void>;
  /**
   * Both listings report corrupt rows alongside the decoded ones rather than
   * dropping them (see `DeferredSerializedUnitPage`). Handling them is this
   * service's job because only it holds the run context — in particular
   * `dryRun`, which must suppress the back-off those rows still need.
   */
  listDue(
    tenantId: string,
    configurationId: string,
    now: Date,
    limit: number,
  ): Promise<DeferredSerializedUnitPage>;
  listForRetry(
    tenantId: string,
    configurationId: string,
    limit: number,
  ): Promise<DeferredSerializedUnitPage>;
  deleteSucceeded(
    tenantId: string,
    configurationId: string,
    inventoryNumberId: string,
  ): Promise<boolean>;
  /**
   * Advances `attempt_count` + `next_attempt_at` only — never `reason`. Used
   * for terminal NON-success outcomes that are not themselves deferral reasons
   * (see `advanceDeferredAttempt`).
   */
  touchAttempt(
    tenantId: string,
    configurationId: string,
    inventoryNumberId: string,
    now: Date,
  ): Promise<number | null>;
}

/** The single audit method quarantine events use. `AuditService` satisfies it. */
export type SerializedAssetQuarantineAuditor = Pick<AuditService, 'logDataAccess'>;

/**
 * Durable per-(tenant, configuration) sweep position (migration 059).
 * `SerializedAssetSweepCursorRepository` satisfies it structurally.
 */
export interface SerializedAssetSweepCursorStore {
  getNextOffset(tenantId: string, configurationId: string): Promise<number>;
  setNextOffset(
    tenantId: string,
    configurationId: string,
    nextOffset: number,
    now: Date,
  ): Promise<void>;
}

/**
 * The optional richer listing surface: page records PLUS the service's own
 * `hasMore`. `NetSuiteConnector.listPage` implements it.
 *
 * `hasMore` is the AUTHORITATIVE exhaustion signal. The short-page heuristic
 * (`records.length < limit` means "end of source") is wrong whenever the
 * service applies its own page cap below the requested limit — the sweep would
 * stop early and report itself complete, a silent partial sync. Connectors
 * without this method still work, on the heuristic alone.
 */
export interface PagedListConnector {
  listPage(
    entityType: string,
    options?: ListOptions,
  ): Promise<{ records: DataRecord[]; hasMore?: boolean; totalResults?: number }>;
}

function supportsPagedList(connector: IConnector): connector is IConnector & PagedListConnector {
  return typeof (connector as Partial<PagedListConnector>).listPage === 'function';
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * The ONLY identifier this module puts in a diagnostic:
 * `sha256(tenantId + '\0' + configurationId + '\0' + inventoryNumberId)`.
 * One-way and salted by the tenant/config pair, so it is stable within a
 * tenant, correlatable across runs, and useless as a cross-tenant oracle.
 */
export function unitReference(unit: {
  tenantId: string;
  configurationId: string;
  inventoryNumberId: string;
}): string {
  return sha256Hex(`${unit.tenantId}\0${unit.configurationId}\0${unit.inventoryNumberId}`);
}

/**
 * Canonical projection used for identical-vs-conflicting duplicate detection:
 * item id, serial, status, and location. Digested rather than returned raw so
 * that even an accidental future log of this value cannot leak a serial —
 * equality is all any caller needs.
 */
function duplicateProjection(unit: SerializedUnit): string {
  return sha256Hex(
    canonicalJson({
      itemId: unit.itemId,
      serialNumber: unit.serialNumber,
      status: unit.status ?? null,
      location: unit.location ?? null,
    }),
  );
}

/**
 * Terminator for the run-scoped serialization chain: collapses both settlement
 * arms to `void` so the chain carries no value and never surfaces an unhandled
 * rejection. Named (rather than an inline `() => undefined`) so its return type
 * is explicit under `noImplicitAny`.
 */
function settleGate(): void {
  // Intentional: the caller already observed this operation's outcome.
}

function boundedBatchSize(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_BATCH_SIZE;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_BATCH_SIZE);
}

function boundedConcurrency(requested: number): number {
  if (!Number.isFinite(requested)) return DEFAULT_CONCURRENCY;
  const floored = Math.floor(requested);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_CONCURRENCY);
}

/** One unit scheduled for this run, plus whether a durable deferred row backs it. */
interface SerializedAssetWorkItem {
  unit: SerializedUnit;
  fromDeferred: boolean;
}

interface RunCounters {
  unitsRead: number;
  upserted: number;
  deferred: number;
  quarantined: number;
  failed: number;
  deferredRecovered: number;
  retriesAttempted: number;
  governanceRejections: number;
  duplicatesCollapsed: number;
}

function emptyCounters(): RunCounters {
  return {
    unitsRead: 0,
    upserted: 0,
    deferred: 0,
    quarantined: 0,
    failed: 0,
    deferredRecovered: 0,
    retriesAttempted: 0,
    governanceRejections: 0,
    duplicatesCollapsed: 0,
  };
}

/** Everything a single `run()` needs, assembled once and threaded through. */
interface RunContext {
  config: IntegrationConfig;
  profile: ReadySerializedAssetProfileConfig;
  actor: SerializedAssetSyncActor;
  targetConnector: IConnector;
  productResolver: SalesforceProductResolver;
  /** Run-scoped Product2 lookup cache — see `resolveProduct`. */
  productResolutions: Map<string, Promise<ProductResolution>>;
  dryRun: boolean;
  now: Date;
  counters: RunCounters;
  failures: SerializedAssetRunFailure[];
  /** Set from the source sweep: a cap stopped it with rows still behind. */
  truncated: boolean;
  /** Run-scoped serialization gate for deferred-store writes. */
  serialize: <T>(operation: () => Promise<T>) => Promise<T>;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SerializedAssetSyncService {
  constructor(
    private readonly deferredStore: SerializedAssetDeferredStore,
    private readonly cursorStore: SerializedAssetSweepCursorStore,
    private readonly readiness: SerializedAssetReadinessEvaluator,
    private readonly metrics: SerializedAssetMetricsRecorder,
    private readonly guardedWriteDeps: GuardedWriteDeps,
    private readonly quarantineAuditor: SerializedAssetQuarantineAuditor,
    private readonly logger?: Logger,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async run(input: SerializedAssetSyncInput): Promise<SerializedAssetSyncResult> {
    const { config, sourceConnector, targetConnector, options, actor } = input;

    // The configuration is the tenant-scoped object the route resolved; the
    // actor is the verified JWT identity. A disagreement is a caller bug that
    // would otherwise read one tenant's backlog under another tenant's rights.
    if (config.tenantId !== actor.tenantId) {
      throw new SerializedAssetRunRefusedError('actor_tenant_mismatch');
    }

    // --- Step 1a: the profile contract, re-checked at runtime -------------
    const profile = requireReadySerializedAssetProfile(config);

    // --- Step 1b: read capabilities, narrowed for READS ONLY --------------
    // `readConnector` is the narrowed receiver; the guarded mutation later
    // binds its own base-typed `writeConnector` from the SAME connector so the
    // static write scanners see a plain `IConnector` receiver rather than an
    // intersection type they do not traverse.
    const readConnector: IConnector = targetConnector;
    assertSalesforceSerializedAssetReadCapabilities(readConnector);

    // --- Step 1c: the non-overrideable live readiness re-check ------------
    // Evaluated ONCE here and held in this run-scoped local. Never memoized on
    // the instance: the next run must be able to observe schema drift.
    //
    // The CALLER'S connector is handed to the evaluator so the check describes
    // the very instance the upsert below will go through. Readiness is the gate
    // protecting decision 4's External-ID-uniqueness assumption; letting it
    // resolve a second connector would prove nothing about the write path if
    // the two ever diverged (and would cost a second construction, auth, and
    // two describes every run). Credential ownership is unaffected — the
    // evaluator still runs `initializeConnectorsForConfig`, the single funnel
    // for `TenantSystemCredentialRegistry`'s cross-tenant check.
    const readinessResult = await this.evaluateRuntimeReadiness(config, targetConnector);
    if (readinessResult.ready !== true) {
      this.metrics.recordReadinessFailure('not_ready');
      throw new SerializedAssetRunNotReadyError(readinessResult.blockers);
    }

    const batchSize = boundedBatchSize(options.batchSize);
    const concurrency = boundedConcurrency(options.concurrency);
    const now = this.clock();

    // --- Step 2: fresh source rows, paged, bounded, and RESUMABLE ---------
    // The cursor is what makes successive runs cover different rows. Without
    // it every run restarted at offset 0, so the same first window was
    // re-upserted forever while everything past the sweep bound was never
    // reached by ANY run.
    const startOffset = await this.cursorStore.getNextOffset(actor.tenantId, config.id);
    let sweep = await this.sweepSource(sourceConnector, config, batchSize, startOffset);

    // The stored offset can sit past the end of a source that shrank. Rather
    // than burning a whole run on nothing (a silent stall), wrap immediately —
    // bounded to ONE restart.
    if (sweep.records.length === 0 && startOffset > 0) {
      sweep = await this.sweepSource(sourceConnector, config, batchSize, 0);
    }

    // A dry run READS the cursor (so the preview reflects what the next real
    // run would do) but must never WRITE it: advancing durable sweep state
    // would change what that run sees.
    //
    // NOTE the ordering: the cursor is persisted BEFORE this window's rows are
    // processed. So if a later stage throws (normalization, or the whole run
    // aborting), this window is consumed — its rows are not retried until the
    // sweep wraps back around. That is deliberate and bounded: the alternative,
    // persisting after processing, would re-sweep the same window forever
    // whenever one row in it reliably kills the run. Self-healing via the wrap,
    // but non-obvious, hence this note.
    if (options.dryRun !== true) {
      await this.cursorStore.setNextOffset(actor.tenantId, config.id, sweep.nextOffset, now);
    }

    const sourceRecords = sweep.records;

    // --- Step 3: deferred backlog ----------------------------------------
    let deferredPage: DeferredSerializedUnitPage;
    try {
      deferredPage = options.forceDeferredRetry
        ? await this.deferredStore.listForRetry(actor.tenantId, config.id, batchSize)
        : await this.deferredStore.listDue(actor.tenantId, config.id, now, batchSize);
    } catch (error) {
      throw new SerializedAssetRunStageError('deferred_listing', errorNameOf(error));
    }
    const deferredRows = deferredPage.units;

    const ctx = this.createRunContext(input, profile, now);
    ctx.truncated = sweep.truncated;

    // --- Step 4: normalize the fresh rows --------------------------------
    const normalized = normalizeBatch(sourceRecords ?? [], config, {
      tenantId: actor.tenantId,
      configurationId: config.id,
    });

    ctx.counters.unitsRead = normalized.units.length + (deferredRows ?? []).length;
    this.metrics.recordUnitsRead('new', normalized.units.length);
    this.metrics.recordUnitsRead('deferred', (deferredRows ?? []).length);

    // --- Step 9a: invalid shapes are quarantined, never deferred ---------
    for (const failure of normalized.invalid) {
      ctx.counters.quarantined += 1;
      ctx.failures.push({ recordIndex: failure.recordIndex, category: 'invalid_shape' });
      this.metrics.recordUnitQuarantined('invalid_shape');
      await this.auditQuarantine(ctx, 'invalid_shape', `record_index:${failure.recordIndex}`);
    }

    // --- Steps 5 + 9b: deduplicate, quarantining conflicting duplicates ---
    const { workItems, conflictingIds } = await this.deduplicate(ctx, normalized.units);

    // --- Step 9c: corrupt deferred rows are quarantined, never dispatched --
    await this.quarantineUndecodableRows(ctx, deferredPage.undecodable ?? []);

    // --- Step 3 (merge): fold the deferred backlog into the work set ------
    await this.mergeDeferredRows(ctx, workItems, conflictingIds, deferredRows ?? [], options);

    // --- Step 6: bounded fan-out over independent units -------------------
    const limit = pLimit(concurrency);
    await Promise.all(
      [...workItems.values()].map((item) => limit(() => this.processUnit(ctx, item))),
    );

    // --- Step 12: counts, never raw serials ------------------------------
    return this.toResult(ctx);
  }

  // -------------------------------------------------------------------------
  // Step 1c
  // -------------------------------------------------------------------------

  /**
   * A readiness result of "not ready" is a DENY; an inability to evaluate is a
   * 503. `ServiceUnavailableAppError` therefore propagates untouched (its
   * message is fixed and safe); anything else becomes a fixed-message stage
   * error so an unexpected failure cannot smuggle record data outward.
   */
  private async evaluateRuntimeReadiness(
    config: IntegrationConfig,
    targetConnector: IConnector,
  ): Promise<SerializedAssetReadinessResult> {
    try {
      return await this.readiness.evaluate(config, { targetConnector });
    } catch (error) {
      this.metrics.recordReadinessFailure('undeterminable');
      if (error instanceof ServiceUnavailableAppError) {
        throw error;
      }
      throw new SerializedAssetRunStageError('readiness', errorNameOf(error));
    }
  }

  /**
   * Pages the source listing with an advancing `offset`, stopping at the first
   * SHORT page (the end of the source) or at whichever bound binds first.
   *
   * Returns `truncated: true` only when a cap stopped a sweep that still had a
   * full page behind it — i.e. more rows genuinely remain. A sweep that ended
   * on a short page is complete and reports `truncated: false`.
   *
   * A failure on ANY page (not just the first) aborts the whole run with the
   * fixed-message stage error: a partial sweep silently treated as complete
   * would look exactly like "the source no longer has those rows".
   */
  private async sweepSource(
    sourceConnector: IConnector,
    config: IntegrationConfig,
    pageSize: number,
    startOffset: number,
  ): Promise<{ records: DataRecord[]; truncated: boolean; nextOffset: number }> {
    const records: DataRecord[] = [];
    const maxUnits = Math.min(pageSize * MAX_SOURCE_PAGES, MAX_UNITS_PER_RUN);
    let offset = startOffset;

    for (let page = 0; page < MAX_SOURCE_PAGES; page += 1) {
      const listOptions: ListOptions = {
        limit: pageSize,
        offset,
        sortBy: SOURCE_PAGE_SORT_FIELD,
        sortOrder: 'asc',
      };

      let pageRecords: DataRecord[];
      let hasMore: boolean | undefined;
      try {
        if (supportsPagedList(sourceConnector)) {
          const result = await sourceConnector.listPage(config.sourceEntity, listOptions);
          pageRecords = result.records ?? [];
          hasMore = result.hasMore;
        } else {
          pageRecords = (await sourceConnector.list(config.sourceEntity, listOptions)) ?? [];
          hasMore = undefined;
        }
      } catch (error) {
        throw new SerializedAssetRunStageError('source_listing', errorNameOf(error));
      }

      records.push(...pageRecords);
      offset += pageRecords.length > 0 ? pageRecords.length : pageSize;

      // `hasMore` is authoritative when the connector reports it; the
      // short-page heuristic is the fallback only when it does not. Trusting
      // the heuristic under a server-side page cap below the requested limit
      // would end the sweep early and call it complete.
      const exhausted = hasMore === undefined ? pageRecords.length < pageSize : !hasMore;
      if (exhausted) {
        // Source fully swept — WRAP so the next run starts over.
        return { records, truncated: false, nextOffset: 0 };
      }
      if (records.length >= maxUnits) {
        break;
      }
    }

    // A bound stopped us with rows still behind: resume here next run.
    return { records, truncated: true, nextOffset: offset };
  }

  /**
   * Run-scoped Product2 memoization. Without it, 500 units sharing an `itemId`
   * issue 500 identical SOQL lookups — the amplification class Task 6's rate
   * limiter exists for, and one that the I2 retry-state fix would otherwise
   * compound on every deferred sweep.
   *
   * The PROMISE is cached, not the resolved value: units are processed
   * concurrently under `p-limit`, so caching only settled values would still
   * let N concurrent lookups start before the first returned.
   *
   * Rejections are cached too, deliberately. During a dependency outage that
   * makes every unit sharing the item defer off ONE failed call instead of N —
   * which is exactly the amplification this cache exists to prevent. The units
   * defer (retryable), and the cache dies with the run, so the next run
   * re-resolves.
   */
  private resolveProduct(ctx: RunContext, itemId: string): Promise<ProductResolution> {
    const cached = ctx.productResolutions.get(itemId);
    if (cached) return cached;
    const pending = ctx.productResolver.resolve(itemId, ctx.profile.productExternalIdField);
    ctx.productResolutions.set(itemId, pending);
    return pending;
  }

  private createRunContext(
    input: SerializedAssetSyncInput,
    profile: ReadySerializedAssetProfileConfig,
    now: Date,
  ): RunContext {
    const readConnector: IConnector = input.targetConnector;
    assertSalesforceSerializedAssetReadCapabilities(readConnector);

    // Run-scoped mutex. Deferral writes are select-then-write, so even though
    // deduplication already guarantees one work item per key, funnelling them
    // through one chain removes any possibility of a same-key race originating
    // inside a single run. Scoped to the run (not the instance) so two
    // independent runs are not serialized against each other.
    let gate: Promise<unknown> = Promise.resolve();
    const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
      // `operation` runs on BOTH settlement arms so one failed deferral write
      // cannot wedge the gate for the rest of the run; `settleGate` then
      // neutralizes the chain's own rejection so it is never an unhandled one.
      const result = gate.then(operation, operation);
      gate = result.then(settleGate, settleGate);
      return result;
    };

    return {
      config: input.config,
      profile,
      actor: input.actor,
      targetConnector: input.targetConnector,
      productResolver: new SalesforceProductResolver(readConnector),
      productResolutions: new Map<string, Promise<ProductResolution>>(),
      dryRun: input.options.dryRun === true,
      now,
      counters: emptyCounters(),
      failures: [],
      truncated: false,
      serialize,
    };
  }

  // -------------------------------------------------------------------------
  // Steps 5 + 9b — deduplication
  // -------------------------------------------------------------------------

  /**
   * Groups by `inventoryNumberId` (decision 3: one row is one physical unit,
   * so the key is the whole identity). A group whose members share a canonical
   * projection collapses to one work item; a group that disagrees is
   * quarantined ENTIRELY — there is no non-arbitrary way to pick a winner, and
   * writing either one would silently discard a real discrepancy.
   */
  private async deduplicate(
    ctx: RunContext,
    units: SerializedUnit[],
  ): Promise<{ workItems: Map<string, SerializedAssetWorkItem>; conflictingIds: Set<string> }> {
    const groups = new Map<string, SerializedUnit[]>();
    for (const unit of units) {
      const group = groups.get(unit.inventoryNumberId);
      if (group) group.push(unit);
      else groups.set(unit.inventoryNumberId, [unit]);
    }

    const workItems = new Map<string, SerializedAssetWorkItem>();
    const conflictingIds = new Set<string>();

    for (const [inventoryNumberId, group] of groups) {
      const projection = duplicateProjection(group[0]);
      const conflicting = group.some((unit) => duplicateProjection(unit) !== projection);

      if (conflicting) {
        conflictingIds.add(inventoryNumberId);
        const unitRef = unitReference(group[0]);
        for (let index = 0; index < group.length; index += 1) {
          ctx.counters.quarantined += 1;
          ctx.failures.push({ unitRef, category: 'conflicting_duplicate' });
          this.metrics.recordUnitQuarantined('conflicting_duplicate');
        }
        await this.auditQuarantine(ctx, 'conflicting_duplicate', unitRef);
        continue;
      }

      ctx.counters.duplicatesCollapsed += group.length - 1;
      workItems.set(inventoryNumberId, { unit: group[0], fromDeferred: false });
    }

    return { workItems, conflictingIds };
  }

  /**
   * Folds durable deferred rows into the work set. The ROW's key columns are
   * authoritative — `DeferredSerializedUnitRepository.toView` already overwrites
   * the payload's copies from the row, and this method re-checks the row's own
   * scope so a row that somehow escaped the tenant-scoped query is refused
   * rather than processed.
   *
   * A unit already present from the fresh listing keeps the FRESH values (they
   * are newer) and simply gains `fromDeferred: true`, which is what causes the
   * durable row to be cleared on success. A unit whose group was quarantined as
   * a conflicting duplicate is skipped entirely: its deferred row is left
   * untouched for an operator to resolve.
   */
  private async mergeDeferredRows(
    ctx: RunContext,
    workItems: Map<string, SerializedAssetWorkItem>,
    conflictingIds: Set<string>,
    deferredRows: DeferredSerializedUnit[],
    options: SerializedAssetSyncOptions,
  ): Promise<void> {
    const retryOutcome = ctx.dryRun ? 'previewed' : options.forceDeferredRetry ? 'forced' : 'due';

    for (const row of deferredRows) {
      if (row.tenantId !== ctx.actor.tenantId || row.configurationId !== ctx.config.id) {
        this.logger?.warn(LOG_FOREIGN_DEFERRED_ROW, {
          correlationId: ctx.actor.correlationId,
          configurationId: ctx.config.id,
        });
        continue;
      }
      if (conflictingIds.has(row.inventoryNumberId)) {
        continue;
      }

      // Attempt ceiling: abandoned rows are never dispatched again (no further
      // target-system API budget) but ARE backed off once more so `listDue`
      // stops re-returning them, and are reported as an explicit give-up.
      //
      // An AUTHORIZED forced retry bypasses the ceiling. Decision 11's verified
      // tenant-administrator endpoint is the design's only operator remedy for a
      // stuck unit; applying the ceiling to it too would block that remedy and
      // leave a manual database edit as the only way to un-stick a unit. The
      // attempt count is deliberately NOT reset — the history of how many
      // attempts a unit has burned stays intact for diagnosis, and an ordinary
      // run still refuses the row.
      if (!options.forceDeferredRetry && row.attemptCount >= MAX_DEFERRAL_ATTEMPTS) {
        const abandonedRef = unitReference(row);
        ctx.counters.quarantined += 1;
        ctx.failures.push({ unitRef: abandonedRef, category: 'attempts_exhausted' });
        this.metrics.recordUnitQuarantined('attempts_exhausted');
        await this.auditQuarantine(ctx, 'attempts_exhausted', abandonedRef);
        await this.advanceDeferredAttempt(ctx, row, abandonedRef);
        continue;
      }

      const existing = workItems.get(row.inventoryNumberId);
      if (existing) {
        existing.fromDeferred = true;
      } else {
        workItems.set(row.inventoryNumberId, {
          unit: { ...row.normalizedPayload, tenantId: row.tenantId, configurationId: row.configurationId, inventoryNumberId: row.inventoryNumberId },
          fromDeferred: true,
        });
      }
      ctx.counters.retriesAttempted += 1;
      this.metrics.recordRetryAttempted(retryOutcome);
    }
  }

  /**
   * Handles the corrupt rows the listings report (see
   * `DeferredSerializedUnitPage`). Each one is quarantined — counted, reported
   * with its one-way digest, metered, and audited — and then backed off so it
   * stops occupying the front of the next `listDue` page.
   *
   * The back-off runs through `advanceDeferredAttempt`, which is what makes a
   * `dryRun` inert here: the repository could not make that distinction,
   * because it does not know the run mode — which is the whole reason this
   * moved up out of the read.
   *
   * The row is deliberately never deleted. A corrupt payload is an operator
   * problem and the row is the only remaining evidence of it. The quarantine
   * COUNT reported here is what surfaces that — not a gap between
   * `countForConfiguration` and the units a run returns, which any backlog
   * larger than the page size produces while perfectly healthy.
   */
  private async quarantineUndecodableRows(
    ctx: RunContext,
    rows: UndecodableDeferredRow[],
  ): Promise<void> {
    for (const row of rows) {
      const unitRef = unitReference(row);
      ctx.counters.quarantined += 1;
      ctx.failures.push({ unitRef, category: 'undecodable_payload' });
      this.metrics.recordUnitQuarantined('undecodable_payload');
      await this.auditQuarantine(ctx, 'undecodable_payload', unitRef);
      await this.advanceDeferredAttempt(ctx, row, unitRef);
    }
  }

  // -------------------------------------------------------------------------
  // Steps 7-11 — per-unit processing
  // -------------------------------------------------------------------------

  private async processUnit(ctx: RunContext, item: SerializedAssetWorkItem): Promise<void> {
    const unit = item.unit;
    const unitRef = unitReference(unit);

    // Step 7: resolve the Product2 parent. A THROW here is a dependency
    // outage, not a data problem, so it defers; the resolver's own three
    // outcomes carry the data verdicts.
    let product2Id: string;
    try {
      const resolution = await this.resolveProduct(ctx, unit.itemId);
      if (resolution.status === 'ambiguous') {
        // Step 9: a Product2 external-ID field that is genuinely unique cannot
        // return two rows — this is a misconfiguration signal, so it is
        // quarantined for an operator rather than retried forever.
        ctx.counters.quarantined += 1;
        ctx.failures.push({ unitRef, category: 'ambiguous_parent' });
        this.metrics.recordUnitQuarantined('ambiguous_parent');
        await this.auditQuarantine(ctx, 'ambiguous_parent', unitRef);
        if (item.fromDeferred) {
          await this.advanceDeferredAttempt(ctx, unit, unitRef);
        }
        return;
      }
      if (resolution.status === 'missing') {
        // Step 8: the parent simply has not synced yet.
        await this.deferUnit(ctx, item, unitRef, 'parent_missing');
        return;
      }
      product2Id = resolution.product2Id;
    } catch {
      await this.deferUnit(ctx, item, unitRef, 'transient_dependency_failure');
      return;
    }

    const payload = SalesforceAssetPayloadBuilder.build(unit, product2Id, ctx.profile);

    if (ctx.dryRun) {
      // dryRun means NO mutation anywhere — not the connector, and not the
      // deferred store (no insert, no attempt_count increment, no
      // next_attempt_at movement, no delete). Reads above already happened,
      // which is what makes the preview meaningful.
      ctx.counters.upserted += 1;
      this.metrics.recordUnitUpserted('previewed');
      if (item.fromDeferred) {
        ctx.counters.deferredRecovered += 1;
        this.metrics.recordDeferredRecovered('previewed');
      }
      return;
    }

    await this.writeUnit(ctx, item, unitRef, payload);
  }

  /**
   * Step 10 — the governed mutation.
   *
   * The exact call shape below is load-bearing for two blocking CI scanners
   * and must not be refactored into a builder, a spread, or an
   * intersection-typed receiver:
   *
   *  - `check-guarded-writes.mjs` only treats a call as a connector mutation
   *    when the RECEIVER'S TYPE inherits `IConnector`; it does not traverse
   *    intersection constituents. Hence the fresh, explicitly base-typed
   *    `writeConnector: IConnector` binding rather than the read-narrowed
   *    connector.
   *  - `check-write-descriptor-equivalence.mjs` walks `do`'s arrow body for
   *    exactly ONE recognized connector method call and compares the method
   *    name to `resume.operation` and the first argument literal to
   *    `resume.entityType`. Hence the expression-bodied `do`, the literal
   *    `'Asset'` first argument, and the inline `resume` object literal in the
   *    same call. Task 5 pins this descriptor shape from the resume side.
   */
  private async writeUnit(
    ctx: RunContext,
    item: SerializedAssetWorkItem,
    unitRef: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const { config, profile, actor, targetConnector } = ctx;
    const unit = item.unit;
    const guardedWriteDeps = this.guardedWriteDeps;

    // `recordId` is the one-way digest, never the inventory-number id: it
    // reaches the ownership audit row and the lineage loop detector, both of
    // which are decision-8 surfaces.
    const context: Omit<GuardedWriteContext, 'operation'> = {
      tenantId: actor.tenantId,
      callerSystem: SERIALIZED_ASSET_CALLER_SYSTEM,
      targetSystem: SERIALIZED_ASSET_TARGET_SYSTEM,
      entity: SERIALIZED_ASSET_ENTITY,
      recordId: unitRef,
      correlationId: actor.correlationId,
      requesterUserId: actor.userId,
      integrationConfigId: config.id,
    };

    const writeConnector: IConnector = targetConnector;

    try {
      const result = await guardedWrite(
        {
          context: { ...context, operation: 'upsert' },
          do: () => writeConnector.upsert(
            'Asset',
            profile.assetExternalIdField,
            unit.inventoryNumberId,
            payload,
          ),
          resume: {
            targetSystemId: connectorKeyForSystem(config.targetSystem),
            operation: 'upsert',
            entityType: 'Asset',
            integrationConfigId: config.id,
            args: {
              externalIdField: profile.assetExternalIdField,
              externalIdValue: unit.inventoryNumberId,
              data: payload,
            },
          },
        },
        guardedWriteDeps,
      );

      ctx.counters.upserted += 1;
      this.metrics.recordUnitUpserted(result.outcome);
      // Step 11: deferred state is cleared ONLY after a confirmed upsert.
      if (item.fromDeferred) {
        await this.clearDeferral(ctx, unit, unitRef);
      }
    } catch (error) {
      this.recordWriteFailure(ctx, unitRef, error);
      // Every terminal non-success outcome backs the row off, governance
      // refusals included — a refusal that re-fires at zero backoff on every
      // run is the same retry storm as a failed write. Backing off is not
      // deleting: the unit is still owed to Salesforce.
      if (item.fromDeferred) {
        await this.advanceDeferredAttempt(ctx, unit, unitRef);
        return;
      }
      // Codex merge-readiness review: a FRESH unit had no durable record at
      // all. Only the already-deferred branch existed, so a transient
      // Salesforce failure on a newly-swept unit was counted, logged, and then
      // forgotten — while `setNextOffset` had ALREADY advanced the sweep cursor
      // past this window (see the ordering note in `run`). The unit was owed to
      // Salesforce with nothing anywhere recording that, and would not be
      // reconsidered until the sweep wrapped the entire source; if NetSuite
      // dropped the unit before then, its Asset was never created.
      //
      // Deferring it makes the debt durable, which is also what bounds the
      // cursor-ordering tradeoff that note describes: the window is still
      // consumed, but nothing in it is lost.
      //
      // Governance refusals land here too, deliberately — same reasoning as the
      // back-off branch above. A refusal means "not yet", never "discard".
      const stored = await ctx.serialize(() =>
        this.persistDeferral(ctx, item.unit, unitRef, 'write_failed'),
      );
      if (stored) {
        ctx.counters.deferred += 1;
        this.metrics.recordUnitDeferred('write_failed');
        return;
      }
      // `recordWriteFailure` already counted this unit as failed; add only the
      // distinct category so a run that LOST a unit is distinguishable from one
      // that merely failed to write it.
      ctx.failures.push({ unitRef, category: 'deferral_persist_failed' });
    }
  }

  /**
   * A governance refusal is never a data failure and must NEVER delete
   * deferred state: the unit is still owed to Salesforce, and the operator
   * resolution path (override, approval, manifest change) is what unblocks it.
   */
  private recordWriteFailure(ctx: RunContext, unitRef: string, error: unknown): void {
    ctx.counters.failed += 1;

    if (error instanceof LoopDetectedError) {
      ctx.counters.governanceRejections += 1;
      ctx.failures.push({ unitRef, category: 'governance_rejected' });
      this.metrics.recordGovernanceRejection('loop_detected');
      return;
    }
    if (error instanceof OwnershipPendingApprovalError) {
      ctx.counters.governanceRejections += 1;
      ctx.failures.push({ unitRef, category: 'governance_rejected' });
      this.metrics.recordGovernanceRejection('pending_approval');
      return;
    }
    if (error instanceof WriteBlockedError) {
      ctx.counters.governanceRejections += 1;
      ctx.failures.push({ unitRef, category: 'governance_rejected' });
      this.metrics.recordGovernanceRejection('blocked');
      return;
    }

    ctx.failures.push({ unitRef, category: 'write_failed' });
    // Class name only: a Salesforce error body can quote the payload it
    // rejected, serial included.
    this.logger?.warn(LOG_WRITE_FAILED, {
      correlationId: ctx.actor.correlationId,
      configurationId: ctx.config.id,
      unitRef,
      errorName: errorNameOf(error),
    });
  }

  // -------------------------------------------------------------------------
  // Steps 8 + 11 — deferred-work state
  // -------------------------------------------------------------------------

  private async deferUnit(
    ctx: RunContext,
    item: SerializedAssetWorkItem,
    unitRef: string,
    reason: DeferredSerializedUnitReason,
  ): Promise<void> {
    if (ctx.dryRun) {
      ctx.counters.deferred += 1;
      this.metrics.recordUnitDeferred('previewed');
      return;
    }

    const stored = await ctx.serialize(() => this.persistDeferral(ctx, item.unit, unitRef, reason));
    if (stored) {
      ctx.counters.deferred += 1;
      this.metrics.recordUnitDeferred(reason);
      return;
    }
    ctx.counters.failed += 1;
    ctx.failures.push({ unitRef, category: 'deferral_persist_failed' });
  }

  /**
   * `upsertDeferred` is select-then-write inside a transaction, which is NOT
   * safe against a concurrent writer for the same key: under READ COMMITTED
   * both writers can miss the SELECT and the loser takes an unhandled unique
   * violation. One retry converts that into the UPDATE arm (the winner's row
   * is now visible), which is the entire fix this loop exists for — hence
   * exactly two attempts, not an unbounded retry.
   *
   * The caught error is NEVER logged or rethrown. A Postgres unique/CHECK
   * violation `DETAIL` embeds the whole failing row, `normalized_payload`
   * included — i.e. the serial. Only the error's class name is recorded.
   */
  private async persistDeferral(
    ctx: RunContext,
    unit: SerializedUnit,
    unitRef: string,
    reason: DeferredSerializedUnitReason,
  ): Promise<boolean> {
    const input: DeferredSerializedUnitInput = {
      tenantId: unit.tenantId,
      configurationId: unit.configurationId,
      inventoryNumberId: unit.inventoryNumberId,
      normalizedPayload: unit,
      reason,
    };

    let lastErrorName = 'UnknownError';
    for (let attempt = 0; attempt < DEFERRAL_PERSIST_ATTEMPTS; attempt += 1) {
      try {
        await this.deferredStore.upsertDeferred(input, ctx.now);
        return true;
      } catch (error) {
        lastErrorName = errorNameOf(error);
      }
    }

    this.logger?.warn(LOG_DEFERRAL_PERSIST_FAILED, {
      correlationId: ctx.actor.correlationId,
      configurationId: ctx.config.id,
      unitRef,
      reason,
      errorName: lastErrorName,
    });
    return false;
  }

  /**
   * Advances the retry schedule of an ALREADY-DEFERRED unit that reached a
   * terminal NON-success outcome which is not itself a deferral reason:
   * an ambiguous parent, a failed upsert, a governance refusal, or the attempt
   * ceiling.
   *
   * Without this the row's `next_attempt_at` stays in the past forever, so
   * `listDue` re-returns it on every run — a zero-backoff retry storm against
   * Salesforce during exactly the outage that caused the failure. `touchAttempt`
   * (rather than `upsertDeferred`) is used deliberately: it moves the schedule
   * WITHOUT rewriting `reason`, so the backlog keeps recording why the unit was
   * originally deferred.
   *
   * Never applies to a unit that was not already deferred (there is no row),
   * and never under `dryRun` (a preview must not advance backoff state — the
   * exact failure mode the dry-run tests exist to catch).
   *
   * A failure here is swallowed with class-name-only logging: the unit's
   * outcome is already recorded, and a Postgres error `DETAIL` can embed the
   * whole row including `normalized_payload`.
   */
  private async advanceDeferredAttempt(
    ctx: RunContext,
    unit: { tenantId: string; configurationId: string; inventoryNumberId: string },
    unitRef: string,
  ): Promise<void> {
    if (ctx.dryRun) return;
    try {
      await ctx.serialize(() =>
        this.deferredStore.touchAttempt(
          unit.tenantId,
          unit.configurationId,
          unit.inventoryNumberId,
          ctx.now,
        ),
      );
    } catch (error) {
      this.logger?.warn(LOG_DEFERRAL_TOUCH_FAILED, {
        correlationId: ctx.actor.correlationId,
        configurationId: ctx.config.id,
        unitRef,
        errorName: errorNameOf(error),
      });
    }
  }

  /**
   * A failed cleanup is not a failed write: the Asset exists, and the surviving
   * deferred row simply causes one convergent retry on the next run. It is
   * logged (class name only) and the unit stays counted as upserted.
   */
  private async clearDeferral(ctx: RunContext, unit: SerializedUnit, unitRef: string): Promise<void> {
    try {
      const deleted = await ctx.serialize(() =>
        this.deferredStore.deleteSucceeded(unit.tenantId, unit.configurationId, unit.inventoryNumberId),
      );
      if (deleted) {
        ctx.counters.deferredRecovered += 1;
        this.metrics.recordDeferredRecovered('deleted');
      }
    } catch (error) {
      this.logger?.warn(LOG_DEFERRAL_DELETE_FAILED, {
        correlationId: ctx.actor.correlationId,
        configurationId: ctx.config.id,
        unitRef,
        errorName: errorNameOf(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 9 — sanitized quarantine audit
  // -------------------------------------------------------------------------

  /**
   * `resource` carries only the configuration id plus either the one-way unit
   * digest or a positional `record_index:` marker (used when normalization
   * failed before a unit — and therefore a key — existed). `dataType` carries
   * the closed-set quarantine class. Nothing here is derived from record
   * content.
   *
   * Under `dryRun` no audit row is written: a preview must mutate nothing,
   * including the audit log.
   *
   * A failure to write the audit row is logged and swallowed — the run's
   * remaining units must not be abandoned because one observability write
   * failed, and the quarantine itself is already reflected in the returned
   * counts.
   */
  private async auditQuarantine(
    ctx: RunContext,
    quarantineClass:
      | 'invalid_shape'
      | 'ambiguous_parent'
      | 'conflicting_duplicate'
      | 'attempts_exhausted'
      | 'undecodable_payload',
    resourceRef: string,
  ): Promise<void> {
    if (ctx.dryRun) return;
    try {
      await this.quarantineAuditor.logDataAccess({
        tenantId: ctx.actor.tenantId,
        sessionId: ctx.actor.correlationId,
        dataType: `serialized_asset_quarantine:${quarantineClass}`,
        action: 'read',
        resource: `serialized_asset/${ctx.config.id}/${resourceRef}`,
        dataClassification: 'restricted',
        userId: ctx.actor.userId,
      });
    } catch (error) {
      this.logger?.warn(LOG_QUARANTINE_AUDIT_FAILED, {
        correlationId: ctx.actor.correlationId,
        configurationId: ctx.config.id,
        quarantineClass,
        errorName: errorNameOf(error),
      });
    }
  }

  // -------------------------------------------------------------------------
  // Step 12 — counts
  // -------------------------------------------------------------------------

  private toResult(ctx: RunContext): SerializedAssetSyncResult {
    const c = ctx.counters;
    if (ctx.dryRun) {
      return {
        mode: 'previewed',
        unitsRead: c.unitsRead,
        wouldUpsert: c.upserted,
        wouldDefer: c.deferred,
        quarantined: c.quarantined,
        failed: c.failed,
        wouldRecoverDeferred: c.deferredRecovered,
        retriesPreviewed: c.retriesAttempted,
        duplicatesCollapsed: c.duplicatesCollapsed,
        truncated: ctx.truncated,
        failures: ctx.failures,
      };
    }
    return {
      mode: 'executed',
      unitsRead: c.unitsRead,
      upserted: c.upserted,
      deferred: c.deferred,
      quarantined: c.quarantined,
      failed: c.failed,
      deferredRecovered: c.deferredRecovered,
      retriesAttempted: c.retriesAttempted,
      governanceRejections: c.governanceRejections,
      duplicatesCollapsed: c.duplicatesCollapsed,
      truncated: ctx.truncated,
      failures: ctx.failures,
    };
  }
}

/**
 * The governance entity name, exported for the operator surfaces (Task 9) and
 * the ownership manifest discussion. NOT the write's entityType — see the
 * "Deliberately NO TARGET_ENTITY" note above.
 */
export { SERIALIZED_ASSET_ENTITY };
