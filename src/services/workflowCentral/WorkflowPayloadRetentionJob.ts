import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { WorkflowCentralRepository } from './WorkflowCentralRepository';

/**
 * Hourly retention sweeper for ephemeral-hosted workflow payloads.
 *
 * Pairs with the lazy-expiry path in `WorkflowCentralOperatorService`:
 *   - **Pre-sweep, post-expiry read**: payload is still ephemeral_hosted
 *     with expiresAt in the past → lazy-expiry throws
 *     `EphemeralPayloadExpiredError` → HTTP 410 to the caller.
 *   - **Post-sweep read**: this job has set the row's `payload` to NULL
 *     AND reset the legacy `data`/`variables` field to `'{}'`. The
 *     operator's lazy-expiry branch no longer fires (gated on payload
 *     existing); the read falls through to the legacy-fallback branch
 *     and returns HTTP 200 with `kind: 'legacy'` and an empty `{}`
 *     resolution. The data-liability contract is satisfied either way
 *     — pre-sweep the data is gated behind 410, post-sweep the data
 *     is gone.
 *
 *   The 410 → 200/empty transition is intentional: by design, the
 *   "expired" status is a transient signal that exists between the
 *   moment expiresAt passes and the next sweep tick. Callers that
 *   care about distinguishing "expired" from "no payload" should
 *   inspect the response's `kind` field, not assume a specific HTTP
 *   status across the sweep boundary. A future enhancement could
 *   persist a non-sensitive tombstone marker to preserve 410 semantics
 *   across the sweep — noted in the proof card's Known Gaps.
 *
 * Closes C1 from Kerry's May-2026 Engineering ToDo — the last data-liability
 * blemish on the governance-without-hosting-data architecture (ADR-019).
 *
 * Shape mirrors `EmbeddedRetentionJob` (canonical Tier-B scheduled service):
 *   - setInterval, NOT pg_advisory_lock leader election. Multi-replica safety
 *     relies on the repository UPDATE being idempotent — concurrent runs across
 *     replicas are wasteful but correct.
 *   - start() is idempotent — warns + returns on double-start.
 *   - stop() awaits in-flight tick before resolving so SIGTERM-gated process
 *     exit does not cut a sweep mid-batch.
 *   - tick() is exposed for tests + manual admin invocation. Per-table errors
 *     are isolated inside the repository helper so a failure on one table
 *     does not poison the other (matches `EmbeddedRetentionJob` best-effort
 *     cleanup stance).
 *   - unref() on the interval handle so local dev/test processes can exit
 *     cleanly even if stop() was not called.
 */
@injectable()
export class WorkflowPayloadRetentionJob {
  static readonly HOURLY_INTERVAL_MS = 60 * 60 * 1000;

  private intervalHandle: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    @inject(TYPES.WorkflowCentralRepository)
    private readonly repo: WorkflowCentralRepository,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  start(intervalMs: number = WorkflowPayloadRetentionJob.HOURLY_INTERVAL_MS): void {
    if (this.intervalHandle !== null) {
      this.logger.warn(
        '[WorkflowPayloadRetentionJob] start() called while already running — ignoring',
      );
      return;
    }
    this.logger.info('[WorkflowPayloadRetentionJob] starting', { intervalMs });
    this.intervalHandle = setInterval(() => {
      // Skip if a previous tick is still running — long sweeps must not
      // overlap (mirrors EmbeddedRetentionJob Copilot R2 fix).
      if (this.inflight !== null) {
        this.logger.warn(
          '[WorkflowPayloadRetentionJob] previous tick still running, skipping this interval',
        );
        return;
      }
      this.inflight = this.tick()
        .then(
          () => {
            /* tick result is reserved for tests + manual invocation */
          },
          (err: unknown) => {
            // Logger.error signature is (message, error?, metadata?). Pass
            // the Error as the 2nd arg so the structured backend captures
            // it; put queryable fields in the 3rd-arg metadata. Use
            // `errorMessage` (NOT `error`) as the metadata key — Logger
            // overwrites `context.error` with the Error instance AFTER
            // spreading metadata, so a `metadata.error` field would be
            // silently clobbered for Error-instance throws. See
            // feedback-logger-error-metadata-position-bug + Copilot R8
            // on PR #829 for the overwrite-after-spread detail.
            this.logger.error(
              '[WorkflowPayloadRetentionJob] tick failed',
              err instanceof Error ? err : undefined,
              { errorMessage: err instanceof Error ? err.message : String(err) },
            );
          },
        )
        .finally(() => {
          this.inflight = null;
        });
    }, intervalMs);
    if (typeof this.intervalHandle.unref === 'function') {
      this.intervalHandle.unref();
    }
  }

  async stop(): Promise<void> {
    if (this.intervalHandle === null) return;
    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
    if (this.inflight !== null) {
      await this.inflight;
      this.inflight = null;
    }
    this.logger.info('[WorkflowPayloadRetentionJob] stopped');
  }

  /**
   * Tick exposed for tests + manual admin invocation. Returns the per-table
   * cleared count so callers can assert + log.
   *
   * The repository call is wrapped in a try/catch so a transient DB blip
   * does not propagate into setInterval's unhandled-rejection sink. The
   * outer .catch in start() handles unhandled cases, but routing through
   * try/catch here gives a single observation point for the per-tick metric.
   */
  async tick(
    now: Date = new Date(),
  ): Promise<{ tasksCleared: number; instancesCleared: number }> {
    try {
      const result = await this.repo.clearExpiredEphemeralPayloads(now);
      if (result.tasksCleared > 0 || result.instancesCleared > 0) {
        this.logger.info('[WorkflowPayloadRetentionJob] tick complete', result);
      }
      return result;
    } catch (err) {
      // Logger.error: see start() comment — Error as 2nd arg, metadata as 3rd,
      // metadata key is `errorMessage` (NOT `error`) to survive Logger's
      // Error-instance overwrite-after-spread of `context.error`.
      this.logger.error(
        '[WorkflowPayloadRetentionJob] clearExpiredEphemeralPayloads failed',
        err instanceof Error ? err : undefined,
        { errorMessage: err instanceof Error ? err.message : String(err) },
      );
      return { tasksCleared: 0, instancesCleared: 0 };
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}
