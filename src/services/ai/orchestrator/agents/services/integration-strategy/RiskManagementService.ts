/**
 * Risk Management Service - Integration Risk Assessment
 * Extracted from IntegrationStrategyAgent
 */

import type {
  IntegrationRisk,
  IntegrationStrategyInput
} from '../../../interfaces';

import type {
  ArchitectureAssessment
} from '../../types/integration-strategy/analysis.types';

export class RiskManagementService {
  /**
   * Assess all integration risks
   */
  async assessIntegrationRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): Promise<IntegrationRisk[]> {
    const risks: IntegrationRisk[] = [];

    // Technical risks
    risks.push(...this.identifyTechnicalRisks(input, assessment));

    // Data risks
    risks.push(...this.identifyDataRisks(input, assessment));

    // Performance risks
    risks.push(...this.identifyPerformanceRisks(input, assessment));

    // Security risks
    risks.push(...this.identifySecurityRisks(input, assessment));

    // Operational risks
    risks.push(...this.identifyOperationalRisks(input, assessment));

    return risks;
  }

  /**
   * Identify technical risks
   */
  identifyTechnicalRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): IntegrationRisk[] {
    const risks: IntegrationRisk[] = [];

    if (assessment.compatibility.overallScore < 0.7) {
      risks.push({
        category: 'data',
        description: 'Low system compatibility may cause integration failures',
        probability: 'medium',
        impact: 'high',
        mitigation: 'Implement compatibility adapters and extensive testing',
        contingency: 'Develop fallback integration methods'
      });
    }

    return risks;
  }

  /**
   * Identify data risks
   */
  identifyDataRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): IntegrationRisk[] {
    return [
      {
        category: 'data',
        description: 'Data quality issues during migration',
        probability: 'medium',
        impact: 'medium',
        mitigation: 'Implement data validation and cleansing processes',
        contingency: 'Establish data rollback procedures'
      }
    ];
  }

  /**
   * Identify performance risks
   */
  identifyPerformanceRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): IntegrationRisk[] {
    return [
      {
        category: 'performance',
        description: 'Integration latency may impact user experience',
        probability: 'low',
        impact: 'medium',
        mitigation: 'Optimize integration endpoints and implement caching',
        contingency: 'Scale infrastructure resources'
      }
    ];
  }

  /**
   * Identify security risks
   */
  identifySecurityRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): IntegrationRisk[] {
    const risks: IntegrationRisk[] = [];

    const securityLevels = ['basic', 'standard', 'high', 'enterprise'];
    const sourceLevel = securityLevels.indexOf(input.sourceSystemProfile.securityLevel);
    const targetLevel = securityLevels.indexOf(input.targetSystemProfile.securityLevel);

    if (Math.abs(sourceLevel - targetLevel) > 0) {
      risks.push({
        category: 'security',
        description: 'Security level mismatch between systems',
        probability: 'medium',
        impact: 'high',
        mitigation: 'Implement security upgrades and additional controls',
        contingency: 'Isolate integration with additional security layers'
      });
    }

    return risks;
  }

  /**
   * Identify operational risks
   */
  identifyOperationalRisks(
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): IntegrationRisk[] {
    return [
      {
        category: 'operational',
        description: 'Integration maintenance complexity',
        probability: 'medium',
        impact: 'medium',
        mitigation: 'Establish clear operational procedures and documentation',
        contingency: 'Train additional team members on integration management'
      }
    ];
  }

  /**
   * Calculate overall risk level
   */
  calculateOverallRisk(risks: IntegrationRisk[]): number {
    if (risks.length === 0) return 0;

    const riskLevels = { low: 1, medium: 2, high: 3, critical: 4 };
    const totalRisk = risks.reduce((sum, risk) => sum + riskLevels[risk.impact], 0);
    return (totalRisk / (risks.length * 4)); // Normalize to 0-1
  }

  /**
   * Check if there are high risks
   */
  hasHighRisks(risks: IntegrationRisk[]): boolean {
    return risks.some(risk => risk.impact === 'high' || risk.probability === 'high');
  }
}
