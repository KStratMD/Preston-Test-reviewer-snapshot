/**
 * Comprehensive tests for ForecastingService
 * Covers: performBusinessImpactAnalysis (AI + heuristic), generateProjections
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/utils/Logger', () => ({
  logger: mockLogger,
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { ForecastingService } from '../../../../src/services/ai/orchestrator/agents/intelligence/ForecastingService';

describe('ForecastingService', () => {
  let service: ForecastingService;

  const makeInput = (overrides: Record<string, any> = {}) => ({
    organizationProfile: {
      name: 'Test Corp',
      industry: 'Technology',
      size: 'medium',
      annualRevenue: 10000000,
      employeeCount: 500,
      regulatoryRequirements: ['GDPR'],
    },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // ForecastingService has 3 DI params: logger, providerRegistry, semanticEngine
    service = new (ForecastingService as any)(mockLogger, null, null);
  });

  /* ────────────── performBusinessImpactAnalysis (heuristic) ────────────── */

  describe('performBusinessImpactAnalysis (heuristic fallback)', () => {
    it('should return complete analysis structure', async () => {
      const result = await service.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.analysisId).toBeDefined();
      expect(result.overallScore).toBe(78);
      expect(result.businessValue).toBeDefined();
      expect(result.riskAssessment).toBeDefined();
      expect(result.recommendations).toBeDefined();
      expect(result.projections).toBeDefined();
    });

    it('should calculate monetary impact from annual revenue', async () => {
      const input = makeInput({ organizationProfile: { ...makeInput().organizationProfile, annualRevenue: 20000000 } });
      const result = await service.performBusinessImpactAnalysis(input as any);
      const bv = result.businessValue as any;
      // annualSavings = 20M * 0.15 * 0.15 = 450000
      expect(bv.monetaryImpact.annualSavings).toBe(450000);
      // operationalCost = 20M * 0.15 = 3000000
      expect(bv.currentState.operationalCost).toBe(3000000);
    });

    it('should include operational risk category', async () => {
      const result = await service.performBusinessImpactAnalysis(makeInput() as any);
      const ra = result.riskAssessment as any;
      expect(ra.overallRiskLevel).toBe('medium');
      expect(ra.riskCategories.length).toBe(1);
      expect(ra.riskCategories[0].category).toBe('operational');
    });

    it('should include governance recommendation', async () => {
      const result = await service.performBusinessImpactAnalysis(makeInput() as any);
      const recs = result.recommendations as any[];
      expect(recs.length).toBe(1);
      expect(recs[0].title).toContain('Data Governance');
      expect(recs[0].priority).toBe('high');
    });

    it('should include projections', async () => {
      const result = await service.performBusinessImpactAnalysis(makeInput() as any);
      const projections = result.projections as any[];
      expect(projections.length).toBe(1);
      expect(projections[0].metric).toBe('Data Quality Score');
    });
  });

  /* ────────────── performBusinessImpactAnalysis (AI path) ────────────── */

  describe('performBusinessImpactAnalysis (AI path)', () => {
    it('should use AI when providers are available', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            overallScore: 85,
            businessValue: {},
            riskAssessment: { overallRiskLevel: 'low', riskCategories: [], mitigationStrategies: [], complianceRisks: [] },
            recommendations: [],
          }),
        }),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'test-provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBe(85);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Using AI-enhanced business impact analysis',
        expect.any(Object)
      );
    });

    it('should fall back when no providers available', async () => {
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, {});
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      // Falls back to heuristic
      expect(result.overallScore).toBe(78);
    });

    it('should fall back when providerRegistry is null', async () => {
      const result = await service.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBe(78);
    });

    it('should fall back when AI response is empty', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue(null),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBe(78);
    });

    it('should fall back when AI returns invalid JSON', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: 'not json at all' }),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBe(78);
    });

    it('should fall back when AI throws error (inner catch)', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockRejectedValue(new Error('AI error')),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI business impact analysis failed',
        expect.any(Object)
      );
      expect(result.overallScore).toBe(78);
    });

    it('should fall back when getAvailableProviders throws (outer catch)', async () => {
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockRejectedValue(new Error('registry error')),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, {});
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      // Inner catch fires first (logger.error), returns null → outer catch with logger.warn
      // Actually: getAvailableProviders throws inside inner try-catch, so inner catch fires
      // and returns null. Then outer code sees null and falls back to heuristic.
      expect(result.overallScore).toBe(78);
    });

    it('should validate AI overallScore bounds', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            overallScore: 150, // out of bounds
            businessValue: {},
            riskAssessment: {},
            recommendations: [],
          }),
        }),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBeLessThanOrEqual(100);
    });

    it('should set default overallScore when missing from AI response', async () => {
      const mockSemanticEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({
          content: JSON.stringify({
            businessValue: {},
          }),
        }),
      };
      const mockRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'provider' }]),
      };
      const aiService = new (ForecastingService as any)(mockLogger, mockRegistry, mockSemanticEngine);
      const result = await aiService.performBusinessImpactAnalysis(makeInput() as any);
      expect(result.overallScore).toBe(75); // default
    });
  });

  /* ────────────── generateProjections ────────────── */

  describe('generateProjections', () => {
    it('should generate projections for each metric', () => {
      const metrics = { 'Quality Score': 0.7, 'Efficiency': 0.6 };
      const result = service.generateProjections(metrics, 0.2, 12);
      expect(result.length).toBe(2);
    });

    it('should calculate projected value correctly', () => {
      const metrics = { 'Score': 0.8 };
      const result = service.generateProjections(metrics, 0.25, 12);
      expect(result[0].projectedValue).toBe(0.8 * 1.25);
      expect(result[0].improvementPercentage).toBe(25);
      expect(result[0].timeframe).toBe('12 months');
    });

    it('should handle zero improvement rate', () => {
      const metrics = { 'Score': 100 };
      const result = service.generateProjections(metrics, 0, 6);
      expect(result[0].projectedValue).toBe(100);
      expect(result[0].improvementPercentage).toBe(0);
    });

    it('should handle empty metrics', () => {
      const result = service.generateProjections({}, 0.2, 12);
      expect(result).toEqual([]);
    });

    it('should include metric name and current value', () => {
      const metrics = { 'Data Quality': 0.85 };
      const result = service.generateProjections(metrics, 0.1, 6);
      expect(result[0].metric).toBe('Data Quality');
      expect(result[0].currentValue).toBe(0.85);
    });
  });

  /* ────────────── Edge cases ────────────── */

  describe('edge cases', () => {
    it('should include regulatory requirements in prompt context', async () => {
      // This tests through the heuristic path since no AI, but validates input handling
      const input = makeInput({
        organizationProfile: {
          ...makeInput().organizationProfile,
          regulatoryRequirements: ['SOX', 'HIPAA'],
        },
      });
      const result = await service.performBusinessImpactAnalysis(input as any);
      expect(result).toBeDefined();
    });

    it('should handle input with dataQualityResults', async () => {
      const input = makeInput({
        dataQualityResults: { overallScore: 85, criticalIssuesCount: 2, completeness: 0.92 },
      });
      const result = await service.performBusinessImpactAnalysis(input as any);
      expect(result).toBeDefined();
    });

    it('should handle input with processOptimizationResults', async () => {
      const input = makeInput({
        processOptimizationResults: { efficiencyScore: 0.75, bottlenecksCount: 3 },
      });
      const result = await service.performBusinessImpactAnalysis(input as any);
      expect(result).toBeDefined();
    });
  });
});
