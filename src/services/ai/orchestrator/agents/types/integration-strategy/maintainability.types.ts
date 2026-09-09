/**
 * Integration Strategy Maintainability Types
 *
 * Types for maintainability analysis, code quality, and technical debt assessment.
 * Extracted from IntegrationStrategyAgent.ts (lines 283-357)
 *
 * @module maintainability.types
 */

export interface MaintainabilityAnalysis {
  maintainabilityScore: number;
  codeQuality: CodeQualityMetrics;
  technicalDebt: TechnicalDebtAssessment;
  documentationQuality: DocumentationAssessment;
  testCoverage: TestCoverageAnalysis;
  maintainabilityRisks: MaintainabilityRisk[];
}

export interface CodeQualityMetrics {
  complexity: number;
  duplication: number;
  testability: number;
  modularity: number;
  coupling: number;
  cohesion: number;
}

export interface TechnicalDebtAssessment {
  overallDebt: number;
  debtCategories: DebtCategory[];
  remediationPlan: RemediationPlan;
  businessImpact: string;
}

export interface DebtCategory {
  category: 'architecture' | 'code' | 'design' | 'testing' | 'documentation';
  amount: number;
  priority: 'low' | 'medium' | 'high';
  impact: string;
  remediation: string;
}

export interface RemediationPlan {
  phases: RemediationPhase[];
  totalEffort: number;
  totalCost: number;
  timeline: number;
}

export interface RemediationPhase {
  phase: number;
  description: string;
  effort: number;
  cost: number;
  benefits: string[];
  dependencies: string[];
}

export interface DocumentationAssessment {
  completeness: number;
  accuracy: number;
  accessibility: number;
  maintenance: number;
  gaps: string[];
  recommendations: string[];
}

export interface TestCoverageAnalysis {
  unitTestCoverage: number;
  integrationTestCoverage: number;
  e2eTestCoverage: number;
  testQuality: number;
  testAutomation: number;
  testingGaps: string[];
}

export interface MaintainabilityRisk {
  risk: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  description: string;
  mitigation: string;
  timeline: number;
}
