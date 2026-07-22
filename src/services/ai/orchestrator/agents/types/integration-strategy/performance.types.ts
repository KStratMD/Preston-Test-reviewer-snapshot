/**
 * Integration Strategy Performance Types
 *
 * Types for performance analysis, requirements, and optimization.
 * Extracted from IntegrationStrategyAgent.ts (lines 231-281)
 *
 * @module performance.types
 */

export interface PerformanceAnalysis {
  currentPerformance: PerformanceProfile;
  performanceRequirements: PerformanceRequirement[];
  performanceGaps: PerformanceGap[];
  optimizationOpportunities: PerformanceOptimization[];
  performanceRisks: PerformanceRisk[];
}

export interface PerformanceProfile {
  latency: number;
  throughput: number;
  availability: number;
  responseTime: number;
  errorRate: number;
  concurrency: number;
}

export interface PerformanceRequirement {
  metric: string;
  target: number;
  unit: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  tolerance: number;
}

export interface PerformanceGap {
  metric: string;
  current: number;
  required: number;
  gap: number;
  impact: 'low' | 'medium' | 'high';
  remediation: string;
}

export interface PerformanceOptimization {
  area: string;
  description: string;
  expectedImprovement: number;
  implementation: string;
  cost: number;
  timeline: number;
  risks: string[];
}

export interface PerformanceRisk {
  risk: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  description: string;
  mitigation: string;
}
