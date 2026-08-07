import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { CostTransparencyService } from './CostTransparencyService';

@injectable()
export class CostTransparencyDailyJob {
  static readonly DEFAULT_INTERVAL_MS = 24 * 60 * 60_000; // 24h

  private timer: NodeJS.Timeout | null = null;
  private inflightPromise: Promise<void> | null = null;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.CostTransparencyService) private service: CostTransparencyService,
  ) {}

  start(intervalMs: number = CostTransparencyDailyJob.DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflightPromise) return;
      this.inflightPromise = this.tick()
        .catch((err: unknown) => {
          this.logger.error(
            'CostTransparencyDailyJob tick failed',
            err instanceof Error ? err : new Error(String(err)),
            { error: err instanceof Error ? err.message : String(err) },
          );
        })
        .finally(() => { this.inflightPromise = null; });
    }, intervalMs);
    // Don't keep the event loop alive solely for this scheduler — local dev/test
    // processes can exit cleanly. unref() is a no-op under jest.useFakeTimers().
    this.timer.unref?.();

    // Fire an initial tick immediately so the dashboard has data on fresh deploy
    // (Codex R1 P2: without this, the rollup is delayed by the full interval).
    // The tick is intentionally fire-and-forget; errors are logged via the same
    // path as scheduled ticks.
    if (!this.inflightPromise) {
      this.inflightPromise = this.tick()
        .catch((err: unknown) => {
          this.logger.error(
            'CostTransparencyDailyJob initial tick failed',
            err instanceof Error ? err : new Error(String(err)),
            { error: err instanceof Error ? err.message : String(err) },
          );
        })
        .finally(() => { this.inflightPromise = null; });
    }
  }

  /** Clears the interval first, then drains inflight. Mirrors SyncErrorAssistDailyJob. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflightPromise) {
      try { await this.inflightPromise; } catch { /* swallow */ }
    }
  }

  /** Manual one-shot for admin endpoints and fixture tests. */
  async runOnce(): Promise<void> {
    await this.tick();
  }

  private async tick(): Promise<void> {
    const dateUtc = new Date().toISOString().slice(0, 10);
    const tenants = await this.service.listTenants();
    for (const tenantId of tenants) {
      try {
        await this.service.rollupDay(tenantId, dateUtc);
      } catch (err: unknown) {
        this.logger.error(
          'CostTransparency rollup failed for tenant',
          err instanceof Error ? err : new Error(String(err)),
          { tenantId, dateUtc, error: err instanceof Error ? err.message : String(err) },
        );
      }
    }
  }
}
