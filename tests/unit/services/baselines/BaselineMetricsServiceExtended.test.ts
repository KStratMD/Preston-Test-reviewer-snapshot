/**
 * Comprehensive unit tests for BaselineMetricsService
 * Covers: initializeBaselines, captureCurrentBaseline, compareToBaseline,
 *         getDashboardData, calculateOverallScore, evaluateGateStatus,
 *         calculatePerformanceScore, calculateAIScore, calculateCostScore
 */
import 'reflect-metadata';
import { BaselineMetricsService } from '../../../../src/services/baselines/BaselineMetricsService';

// Mock the logger module
jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

describe('BaselineMetricsService', () => {
  let service: BaselineMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BaselineMetricsService();
  });

  describe('captureCurrentBaseline', () => {
    it('should capture all metric categories', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.id).toMatch(/^baseline-\d+$/);
      expect(baseline.timestamp).toBeInstanceOf(Date);
      expect(baseline.lighthouse).toBeDefined();
      expect(baseline.performance).toBeDefined();
      expect(baseline.ai).toBeDefined();
      expect(baseline.cost).toBeDefined();
      expect(baseline.bundle).toBeDefined();
      expect(baseline.accessibility).toBeDefined();
    });

    it('should capture lighthouse metrics', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.lighthouse.performance).toBe(85);
      expect(baseline.lighthouse.accessibility).toBe(88);
      expect(baseline.lighthouse.bestPractices).toBe(92);
      expect(baseline.lighthouse.seo).toBe(90);
      expect(baseline.lighthouse.pwa).toBe(85);
      expect(baseline.lighthouse.mobile).toBeDefined();
      expect(baseline.lighthouse.desktop).toBeDefined();
    });

    it('should capture performance metrics (Core Web Vitals)', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.performance.lcp).toBe(2100);
      expect(baseline.performance.fid).toBe(85);
      expect(baseline.performance.cls).toBe(0.08);
      expect(baseline.performance.ttfb).toBe(180);
      expect(baseline.performance.tti).toBe(2800);
      expect(baseline.performance.fcp).toBe(1200);
      expect(baseline.performance.responseTime).toBe(145);
      expect(baseline.performance.throughput).toBe(50000);
    });

    it('should capture AI metrics', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.ai.accuracy.fieldMapping).toBe(96.2);
      expect(baseline.ai.accuracy.topK.top1).toBe(90.1);
      expect(baseline.ai.confidence.average).toBe(0.85);
      expect(baseline.ai.latency).toBe(275);
      expect(baseline.ai.costPerSession).toBe(0.18);
      expect(baseline.ai.errorRate).toBe(0.08);
    });

    it('should capture cost metrics', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.cost.total).toBe(1250.50);
      expect(baseline.cost.perSession).toBe(0.18);
      expect(baseline.cost.perRequest).toBe(0.004);
      expect(baseline.cost.breakdown.openai).toBe(680.25);
      expect(baseline.cost.breakdown.claude).toBe(420.15);
      expect(baseline.cost.projectedMonthly).toBe(1485.60);
    });

    it('should capture bundle metrics', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.bundle.totalSize).toBe(2850);
      expect(baseline.bundle.gzippedSize).toBe(285);
      expect(baseline.bundle.cacheHitRate).toBe(89);
    });

    it('should capture accessibility metrics', async () => {
      const baseline = await service.captureCurrentBaseline();
      expect(baseline.accessibility.wcagAA).toBe(88);
      expect(baseline.accessibility.violations.length).toBe(2);
      expect(baseline.accessibility.keyboardNavigation).toBe(true);
      expect(baseline.accessibility.screenReaderCompatibility).toBe(91);
    });
  });

  describe('initializeBaselines', () => {
    it('should establish initial baseline', async () => {
      await service.initializeBaselines();
      // After initialization, getDashboardData should work
      const dashboard = service.getDashboardData();
      expect(dashboard.baseline).toBeDefined();
      expect(dashboard.baseline.lighthouse.performance).toBe(85);
    });

    it('should store the baseline in history', async () => {
      await service.initializeBaselines();
      // Access private baselines array via comparison
      const comparison = await service.compareToBaseline();
      expect(comparison.baseline).toBeDefined();
    });
  });

  describe('compareToBaseline', () => {
    it('should throw when no baseline established', async () => {
      await expect(service.compareToBaseline())
        .rejects.toThrow('No baseline established');
    });

    it('should return comparison with all fields', async () => {
      await service.initializeBaselines();
      const comparison = await service.compareToBaseline();
      expect(comparison.timestamp).toBeInstanceOf(Date);
      expect(comparison.baseline).toBeDefined();
      expect(comparison.current).toBeDefined();
      expect(comparison.improvements).toBeDefined();
      expect(comparison.regressions).toBeDefined();
      expect(comparison.overallScore).toBeGreaterThan(0);
      expect(comparison.gateStatus).toBeDefined();
    });

    it('should detect no improvements when baseline equals current', async () => {
      await service.initializeBaselines();
      const comparison = await service.compareToBaseline();
      // Since stub returns same values, no improvements (not strictly greater)
      expect(comparison.improvements.length).toBe(0);
    });

    it('should detect no regressions when baseline equals current', async () => {
      await service.initializeBaselines();
      const comparison = await service.compareToBaseline();
      expect(comparison.regressions.length).toBe(0);
    });

    it('should have valid gate status', async () => {
      await service.initializeBaselines();
      const comparison = await service.compareToBaseline();
      expect(['passing', 'warning', 'failing']).toContain(comparison.gateStatus.overallStatus);
      expect(comparison.gateStatus.totalChecks).toBe(4);
      expect(comparison.gateStatus.checks.length).toBe(4);
    });

    it('should evaluate gate checks correctly', async () => {
      await service.initializeBaselines();
      const comparison = await service.compareToBaseline();
      const checks = comparison.gateStatus.checks;

      // Week 2 Gate: lighthouse >= 88 — baseline is 85, should fail
      const week2 = checks.find(c => c.gate === 'Week 2');
      expect(week2!.passed).toBe(false);
      expect(week2!.actual).toBe(85);

      // Week 8 Gate: costPerSession <= 0.30 — baseline is 0.18, should pass
      const week8 = checks.find(c => c.gate === 'Week 8');
      expect(week8!.passed).toBe(true);

      // Week 12 Gate: ai accuracy >= 90 — baseline is 96.2, should pass
      const week12 = checks.find(c => c.gate === 'Week 12');
      expect(week12!.passed).toBe(true);
    });
  });

  describe('getDashboardData', () => {
    it('should throw when no baseline established', () => {
      expect(() => service.getDashboardData())
        .toThrow('No baseline established');
    });

    it('should return dashboard data after initialization', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      expect(dashboard.lastUpdated).toBeInstanceOf(Date);
      expect(dashboard.baseline).toBeDefined();
      expect(dashboard.summary).toBeDefined();
      expect(dashboard.trends).toBeDefined();
      expect(dashboard.alerts).toBeDefined();
    });

    it('should include summary scores', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      expect(dashboard.summary.overallScore).toBeGreaterThan(0);
      expect(dashboard.summary.lighthouse).toBe(85);
      expect(dashboard.summary.aiAccuracy).toBe(96.2);
      expect(dashboard.summary.accessibility).toBe(88);
      expect(dashboard.summary.performance).toBeGreaterThan(0);
      expect(dashboard.summary.costEfficiency).toBeGreaterThan(0);
    });

    it('should include trends', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      expect(dashboard.trends.length).toBeGreaterThan(0);
      expect(dashboard.trends[0]).toHaveProperty('metric');
      expect(dashboard.trends[0]).toHaveProperty('trend');
      expect(dashboard.trends[0]).toHaveProperty('change');
    });

    it('should not include cost alert when below threshold', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      // costPerSession is 0.18, threshold is 0.25 for warning
      expect(dashboard.alerts.length).toBe(0);
    });
  });

  describe('scoring functions', () => {
    it('should calculate overall score as weighted average', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      // Overall score should be in 0-100 range
      expect(dashboard.summary.overallScore).toBeGreaterThan(0);
      expect(dashboard.summary.overallScore).toBeLessThanOrEqual(100);
    });

    it('should calculate performance score based on web vitals', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      // Current values: LCP=2100 (needs improvement -10), FID=85 (needs improvement -8),
      // CLS=0.08 (good), TTI=2800 (good) = 100 - 10 - 8 = 82
      expect(dashboard.summary.performance).toBe(82);
    });

    it('should calculate cost efficiency score', async () => {
      await service.initializeBaselines();
      const dashboard = service.getDashboardData();
      // perSession = 0.18, which falls in <= 0.20 => score 90
      expect(dashboard.summary.costEfficiency).toBe(90);
    });
  });
});
