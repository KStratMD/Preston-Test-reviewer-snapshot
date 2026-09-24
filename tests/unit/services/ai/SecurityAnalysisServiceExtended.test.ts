/**
 * Comprehensive tests for SecurityAnalysisService
 * Covers: analyzeSecurity with threat assessment, vulnerabilities,
 *         compliance, security controls, recommendations, overall risk
 */

import { SecurityAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/SecurityAnalysisService';

describe('SecurityAnalysisService', () => {
  let service: SecurityAnalysisService;

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    version: '3.0',
    securityLevel: 'standard' as const,
    apiSupport: [{ authentication: ['oauth', 'api_key'] }],
    ...overrides,
  });

  beforeEach(() => {
    service = new SecurityAnalysisService();
  });

  describe('analyzeSecurity', () => {
    it('should return complete security analysis structure', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.overallRiskLevel).toBeDefined();
      expect(result.threatAssessment).toBeDefined();
      expect(result.vulnerabilities).toBeDefined();
      expect(result.complianceRequirements).toBeDefined();
      expect(result.securityControls).toBeDefined();
      expect(result.recommendations).toBeDefined();
    });

    it('should return low risk for standard systems with oauth', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.overallRiskLevel).toBe('low');
    });

    it('should detect threats when source has no oauth', () => {
      const source = makeSystem({ apiSupport: [{ authentication: ['api_key'] }] });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.threatAssessment.threats.length).toBeGreaterThan(0);
      expect(result.threatAssessment.threats[0].type).toBe('data_breach');
    });

    it('should add attack vector for no-oauth source', () => {
      const source = makeSystem({ apiSupport: [{ authentication: ['basic'] }] });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.threatAssessment.attackVectors.length).toBeGreaterThan(0);
      expect(result.threatAssessment.attackVectors[0].vector).toContain('Man-in-the-middle');
    });

    it('should not detect threats when source has oauth', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.threatAssessment.threats).toEqual([]);
    });

    it('should include risk matrix in threat assessment', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.threatAssessment.riskMatrix).toBeDefined();
      expect(result.threatAssessment.riskMatrix.low).toBe(8);
    });

    it('should include business impact in threat assessment', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.threatAssessment.businessImpact.financialImpact).toBe(75000);
    });

    it('should set high compliance impact for enterprise systems', () => {
      const source = makeSystem({ securityLevel: 'enterprise' });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.threatAssessment.businessImpact.complianceImpact).toBe('high');
    });

    it('should set low compliance impact for non-enterprise', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.threatAssessment.businessImpact.complianceImpact).toBe('low');
    });
  });

  describe('vulnerabilities', () => {
    it('should detect outdated version (< 2.0)', () => {
      const source = makeSystem({ version: '1.5' });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.vulnerabilities.length).toBe(1);
      expect(result.vulnerabilities[0].vulnerability).toContain('Outdated');
    });

    it('should not flag version >= 2.0', () => {
      const source = makeSystem({ version: '2.0' });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.vulnerabilities).toEqual([]);
    });

    it('should not flag when no version specified', () => {
      const source = makeSystem({ version: undefined });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.vulnerabilities).toEqual([]);
    });
  });

  describe('compliance requirements', () => {
    it('should require SOX for enterprise source', () => {
      const source = makeSystem({ securityLevel: 'enterprise' });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      expect(result.complianceRequirements.length).toBe(1);
      expect(result.complianceRequirements[0].regulation).toBe('SOX');
    });

    it('should require SOX for enterprise target', () => {
      const target = makeSystem({ securityLevel: 'enterprise' });
      const result = service.analyzeSecurity(makeSystem() as any, target as any);
      expect(result.complianceRequirements.length).toBe(1);
    });

    it('should not require SOX for non-enterprise systems', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.complianceRequirements).toEqual([]);
    });
  });

  describe('security controls', () => {
    it('should always include encryption control', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.securityControls.length).toBe(1);
      expect(result.securityControls[0].control).toContain('Encryption');
      expect(result.securityControls[0].type).toBe('preventive');
    });
  });

  describe('recommendations', () => {
    it('should always include encryption recommendation', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.recommendations.length).toBe(1);
      expect(result.recommendations[0].priority).toBe('high');
      expect(result.recommendations[0].category).toBe('infrastructure');
    });
  });

  describe('overall risk level', () => {
    it('should return medium when high-impact threats exist', () => {
      const source = makeSystem({ apiSupport: [{ authentication: ['basic'] }] });
      const result = service.analyzeSecurity(source as any, makeSystem() as any);
      // 1 high-impact threat → medium
      expect(result.overallRiskLevel).toBe('medium');
    });

    it('should return low when no high threats or critical vulns', () => {
      const result = service.analyzeSecurity(makeSystem() as any, makeSystem() as any);
      expect(result.overallRiskLevel).toBe('low');
    });
  });
});
