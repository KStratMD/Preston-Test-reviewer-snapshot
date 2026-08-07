import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import { EmbeddedSessionRepository } from './EmbeddedSessionRepository';
import { EmbeddedServiceTokenRepository } from './EmbeddedServiceTokenRepository';

/**
 * Hourly retention job for embedded sessions + service-token versions.
 *
 * Round-X-survived constraints (do not regress):
 *  - setInterval pattern (mirrors DisasterRecoveryService.startAutoBackup),
 *    NOT a CronScheduler with pg_advisory_lock leader election. Multi-replica
 *    safety relies on the queries being idempotent — concurrent runs across
 *    replicas are wasteful but correct (round-6 finding #3 + PR #752 catch).
 *  - Idempotent start(): double-start emits a warning log and returns early.
 *  - stop() awaits in-flight tick before resolving so SIGTERM-gated process
 *    exit doesn't cut a DELETE mid-batch.
 *  - Three queries per tick (round-8 finding #5):
 *      (a) DELETE FROM embedded_sessions WHERE expires_at < now - 1h
 *      (b) UPDATE retire token versions whose valid_until passed
 *      (c) DELETE token versions retired more than 7d ago (forensic grace)
 *  - This is the canonical pattern for Tier-B scheduled services
 *    (round-8 finding #7) — PR 11+ schedulers MUST mirror this shape.
 */
@injectable()
export class EmbeddedRetentionJob {
  static readonly HOURLY_INTERVAL_MS = 60 * 60 * 1000;
  static readonly SESSION_GRACE_MS = 60 * 60 * 1000; // 1 hour past expires_at
  static readonly TOKEN_FORENSIC_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  private intervalHandle: NodeJS.Timeout | null = null;
  private inflight: Promise<void> | null = null;

  constructor(
    @inject(TYPES.EmbeddedSessionRepository)
    private readonly sessions: EmbeddedSessionRepository,
    @inject(TYPES.EmbeddedServiceTokenRepository)
    private readonly tokens: EmbeddedServiceTokenRepository,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  start(intervalMs: number = EmbeddedRetentionJob.HOURLY_INTERVAL_MS): void {
    if (this.intervalHandle !== null) {
      this.logger.warn(
        '[EmbeddedRetentionJob] start() called while already running — ignoring',
      );
      return;
    }
    this.logger.info('[EmbeddedRetentionJob] starting', { intervalMs });
    this.intervalHandle = setInterval(() => {
      // Closes Copilot review round-2: the original interval scheduled a
      // new tick on every fire even if the previous one was still running.
      // A long tick (large DELETE batch, slow DB) would overlap, this.inflight
      // would be overwritten, and stop() would only await the most recent
      // — earlier in-flight ticks could be cut off mid-DELETE.
      // Now: skip the new tick if the previous is still in-flight; clear
      // this.inflight to null when the tick settles via .finally().
      if (this.inflight !== null) {
        this.logger.warn(
          '[EmbeddedRetentionJob] previous tick still running, skipping this interval',
        );
        return;
      }
      this.inflight = this.tick()
        .then(
          () => {
            /* swallow result for the in-flight tracker; tick() return
               value is reserved for tests and manual invocation. */
          },
          (err: unknown) => {
            this.logger.error('[EmbeddedRetentionJob] tick failed', {
              error: err instanceof Error ? err.message : String(err),
            });
          },
        )
        .finally(() => {
          this.inflight = null;
        });
    }, intervalMs);
    // Don't pin Node's event loop open just for retention — orchestrators
    // tear down via stop() but during local dev/test the unref() lets a
    // bare app shutdown immediately.
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
    this.logger.info('[EmbeddedRetentionJob] stopped');
  }

  /**
   * Tick exposed for tests + manual invocation. The three retention queries
   * are deliberately NOT wrapped in a single transaction — they're each
   * idempotent on the row set they touch and isolating them lets one query
   * fail without poisoning the other two (matches the broader app's
   * "best-effort cleanup" stance).
   *
   * Each query runs in its own try/catch so a failure in one (e.g. a session
   * DELETE blocked by a stray FK) does not prevent the other two from
   * running. Per-query failures emit structured-log entries and return 0
   * for that counter so partial counts are still observable.
   */
  async tick(now: Date = new Date()): Promise<{
    sessionsDeleted: number;
    versionsRetired: number;
    versionsPurged: number;
  }> {
    let sessionsDeleted = 0;
    let versionsRetired = 0;
    let versionsPurged = 0;
    try {
      sessionsDeleted = await this.sessions.deleteExpired(
        now,
        EmbeddedRetentionJob.SESSION_GRACE_MS,
      );
    } catch (err) {
      this.logger.error('[EmbeddedRetentionJob] sessions.deleteExpired failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      versionsRetired = await this.tokens.retireExpiredVersions(now);
    } catch (err) {
      this.logger.error('[EmbeddedRetentionJob] tokens.retireExpiredVersions failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    try {
      versionsPurged = await this.tokens.purgeForensicallyRetired(
        now,
        EmbeddedRetentionJob.TOKEN_FORENSIC_GRACE_MS,
      );
    } catch (err) {
      this.logger.error('[EmbeddedRetentionJob] tokens.purgeForensicallyRetired failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (sessionsDeleted > 0 || versionsRetired > 0 || versionsPurged > 0) {
      this.logger.info('[EmbeddedRetentionJob] tick complete', {
        sessionsDeleted,
        versionsRetired,
        versionsPurged,
      });
    }
    return { sessionsDeleted, versionsRetired, versionsPurged };
  }

  /** Test-only: report whether the interval is active. */
  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}
