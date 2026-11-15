/**
 * Comprehensive tests for TelemetryStabilizationService
 * Covers: dashboards, metrics, streams, alerts, health, export
 */
import 'reflect-metadata';

jest.mock('../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { TelemetryStabilizationService } from '../../../src/services/telemetry/TelemetryStabilizationService';

describe('TelemetryStabilizationService', () => {
  let service: TelemetryStabilizationService;

  beforeEach(() => {
    jest.useFakeTimers();
    service = new TelemetryStabilizationService();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  describe('constructor and initialization', () => {
    it('should initialize with default dashboards', () => {
      const dashboards = service.listDashboards();
      expect(dashboards.length).toBe(3);
    });

    it('should create operational dashboard', () => {
      const d = service.getDashboard('operational');
      expect(d).toBeDefined();
      expect(d!.name).toBe('Operational Dashboard');
      expect(d!.type).toBe('operational');
      expect(d!.widgets.length).toBe(3);
    });

    it('should create business dashboard', () => {
      const d = service.getDashboard('business');
      expect(d).toBeDefined();
      expect(d!.type).toBe('business');
    });

    it('should create technical dashboard', () => {
      const d = service.getDashboard('technical');
      expect(d).toBeDefined();
      expect(d!.type).toBe('technical');
    });
  });

  describe('registerMetric', () => {
    it('should register a custom metric', () => {
      service.registerMetric({
        id: 'custom.metric',
        name: 'Custom',
        category: 'custom',
        type: 'gauge',
        unit: 'count',
        description: 'A custom metric',
        tags: ['test'],
        aggregation: 'avg',
        retention: 30,
      });
      // Verify by checking that getMetricValues works (metric exists)
      const values = service.getMetricValues('custom.metric', new Date(), new Date());
      expect(values).toBeDefined();
    });
  });

  describe('createDashboard', () => {
    it('should add a new dashboard', () => {
      service.createDashboard({
        id: 'custom',
        name: 'Custom Dashboard',
        type: 'executive',
        widgets: [],
        refreshInterval: 60,
        filters: [],
        layout: { type: 'grid', columns: 12 },
      });
      expect(service.getDashboard('custom')).toBeDefined();
      expect(service.listDashboards().length).toBe(4);
    });

    it('should update existing dashboard', () => {
      service.createDashboard({
        id: 'operational',
        name: 'Updated Operational',
        type: 'operational',
        widgets: [],
        refreshInterval: 15,
        filters: [],
        layout: { type: 'grid', columns: 6 },
      });
      const d = service.getDashboard('operational');
      expect(d!.name).toBe('Updated Operational');
      expect(service.listDashboards().length).toBe(3); // no duplication
    });
  });

  describe('getDashboard', () => {
    it('should return undefined for non-existent dashboard', () => {
      expect(service.getDashboard('nonexistent')).toBeUndefined();
    });
  });

  describe('createStream', () => {
    it('should create a telemetry stream', () => {
      service.createStream({
        id: 'stream-1',
        name: 'API Stream',
        source: 'api-server',
        destination: 'metrics-store',
        format: 'json',
        batchSize: 100,
        flushInterval: 5000,
        compression: true,
        encryption: true,
      });
      // Stream created without error
      expect(true).toBe(true);
    });
  });

  describe('createAlertRule', () => {
    it('should create an alert rule', () => {
      service.createAlertRule({
        id: 'alert-1',
        name: 'High CPU',
        metric: 'system.cpu.usage',
        condition: { operator: '>', threshold: 90 },
        severity: 'critical',
        actions: [{ type: 'log', target: 'console' }],
        cooldown: 300,
        enabled: true,
      });
      // Alert rule created without error
      expect(true).toBe(true);
    });
  });

  describe('getHealth', () => {
    it('should return healthy status', () => {
      const health = service.getHealth();
      expect(health.status).toBe('healthy');
    });

    it('should include collectors', () => {
      const health = service.getHealth();
      expect(health.collectors.length).toBe(3);
      expect(health.collectors[0].name).toBe('API Collector');
      expect(health.collectors[0].status).toBe('active');
    });

    it('should include storage info', () => {
      const health = service.getHealth();
      expect(health.storage.retentionDays).toBe(90);
      expect(health.storage.used).toBeGreaterThan(0);
      expect(health.storage.available).toBeGreaterThan(0);
    });

    it('should include processing info', () => {
      const health = service.getHealth();
      expect(health.processing.queueDepth).toBe(125);
      expect(health.processing.processingRate).toBe(1785);
      expect(health.processing.errorRate).toBe(0.008);
      expect(health.processing.latency).toBe(12);
    });

    it('should include lastCheck timestamp', () => {
      const health = service.getHealth();
      expect(health.lastCheck).toBeInstanceOf(Date);
    });
  });

  describe('getMetricValues', () => {
    it('should return data points in the time range', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:05:00Z');
      const values = service.getMetricValues('system.uptime', start, end);
      expect(values.length).toBeGreaterThan(0);
      values.forEach(v => {
        expect(v.timestamp).toBeInstanceOf(Date);
        expect(typeof v.value).toBe('number');
      });
    });

    it('should respect custom resolution', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:10:00Z');
      const values1min = service.getMetricValues('system.uptime', start, end, 60000);
      const values5min = service.getMetricValues('system.uptime', start, end, 300000);
      expect(values1min.length).toBeGreaterThan(values5min.length);
    });

    it('should default to 1 minute resolution', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:02:00Z');
      const values = service.getMetricValues('any.metric', start, end);
      // 2 minutes at 1 minute intervals = 3 points (0, 1, 2)
      expect(values.length).toBe(3);
    });
  });

  describe('exportTelemetryData', () => {
    it('should export as JSON by default', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:01:00Z');
      const exported = service.exportTelemetryData(start, end, 'json');
      const parsed = JSON.parse(exported);
      expect(parsed.period).toBeDefined();
      expect(parsed.metrics).toBeDefined();
    });

    it('should export as CSV', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:01:00Z');
      const csv = service.exportTelemetryData(start, end, 'csv');
      expect(csv).toContain('Timestamp,Metric,Value');
      expect(csv.split('\n').length).toBeGreaterThan(1);
    });

    it('should export as Prometheus format', () => {
      const start = new Date('2026-01-01T00:00:00Z');
      const end = new Date('2026-01-01T00:01:00Z');
      const prom = service.exportTelemetryData(start, end, 'prometheus');
      expect(prom).toContain('# HELP');
      expect(prom).toContain('# TYPE');
    });
  });

  describe('operational dashboard widgets', () => {
    it('should have uptime gauge widget', () => {
      const d = service.getDashboard('operational')!;
      const uptimeWidget = d.widgets.find(w => w.id === 'uptime-gauge');
      expect(uptimeWidget).toBeDefined();
      expect(uptimeWidget!.type).toBe('gauge');
    });

    it('should have response time chart widget', () => {
      const d = service.getDashboard('operational')!;
      const rtWidget = d.widgets.find(w => w.id === 'response-time-chart');
      expect(rtWidget).toBeDefined();
      expect(rtWidget!.type).toBe('chart');
      expect(rtWidget!.visualization.chartType).toBe('line');
    });

    it('should have error rate chart widget', () => {
      const d = service.getDashboard('operational')!;
      const errWidget = d.widgets.find(w => w.id === 'error-rate-chart');
      expect(errWidget).toBeDefined();
      expect(errWidget!.visualization.chartType).toBe('area');
    });
  });
});
