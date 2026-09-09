/**
 * Comprehensive tests for MetricsCalculationService
 * Covers: calculateOverallScore, determineOverallRiskLevel, generateRecommendedActions,
 *         mapEffortLevel, calculateImplementationTime, mapTimeframe, mapLikelihood,
 *         mapImpact, calculateConfidence, calculateTimeToValue, calculateInvestmentRequired,
 *         calculateProjectedROI, calculateRiskScore, calculateWeightedScore
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

import { MetricsCalculationService } from '../../../../src/services/ai/orchestrator/agents/intelligence/MetricsCalculationService';

describe('MetricsCalculationService', () => {
  let service: MetricsCalculationService;
  let mockROIService: { calculateSimpleROI: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    mockROIService = {
      calculateSimpleROI: jest.fn().mockImplementation((benefits, investment) => {
        if (investment === 0) return 0;
        return Math.round(((benefits - investment) / investment) * 100);
      }),
    };
    service = new (MetricsCalculationService as any)(mockLogger, mockROIService);
  });

  describe('calculateOverallScore', () => {
    it('should return 70 base score with no inputs', () => {
      expect(service.calculateOverallScore()).toBe(70);
    });

    it('should use businessImpact score when provided', () => {
      const bi = { overallScore: 85 } as any;
      expect(service.calculateOverallScore(bi)).toBe(85);
    });

    it('should use compliance score when only compliance provided', () => {
      const compliance = { overallCompliance: 0.9 } as any;
      expect(service.calculateOverallScore(undefined, compliance)).toBe(90);
    });

    it('should average businessImpact and compliance scores', () => {
      const bi = { overallScore: 80 } as any;
      const compliance = { overallCompliance: 0.9 } as any;
      // (80 + 90) / 2 = 85
      expect(service.calculateOverallScore(bi, compliance)).toBe(85);
    });

    it('should round the result', () => {
      const bi = { overallScore: 77 } as any;
      const compliance = { overallCompliance: 0.84 } as any;
      // (77 + 84) / 2 = 80.5 → 81
      expect(service.calculateOverallScore(bi, compliance)).toBe(81);
    });
  });

  describe('determineOverallRiskLevel', () => {
    it('should default to medium with no inputs', () => {
      expect(service.determineOverallRiskLevel()).toBe('medium');
    });

    it('should use businessImpact risk level', () => {
      const bi = { riskAssessment: { overallRiskLevel: 'high' } } as any;
      expect(service.determineOverallRiskLevel(bi)).toBe('high');
    });

    it('should escalate to high when critical compliance issues exist', () => {
      const bi = { riskAssessment: { overallRiskLevel: 'low' } } as any;
      const compliance = { criticalIssues: [{ description: 'Critical gap' }] } as any;
      expect(service.determineOverallRiskLevel(bi, compliance)).toBe('high');
    });

    it('should not escalate when no critical compliance issues', () => {
      const bi = { riskAssessment: { overallRiskLevel: 'low' } } as any;
      const compliance = { criticalIssues: [] } as any;
      expect(service.determineOverallRiskLevel(bi, compliance)).toBe('low');
    });

    it('should handle missing riskAssessment', () => {
      const bi = {} as any;
      expect(service.determineOverallRiskLevel(bi)).toBe('medium');
    });
  });

  describe('generateRecommendedActions', () => {
    it('should return empty array with no inputs', () => {
      expect(service.generateRecommendedActions()).toEqual([]);
    });

    it('should extract critical/high priority BI recommendations', () => {
      const bi = {
        recommendations: [
          { priority: 'critical', title: 'Critical Fix' },
          { priority: 'high', title: 'High Priority' },
          { priority: 'low', title: 'Low Priority' },
        ],
      } as any;
      const actions = service.generateRecommendedActions(bi);
      expect(actions).toEqual(['Critical Fix', 'High Priority']);
    });

    it('should extract critical/high priority compliance recommendations', () => {
      const compliance = {
        recommendations: [
          { priority: 'high', title: 'Comply GDPR' },
          { priority: 'medium', title: 'Update Docs' },
        ],
      } as any;
      const actions = service.generateRecommendedActions(undefined, compliance);
      expect(actions).toEqual(['Comply GDPR']);
    });

    it('should combine BI and compliance and limit to 5', () => {
      const bi = {
        recommendations: Array(4).fill(null).map((_, i) => ({ priority: 'high', title: `BI-${i}` })),
      } as any;
      const compliance = {
        recommendations: Array(3).fill(null).map((_, i) => ({ priority: 'critical', title: `C-${i}` })),
      } as any;
      const actions = service.generateRecommendedActions(bi, compliance);
      expect(actions.length).toBe(5);
    });
  });

  describe('mapEffortLevel', () => {
    it('should return high for >100K total cost', () => {
      expect(service.mapEffortLevel([{ cost: 120000 }] as any[])).toBe('high');
    });

    it('should return medium for 50K-100K total cost', () => {
      expect(service.mapEffortLevel([{ cost: 75000 }] as any[])).toBe('medium');
    });

    it('should return low for <=50K total cost', () => {
      expect(service.mapEffortLevel([{ cost: 30000 }] as any[])).toBe('low');
    });

    it('should sum multiple requirements', () => {
      expect(service.mapEffortLevel([{ cost: 60000 }, { cost: 60000 }] as any[])).toBe('high');
    });
  });

  describe('calculateImplementationTime', () => {
    it('should return 15 days per step', () => {
      expect(service.calculateImplementationTime(['a', 'b', 'c'])).toBe(45);
    });

    it('should return 0 for empty steps', () => {
      expect(service.calculateImplementationTime([])).toBe(0);
    });
  });

  describe('mapTimeframe', () => {
    it('should return immediate for "immediate"', () => {
      expect(service.mapTimeframe('immediate action')).toBe('immediate');
    });

    it('should return immediate for "1 month"', () => {
      expect(service.mapTimeframe('within 1 month')).toBe('immediate');
    });

    it('should return short-term for "3 months"', () => {
      expect(service.mapTimeframe('3 months timeline')).toBe('short-term');
    });

    it('should return short-term for "quarter"', () => {
      expect(service.mapTimeframe('next quarter')).toBe('short-term');
    });

    it('should return medium-term for "6 months"', () => {
      expect(service.mapTimeframe('6 months plan')).toBe('medium-term');
    });

    it('should return medium-term for "year"', () => {
      expect(service.mapTimeframe('within the year')).toBe('medium-term');
    });

    it('should return long-term for unrecognized', () => {
      expect(service.mapTimeframe('5-10 decades')).toBe('long-term');
    });
  });

  describe('mapLikelihood', () => {
    it('should return very-high for >= 0.8', () => {
      expect(service.mapLikelihood(0.9)).toBe('very-high');
    });

    it('should return high for 0.6-0.79', () => {
      expect(service.mapLikelihood(0.7)).toBe('high');
    });

    it('should return medium for 0.4-0.59', () => {
      expect(service.mapLikelihood(0.5)).toBe('medium');
    });

    it('should return low for 0.2-0.39', () => {
      expect(service.mapLikelihood(0.3)).toBe('low');
    });

    it('should return very-low for < 0.2', () => {
      expect(service.mapLikelihood(0.1)).toBe('very-low');
    });
  });

  describe('mapImpact', () => {
    it('should return catastrophic for >= 0.8', () => {
      expect(service.mapImpact(0.9)).toBe('catastrophic');
    });

    it('should return major for 0.6-0.79', () => {
      expect(service.mapImpact(0.7)).toBe('major');
    });

    it('should return moderate for 0.4-0.59', () => {
      expect(service.mapImpact(0.5)).toBe('moderate');
    });

    it('should return minor for 0.2-0.39', () => {
      expect(service.mapImpact(0.3)).toBe('minor');
    });

    it('should return negligible for < 0.2', () => {
      expect(service.mapImpact(0.1)).toBe('negligible');
    });
  });

  describe('calculateConfidence', () => {
    it('should start at 0.5 base', () => {
      const output = {} as any;
      expect(service.calculateConfidence(output)).toBe(0.5);
    });

    it('should add 0.15 for businessImpactAnalysis', () => {
      const output = { businessImpactAnalysis: {} } as any;
      expect(service.calculateConfidence(output)).toBeCloseTo(0.65, 5);
    });

    it('should add 0.15 for roiCalculation', () => {
      const output = { roiCalculation: {} } as any;
      expect(service.calculateConfidence(output)).toBeCloseTo(0.65, 5);
    });

    it('should add 0.10 for complianceValidation', () => {
      const output = { complianceValidation: {} } as any;
      expect(service.calculateConfidence(output)).toBeCloseTo(0.6, 5);
    });

    it('should add 0.05 for non-empty insights', () => {
      const output = { actionableInsights: [{}] } as any;
      expect(service.calculateConfidence(output)).toBeCloseTo(0.55, 5);
    });

    it('should add 0.05 for non-empty recommendations', () => {
      const output = { recommendations: [{}] } as any;
      expect(service.calculateConfidence(output)).toBeCloseTo(0.55, 5);
    });

    it('should cap at 1.0 with all fields', () => {
      const output = {
        businessImpactAnalysis: {},
        roiCalculation: {},
        complianceValidation: {},
        actionableInsights: [{}],
        recommendations: [{}],
      } as any;
      expect(service.calculateConfidence(output)).toBe(1.0);
    });
  });

  describe('calculateTimeToValue', () => {
    it('should convert days to months with 20% buffer', () => {
      // 90 days → 3 months → 3.6 → ceil → 4
      expect(service.calculateTimeToValue(90)).toBe(4);
    });

    it('should handle small values', () => {
      // 15 days → 1 month → 1.2 → ceil → 2
      expect(service.calculateTimeToValue(15)).toBe(2);
    });

    it('should handle 0', () => {
      expect(service.calculateTimeToValue(0)).toBe(0);
    });
  });

  describe('calculateInvestmentRequired', () => {
    it('should sum cost * quantity', () => {
      const reqs = [
        { cost: 100, quantity: 2 },
        { cost: 200, quantity: 3 },
      ] as any[];
      expect(service.calculateInvestmentRequired(reqs)).toBe(800); // 200 + 600
    });

    it('should return 0 for empty', () => {
      expect(service.calculateInvestmentRequired([])).toBe(0);
    });
  });

  describe('calculateProjectedROI', () => {
    it('should delegate to ROI service', () => {
      service.calculateProjectedROI(200000, 100000);
      expect(mockROIService.calculateSimpleROI).toHaveBeenCalledWith(200000, 100000);
    });
  });

  describe('calculateRiskScore', () => {
    it('should return likelihood * impact * 100 rounded', () => {
      expect(service.calculateRiskScore(0.6, 0.7)).toBe(42);
    });

    it('should return 0 for zero likelihood', () => {
      expect(service.calculateRiskScore(0, 0.9)).toBe(0);
    });

    it('should return 100 for max values', () => {
      expect(service.calculateRiskScore(1, 1)).toBe(100);
    });
  });

  describe('calculateWeightedScore', () => {
    it('should calculate weighted average', () => {
      const scores = [
        { value: 80, weight: 2 },
        { value: 60, weight: 1 },
      ];
      // (80*2 + 60*1) / 3 = 220/3 ≈ 73.33 → 73
      expect(service.calculateWeightedScore(scores)).toBe(73);
    });

    it('should return 0 for zero total weight', () => {
      expect(service.calculateWeightedScore([{ value: 80, weight: 0 }])).toBe(0);
    });

    it('should return 0 for empty array', () => {
      expect(service.calculateWeightedScore([])).toBe(0);
    });

    it('should handle single score', () => {
      expect(service.calculateWeightedScore([{ value: 90, weight: 1 }])).toBe(90);
    });
  });
});
