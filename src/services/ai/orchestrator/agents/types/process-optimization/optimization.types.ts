/**
 * Process Optimization Type Definitions
 * Extracted from ProcessOptimizationAgent.ts - October 27, 2025
 *
 * Contains all type definitions for process optimization analysis,
 * bottleneck identification, performance metrics, and optimization recommendations.
 */

import type {
  WorkflowStep,
  ProcessImprovement,
  Bottleneck,
  CostSaving,
  ProcessRisk,
  PerformanceMetric,
  Constraint,
  Objective
} from '../../../interfaces';

// ==================== Core Analysis Types ====================

export interface ProcessAnalysis {
  workflow: AnalyzedWorkflow;
  performance: PerformanceAnalysis;
  bottlenecks: BottleneckAnalysis;
  optimization: OptimizationAnalysis;
  risks: RiskAnalysis;
}

// ==================== Workflow Analysis Types ====================

export interface AnalyzedWorkflow {
  totalSteps: number;
  criticalPath: string[];
  parallelizable: string[];
  sequential: string[];
  cyclicPaths: string[];
  totalDuration: number;
  totalCost: number;
  complexity: 'low' | 'medium' | 'high';
}

// ==================== Performance Types ====================

export interface PerformanceAnalysis {
  throughput: number;
  utilization: number;
  efficiency: number;
  waitTime: number;
  processingTime: number;
  setupTime: number;
  metrics: ProcessMetric[];
}

export interface ProcessMetric {
  name: string;
  current: number;
  target: number;
  unit: string;
  trend: 'improving' | 'stable' | 'declining';
  variance: number;
}

// ==================== Bottleneck Analysis Types ====================

export interface BottleneckAnalysis {
  criticalBottlenecks: Bottleneck[];
  capacity: CapacityAnalysis;
  queueAnalysis: QueueAnalysis;
  resourceConstraints: ResourceConstraint[];
}

export interface CapacityAnalysis {
  currentCapacity: number;
  requiredCapacity: number;
  utilizationRate: number;
  peakLoad: number;
  averageLoad: number;
  capacityGap: number;
}

export interface QueueAnalysis {
  averageQueueLength: number;
  maxQueueLength: number;
  averageWaitTime: number;
  queueingDelay: number;
  serviceRate: number;
  arrivalRate: number;
}

export interface ResourceConstraint {
  resource: string;
  type: 'human' | 'system' | 'infrastructure' | 'external';
  currentUsage: number;
  maxCapacity: number;
  utilizationRate: number;
  isBottleneck: boolean;
  scalability: 'fixed' | 'scalable' | 'elastic';
}

// ==================== Optimization Types ====================

export interface OptimizationAnalysis {
  opportunities: OptimizationOpportunity[];
  scenarios: OptimizationScenario[];
  recommendations: OptimizationRecommendation[];
  impact: ImpactAssessment;
}

export interface OptimizationOpportunity {
  id: string;
  type: 'automation' | 'parallelization' | 'elimination' | 'consolidation' | 'reordering';
  description: string;
  affectedSteps: string[];
  potentialGains: {
    timeReduction: number;
    costReduction: number;
    qualityImprovement: number;
    errorReduction: number;
  };
  implementationEffort: 'low' | 'medium' | 'high';
  prerequisites: string[];
  risks: string[];
}

export interface OptimizationScenario {
  name: string;
  description: string;
  changes: ProcessChange[];
  expectedOutcome: ScenarioOutcome;
  confidence: number;
  timeframe: string;
}

export interface ProcessChange {
  step: string;
  changeType: 'modify' | 'add' | 'remove' | 'replace';
  description: string;
  impact: ChangeImpact;
}

export interface ChangeImpact {
  duration: number;
  cost: number;
  quality: number;
  risk: 'low' | 'medium' | 'high';
}

export interface ScenarioOutcome {
  timeImprovement: number;
  costSavings: number;
  qualityGains: number;
  riskLevel: 'low' | 'medium' | 'high';
  roi: number;
  paybackPeriod: number;
}

export interface OptimizationRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: 'quick_win' | 'strategic' | 'transformational' | 'experimental';
  title: string;
  description: string;
  benefits: string[];
  implementation: ImplementationPlan;
  success_metrics: string[];
}

// ==================== Implementation Types ====================

export interface ImplementationPlan {
  phases: ImplementationPhase[];
  duration: number;
  resources: ResourceRequirement[];
  dependencies: string[];
  risks: ImplementationRisk[];
}

export interface ImplementationPhase {
  phase: number;
  name: string;
  description: string;
  duration: number;
  deliverables: string[];
  successCriteria: string[];
}

export interface ResourceRequirement {
  type: 'human' | 'technology' | 'infrastructure' | 'training';
  description: string;
  quantity: number;
  duration: number;
  cost: number;
}

export interface ImplementationRisk {
  risk: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
}

// ==================== Risk Analysis Types ====================

export interface RiskAnalysis {
  operationalRisks: OperationalRisk[];
  technicalRisks: TechnicalRisk[];
  businessRisks: BusinessRisk[];
  complianceRisks: ComplianceRisk[];
  overallRiskScore: number;
}

export interface OperationalRisk {
  type: 'capacity' | 'dependency' | 'quality' | 'timing' | 'resource';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  currentControls: string[];
  recommendedControls: string[];
}

export interface TechnicalRisk {
  type: 'integration' | 'performance' | 'scalability' | 'reliability' | 'security';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  technicalDebt: number;
  mitigation: string[];
}

export interface BusinessRisk {
  type: 'market' | 'financial' | 'strategic' | 'regulatory' | 'reputation';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  businessImpact: string;
  stakeholderConcerns: string[];
}

export interface ComplianceRisk {
  regulation: string;
  requirement: string;
  currentCompliance: number;
  requiredCompliance: number;
  riskLevel: 'low' | 'medium' | 'high';
  remediation: string[];
}

// ==================== Impact Assessment Types ====================

export interface ImpactAssessment {
  timeImprovement: ImpactMetric;
  costReduction: ImpactMetric;
  qualityGains: ImpactMetric;
  riskReduction: ImpactMetric;
  overallValue: number;
}

export interface ImpactMetric {
  currentValue: number;
  projectedValue: number;
  improvementPercent: number;
  confidence: number;
  timeframe: string;
}

// ==================== Supporting Types (for internal use) ====================

export interface OptimizationPattern {
  id: string;
  name: string;
  description: string;
  applicableScenarios: string[];
  expectedGains: {
    timeReduction: number;
    costReduction: number;
    qualityImprovement: number;
  };
  implementationComplexity: 'low' | 'medium' | 'high';
}

export interface Benchmark {
  industry: string;
  metric: string;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
  unit: string;
}

export interface ProcessTemplate {
  id: string;
  name: string;
  description: string;
  steps: WorkflowStep[];
  recommendedFor: string[];
  averageDuration: number;
  averageCost: number;
  successRate: number;
}
