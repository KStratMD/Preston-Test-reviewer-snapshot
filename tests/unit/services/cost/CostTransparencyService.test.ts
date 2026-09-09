import { CostTransparencyService, type DashboardModel } from '../../../../src/services/cost/CostTransparencyService';
import type { CostTransparencyRepository } from '../../../../src/services/cost/CostTransparencyRepository';

function makeRepoMock(overrides: Partial<CostTransparencyRepository> = {}): CostTransparencyRepository {
  return {
    upsertDailyRollup: jest.fn(),
    upsertPerFlowRollup: jest.fn(),
    getDailyRollups: jest.fn().mockResolvedValue([]),
    getPerFlowRollups: jest.fn().mockResolvedValue([]),
    getRawUsageForDate: jest.fn().mockResolvedValue([]),
    getRawFlowUsageForDate: jest.fn().mockResolvedValue([]),
    listActiveTenants: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as CostTransparencyRepository;
}

const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

describe('CostTransparencyService', () => {
  describe('formatSourceLabel', () => {
    it('returns "measured" when only measured rows', () => {
      expect(CostTransparencyService.formatSourceLabel(5, 0)).toBe('measured');
    });
    it('returns "estimated" when only estimated', () => {
      expect(CostTransparencyService.formatSourceLabel(0, 5)).toBe('estimated');
    });
    it('returns mixed with counts when both', () => {
      expect(CostTransparencyService.formatSourceLabel(3, 2)).toBe('mixed (3 measured, 2 estimated)');
    });
    it('returns "no data" when both zero', () => {
      expect(CostTransparencyService.formatSourceLabel(0, 0)).toBe('no data');
    });
  });

  describe('detectAnomaly', () => {
    const day = (date: string, cost: number) => ({
      tenantId: 't1', provider: 'openai', dateUtc: date,
      totalCostUsd: cost, measuredCount: 1, estimatedCount: 0,
    });

    it('flags when day > 3× 7d avg AND > $1', () => {
      const history = [
        day('2026-05-22', 5.00),
        day('2026-05-21', 1.00), day('2026-05-20', 1.00), day('2026-05-19', 1.00),
        day('2026-05-18', 1.00), day('2026-05-17', 1.00), day('2026-05-16', 1.00),
        day('2026-05-15', 1.00),
      ];
      expect(CostTransparencyService.detectAnomaly(history)).toBe(true);
    });

    it('does NOT flag when daily cost ≤ $1 even if 10× avg', () => {
      const history = [
        day('2026-05-22', 0.99),
        day('2026-05-21', 0.01), day('2026-05-20', 0.01), day('2026-05-19', 0.01),
        day('2026-05-18', 0.01), day('2026-05-17', 0.01), day('2026-05-16', 0.01),
        day('2026-05-15', 0.01),
      ];
      expect(CostTransparencyService.detectAnomaly(history)).toBe(false);
    });

    it('does NOT flag when daily cost is < 3× 7d avg', () => {
      const history = [
        day('2026-05-22', 5.00),
        day('2026-05-21', 2.00), day('2026-05-20', 2.00), day('2026-05-19', 2.00),
        day('2026-05-18', 2.00), day('2026-05-17', 2.00), day('2026-05-16', 2.00),
        day('2026-05-15', 2.00),
      ];
      expect(CostTransparencyService.detectAnomaly(history)).toBe(false);
    });

    it('returns false with fewer than 8 rows (need today + 7 trailing)', () => {
      // Exactly 7 rows is NOT enough — need 1 today + 7 trailing = 8 total.
      const seven = Array.from({ length: 7 }, (_, i) => day(`2026-05-${22 - i}`, i === 0 ? 100 : 0.01));
      expect(CostTransparencyService.detectAnomaly(seven)).toBe(false);
      expect(CostTransparencyService.detectAnomaly(seven.slice(0, 2))).toBe(false);
    });

    it('regression: multi-provider rollups must be aggregated by date before threshold check', () => {
      // Without aggregation, history[0] = openai today = $1 (below floor),
      // history.slice(1,8) might include 'anthropic' from same day. With aggregation,
      // today's TOTAL is $4 ($1 + $3) which IS the right anomaly signal.
      const rawHistory = [
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-22', totalCostUsd: 1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'anthropic', dateUtc: '2026-05-22', totalCostUsd: 3, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-21', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-20', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-19', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-18', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-17', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-16', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-15', totalCostUsd: 0.1, measuredCount: 1, estimatedCount: 0 },
      ];
      const aggregated = CostTransparencyService.aggregateByDate(rawHistory);
      // 8 unique dates after aggregation; today's total = $4 > 3× trailing $0.1 avg = $0.30 AND > $1 floor → anomaly
      expect(aggregated).toHaveLength(8);
      expect(aggregated[0].totalCostUsd).toBe(4);
      expect(CostTransparencyService.detectAnomaly(aggregated)).toBe(true);
    });
  });

  describe('rollupDay', () => {
    it('writes one row per provider and per flow from raw usage', async () => {
      const upsertDaily = jest.fn();
      const upsertPerFlow = jest.fn();
      const repo = makeRepoMock({
        upsertDailyRollup: upsertDaily,
        upsertPerFlowRollup: upsertPerFlow,
        getRawUsageForDate: jest.fn().mockResolvedValue([
          { provider: 'openai',    totalCostUsd: 1.50, measuredCount: 5, estimatedCount: 2 },
          { provider: 'anthropic', totalCostUsd: 0.75, measuredCount: 3, estimatedCount: 0 },
        ]),
        getRawFlowUsageForDate: jest.fn().mockResolvedValue([
          { flowName: 'mapping',           totalCostUsd: 1.50, measuredCount: 4, estimatedCount: 1 },
          { flowName: 'sync-error-assist', totalCostUsd: 0.75, measuredCount: 4, estimatedCount: 1 },
        ]),
      } as any);
      const svc = new CostTransparencyService(mockLogger, repo);

      await svc.rollupDay('t1', '2026-05-22');

      expect(upsertDaily).toHaveBeenCalledTimes(2);
      expect(upsertPerFlow).toHaveBeenCalledTimes(2);
      expect(upsertDaily).toHaveBeenCalledWith(expect.objectContaining({ tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22' }));
    });
  });

  describe('getDashboard', () => {
    it('returns last-rollup timestamp + 7d history + anomaly flag', async () => {
      const recent = Array.from({ length: 8 }, (_, i) => ({
        tenantId: 't1', provider: 'openai', dateUtc: `2026-05-${(15 + i).toString().padStart(2, '0')}`,
        totalCostUsd: i === 7 ? 10 : 1, measuredCount: 1, estimatedCount: 0,
      })).reverse(); // newest first
      const repo = makeRepoMock({ getDailyRollups: jest.fn().mockResolvedValue(recent) } as any);
      const svc = new CostTransparencyService(mockLogger, repo);

      const dash: DashboardModel = await svc.getDashboard('t1');
      expect(dash.anomalyDetected).toBe(true);
      expect(dash.history).toHaveLength(8);
      expect(dash.lastRollupDate).not.toBeNull();
    });

    it('aggregates todayLabel across multiple providers for today', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-05-22T12:00:00Z'));
      try {
        const history = [
          { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-22', totalCostUsd: 1, measuredCount: 5, estimatedCount: 0 },
          { tenantId: 't1', provider: 'anthropic', dateUtc: '2026-05-22', totalCostUsd: 1, measuredCount: 0, estimatedCount: 3 },
        ];
        const repo = makeRepoMock({ getDailyRollups: jest.fn().mockResolvedValue(history) } as any);
        const svc = new CostTransparencyService(mockLogger, repo);

        const dash = await svc.getDashboard('t1');
        expect(dash.todayLabel).toBe('mixed (5 measured, 3 estimated)');
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('aggregateByDate', () => {
    it('sums totalCostUsd / measuredCount / estimatedCount across providers per date', () => {
      const rows = [
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-22', totalCostUsd: 1, measuredCount: 1, estimatedCount: 0 },
        { tenantId: 't1', provider: 'anthropic', dateUtc: '2026-05-22', totalCostUsd: 2, measuredCount: 0, estimatedCount: 3 },
        { tenantId: 't1', provider: 'openai',    dateUtc: '2026-05-21', totalCostUsd: 5, measuredCount: 4, estimatedCount: 0 },
      ];
      const agg = CostTransparencyService.aggregateByDate(rows);
      expect(agg).toHaveLength(2);
      // Descending order — today first
      expect(agg[0].dateUtc).toBe('2026-05-22');
      expect(agg[0].totalCostUsd).toBe(3);
      expect(agg[0].measuredCount).toBe(1);
      expect(agg[0].estimatedCount).toBe(3);
      expect(agg[1].dateUtc).toBe('2026-05-21');
      expect(agg[1].totalCostUsd).toBe(5);
    });

    it('preserves single-provider days unchanged in cost', () => {
      const rows = [
        { tenantId: 't1', provider: 'openai', dateUtc: '2026-05-22', totalCostUsd: 1.5, measuredCount: 2, estimatedCount: 1 },
      ];
      const agg = CostTransparencyService.aggregateByDate(rows);
      expect(agg).toHaveLength(1);
      expect(agg[0].totalCostUsd).toBe(1.5);
    });

    it('returns empty array on empty input', () => {
      expect(CostTransparencyService.aggregateByDate([])).toEqual([]);
    });
  });

  describe('getAnomalySummary', () => {
    it('returns anomalyDetected + history without fetching flows', async () => {
      const getDailyRollups = jest.fn().mockResolvedValue([]);
      const getPerFlowRollups = jest.fn().mockResolvedValue([]);
      const repo = makeRepoMock({ getDailyRollups, getPerFlowRollups } as any);
      const svc = new CostTransparencyService(mockLogger, repo);

      const result = await svc.getAnomalySummary('t1');
      expect(result).toHaveProperty('anomalyDetected');
      expect(result).toHaveProperty('history');
      expect(getDailyRollups).toHaveBeenCalledTimes(1);
      expect(getPerFlowRollups).not.toHaveBeenCalled();
    });
  });

  describe('listTenants', () => {
    it('delegates to repo.listActiveTenants with 30-day window', async () => {
      const listFn = jest.fn().mockResolvedValue(['t1', 't2']);
      const repo = makeRepoMock({ listActiveTenants: listFn } as any);
      const svc = new CostTransparencyService(mockLogger, repo);
      const result = await svc.listTenants();
      expect(listFn).toHaveBeenCalledWith(30);
      expect(result).toEqual(['t1', 't2']);
    });
  });
});
