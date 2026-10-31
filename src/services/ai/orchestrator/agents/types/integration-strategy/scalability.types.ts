/**
 * Integration Strategy Scalability Types
 *
 * Types for scalability analysis, capacity planning, and growth projections.
 * Extracted from IntegrationStrategyAgent.ts (lines 79-144)
 *
 * @module scalability.types
 */

export interface SimplificationOpportunity {
  area: string;
  description: string;
  potentialReduction: number;
  implementation: string;
  risks: string[];
}

export interface ScalabilityAnalysis {
  currentCapacity: CapacityProfile;
  projectedGrowth: GrowthProjection;
  scalabilityLimits: ScalabilityLimit[];
  scalingStrategies: ScalingStrategy[];
  bottlenecks: ScalabilityBottleneck[];
}

export interface CapacityProfile {
  throughput: number;
  concurrentUsers: number;
  dataVolume: number;
  transactionRate: number;
  storageRequirements: number;
}

export interface GrowthProjection {
  timeframe: string;
  expectedGrowth: GrowthMetric[];
  growthFactors: string[];
  uncertainty: 'low' | 'medium' | 'high';
}

export interface GrowthMetric {
  metric: string;
  currentValue: number;
  projectedValue: number;
  growthRate: number;
}

export interface ScalabilityLimit {
  component: string;
  type: 'performance' | 'capacity' | 'architectural' | 'resource';
  limit: number;
  unit: string;
  timeToLimit: number;
  mitigation: string;
}

export interface ScalingStrategy {
  name: string;
  type: 'vertical' | 'horizontal' | 'functional' | 'data';
  description: string;
  applicability: string[];
  benefits: string[];
  challenges: string[];
  cost: 'low' | 'medium' | 'high';
  complexity: 'low' | 'medium' | 'high';
}

export interface ScalabilityBottleneck {
  component: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  resolution: string;
  timeline: number;
  cost: number;
}
