/**
 * Business Intelligence Core Types
 * Core input/output and configuration interfaces
 */

import type { DataQualityOutput, ProcessOptimizationOutput } from '../../../interfaces';

export interface OrganizationProfile {
  name: string;
  industry: string;
  size: 'small' | 'medium' | 'large' | 'enterprise';
  annualRevenue: number;
  employeeCount: number;
  regulatoryRequirements?: string[];
  geographicRegions?: string[];
}

export interface SystemConfiguration {
  accessControls?: { enabled: boolean };
  auditLogging?: { enabled: boolean };
  dataIntegrity?: { enabled: boolean };
  authentication?: { enabled: boolean };
  transmissionSecurity?: { enabled: boolean };
  encryption?: { enabled: boolean };
}

export interface ImplementationScenario {
  scenario: 'conservative' | 'realistic' | 'optimistic';
  timeframe: number;
  timeHorizonYears?: number; // Alias for timeframe or specific year count
  budget?: number;
  riskTolerance: 'low' | 'medium' | 'high';
  discountRate?: number;
  implementationApproach?: 'phased' | 'big_bang' | 'pilot';
}

export interface BusinessIntelligenceInput {
  dataQualityResults?: DataQualityOutput;
  processOptimizationResults?: ProcessOptimizationOutput;
  organizationProfile: OrganizationProfile;
  systemConfiguration?: SystemConfiguration;
  analysisType: 'business-impact' | 'roi-calculation' | 'compliance-validation' | 'comprehensive';
  implementationScenario?: ImplementationScenario;
}

export interface BusinessIntelligenceOutput {
  businessImpactAnalysis?: import('./analysis.types').BusinessImpactAnalysis;
  roiCalculation?: import('./analysis.types').ROICalculation;
  complianceValidation?: import('./analysis.types').ComplianceValidationResult;
  executiveSummary: import('./summary.types').ExecutiveSummary;
  actionableInsights: import('./insights.types').ActionableInsight[];
  riskAssessment: import('./risk.types').EnhancedRiskAssessment;
  recommendations: import('./insights.types').PrioritizedRecommendation[];
}
