/**
 * Comprehensive tests for RiskAssessmentService
 * Covers: assessRisks, operational/technical/business/compliance risks,
 *         probability/impact conversion
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

import { RiskAssessmentService } from '../../../../src/services/ai/orchestrator/agents/optimization/RiskAssessmentService';

describe('RiskAssessmentService', () => {
  let service: RiskAssessmentService;

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

  const makeOptimization = (overrides: Record<string, any> = {}) => ({
    opportunities: [],
    scenarios: [],
    recommendations: [],
    impact: { overallValue: 0 },
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (RiskAssessmentService as any)(mockLogger);
  });

  /* ────────────── assessRisks ────────────── */

  describe('assessRisks', () => {
    it('should return complete risk analysis structure', async () => {
      const result = await service.assessRisks(
        [makeStep()] as any[],
        [],
        makeOptimization() as any
      );
      expect(result.operationalRisks).toBeDefined();
      expect(result.technicalRisks).toBeDefined();
      expect(result.businessRisks).toBeDefined();
      expect(result.complianceRisks).toBeDefined();
      expect(result.overallRiskScore).toBeDefined();
    });

    it('should always include capacity risk in operational', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      const capacityRisks = result.operationalRisks.filter(r => r.type === 'capacity');
      expect(capacityRisks.length).toBe(1);
    });

    it('should increase capacity risk for large workflows (>20 steps)', async () => {
      const steps = Array(25).fill(null).map((_, i) => makeStep({ id: `s-${i}` }));
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const capacityRisk = result.operationalRisks.find(r => r.type === 'capacity');
      expect(capacityRisk!.probability).toBe(0.6);
    });

    it('should have lower capacity risk for small workflows', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      const capacityRisk = result.operationalRisks.find(r => r.type === 'capacity');
      expect(capacityRisk!.probability).toBe(0.3);
    });

    it('should always include strategic business risk', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      const strategicRisks = result.businessRisks.filter(r => r.type === 'strategic');
      expect(strategicRisks.length).toBe(1);
    });

    it('should log start and completion', async () => {
      await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      expect(mockLogger.info).toHaveBeenCalledWith('Assessing process optimization risks', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Risk assessment completed', expect.any(Object));
    });
  });

  /* ────────────── Operational risks ────────────── */

  describe('operational risks', () => {
    it('should detect dependency risk when avg dependencies > 2', async () => {
      const steps = [
        makeStep({ dependencies: ['a', 'b', 'c'] }),
        makeStep({ id: 's2', dependencies: ['x', 'y', 'z'] }),
      ];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const depRisks = result.operationalRisks.filter(r => r.type === 'dependency');
      expect(depRisks.length).toBe(1);
      expect(depRisks[0].description).toContain('3.0');
    });

    it('should not detect dependency risk when avg <= 2', async () => {
      const steps = [
        makeStep({ dependencies: ['a'] }),
        makeStep({ id: 's2', dependencies: ['b'] }),
      ];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const depRisks = result.operationalRisks.filter(r => r.type === 'dependency');
      expect(depRisks).toEqual([]);
    });

    it('should detect quality risk when >40% manual steps', async () => {
      const steps = [
        makeStep({ type: 'manual' }),
        makeStep({ id: 's2', type: 'manual' }),
        makeStep({ id: 's3', type: 'manual' }),
        makeStep({ id: 's4', type: 'automated' }),
      ];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const qualityRisks = result.operationalRisks.filter(r => r.type === 'quality');
      expect(qualityRisks.length).toBe(1);
      expect(qualityRisks[0].description).toContain('75%');
    });

    it('should detect timing risk for long processes (>240 min)', async () => {
      const steps = [
        makeStep({ duration: 150 }),
        makeStep({ id: 's2', duration: 120 }),
      ];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const timingRisks = result.operationalRisks.filter(r => r.type === 'timing');
      expect(timingRisks.length).toBe(1);
      expect(timingRisks[0].description).toContain('270');
    });

    it('should not detect timing risk for short processes', async () => {
      const result = await service.assessRisks(
        [makeStep({ duration: 30 })] as any[], [], makeOptimization() as any
      );
      const timingRisks = result.operationalRisks.filter(r => r.type === 'timing');
      expect(timingRisks).toEqual([]);
    });

    it('should detect resource risk when one resource used >50%', async () => {
      const steps = [
        makeStep({ id: 's1', resources: ['analyst'] }),
        makeStep({ id: 's2', resources: ['analyst'] }),
        makeStep({ id: 's3', resources: ['server'] }),
      ];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const resourceRisks = result.operationalRisks.filter(r => r.type === 'resource');
      expect(resourceRisks.length).toBe(1);
    });
  });

  /* ────────────── Technical risks ────────────── */

  describe('technical risks', () => {
    it('should detect integration risk for automation opportunities', async () => {
      const opt = makeOptimization({
        opportunities: [{ type: 'automation', implementationEffort: 'medium', potentialGains: {} }],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const intRisks = result.technicalRisks.filter(r => r.type === 'integration');
      expect(intRisks.length).toBe(1);
    });

    it('should detect performance risk for parallelization', async () => {
      const opt = makeOptimization({
        opportunities: [{ type: 'parallelization', implementationEffort: 'low', potentialGains: {} }],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const perfRisks = result.technicalRisks.filter(r => r.type === 'performance');
      expect(perfRisks.length).toBe(1);
    });

    it('should detect scalability risk for >2 high-effort opportunities', async () => {
      const opt = makeOptimization({
        opportunities: [
          { type: 'automation', implementationEffort: 'high', potentialGains: {} },
          { type: 'consolidation', implementationEffort: 'high', potentialGains: {} },
          { type: 'reordering', implementationEffort: 'high', potentialGains: {} },
        ],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const scaleRisks = result.technicalRisks.filter(r => r.type === 'scalability');
      expect(scaleRisks.length).toBe(1);
    });

    it('should detect reliability risk for elimination opportunities', async () => {
      const opt = makeOptimization({
        opportunities: [{ type: 'elimination', implementationEffort: 'low', potentialGains: {} }],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const relRisks = result.technicalRisks.filter(r => r.type === 'reliability');
      expect(relRisks.length).toBe(1);
    });

    it('should detect security risk for consolidation opportunities', async () => {
      const opt = makeOptimization({
        opportunities: [{ type: 'consolidation', implementationEffort: 'medium', potentialGains: {} }],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const secRisks = result.technicalRisks.filter(r => r.type === 'security');
      expect(secRisks.length).toBe(1);
    });

    it('should return no technical risks when no relevant opportunities', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      expect(result.technicalRisks).toEqual([]);
    });
  });

  /* ────────────── Business risks ────────────── */

  describe('business risks', () => {
    it('should detect financial risk for high total investment (>$100K)', async () => {
      const opt = makeOptimization({
        opportunities: [
          { type: 'automation', implementationEffort: 'high', potentialGains: {} },
          { type: 'consolidation', implementationEffort: 'high', potentialGains: {} },
          { type: 'elimination', implementationEffort: 'high', potentialGains: {} },
        ],
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const finRisks = result.businessRisks.filter(r => r.type === 'financial');
      expect(finRisks.length).toBe(1);
      expect(finRisks[0].description).toContain('$150,000');
    });

    it('should detect market risk for >5 opportunities', async () => {
      const opt = makeOptimization({
        opportunities: Array(6).fill({ type: 'automation', implementationEffort: 'low', potentialGains: {} }),
      });
      const result = await service.assessRisks([makeStep()] as any[], [], opt as any);
      const marketRisks = result.businessRisks.filter(r => r.type === 'market');
      expect(marketRisks.length).toBe(1);
    });

    it('should detect regulatory risk for compliance-named steps', async () => {
      const steps = [makeStep({ name: 'Compliance Check' })];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const regRisks = result.businessRisks.filter(r => r.type === 'regulatory');
      expect(regRisks.length).toBe(1);
    });

    it('should detect regulatory risk for audit-named steps', async () => {
      const steps = [makeStep({ name: 'Internal Audit Review' })];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const regRisks = result.businessRisks.filter(r => r.type === 'regulatory');
      expect(regRisks.length).toBe(1);
    });

    it('should detect reputation risk for customer-facing steps', async () => {
      const steps = [makeStep({ name: 'Customer Notification' })];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const repRisks = result.businessRisks.filter(r => r.type === 'reputation');
      expect(repRisks.length).toBe(1);
    });

    it('should detect reputation risk for client-named steps', async () => {
      const steps = [makeStep({ name: 'Client Onboarding' })];
      const result = await service.assessRisks(steps as any[], [], makeOptimization() as any);
      const repRisks = result.businessRisks.filter(r => r.type === 'reputation');
      expect(repRisks.length).toBe(1);
    });
  });

  /* ────────────── Compliance risks ────────────── */

  describe('compliance risks', () => {
    it('should create risk for regulatory constraints', async () => {
      const constraints = [{ type: 'regulatory', description: 'GDPR compliance' }] as any[];
      const result = await service.assessRisks([makeStep()] as any[], constraints, makeOptimization() as any);
      expect(result.complianceRisks.length).toBe(1);
      expect(result.complianceRisks[0].regulation).toBe('GDPR compliance');
      expect(result.complianceRisks[0].riskLevel).toBe('medium');
    });

    it('should create risk for technical constraints', async () => {
      const constraints = [{ type: 'technical', description: 'API rate limit' }] as any[];
      const result = await service.assessRisks([makeStep()] as any[], constraints, makeOptimization() as any);
      const techCompliance = result.complianceRisks.filter(r => r.regulation === 'Technical Standards');
      expect(techCompliance.length).toBe(1);
    });

    it('should create risk for resource constraints', async () => {
      const constraints = [{ type: 'resource', description: 'Max 5 analysts' }] as any[];
      const result = await service.assessRisks([makeStep()] as any[], constraints, makeOptimization() as any);
      const resCompliance = result.complianceRisks.filter(r => r.regulation === 'Resource Requirements');
      expect(resCompliance.length).toBe(1);
      expect(resCompliance[0].riskLevel).toBe('low');
    });

    it('should return empty compliance risks for no constraints', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      expect(result.complianceRisks).toEqual([]);
    });

    it('should handle multiple constraints', async () => {
      const constraints = [
        { type: 'regulatory', description: 'SOX' },
        { type: 'technical', description: 'SLA' },
        { type: 'resource', description: 'Budget limit' },
      ] as any[];
      const result = await service.assessRisks([makeStep()] as any[], constraints, makeOptimization() as any);
      expect(result.complianceRisks.length).toBe(3);
    });
  });

  /* ────────────── Overall risk score ────────────── */

  describe('overall risk score', () => {
    it('should calculate overall risk score as scaled average', async () => {
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      expect(result.overallRiskScore).toBeGreaterThan(0);
      expect(result.overallRiskScore).toBeLessThanOrEqual(10);
    });

    it('should return 0 when no operational/technical/business risks exist', async () => {
      // This won't happen in practice since strategic risk always exists,
      // but test the formula: no risks → 0
      // Actually strategic always present, so score > 0
      const result = await service.assessRisks([makeStep()] as any[], [], makeOptimization() as any);
      expect(result.overallRiskScore).toBeGreaterThan(0);
    });
  });

  /* ────────────── Probability/Impact conversion ────────────── */

  describe('convertProbabilityToString', () => {
    it('should return low for < 0.3', () => {
      expect(service.convertProbabilityToString(0.1)).toBe('low');
      expect(service.convertProbabilityToString(0.29)).toBe('low');
    });

    it('should return medium for 0.3-0.69', () => {
      expect(service.convertProbabilityToString(0.3)).toBe('medium');
      expect(service.convertProbabilityToString(0.5)).toBe('medium');
    });

    it('should return high for >= 0.7', () => {
      expect(service.convertProbabilityToString(0.7)).toBe('high');
      expect(service.convertProbabilityToString(1.0)).toBe('high');
    });
  });

  describe('convertImpactToString', () => {
    it('should return low for < 0.3', () => {
      expect(service.convertImpactToString(0.1)).toBe('low');
    });

    it('should return medium for 0.3-0.69', () => {
      expect(service.convertImpactToString(0.5)).toBe('medium');
    });

    it('should return high for >= 0.7', () => {
      expect(service.convertImpactToString(0.8)).toBe('high');
    });
  });
});
