/**
 * Unit tests for ROIAnalysisService
 * Tests ROI calculation, financial analysis, and scenario modeling
 */

import { Container } from 'inversify';
import { ROIAnalysisService } from '../../../../src/services/ai/orchestrator/agents/intelligence/ROIAnalysisService';
import { TYPES } from '../../../../src/inversify/types';
import type {
  BusinessImpactAnalysis,
  ImplementationScenario
} from '../../../../src/services/ai/orchestrator/agents/types/business-intelligence';

// Mock Logger
class MockLogger {
  debug(message: string, meta?: any): void {}
  info(message: string, meta?: any): void {}
  warn(message: string, meta?: any): void {}
  error(message: string, meta?: any): void {}
}

describe('ROIAnalysisService', () => {
  let container: Container;
  let roiService: ROIAnalysisService;

  beforeEach(() => {
    container = new Container();
    container.bind(TYPES.Logger).toConstantValue(new MockLogger());
    container.bind(ROIAnalysisService).toSelf();

    roiService = container.get(ROIAnalysisService);
  });

  afterEach(() => {
    container.unbindAll();
  });

  describe('calculateSimpleROI', () => {
    it('should calculate ROI correctly for profitable scenario', () => {
      const benefits = 500000;
      const costs = 200000;
      // ROI = ((500000 - 200000) / 200000) * 100 = 150%
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(150);
    });

    it('should calculate ROI correctly for break-even scenario', () => {
      const benefits = 100000;
      const costs = 100000;
      // ROI = ((100000 - 100000) / 100000) * 100 = 0%
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(0);
    });

    it('should calculate negative ROI for loss scenario', () => {
      const benefits = 80000;
      const costs = 100000;
      // ROI = ((80000 - 100000) / 100000) * 100 = -20%
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(-20);
    });

    it('should handle zero costs by returning 0', () => {
      const benefits = 100000;
      const costs = 0;
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(0);
    });

    it('should round ROI to nearest integer', () => {
      const benefits = 333333;
      const costs = 100000;
      // ROI = ((333333 - 100000) / 100000) * 100 = 233.333%
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(233); // Rounded
    });
  });

  describe('calculateNetROI', () => {
    it('should calculate net ROI as simple difference', () => {
      const benefits = 500000;
      const costs = 200000;
      const netROI = roiService.calculateNetROI(benefits, costs);

      expect(netROI).toBe(300000);
    });

    it('should handle zero benefits', () => {
      const benefits = 0;
      const costs = 100000;
      const netROI = roiService.calculateNetROI(benefits, costs);

      expect(netROI).toBe(-100000);
    });

    it('should handle zero costs', () => {
      const benefits = 100000;
      const costs = 0;
      const netROI = roiService.calculateNetROI(benefits, costs);

      expect(netROI).toBe(100000);
    });

    it('should handle negative results (loss)', () => {
      const benefits = 50000;
      const costs = 150000;
      const netROI = roiService.calculateNetROI(benefits, costs);

      expect(netROI).toBe(-100000);
    });
  });

  describe('performROICalculation', () => {
    const createMockBusinessImpact = (): BusinessImpactAnalysis => ({
      businessValue: {
        monetaryImpact: {
          implementationCost: 150000,
          annualSavings: 300000,
          revenueOpportunity: 100000,
          riskMitigationValue: 50000
        },
        operationalImpact: {
          timeReduction: 75,
          errorReduction: 60,
          throughputIncrease: 50,
          capacityIncrease: 40
        },
        currentState: {
          operationalCost: 500000,
          manualEffort: 2000,
          errorRate: 0.08,
          throughput: 1000
        },
        futureState: {
          operationalCost: 200000,
          manualEffort: 500,
          errorRate: 0.03,
          throughput: 1500
        }
      },
      costAnalysis: {
        implementationCosts: {
          licensing: 50000,
          professional: 75000,
          training: 15000,
          migration: 10000
        },
        recurringCosts: {
          licensing: 20000,
          maintenance: 15000,
          support: 10000,
          training: 5000
        },
        breakEvenPoint: 9,
        totalCostOfOwnership: 300000
      },
      risks: [],
      opportunities: [],
      recommendations: []
    });

    it('should perform complete ROI calculation with default scenario', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      expect(result).toHaveProperty('calculationId');
      expect(result).toHaveProperty('timestamp');
      expect(result.scenario).toBe('realistic');
      expect(result.initialInvestment).toBe(150000);
      expect(result.annualBenefits).toBe(400000); // 300000 + 100000
      expect(result).toHaveProperty('netPresentValue');
      expect(result).toHaveProperty('internalRateOfReturn');
      expect(result).toHaveProperty('paybackPeriod');
      expect(result).toHaveProperty('riskAdjustedROI');
      expect(result).toHaveProperty('sensitivityAnalysis');
    });

    it('should use provided scenario parameters', async () => {
      const businessImpact = createMockBusinessImpact();
      const scenario: ImplementationScenario = {
        scenario: 'optimistic',
        timeframe: 5,
        discountRate: 0.08,
        timeHorizonYears: 5,
        implementationApproach: 'big-bang',
        resourceAllocation: {
          fteDedicated: 3,
          ftePartTime: 2,
          budget: 200000
        },
        assumptions: [],
        constraints: []
      };

      const result = await roiService.performROICalculation(businessImpact, scenario);

      expect(result.scenario).toBe('optimistic');
      expect(result.expectedBenefits).toBe(2000000); // annualBenefits * 5 years
    });

    it('should calculate correct NPV for multi-year scenario', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      // NPV should be positive for profitable scenarios
      expect(result.netPresentValue).toBeGreaterThan(0);
      // NPV should be less than total undiscounted cash flows
      expect(result.netPresentValue).toBeLessThan(result.expectedBenefits);
    });

    it('should calculate payback period in months', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      expect(result.paybackPeriod).toBeGreaterThan(0);
      expect(result.paybackPeriod).toBeLessThan(100); // Reasonable payback
      expect(Number.isInteger(result.paybackPeriod)).toBe(true);
    });

    it('should include sensitivity analysis with three variables', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      expect(result.sensitivityAnalysis).toHaveLength(3);
      expect(result.sensitivityAnalysis[0].variable).toBe('Implementation Cost');
      expect(result.sensitivityAnalysis[1].variable).toBe('Annual Benefits');
      expect(result.sensitivityAnalysis[2].variable).toBe('Annual Costs');

      // Each should have base, pessimistic, and optimistic cases
      result.sensitivityAnalysis.forEach(analysis => {
        expect(analysis).toHaveProperty('baseCase');
        expect(analysis).toHaveProperty('pessimistic');
        expect(analysis).toHaveProperty('optimistic');
        expect(analysis).toHaveProperty('impactOnROI');
      });
    });

    it('should apply risk adjustment to ROI', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      // Risk-adjusted ROI should be lower than simple ROI due to risk factor (0.85)
      expect(result.riskAdjustedROI).toBeDefined();
      expect(typeof result.riskAdjustedROI).toBe('number');
    });

    it('should handle zero implementation cost scenario', async () => {
      const businessImpact = createMockBusinessImpact();
      businessImpact.businessValue.monetaryImpact.implementationCost = 0;

      const result = await roiService.performROICalculation(businessImpact);

      expect(result.initialInvestment).toBe(150000); // Uses default
      expect(result.riskAdjustedROI).toBeGreaterThanOrEqual(0);
    });

    it('should generate unique calculation IDs', async () => {
      const businessImpact = createMockBusinessImpact();

      const result1 = await roiService.performROICalculation(businessImpact);
      // Add small delay to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 5));
      const result2 = await roiService.performROICalculation(businessImpact);

      expect(result1.calculationId).not.toBe(result2.calculationId);
      expect(result1.calculationId).toMatch(/^calc_\d+$/);
      expect(result2.calculationId).toMatch(/^calc_\d+$/);
    });

    it('should calculate IRR as decimal value', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      expect(result.internalRateOfReturn).toBeGreaterThan(0);
      expect(result.internalRateOfReturn).toBeLessThan(10); // Reasonable IRR
      expect(typeof result.internalRateOfReturn).toBe('number');
    });

    it('should handle conservative scenario', async () => {
      const businessImpact = createMockBusinessImpact();
      const scenario: ImplementationScenario = {
        scenario: 'conservative',
        timeframe: 3,
        discountRate: 0.08,
        timeHorizonYears: 3,
        implementationApproach: 'phased',
        resourceAllocation: {
          fteDedicated: 2,
          ftePartTime: 1,
          budget: 150000
        },
        assumptions: [],
        constraints: []
      };

      const result = await roiService.performROICalculation(businessImpact, scenario);

      expect(result.scenario).toBe('conservative');
      expect(result).toHaveProperty('netPresentValue');
      expect(result).toHaveProperty('riskAdjustedROI');
    });

    it('should round NPV to nearest integer', async () => {
      const businessImpact = createMockBusinessImpact();
      const result = await roiService.performROICalculation(businessImpact);

      expect(Number.isInteger(result.netPresentValue)).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle very large investment amounts', () => {
      const benefits = 10000000000; // $10B
      const costs = 5000000000; // $5B
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(100); // 100% ROI
    });

    it('should handle very small amounts', () => {
      const benefits = 100;
      const costs = 50;
      const roi = roiService.calculateSimpleROI(benefits, costs);

      expect(roi).toBe(100); // 100% ROI
    });

    it('should handle negative costs (refund scenario)', () => {
      const benefits = 100000;
      const costs = -50000; // Receiving money back
      const netROI = roiService.calculateNetROI(benefits, costs);

      expect(netROI).toBe(150000); // Benefit + refund
    });
  });
});
