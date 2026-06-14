/**
 * Comprehensive unit tests for PredictiveAnalyticsService
 * Covers: performPredictiveAnalysis with all analysis types,
 *         forecasting, capacity planning, trend analysis, alerts
 */
import 'reflect-metadata';
import { PredictiveAnalyticsService } from '../../../../src/services/ai/PredictiveAnalyticsService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('PredictiveAnalyticsService', () => {
  let service: PredictiveAnalyticsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PredictiveAnalyticsService(mockLogger);
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(service).toBeDefined();
    });
  });

  describe('performPredictiveAnalysis - forecasting', () => {
    it('should return forecasting results', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '30 days',
      });
      expect(result).toBeDefined();
      expect(result.analysisId).toMatch(/^predictive_/);
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.analysisType).toBe('forecasting');
      expect(result.forecastingResults).toBeDefined();
      expect(result.capacityPlanningResults).toBeUndefined();
      expect(result.trendAnalysisResults).toBeUndefined();
    });

    it('should include data volume forecast', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '30 days',
      });
      const forecast = result.forecastingResults!;
      expect(forecast.forecastHorizon).toBe('30 days');
      expect(forecast.dataVolumeForecast).toBeDefined();
      expect(typeof forecast.dataVolumeForecast.currentVolume).toBe('number');
      expect(typeof forecast.dataVolumeForecast.projectedVolume).toBe('number');
      expect(typeof forecast.dataVolumeForecast.growthRate).toBe('number');
      expect(Array.isArray(forecast.dataVolumeForecast.seasonality)).toBe(true);
      expect(Array.isArray(forecast.dataVolumeForecast.peaks)).toBe(true);
      expect(Array.isArray(forecast.dataVolumeForecast.volumeByIntegration)).toBe(true);
    });

    it('should include integration load forecast', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '7 days',
      });
      const forecast = result.forecastingResults!;
      expect(forecast.integrationLoadForecast).toBeDefined();
      expect(typeof forecast.integrationLoadForecast.currentConcurrentJobs).toBe('number');
      expect(typeof forecast.integrationLoadForecast.projectedConcurrentJobs).toBe('number');
      expect(Array.isArray(forecast.integrationLoadForecast.loadDistribution)).toBe(true);
      expect(Array.isArray(forecast.integrationLoadForecast.bottlenecks)).toBe(true);
      expect(Array.isArray(forecast.integrationLoadForecast.scalingRecommendations)).toBe(true);
    });

    it('should include performance forecast', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '14 days',
      });
      const forecast = result.forecastingResults!;
      expect(forecast.performanceForecast).toBeDefined();
      expect(forecast.performanceForecast.currentLatency).toBeDefined();
      expect(forecast.performanceForecast.projectedLatency).toBeDefined();
      expect(typeof forecast.performanceForecast.currentLatency.avgLatency).toBe('number');
      expect(typeof forecast.performanceForecast.currentLatency.throughput).toBe('number');
    });

    it('should include risk forecast', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '30 days',
      });
      const forecast = result.forecastingResults!;
      expect(forecast.riskForecast).toBeDefined();
    });
  });

  describe('performPredictiveAnalysis - capacity-planning', () => {
    it('should return capacity planning results', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '6 months',
      });
      expect(result.capacityPlanningResults).toBeDefined();
      expect(result.forecastingResults).toBeUndefined();
      expect(result.trendAnalysisResults).toBeUndefined();
    });

    it('should include current capacity metrics', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '3 months',
      });
      const capacity = result.capacityPlanningResults!;
      expect(capacity.currentCapacity).toBeDefined();
      expect(typeof capacity.currentCapacity.cpuUtilization).toBe('number');
      expect(typeof capacity.currentCapacity.memoryUtilization).toBe('number');
      expect(typeof capacity.currentCapacity.networkUtilization).toBe('number');
      expect(typeof capacity.currentCapacity.storageUtilization).toBe('number');
    });

    it('should include projected demand', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '3 months',
      });
      const capacity = result.capacityPlanningResults!;
      expect(capacity.projectedDemand).toBeDefined();
      expect(typeof capacity.projectedDemand.projectedGrowth).toBe('number');
      expect(Array.isArray(capacity.projectedDemand.scenarios)).toBe(true);
    });

    it('should include capacity gaps', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '3 months',
      });
      const capacity = result.capacityPlanningResults!;
      expect(Array.isArray(capacity.capacityGaps)).toBe(true);
      for (const gap of capacity.capacityGaps) {
        expect(gap.resource).toBeDefined();
        expect(typeof gap.currentCapacity).toBe('number');
        expect(typeof gap.projectedDemand).toBe('number');
        expect(typeof gap.gap).toBe('number');
        expect(['low', 'medium', 'high', 'critical']).toContain(gap.urgency);
      }
    });

    it('should include scaling plan', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '6 months',
      });
      const capacity = result.capacityPlanningResults!;
      expect(capacity.scalingPlan).toBeDefined();
      expect(Array.isArray(capacity.scalingPlan.phases)).toBe(true);
      expect(typeof capacity.scalingPlan.totalCost).toBe('number');
    });

    it('should include cost projections', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'capacity-planning',
        timeHorizon: '3 months',
      });
      const capacity = result.capacityPlanningResults!;
      expect(capacity.costProjections).toBeDefined();
      expect(typeof capacity.costProjections.currentMonthlyCost).toBe('number');
      expect(typeof capacity.costProjections.projectedMonthlyCost).toBe('number');
    });
  });

  describe('performPredictiveAnalysis - trend-analysis', () => {
    it('should return trend analysis results', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'trend-analysis',
        timeHorizon: '90 days',
      });
      expect(result.trendAnalysisResults).toBeDefined();
      expect(result.forecastingResults).toBeUndefined();
      expect(result.capacityPlanningResults).toBeUndefined();
    });

    it('should include data trends', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'trend-analysis',
        timeHorizon: '30 days',
      });
      const trends = result.trendAnalysisResults!;
      expect(Array.isArray(trends.dataTrends)).toBe(true);
      expect(Array.isArray(trends.usageTrends)).toBe(true);
      expect(Array.isArray(trends.performanceTrends)).toBe(true);
      expect(Array.isArray(trends.errorTrends)).toBe(true);
      expect(Array.isArray(trends.seasonalPatterns)).toBe(true);
      expect(Array.isArray(trends.anomalies)).toBe(true);
    });
  });

  describe('performPredictiveAnalysis - comprehensive', () => {
    it('should include all three analysis types', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'comprehensive',
        timeHorizon: '30 days',
      });
      expect(result.forecastingResults).toBeDefined();
      expect(result.capacityPlanningResults).toBeDefined();
      expect(result.trendAnalysisResults).toBeDefined();
    });

    it('should generate recommendations', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'comprehensive',
        timeHorizon: '30 days',
      });
      expect(Array.isArray(result.recommendations)).toBe(true);
      for (const rec of result.recommendations) {
        expect(rec.recommendationId).toBeDefined();
        expect(['scaling', 'optimization', 'maintenance', 'risk-mitigation', 'cost-reduction']).toContain(rec.type);
        expect(['low', 'medium', 'high', 'critical']).toContain(rec.priority);
        expect(rec.title).toBeDefined();
        expect(rec.description).toBeDefined();
        expect(typeof rec.costImpact).toBe('number');
        expect(typeof rec.riskReduction).toBe('number');
        expect(Array.isArray(rec.actions)).toBe(true);
      }
    });

    it('should include alerts when requested', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'comprehensive',
        timeHorizon: '30 days',
        includeAlerts: true,
      });
      expect(Array.isArray(result.alerts)).toBe(true);
      for (const alert of result.alerts) {
        expect(alert.alertId).toBeDefined();
        expect(['info', 'warning', 'critical', 'emergency']).toContain(alert.severity);
        expect(['capacity', 'performance', 'reliability', 'cost', 'security']).toContain(alert.category);
        expect(alert.title).toBeDefined();
        expect(typeof alert.confidence).toBe('number');
      }
    });

    it('should not include alerts when not requested', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'comprehensive',
        timeHorizon: '30 days',
        includeAlerts: false,
      });
      expect(result.alerts.length).toBe(0);
    });
  });

  describe('metadata', () => {
    it('should include metadata in all results', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '30 days',
      });
      expect(result.metadata).toBeDefined();
      expect(result.metadata.sessionId).toBeDefined();
      expect(typeof result.metadata.analysisTime).toBe('number');
      expect(typeof result.metadata.dataPoints).toBe('number');
      expect(typeof result.metadata.confidence).toBe('number');
      expect(result.metadata.version).toBeDefined();
      expect(Array.isArray(result.metadata.limitations)).toBe(true);
    });

    it('should have confidence value', async () => {
      const result = await service.performPredictiveAnalysis({
        analysisType: 'forecasting',
        timeHorizon: '7 days',
      });
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });

  describe('logging', () => {
    it('should log analysis start and completion', async () => {
      await service.performPredictiveAnalysis({
        analysisType: 'trend-analysis',
        timeHorizon: '14 days',
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Starting predictive analysis',
        expect.objectContaining({
          analysisType: 'trend-analysis',
          timeHorizon: '14 days',
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Predictive analysis completed',
        expect.objectContaining({
          analysisType: 'trend-analysis',
          recommendationsCount: expect.any(Number),
          alertsCount: expect.any(Number),
        })
      );
    });
  });
});
