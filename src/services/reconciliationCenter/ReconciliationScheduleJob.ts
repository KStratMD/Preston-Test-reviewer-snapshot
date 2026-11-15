import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import { ReconciliationCenterService } from './ReconciliationCenterService';
import type { ReconciliationScheduleTick } from './ReconciliationCenterTypes';

@injectable()
export class ReconciliationScheduleJob {
  static readonly DEFAULT_INTERVAL_MS = 60 * 60 * 1000; // 1h

  private intervalHandle: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    @inject(TYPES.ReconciliationCenterService)
    private readonly service: ReconciliationCenterService,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  start(intervalMs: number = ReconciliationScheduleJob.DEFAULT_INTERVAL_MS): void {
    if (this.intervalHandle !== null) {
      this.logger.warn('[ReconciliationScheduleJob] start() called while already running - ignoring');
      return;
    }
    this.intervalHandle = setInterval(() => this.launchGuardedTick(), intervalMs);
    this.intervalHandle.unref?.();
    // Immediate startup sweep: claim any schedules already overdue at boot
    // rather than leaving them idle until the first interval fires (up to a
    // full interval, e.g. 1h, after every restart/deploy). Reuses the same
    // inflight guard, so stop()'s drain still covers this tick. (Codex review,
    // PR #862.)
    this.launchGuardedTick();
  }

  /**
   * Launch one tick under the single-flight guard: if a tick is already in
   * flight, skip (log) rather than overlap. The interval AND the startup sweep
   * both go through here so they share the same drain semantics that stop()
   * relies on.
   */
  private launchGuardedTick(): void {
    if (this.inflight !== null) {
      this.logger.warn('[ReconciliationScheduleJob] previous tick still running, skipping this interval');
      return;
    }
    this.inflight = (async (): Promise<void> => {
      try {
        await this.tick(new Date());
      } finally {
        this.inflight = null;
      }
    })();
  }

  async stop(): Promise<void> {
    // Clear the interval once, but ALWAYS await the captured inflight even
    // when intervalHandle is already null. Otherwise a second concurrent
    // stop() call (or a stop() chained after another caller's stop()) sees
    // intervalHandle === null and returns synchronously while a tick is still
    // running — the caller thinks shutdown is complete but the IIFE is still
    // executing past stop()'s return.
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    const pending = this.inflight;
    if (pending !== null) {
      try { await pending; } catch { /* swallow */ }
    }
    // The IIFE's finally clause clears this.inflight when the tick resolves,
    // so we don't need to null it again here.
  }

  /**
   * Run one scheduler tick. Errors from the downstream service are caught
   * and logged so an interval-driven loop survives transient DB failures;
   * the return shape mirrors the success case with zeros.
   */
  async tick(now: Date): Promise<ReconciliationScheduleTick> {
    try {
      return await this.service.runDueSchedules(now);
    } catch (err: unknown) {
      // Logger.error sets context.error = errorInstance, so a metadata field
      // named `error` would be silently overwritten by the Error reference.
      // Use `errorMessage` for the string payload so both the Error instance
      // (under `error`) and the human-readable message survive in structured
      // logs.
      this.logger.error(
        '[ReconciliationScheduleJob] tick failed',
        err instanceof Error ? err : new Error(String(err)),
        { errorMessage: err instanceof Error ? err.message : String(err) },
      );
      return { schedulesRun: 0, exceptionsCreated: 0, staleRunsReclaimed: 0 };
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}
