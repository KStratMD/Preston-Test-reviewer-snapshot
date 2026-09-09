/**
 * AIBusinessIntelligenceService Tests
 * Tests for ROI prediction, performance optimization, and usage pattern analysis
 */

import { AIBusinessIntelligenceService } from '../../../src/services/AIBusinessIntelligenceService';

describe('AIBusinessIntelligenceService', () => {
  let service: AIBusinessIntelligenceService;
  let mockROIService: any;

  beforeEach(() => {
    mockROIService = {
      calculateSimpleROI: jest.fn().mockReturnValue(150),
    };

    service = new AIBusinessIntelligenceService(mockROIService);
  });

  describe('generateBusinessInsights', () => {
    it('should return array of business insights', async () => {
      const insights = await service.generateBusinessInsights();

      expect(Array.isArray(insights)).toBe(true);
    });

    it('should include insights from multiple categories', async () => {
      const insights = await service.generateBusinessInsights();

      const categories = new Set(insights.map(i => i.category));
      expect(categories.size).toBeGreaterThan(0);
    });

    it('should sort insights by confidence descending', async () => {
      const insights = await service.generateBusinessInsights();

      for (let i = 1; i < insights.length; i++) {
        expect(insights[i - 1].confidence).toBeGreaterThanOrEqual(insights[i].confidence);
      }
    });

    it('should include recommendations with each insight', async () => {
      const insights = await service.generateBusinessInsights();

      insights.forEach(insight => {
        expect(insight.recommendations).toBeDefined();
        expect(Array.isArray(insight.recommendations)).toBe(true);
      });
    });

    it('should include KPI and trend for each insight', async () => {
      const insights = await service.generateBusinessInsights();

      insights.forEach(insight => {
        expect(insight.kpi).toBeDefined();
        expect(['improving', 'declining', 'stable']).toContain(insight.trend);
      });
    });
  });

  describe('predictROI', () => {
    it('should return ROI prediction for integration', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.integrationId).toBe('integration-1');
      expect(prediction.currentROI).toBeDefined();
      expect(prediction.predictedROI).toBeDefined();
    });

    it('should include multi-timeframe predictions', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.predictedROI.month1).toBeDefined();
      expect(prediction.predictedROI.month3).toBeDefined();
      expect(prediction.predictedROI.month6).toBeDefined();
      expect(prediction.predictedROI.year1).toBeDefined();
    });

    it('should show increasing ROI over time', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.predictedROI.month3).toBeGreaterThan(prediction.predictedROI.month1);
      expect(prediction.predictedROI.month6).toBeGreaterThan(prediction.predictedROI.month3);
      expect(prediction.predictedROI.year1).toBeGreaterThan(prediction.predictedROI.month6);
    });

    it('should identify ROI factors', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.factors).toBeDefined();
      expect(prediction.factors.length).toBeGreaterThan(0);

      prediction.factors.forEach(factor => {
        expect(factor.factor).toBeDefined();
        expect(factor.weight).toBeDefined();
        expect(factor.impact).toBeDefined();
        expect(typeof factor.controllable).toBe('boolean');
      });
    });

    it('should include factor weights that sum to 1', async () => {
      const prediction = await service.predictROI('integration-1');

      const totalWeight = prediction.factors.reduce((sum, f) => sum + f.weight, 0);
      expect(totalWeight).toBeCloseTo(1, 2);
    });

    it('should generate ROI scenarios', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.scenarios).toBeDefined();
      expect(prediction.scenarios.length).toBe(3);

      const scenarioNames = prediction.scenarios.map(s => s.name);
      expect(scenarioNames).toContain('conservative');
      expect(scenarioNames).toContain('realistic');
      expect(scenarioNames).toContain('optimistic');
    });

    it('should have optimistic scenario with highest ROI', async () => {
      const prediction = await service.predictROI('integration-1');

      const optimistic = prediction.scenarios.find(s => s.name === 'optimistic');
      const conservative = prediction.scenarios.find(s => s.name === 'conservative');

      expect(optimistic!.projectedROI).toBeGreaterThan(conservative!.projectedROI);
    });

    it('should calculate break-even point', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.breakEvenPoint).toBeDefined();
      expect(prediction.breakEvenPoint).toContain('month');
    });

    it('should include recommendations', async () => {
      const prediction = await service.predictROI('integration-1');

      expect(prediction.recommendations).toBeDefined();
      expect(prediction.recommendations.length).toBeGreaterThan(0);
    });

    it('should use ROI service for calculations', async () => {
      await service.predictROI('integration-1');

      expect(mockROIService.calculateSimpleROI).toHaveBeenCalled();
    });
  });

  describe('analyzeUsagePatterns', () => {
    it('should return usage patterns array', async () => {
      const patterns = await service.analyzeUsagePatterns();

      expect(Array.isArray(patterns)).toBe(true);
    });

    it('should analyze specific integration when provided', async () => {
      const patterns = await service.analyzeUsagePatterns('integration-1');

      expect(Array.isArray(patterns)).toBe(true);
    });

    it('should include pattern details', async () => {
      const patterns = await service.analyzeUsagePatterns();

      patterns.forEach(pattern => {
        expect(pattern.pattern).toBeDefined();
        expect(pattern.frequency).toBeDefined();
        expect(['increasing', 'decreasing', 'stable']).toContain(pattern.trend);
        expect(pattern.business_impact).toBeDefined();
        expect(pattern.optimization_potential).toBeDefined();
      });
    });

    it('should filter patterns by optimization potential', async () => {
      const patterns = await service.analyzeUsagePatterns();

      // All returned patterns should have optimization_potential > 0.2
      patterns.forEach(pattern => {
        expect(pattern.optimization_potential).toBeGreaterThan(0.2);
      });
    });

    it('should filter patterns by minimum frequency', async () => {
      const patterns = await service.analyzeUsagePatterns();

      // Patterns are filtered by frequency > 0.05 or 0.1 depending on type
      patterns.forEach(pattern => {
        expect(pattern.frequency).toBeGreaterThan(0.05);
      });
    });

    it('should include seasonality data', async () => {
      const patterns = await service.analyzeUsagePatterns();

      const patternsWithSeasonality = patterns.filter(p => p.seasonality && p.seasonality.length > 0);
      expect(patternsWithSeasonality.length).toBeGreaterThan(0);

      patternsWithSeasonality.forEach(pattern => {
        pattern.seasonality.forEach(seasonal => {
          expect(seasonal.period).toBeDefined();
          expect(seasonal.multiplier).toBeDefined();
          expect(seasonal.confidence).toBeDefined();
        });
      });
    });
  });

  describe('generatePerformanceOptimizations', () => {
    it('should return performance optimizations array', async () => {
      const optimizations = await service.generatePerformanceOptimizations();

      expect(Array.isArray(optimizations)).toBe(true);
    });

    it('should sort optimizations by business impact descending', async () => {
      const optimizations = await service.generatePerformanceOptimizations();

      for (let i = 1; i < optimizations.length; i++) {
        expect(optimizations[i - 1].businessImpact).toBeGreaterThanOrEqual(optimizations[i].businessImpact);
      }
    });

    it('should include optimization details', async () => {
      const optimizations = await service.generatePerformanceOptimizations();

      optimizations.forEach(opt => {
        expect(opt.area).toBeDefined();
        expect(opt.currentPerformance).toBeDefined();
        expect(opt.potentialImprovement).toBeDefined();
        expect(['low', 'medium', 'high']).toContain(opt.implementationEffort);
        expect(opt.expectedTimeframe).toBeDefined();
        expect(opt.businessImpact).toBeDefined();
      });
    });

    it('should include technical requirements', async () => {
      const optimizations = await service.generatePerformanceOptimizations();

      optimizations.forEach(opt => {
        expect(opt.technicalRequirements).toBeDefined();
        expect(Array.isArray(opt.technicalRequirements)).toBe(true);
      });
    });
  });

  describe('generatePredictiveAnalytics', () => {
    it('should return predictive analytics for integration', async () => {
      const analytics = await service.generatePredictiveAnalytics('integration-1');

      expect(Array.isArray(analytics)).toBe(true);
      expect(analytics.length).toBeGreaterThan(0);
    });

    it('should include multiple metrics', async () => {
      const analytics = await service.generatePredictiveAnalytics('integration-1');

      const metrics = analytics.map(a => a.metric);
      expect(metrics).toContain('recordsProcessed');
      expect(metrics).toContain('errorRate');
      expect(metrics).toContain('processingTime');
      expect(metrics).toContain('businessValue');
    });

    it('should include multi-timeframe predictions', async () => {
      const analytics = await service.generatePredictiveAnalytics('integration-1');

      analytics.forEach(analytic => {
        expect(analytic.predictions.next7Days).toBeDefined();
        expect(analytic.predictions.next30Days).toBeDefined();
        expect(analytic.predictions.next90Days).toBeDefined();
      });
    });

    it('should include trend analysis', async () => {
      const analytics = await service.generatePredictiveAnalytics('integration-1');

      analytics.forEach(analytic => {
        expect(analytic.trendAnalysis).toBeDefined();
        expect(['up', 'down', 'stable']).toContain(analytic.trendAnalysis.direction);
        expect(analytic.trendAnalysis.strength).toBeDefined();
        expect(typeof analytic.trendAnalysis.seasonalComponent).toBe('boolean');
      });
    });

    it('should include confidence scores', async () => {
      const analytics = await service.generatePredictiveAnalytics('integration-1');

      analytics.forEach(analytic => {
        expect(analytic.confidence).toBeDefined();
        expect(analytic.confidence).toBeGreaterThan(0);
        expect(analytic.confidence).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('insight categories', () => {
    it('should generate performance insights', async () => {
      const insights = await service.generateBusinessInsights();
      const performanceInsights = insights.filter(i => i.category === 'performance');

      performanceInsights.forEach(insight => {
        expect(insight.kpi).toBeDefined();
        expect(insight.timeframe).toBeDefined();
      });
    });

    it('should generate cost insights', async () => {
      const insights = await service.generateBusinessInsights();
      const costInsights = insights.filter(i => i.category === 'cost');

      costInsights.forEach(insight => {
        expect(insight.data).toBeDefined();
      });
    });

    it('should generate risk insights', async () => {
      const insights = await service.generateBusinessInsights();
      const riskInsights = insights.filter(i => i.category === 'risk');

      riskInsights.forEach(insight => {
        expect(['low', 'medium', 'high', 'critical']).toContain(insight.impact);
      });
    });
  });

  describe('data validation', () => {
    it('should handle missing integration metrics gracefully', async () => {
      const prediction = await service.predictROI('non-existent-integration');

      expect(prediction).toBeDefined();
      expect(prediction.currentROI).toBeDefined();
    });

    it('should return valid confidence values', async () => {
      const insights = await service.generateBusinessInsights();

      insights.forEach(insight => {
        expect(insight.confidence).toBeGreaterThan(0);
        expect(insight.confidence).toBeLessThanOrEqual(1);
      });
    });

    it('should return valid impact values', async () => {
      const insights = await service.generateBusinessInsights();

      const validImpacts = ['low', 'medium', 'high', 'critical'];
      insights.forEach(insight => {
        expect(validImpacts).toContain(insight.impact);
      });
    });
  });
});
