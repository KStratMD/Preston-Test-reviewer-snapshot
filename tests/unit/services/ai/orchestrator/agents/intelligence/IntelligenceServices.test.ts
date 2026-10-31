/**
 * Comprehensive unit tests for the 4 intelligence-related services:
 *   1. ForecastingService
 *   2. InsightsGeneratorService
 *   3. MetricsCalculationService
 *   4. ROIAnalysisService
 *
 * Tests all public methods with realistic data, edge cases, and boundary conditions.
 */

import 'reflect-metadata';

import { ROIAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/intelligence/ROIAnalysisService';
import { MetricsCalculationService } from '../../../../../../../src/services/ai/orchestrator/agents/intelligence/MetricsCalculationService';
import { InsightsGeneratorService } from '../../../../../../../src/services/ai/orchestrator/agents/intelligence/InsightsGeneratorService';
import { ForecastingService } from '../../../../../../../src/services/ai/orchestrator/agents/intelligence/ForecastingService';
import type {
  BusinessImpactAnalysis,
  ComplianceValidationResult,
  BusinessIntelligenceInput,
  BusinessIntelligenceOutput,
  ImplementationScenario,
  OrganizationProfile,
  ResourceRequirement,
  ROICalculation,
} from '../../../../../../../src/services/ai/orchestrator/agents/types/business-intelligence';

// ---------- Shared mock logger ----------
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

// ---------- Test data builders ----------

function buildOrgProfile(overrides?: Partial<OrganizationProfile>): OrganizationProfile {
  return {
    name: 'Acme Corp',
    industry: 'Technology',
    size: 'large',
    annualRevenue: 10_000_000,
    employeeCount: 500,
    regulatoryRequirements: ['SOX', 'GDPR'],
    geographicRegions: ['US', 'EU'],
    ...overrides,
  };
}

function buildBusinessImpact(overrides?: Partial<BusinessImpactAnalysis>): BusinessImpactAnalysis {
  return {
    analysisId: 'analysis_test',
    timestamp: new Date('2026-01-01'),
    overallScore: 78,
    businessValue: {
      currentState: {
        dataQualityScore: 0.75,
        processEfficiency: 0.70,
        complianceRating: 0.80,
        operationalCost: 1_500_000,
      },
      potentialImprovements: {
        qualityGainPercentage: 0.25,
        efficiencyGainPercentage: 0.20,
        costReductionPercentage: 0.15,
        revenueUpliftPercentage: 0.08,
      },
      monetaryImpact: {
        annualSavings: 225_000,
        revenueOpportunity: 800_000,
        implementationCost: 150_000,
        netROI: 2.5,
        paybackPeriodMonths: 18,
      },
    },
    riskAssessment: {
      overallRiskLevel: 'medium',
      riskCategories: [
        {
          category: 'operational',
          level: 'medium',
          description: 'Data quality issues impacting operations',
          likelihood: 0.6,
          impact: 0.7,
          riskScore: 42,
          affectedAreas: ['reporting', 'decision_making'],
        },
      ],
      mitigationStrategies: [],
      complianceRisks: [],
    },
    recommendations: [
      {
        priority: 'high',
        category: 'data_quality',
        title: 'Implement Data Governance Framework',
        description: 'Establish comprehensive data quality monitoring',
        businessJustification: 'Improve decision-making accuracy',
        implementationSteps: ['Assess current state', 'Design framework', 'Implement controls'],
        estimatedROI: 250,
        implementationTimeframe: '6-9 months',
        resourceRequirements: [
          {
            type: 'human' as const,
            description: 'Data governance specialist',
            quantity: 1,
            cost: 120_000,
            duration: 180,
            skillsRequired: ['Data governance', 'Data quality management'],
          },
        ],
        riskLevel: 'low' as const,
        dependsOn: [] as string[],
      },
    ],
    ...overrides,
  };
}

function buildComplianceResult(overrides?: Partial<ComplianceValidationResult>): ComplianceValidationResult {
  return {
    overallCompliance: 0.82,
    regulatoryGaps: [],
    criticalIssues: [],
    recommendations: [],
    regulations: [
      {
        regulation: 'GDPR',
        complianceScore: 0.85,
        gaps: [
          { severity: 'high', description: 'Missing data subject access request process' },
          { severity: 'low', description: 'Documentation needs update' },
        ],
        estimatedFineExposure: 500_000,
      },
      {
        regulation: 'SOX',
        complianceScore: 0.90,
        gaps: [
          { severity: 'critical', description: 'Insufficient audit trail logging' },
        ],
        estimatedFineExposure: 1_000_000,
      },
    ],
    ...overrides,
  };
}

function buildBIInput(overrides?: Partial<BusinessIntelligenceInput>): BusinessIntelligenceInput {
  return {
    organizationProfile: buildOrgProfile(),
    analysisType: 'comprehensive',
    ...overrides,
  };
}

function buildResourceRequirements(): ResourceRequirement[] {
  return [
    {
      type: 'human',
      description: 'Engineer',
      quantity: 2,
      duration: 90,
      cost: 60_000,
      skillsRequired: ['TypeScript'],
    },
    {
      type: 'technical',
      description: 'Cloud infrastructure',
      quantity: 1,
      duration: 365,
      cost: 25_000,
    },
  ];
}

// ===========================================================================
//  ROIAnalysisService
// ===========================================================================

describe('ROIAnalysisService', () => {
  let service: ROIAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ROIAnalysisService(mockLogger);
  });

  // --- calculateSimpleROI ---

  describe('calculateSimpleROI', () => {
    it('should return correct ROI for profitable scenario', () => {
      // ((500k - 200k) / 200k) * 100 = 150
      expect(service.calculateSimpleROI(500_000, 200_000)).toBe(150);
    });

    it('should return 0 for break-even', () => {
      expect(service.calculateSimpleROI(100_000, 100_000)).toBe(0);
    });

    it('should return negative ROI for loss', () => {
      // ((80k - 100k) / 100k) * 100 = -20
      expect(service.calculateSimpleROI(80_000, 100_000)).toBe(-20);
    });

    it('should return 0 when costs are zero', () => {
      expect(service.calculateSimpleROI(100_000, 0)).toBe(0);
    });

    it('should handle very large numbers', () => {
      const roi = service.calculateSimpleROI(1_000_000_000, 500_000_000);
      expect(roi).toBe(100);
    });

    it('should handle zero benefits', () => {
      expect(service.calculateSimpleROI(0, 100_000)).toBe(-100);
    });
  });

  // --- calculateNetROI ---

  describe('calculateNetROI', () => {
    it('should return positive net value when benefits exceed costs', () => {
      expect(service.calculateNetROI(500_000, 200_000)).toBe(300_000);
    });

    it('should return negative net value when costs exceed benefits', () => {
      expect(service.calculateNetROI(50_000, 200_000)).toBe(-150_000);
    });

    it('should return zero for break-even', () => {
      expect(service.calculateNetROI(100_000, 100_000)).toBe(0);
    });
  });

  // --- calculateTotalCostOfOwnership ---

  describe('calculateTotalCostOfOwnership', () => {
    it('should calculate TCO correctly', () => {
      // 150k + (50k * 3) = 300k
      expect(service.calculateTotalCostOfOwnership(150_000, 50_000, 3)).toBe(300_000);
    });

    it('should return just initial investment for zero annual costs', () => {
      expect(service.calculateTotalCostOfOwnership(150_000, 0, 5)).toBe(150_000);
    });

    it('should return just recurring costs for zero initial investment', () => {
      expect(service.calculateTotalCostOfOwnership(0, 50_000, 4)).toBe(200_000);
    });

    it('should return zero for all-zero inputs', () => {
      expect(service.calculateTotalCostOfOwnership(0, 0, 0)).toBe(0);
    });
  });

  // --- calculateBenefitCostRatio ---

  describe('calculateBenefitCostRatio', () => {
    it('should return ratio greater than 1 for profitable project', () => {
      expect(service.calculateBenefitCostRatio(500_000, 200_000)).toBe(2.5);
    });

    it('should return 1 for break-even', () => {
      expect(service.calculateBenefitCostRatio(100_000, 100_000)).toBe(1);
    });

    it('should return ratio less than 1 for unprofitable project', () => {
      expect(service.calculateBenefitCostRatio(50_000, 200_000)).toBe(0.25);
    });

    it('should return 0 when total costs are zero', () => {
      expect(service.calculateBenefitCostRatio(500_000, 0)).toBe(0);
    });
  });

  // --- calculateBreakEvenPoint ---

  describe('calculateBreakEvenPoint', () => {
    it('should calculate break-even months correctly', () => {
      // 150000 / 12500 = 12 months
      expect(service.calculateBreakEvenPoint(150_000, 12_500)).toBe(12);
    });

    it('should ceil fractional months', () => {
      // 100000 / 30000 = 3.33... → 4
      expect(service.calculateBreakEvenPoint(100_000, 30_000)).toBe(4);
    });

    it('should return Infinity when monthly benefits are zero', () => {
      expect(service.calculateBreakEvenPoint(150_000, 0)).toBe(Infinity);
    });

    it('should return Infinity when monthly benefits are negative', () => {
      expect(service.calculateBreakEvenPoint(150_000, -5_000)).toBe(Infinity);
    });

    it('should return 1 when investment equals monthly benefit', () => {
      expect(service.calculateBreakEvenPoint(10_000, 10_000)).toBe(1);
    });
  });

  // --- performROICalculation ---

  describe('performROICalculation', () => {
    it('should return a complete ROI calculation with defaults', async () => {
      const impact = buildBusinessImpact();
      const result = await service.performROICalculation(impact);

      expect(result.calculationId).toMatch(/^calc_/);
      expect(result.timestamp).toBeInstanceOf(Date);
      expect(result.scenario).toBe('realistic');
      expect(result.initialInvestment).toBe(150_000);
      expect(result.annualBenefits).toBe(225_000 + 800_000); // savings + revenue opportunity
      expect(typeof result.annualCosts).toBe('number');
      expect(typeof result.netPresentValue).toBe('number');
      expect(typeof result.internalRateOfReturn).toBe('number');
      expect(typeof result.paybackPeriod).toBe('number');
      expect(typeof result.riskAdjustedROI).toBe('number');
      expect(result.sensitivityAnalysis).toHaveLength(3);
    });

    it('should use custom scenario parameters', async () => {
      const impact = buildBusinessImpact();
      const scenario: ImplementationScenario = {
        scenario: 'optimistic',
        timeframe: 5,
        riskTolerance: 'high',
        implementationApproach: 'big_bang',
      };

      const result = await service.performROICalculation(impact, scenario);

      expect(result.scenario).toBe('optimistic');
      // expectedBenefits = annualBenefits * timeframe
      expect(result.expectedBenefits).toBe(result.annualBenefits * 5);
    });

    it('should compute NPV as a rounded number', async () => {
      const impact = buildBusinessImpact();
      const result = await service.performROICalculation(impact);

      expect(result.netPresentValue).toBe(Math.round(result.netPresentValue));
    });

    it('should have payback period in months', async () => {
      const impact = buildBusinessImpact();
      const result = await service.performROICalculation(impact);

      expect(result.paybackPeriod).toBeGreaterThan(0);
      // paybackPeriod is integer months
      expect(Number.isInteger(result.paybackPeriod)).toBe(true);
    });

    it('should include sensitivity analysis for three variables', async () => {
      const impact = buildBusinessImpact();
      const result = await service.performROICalculation(impact);

      const variables = result.sensitivityAnalysis.map((s: any) => s.variable);
      expect(variables).toContain('Implementation Cost');
      expect(variables).toContain('Annual Benefits');
      expect(variables).toContain('Annual Costs');
    });

    it('should calculate totalInvestment equal to initialInvestment', async () => {
      const impact = buildBusinessImpact();
      const result = await service.performROICalculation(impact);

      expect(result.totalInvestment).toBe(result.initialInvestment);
    });
  });
});

// ===========================================================================
//  MetricsCalculationService
// ===========================================================================

describe('MetricsCalculationService', () => {
  let service: MetricsCalculationService;
  let mockROIService: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockROIService = {
      calculateSimpleROI: jest.fn((benefits: number, costs: number) => {
        if (costs === 0) return 0;
        return Math.round(((benefits - costs) / costs) * 100);
      }),
    };
    service = new MetricsCalculationService(mockLogger, mockROIService);
  });

  // --- calculateOverallScore ---

  describe('calculateOverallScore', () => {
    it('should return business impact score when only business impact is provided', () => {
      const impact = buildBusinessImpact({ overallScore: 85 });
      expect(service.calculateOverallScore(impact)).toBe(85);
    });

    it('should return compliance score when only compliance is provided', () => {
      const compliance = buildComplianceResult({ overallCompliance: 0.90 });
      expect(service.calculateOverallScore(undefined, compliance)).toBe(90);
    });

    it('should average business impact and compliance scores when both provided', () => {
      const impact = buildBusinessImpact({ overallScore: 80 });
      const compliance = buildComplianceResult({ overallCompliance: 0.90 });
      // (80 + 90) / 2 = 85
      expect(service.calculateOverallScore(impact, compliance)).toBe(85);
    });

    it('should return base score of 70 when neither is provided', () => {
      expect(service.calculateOverallScore()).toBe(70);
    });

    it('should return base score of 70 when business impact has no overallScore', () => {
      const impact = buildBusinessImpact({ overallScore: undefined });
      expect(service.calculateOverallScore(impact)).toBe(70);
    });

    it('should round the result', () => {
      const impact = buildBusinessImpact({ overallScore: 77 });
      const compliance = buildComplianceResult({ overallCompliance: 0.82 });
      // (77 + 82) / 2 = 79.5 → 80
      expect(service.calculateOverallScore(impact, compliance)).toBe(80);
    });
  });

  // --- determineOverallRiskLevel ---

  describe('determineOverallRiskLevel', () => {
    it('should return medium as default', () => {
      expect(service.determineOverallRiskLevel()).toBe('medium');
    });

    it('should return risk level from business impact', () => {
      const impact = buildBusinessImpact();
      (impact.riskAssessment as any).overallRiskLevel = 'high';
      expect(service.determineOverallRiskLevel(impact)).toBe('high');
    });

    it('should escalate to high when compliance has critical issues', () => {
      const compliance = buildComplianceResult({
        criticalIssues: [{ description: 'Critical PII exposure' }] as any,
      });
      expect(service.determineOverallRiskLevel(undefined, compliance)).toBe('high');
    });

    it('should escalate to high regardless of business risk when compliance has critical issues', () => {
      const impact = buildBusinessImpact();
      (impact.riskAssessment as any).overallRiskLevel = 'low';
      const compliance = buildComplianceResult({
        criticalIssues: [{ description: 'Audit trail failure' }] as any,
      });
      expect(service.determineOverallRiskLevel(impact, compliance)).toBe('high');
    });

    it('should return medium if business impact has no riskAssessment', () => {
      const impact = buildBusinessImpact({ riskAssessment: undefined });
      expect(service.determineOverallRiskLevel(impact)).toBe('medium');
    });

    it('should not escalate when criticalIssues is empty', () => {
      const impact = buildBusinessImpact();
      (impact.riskAssessment as any).overallRiskLevel = 'low';
      const compliance = buildComplianceResult({ criticalIssues: [] });
      expect(service.determineOverallRiskLevel(impact, compliance)).toBe('low');
    });
  });

  // --- generateRecommendedActions ---

  describe('generateRecommendedActions', () => {
    it('should extract high-priority actions from business impact', () => {
      const impact = buildBusinessImpact();
      const actions = service.generateRecommendedActions(impact);
      expect(actions).toContain('Implement Data Governance Framework');
    });

    it('should extract critical and high from compliance recommendations', () => {
      const compliance = buildComplianceResult({
        recommendations: [
          { priority: 'critical', title: 'Fix audit logging' },
          { priority: 'high', title: 'Update PII handling' },
          { priority: 'low', title: 'Improve docs' },
        ] as any,
      });
      const actions = service.generateRecommendedActions(undefined, compliance);
      expect(actions).toContain('Fix audit logging');
      expect(actions).toContain('Update PII handling');
      expect(actions).not.toContain('Improve docs');
    });

    it('should return at most 5 actions', () => {
      const impact = buildBusinessImpact({
        recommendations: Array.from({ length: 10 }, (_, i) => ({
          priority: 'high',
          title: `Action ${i}`,
        })),
      });
      const actions = service.generateRecommendedActions(impact);
      expect(actions.length).toBeLessThanOrEqual(5);
    });

    it('should return empty array when no data provided', () => {
      expect(service.generateRecommendedActions()).toEqual([]);
    });

    it('should return empty array when recommendations exist but none are high/critical', () => {
      const impact = buildBusinessImpact({
        recommendations: [
          { priority: 'low', title: 'Low priority item' },
          { priority: 'medium', title: 'Medium priority item' },
        ],
      });
      expect(service.generateRecommendedActions(impact)).toEqual([]);
    });
  });

  // --- mapEffortLevel ---

  describe('mapEffortLevel', () => {
    it('should return high for cost above 100k', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'Dev', quantity: 1, duration: 90, cost: 120_000 },
      ];
      expect(service.mapEffortLevel(resources)).toBe('high');
    });

    it('should return medium for cost between 50k and 100k', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'Dev', quantity: 1, duration: 90, cost: 75_000 },
      ];
      expect(service.mapEffortLevel(resources)).toBe('medium');
    });

    it('should return low for cost below 50k', () => {
      const resources: ResourceRequirement[] = [
        { type: 'technical', description: 'Tool', quantity: 1, duration: 30, cost: 10_000 },
      ];
      expect(service.mapEffortLevel(resources)).toBe('low');
    });

    it('should sum costs from multiple resources', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'Dev', quantity: 1, duration: 90, cost: 40_000 },
        { type: 'human', description: 'QA', quantity: 1, duration: 60, cost: 30_000 },
      ];
      // total = 70k → medium
      expect(service.mapEffortLevel(resources)).toBe('medium');
    });

    it('should return low for empty resource list', () => {
      expect(service.mapEffortLevel([])).toBe('low');
    });

    it('should return medium for exactly 50001', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'X', quantity: 1, duration: 1, cost: 50_001 },
      ];
      expect(service.mapEffortLevel(resources)).toBe('medium');
    });

    it('should return high for exactly 100001', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'X', quantity: 1, duration: 1, cost: 100_001 },
      ];
      expect(service.mapEffortLevel(resources)).toBe('high');
    });
  });

  // --- calculateImplementationTime ---

  describe('calculateImplementationTime', () => {
    it('should return 15 days per step', () => {
      expect(service.calculateImplementationTime(['Step 1', 'Step 2', 'Step 3'])).toBe(45);
    });

    it('should return 0 for empty steps', () => {
      expect(service.calculateImplementationTime([])).toBe(0);
    });

    it('should return 15 for single step', () => {
      expect(service.calculateImplementationTime(['Only step'])).toBe(15);
    });
  });

  // --- mapTimeframe ---

  describe('mapTimeframe', () => {
    it('should return immediate for "immediate"', () => {
      expect(service.mapTimeframe('immediate')).toBe('immediate');
    });

    it('should return immediate for "1 month"', () => {
      expect(service.mapTimeframe('1 month')).toBe('immediate');
    });

    it('should return short-term for "3 months"', () => {
      expect(service.mapTimeframe('3 months')).toBe('short-term');
    });

    it('should return short-term for "quarter"', () => {
      expect(service.mapTimeframe('Next quarter')).toBe('short-term');
    });

    it('should return medium-term for "6 months"', () => {
      expect(service.mapTimeframe('6 months')).toBe('medium-term');
    });

    it('should return medium-term for "year"', () => {
      expect(service.mapTimeframe('1 year timeline')).toBe('medium-term');
    });

    it('should return long-term as default', () => {
      expect(service.mapTimeframe('some unknown timeframe')).toBe('long-term');
    });

    it('should be case-insensitive', () => {
      expect(service.mapTimeframe('IMMEDIATE')).toBe('immediate');
      expect(service.mapTimeframe('3 Months Plan')).toBe('short-term');
    });
  });

  // --- mapLikelihood ---

  describe('mapLikelihood', () => {
    it('should return very-high for >= 0.8', () => {
      expect(service.mapLikelihood(0.8)).toBe('very-high');
      expect(service.mapLikelihood(0.95)).toBe('very-high');
      expect(service.mapLikelihood(1.0)).toBe('very-high');
    });

    it('should return high for >= 0.6 and < 0.8', () => {
      expect(service.mapLikelihood(0.6)).toBe('high');
      expect(service.mapLikelihood(0.79)).toBe('high');
    });

    it('should return medium for >= 0.4 and < 0.6', () => {
      expect(service.mapLikelihood(0.4)).toBe('medium');
      expect(service.mapLikelihood(0.59)).toBe('medium');
    });

    it('should return low for >= 0.2 and < 0.4', () => {
      expect(service.mapLikelihood(0.2)).toBe('low');
      expect(service.mapLikelihood(0.39)).toBe('low');
    });

    it('should return very-low for < 0.2', () => {
      expect(service.mapLikelihood(0.1)).toBe('very-low');
      expect(service.mapLikelihood(0)).toBe('very-low');
    });
  });

  // --- mapImpact ---

  describe('mapImpact', () => {
    it('should return catastrophic for >= 0.8', () => {
      expect(service.mapImpact(0.8)).toBe('catastrophic');
      expect(service.mapImpact(1.0)).toBe('catastrophic');
    });

    it('should return major for >= 0.6 and < 0.8', () => {
      expect(service.mapImpact(0.6)).toBe('major');
      expect(service.mapImpact(0.79)).toBe('major');
    });

    it('should return moderate for >= 0.4 and < 0.6', () => {
      expect(service.mapImpact(0.4)).toBe('moderate');
      expect(service.mapImpact(0.59)).toBe('moderate');
    });

    it('should return minor for >= 0.2 and < 0.4', () => {
      expect(service.mapImpact(0.2)).toBe('minor');
      expect(service.mapImpact(0.39)).toBe('minor');
    });

    it('should return negligible for < 0.2', () => {
      expect(service.mapImpact(0.1)).toBe('negligible');
      expect(service.mapImpact(0)).toBe('negligible');
    });
  });

  // --- calculateConfidence ---

  describe('calculateConfidence', () => {
    it('should return base 0.5 for empty output', () => {
      const output: BusinessIntelligenceOutput = {
        executiveSummary: {} as any,
        actionableInsights: [],
        riskAssessment: {} as any,
        recommendations: [],
      };
      expect(service.calculateConfidence(output)).toBe(0.5);
    });

    it('should increase confidence for each completed section', () => {
      const output: BusinessIntelligenceOutput = {
        businessImpactAnalysis: buildBusinessImpact(),
        roiCalculation: { totalInvestment: 100, expectedBenefits: 200, paybackPeriod: 12, netPresentValue: 100, internalRateOfReturn: 0.2 },
        complianceValidation: buildComplianceResult(),
        executiveSummary: {} as any,
        actionableInsights: [{ insightId: 'i1' } as any],
        riskAssessment: {} as any,
        recommendations: [{ recommendationId: 'r1' } as any],
      };
      // 0.5 + 0.15 + 0.15 + 0.10 + 0.05 + 0.05 = 1.0
      expect(service.calculateConfidence(output)).toBe(1.0);
    });

    it('should never exceed 1.0', () => {
      const output: BusinessIntelligenceOutput = {
        businessImpactAnalysis: buildBusinessImpact(),
        roiCalculation: { totalInvestment: 100, expectedBenefits: 200, paybackPeriod: 12, netPresentValue: 100, internalRateOfReturn: 0.2 },
        complianceValidation: buildComplianceResult(),
        executiveSummary: {} as any,
        actionableInsights: [{ insightId: 'i1' } as any],
        riskAssessment: {} as any,
        recommendations: [{ recommendationId: 'r1' } as any],
      };
      expect(service.calculateConfidence(output)).toBeLessThanOrEqual(1.0);
    });

    it('should add 0.15 for businessImpactAnalysis only', () => {
      const output: BusinessIntelligenceOutput = {
        businessImpactAnalysis: buildBusinessImpact(),
        executiveSummary: {} as any,
        actionableInsights: [],
        riskAssessment: {} as any,
        recommendations: [],
      };
      expect(service.calculateConfidence(output)).toBeCloseTo(0.65, 2);
    });

    it('should not count empty arrays for insights and recommendations', () => {
      const output: BusinessIntelligenceOutput = {
        executiveSummary: {} as any,
        actionableInsights: [],
        riskAssessment: {} as any,
        recommendations: [],
      };
      // Only base 0.5
      expect(service.calculateConfidence(output)).toBe(0.5);
    });
  });

  // --- calculateTimeToValue ---

  describe('calculateTimeToValue', () => {
    it('should convert days to months with 20% buffer', () => {
      // 90 days / 30 = 3 months, * 1.2 = 3.6, ceil = 4
      expect(service.calculateTimeToValue(90)).toBe(4);
    });

    it('should return 0 for zero implementation days', () => {
      // 0 / 30 = 0, * 1.2 = 0, ceil = 0
      expect(service.calculateTimeToValue(0)).toBe(0);
    });

    it('should ceil fractional results', () => {
      // 30 days / 30 = 1 month, * 1.2 = 1.2, ceil = 2
      expect(service.calculateTimeToValue(30)).toBe(2);
    });

    it('should handle large implementation timelines', () => {
      // 365 days / 30 = 12.17, ceil = 13, * 1.2 = 15.6, ceil = 16
      const result = service.calculateTimeToValue(365);
      expect(result).toBeGreaterThan(12);
    });
  });

  // --- calculateInvestmentRequired ---

  describe('calculateInvestmentRequired', () => {
    it('should sum cost * quantity for all resources', () => {
      const resources = buildResourceRequirements();
      // (60000 * 2) + (25000 * 1) = 145000
      expect(service.calculateInvestmentRequired(resources)).toBe(145_000);
    });

    it('should return 0 for empty resources', () => {
      expect(service.calculateInvestmentRequired([])).toBe(0);
    });

    it('should handle resources with undefined cost as NaN (edge case)', () => {
      const resources: ResourceRequirement[] = [
        { type: 'human', description: 'Dev', quantity: 1, duration: 90 },
      ];
      const result = service.calculateInvestmentRequired(resources);
      // cost is undefined → undefined * 1 = NaN
      expect(Number.isNaN(result)).toBe(true);
    });
  });

  // --- calculateProjectedROI ---

  describe('calculateProjectedROI', () => {
    it('should delegate to roiService.calculateSimpleROI', () => {
      service.calculateProjectedROI(300_000, 100_000);
      expect(mockROIService.calculateSimpleROI).toHaveBeenCalledWith(300_000, 100_000);
    });

    it('should return the value from roiService', () => {
      const result = service.calculateProjectedROI(300_000, 100_000);
      expect(result).toBe(200); // ((300k - 100k) / 100k) * 100
    });
  });

  // --- calculateRiskScore ---

  describe('calculateRiskScore', () => {
    it('should compute likelihood * impact * 100 rounded', () => {
      expect(service.calculateRiskScore(0.6, 0.7)).toBe(42);
    });

    it('should return 0 for zero likelihood', () => {
      expect(service.calculateRiskScore(0, 0.9)).toBe(0);
    });

    it('should return 0 for zero impact', () => {
      expect(service.calculateRiskScore(0.9, 0)).toBe(0);
    });

    it('should return 100 for maximum values', () => {
      expect(service.calculateRiskScore(1.0, 1.0)).toBe(100);
    });

    it('should handle fractional intermediate values', () => {
      // 0.33 * 0.33 * 100 = 10.89 → 11
      expect(service.calculateRiskScore(0.33, 0.33)).toBe(11);
    });
  });

  // --- calculateWeightedScore ---

  describe('calculateWeightedScore', () => {
    it('should compute weighted average', () => {
      const scores = [
        { value: 80, weight: 3 },
        { value: 60, weight: 1 },
      ];
      // (80*3 + 60*1) / (3+1) = 300/4 = 75
      expect(service.calculateWeightedScore(scores)).toBe(75);
    });

    it('should return 0 for empty array', () => {
      expect(service.calculateWeightedScore([])).toBe(0);
    });

    it('should return 0 when total weight is zero', () => {
      const scores = [
        { value: 80, weight: 0 },
        { value: 60, weight: 0 },
      ];
      expect(service.calculateWeightedScore(scores)).toBe(0);
    });

    it('should handle equal weights', () => {
      const scores = [
        { value: 90, weight: 1 },
        { value: 70, weight: 1 },
      ];
      // (90+70)/2 = 80
      expect(service.calculateWeightedScore(scores)).toBe(80);
    });

    it('should round the result', () => {
      const scores = [
        { value: 33, weight: 1 },
        { value: 67, weight: 1 },
      ];
      // (33+67)/2 = 50
      expect(service.calculateWeightedScore(scores)).toBe(50);
    });

    it('should handle single score', () => {
      const scores = [{ value: 85, weight: 5 }];
      expect(service.calculateWeightedScore(scores)).toBe(85);
    });
  });
});

// ===========================================================================
//  ForecastingService
// ===========================================================================

describe('ForecastingService', () => {
  let service: ForecastingService;
  let mockProviderRegistry: any;
  let mockSemanticEngine: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderRegistry = null;
    mockSemanticEngine = null;
    service = new ForecastingService(mockLogger, mockProviderRegistry, mockSemanticEngine);
  });

  // --- performBusinessImpactAnalysis (heuristic fallback) ---

  describe('performBusinessImpactAnalysis', () => {
    it('should fall back to heuristic analysis when AI providers are null', async () => {
      const input = buildBIInput();
      const result = await service.performBusinessImpactAnalysis(input);

      expect(result).toBeDefined();
      expect(result.overallScore).toBe(78);
      expect(result.businessValue).toBeDefined();
      expect(result.riskAssessment).toBeDefined();
      expect(result.recommendations).toBeDefined();
      expect(result.projections).toBeDefined();
    });

    it('should calculate operationalCost from annualRevenue', async () => {
      const input = buildBIInput({
        organizationProfile: buildOrgProfile({ annualRevenue: 20_000_000 }),
      });
      const result = await service.performBusinessImpactAnalysis(input);

      // operationalCost = 20M * 0.15 = 3M
      expect(result.businessValue!.currentState.operationalCost).toBe(3_000_000);
    });

    it('should calculate monetaryImpact correctly', async () => {
      const input = buildBIInput({
        organizationProfile: buildOrgProfile({ annualRevenue: 10_000_000 }),
      });
      const result = await service.performBusinessImpactAnalysis(input);

      const monetary = result.businessValue!.monetaryImpact;
      // annualSavings = revenue * 0.15 * 0.15 = 225k
      expect(monetary.annualSavings).toBe(225_000);
      // revenueOpportunity = revenue * 0.08 = 800k
      expect(monetary.revenueOpportunity).toBe(800_000);
      expect(monetary.implementationCost).toBe(150_000);
      expect(monetary.netROI).toBe(2.5);
      expect(monetary.paybackPeriodMonths).toBe(18);
    });

    it('should include riskAssessment with medium level', async () => {
      const input = buildBIInput();
      const result = await service.performBusinessImpactAnalysis(input);

      expect(result.riskAssessment!.overallRiskLevel).toBe('medium');
      expect((result.riskAssessment!.riskCategories as any[]).length).toBe(1);
    });

    it('should include at least one recommendation', async () => {
      const input = buildBIInput();
      const result = await service.performBusinessImpactAnalysis(input);

      const recs = result.recommendations as any[];
      expect(recs.length).toBeGreaterThanOrEqual(1);
      expect(recs[0].priority).toBe('high');
      expect(recs[0].title).toBe('Implement Data Governance Framework');
    });

    it('should include projections', async () => {
      const input = buildBIInput();
      const result = await service.performBusinessImpactAnalysis(input);

      const projections = result.projections as any[];
      expect(projections.length).toBe(1);
      expect(projections[0].metric).toBe('Data Quality Score');
      expect(projections[0].currentValue).toBe(0.75);
      expect(projections[0].projectedValue).toBe(0.90);
    });

    it('should log error and fall back to heuristics when AI provider throws', async () => {
      // Set up providers that throw — the inner try/catch in performBusinessImpactAnalysisWithAI
      // catches the error and logs it, then returns null. The outer method gets null (not an
      // exception) so it falls back to heuristics without hitting the outer catch block.
      const failingRegistry = {
        getAvailableProviders: jest.fn().mockRejectedValue(new Error('Provider unavailable')),
      };
      const failingEngine = {};
      const svc = new ForecastingService(mockLogger, failingRegistry, failingEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(78); // heuristic fallback
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI business impact analysis failed',
        expect.any(Object)
      );
    });

    it('should use AI result when AI providers return valid data', async () => {
      const aiResult = {
        overallScore: 92,
        businessValue: {
          currentState: { dataQualityScore: 0.9, processEfficiency: 0.85, complianceRating: 0.95, operationalCost: 500_000 },
          potentialImprovements: { qualityGainPercentage: 0.1, efficiencyGainPercentage: 0.1, costReductionPercentage: 0.1, revenueUpliftPercentage: 0.05 },
          monetaryImpact: { annualSavings: 100_000, revenueOpportunity: 200_000, implementationCost: 50_000, netROI: 5, paybackPeriodMonths: 6 },
        },
        riskAssessment: { overallRiskLevel: 'low', riskCategories: [], mitigationStrategies: [], complianceRisks: [] },
        recommendations: [],
      };
      const jsonResponse = JSON.stringify(aiResult);

      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: jsonResponse }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(92);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Using AI-enhanced business impact analysis',
        expect.any(Object)
      );
    });

    it('should fall back when AI returns no providers', async () => {
      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([]),
      };
      const aiEngine = {};
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(78); // heuristic fallback
    });

    it('should fall back when AI response content is empty', async () => {
      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: '' }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(78); // heuristic fallback
    });

    it('should fall back when AI returns invalid JSON', async () => {
      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: 'Not valid JSON at all' }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(78); // heuristic fallback
    });

    it('should clamp AI-generated overallScore to 0-100 range', async () => {
      const aiResult = { overallScore: 150, recommendations: [] };
      const jsonResponse = JSON.stringify(aiResult);

      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: jsonResponse }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBeLessThanOrEqual(100);
    });

    it('should set default overallScore of 75 when AI omits it', async () => {
      const aiResult = { businessValue: {}, recommendations: [] };
      const jsonResponse = JSON.stringify(aiResult);

      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: jsonResponse }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.overallScore).toBe(75);
    });

    it('should provide default riskAssessment when AI omits it', async () => {
      const aiResult = { overallScore: 80 };
      const jsonResponse = JSON.stringify(aiResult);

      const aiRegistry = {
        getAvailableProviders: jest.fn().mockResolvedValue([{ name: 'openai' }]),
      };
      const aiEngine = {
        analyzeWithLLM: jest.fn().mockResolvedValue({ content: jsonResponse }),
      };
      const svc = new ForecastingService(mockLogger, aiRegistry, aiEngine);

      const input = buildBIInput();
      const result = await svc.performBusinessImpactAnalysis(input);

      expect(result.riskAssessment).toBeDefined();
      expect(result.riskAssessment!.overallRiskLevel).toBe('medium');
    });
  });

  // --- generateProjections ---

  describe('generateProjections', () => {
    it('should generate projections for each metric', () => {
      const metrics = { 'Data Quality': 0.75, 'Efficiency': 0.70 };
      const result = service.generateProjections(metrics, 0.20, 12);

      expect(result).toHaveLength(2);
    });

    it('should calculate projected value with improvement rate', () => {
      const metrics = { 'Score': 100 };
      const result = service.generateProjections(metrics, 0.25, 6);

      expect(result[0].currentValue).toBe(100);
      expect(result[0].projectedValue).toBe(125); // 100 * 1.25
      expect(result[0].improvementPercentage).toBe(25);
      expect(result[0].timeframe).toBe('6 months');
    });

    it('should return empty array for empty metrics', () => {
      const result = service.generateProjections({}, 0.20, 12);
      expect(result).toEqual([]);
    });

    it('should handle zero improvement rate', () => {
      const metrics = { 'Score': 80 };
      const result = service.generateProjections(metrics, 0, 12);

      expect(result[0].projectedValue).toBe(80);
      expect(result[0].improvementPercentage).toBe(0);
    });

    it('should handle negative improvement rate (decline)', () => {
      const metrics = { 'Score': 100 };
      const result = service.generateProjections(metrics, -0.10, 12);

      expect(result[0].projectedValue).toBe(90);
      expect(result[0].improvementPercentage).toBe(-10);
    });

    it('should include metric name in output', () => {
      const metrics = { 'Customer Satisfaction': 4.2 };
      const result = service.generateProjections(metrics, 0.10, 6);

      expect(result[0].metric).toBe('Customer Satisfaction');
    });

    it('should round improvementPercentage to integer', () => {
      const metrics = { 'Score': 3 };
      const result = service.generateProjections(metrics, 0.333, 12);

      // (3 * 1.333 - 3) / 3 * 100 = 33.3 → 33
      expect(Number.isInteger(result[0].improvementPercentage)).toBe(true);
    });
  });
});

// ===========================================================================
//  InsightsGeneratorService
// ===========================================================================

describe('InsightsGeneratorService', () => {
  let service: InsightsGeneratorService;
  let mockMetricsService: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockMetricsService = {
      calculateOverallScore: jest.fn().mockReturnValue(80),
      determineOverallRiskLevel: jest.fn().mockReturnValue('medium'),
      generateRecommendedActions: jest.fn().mockReturnValue(['Action 1']),
      mapEffortLevel: jest.fn().mockReturnValue('medium'),
      calculateImplementationTime: jest.fn().mockReturnValue(45),
      mapTimeframe: jest.fn().mockReturnValue('medium-term'),
      calculateRiskScore: jest.fn((l: number, i: number) => Math.round(l * i * 100)),
      mapLikelihood: jest.fn().mockReturnValue('high'),
      mapImpact: jest.fn().mockReturnValue('major'),
    };

    service = new InsightsGeneratorService(mockLogger, mockMetricsService);
  });

  // --- generateExecutiveSummary ---

  describe('generateExecutiveSummary', () => {
    it('should return a complete executive summary with all inputs', async () => {
      const impact = buildBusinessImpact();
      const roi: ROICalculation = {
        totalInvestment: 150_000,
        expectedBenefits: 1_025_000,
        paybackPeriod: 18,
        netPresentValue: 500_000,
        internalRateOfReturn: 0.45,
        riskAdjustedROI: 3.5,
      };
      const compliance = buildComplianceResult();
      const orgProfile = buildOrgProfile();

      const result = await service.generateExecutiveSummary(impact, roi, compliance, orgProfile);

      expect(result.overallScore).toBe(80);
      expect(result.keyFindings.length).toBeGreaterThan(0);
      expect(result.businessValue).toBeDefined();
      expect(result.riskLevel).toBe('medium');
      expect(result.recommendedActions).toEqual(['Action 1']);
      expect(result.timeToValue).toBe(12);
      expect(result.projectedROI).toBe(3.5);
    });

    it('should generate opportunity finding from business impact', async () => {
      const impact = buildBusinessImpact();
      const result = await service.generateExecutiveSummary(impact);

      const opportunityFinding = result.keyFindings.find(f => f.category === 'opportunity');
      expect(opportunityFinding).toBeDefined();
      expect(opportunityFinding!.title).toContain('Data Quality');
    });

    it('should generate compliance finding when compliance is provided', async () => {
      const compliance = buildComplianceResult();
      const result = await service.generateExecutiveSummary(undefined, undefined, compliance);

      const complianceFinding = result.keyFindings.find(f => f.category === 'compliance');
      expect(complianceFinding).toBeDefined();
      expect(complianceFinding!.description).toContain('82%');
    });

    it('should mark opportunity as high impact when dataQualityScore < 0.7', async () => {
      const impact = buildBusinessImpact();
      impact.businessValue!.currentState.dataQualityScore = 0.65;
      const result = await service.generateExecutiveSummary(impact);

      const finding = result.keyFindings.find(f => f.category === 'opportunity');
      expect(finding!.impact).toBe('high');
    });

    it('should mark opportunity as medium impact when dataQualityScore >= 0.7', async () => {
      const impact = buildBusinessImpact();
      impact.businessValue!.currentState.dataQualityScore = 0.75;
      const result = await service.generateExecutiveSummary(impact);

      const finding = result.keyFindings.find(f => f.category === 'opportunity');
      expect(finding!.impact).toBe('medium');
    });

    it('should mark compliance as high impact when overallCompliance < 0.8', async () => {
      const compliance = buildComplianceResult({ overallCompliance: 0.60 });
      const result = await service.generateExecutiveSummary(undefined, undefined, compliance);

      const finding = result.keyFindings.find(f => f.category === 'compliance');
      expect(finding!.impact).toBe('high');
    });

    it('should return default investmentRequired when businessImpact is missing', async () => {
      const result = await service.generateExecutiveSummary();

      expect(result.investmentRequired).toBe(100_000);
    });

    it('should extract investmentRequired from business impact monetaryImpact', async () => {
      const impact = buildBusinessImpact();
      const result = await service.generateExecutiveSummary(impact);

      expect(result.investmentRequired).toBe(150_000);
    });

    it('should return 250 default projectedROI when roi is not provided', async () => {
      const result = await service.generateExecutiveSummary();

      expect(result.projectedROI).toBe(250);
    });

    it('should extract riskAdjustedROI from roi parameter', async () => {
      const roi: ROICalculation = {
        totalInvestment: 100_000,
        expectedBenefits: 400_000,
        paybackPeriod: 12,
        netPresentValue: 200_000,
        internalRateOfReturn: 0.4,
        riskAdjustedROI: 1.75,
      };
      const result = await service.generateExecutiveSummary(undefined, roi);

      expect(result.projectedROI).toBe(1.75);
    });

    it('should compute businessValue summary with defaults when no business impact', async () => {
      const result = await service.generateExecutiveSummary();

      expect(result.businessValue.currentStateScore).toBe(75);
      expect(result.businessValue.potentialImprovementScore).toBe(25);
      expect(result.businessValue.efficiencyGains).toBe(15);
    });

    it('should compute businessValue summary from business impact data', async () => {
      const impact = buildBusinessImpact();
      const result = await service.generateExecutiveSummary(impact);

      expect(result.businessValue.currentStateScore).toBe(75); // 0.75 * 100
      expect(result.businessValue.potentialImprovementScore).toBe(25); // 0.25 * 100
      expect(result.businessValue.annualSavingsOpportunity).toBe(225_000);
      expect(result.businessValue.revenueUpliftOpportunity).toBe(800_000);
      expect(result.businessValue.efficiencyGains).toBe(20); // 0.20 * 100
    });

    it('should compute riskReduction from compliance data when businessImpact is also provided', async () => {
      const impact = buildBusinessImpact();
      const compliance = buildComplianceResult({ overallCompliance: 0.80 });
      const result = await service.generateExecutiveSummary(impact, undefined, compliance);

      // (1 - 0.80) * 50 = 10
      expect(result.businessValue.riskReduction).toBe(10);
    });

    it('should return default riskReduction when only compliance is provided (no businessImpact)', async () => {
      const compliance = buildComplianceResult({ overallCompliance: 0.80 });
      const result = await service.generateExecutiveSummary(undefined, undefined, compliance);

      // Without businessImpact, calculateBusinessValueSummary returns defaults (riskReduction: 20)
      expect(result.businessValue.riskReduction).toBe(20);
    });
  });

  // --- generateActionableInsights ---

  describe('generateActionableInsights', () => {
    it('should generate insights from business impact recommendations', async () => {
      const impact = buildBusinessImpact();
      const insights = await service.generateActionableInsights(impact);

      expect(insights.length).toBeGreaterThan(0);
      expect(insights[0].title).toBe('Implement Data Governance Framework');
      expect(insights[0].description).toBe('Establish comprehensive data quality monitoring');
      expect(insights[0].insightId).toMatch(/^insight-/);
    });

    it('should calculate estimatedCost from resource requirements', async () => {
      const impact = buildBusinessImpact();
      const insights = await service.generateActionableInsights(impact);

      // Single resource with cost 120000
      expect(insights[0].estimatedCost).toBe(120_000);
    });

    it('should calculate expectedBenefit from estimatedROI', async () => {
      const impact = buildBusinessImpact();
      const insights = await service.generateActionableInsights(impact);

      // 250 * 1000 = 250000
      expect(insights[0].expectedBenefit).toBe(250_000);
    });

    it('should include success metrics', async () => {
      const impact = buildBusinessImpact();
      const insights = await service.generateActionableInsights(impact);

      expect(insights[0].successMetrics).toEqual(
        expect.arrayContaining([expect.stringContaining('ROI')])
      );
    });

    it('should generate compliance insights', async () => {
      const compliance = buildComplianceResult({
        recommendations: [
          {
            title: 'Implement GDPR controls',
            description: 'Enhance data protection measures',
            regulation: 'GDPR',
            riskReduction: 0.4,
            implementation: {
              phases: [
                {
                  name: 'Assessment',
                  description: 'Assess current state',
                  duration: 30,
                  cost: 20_000,
                  deliverables: ['Assessment report'],
                  dependencies: [],
                },
              ],
              totalDuration: 30,
              totalCost: 20_000,
              dependencies: [],
              successMetrics: ['GDPR compliance score > 95%'],
            },
          },
        ] as any,
      });

      const insights = await service.generateActionableInsights(undefined, compliance);

      expect(insights.length).toBe(1);
      expect(insights[0].category).toBe('compliance');
      expect(insights[0].title).toBe('Implement GDPR controls');
      expect(insights[0].businessImpact).toContain('GDPR');
      expect(insights[0].estimatedCost).toBe(20_000);
      // riskReduction * 100000 = 40000
      expect(insights[0].expectedBenefit).toBe(40_000);
    });

    it('should set high effort for compliance with > 2 phases', async () => {
      const compliance = buildComplianceResult({
        recommendations: [
          {
            title: 'Complex compliance update',
            description: 'Multi-phase effort',
            regulation: 'SOX',
            riskReduction: 0.5,
            implementation: {
              phases: [
                { name: 'P1', description: 'd', duration: 10, cost: 10_000, deliverables: [], dependencies: [] },
                { name: 'P2', description: 'd', duration: 10, cost: 10_000, deliverables: [], dependencies: [] },
                { name: 'P3', description: 'd', duration: 10, cost: 10_000, deliverables: [], dependencies: [] },
              ],
              totalDuration: 30,
              totalCost: 30_000,
              dependencies: [],
              successMetrics: ['Metric 1'],
            },
          },
        ] as any,
      });

      const insights = await service.generateActionableInsights(undefined, compliance);
      expect(insights[0].implementationEffort).toBe('high');
    });

    it('should return empty array when no data provided', async () => {
      const insights = await service.generateActionableInsights();
      expect(insights).toEqual([]);
    });

    it('should return empty array when business impact has no recommendations', async () => {
      const impact = buildBusinessImpact({ recommendations: undefined });
      const insights = await service.generateActionableInsights(impact);
      expect(insights).toEqual([]);
    });
  });

  // --- generateEnhancedRiskAssessment ---

  describe('generateEnhancedRiskAssessment', () => {
    it('should return risk assessment with operational and compliance categories', async () => {
      const impact = buildBusinessImpact();
      const compliance = buildComplianceResult();

      const result = await service.generateEnhancedRiskAssessment(impact, compliance);

      expect(result.riskCategories).toHaveLength(2);
      expect(result.riskCategories[0].category).toBe('operational');
      expect(result.riskCategories[1].category).toBe('compliance');
    });

    it('should calculate overall risk score as average of categories', async () => {
      const result = await service.generateEnhancedRiskAssessment();

      const expectedAvg = Math.round(
        result.riskCategories.reduce((sum, cat) => sum + cat.riskScore, 0) / result.riskCategories.length
      );
      expect(result.overallRiskScore).toBe(expectedAvg);
    });

    it('should generate mitigation strategies for each category', async () => {
      const result = await service.generateEnhancedRiskAssessment();

      expect(result.mitigationStrategies).toHaveLength(2);
      expect(result.mitigationStrategies[0].riskCategory).toBe('operational');
      expect(result.mitigationStrategies[1].riskCategory).toBe('compliance');
    });

    it('should generate risk matrix entries from business impact risk categories', async () => {
      const impact = buildBusinessImpact();
      const result = await service.generateEnhancedRiskAssessment(impact);

      expect(result.riskMatrix.length).toBeGreaterThan(0);
      expect(result.riskMatrix[0].riskId).toBe('risk-operational');
    });

    it('should return empty risk matrix when no business impact', async () => {
      const result = await service.generateEnhancedRiskAssessment();
      expect(result.riskMatrix).toEqual([]);
    });

    it('should generate compliance risk summary from regulations', async () => {
      const compliance = buildComplianceResult();
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance);

      expect(result.complianceRisks.length).toBe(2);
      expect(result.complianceRisks[0].regulation).toBe('GDPR');
      expect(result.complianceRisks[0].targetComplianceLevel).toBe(0.95);
      expect(result.complianceRisks[0].gaps).toBe(2);
    });

    it('should return empty compliance risks when no compliance data', async () => {
      const result = await service.generateEnhancedRiskAssessment();
      expect(result.complianceRisks).toEqual([]);
    });

    it('should filter high and critical severity gaps for priorityActions', async () => {
      const compliance = buildComplianceResult();
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance);

      // GDPR has 1 high gap, SOX has 1 critical gap
      const gdpr = result.complianceRisks.find(r => r.regulation === 'GDPR');
      expect(gdpr!.priorityActions).toEqual(['Missing data subject access request process']);

      const sox = result.complianceRisks.find(r => r.regulation === 'SOX');
      expect(sox!.priorityActions).toEqual(['Insufficient audit trail logging']);
    });

    it('should set compliance category risk level to high when overallCompliance < 0.8', async () => {
      const compliance = buildComplianceResult({ overallCompliance: 0.60 });
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance);

      const complianceCategory = result.riskCategories.find(c => c.category === 'compliance');
      expect(complianceCategory!.currentRiskLevel).toBe('high');
    });

    it('should set compliance category risk level to medium when overallCompliance >= 0.8', async () => {
      const compliance = buildComplianceResult({ overallCompliance: 0.85 });
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance);

      const complianceCategory = result.riskCategories.find(c => c.category === 'compliance');
      expect(complianceCategory!.currentRiskLevel).toBe('medium');
    });

    it('should extract operational risk level from business impact', async () => {
      const impact = buildBusinessImpact();
      (impact.riskAssessment as any).overallRiskLevel = 'high';
      const result = await service.generateEnhancedRiskAssessment(impact);

      const operational = result.riskCategories.find(c => c.category === 'operational');
      expect(operational!.currentRiskLevel).toBe('high');
    });

    it('should default operational risk to medium when no business impact', async () => {
      const result = await service.generateEnhancedRiskAssessment();

      const operational = result.riskCategories.find(c => c.category === 'operational');
      expect(operational!.currentRiskLevel).toBe('medium');
    });
  });

  // --- generatePrioritizedRecommendations ---

  describe('generatePrioritizedRecommendations', () => {
    it('should generate recommendations from business impact', async () => {
      const impact = buildBusinessImpact();
      const recs = await service.generatePrioritizedRecommendations(impact);

      expect(recs.length).toBeGreaterThan(0);
      expect(recs[0].recommendationId).toMatch(/^bi-/);
      expect(recs[0].title).toBe('Implement Data Governance Framework');
    });

    it('should include implementation plan in each recommendation', async () => {
      const impact = buildBusinessImpact();
      const recs = await service.generatePrioritizedRecommendations(impact);

      const plan = recs[0].implementationPlan;
      expect(plan.phases).toBeDefined();
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.totalDuration).toBeDefined();
      expect(plan.totalCost).toBeDefined();
      expect(plan.milestones.length).toBeGreaterThan(0);
      expect(plan.riskMitigation.length).toBeGreaterThan(0);
    });

    it('should generate recommendations from compliance', async () => {
      const compliance = buildComplianceResult({
        recommendations: [
          {
            priority: 'critical',
            title: 'Fix audit logging',
            description: 'Implement comprehensive audit trail',
            regulation: 'SOX',
            riskReduction: 0.6,
            implementation: {
              phases: [
                {
                  name: 'Design',
                  description: 'Design audit system',
                  duration: 30,
                  cost: 25_000,
                  deliverables: ['Design doc'],
                  dependencies: [],
                },
              ],
              totalDuration: 30,
              totalCost: 25_000,
              resourceRequirements: [
                { type: 'human', description: 'Security engineer', quantity: 1, duration: 30, cost: 25_000 },
              ],
              dependencies: [],
              successMetrics: ['SOX audit pass rate > 95%'],
            },
          },
        ] as any,
      });

      const recs = await service.generatePrioritizedRecommendations(undefined, compliance);

      expect(recs.length).toBe(1);
      expect(recs[0].recommendationId).toMatch(/^comp-/);
      expect(recs[0].priority).toBe('critical');
      expect(recs[0].category).toBe('short-term');
      expect(recs[0].businessJustification).toContain('SOX');
    });

    it('should sort recommendations by priority (critical first)', async () => {
      const impact = buildBusinessImpact({
        recommendations: [
          {
            priority: 'low',
            title: 'Low priority',
            description: 'desc',
            businessJustification: 'just',
            estimatedROI: 50,
            implementationTimeframe: '12 months',
            riskLevel: 'low',
            dependsOn: [],
          },
          {
            priority: 'critical',
            title: 'Critical priority',
            description: 'desc',
            businessJustification: 'just',
            estimatedROI: 500,
            implementationTimeframe: '1 month',
            riskLevel: 'high',
            dependsOn: [],
          },
        ],
      });

      const recs = await service.generatePrioritizedRecommendations(impact);

      expect(recs[0].priority).toBe('critical');
      expect(recs[1].priority).toBe('low');
    });

    it('should return empty array when no data provided', async () => {
      const recs = await service.generatePrioritizedRecommendations();
      expect(recs).toEqual([]);
    });

    it('should combine business and compliance recommendations', async () => {
      const impact = buildBusinessImpact();
      const compliance = buildComplianceResult({
        recommendations: [
          {
            priority: 'high',
            title: 'Compliance rec',
            description: 'desc',
            regulation: 'GDPR',
            riskReduction: 0.3,
            implementation: {
              phases: [],
              totalDuration: 30,
              totalCost: 15_000,
              resourceRequirements: [],
              dependencies: [],
              successMetrics: ['Metric'],
            },
          },
        ] as any,
      });

      const recs = await service.generatePrioritizedRecommendations(impact, compliance);

      const biRecs = recs.filter(r => r.recommendationId.startsWith('bi-'));
      const compRecs = recs.filter(r => r.recommendationId.startsWith('comp-'));
      expect(biRecs.length).toBeGreaterThan(0);
      expect(compRecs.length).toBeGreaterThan(0);
    });

    it('should handle compliance recommendation with skills array', async () => {
      const compliance = buildComplianceResult({
        recommendations: [
          {
            priority: 'medium',
            title: 'Skill-based rec',
            description: 'desc',
            regulation: 'HIPAA',
            riskReduction: 0.2,
            implementation: {
              phases: [],
              totalDuration: 60,
              totalCost: 50_000,
              resourceRequirements: [
                { type: 'human', description: 'Specialist', quantity: 1, duration: 60, cost: 50_000, skills: ['HIPAA', 'Security'] },
              ],
              dependencies: ['Management approval'],
              successMetrics: ['HIPAA compliance'],
            },
          },
        ] as any,
      });

      const recs = await service.generatePrioritizedRecommendations(undefined, compliance);

      expect(recs[0].implementationPlan.resourceRequirements[0].skillsRequired).toEqual(['HIPAA', 'Security']);
    });

    it('should default skillsRequired to empty array when skills not provided', async () => {
      const compliance = buildComplianceResult({
        recommendations: [
          {
            priority: 'medium',
            title: 'No skills rec',
            description: 'desc',
            regulation: 'PCI',
            riskReduction: 0.1,
            implementation: {
              phases: [],
              totalDuration: 30,
              totalCost: 10_000,
              resourceRequirements: [
                { type: 'technical', description: 'Tool', quantity: 1, duration: 30, cost: 10_000 },
              ],
              dependencies: [],
              successMetrics: ['PCI compliance'],
            },
          },
        ] as any,
      });

      const recs = await service.generatePrioritizedRecommendations(undefined, compliance);

      expect(recs[0].implementationPlan.resourceRequirements[0].skillsRequired).toEqual([]);
    });
  });
});
