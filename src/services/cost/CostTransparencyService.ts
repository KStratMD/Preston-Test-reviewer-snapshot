import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type {
  CostTransparencyRepository,
  DailyRollupRow,
  PerFlowRollupRow,
} from './CostTransparencyRepository';

export type SourceLabel = 'measured' | 'estimated' | 'no data' | string;

export interface DashboardModel {
  tenantId: string;
  history: DailyRollupRow[];
  flows: PerFlowRollupRow[];
  anomalyDetected: boolean;
  lastRollupDate: string | null;
  todayLabel: SourceLabel;
}

const ANOMALY_DAILY_FLOOR_USD = 1.0;
const ANOMALY_MULTIPLIER = 3;
const HISTORY_DAYS = 7;
const MIN_HISTORY_FOR_ANOMALY = HISTORY_DAYS + 1; // 8 rows = 1 today + 7 trailing days

@injectable()
export class CostTransparencyService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.CostTransparencyRepository) private repo: CostTransparencyRepository,
  ) {}

  /**
   * Returns 'measured' | 'estimated' | 'mixed (M measured, E estimated)' | 'no data'.
   */
  static formatSourceLabel(measured: number, estimated: number): SourceLabel {
    if (measured === 0 && estimated === 0) return 'no data';
    if (estimated === 0) return 'measured';
    if (measured === 0) return 'estimated';
    return `mixed (${measured} measured, ${estimated} estimated)`;
  }

  /**
   * Anomaly = today > MULTIPLIER * trailing-7d-avg AND today > FLOOR.
   * `history[0]` MUST be the most recent day (descending order matches repo).
   * Requires at least 8 rows: 1 for today + 7 trailing days to compute the full average.
   */
  static detectAnomaly(history: DailyRollupRow[]): boolean {
    if (history.length < MIN_HISTORY_FOR_ANOMALY) return false; // need today + 7 trailing = 8 rows
    const today = history[0].totalCostUsd;
    const trailing = history.slice(1, 1 + HISTORY_DAYS);
    if (trailing.length === 0) return false;
    const avg = trailing.reduce((s, r) => s + r.totalCostUsd, 0) / trailing.length;
    return today > ANOMALY_DAILY_FLOOR_USD && today > ANOMALY_MULTIPLIER * avg;
  }

  /**
   * Reads raw usage for a single UTC date, writes both rollup tables (per-provider + per-flow).
   */
  async rollupDay(tenantId: string, dateUtc: string): Promise<void> {
    const providerBuckets = await this.repo.getRawUsageForDate(tenantId, dateUtc);
    for (const b of providerBuckets) {
      await this.repo.upsertDailyRollup({
        tenantId, provider: b.provider, dateUtc,
        totalCostUsd: b.totalCostUsd, measuredCount: b.measuredCount, estimatedCount: b.estimatedCount,
      });
    }

    const flowBuckets = await this.repo.getRawFlowUsageForDate(tenantId, dateUtc);
    for (const b of flowBuckets) {
      await this.repo.upsertPerFlowRollup({
        tenantId, flowName: b.flowName, dateUtc,
        totalCostUsd: b.totalCostUsd, measuredCount: b.measuredCount, estimatedCount: b.estimatedCount,
      });
    }

    this.logger.info('CostTransparency rollup written', {
      tenantId, dateUtc,
      providerCount: providerBuckets.length, flowCount: flowBuckets.length,
    });
  }

  /**
   * Aggregate per-provider rollup rows into per-date totals. Required because
   * `detectAnomaly` operates on a "daily total" contract; the raw rollup history
   * has one row per (tenant, provider, date) which would silently bias the
   * trailing-7-day average if multiple providers contribute on the same date.
   *
   * Returns rows in descending dateUtc order to match `detectAnomaly`'s expectation
   * that history[0] is today.
   */
  static aggregateByDate(history: DailyRollupRow[]): DailyRollupRow[] {
    const byDate = new Map<string, DailyRollupRow>();
    for (const r of history) {
      const existing = byDate.get(r.dateUtc);
      if (existing) {
        existing.totalCostUsd += r.totalCostUsd;
        existing.measuredCount += r.measuredCount;
        existing.estimatedCount += r.estimatedCount;
      } else {
        byDate.set(r.dateUtc, {
          tenantId: r.tenantId,
          provider: '__aggregated__',
          dateUtc: r.dateUtc,
          totalCostUsd: r.totalCostUsd,
          measuredCount: r.measuredCount,
          estimatedCount: r.estimatedCount,
        });
      }
    }
    // Descending by dateUtc so history[0] is today.
    return Array.from(byDate.values()).sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : a.dateUtc > b.dateUtc ? -1 : 0));
  }

  /**
   * Returns last 8 days (today + 7 prior) of rollups, anomaly flag, and source label for today.
   * `todayLabel` aggregates across all providers active today so the mix reflects the full day.
   * `anomalyDetected` is computed on per-day TOTALS (aggregated across providers) so a multi-
   * provider deployment doesn't skew the trailing-7d average with per-provider sub-rows.
   */
  async getDashboard(tenantId: string): Promise<DashboardModel> {
    const endUtc = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - HISTORY_DAYS);
    const startUtc = start.toISOString().slice(0, 10);

    const history = await this.repo.getDailyRollups(tenantId, { startUtc, endUtc });
    const flows = await this.repo.getPerFlowRollups(tenantId, { startUtc, endUtc });

    // Aggregate today's source mix across ALL providers, not just the first one found.
    const todayRows = history.filter((r) => r.dateUtc === endUtc);
    const measuredTotal = todayRows.reduce((s, r) => s + r.measuredCount, 0);
    const estimatedTotal = todayRows.reduce((s, r) => s + r.estimatedCount, 0);
    const todayLabel = CostTransparencyService.formatSourceLabel(measuredTotal, estimatedTotal);

    return {
      tenantId,
      history,
      flows,
      anomalyDetected: CostTransparencyService.detectAnomaly(CostTransparencyService.aggregateByDate(history)),
      lastRollupDate: history[0]?.dateUtc ?? null,
      todayLabel,
    };
  }

  /**
   * Returns only anomaly detection data without fetching per-flow rollups.
   * Avoids the double-fetch that `getDashboard` performs when the caller
   * only needs the anomaly flag and daily history.
   * `anomalyDetected` is computed on per-day TOTALS (aggregated across providers).
   */
  async getAnomalySummary(tenantId: string): Promise<{ anomalyDetected: boolean; history: DailyRollupRow[] }> {
    const endUtc = new Date().toISOString().slice(0, 10);
    const start = new Date();
    start.setUTCDate(start.getUTCDate() - HISTORY_DAYS);
    const startUtc = start.toISOString().slice(0, 10);

    const history = await this.repo.getDailyRollups(tenantId, { startUtc, endUtc });
    return {
      anomalyDetected: CostTransparencyService.detectAnomaly(CostTransparencyService.aggregateByDate(history)),
      history, // raw per-provider history for the route — caller can re-aggregate if needed
    };
  }

  /** Returns list of tenants active within the last 30 days. */
  async listTenants(): Promise<string[]> {
    return this.repo.listActiveTenants(30);
  }
}
