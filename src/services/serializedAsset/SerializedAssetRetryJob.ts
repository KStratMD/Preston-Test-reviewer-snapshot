import { inject, injectable } from 'inversify';
import { randomUUID } from 'crypto';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import {
  SERIALIZED_ASSET_RETRY_HEARTBEAT_MS,
  SERIALIZED_ASSET_RETRY_POLL_MS,
  type RetryOperation,
  type RetryOperationCounters,
  type SerializedAssetRetryOperationRepository,
} from './SerializedAssetRetryOperationRepository';
import type { SyncResult } from '../../types';

/**
 * The worker half of the durable forced serialized-asset retry (A9).
 *
 * Mirrors `EmbeddedRetentionJob`, which its own docstring designates as the
 * canonical shape for scheduled services here: a `setInterval` poll, an
 * idempotent `start()`, one in-flight tick at a time, and a `stop()` that
 * awaits the active tick so a SIGTERM does not cut a drain mid-batch.
 *
 * Two qualifications on that sentence, both from Codex round 8, because the
 * unqualified version claims more than the code delivers:
 *
 *   - "one in-flight tick at a time" holds for ticks this job STARTS. It does
 *     not hold across a grace-time abandonment followed by a restart: the
 *     abandoned executor may still be running while a new tick proceeds.
 *   - the wait is bounded at SERIALIZED_ASSET_RETRY_STOP_GRACE_MS, and what is
 *     abandoned at that deadline is the WAITING and the lease renewal — not the
 *     executor, which this job has no way to cancel. It keeps running, and may
 *     still commit its outcome if its fencing predicate still matches.
 *
 * Explicitly NOT added, per the design: no queue framework, no scheduler
 * library, no distributed leader election. Multi-replica safety comes from the
 * lease and fencing token in the repository — two replicas polling
 * concurrently is wasteful but correct, because only one can hold a claim.
 */

/** Counters the executor must return. Deliberately the only thing it returns. */
export type { RetryOperationCounters };

/**
 * The narrow seam between this job and the sync engine.
 *
 * It returns COUNTERS, not a `SyncResult`, and that is a containment boundary
 * rather than a convenience. `SyncResult` carries `errors: string[]` and a
 * free-form `metadata` object holding the entire serialized-asset run — a shape
 * that can include per-unit references. If the job received one it could
 * persist it into a table that is operator-readable and reaches an HTTP status
 * endpoint. Narrowing here means it never holds the wider object at all.
 */
export interface ForcedRetryExecutor {
  run(args: {
    tenantId: string;
    configurationId: string;
    requesterUserId: string;
    correlationId: string;
  }): Promise<RetryOperationCounters>;
}

/** Fixed failure vocabulary. Never a driver, connector, or governance message. */
export const RETRY_FAILURE_CODE = 'forced_retry_execution_failed';
/**
 * The configuration was already being synced when this operation reached the
 * front of the queue, so `IntegrationService`'s in-process guard refused it.
 *
 * Distinct from `RETRY_FAILURE_CODE` (Codex round 2): under the generic code an
 * operator cannot tell "your retry collided with a scheduled sync, just run it
 * again" from "the drain genuinely failed", and those call for opposite
 * responses. This is a transient, self-clearing condition.
 */
export const RETRY_BUSY_CODE = 'forced_retry_configuration_busy';
/** Reported when a thrown value's class name is unusable — see `safeErrorClass`. */
export const RETRY_UNKNOWN_ERROR_CLASS = 'UnknownError';
/** `error_class` is VARCHAR(64) in migration 063; stay well inside it. */
const MAX_ERROR_CLASS_LENGTH = 64;
/**
 * How long stop() waits for an in-flight tick before abandoning it to the
 * lease. Comfortably under a typical container SIGTERM grace, and far under
 * SERIALIZED_ASSET_RETRY_LEASE_MS so an abandoned operation becomes
 * RECLAIMABLE well within one lease period rather than lingering. Reclaimable,
 * not reclaimed: whether anything picks it up needs a replica running and
 * polling, which this constant cannot promise.
 */
export const SERIALIZED_ASSET_RETRY_STOP_GRACE_MS = 10_000;

/**
 * True when the executor refused because the configuration was already running.
 *
 * Structural rather than `instanceof ConflictAppError`: the job deliberately
 * depends on the narrow `ForcedRetryExecutor` interface and not on
 * `IntegrationService` or the route error classes, so it must not import them.
 *
 * The status alone is NOT sufficient (Copilot round 7). An earlier version of
 * this comment claimed "a 409 from this executor has exactly one cause", which
 * was an absolute assertion about a whole call tree — the drain reaches
 * connectors, governance and guarded writes, any of which could raise a 409
 * for an unrelated, DETERMINISTIC reason. Misclassifying one of those as busy
 * is worse than not classifying it at all: `RETRY_BUSY_CODE` tells an operator
 * "transient, run it again", which is precisely wrong for a condition that
 * will never clear on its own.
 *
 * So the shape is checked too. Reading the message for CLASSIFICATION is not a
 * decision-8 violation, but state the reason precisely (Codex round 8): it is
 * NOT that nothing derived from the message is emitted — the persisted code is
 * itself derived from this check. It is that the derivation collapses the
 * message into a CLOSED, non-sensitive two-value vocabulary fixed in this file.
 * The raw message reaches neither the durable row nor the status endpoint; only
 * `RETRY_BUSY_CODE` or `RETRY_FAILURE_CODE` does.
 *
 * Anything that does not match is recorded as a generic failure, which is the
 * safe default: it tells the operator to investigate rather than to retry.
 */
const ALREADY_RUNNING_PATTERN = /is already running/i;
function isConfigurationBusy(error: unknown): boolean {
  // Wrapped for the same reason as safeErrorClass (Codex round 3): reading
  // `statusCode` is an ordinary property access, so a throwing getter or a
  // hostile Proxy makes it throw. This runs inside the catch that writes the
  // terminal failure row, so an escaping throw would abort that write and
  // strand the operation `running`. Classify as not-busy and carry on.
  try {
    if (typeof error !== 'object' || error === null) return false;
    if ((error as { statusCode?: unknown }).statusCode !== 409) return false;
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && ALREADY_RUNNING_PATTERN.test(message);
  } catch {
    return false;
  }
}

/**
 * Narrows a thrown value's class name to something safe to persist.
 *
 * `error.constructor.name` is NOT bounded: a class can be declared with an
 * arbitrarily long or arbitrary-character name, and in the worst case that
 * value is influenced by data. Two consequences, both found by Codex on
 * #1132 — it could carry content into a row that is served over HTTP, and an
 * over-long name would fail the Postgres VARCHAR(64) write, which would abort
 * the terminal update and strand the operation `running` until its lease
 * lapsed. Restricted to an identifier shape and truncated.
 *
 * The property read is itself wrapped (Codex round 2): `constructor` and `name`
 * are ordinary property lookups, so an object carrying a throwing getter makes
 * the read throw. That throw would happen INSIDE the catch block that writes
 * the terminal failure row, so it would abort that write and strand the
 * operation `running` — the exact failure the truncation above exists to
 * prevent, reached through a different door. This function must never throw.
 */
export function safeErrorClass(error: unknown): string {
  let raw: unknown;
  try {
    raw = error instanceof Error ? error.constructor?.name : undefined;
  } catch {
    return RETRY_UNKNOWN_ERROR_CLASS;
  }
  if (typeof raw !== 'string') return RETRY_UNKNOWN_ERROR_CLASS;
  const trimmed = raw.trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed)) return RETRY_UNKNOWN_ERROR_CLASS;
  return trimmed.slice(0, MAX_ERROR_CLASS_LENGTH);
}

function boundedCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Narrows a `SyncResult` to the five bounded counters the durable row can hold.
 *
 * Everything else is dropped on purpose: `errors` (failure categories),
 * `metadata.serializedAssetResult` (the whole run, including per-unit failure
 * entries), `syncId`, and the timing strings. The deferred and quarantined
 * counts are read defensively from the nested result and coerced, so a shape
 * change upstream degrades to zero rather than persisting something unexpected.
 */
export function toRetryCounters(result: SyncResult): RetryOperationCounters {
  const nested = (result.metadata as { serializedAssetResult?: Record<string, unknown> } | undefined)
    ?.serializedAssetResult;
  return {
    read: boundedCount(result.recordsProcessed),
    upserted: boundedCount(result.recordsSuccessful),
    failed: boundedCount(result.recordsFailed),
    deferred: boundedCount(nested?.deferred),
    quarantined: boundedCount(nested?.quarantined),
  };
}

@injectable()
export class SerializedAssetRetryJob {
  /** Stable for this process; identifies the lease holder in the database. */
  private readonly leaseOwner = `retry-worker-${randomUUID()}`;

  private intervalHandle: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;
  private stopping = false;
  /** Non-null only while a stop() is winding down. See start() and stop(). */
  private stopPromise: Promise<void> | null = null;
  /**
   * Incremented by every stop(). A tick captures this when it starts running,
   * and every SUBSEQUENT heartbeat callback for it returns early once the value
   * moves. A beat already dispatched at that moment still completes — see
   * `awaitInflight` for what that means for takeover timing.
   *
   * `stopping` alone is not enough. stop() abandons a tick that outlives the
   * grace, but that tick's heartbeat interval stays armed — `runClaimed`'s
   * `finally` never runs, because the executor never settled. A later start()
   * clears `stopping`, and the abandoned tick would begin renewing its lease
   * again: the operation shutdown deliberately gave up on would be pinned once
   * more, unreclaimable by any other replica. A generation is one-way, so
   * abandonment survives the restart that `stopping` forgets.
   */
  private stopGeneration = 0;

  constructor(
    @inject(TYPES.SerializedAssetRetryOperationRepository)
    private readonly repo: SerializedAssetRetryOperationRepository,
    @inject(TYPES.SerializedAssetForcedRetryExecutor)
    private readonly executor: ForcedRetryExecutor,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  start(intervalMs: number = SERIALIZED_ASSET_RETRY_POLL_MS): void {
    if (this.intervalHandle !== null) {
      this.logger.warn('[SerializedAssetRetryJob] start() called while already running — ignoring');
      return;
    }
    if (this.stopPromise !== null) {
      // stop() has already cleared the interval but is still awaiting the
      // in-flight tick. Starting here would clear `stopping`, arm a new
      // interval, and leave the in-progress stop() logging "stopped" over a
      // job that is running again (Codex round 2). Callers that genuinely want
      // a restart must await stop() first.
      this.logger.warn('[SerializedAssetRetryJob] start() called while stopping — ignoring');
      return;
    }
    this.stopping = false;
    this.logger.info('[SerializedAssetRetryJob] starting', { intervalMs });

    this.intervalHandle = setInterval(() => {
      // One tick at a time, same reasoning as EmbeddedRetentionJob: a drain can
      // run for minutes, so a fresh tick per interval would overlap, overwrite
      // the in-flight handle, and leave stop() awaiting only the most recent.
      if (this.inflight !== null) return;
      const run: Promise<void> = this.tick()
        .catch((err: unknown) => {
          // Class name only. A connector error's message can embed a serial
          // number or a whole row. Via safeErrorClass rather than a direct
          // property read: a throwing `constructor`/`name` getter here would
          // reject inside the catch handler, and the `.finally` below would
          // then surface it as an unhandled rejection with nothing left to
          // catch it.
          this.logger.error('[SerializedAssetRetryJob] tick failed', {
            errorName: safeErrorClass(err),
          });
        })
        .finally(() => {
          // Only clear the slot if it is still THIS tick's (Codex round 3).
          // After stop() abandons a tick at the grace deadline, that tick keeps
          // running; if the job is later restarted and this stale `finally`
          // fired unconditionally, it would clear a NEWER tick's handle and
          // allow two ticks to overlap — the exact thing the guard above
          // exists to prevent.
          if (this.inflight === run) this.inflight = null;
        });
      // Assigned after construction so the identity check above compares
      // against this same promise. `.finally` runs on a later microtask, so
      // this assignment always wins the race.
      this.inflight = run;
    }, intervalMs);

    if (typeof this.intervalHandle.unref === 'function') {
      this.intervalHandle.unref();
    }
  }

  /**
   * Await the in-flight tick, but never longer than the drain grace.
   *
   * An unbounded `await this.inflight` makes shutdown hostage to the executor
   * (Codex round 2): a connector call with no timeout, or any promise that
   * simply never settles, would hang `stop()` forever and with it the whole
   * graceful-shutdown sequence that awaits it.
   *
   * Abandoning the tick is safe only because no FURTHER heartbeat callback for
   * it will renew the lease. This comment has been wrong twice about why, so it
   * carries both wrong versions:
   *
   *   - It first claimed abandonment was safe "because the lease protects the
   *     operation, the same path a hard kill takes". False: a hard kill stops
   *     the heartbeat by killing the process, while a timed-out graceful stop
   *     leaves the process alive and beating, so the lease never lapsed and no
   *     replica could reclaim the operation. Copilot caught that.
   *   - It then credited the `stopping` flag alone. Also incomplete: a later
   *     start() clears `stopping`, and the abandoned tick's interval is still
   *     armed because its `finally` never ran, so the beats resumed. Codex
   *     caught that.
   *
   * What closes it is `stopGeneration`, which is one-way: this stop() moves it,
   * and the abandoned tick's captured value can never match again. The two
   * guards are not simultaneous — the callback returns early if EITHER
   * `stopping` is set or the generation has moved. `stopping` covers the window
   * before this stop() finishes; the generation covers everything after,
   * including restarts.
   *
   * Precise about the boundary (Codex round 6): this suppresses future
   * callbacks. A `repo.heartbeat()` call already dispatched when stop() ran
   * still completes and may extend the lease one final time, so the operation
   * becomes reclaimable up to one lease period after the last in-flight beat —
   * not instantly. And "reclaimable" is all this class provides: whether
   * another replica actually takes it depends on one running and polling.
   */
  private async awaitInflight(): Promise<void> {
    const inflight = this.inflight;
    if (inflight === null) return;

    let timer: NodeJS.Timeout | undefined;
    const grace = new Promise<'grace-expired'>((resolve: (v: 'grace-expired') => void) => {
      timer = setTimeout(() => resolve('grace-expired'), SERIALIZED_ASSET_RETRY_STOP_GRACE_MS);
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const outcome = await Promise.race([
        inflight.then((): 'settled' => 'settled'),
        grace,
      ]);
      if (outcome === 'grace-expired') {
        this.logger.warn(
          '[SerializedAssetRetryJob] in-flight tick did not settle within the stop grace; ' +
            'abandoning it to the lease',
          { graceMs: SERIALIZED_ASSET_RETRY_STOP_GRACE_MS },
        );
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    // One-way marker for every tick running right now. A later start() clears
    // `stopping`; it must not un-abandon a tick this stop() walked away from.
    this.stopGeneration += 1;
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    // Held across the await so a start() arriving mid-stop is refused rather
    // than resurrecting the interval while this call is still winding down —
    // which would leave stop() logging "stopped" over a running job.
    this.stopPromise = this.awaitInflight();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
      this.inflight = null;
    }
    this.logger.info('[SerializedAssetRetryJob] stopped');
  }

  /**
   * One poll: claim at most one operation and run it to a terminal state.
   * Exposed for tests and manual invocation, like `EmbeddedRetentionJob.tick`.
   */
  async tick(): Promise<void> {
    const claimed = await this.repo.claimNext(this.leaseOwner);
    if (!claimed) return;

    // Shutdown that began between the claim and execution: mark the operation
    // terminally interrupted under the fencing predicate rather than leaving a
    // running row for the lease to time out. The operator sees a decided
    // outcome immediately instead of a five-minute silence.
    if (this.stopping) {
      await this.repo.interrupt(this.holderFor(claimed));
      return;
    }

    await this.runClaimed(claimed);
  }

  private async runClaimed(claimed: RetryOperation): Promise<void> {
    const holder = this.holderFor(claimed);
    // Captured, not read live: see stopGeneration's note. Once a stop() moves
    // the counter, THIS tick is abandoned for good, even if the job restarts.
    const generation = this.stopGeneration;
    const heartbeat = setInterval(() => {
      // Stop renewing the moment shutdown begins (Copilot round 3 on #1132).
      // stop() abandons a tick that outlives the grace, and the justification
      // for that was "the lease lapses and another worker reclaims it" — which
      // was FALSE while this heartbeat kept beating. The process is still alive
      // after a timed-out graceful stop, unlike a hard kill, so the lease would
      // be renewed indefinitely and NO replica could take the operation over:
      // pinned by a worker the shutdown had already given up on. Ceasing to
      // beat here is what makes the abandonment safe.
      //
      // Safe for the ordinary stop path too: the terminal writes CAS on
      // status + lease_owner + fencing_token, never on lease expiry, so ceasing
      // to beat does not by itself invalidate a tick that finishes afterwards.
      // It is NOT a guarantee that the outcome commits (Codex round 8): if the
      // lease lapses and a successor claims the row, the fencing token moves
      // and the late terminal write matches zero rows. That is the intended
      // ordering — the successor owns the operation — but it means a tick can
      // finish its work and find it has nothing left to publish.
      if (this.stopping || this.stopGeneration !== generation) return;
      void this.repo.heartbeat(holder).catch(() => {
        // A failed beat is not fatal. The next beat may well succeed — the
        // lease only lapses if enough of them fail in a row — and if it does
        // lapse the operation becomes reclaimable by another worker. Neither
        // the lapse nor the takeover is orchestrated here. Nothing is logged
        // with the error attached.
      });
    }, SERIALIZED_ASSET_RETRY_HEARTBEAT_MS);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    try {
      const counters = await this.executor.run({
        tenantId: claimed.tenantId,
        configurationId: claimed.configurationId,
        requesterUserId: claimed.requesterUserId,
        correlationId: claimed.correlationId,
      });
      await this.repo.complete({ ...holder, counters });
    } catch (error) {
      // Fixed code, class name only. The raw message never reaches the row and
      // therefore never reaches the status endpoint.
      await this.repo.fail({
        ...holder,
        errorCode: isConfigurationBusy(error) ? RETRY_BUSY_CODE : RETRY_FAILURE_CODE,
        errorClass: safeErrorClass(error),
      });
    } finally {
      clearInterval(heartbeat);
    }
  }

  private holderFor(operation: RetryOperation): {
    id: string;
    leaseOwner: string;
    fencingToken: number;
  } {
    return {
      id: operation.id,
      leaseOwner: this.leaseOwner,
      fencingToken: operation.fencingToken,
    };
  }
}
