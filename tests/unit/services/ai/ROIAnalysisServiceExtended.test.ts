/**
 * Comprehensive tests for ROIAnalysisService
 * Covers: calculateSimpleROI, calculateNetROI, performROICalculation,
 *         calculateTotalCostOfOwnership, calculateBenefitCostRatio, calculateBreakEvenPoint
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

import { ROIAnalysisService } from '../../../../src/services/ai/orchestrator/agents/intelligence/ROIAnalysisService';

describe('ROIAnalysisService', () => {
  let service: ROIAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (ROIAnalysisService as any)(mockLogger);
  });

  describe('calculateSimpleROI', () => {
    it('should calculate ROI percentage correctly', () => {
      // (200000 - 100000) / 100000 * 100 = 100%
      expect(service.calculateSimpleROI(200000, 100000)).toBe(100);
    });

    it('should return 0 when costs are 0', () => {
      expect(service.calculateSimpleROI(50000, 0)).toBe(0);
    });

    it('should handle negative ROI', () => {
      // (50000 - 100000) / 100000 * 100 = -50%
      expect(service.calculateSimpleROI(50000, 100000)).toBe(-50);
    });

    it('should round the result', () => {
      // (333333 - 200000) / 200000 * 100 = 66.6665 → 67
      expect(service.calculateSimpleROI(333333, 200000)).toBe(67);
    });
  });

  describe('calculateNetROI', () => {
    it('should return benefits minus costs', () => {
      expect(service.calculateNetROI(500000, 200000)).toBe(300000);
    });

    it('should handle negative net ROI', () => {
      expect(service.calculateNetROI(100000, 300000)).toBe(-200000);
    });

    it('should handle zero', () => {
      expect(service.calculateNetROI(100000, 100000)).toBe(0);
    });
  });

  describe('performROICalculation', () => {
    const makeBusinessImpact = (overrides: Record<string, any> = {}) => ({
      businessValue: {
        currentState: { operationalCost: 500000 },
        monetaryImpact: {
          implementationCost: 150000,
          annualSavings: 200000,
          revenueOpportunity: 300000,
        },
      },
      ...overrides,
    });

    it('should return complete ROI calculation structure', async () => {
      const result = await service.performROICalculation(makeBusinessImpact() as any);
      expect(result.calculationId).toBeDefined();
      expect(result.timestamp).toBeDefined();
      expect(result.scenario).toBe('realistic');
      expect(result.initialInvestment).toBe(150000);
      expect(result.annualBenefits).toBe(500000); // 200K + 300K
      expect(result.netPresentValue).toBeDefined();
      expect(result.internalRateOfReturn).toBeDefined();
      expect(result.paybackPeriod).toBeDefined();
      expect(result.riskAdjustedROI).toBeDefined();
      expect(result.sensitivityAnalysis.length).toBe(3);
    });

    it('should use default timeHorizon of 3 years', async () => {
      const result = await service.performROICalculation(makeBusinessImpact() as any);
      expect(result.expectedBenefits).toBe(500000 * 3);
    });

    it('should use scenario timeframe when provided', async () => {
      const scenario = { timeframe: 5 } as any;
      const result = await service.performROICalculation(makeBusinessImpact() as any, scenario);
      expect(result.expectedBenefits).toBe(500000 * 5);
    });

    it('should calculate payback period in months', async () => {
      const result = await service.performROICalculation(makeBusinessImpact() as any);
      // annualCosts = 500000 * 0.1 = 50000
      // netAnnualFlow = 500000 - 50000 = 450000
      // payback = 150000 / 450000 = 0.333 years = 4 months
      expect(result.paybackPeriod).toBe(4);
    });

    it('should calculate NPV correctly', async () => {
      const result = await service.performROICalculation(makeBusinessImpact() as any);
      // NPV = -150000 + 450000/1.08 + 450000/1.08^2 + 450000/1.08^3
      expect(result.netPresentValue).toBeGreaterThan(0);
    });

    it('should include sensitivity analysis with 3 variables', async () => {
      const result = await service.performROICalculation(makeBusinessImpact() as any);
      expect(result.sensitivityAnalysis.length).toBe(3);
      const variables = result.sensitivityAnalysis.map(s => s.variable);
      expect(variables).toContain('Implementation Cost');
      expect(variables).toContain('Annual Benefits');
      expect(variables).toContain('Annual Costs');
    });

    it('should use default values when monetary impact fields missing', async () => {
      const bi = makeBusinessImpact({
        businessValue: {
          currentState: { operationalCost: 0 },
          monetaryImpact: {},
        },
      });
      const result = await service.performROICalculation(bi as any);
      expect(result.initialInvestment).toBe(150000); // default
    });
  });

  describe('calculateTotalCostOfOwnership', () => {
    it('should calculate initial + annual * years', () => {
      expect(service.calculateTotalCostOfOwnership(100000, 50000, 3)).toBe(250000);
    });

    it('should handle zero annual costs', () => {
      expect(service.calculateTotalCostOfOwnership(100000, 0, 5)).toBe(100000);
    });
  });

  describe('calculateBenefitCostRatio', () => {
    it('should calculate ratio', () => {
      // 300000 / 100000 = 3.0
      expect(service.calculateBenefitCostRatio(300000, 100000)).toBe(3);
    });

    it('should return 0 when costs are 0', () => {
      expect(service.calculateBenefitCostRatio(100000, 0)).toBe(0);
    });

    it('should round to 2 decimal places', () => {
      // 100000 / 30000 = 3.3333... → 3.33
      expect(service.calculateBenefitCostRatio(100000, 30000)).toBe(3.33);
    });
  });

  describe('calculateBreakEvenPoint', () => {
    it('should calculate months to break even', () => {
      // 120000 / 10000 = 12 months
      expect(service.calculateBreakEvenPoint(120000, 10000)).toBe(12);
    });

    it('should return Infinity when monthly benefits <= 0', () => {
      expect(service.calculateBreakEvenPoint(100000, 0)).toBe(Infinity);
      expect(service.calculateBreakEvenPoint(100000, -5000)).toBe(Infinity);
    });

    it('should ceil fractional months', () => {
      // 100000 / 30000 = 3.33 → 4 months
      expect(service.calculateBreakEvenPoint(100000, 30000)).toBe(4);
    });
  });
});
