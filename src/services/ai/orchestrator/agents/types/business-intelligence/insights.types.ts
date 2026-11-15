/**
 * Business Intelligence Insights Types
 * Actionable insights and prioritized recommendations
 */

export interface ActionableInsight {
  insightId: string;
  category: 'data-quality' | 'process-optimization' | 'compliance' | 'cost-reduction' | 'revenue-enhancement';
  title: string;
  description: string;
  businessImpact: string;
  implementationEffort: 'low' | 'medium' | 'high';
  timeToImplement: number; // days
  estimatedCost: number;
  expectedBenefit: number;
  riskLevel: 'low' | 'medium' | 'high';
  dependencies: string[];
  successMetrics: string[];
}

export interface PrioritizedRecommendation {
  recommendationId: string;
  priority: 'critical' | 'high' | 'medium' | 'low';
  category: 'immediate' | 'short-term' | 'medium-term' | 'long-term';
  title: string;
  description: string;
  businessJustification: string;
  expectedOutcome: string;
  implementationPlan: import('./implementation.types').ImplementationPlan;
  successCriteria: string[];
  riskConsiderations: string[];
  dependencies: string[];
}

export interface BusinessRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: 'data_quality' | 'process_optimization' | 'compliance' | 'cost_reduction' | 'revenue_enhancement';
  title: string;
  description: string;
  businessJustification: string;
  implementationSteps: string[];
  estimatedROI: number;
  implementationTimeframe: string;
  resourceRequirements: import('./implementation.types').ResourceRequirement[];
  riskLevel: 'low' | 'medium' | 'high';
  dependsOn: string[];
}
