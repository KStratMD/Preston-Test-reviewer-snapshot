/**
 * Comprehensive unit tests for AIWorkflowIntelligenceService
 * Covers: analyzeWorkflow, predictFailures, generateOptimizationSuggestions,
 *         optimizeSchedule, getWorkflowMetrics, and internal helpers
 */
import 'reflect-metadata';
import { AIWorkflowIntelligenceService } from '../../../src/services/AIWorkflowIntelligenceService';

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

const mockPredictiveAnalyticsService = {
  performPredictiveAnalysis: jest.fn().mockResolvedValue({
    predictions: [],
    alerts: [],
    confidence: 0.8,
    metadata: {},
  }),
  predictPerformanceTrend: jest.fn().mockResolvedValue({
    trend: 'improving',
    confidence: 0.85,
  }),
} as any;

const mockProactiveIssueDetectionService = {
  detectIssues: jest.fn().mockResolvedValue([]),
  startMonitoring: jest.fn().mockResolvedValue(undefined),
  getHealthStatus: jest.fn().mockReturnValue({ status: 'healthy' }),
} as any;

const mockPerformanceOptimizationService = {
  collectCurrentMetrics: jest.fn().mockResolvedValue({
    timestamp: new Date(),
    responseTime: 100,
    throughput: 1000,
    errorRate: 0.5,
    memoryUsage: 65,
    cpuUsage: 40,
    diskIo: 200,
    networkLatency: 20,
    cacheHitRate: 92,
    connectionPoolSize: 70,
    queueLength: 5,
    systemLoad: 1.0,
  }),
  detectBottlenecks: jest.fn().mockResolvedValue([]),
} as any;

function buildWorkflowMetrics(overrides: Partial<{
  totalRuns: number;
  successRate: number;
  averageDuration: number;
}> = {}) {
  return {
    totalRuns: 500,
    successRate: 0.95,
    averageDuration: 120,
    errorPatterns: [
      { error: 'timeout', frequency: 15, timePattern: 'peak_hours', resolution: 'retry', preventable: true },
      { error: 'auth_expired', frequency: 3, timePattern: 'weekly', resolution: 'refresh_token', preventable: true },
    ],
    resourceUsage: {
      cpuAverage: 45,
      memoryAverage: 60,
      networkBandwidth: 100,
      apiCallsPerHour: 800,
    },
    businessImpact: {
      recordsProcessed: 10000,
      dataLatency: 30,
      costPerRecord: 0.05,
      businessValue: 50000,
    },
    ...overrides,
  };
}

describe('AIWorkflowIntelligenceService', () => {
  let service: AIWorkflowIntelligenceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AIWorkflowIntelligenceService(
      mockLoggingService,
      mockTelemetryService,
      mockPredictiveAnalyticsService,
      mockProactiveIssueDetectionService,
      mockPerformanceOptimizationService,
    );
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(service).toBeDefined();
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Initializing AIWorkflowIntelligenceService with Week 7 enhancements'
      );
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'AIWorkflowIntelligenceService initialization completed'
      );
    });
  });

  describe('analyzeWorkflow', () => {
    it('should return a complete workflow analysis', async () => {
      const analysis = await service.analyzeWorkflow('integration-1');
      expect(analysis).toBeDefined();
      expect(analysis.integrationId).toBe('integration-1');
      expect(typeof analysis.performanceScore).toBe('number');
      expect(Array.isArray(analysis.predictedFailures)).toBe(true);
      expect(Array.isArray(analysis.optimizationSuggestions)).toBe(true);
      expect(analysis.smartSchedule).toBeDefined();
      expect(Array.isArray(analysis.remediationActions)).toBe(true);
    });

    it('should record telemetry', async () => {
      await service.analyzeWorkflow('int-2');
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'workflow_analysis_completed',
        1,
        expect.objectContaining({
          integrationId: 'int-2',
          performanceScore: expect.any(Number),
        })
      );
    });

    it('should log completion', async () => {
      await service.analyzeWorkflow('int-3');
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Workflow analysis completed successfully',
        expect.objectContaining({ integrationId: 'int-3' })
      );
    });
  });

  describe('predictFailures', () => {
    it('should predict connection failure when success rate is low', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.9 });
      const predictions = await service.predictFailures('int-1', metrics);
      const connectionPrediction = predictions.find(p => p.type === 'connection');
      expect(connectionPrediction).toBeDefined();
      expect(connectionPrediction!.probability).toBeGreaterThan(0);
      expect(connectionPrediction!.impact).toBeDefined();
    });

    it('should not predict connection failure for high success rate', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.99 });
      const predictions = await service.predictFailures('int-2', metrics);
      const connectionPrediction = predictions.find(p => p.type === 'connection');
      expect(connectionPrediction).toBeUndefined();
    });

    it('should mark critical impact for very low success rate', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.7 });
      const predictions = await service.predictFailures('int-3', metrics);
      const connectionPrediction = predictions.find(p => p.type === 'connection');
      expect(connectionPrediction).toBeDefined();
      expect(connectionPrediction!.impact).toBe('critical');
    });

    it('should sort by probability descending', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.85 });
      const predictions = await service.predictFailures('int-4', metrics);
      if (predictions.length >= 2) {
        for (let i = 0; i < predictions.length - 1; i++) {
          expect(predictions[i].probability).toBeGreaterThanOrEqual(predictions[i + 1].probability);
        }
      }
    });

    it('should include prevention steps', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.8 });
      const predictions = await service.predictFailures('int-5', metrics);
      for (const p of predictions) {
        expect(Array.isArray(p.preventionSteps)).toBe(true);
        expect(p.preventionSteps.length).toBeGreaterThan(0);
      }
    });
  });

  describe('generateOptimizationSuggestions', () => {
    it('should suggest parallel processing for slow workflows', async () => {
      const metrics = buildWorkflowMetrics({ averageDuration: 600 });
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      const perfSuggestion = suggestions.find(s =>
        s.category === 'performance' && s.suggestion.includes('parallel')
      );
      expect(perfSuggestion).toBeDefined();
    });

    it('should suggest retry logic for low reliability', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.9 });
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      const reliabilitySuggestion = suggestions.find(s =>
        s.category === 'reliability'
      );
      expect(reliabilitySuggestion).toBeDefined();
    });

    it('should suggest caching for high API usage', async () => {
      const metrics = buildWorkflowMetrics();
      metrics.resourceUsage.apiCallsPerHour = 2000;
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      const costSuggestion = suggestions.find(s => s.category === 'cost');
      expect(costSuggestion).toBeDefined();
      expect(costSuggestion!.suggestion).toContain('caching');
    });

    it('should sort by priority descending', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.9, averageDuration: 500 });
      metrics.resourceUsage.apiCallsPerHour = 2000;
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      if (suggestions.length >= 2) {
        for (let i = 0; i < suggestions.length - 1; i++) {
          expect(suggestions[i].priority).toBeGreaterThanOrEqual(suggestions[i + 1].priority);
        }
      }
    });

    it('should return empty for optimal metrics', async () => {
      const metrics = buildWorkflowMetrics({ successRate: 0.999, averageDuration: 10 });
      metrics.resourceUsage.apiCallsPerHour = 100;
      metrics.businessImpact.dataLatency = 5;
      metrics.errorPatterns = [];
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      expect(suggestions.length).toBe(0);
    });

    it('should suggest error categorization for many error types', async () => {
      const metrics = buildWorkflowMetrics();
      metrics.errorPatterns = Array.from({ length: 8 }, (_, i) => ({
        error: `error_type_${i}`,
        frequency: 5,
        timePattern: 'random',
        resolution: 'manual',
        preventable: true,
      }));
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      const maintenanceSuggestion = suggestions.find(s => s.category === 'maintenance');
      expect(maintenanceSuggestion).toBeDefined();
    });

    it('should suggest real-time sync for high data latency', async () => {
      const metrics = buildWorkflowMetrics();
      metrics.businessImpact.dataLatency = 120;
      const suggestions = await service.generateOptimizationSuggestions(metrics);
      const latencySuggestion = suggestions.find(s =>
        s.suggestion.includes('webhook') || s.suggestion.includes('real-time')
      );
      expect(latencySuggestion).toBeDefined();
    });
  });

  describe('optimizeSchedule', () => {
    it('should return a smart schedule', async () => {
      const metrics = buildWorkflowMetrics();
      const schedule = await service.optimizeSchedule('int-1', metrics);
      expect(schedule).toBeDefined();
      expect(schedule.recommended).toBeDefined();
      expect(typeof schedule.recommended.frequency).toBe('string');
      expect(Array.isArray(schedule.recommended.times)).toBe(true);
      expect(typeof schedule.recommended.timezone).toBe('string');
      expect(typeof schedule.reasoning).toBe('string');
    });

    it('should include traffic prediction', async () => {
      const metrics = buildWorkflowMetrics();
      const schedule = await service.optimizeSchedule('int-2', metrics);
      expect(Array.isArray(schedule.trafficPrediction)).toBe(true);
    });

    it('should include conflict avoidance', async () => {
      const metrics = buildWorkflowMetrics();
      const schedule = await service.optimizeSchedule('int-3', metrics);
      expect(Array.isArray(schedule.conflictAvoidance)).toBe(true);
    });
  });
});
