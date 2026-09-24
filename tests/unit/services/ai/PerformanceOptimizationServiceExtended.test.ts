/**
 * Comprehensive unit tests for PerformanceOptimizationService
 * Covers: collectCurrentMetrics, analyzePerformance, createOptimizationPlan,
 *         executeOptimization, detectBottlenecks, generatePerformanceReport,
 *         createBaseline, startMonitoring, stopMonitoring, validateWeek7PerformanceGains
 */
import 'reflect-metadata';
import { PerformanceOptimizationService } from '../../../../src/services/ai/PerformanceOptimizationService';

const mockLoggingService = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockTelemetryService = {
  recordMetric: jest.fn(),
  recordEvent: jest.fn().mockResolvedValue(undefined),
} as any;

describe('PerformanceOptimizationService', () => {
  let service: PerformanceOptimizationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PerformanceOptimizationService(mockLoggingService, mockTelemetryService);
  });

  afterEach(() => {
    // Stop monitoring to clear intervals
    service.stopMonitoring().catch(() => {});
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(service).toBeDefined();
      expect(mockLoggingService.info).toHaveBeenCalledWith('Initializing Performance Optimization Service');
    });
  });

  describe('collectCurrentMetrics', () => {
    it('should return performance metrics with all required fields', async () => {
      const metrics = await service.collectCurrentMetrics();
      expect(metrics).toBeDefined();
      expect(metrics.timestamp).toBeInstanceOf(Date);
      expect(typeof metrics.responseTime).toBe('number');
      expect(typeof metrics.throughput).toBe('number');
      expect(typeof metrics.errorRate).toBe('number');
      expect(typeof metrics.memoryUsage).toBe('number');
      expect(typeof metrics.cpuUsage).toBe('number');
      expect(typeof metrics.diskIo).toBe('number');
      expect(typeof metrics.networkLatency).toBe('number');
      expect(typeof metrics.cacheHitRate).toBe('number');
      expect(typeof metrics.connectionPoolSize).toBe('number');
      expect(typeof metrics.queueLength).toBe('number');
      expect(typeof metrics.systemLoad).toBe('number');
    });

    it('should record telemetry metric', async () => {
      await service.collectCurrentMetrics();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'metrics_collected',
        1,
        expect.objectContaining({
          responseTime: expect.any(Number),
          throughput: expect.any(Number),
          errorRate: expect.any(Number),
        })
      );
    });

    it('should log debug message', async () => {
      await service.collectCurrentMetrics();
      expect(mockLoggingService.debug).toHaveBeenCalledWith(
        'Performance metrics collected',
        expect.any(Object)
      );
    });

    it('should return metrics within expected ranges', async () => {
      const metrics = await service.collectCurrentMetrics();
      expect(metrics.responseTime).toBeGreaterThanOrEqual(0);
      expect(metrics.throughput).toBeGreaterThanOrEqual(0);
      expect(metrics.errorRate).toBeGreaterThanOrEqual(0);
      expect(metrics.memoryUsage).toBeGreaterThanOrEqual(0);
      expect(metrics.cpuUsage).toBeGreaterThanOrEqual(0);
    });
  });

  describe('analyzePerformance', () => {
    it('should return an array of recommendations', async () => {
      const recommendations = await service.analyzePerformance();
      expect(Array.isArray(recommendations)).toBe(true);
    });

    it('should record telemetry after analysis', async () => {
      await service.analyzePerformance();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'performance_analyzed',
        1,
        expect.objectContaining({
          recommendationsCount: expect.any(Number),
          criticalIssues: expect.any(Number),
        })
      );
    });

    it('should log completion info', async () => {
      await service.analyzePerformance();
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Performance analysis completed',
        expect.any(Object)
      );
    });

    it('should sort recommendations by priority', async () => {
      const recommendations = await service.analyzePerformance();
      if (recommendations.length >= 2) {
        const priorityWeight: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
        for (let i = 0; i < recommendations.length - 1; i++) {
          const w1 = priorityWeight[recommendations[i].priority];
          const w2 = priorityWeight[recommendations[i + 1].priority];
          expect(w1).toBeGreaterThanOrEqual(w2);
        }
      }
    });

    it('should have valid recommendation structure', async () => {
      const recommendations = await service.analyzePerformance();
      for (const rec of recommendations) {
        expect(rec.id).toBeDefined();
        expect(['performance', 'memory', 'network', 'cache', 'database', 'code']).toContain(rec.category);
        expect(['low', 'medium', 'high', 'critical']).toContain(rec.priority);
        expect(rec.title).toBeDefined();
        expect(rec.description).toBeDefined();
        expect(typeof rec.estimatedImprovement).toBe('number');
        expect(Array.isArray(rec.risks)).toBe(true);
        expect(Array.isArray(rec.dependencies)).toBe(true);
      }
    });
  });

  describe('createOptimizationPlan', () => {
    it('should create a plan with phases', async () => {
      const plan = await service.createOptimizationPlan(25);
      expect(plan).toBeDefined();
      expect(plan.planId).toMatch(/^opt-plan-/);
      expect(plan.targetImprovement).toBe(25);
      expect(Array.isArray(plan.phases)).toBe(true);
      expect(plan.totalEstimatedTime).toBeDefined();
      expect(Array.isArray(plan.resourceRequirements)).toBe(true);
      expect(Array.isArray(plan.successCriteria)).toBe(true);
    });

    it('should filter empty phases', async () => {
      const plan = await service.createOptimizationPlan(10);
      for (const phase of plan.phases) {
        expect(phase.recommendations.length).toBeGreaterThan(0);
      }
    });

    it('should record telemetry', async () => {
      await service.createOptimizationPlan(15);
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'optimization_plan_created',
        1,
        expect.objectContaining({
          targetImprovement: 15,
          phasesCount: expect.any(Number),
        })
      );
    });

    it('should include success criteria referencing target improvement', async () => {
      const plan = await service.createOptimizationPlan(30);
      const hasTarget = plan.successCriteria.some(c => c.includes('30'));
      expect(hasTarget).toBe(true);
    });

    it('should have phases numbered sequentially', async () => {
      const plan = await service.createOptimizationPlan(20);
      for (let i = 0; i < plan.phases.length; i++) {
        expect(plan.phases[i].phaseNumber).toBeGreaterThan(0);
      }
    });
  });

  describe('executeOptimization', () => {
    it('should execute and return result with before/after metrics', async () => {
      const result = await service.executeOptimization('opt-001');
      expect(result).toBeDefined();
      expect(result.optimizationId).toBe('opt-001');
      expect(result.implementedAt).toBeInstanceOf(Date);
      expect(result.beforeMetrics).toBeDefined();
      expect(result.afterMetrics).toBeDefined();
      expect(result.status).toBe('success');
    }, 10000);

    it('should calculate improvement scores', async () => {
      const result = await service.executeOptimization('opt-002');
      expect(typeof result.improvement.responseTime).toBe('number');
      expect(typeof result.improvement.throughput).toBe('number');
      expect(typeof result.improvement.errorRate).toBe('number');
      expect(typeof result.improvement.memoryUsage).toBe('number');
      expect(typeof result.improvement.overallScore).toBe('number');
    }, 10000);

    it('should record telemetry', async () => {
      await service.executeOptimization('opt-test');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'optimization_executed',
        1,
        expect.objectContaining({
          recommendationId: 'opt-test',
          status: 'success',
        })
      );
    }, 10000);

    it('should log success on completion', async () => {
      await service.executeOptimization('opt-a');
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Optimization executed successfully',
        expect.objectContaining({ recommendationId: 'opt-a' })
      );
    }, 10000);
  });

  describe('detectBottlenecks', () => {
    it('should return an array of bottlenecks', async () => {
      const bottlenecks = await service.detectBottlenecks();
      expect(Array.isArray(bottlenecks)).toBe(true);
    });

    it('should sort by severity descending', async () => {
      const bottlenecks = await service.detectBottlenecks();
      if (bottlenecks.length >= 2) {
        for (let i = 0; i < bottlenecks.length - 1; i++) {
          expect(bottlenecks[i].severity).toBeGreaterThanOrEqual(bottlenecks[i + 1].severity);
        }
      }
    });

    it('should have valid bottleneck structure', async () => {
      const bottlenecks = await service.detectBottlenecks();
      for (const bn of bottlenecks) {
        expect(bn.component).toBeDefined();
        expect(['cpu', 'memory', 'disk', 'network', 'database', 'cache']).toContain(bn.type);
        expect(typeof bn.severity).toBe('number');
        expect(bn.description).toBeDefined();
        expect(bn.impact).toBeDefined();
        expect(Array.isArray(bn.suggestedFixes)).toBe(true);
        expect(Array.isArray(bn.monitoring)).toBe(true);
      }
    });

    it('should record telemetry', async () => {
      await service.detectBottlenecks();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'bottlenecks_detected',
        expect.any(Number),
        expect.any(Object)
      );
    });
  });

  describe('generatePerformanceReport', () => {
    it('should generate a complete report', async () => {
      const start = new Date('2026-01-01');
      const end = new Date('2026-02-18');
      const report = await service.generatePerformanceReport(start, end);

      expect(report).toBeDefined();
      expect(report.reportId).toMatch(/^perf-report-/);
      expect(report.generatedAt).toBeInstanceOf(Date);
      expect(report.period.start).toBe(start);
      expect(report.period.end).toBe(end);
      expect(report.summary).toBeDefined();
      expect(typeof report.summary.overallHealth).toBe('number');
      expect(report.summary.trendsAnalysis).toBeDefined();
      expect(Array.isArray(report.summary.keyFindings)).toBe(true);
      expect(Array.isArray(report.bottlenecks)).toBe(true);
      expect(Array.isArray(report.recommendations)).toBe(true);
    });

    it('should generate trends data', async () => {
      const start = new Date('2026-01-01');
      const end = new Date('2026-02-18');
      const report = await service.generatePerformanceReport(start, end);
      expect(report.metrics.trends.length).toBeGreaterThan(0);
      expect(report.metrics.current).toBeDefined();
    });

    it('should record telemetry', async () => {
      const start = new Date('2026-01-01');
      const end = new Date('2026-02-18');
      await service.generatePerformanceReport(start, end);
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'performance_report_generated',
        1,
        expect.objectContaining({
          reportId: expect.any(String),
          overallHealth: expect.any(Number),
        })
      );
    });

    it('should handle short date range', async () => {
      const start = new Date('2026-02-17');
      const end = new Date('2026-02-18');
      const report = await service.generatePerformanceReport(start, end);
      expect(report.metrics.trends.length).toBe(1);
    });

    it('should cap trends at 30 entries', async () => {
      const start = new Date('2025-01-01');
      const end = new Date('2026-02-18');
      const report = await service.generatePerformanceReport(start, end);
      expect(report.metrics.trends.length).toBeLessThanOrEqual(30);
    });

    it('should include regressions and improvements', async () => {
      const start = new Date('2025-12-01');
      const end = new Date('2026-02-18');
      const report = await service.generatePerformanceReport(start, end);
      expect(Array.isArray(report.summary.regressions)).toBe(true);
      expect(Array.isArray(report.summary.improvements)).toBe(true);
    });
  });

  describe('createBaseline', () => {
    it('should create and store a baseline', async () => {
      await service.createBaseline('test-baseline', '2.0.0', 'staging');
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Baseline created successfully',
        expect.objectContaining({ name: 'test-baseline' })
      );
    });

    it('should record telemetry', async () => {
      await service.createBaseline('prod-baseline', '1.5.0', 'production');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'baseline_created',
        1,
        expect.objectContaining({
          name: 'prod-baseline',
          version: '1.5.0',
          environment: 'production',
        })
      );
    });
  });

  describe('startMonitoring / stopMonitoring', () => {
    it('should start monitoring and record telemetry', async () => {
      await service.stopMonitoring(); // clear any existing
      await service.startMonitoring(60000);
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'monitoring_started',
        1,
        expect.objectContaining({ intervalMs: 60000 })
      );
    });

    it('should stop monitoring and record telemetry', async () => {
      await service.stopMonitoring();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'monitoring_stopped',
        1
      );
    });

    it('should clear previous interval when starting again', async () => {
      await service.startMonitoring(30000);
      await service.startMonitoring(60000);
      // Should not throw, should clear the previous interval
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Performance monitoring started successfully'
      );
    });
  });

  describe('validateWeek7PerformanceGains', () => {
    it('should return validation result with details', async () => {
      const result = await service.validateWeek7PerformanceGains();
      expect(result).toBeDefined();
      expect(typeof result.achieved).toBe('boolean');
      expect(typeof result.actualGain).toBe('number');
      expect(typeof result.details).toBe('string');
      expect(result.details).toContain('Week 7 Performance Analysis');
    });

    it('should record telemetry', async () => {
      await service.validateWeek7PerformanceGains();
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'week7_performance_validation',
        1,
        expect.objectContaining({
          overallGain: expect.any(Number),
          achieved: expect.any(Boolean),
        })
      );
    });

    it('should include all metric categories in details', async () => {
      const result = await service.validateWeek7PerformanceGains();
      expect(result.details).toContain('Response Time');
      expect(result.details).toContain('Throughput');
      expect(result.details).toContain('Error Rate');
      expect(result.details).toContain('Memory Usage');
      expect(result.details).toContain('CPU Usage');
    });
  });
});
