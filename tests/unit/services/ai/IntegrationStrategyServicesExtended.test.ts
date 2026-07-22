/**
 * Comprehensive tests for integration-strategy sub-services:
 * ComplexityAnalysisService, ResourceEstimationService,
 * SecurityAnalysisService, RiskManagementService, PerformanceAnalysisService
 */

import { ComplexityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ComplexityAnalysisService';
import { ResourceEstimationService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ResourceEstimationService';
import { SecurityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/SecurityAnalysisService';
import { RiskManagementService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/RiskManagementService';
import { PerformanceAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/PerformanceAnalysisService';

/* ────────────── ComplexityAnalysisService ────────────── */

describe('ComplexityAnalysisService', () => {
  let service: ComplexityAnalysisService;

  beforeEach(() => {
    service = new ComplexityAnalysisService();
  });

  const source = { name: 'Salesforce', type: 'crm', limitations: ['rate-limit'] };
  const target = { name: 'NetSuite', type: 'erp', limitations: ['batch-processing'] };

  it('should analyze complexity between two systems', () => {
    const result = service.analyzeComplexity(source, target);
    expect(result.overallComplexity).toBeDefined();
    expect(result.technicalComplexity).toBeGreaterThan(0);
    expect(result.businessComplexity).toBeGreaterThan(0);
    expect(result.organizationalComplexity).toBeDefined();
  });

  it('should return medium for typical systems', () => {
    const result = service.analyzeComplexity(source, target);
    expect(result.overallComplexity).toBe('medium');
  });

  it('should increase complexity for file-type systems', () => {
    const fileSource = { name: 'CSV', type: 'file', limitations: [] };
    const result = service.analyzeComplexity(fileSource, target);
    expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.6);
  });

  it('should increase complexity for systems with many limitations', () => {
    const limitedSource = { name: 'Legacy', limitations: ['a', 'b', 'c', 'd'] };
    const result = service.analyzeComplexity(limitedSource, target);
    expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.7);
  });

  it('should identify complexity factors for limited systems', () => {
    const limitedSource = { name: 'Legacy', limitations: ['a', 'b', 'c', 'd'] };
    const result = service.analyzeComplexity(limitedSource, target);
    expect(result.complexityFactors.length).toBeGreaterThan(0);
    expect(result.complexityFactors[0].impact).toBe('medium');
  });

  it('should return no factors for simple systems', () => {
    const result = service.analyzeComplexity(source, target);
    expect(result.complexityFactors).toEqual([]);
    expect(result.simplificationOpportunities).toEqual([]);
  });

  it('should provide simplification opportunities per factor', () => {
    const limitedSource = { name: 'Legacy', limitations: ['a', 'b', 'c', 'd'] };
    const result = service.analyzeComplexity(limitedSource, target);
    expect(result.simplificationOpportunities.length).toBe(result.complexityFactors.length);
  });

  it('should increase complexity when no API support', () => {
    const noApiSource = { name: 'X', apiSupport: [] as unknown[] };
    const result = service.analyzeComplexity(noApiSource, target);
    expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.6);
  });
});

/* ────────────── ResourceEstimationService ────────────── */

describe('ResourceEstimationService', () => {
  let service: ResourceEstimationService;

  beforeEach(() => {
    service = new ResourceEstimationService();
  });

  const assessment = {
    compatibility: { overallScore: 0.85 },
  } as any;

  const lowPattern = { complexity: 'low' as const } as any;
  const medPattern = { complexity: 'medium' as const } as any;
  const highPattern = { complexity: 'high' as const } as any;

  describe('estimateCost', () => {
    it('should return base cost for low complexity', () => {
      expect(service.estimateCost(lowPattern, assessment)).toBe(25000);
    });

    it('should multiply cost for medium complexity', () => {
      expect(service.estimateCost(medPattern, assessment)).toBe(37500);
    });

    it('should multiply cost for high complexity', () => {
      expect(service.estimateCost(highPattern, assessment)).toBe(62500);
    });

    it('should add 30% for low compatibility', () => {
      const lowCompat = { compatibility: { overallScore: 0.5 } } as any;
      const cost = service.estimateCost(lowPattern, lowCompat);
      expect(cost).toBe(32500);
    });
  });

  describe('estimateTime', () => {
    it('should return base time for low complexity', () => {
      expect(service.estimateTime(lowPattern, assessment)).toBe(60);
    });

    it('should multiply time for medium complexity', () => {
      expect(service.estimateTime(medPattern, assessment)).toBe(90);
    });

    it('should multiply time for high complexity', () => {
      expect(service.estimateTime(highPattern, assessment)).toBe(120);
    });

    it('should add 20% for low compatibility', () => {
      const lowCompat = { compatibility: { overallScore: 0.5 } } as any;
      const time = service.estimateTime(lowPattern, lowCompat);
      expect(time).toBe(72);
    });
  });
});

/* ────────────── SecurityAnalysisService ────────────── */

describe('SecurityAnalysisService', () => {
  let service: SecurityAnalysisService;

  beforeEach(() => {
    service = new SecurityAnalysisService();
  });

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    version: '3.0',
    securityLevel: 'standard' as const,
    apiSupport: [{ authentication: ['oauth', 'basic'] }],
    ...overrides,
  });

  it('should analyze security between two systems', () => {
    const result = service.analyzeSecurity(makeSystem(), makeSystem());
    expect(result.overallRiskLevel).toBeDefined();
    expect(result.threatAssessment).toBeDefined();
    expect(result.vulnerabilities).toBeDefined();
    expect(result.complianceRequirements).toBeDefined();
    expect(result.securityControls).toBeDefined();
    expect(result.recommendations).toBeDefined();
  });

  it('should detect threats when no oauth on source', () => {
    const noOauth = makeSystem({ apiSupport: [{ authentication: ['basic'] }] });
    const result = service.analyzeSecurity(noOauth, makeSystem());
    expect(result.threatAssessment.threats.length).toBeGreaterThan(0);
    expect(result.threatAssessment.attackVectors.length).toBeGreaterThan(0);
  });

  it('should have no threats when both have oauth', () => {
    const result = service.analyzeSecurity(makeSystem(), makeSystem());
    expect(result.threatAssessment.threats).toEqual([]);
  });

  it('should identify vulnerability for old version', () => {
    const oldSystem = makeSystem({ version: '1.5' });
    const result = service.analyzeSecurity(oldSystem, makeSystem());
    expect(result.vulnerabilities.length).toBeGreaterThan(0);
    expect(result.vulnerabilities[0].severity).toBe('medium');
  });

  it('should add compliance requirements for enterprise systems', () => {
    const enterprise = makeSystem({ securityLevel: 'enterprise' });
    const result = service.analyzeSecurity(enterprise, makeSystem());
    expect(result.complianceRequirements.length).toBeGreaterThan(0);
    expect(result.complianceRequirements[0].regulation).toBe('SOX');
  });

  it('should always include encryption control', () => {
    const result = service.analyzeSecurity(makeSystem(), makeSystem());
    expect(result.securityControls.length).toBeGreaterThan(0);
    expect(result.securityControls[0].control).toContain('Encryption');
  });

  it('should always include infrastructure recommendation', () => {
    const result = service.analyzeSecurity(makeSystem(), makeSystem());
    expect(result.recommendations.length).toBeGreaterThan(0);
    expect(result.recommendations[0].category).toBe('infrastructure');
  });

  it('should return low risk for secure systems', () => {
    const result = service.analyzeSecurity(makeSystem(), makeSystem());
    expect(result.overallRiskLevel).toBe('low');
  });

  it('should return high compliance impact for enterprise', () => {
    const enterprise = makeSystem({ securityLevel: 'enterprise', apiSupport: [{ authentication: ['basic'] }] });
    const result = service.analyzeSecurity(enterprise, makeSystem());
    expect(result.threatAssessment.businessImpact.complianceImpact).toBe('high');
  });
});

/* ────────────── RiskManagementService ────────────── */

describe('RiskManagementService', () => {
  let service: RiskManagementService;

  beforeEach(() => {
    service = new RiskManagementService();
  });

  const makeInput = (overrides: Record<string, any> = {}) => ({
    sourceSystemProfile: { name: 'SF', securityLevel: 'standard' },
    targetSystemProfile: { name: 'NS', securityLevel: 'standard' },
    ...overrides,
  });

  const makeAssessment = (overrides: Record<string, any> = {}) => ({
    compatibility: { overallScore: 0.85 },
    ...overrides,
  });

  it('should assess all risk categories', async () => {
    const risks = await service.assessIntegrationRisks(makeInput() as any, makeAssessment() as any);
    expect(risks.length).toBeGreaterThan(0);
    const categories = risks.map(r => r.category);
    expect(categories).toContain('data');
    expect(categories).toContain('performance');
    expect(categories).toContain('operational');
  });

  it('should identify technical risk for low compatibility', async () => {
    const lowCompat = makeAssessment({ compatibility: { overallScore: 0.5 } });
    const risks = await service.assessIntegrationRisks(makeInput() as any, lowCompat as any);
    const techRisks = risks.filter(r => r.description.includes('compatibility'));
    expect(techRisks.length).toBeGreaterThan(0);
  });

  it('should identify security risk for security level mismatch', async () => {
    const input = makeInput({
      sourceSystemProfile: { name: 'SF', securityLevel: 'enterprise' },
      targetSystemProfile: { name: 'NS', securityLevel: 'standard' },
    });
    const risks = await service.assessIntegrationRisks(input as any, makeAssessment() as any);
    const secRisks = risks.filter(r => r.category === 'security');
    expect(secRisks.length).toBeGreaterThan(0);
  });

  it('should not add security risk when levels match', async () => {
    const risks = await service.assessIntegrationRisks(makeInput() as any, makeAssessment() as any);
    const secRisks = risks.filter(r => r.category === 'security');
    expect(secRisks).toEqual([]);
  });

  it('should calculate overall risk', () => {
    const risks = [
      { impact: 'low' as const },
      { impact: 'medium' as const },
      { impact: 'high' as const },
    ] as any[];
    const overall = service.calculateOverallRisk(risks);
    expect(overall).toBeCloseTo(0.5);
  });

  it('should return 0 for empty risks', () => {
    expect(service.calculateOverallRisk([])).toBe(0);
  });

  it('should detect high risks', () => {
    const risks = [{ impact: 'high', probability: 'low' }] as any[];
    expect(service.hasHighRisks(risks)).toBe(true);
  });

  it('should detect high probability as high risk', () => {
    const risks = [{ impact: 'low', probability: 'high' }] as any[];
    expect(service.hasHighRisks(risks)).toBe(true);
  });

  it('should return false when no high risks', () => {
    const risks = [{ impact: 'low', probability: 'low' }] as any[];
    expect(service.hasHighRisks(risks)).toBe(false);
  });
});

/* ────────────── PerformanceAnalysisService ────────────── */

describe('PerformanceAnalysisService', () => {
  let service: PerformanceAnalysisService;

  beforeEach(() => {
    service = new PerformanceAnalysisService();
  });

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    type: 'crm',
    dataVolume: { recordCount: 5000, growthRate: 0.1 },
    ...overrides,
  });

  it('should return full performance analysis', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    expect(result.currentPerformance).toBeDefined();
    expect(result.performanceRequirements).toBeDefined();
    expect(result.performanceGaps).toBeDefined();
    expect(result.optimizationOpportunities).toBeDefined();
    expect(result.performanceRisks).toBeDefined();
  });

  it('should include response time and throughput requirements', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    expect(result.performanceRequirements.length).toBeGreaterThanOrEqual(2);
    const metrics = result.performanceRequirements.map(r => r.metric);
    expect(metrics).toContain('Response Time');
    expect(metrics).toContain('Throughput');
  });

  it('should calculate throughput from data volume', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    expect(result.currentPerformance.throughput).toBeCloseTo(5000 / 3600, 1);
  });

  it('should default throughput for unknown data volume', () => {
    const sys = makeSystem({ dataVolume: undefined });
    const result = service.analyzePerformance(sys as any, makeSystem() as any);
    expect(result.currentPerformance.throughput).toBeCloseTo(1000 / 3600, 1);
  });

  it('should have no gaps when performance is good', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    // Default response time is 200ms, well under 2000ms threshold
    expect(result.performanceGaps).toEqual([]);
  });

  it('should include optimization opportunities', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    expect(result.optimizationOpportunities.length).toBeGreaterThan(0);
    expect(result.optimizationOpportunities[0].area).toBe('Data Transfer');
  });

  it('should include performance risks', () => {
    const result = service.analyzePerformance(makeSystem() as any, makeSystem() as any);
    expect(result.performanceRisks.length).toBeGreaterThan(0);
    expect(result.performanceRisks[0].risk).toContain('Volume');
  });
});
