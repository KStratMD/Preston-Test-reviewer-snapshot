/**
 * Business Intelligence Risk Types
 * Risk assessment, mitigation strategies, and compliance risk types
 */

export interface EnhancedRiskAssessment {
  overallRiskScore: number; // 0-100
  riskCategories: RiskCategoryAssessment[];
  mitigationStrategies: MitigationStrategy[];
  riskMatrix: RiskMatrixEntry[];
  complianceRisks: ComplianceRiskSummary[];
}

export interface RiskCategoryAssessment {
  category: 'operational' | 'financial' | 'compliance' | 'technical' | 'strategic' | 'reputational';
  currentRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  targetRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  likelihood: number; // 0-1
  impact: number; // 0-1
  riskScore: number;
  trends: 'improving' | 'stable' | 'deteriorating';
  keyRiskFactors: string[];
}

export interface MitigationStrategy {
  riskCategory: string;
  strategy: string;
  effectiveness: number; // 0-1
  implementationCost: number;
  timeToImplement: number; // days
  resourceRequirements: string[];
  dependencies: string[];
}

export interface RiskMatrixEntry {
  riskId: string;
  description: string;
  likelihood: 'very-low' | 'low' | 'medium' | 'high' | 'very-high';
  impact: 'negligible' | 'minor' | 'moderate' | 'major' | 'catastrophic';
  riskScore: number;
  currentControls: string[];
  additionalControls: string[];
}

export interface ComplianceRiskSummary {
  regulation: string;
  currentComplianceLevel: number; // 0-1
  targetComplianceLevel: number; // 0-1
  gaps: number;
  estimatedFineRisk: number;
  priorityActions: string[];
}

export interface BusinessRiskAssessment {
  overallRiskLevel: 'low' | 'medium' | 'high' | 'critical';
  riskCategories: RiskCategory[];
  mitigationStrategies: MitigationStrategy[];
  complianceRisks: ComplianceRisk[];
}

export interface RiskCategory {
  category: 'operational' | 'financial' | 'compliance' | 'technical' | 'strategic';
  level: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  likelihood: number; // 0-1
  impact: number; // 0-1
  riskScore: number; // likelihood * impact
  affectedAreas: string[];
}

export interface ComplianceRisk {
  regulation: 'GDPR' | 'HIPAA' | 'SOX' | 'PCI-DSS' | 'CCPA' | 'PIPEDA';
  status: 'compliant' | 'non-compliant' | 'at-risk' | 'unknown';
  issues: ComplianceIssue[];
  recommendations: string[];
  estimatedFineRisk: number;
}

export interface ComplianceIssue {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  affectedRecords: number;
  remediation: string;
  deadline?: Date;
}
