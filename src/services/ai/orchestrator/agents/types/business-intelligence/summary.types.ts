/**
 * Business Intelligence Summary Types
 * Executive summary, key findings, and business value types
 */

export interface ExecutiveSummary {
  overallScore: number; // 0-100
  keyFindings: KeyFinding[];
  businessValue: BusinessValueSummary;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  recommendedActions: string[];
  timeToValue: number; // months
  investmentRequired: number;
  projectedROI: number;
}

export interface KeyFinding {
  category: 'opportunity' | 'risk' | 'compliance' | 'efficiency';
  title: string;
  description: string;
  impact: 'low' | 'medium' | 'high' | 'critical';
  quantification?: number;
  timeframe: string;
}

export interface BusinessValueSummary {
  currentStateScore: number;
  potentialImprovementScore: number;
  annualSavingsOpportunity: number;
  revenueUpliftOpportunity: number;
  efficiencyGains: number;
  riskReduction: number;
}
