/**
 * Comprehensive tests for InsightsGeneratorService
 * Covers: generateExecutiveSummary, generateActionableInsights,
 *         generateEnhancedRiskAssessment, generatePrioritizedRecommendations
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

import { InsightsGeneratorService } from '../../../../src/services/ai/orchestrator/agents/intelligence/InsightsGeneratorService';

describe('InsightsGeneratorService', () => {
  let service: InsightsGeneratorService;
  let mockMetricsService: Record<string, jest.Mock>;

  const makeBusinessImpact = (overrides: Record<string, any> = {}) => ({
    overallScore: 80,
    businessValue: {
      currentState: { dataQualityScore: 0.75, processEfficiency: 0.7 },
      potentialImprovements: { qualityGainPercentage: 0.25, efficiencyGainPercentage: 0.2 },
      monetaryImpact: { annualSavings: 150000, revenueOpportunity: 800000, implementationCost: 100000 },
    },
    riskAssessment: {
      overallRiskLevel: 'medium',
      riskCategories: [
        { category: 'operational', description: 'Operational risk', likelihood: 0.6, impact: 0.7, riskScore: 42 },
      ],
    },
    recommendations: [
      {
        priority: 'high',
        category: 'data_quality',
        title: 'Improve Quality',
        description: 'Improve data quality',
        businessJustification: 'Better decisions',
        implementationSteps: ['Assess', 'Design', 'Implement'],
        estimatedROI: 250,
        implementationTimeframe: '6 months',
        riskLevel: 'low',
        dependsOn: [],
        resourceRequirements: [
          { type: 'human', description: 'Analyst', quantity: 1, cost: 120000, duration: 180, skillsRequired: [] },
        ],
      },
    ],
    ...overrides,
  });

  const makeCompliance = (overrides: Record<string, any> = {}) => ({
    overallCompliance: 0.85,
    criticalIssues: [],
    regulations: [
      {
        regulation: 'GDPR',
        complianceScore: 0.8,
        gaps: [{ severity: 'high', description: 'Data retention gap' }],
        estimatedFineExposure: 500000,
      },
    ],
    recommendations: [
      {
        priority: 'high',
        title: 'GDPR Compliance',
        description: 'Improve GDPR compliance',
        regulation: 'GDPR',
        riskReduction: 0.3,
        implementation: {
          phases: [
            { name: 'Assess', description: 'Assessment', duration: 30, cost: 20000, deliverables: ['Report'], dependencies: [] },
            { name: 'Implement', description: 'Implementation', duration: 60, cost: 50000, deliverables: ['Controls'], dependencies: [] },
          ],
          totalDuration: 90,
          totalCost: 70000,
          resourceRequirements: [
            { type: 'human', description: 'Compliance officer', quantity: 1, duration: 90, cost: 50000 },
          ],
          dependencies: ['Budget approval'],
          successMetrics: ['Compliance score > 95%'],
        },
      },
    ],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockMetricsService = {
      calculateOverallScore: jest.fn().mockReturnValue(80),
      determineOverallRiskLevel: jest.fn().mockReturnValue('medium'),
      generateRecommendedActions: jest.fn().mockReturnValue(['Improve Quality']),
      mapEffortLevel: jest.fn().mockReturnValue('medium'),
      calculateImplementationTime: jest.fn().mockReturnValue(45),
      calculateRiskScore: jest.fn().mockImplementation((l, i) => Math.round(l * i * 100)),
      mapLikelihood: jest.fn().mockReturnValue('high'),
      mapImpact: jest.fn().mockReturnValue('major'),
      mapTimeframe: jest.fn().mockReturnValue('medium-term'),
    };
    service = new (InsightsGeneratorService as any)(mockLogger, mockMetricsService);
  });

  /* ────────────── generateExecutiveSummary ────────────── */

  describe('generateExecutiveSummary', () => {
    it('should return complete executive summary', async () => {
      const result = await service.generateExecutiveSummary(
        makeBusinessImpact() as any,
        undefined,
        makeCompliance() as any
      );
      expect(result.overallScore).toBeDefined();
      expect(result.keyFindings).toBeDefined();
      expect(result.businessValue).toBeDefined();
      expect(result.riskLevel).toBeDefined();
      expect(result.recommendedActions).toBeDefined();
    });

    it('should generate key finding from business impact', async () => {
      const result = await service.generateExecutiveSummary(makeBusinessImpact() as any);
      const oppFindings = result.keyFindings.filter(f => f.category === 'opportunity');
      expect(oppFindings.length).toBe(1);
      expect(oppFindings[0].title).toContain('Data Quality');
    });

    it('should flag high impact when quality < 0.7', async () => {
      const bi = makeBusinessImpact({
        businessValue: {
          currentState: { dataQualityScore: 0.5 },
          monetaryImpact: { annualSavings: 100000 },
        },
      });
      const result = await service.generateExecutiveSummary(bi as any);
      const oppFinding = result.keyFindings.find(f => f.category === 'opportunity');
      expect(oppFinding!.impact).toBe('high');
    });

    it('should generate compliance key finding', async () => {
      const result = await service.generateExecutiveSummary(
        undefined,
        undefined,
        makeCompliance() as any
      );
      const compFindings = result.keyFindings.filter(f => f.category === 'compliance');
      expect(compFindings.length).toBe(1);
      expect(compFindings[0].description).toContain('85%');
    });

    it('should flag high compliance impact when < 0.8', async () => {
      const compliance = makeCompliance({ overallCompliance: 0.6 });
      const result = await service.generateExecutiveSummary(undefined, undefined, compliance as any);
      const compFinding = result.keyFindings.find(f => f.category === 'compliance');
      expect(compFinding!.impact).toBe('high');
    });

    it('should use default investment cost when not in businessImpact', async () => {
      const bi = makeBusinessImpact({ businessValue: { currentState: { dataQualityScore: 0.8 }, monetaryImpact: {} } });
      const result = await service.generateExecutiveSummary(bi as any);
      expect(result.investmentRequired).toBe(100000); // default
    });

    it('should extract investment cost from businessImpact', async () => {
      const bi = makeBusinessImpact({
        businessValue: {
          currentState: { dataQualityScore: 0.8 },
          monetaryImpact: { annualSavings: 150000, implementationCost: 250000 },
        },
      });
      const result = await service.generateExecutiveSummary(bi as any);
      expect(result.investmentRequired).toBe(250000);
    });

    it('should extract projected ROI from roi param', async () => {
      const roi = { riskAdjustedROI: 300 } as any;
      const result = await service.generateExecutiveSummary(undefined, roi);
      expect(result.projectedROI).toBe(300);
    });

    it('should use default ROI 250 when no roi param', async () => {
      const result = await service.generateExecutiveSummary();
      expect(result.projectedROI).toBe(250);
    });

    it('should calculate business value summary with defaults', async () => {
      const result = await service.generateExecutiveSummary();
      expect(result.businessValue.currentStateScore).toBe(75);
      expect(result.businessValue.potentialImprovementScore).toBe(25);
    });

    it('should calculate business value from impact data', async () => {
      const result = await service.generateExecutiveSummary(makeBusinessImpact() as any);
      expect(result.businessValue.currentStateScore).toBe(75); // 0.75 * 100
      expect(result.businessValue.potentialImprovementScore).toBe(25); // 0.25 * 100
      expect(result.businessValue.annualSavingsOpportunity).toBe(150000);
    });
  });

  /* ────────────── generateActionableInsights ────────────── */

  describe('generateActionableInsights', () => {
    it('should return empty when no inputs', async () => {
      const result = await service.generateActionableInsights();
      expect(result).toEqual([]);
    });

    it('should generate insights from business impact recommendations', async () => {
      const result = await service.generateActionableInsights(makeBusinessImpact() as any);
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('Improve Quality');
      expect(result[0].riskLevel).toBe('low');
    });

    it('should generate insights from compliance recommendations', async () => {
      const result = await service.generateActionableInsights(undefined, makeCompliance() as any);
      expect(result.length).toBe(1);
      expect(result[0].category).toBe('compliance');
      expect(result[0].title).toBe('GDPR Compliance');
    });

    it('should combine BI and compliance insights', async () => {
      const result = await service.generateActionableInsights(
        makeBusinessImpact() as any,
        makeCompliance() as any
      );
      expect(result.length).toBe(2);
    });

    it('should calculate cost from resource requirements', async () => {
      const result = await service.generateActionableInsights(makeBusinessImpact() as any);
      expect(result[0].estimatedCost).toBe(120000); // 1 resource at 120K
    });

    it('should calculate expected benefit from ROI', async () => {
      const result = await service.generateActionableInsights(makeBusinessImpact() as any);
      expect(result[0].expectedBenefit).toBe(250000); // 250 * 1000
    });

    it('should set compliance insight effort based on phases', async () => {
      // 2 phases → not > 2 → medium
      const result = await service.generateActionableInsights(undefined, makeCompliance() as any);
      expect(result[0].implementationEffort).toBe('medium');
    });

    it('should set high effort for > 2 compliance phases', async () => {
      const compliance = makeCompliance({
        recommendations: [{
          ...makeCompliance().recommendations[0],
          implementation: {
            ...makeCompliance().recommendations[0].implementation,
            phases: [
              { name: 'P1', description: 'd', duration: 10, cost: 10000, deliverables: [], dependencies: [] },
              { name: 'P2', description: 'd', duration: 10, cost: 10000, deliverables: [], dependencies: [] },
              { name: 'P3', description: 'd', duration: 10, cost: 10000, deliverables: [], dependencies: [] },
            ],
          },
        }],
      });
      const result = await service.generateActionableInsights(undefined, compliance as any);
      expect(result[0].implementationEffort).toBe('high');
    });
  });

  /* ────────────── generateEnhancedRiskAssessment ────────────── */

  describe('generateEnhancedRiskAssessment', () => {
    it('should return complete risk assessment structure', async () => {
      const result = await service.generateEnhancedRiskAssessment(
        makeBusinessImpact() as any,
        makeCompliance() as any
      );
      expect(result.overallRiskScore).toBeDefined();
      expect(result.riskCategories.length).toBe(2);
      expect(result.mitigationStrategies).toBeDefined();
      expect(result.riskMatrix).toBeDefined();
      expect(result.complianceRisks).toBeDefined();
    });

    it('should include operational and compliance risk categories', async () => {
      const result = await service.generateEnhancedRiskAssessment(
        makeBusinessImpact() as any,
        makeCompliance() as any
      );
      const categories = result.riskCategories.map(c => c.category);
      expect(categories).toContain('operational');
      expect(categories).toContain('compliance');
    });

    it('should set compliance risk level high when overall < 0.8', async () => {
      const compliance = makeCompliance({ overallCompliance: 0.6 });
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance as any);
      const compCat = result.riskCategories.find(c => c.category === 'compliance');
      expect(compCat!.currentRiskLevel).toBe('high');
    });

    it('should set compliance risk level medium when overall >= 0.8', async () => {
      const compliance = makeCompliance({ overallCompliance: 0.9 });
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance as any);
      const compCat = result.riskCategories.find(c => c.category === 'compliance');
      expect(compCat!.currentRiskLevel).toBe('medium');
    });

    it('should calculate overallRiskScore as average of category scores', async () => {
      const result = await service.generateEnhancedRiskAssessment(
        makeBusinessImpact() as any,
        makeCompliance() as any
      );
      const avg = Math.round(
        result.riskCategories.reduce((sum, c) => sum + c.riskScore, 0) / result.riskCategories.length
      );
      expect(result.overallRiskScore).toBe(avg);
    });

    it('should generate mitigation strategies for each category', async () => {
      const result = await service.generateEnhancedRiskAssessment(
        makeBusinessImpact() as any,
        makeCompliance() as any
      );
      expect(result.mitigationStrategies.length).toBe(2);
    });

    it('should generate risk matrix from business impact risk categories', async () => {
      const result = await service.generateEnhancedRiskAssessment(makeBusinessImpact() as any);
      expect(result.riskMatrix.length).toBe(1);
      expect(result.riskMatrix[0].description).toContain('Operational');
    });

    it('should generate compliance risk summary', async () => {
      const result = await service.generateEnhancedRiskAssessment(
        undefined,
        makeCompliance() as any
      );
      expect(result.complianceRisks.length).toBe(1);
      expect(result.complianceRisks[0].regulation).toBe('GDPR');
      expect(result.complianceRisks[0].gaps).toBe(1);
    });

    it('should return empty compliance risks when no compliance', async () => {
      const result = await service.generateEnhancedRiskAssessment();
      expect(result.complianceRisks).toEqual([]);
    });

    it('should extract critical issues from compliance', async () => {
      const compliance = makeCompliance({
        criticalIssues: [
          { description: 'Critical gap A' },
          { description: 'Critical gap B' },
        ],
      });
      const result = await service.generateEnhancedRiskAssessment(undefined, compliance as any);
      const compCat = result.riskCategories.find(c => c.category === 'compliance');
      expect(compCat!.keyRiskFactors).toContain('Critical gap A');
    });

    it('should default operational risk to medium when no business impact', async () => {
      const result = await service.generateEnhancedRiskAssessment();
      const opsCat = result.riskCategories.find(c => c.category === 'operational');
      expect(opsCat!.currentRiskLevel).toBe('medium');
    });
  });

  /* ────────────── generatePrioritizedRecommendations ────────────── */

  describe('generatePrioritizedRecommendations', () => {
    it('should return empty when no inputs', async () => {
      const result = await service.generatePrioritizedRecommendations();
      expect(result).toEqual([]);
    });

    it('should generate recommendations from business impact', async () => {
      const result = await service.generatePrioritizedRecommendations(makeBusinessImpact() as any);
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('Improve Quality');
      expect(result[0].priority).toBe('high');
    });

    it('should generate recommendations from compliance', async () => {
      const result = await service.generatePrioritizedRecommendations(
        undefined,
        makeCompliance() as any
      );
      expect(result.length).toBe(1);
      expect(result[0].title).toBe('GDPR Compliance');
    });

    it('should sort by priority (critical > high > medium > low)', async () => {
      const bi = makeBusinessImpact({
        recommendations: [
          { priority: 'low', title: 'Low', description: 'd', businessJustification: 'j', implementationSteps: [], estimatedROI: 10, implementationTimeframe: '12 months', riskLevel: 'low', dependsOn: [] },
          { priority: 'critical', title: 'Critical', description: 'd', businessJustification: 'j', implementationSteps: [], estimatedROI: 100, implementationTimeframe: '1 month', riskLevel: 'high', dependsOn: [] },
        ],
      });
      const result = await service.generatePrioritizedRecommendations(bi as any);
      expect(result[0].priority).toBe('critical');
      expect(result[1].priority).toBe('low');
    });

    it('should include implementation plan for BI recommendations', async () => {
      const result = await service.generatePrioritizedRecommendations(makeBusinessImpact() as any);
      expect(result[0].implementationPlan).toBeDefined();
      expect(result[0].implementationPlan.phases.length).toBe(1);
      expect(result[0].implementationPlan.totalDuration).toBe(90);
    });

    it('should include implementation plan for compliance recommendations', async () => {
      const result = await service.generatePrioritizedRecommendations(
        undefined,
        makeCompliance() as any
      );
      expect(result[0].implementationPlan).toBeDefined();
      expect(result[0].implementationPlan.phases.length).toBe(2);
      expect(result[0].implementationPlan.milestones.length).toBe(2);
    });

    it('should combine BI and compliance recommendations sorted', async () => {
      const bi = makeBusinessImpact({
        recommendations: [
          { priority: 'medium', title: 'BI Med', description: 'd', businessJustification: 'j', implementationSteps: [], estimatedROI: 50, implementationTimeframe: '6 months', riskLevel: 'low', dependsOn: [] },
        ],
      });
      const compliance = makeCompliance({
        recommendations: [{
          ...makeCompliance().recommendations[0],
          priority: 'critical',
        }],
      });
      const result = await service.generatePrioritizedRecommendations(bi as any, compliance as any);
      expect(result.length).toBe(2);
      expect(result[0].priority).toBe('critical'); // compliance critical first
    });
  });
});
