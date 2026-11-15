/**
 * Comprehensive tests for integration-strategy sub-services (batch 2):
 * MaintainabilityAnalysisService, ScalabilityAnalysisService, CompatibilityAnalysisService
 */

import { MaintainabilityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/MaintainabilityAnalysisService';
import { ScalabilityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ScalabilityAnalysisService';
import { CompatibilityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/CompatibilityAnalysisService';

/* ────────────── MaintainabilityAnalysisService ────────────── */

describe('MaintainabilityAnalysisService', () => {
  let service: MaintainabilityAnalysisService;

  beforeEach(() => {
    service = new MaintainabilityAnalysisService();
  });

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    version: '3.0',
    ...overrides,
  });

  it('should return full maintainability analysis', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.maintainabilityScore).toBeDefined();
    expect(result.codeQuality).toBeDefined();
    expect(result.technicalDebt).toBeDefined();
    expect(result.documentationQuality).toBeDefined();
    expect(result.testCoverage).toBeDefined();
    expect(result.maintainabilityRisks).toBeDefined();
  });

  it('should return code quality metrics', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.codeQuality.complexity).toBe(0.7);
    expect(result.codeQuality.duplication).toBe(0.1);
    expect(result.codeQuality.testability).toBe(0.8);
    expect(result.codeQuality.modularity).toBe(0.8);
    expect(result.codeQuality.coupling).toBe(0.3);
    expect(result.codeQuality.cohesion).toBe(0.8);
  });

  it('should return technical debt assessment', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.technicalDebt.overallDebt).toBe(0.3);
    expect(result.technicalDebt.debtCategories.length).toBeGreaterThan(0);
    expect(result.technicalDebt.debtCategories[0].category).toBe('architecture');
    expect(result.technicalDebt.debtCategories[0].priority).toBe('medium');
  });

  it('should include remediation plan', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    const plan = result.technicalDebt.remediationPlan;
    expect(plan.phases.length).toBeGreaterThan(0);
    expect(plan.totalEffort).toBe(40);
    expect(plan.totalCost).toBe(15000);
    expect(plan.timeline).toBe(60);
  });

  it('should include remediation phase details', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    const phase = result.technicalDebt.remediationPlan.phases[0];
    expect(phase.phase).toBe(1);
    expect(phase.description).toBe('Architecture cleanup');
    expect(phase.effort).toBe(40);
    expect(phase.cost).toBe(15000);
    expect(phase.benefits.length).toBeGreaterThan(0);
    expect(phase.dependencies.length).toBeGreaterThan(0);
  });

  it('should include business impact', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.technicalDebt.businessImpact).toContain('Moderate');
  });

  it('should return documentation assessment', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.documentationQuality.completeness).toBe(0.7);
    expect(result.documentationQuality.accuracy).toBe(0.8);
    expect(result.documentationQuality.accessibility).toBe(0.6);
    expect(result.documentationQuality.maintenance).toBe(0.5);
  });

  it('should identify documentation gaps and recommendations', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.documentationQuality.gaps.length).toBeGreaterThan(0);
    expect(result.documentationQuality.recommendations.length).toBeGreaterThan(0);
    expect(result.documentationQuality.gaps[0]).toContain('API');
  });

  it('should return test coverage analysis', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.testCoverage.unitTestCoverage).toBe(75);
    expect(result.testCoverage.integrationTestCoverage).toBe(60);
    expect(result.testCoverage.e2eTestCoverage).toBe(40);
    expect(result.testCoverage.testQuality).toBe(0.7);
    expect(result.testCoverage.testAutomation).toBe(0.8);
  });

  it('should identify testing gaps', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.testCoverage.testingGaps.length).toBeGreaterThan(0);
  });

  it('should have no risks when versions are present', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(result.maintainabilityRisks).toEqual([]);
  });

  it('should detect risk when source version is missing', () => {
    const noVersion = makeSystem({ version: undefined });
    const result = service.analyzeMaintainability(noVersion as any, makeSystem() as any);
    expect(result.maintainabilityRisks.length).toBeGreaterThan(0);
    expect(result.maintainabilityRisks[0].risk).toContain('Version');
    expect(result.maintainabilityRisks[0].probability).toBe('medium');
  });

  it('should detect risk when target version is missing', () => {
    const noVersion = makeSystem({ version: undefined });
    const result = service.analyzeMaintainability(makeSystem() as any, noVersion as any);
    expect(result.maintainabilityRisks.length).toBeGreaterThan(0);
  });

  it('should calculate maintainability score correctly for no-risk case', () => {
    const result = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    // techDebtScore = (1 - 0.3) * 0.3 = 0.21
    // docScore = 0.7 * 0.3 = 0.21
    // testScore = (75 / 100) * 0.3 = 0.225
    // riskPenalty = 0 * 0.05 = 0
    // total = 0.21 + 0.21 + 0.225 = 0.645
    expect(result.maintainabilityScore).toBeCloseTo(0.645, 2);
  });

  it('should reduce score when risks exist', () => {
    const noVersion = makeSystem({ version: undefined });
    const withRisk = service.analyzeMaintainability(noVersion as any, makeSystem() as any);
    const noRisk = service.analyzeMaintainability(makeSystem() as any, makeSystem() as any);
    expect(withRisk.maintainabilityScore).toBeLessThan(noRisk.maintainabilityScore);
  });
});

/* ────────────── ScalabilityAnalysisService ────────────── */

describe('ScalabilityAnalysisService', () => {
  let service: ScalabilityAnalysisService;

  beforeEach(() => {
    service = new ScalabilityAnalysisService();
  });

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    type: 'crm',
    capabilities: ['api'],
    dataVolume: { recordCount: 5000, growthRate: 0.1 },
    ...overrides,
  });

  describe('analyzeScalability', () => {
    it('should return full scalability analysis', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.currentCapacity).toBeDefined();
      expect(result.projectedGrowth).toBeDefined();
      expect(result.scalabilityLimits).toBeDefined();
      expect(result.scalingStrategies).toBeDefined();
      expect(result.bottlenecks).toBeDefined();
    });

    it('should calculate current capacity from data volume', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.currentCapacity.throughput).toBe(5000);
      expect(result.currentCapacity.dataVolume).toBe(5000);
      expect(result.currentCapacity.concurrentUsers).toBe(100);
      expect(result.currentCapacity.transactionRate).toBe(1000);
      expect(result.currentCapacity.storageRequirements).toBe(5000 * 1024);
    });

    it('should calculate projected growth', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.projectedGrowth.timeframe).toBe('2 years');
      expect(result.projectedGrowth.expectedGrowth.length).toBeGreaterThan(0);
      const metric = result.projectedGrowth.expectedGrowth[0];
      expect(metric.metric).toBe('data_volume');
      expect(metric.currentValue).toBe(5000);
      expect(metric.projectedValue).toBe(5500); // 5000 * 1.1
      expect(metric.growthRate).toBe(0.1);
    });

    it('should include growth factors', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.projectedGrowth.growthFactors.length).toBeGreaterThan(0);
      expect(result.projectedGrowth.uncertainty).toBe('medium');
    });

    it('should return no limits for small data volumes', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.scalabilityLimits).toEqual([]);
    });

    it('should detect limits for large data volumes (>10M records)', () => {
      const largeSystem = makeSystem({ dataVolume: { recordCount: 15000000, growthRate: 0.1 } });
      const result = service.analyzeScalability(largeSystem as any, makeSystem() as any);
      expect(result.scalabilityLimits.length).toBeGreaterThan(0);
      expect(result.scalabilityLimits[0].component).toContain('Data Volume');
      expect(result.scalabilityLimits[0].type).toBe('capacity');
      expect(result.scalabilityLimits[0].limit).toBe(15000000);
    });

    it('should always include data partitioning strategy', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.scalingStrategies.length).toBeGreaterThan(0);
      expect(result.scalingStrategies[0].name).toContain('Data Partitioning');
      expect(result.scalingStrategies[0].type).toBe('horizontal');
      expect(result.scalingStrategies[0].cost).toBe('high');
      expect(result.scalingStrategies[0].complexity).toBe('medium');
    });

    it('should detect no bottlenecks for modern systems', () => {
      const result = service.analyzeScalability(makeSystem() as any, makeSystem() as any);
      expect(result.bottlenecks).toEqual([]);
    });

    it('should detect bottleneck for legacy source system', () => {
      const legacy = makeSystem({ capabilities: ['legacy'] });
      const result = service.analyzeScalability(legacy as any, makeSystem() as any);
      expect(result.bottlenecks.length).toBeGreaterThan(0);
      expect(result.bottlenecks[0].component).toContain('Legacy');
      expect(result.bottlenecks[0].impact).toBe('high');
    });

    it('should detect bottleneck for legacy target system', () => {
      const legacy = makeSystem({ capabilities: ['legacy'] });
      const result = service.analyzeScalability(makeSystem() as any, legacy as any);
      expect(result.bottlenecks.length).toBeGreaterThan(0);
    });
  });

  describe('assessCurrentCapacity', () => {
    it('should calculate throughput as min / 3600', () => {
      const source = makeSystem({ dataVolume: { recordCount: 7200, growthRate: 0.1 } });
      const target = makeSystem({ dataVolume: { recordCount: 3600, growthRate: 0.1 } });
      const result = service.assessCurrentCapacity(source as any, target as any);
      expect(result.throughput).toBeCloseTo(1, 1); // min(7200, 3600) / 3600 = 1
    });

    it('should cap concurrent users at 50', () => {
      const result = service.assessCurrentCapacity(makeSystem() as any, makeSystem() as any);
      expect(result.concurrentUsers).toBeLessThanOrEqual(50);
    });

    it('should use max for data volume', () => {
      const source = makeSystem({ dataVolume: { recordCount: 1000, growthRate: 0.1 } });
      const target = makeSystem({ dataVolume: { recordCount: 8000, growthRate: 0.1 } });
      const result = service.assessCurrentCapacity(source as any, target as any);
      expect(result.dataVolume).toBe(8000);
    });

    it('should default to 1000 for missing data volume', () => {
      const noData = makeSystem({ dataVolume: undefined });
      const result = service.assessCurrentCapacity(noData as any, makeSystem() as any);
      expect(result.throughput).toBeCloseTo(1000 / 3600, 1);
    });

    it('should calculate storage as sum * 1.5', () => {
      const source = makeSystem({ dataVolume: { recordCount: 2000, growthRate: 0.1 } });
      const target = makeSystem({ dataVolume: { recordCount: 3000, growthRate: 0.1 } });
      const result = service.assessCurrentCapacity(source as any, target as any);
      expect(result.storageRequirements).toBe(7500); // (2000 + 3000) * 1.5
    });
  });

  describe('assessProjectedGrowth', () => {
    it('should return 12 month projection', () => {
      const result = service.assessProjectedGrowth(makeSystem() as any, makeSystem() as any, []);
      expect(result.timeframe).toBe('12 months');
    });

    it('should use max data volume as current value', () => {
      const source = makeSystem({ dataVolume: { recordCount: 1000, growthRate: 0.1 } });
      const target = makeSystem({ dataVolume: { recordCount: 9000, growthRate: 0.1 } });
      const result = service.assessProjectedGrowth(source as any, target as any, []);
      expect(result.expectedGrowth[0].currentValue).toBe(9000);
    });

    it('should calculate projected value with growth rate', () => {
      const result = service.assessProjectedGrowth(makeSystem() as any, makeSystem() as any, []);
      // currentVolume = max(5000, 5000) = 5000, growth = 0.1
      expect(result.expectedGrowth[0].projectedValue).toBe(5500);
    });

    it('should default growth rate to 0.2 when missing', () => {
      const noData = makeSystem({ dataVolume: undefined });
      const result = service.assessProjectedGrowth(noData as any, noData as any, []);
      expect(result.expectedGrowth[0].growthRate).toBe(0.2);
    });

    it('should include growth factors and uncertainty', () => {
      const result = service.assessProjectedGrowth(makeSystem() as any, makeSystem() as any, []);
      expect(result.growthFactors.length).toBeGreaterThan(0);
      expect(result.uncertainty).toBe('medium');
    });
  });
});

/* ────────────── CompatibilityAnalysisService ────────────── */

describe('CompatibilityAnalysisService', () => {
  let service: CompatibilityAnalysisService;

  beforeEach(() => {
    service = new CompatibilityAnalysisService();
  });

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    type: 'crm',
    securityLevel: 'standard',
    apiSupport: [{ type: 'REST' }],
    ...overrides,
  });

  it('should return full compatibility analysis', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.overallScore).toBeDefined();
    expect(result.apiCompatibility).toBeDefined();
    expect(result.dataFormatCompatibility).toBeDefined();
    expect(result.protocolCompatibility).toBeDefined();
    expect(result.versionCompatibility).toBeDefined();
    expect(result.incompatibilities).toBeDefined();
    expect(result.mitigations).toBeDefined();
  });

  it('should calculate overall score as average of 4 sub-scores', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    const expected = (result.apiCompatibility + result.dataFormatCompatibility +
                      result.protocolCompatibility + result.versionCompatibility) / 4;
    expect(result.overallScore).toBeCloseTo(expected, 5);
  });

  it('should return high API compatibility for matching API types', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.apiCompatibility).toBe(0.9);
  });

  it('should return low API compatibility when no API support', () => {
    const noApi = makeSystem({ apiSupport: undefined });
    const result = service.analyzeCompatibility(noApi, makeSystem());
    expect(result.apiCompatibility).toBe(0.3);
  });

  it('should return 0.5 for non-matching API types', () => {
    const restSys = makeSystem({ apiSupport: [{ type: 'REST' }] });
    const soapSys = makeSystem({ apiSupport: [{ type: 'SOAP' }] });
    const result = service.analyzeCompatibility(restSys, soapSys);
    expect(result.apiCompatibility).toBe(0.5);
  });

  it('should return high data format compatibility for modern systems', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.dataFormatCompatibility).toBe(0.9);
  });

  it('should return 0.7 when only one system is modern', () => {
    const fileSys = makeSystem({ type: 'file' });
    const result = service.analyzeCompatibility(fileSys, makeSystem());
    expect(result.dataFormatCompatibility).toBe(0.7);
  });

  it('should return 0.5 for two non-modern systems', () => {
    const fileSys1 = makeSystem({ type: 'file' });
    const fileSys2 = makeSystem({ type: 'legacy' });
    const result = service.analyzeCompatibility(fileSys1, fileSys2);
    expect(result.dataFormatCompatibility).toBe(0.5);
  });

  it('should return 0.8 for protocol compatibility (default)', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.protocolCompatibility).toBe(0.8);
  });

  it('should return 0.85 for version compatibility (default)', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.versionCompatibility).toBe(0.85);
  });

  it('should have no incompatibilities for similar security levels', () => {
    const result = service.analyzeCompatibility(makeSystem(), makeSystem());
    expect(result.incompatibilities).toEqual([]);
    expect(result.mitigations).toEqual([]);
  });

  it('should detect security level mismatch >1 level apart', () => {
    const basic = makeSystem({ securityLevel: 'basic' });
    const enterprise = makeSystem({ securityLevel: 'enterprise' });
    const result = service.analyzeCompatibility(basic, enterprise);
    expect(result.incompatibilities.length).toBeGreaterThan(0);
    expect(result.incompatibilities[0].type).toBe('security');
    expect(result.incompatibilities[0].severity).toBe('medium');
  });

  it('should not detect mismatch for adjacent security levels', () => {
    const standard = makeSystem({ securityLevel: 'standard' });
    const high = makeSystem({ securityLevel: 'high' });
    const result = service.analyzeCompatibility(standard, high);
    expect(result.incompatibilities).toEqual([]);
  });

  it('should generate mitigation for each incompatibility', () => {
    const basic = makeSystem({ securityLevel: 'basic' });
    const enterprise = makeSystem({ securityLevel: 'enterprise' });
    const result = service.analyzeCompatibility(basic, enterprise);
    expect(result.mitigations.length).toBe(result.incompatibilities.length);
  });

  it('should select upgrade strategy for security incompatibility', () => {
    const basic = makeSystem({ securityLevel: 'basic' });
    const enterprise = makeSystem({ securityLevel: 'enterprise' });
    const result = service.analyzeCompatibility(basic, enterprise);
    expect(result.mitigations[0].strategy).toBe('upgrade');
  });

  it('should set medium effort for non-high severity', () => {
    const basic = makeSystem({ securityLevel: 'basic' });
    const enterprise = makeSystem({ securityLevel: 'enterprise' });
    const result = service.analyzeCompatibility(basic, enterprise);
    expect(result.mitigations[0].effort).toBe('medium');
    expect(result.mitigations[0].cost).toBe(5000);
    expect(result.mitigations[0].timeline).toBe(30);
  });
});
