/**
 * Business Intelligence Analysis Types
 * Impact analysis, ROI calculation, and compliance validation result types
 */

export interface BusinessImpactAnalysis {
  analysisId?: string;
  timestamp?: Date;
  overallScore?: number;
  businessValue?: {
    currentState: {
      dataQualityScore: number;
      processEfficiency: number;
      complianceRating: number;
      operationalCost: number;
    };
    potentialImprovements: {
      qualityGainPercentage: number;
      efficiencyGainPercentage: number;
      costReductionPercentage: number;
      revenueUpliftPercentage: number;
    };
    monetaryImpact: {
      annualSavings: number;
      revenueOpportunity: number;
      implementationCost: number;
      netROI: number;
      paybackPeriodMonths: number;
    };
  };
  riskAssessment?: {
    overallRiskLevel: 'low' | 'medium' | 'high' | 'critical';
    riskCategories: unknown[];
    mitigationStrategies: unknown[];
    complianceRisks: unknown[];
  };
  recommendations?: unknown[];
  projections?: unknown[];
  complianceStatus?: unknown;
  organizationalImpact?: unknown;
  financialProjections?: unknown;
  operationalEfficiency?: unknown;
  strategicAlignment?: unknown;
}

export interface ROICalculation {
  calculationId?: string;
  timestamp?: Date;
  scenario?: 'conservative' | 'realistic' | 'optimistic';
  initialInvestment?: number;
  annualBenefits?: number;
  annualCosts?: number;
  totalInvestment: number;
  expectedBenefits: number;
  paybackPeriod: number;
  netPresentValue: number;
  internalRateOfReturn: number;
  riskAdjustedROI?: number;
  sensitivityAnalysis?: unknown[];
}

export interface BusinessValue {
  currentState: {
    dataQualityScore: number;
    processEfficiency: number;
    complianceRating: number;
    operationalCost: number;
  };
  potentialImprovements: {
    qualityGainPercentage: number;
    efficiencyGainPercentage: number;
    costReductionPercentage: number;
    revenueUpliftPercentage: number;
  };
  monetaryImpact: {
    annualSavings: number;
    revenueOpportunity: number;
    implementationCost: number;
    netROI: number;
    paybackPeriodMonths: number;
  };
}

export interface SensitivityFactor {
  variable: string;
  baseCase: number;
  pessimistic: number;
  optimistic: number;
  impactOnROI: number;
}

export interface ComplianceStatus {
  overallCompliance: number; // 0-1
  regulations: RegulationCompliance[];
  gaps: ComplianceGap[];
  actionItems: ComplianceAction[];
  auditReadiness: number; // 0-1
}

export interface RegulationCompliance {
  regulation: string;
  applicableControls: number;
  implementedControls: number;
  compliancePercentage: number;
  status: 'compliant' | 'non-compliant' | 'partial';
  lastAssessment: Date;
  nextReview: Date;
}

export interface ComplianceGap {
  regulation: string;
  control: string;
  gapDescription: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  estimatedCostToRemediate: number;
  estimatedTimeToRemediate: number; // days
  businessImpact: string;
}

export interface ComplianceAction {
  actionId: string;
  description: string;
  regulation: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  dueDate: Date;
  owner: string;
  status: 'not_started' | 'in_progress' | 'completed' | 'blocked';
  estimatedEffort: number; // hours
}

export interface BusinessProjection {
  metric: string;
  currentValue: number;
  projectedValue: number;
  improvementPercentage: number;
  timeframe: string;
  confidence: number; // 0-1
  assumptions: string[];
}

export interface ComplianceValidationResult {
  overallCompliance: number;
  regulatoryGaps: unknown[];
  criticalIssues: unknown[];
  recommendations: unknown[];
  regulations?: unknown[];
}
