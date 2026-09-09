/**
 * Integration Strategy Security Types
 *
 * Types for security analysis, threat assessment, and compliance requirements.
 * Extracted from IntegrationStrategyAgent.ts (lines 146-229)
 *
 * @module security.types
 */

export interface SecurityAnalysis {
  overallRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  threatAssessment: ThreatAssessment;
  vulnerabilities: SecurityVulnerability[];
  complianceRequirements: ComplianceRequirement[];
  securityControls: SecurityControl[];
  recommendations: SecurityRecommendation[];
}

export interface ThreatAssessment {
  threats: SecurityThreat[];
  attackVectors: AttackVector[];
  riskMatrix: RiskMatrix;
  businessImpact: BusinessImpact;
}

export interface SecurityThreat {
  threat: string;
  type: 'data_breach' | 'service_disruption' | 'unauthorized_access' | 'data_corruption';
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high' | 'critical';
  riskScore: number;
  mitigations: string[];
}

export interface AttackVector {
  vector: string;
  description: string;
  likelihood: number;
  preventionMeasures: string[];
}

export interface RiskMatrix {
  low: number;
  medium: number;
  high: number;
  critical: number;
}

export interface BusinessImpact {
  financialImpact: number;
  reputationalImpact: 'low' | 'medium' | 'high';
  operationalImpact: 'low' | 'medium' | 'high';
  complianceImpact: 'low' | 'medium' | 'high';
}

export interface SecurityVulnerability {
  vulnerability: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cve?: string;
  description: string;
  affectedComponents: string[];
  remediation: string;
  timeline: number;
}

export interface ComplianceRequirement {
  regulation: string;
  requirement: string;
  applicability: boolean;
  currentCompliance: number;
  requiredCompliance: number;
  gap: string[];
  remediation: string[];
}

export interface SecurityControl {
  control: string;
  type: 'preventive' | 'detective' | 'corrective';
  description: string;
  effectiveness: number;
  cost: number;
  complexity: 'low' | 'medium' | 'high';
}

export interface SecurityRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: 'infrastructure' | 'application' | 'data' | 'process';
  recommendation: string;
  rationale: string;
  implementation: string;
  cost: number;
  timeline: number;
}
