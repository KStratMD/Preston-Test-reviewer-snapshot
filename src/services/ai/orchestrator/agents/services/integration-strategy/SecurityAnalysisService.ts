/**
 * Security Analysis Service - Security assessment for integration strategy
 * Extracted from IntegrationStrategyAgent.ts - Phase 3, Batch 1, Service 4/6
 */

import type {
  SecurityAnalysis,
  ThreatAssessment,
  SecurityThreat,
  AttackVector,
  RiskMatrix,
  BusinessImpact,
  SecurityVulnerability,
  ComplianceRequirement,
  SecurityControl,
  SecurityRecommendation
} from '../../types/integration-strategy/security.types';

// SystemProfile interface (minimal required fields)
interface SystemProfile {
  name: string;
  version?: string;
  securityLevel: 'basic' | 'standard' | 'high' | 'enterprise';
  apiSupport: { authentication: string[] }[];
}

export class SecurityAnalysisService {
  /**
   * Analyze security aspects of integration
   * PUBLIC method for security analysis
   */
  public analyzeSecurity(
    sourceSystem: SystemProfile,
    targetSystem: SystemProfile
  ): SecurityAnalysis {
    // Threat assessment
    const threatAssessment = this.assessSecurityThreats(sourceSystem, targetSystem);

    // Vulnerabilities
    const vulnerabilities = this.identifySecurityVulnerabilities(sourceSystem, targetSystem);

    // Compliance requirements
    const complianceRequirements = this.identifyComplianceRequirements(sourceSystem, targetSystem);

    // Security controls
    const securityControls = this.recommendSecurityControls(threatAssessment, vulnerabilities);

    // Recommendations
    const recommendations = this.generateSecurityRecommendations(threatAssessment, vulnerabilities, complianceRequirements);

    const overallRiskLevel = this.calculateOverallSecurityRisk(threatAssessment, vulnerabilities);

    return {
      overallRiskLevel,
      threatAssessment,
      vulnerabilities,
      complianceRequirements,
      securityControls,
      recommendations
    };
  }

  /**
   * Assess security threats for integration
   * PRIVATE method - internal threat assessment
   */
  private assessSecurityThreats(sourceSystem: SystemProfile, targetSystem: SystemProfile): ThreatAssessment {
    const threats: SecurityThreat[] = [];
    const attackVectors: AttackVector[] = [];

    // Data in transit threats
    if (!sourceSystem.apiSupport.some(api => api.authentication.includes('oauth'))) {
      threats.push({
        threat: 'Unencrypted data transmission from source system',
        type: 'data_breach',
        probability: 'medium',
        impact: 'high',
        riskScore: 7,
        mitigations: ['Implement TLS encryption', 'Use VPN connections']
      });

      attackVectors.push({
        vector: 'Man-in-the-middle attack on unencrypted channels',
        description: 'Potential for data interception during transmission',
        likelihood: 0.6,
        preventionMeasures: ['Implement TLS encryption', 'Use VPN connections', 'Certificate pinning']
      });
    }

    return {
      threats,
      attackVectors,
      riskMatrix: {
        low: 8,
        medium: 4,
        high: 2,
        critical: 0
      },
      businessImpact: {
        financialImpact: 75000,
        reputationalImpact: 'medium',
        operationalImpact: 'medium',
        complianceImpact: sourceSystem.securityLevel === 'enterprise' ? 'high' : 'low'
      }
    };
  }

  /**
   * Identify security vulnerabilities
   * PRIVATE method - vulnerability identification
   */
  private identifySecurityVulnerabilities(sourceSystem: SystemProfile, targetSystem: SystemProfile): SecurityVulnerability[] {
    const vulnerabilities: SecurityVulnerability[] = [];

    // Check for outdated versions
    if (sourceSystem.version && parseFloat(sourceSystem.version) < 2.0) {
      vulnerabilities.push({
        vulnerability: 'Outdated source system version',
        severity: 'medium',
        description: 'Legacy version may have known security vulnerabilities',
        affectedComponents: [sourceSystem.name],
        remediation: 'Upgrade to latest version',
        timeline: 30
      });
    }

    return vulnerabilities;
  }

  /**
   * Identify compliance requirements
   * PRIVATE method - compliance requirement identification
   */
  private identifyComplianceRequirements(sourceSystem: SystemProfile, targetSystem: SystemProfile): ComplianceRequirement[] {
    const requirements: ComplianceRequirement[] = [];

    if (sourceSystem.securityLevel === 'enterprise' || targetSystem.securityLevel === 'enterprise') {
      requirements.push({
        regulation: 'SOX',
        requirement: 'Enterprise security controls and audit trails',
        applicability: true,
        currentCompliance: 0.7,
        requiredCompliance: 1.0,
        gap: ['Missing audit trails', 'Incomplete access controls'],
        remediation: ['Implement comprehensive logging', 'Enhance access controls']
      });
    }

    return requirements;
  }

  /**
   * Recommend security controls
   * PRIVATE method - security control recommendations
   */
  private recommendSecurityControls(threatAssessment: ThreatAssessment, vulnerabilities: SecurityVulnerability[]): SecurityControl[] {
    const controls: SecurityControl[] = [];

    controls.push({
      control: 'Data Encryption in Transit',
      type: 'preventive',
      description: 'Encrypt all data during transmission between systems',
      effectiveness: 0.9,
      cost: 2000,
      complexity: 'medium'
    });

    return controls;
  }

  /**
   * Generate security recommendations
   * PRIVATE method - recommendation generation
   */
  private generateSecurityRecommendations(threatAssessment: ThreatAssessment, vulnerabilities: SecurityVulnerability[], complianceRequirements: ComplianceRequirement[]): SecurityRecommendation[] {
    const recommendations: SecurityRecommendation[] = [];

    recommendations.push({
      priority: 'high',
      category: 'infrastructure',
      recommendation: 'Implement end-to-end encryption for all data transfers',
      rationale: 'Protects sensitive data during transmission',
      implementation: 'Deploy TLS 1.3 certificates and configure encryption protocols',
      cost: 5000,
      timeline: 30
    });

    return recommendations;
  }

  /**
   * Calculate overall security risk level
   * PRIVATE method - overall risk calculation
   */
  private calculateOverallSecurityRisk(threatAssessment: ThreatAssessment, vulnerabilities: SecurityVulnerability[]): 'low' | 'medium' | 'high' {
    const highRiskThreats = threatAssessment.threats.filter(t => t.impact === 'high' || t.impact === 'critical').length;
    const criticalVulnerabilities = vulnerabilities.filter(v => v.severity === 'critical' || v.severity === 'high').length;

    if (highRiskThreats > 2 || criticalVulnerabilities > 1) return 'high';
    if (highRiskThreats > 0 || criticalVulnerabilities > 0) return 'medium';
    return 'low';
  }

  /**
   * Assess security risk level
   * PRIVATE method - risk level assessment
   */
  private assessSecurityRiskLevel(source: SystemProfile, target: SystemProfile): 'low' | 'medium' | 'high' | 'critical' {
    const maxSecurityLevel = [source.securityLevel, target.securityLevel].includes('enterprise') ? 'high' : 'medium';
    const securityMismatch = source.securityLevel !== target.securityLevel;

    if (maxSecurityLevel === 'high' && securityMismatch) return 'high';
    if (maxSecurityLevel === 'high') return 'medium';
    if (securityMismatch) return 'medium';
    return 'low';
  }

  /**
   * Assess compliance requirements (alternative signature)
   * PRIVATE method - compliance assessment
   */
  private assessCompliance(source: SystemProfile, target: SystemProfile): unknown[] {
    const requirements = [];

    if (source.securityLevel === 'enterprise' || target.securityLevel === 'enterprise') {
      requirements.push({
        requirement: 'SOX Compliance',
        status: 'required',
        description: 'Enterprise systems require SOX compliance controls'
      });
    }

    requirements.push({
      requirement: 'Data Privacy',
      status: 'required',
      description: 'GDPR/CCPA compliance for data handling'
    });

    return requirements;
  }
}
