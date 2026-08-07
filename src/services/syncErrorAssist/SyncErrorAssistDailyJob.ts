import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { SyncErrorAssistService } from './SyncErrorAssistService';
import type { CycleResult } from './types';
import { SYSTEM_IDENTITY } from '../governance/identityContext';

@injectable()
export class SyncErrorAssistDailyJob {
  static readonly DEFAULT_INTERVAL_MS = 30 * 60_000;

  private timer: NodeJS.Timeout | null = null;
  private inflightPromise: Promise<CycleResult[]> | null = null;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.SyncErrorAssistService) private service: SyncErrorAssistService,
  ) {}

  start(intervalMs: number = SyncErrorAssistDailyJob.DEFAULT_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inflightPromise) return;
      this.inflightPromise = this.service.runAllEnabledTenants(SYSTEM_IDENTITY)
        .catch((err: unknown) => {
          this.logger.error('SyncErrorAssistDailyJob tick failed', { error: err instanceof Error ? err.message : String(err) });
          return [] as CycleResult[];
        })
        .finally(() => { this.inflightPromise = null; }) as Promise<CycleResult[]>;
    }, intervalMs);
    // Mirror EmbeddedRetentionJob: don't keep the event loop alive solely for this
    // scheduler — local dev/test processes can exit cleanly. unref() is a no-op
    // under jest.useFakeTimers().
    this.timer.unref?.();
  }

  /** Async — clears the interval first so it stops scheduling new ticks, then drains
   * inflight. Mirrors EmbeddedRetentionJob.stop():31. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inflightPromise) {
      try { await this.inflightPromise; } catch { /* swallow */ }
    }
  }

  /** Manual one-shot for tests + admin. */
  async runOnce(): Promise<CycleResult[]> {
    return this.service.runAllEnabledTenants(SYSTEM_IDENTITY);
  }
}
