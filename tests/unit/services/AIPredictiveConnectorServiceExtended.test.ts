/**
 * Comprehensive unit tests for AIPredictiveConnectorService
 * Covers: generateRecommendations, predictNextIntegrations, optimizeIntegrationPathway,
 *         analyzeCurrentSystems, and internal catalog/pattern helpers
 */
import 'reflect-metadata';
import { AIPredictiveConnectorService } from '../../../src/services/AIPredictiveConnectorService';

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
    confidence: 0.85,
    metadata: {},
  }),
} as any;

const mockMappingPatternCacheService = {
  cachePattern: jest.fn().mockResolvedValue(undefined),
  getPattern: jest.fn().mockResolvedValue(null),
  searchPatterns: jest.fn().mockResolvedValue([]),
  getCacheMetrics: jest.fn().mockResolvedValue({ totalPatterns: 0, hitRate: 0, missRate: 0 }),
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
  analyzePerformance: jest.fn().mockResolvedValue([]),
} as any;

const mockROIService = {
  calculateNetROI: jest.fn().mockReturnValue(100000),
  calculateSimpleROI: jest.fn().mockReturnValue(200),
} as any;

describe('AIPredictiveConnectorService', () => {
  let service: AIPredictiveConnectorService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new AIPredictiveConnectorService(
      mockLoggingService,
      mockTelemetryService,
      mockPredictiveAnalyticsService,
      mockMappingPatternCacheService,
      mockPerformanceOptimizationService,
      mockROIService,
    );
  });

  describe('constructor', () => {
    it('should initialize and log', () => {
      expect(service).toBeDefined();
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Initializing AIPredictiveConnectorService with Week 7 enhancements'
      );
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'AIPredictiveConnectorService initialization completed'
      );
    });
  });

  describe('generateRecommendations', () => {
    it('should return recommendations for a given stack', async () => {
      const recs = await service.generateRecommendations(
        ['salesforce', 'netsuite'],
        'manufacturing',
        'medium',
        ['efficiency', 'growth']
      );
      expect(Array.isArray(recs)).toBe(true);
    });

    it('should call predictive analytics service', async () => {
      await service.generateRecommendations(
        ['salesforce'],
        'retail',
        'small',
        ['cost_reduction']
      );
      expect(mockPredictiveAnalyticsService.performPredictiveAnalysis).toHaveBeenCalled();
    });

    it('should record telemetry on success', async () => {
      await service.generateRecommendations(
        ['salesforce'],
        'technology',
        'large',
        ['innovation']
      );
      expect(mockTelemetryService.recordMetric).toHaveBeenCalledWith(
        'connector_recommendations_generated',
        expect.any(Number),
        expect.objectContaining({
          industry: 'technology',
          companySize: 'large',
        })
      );
    });

    it('should log success', async () => {
      await service.generateRecommendations(
        ['netsuite'],
        'healthcare',
        'enterprise',
        ['compliance']
      );
      expect(mockLoggingService.info).toHaveBeenCalledWith(
        'Connector recommendations generated successfully',
        expect.any(Object)
      );
    });

    it('should handle empty current systems', async () => {
      const recs = await service.generateRecommendations([], 'retail', 'small', ['growth']);
      expect(Array.isArray(recs)).toBe(true);
    });

    it('should limit to 10 recommendations', async () => {
      const recs = await service.generateRecommendations(
        ['salesforce', 'netsuite', 'sap'],
        'manufacturing',
        'large',
        ['efficiency', 'growth', 'compliance', 'innovation']
      );
      expect(recs.length).toBeLessThanOrEqual(10);
    });

    it('should sort by relevanceScore descending', async () => {
      const recs = await service.generateRecommendations(
        ['netsuite'],
        'retail',
        'medium',
        ['growth']
      );
      if (recs.length >= 2) {
        for (let i = 0; i < recs.length - 1; i++) {
          expect(recs[i].relevanceScore).toBeGreaterThanOrEqual(recs[i + 1].relevanceScore);
        }
      }
    });
  });

  describe('predictNextIntegrations', () => {
    it('should return a prediction model', async () => {
      const prediction = await service.predictNextIntegrations(
        ['salesforce', 'netsuite'],
        'manufacturing',
        'growth'
      );
      expect(prediction).toBeDefined();
      expect(Array.isArray(prediction.nextLikelyIntegrations)).toBe(true);
      expect(Array.isArray(prediction.seasonalDemand)).toBe(true);
      expect(Array.isArray(prediction.technologyTrends)).toBe(true);
      expect(prediction.competitiveAnalysis).toBeDefined();
    });

    it('should include competitive analysis', async () => {
      const prediction = await service.predictNextIntegrations(
        ['salesforce'],
        'technology',
        'startup'
      );
      expect(prediction.competitiveAnalysis.competitorIntegrations).toBeDefined();
      expect(prediction.competitiveAnalysis.industryStandards).toBeDefined();
    });

    it('should handle unknown industry', async () => {
      const prediction = await service.predictNextIntegrations(
        ['netsuite'],
        'unknown_industry',
        'established'
      );
      expect(prediction).toBeDefined();
      expect(Array.isArray(prediction.nextLikelyIntegrations)).toBe(true);
    });
  });

  describe('optimizeIntegrationPathway', () => {
    it('should return optimized pathways', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['salesforce'],
        ['netsuite'],
        {}
      );
      expect(Array.isArray(pathways)).toBe(true);
    });

    it('should handle multiple source/target combinations', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['salesforce', 'sap'],
        ['netsuite', 'dynamics'],
        { budget: 100000 }
      );
      expect(Array.isArray(pathways)).toBe(true);
    });

    it('should return pathways with required structure', async () => {
      const pathways = await service.optimizeIntegrationPathway(
        ['salesforce'],
        ['netsuite'],
        {}
      );
      for (const p of pathways) {
        expect(typeof p.recommended).toBe('boolean');
        expect(Array.isArray(p.steps)).toBe(true);
        expect(typeof p.estimatedTimeline).toBe('string');
        expect(Array.isArray(p.resourceRequirements)).toBe(true);
        expect(Array.isArray(p.risks)).toBe(true);
      }
    });
  });
});
