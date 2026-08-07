/**
 * Comprehensive tests for CostBenefitAnalyzer
 * Covers: calculateCostSavings with time, labor, quality, error savings
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

import { CostBenefitAnalyzer } from '../../../../src/services/ai/orchestrator/agents/optimization/CostBenefitAnalyzer';

describe('CostBenefitAnalyzer', () => {
  let service: CostBenefitAnalyzer;
  let mockROIService: { calculateSimpleROI: jest.Mock };

  const makeStep = (overrides: Record<string, any> = {}) => ({
    id: 'step-1',
    name: 'Process Step',
    type: 'automated',
    duration: 30,
    resources: ['analyst'],
    dependencies: [],
    failureRate: 0.02,
    ...overrides,
  });

  const makeOptimizationAnalysis = (overrides: Record<string, any> = {}) => ({
    opportunities: [],
    scenarios: [],
    recommendations: [],
    impact: { overallValue: 0 },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockROIService = {
      calculateSimpleROI: jest.fn().mockImplementation((annual, oneTime) => annual / oneTime),
    };
    service = new (CostBenefitAnalyzer as any)(mockLogger, mockROIService);
  });

  describe('calculateCostSavings', () => {
    it('should return empty savings when no time savings and no opportunities', async () => {
      const current = [makeStep({ duration: 30 })];
      const optimized = [makeStep({ duration: 30 })];
      const result = await service.calculateCostSavings(
        current as any[], optimized as any[], makeOptimizationAnalysis() as any
      );
      expect(result).toEqual([]);
    });

    it('should calculate time savings when optimized is shorter', async () => {
      const current = [makeStep({ duration: 60 })];
      const optimized = [makeStep({ duration: 30 })];
      const result = await service.calculateCostSavings(
        current as any[], optimized as any[], makeOptimizationAnalysis() as any
      );
      const timeSavings = result.filter(s => s.category === 'time');
      expect(timeSavings.length).toBe(1);
      expect(timeSavings[0].description).toContain('30 minutes');
      // annualSaving = 30 * 60 * 8760
      expect(timeSavings[0].annualSaving).toBe(30 * 60 * 8760);
      expect(timeSavings[0].oneTimeCost).toBe(5000);
      expect(timeSavings[0].confidence).toBe(0.8);
      expect(mockROIService.calculateSimpleROI).toHaveBeenCalledWith(30 * 60 * 8760, 5000);
    });

    it('should not create time savings when no duration reduction', async () => {
      const current = [makeStep({ duration: 30 })];
      const optimized = [makeStep({ duration: 40 })]; // longer
      const result = await service.calculateCostSavings(
        current as any[], optimized as any[], makeOptimizationAnalysis() as any
      );
      const timeSavings = result.filter(s => s.category === 'time');
      expect(timeSavings).toEqual([]);
    });

    it('should calculate labor savings for automation opportunities', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0.5, qualityImprovement: 0, errorReduction: 0 } },
          { type: 'automation', potentialGains: { costReduction: 0.3, qualityImprovement: 0, errorReduction: 0 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const laborSavings = result.filter(s => s.category === 'labor');
      expect(laborSavings.length).toBe(1);
      // (0.5 + 0.3) * 50000 = 40000
      expect(laborSavings[0].annualSaving).toBe(40000);
      expect(laborSavings[0].oneTimeCost).toBe(25000);
      expect(laborSavings[0].confidence).toBe(0.7);
    });

    it('should not create labor savings when no automation opportunities', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'elimination', potentialGains: { costReduction: 0.5, qualityImprovement: 0, errorReduction: 0 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const laborSavings = result.filter(s => s.category === 'labor');
      expect(laborSavings).toEqual([]);
    });

    it('should calculate quality savings for high quality improvement opportunities', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'consolidation', potentialGains: { costReduction: 0, qualityImprovement: 0.3, errorReduction: 0 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const qualitySavings = result.filter(s => s.description?.includes('quality'));
      expect(qualitySavings.length).toBe(1);
      // 0.3 * 20000 = 6000
      expect(qualitySavings[0].annualSaving).toBe(6000);
      expect(qualitySavings[0].oneTimeCost).toBe(10000);
      expect(qualitySavings[0].confidence).toBe(0.6);
    });

    it('should not create quality savings when improvement <= 0.1', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'consolidation', potentialGains: { costReduction: 0, qualityImprovement: 0.05, errorReduction: 0 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const qualitySavings = result.filter(s => s.description?.includes('quality'));
      expect(qualitySavings).toEqual([]);
    });

    it('should calculate error reduction savings when error > 0.2', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0, qualityImprovement: 0, errorReduction: 0.5 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const errorSavings = result.filter(s => s.description?.includes('error'));
      expect(errorSavings.length).toBe(1);
      // 0.5 * 15000 = 7500
      expect(errorSavings[0].annualSaving).toBe(7500);
      expect(errorSavings[0].oneTimeCost).toBe(8000);
      expect(errorSavings[0].confidence).toBe(0.75);
    });

    it('should not create error savings when reduction <= 0.2', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0, qualityImprovement: 0, errorReduction: 0.1 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const errorSavings = result.filter(s => s.description?.includes('error'));
      expect(errorSavings).toEqual([]);
    });

    it('should combine all savings types', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0.7, qualityImprovement: 0.3, errorReduction: 0.8 } },
        ],
      });
      const current = [makeStep({ duration: 60 })];
      const optimized = [makeStep({ duration: 30 })];
      const result = await service.calculateCostSavings(
        current as any[], optimized as any[], analysis as any
      );
      // Should have: time + labor + quality (0.3>0.1) + error (0.8>0.2)
      expect(result.length).toBe(4);
      const categories = result.map(s => s.category);
      expect(categories).toContain('time');
      expect(categories).toContain('labor');
      expect(categories.filter(c => c === 'maintenance').length).toBe(2); // quality + error
    });

    it('should call ROI service for each savings category', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.3 } },
        ],
      });
      const current = [makeStep({ duration: 60 })];
      const optimized = [makeStep({ duration: 30 })];
      await service.calculateCostSavings(current as any[], optimized as any[], analysis as any);
      // time + labor + quality(0.2>0.1) + error(0.3>0.2) = 4 calls
      expect(mockROIService.calculateSimpleROI).toHaveBeenCalledTimes(5); // 4 categories + 1 overall
    });

    it('should log start and completion', async () => {
      await service.calculateCostSavings(
        [makeStep()] as any[],
        [makeStep()] as any[],
        makeOptimizationAnalysis() as any
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Calculating cost savings', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Cost savings analysis completed', expect.any(Object));
    });

    it('should log individual savings categories', async () => {
      const current = [makeStep({ duration: 60 })];
      const optimized = [makeStep({ duration: 30 })];
      await service.calculateCostSavings(
        current as any[], optimized as any[], makeOptimizationAnalysis() as any
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Time savings calculated', expect.any(Object));
    });

    it('should handle empty workflows', async () => {
      const result = await service.calculateCostSavings(
        [] as any[], [] as any[], makeOptimizationAnalysis() as any
      );
      expect(result).toEqual([]);
    });

    it('should calculate multiple automation opportunities', async () => {
      const analysis = makeOptimizationAnalysis({
        opportunities: [
          { type: 'automation', potentialGains: { costReduction: 0.3, qualityImprovement: 0, errorReduction: 0 } },
          { type: 'automation', potentialGains: { costReduction: 0.4, qualityImprovement: 0, errorReduction: 0 } },
          { type: 'automation', potentialGains: { costReduction: 0.5, qualityImprovement: 0, errorReduction: 0 } },
        ],
      });
      const result = await service.calculateCostSavings(
        [makeStep({ duration: 30 })] as any[],
        [makeStep({ duration: 30 })] as any[],
        analysis as any
      );
      const laborSavings = result.find(s => s.category === 'labor');
      expect(laborSavings).toBeDefined();
      // (0.3 + 0.4 + 0.5) * 50000 = 60000
      expect(laborSavings!.annualSaving).toBe(60000);
      expect(laborSavings!.description).toContain('3 manual processes');
    });
  });
});
