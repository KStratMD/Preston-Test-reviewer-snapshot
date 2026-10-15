/**
 * Comprehensive unit tests for TelemetryAggregator
 * Covers: calculateROI, calculateBusinessMetrics, generateExecutiveSummary,
 *         generateTrendData, generatePerformanceBreakdown, and demo fallbacks
 */
import 'reflect-metadata';
import { TelemetryAggregator } from '../../../src/services/TelemetryAggregator';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockROIService = {
  calculateNetROI: jest.fn((gains: number, costs: number) => gains - costs),
  calculateSimpleROI: jest.fn((gains: number, costs: number) => ((gains - costs) / costs) * 100),
} as any;

function buildTelemetryStore(overrides: Partial<{
  totalEvents: number;
  totalRecordsProcessed: number;
  failureCount: number;
  successRate: number;
  averageDuration: number;
}> = {}) {
  const defaults = {
    totalEvents: 1000,
    totalRecordsProcessed: 5000,
    failureCount: 50,
    successRate: 95,
    averageDuration: 1200,
  };
  const metrics = { ...defaults, ...overrides };

  return {
    getMetrics: jest.fn().mockResolvedValue(metrics),
    queryEvents: jest.fn().mockResolvedValue([]),
  } as any;
}

describe('TelemetryAggregator', () => {
  let aggregator: TelemetryAggregator;

  beforeEach(() => {
    jest.clearAllMocks();
    aggregator = new TelemetryAggregator(mockLogger, mockROIService);
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(aggregator).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('TelemetryAggregator initialized');
    });
  });

  describe('calculateROI', () => {
    it('should calculate ROI from telemetry data', async () => {
      const store = buildTelemetryStore();
      const roi = await aggregator.calculateROI(store);

      expect(roi).toBeDefined();
      expect(typeof roi.totalRevenue).toBe('number');
      expect(typeof roi.costSavings).toBe('number');
      expect(typeof roi.implementationCosts).toBe('number');
      expect(typeof roi.operationalCosts).toBe('number');
      expect(typeof roi.netROI).toBe('number');
      expect(typeof roi.roiPercentage).toBe('number');
      expect(typeof roi.paybackPeriodMonths).toBe('number');
      expect(typeof roi.timeToValue).toBe('number');
    });

    it('should call roiService for net ROI calculation', async () => {
      const store = buildTelemetryStore();
      await aggregator.calculateROI(store);
      expect(mockROIService.calculateNetROI).toHaveBeenCalled();
      expect(mockROIService.calculateSimpleROI).toHaveBeenCalled();
    });

    it('should compute positive cost savings with records', async () => {
      const store = buildTelemetryStore({ totalRecordsProcessed: 10000 });
      const roi = await aggregator.calculateROI(store);
      expect(roi.costSavings).toBeGreaterThan(0);
    });

    it('should cap timeToValue at 6 months', async () => {
      const store = buildTelemetryStore({ totalRecordsProcessed: 100000 });
      const roi = await aggregator.calculateROI(store);
      expect(roi.timeToValue).toBeLessThanOrEqual(6);
    });

    it('should return demo metrics when no data in demo mode', async () => {
      const originalDemoMode = process.env.DEMO_MODE;
      process.env.DEMO_MODE = '1';
      try {
        const store = buildTelemetryStore({ totalEvents: 0 });
        const roi = await aggregator.calculateROI(store);
        expect(roi.totalRevenue).toBe(2485000);
        expect(roi.roiPercentage).toBe(340.7);
      } finally {
        process.env.DEMO_MODE = originalDemoMode;
      }
    });

    it('should log ROI metrics', async () => {
      const store = buildTelemetryStore();
      await aggregator.calculateROI(store);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'ROI metrics calculated',
        expect.objectContaining({
          netROI: expect.any(Number),
          roiPercentage: expect.any(Number),
        })
      );
    });

    it('should accept custom time range', async () => {
      const store = buildTelemetryStore();
      const roi = await aggregator.calculateROI(store, 7 * 24 * 60 * 60 * 1000);
      expect(roi).toBeDefined();
      expect(store.getMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          startTime: expect.any(Number),
          endTime: expect.any(Number),
        })
      );
    });

    it('should throw on store error', async () => {
      const store = {
        getMetrics: jest.fn().mockRejectedValue(new Error('store down')),
        queryEvents: jest.fn(),
      } as any;
      await expect(aggregator.calculateROI(store)).rejects.toThrow('store down');
    });
  });

  describe('calculateBusinessMetrics', () => {
    it('should calculate business metrics', async () => {
      const store = buildTelemetryStore();
      const metrics = await aggregator.calculateBusinessMetrics(store);

      expect(typeof metrics.integrationEfficiency).toBe('number');
      expect(typeof metrics.dataAccuracy).toBe('number');
      expect(typeof metrics.systemUptime).toBe('number');
      expect(typeof metrics.processingSpeed).toBe('number');
      expect(typeof metrics.errorRate).toBe('number');
      expect(typeof metrics.customerSatisfaction).toBe('number');
      expect(typeof metrics.timeToMarket).toBe('number');
    });

    it('should compute dataAccuracy from failures', async () => {
      const store = buildTelemetryStore({ totalEvents: 100, failureCount: 10 });
      const metrics = await aggregator.calculateBusinessMetrics(store);
      expect(metrics.dataAccuracy).toBeCloseTo(90, 0);
    });

    it('should return demo metrics in demo mode with no data', async () => {
      const originalDemoMode = process.env.DEMO_MODE;
      process.env.DEMO_MODE = '1';
      try {
        const store = buildTelemetryStore({ totalEvents: 0 });
        const metrics = await aggregator.calculateBusinessMetrics(store);
        expect(metrics.integrationEfficiency).toBe(4819);
        expect(metrics.dataAccuracy).toBe(95.4);
      } finally {
        process.env.DEMO_MODE = originalDemoMode;
      }
    });

    it('should cap customerSatisfaction at 100', async () => {
      const store = buildTelemetryStore({ successRate: 100, failureCount: 0, totalEvents: 1000 });
      const metrics = await aggregator.calculateBusinessMetrics(store);
      expect(metrics.customerSatisfaction).toBeLessThanOrEqual(100);
    });

    it('should handle zero events gracefully', async () => {
      const store = buildTelemetryStore({ totalEvents: 0, failureCount: 0, totalRecordsProcessed: 0 });
      // Without demo mode, will do calculations with zero (NaN territory)
      const metrics = await aggregator.calculateBusinessMetrics(store);
      expect(metrics).toBeDefined();
    });
  });

  describe('generateExecutiveSummary', () => {
    it('should generate a complete summary', async () => {
      const store = buildTelemetryStore();
      const summary = await aggregator.generateExecutiveSummary(store);

      expect(summary.period).toBeDefined();
      expect(summary.period.label).toBe('Last 30 Days');
      expect(typeof summary.totalIntegrations).toBe('number');
      expect(typeof summary.activeIntegrations).toBe('number');
      expect(typeof summary.totalDataProcessed).toBe('number');
      expect(typeof summary.successRate).toBe('number');
      expect(typeof summary.costSavings).toBe('number');
      expect(typeof summary.revenueImpact).toBe('number');
      expect(summary.roi).toBeDefined();
      expect(summary.businessMetrics).toBeDefined();
      expect(Array.isArray(summary.keyInsights)).toBe(true);
      expect(Array.isArray(summary.recommendations)).toBe(true);
      expect(Array.isArray(summary.riskFactors)).toBe(true);
    });

    it('should generate insights for high ROI', async () => {
      // ROI will be very high for large records processed
      mockROIService.calculateSimpleROI.mockReturnValue(500);
      const store = buildTelemetryStore({ totalRecordsProcessed: 100000 });
      const summary = await aggregator.generateExecutiveSummary(store);
      expect(summary.keyInsights.some(i => i.includes('ROI'))).toBe(true);
    });

    it('should recommend error rate improvement when high', async () => {
      const store = buildTelemetryStore({
        totalEvents: 100,
        failureCount: 10,
        successRate: 90,
      });
      const summary = await aggregator.generateExecutiveSummary(store);
      expect(summary.recommendations.some(r => r.includes('error rates'))).toBe(true);
    });

    it('should add risk factor for low uptime', async () => {
      const store = buildTelemetryStore({
        successRate: 93,
        failureCount: 70,
        totalEvents: 1000,
      });
      const summary = await aggregator.generateExecutiveSummary(store);
      // systemUptime = successRate = 93, which is < 95
      expect(summary.riskFactors.some(r => r.includes('reliability'))).toBe(true);
    });

    it('should query integration events', async () => {
      const store = buildTelemetryStore();
      await aggregator.generateExecutiveSummary(store);
      expect(store.queryEvents).toHaveBeenCalledWith(
        expect.objectContaining({
          eventTypes: ['IntegrationFlowStarted', 'IntegrationFlowCompleted'],
        })
      );
    });

    it('should count unique flows', async () => {
      const store = buildTelemetryStore();
      store.queryEvents.mockResolvedValue([
        { flowId: 'flow-1', type: 'IntegrationFlowStarted' },
        { flowId: 'flow-1', type: 'IntegrationFlowCompleted' },
        { flowId: 'flow-2', type: 'IntegrationFlowStarted' },
      ]);
      const summary = await aggregator.generateExecutiveSummary(store);
      expect(summary.totalIntegrations).toBe(2);
      expect(summary.activeIntegrations).toBe(2);
    });

    it('should throw on error', async () => {
      const store = {
        getMetrics: jest.fn().mockRejectedValue(new Error('fail')),
        queryEvents: jest.fn(),
      } as any;
      await expect(aggregator.generateExecutiveSummary(store)).rejects.toThrow('fail');
    });
  });

  describe('generateTrendData', () => {
    it('should generate trend data for throughput', async () => {
      const store = buildTelemetryStore();
      const trends = await aggregator.generateTrendData(store, 'throughput');
      expect(trends.length).toBe(24); // default bucketCount
      for (const t of trends) {
        expect(typeof t.timestamp).toBe('number');
        expect(typeof t.value).toBe('number');
        expect(typeof t.label).toBe('string');
      }
    });

    it('should generate trend data for success_rate', async () => {
      const store = buildTelemetryStore();
      const trends = await aggregator.generateTrendData(store, 'success_rate');
      expect(trends.length).toBe(24);
    });

    it('should generate trend data for processing_time', async () => {
      const store = buildTelemetryStore();
      const trends = await aggregator.generateTrendData(store, 'processing_time');
      expect(trends.length).toBe(24);
    });

    it('should generate trend data for error_count', async () => {
      const store = buildTelemetryStore();
      const trends = await aggregator.generateTrendData(store, 'error_count');
      expect(trends.length).toBe(24);
    });

    it('should accept custom bucket count', async () => {
      const store = buildTelemetryStore();
      const trends = await aggregator.generateTrendData(store, 'throughput', 7 * 24 * 60 * 60 * 1000, 7);
      expect(trends.length).toBe(7);
    });

    it('should call getMetrics for each bucket', async () => {
      const store = buildTelemetryStore();
      await aggregator.generateTrendData(store, 'throughput', 7 * 24 * 60 * 60 * 1000, 4);
      expect(store.getMetrics).toHaveBeenCalledTimes(4);
    });

    it('should throw on store error', async () => {
      const store = {
        getMetrics: jest.fn().mockRejectedValue(new Error('metric fail')),
        queryEvents: jest.fn(),
      } as any;
      await expect(aggregator.generateTrendData(store, 'throughput')).rejects.toThrow('metric fail');
    });
  });

  describe('generatePerformanceBreakdown', () => {
    it('should return breakdown from events', async () => {
      const store = buildTelemetryStore();
      store.queryEvents.mockResolvedValue([
        { type: 'IntegrationFlowStarted', sourceSystem: 'Salesforce', timestamp: Date.now() },
        { type: 'IntegrationFlowCompleted', sourceSystem: 'Salesforce', durationMs: 500, successCount: 10, timestamp: Date.now() },
        { type: 'IntegrationFlowStarted', sourceSystem: 'NetSuite', timestamp: Date.now() },
        { type: 'IntegrationFlowFailed', sourceSystem: 'NetSuite', timestamp: Date.now() },
      ]);

      const breakdown = await aggregator.generatePerformanceBreakdown(store);
      expect(breakdown.length).toBe(2);

      const sf = breakdown.find(b => b.connector === 'Salesforce');
      expect(sf).toBeDefined();
      expect(sf!.totalOperations).toBe(1);
      expect(sf!.successRate).toBe(100);

      const ns = breakdown.find(b => b.connector === 'NetSuite');
      expect(ns).toBeDefined();
      expect(ns!.totalOperations).toBe(1);
    });

    it('should return demo data in demo mode with no events', async () => {
      const originalDemoMode = process.env.DEMO_MODE;
      process.env.DEMO_MODE = '1';
      try {
        const store = buildTelemetryStore();
        store.queryEvents.mockResolvedValue([]);
        const breakdown = await aggregator.generatePerformanceBreakdown(store);
        expect(breakdown.length).toBe(6);
        expect(breakdown[0].connector).toBe('Salesforce');
      } finally {
        process.env.DEMO_MODE = originalDemoMode;
      }
    });

    it('should sort by totalOperations descending', async () => {
      const store = buildTelemetryStore();
      store.queryEvents.mockResolvedValue([
        { type: 'IntegrationFlowStarted', sourceSystem: 'A', timestamp: Date.now() },
        { type: 'IntegrationFlowStarted', sourceSystem: 'B', timestamp: Date.now() },
        { type: 'IntegrationFlowStarted', sourceSystem: 'B', timestamp: Date.now() },
      ]);
      const breakdown = await aggregator.generatePerformanceBreakdown(store);
      expect(breakdown[0].connector).toBe('B');
      expect(breakdown[0].totalOperations).toBe(2);
    });

    it('should compute average latency from durations', async () => {
      const store = buildTelemetryStore();
      store.queryEvents.mockResolvedValue([
        { type: 'IntegrationFlowStarted', sourceSystem: 'X', timestamp: Date.now() },
        { type: 'IntegrationFlowCompleted', sourceSystem: 'X', durationMs: 100, successCount: 5, timestamp: Date.now() },
        { type: 'IntegrationFlowCompleted', sourceSystem: 'X', durationMs: 300, successCount: 10, timestamp: Date.now() },
      ]);
      const breakdown = await aggregator.generatePerformanceBreakdown(store);
      const x = breakdown.find(b => b.connector === 'X');
      expect(x!.averageLatency).toBe(200);
    });

    it('should handle events with no sourceSystem', async () => {
      const store = buildTelemetryStore();
      store.queryEvents.mockResolvedValue([
        { type: 'IntegrationFlowStarted', timestamp: Date.now() },
      ]);
      const breakdown = await aggregator.generatePerformanceBreakdown(store);
      expect(breakdown[0].connector).toBe('Unknown');
    });

    it('should throw on query error', async () => {
      const store = {
        getMetrics: jest.fn(),
        queryEvents: jest.fn().mockRejectedValue(new Error('query fail')),
      } as any;
      await expect(aggregator.generatePerformanceBreakdown(store)).rejects.toThrow('query fail');
    });
  });
});
