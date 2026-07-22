/**
 * Integration Strategy Pattern Types
 *
 * Types for integration patterns, pattern comparison, and best practices.
 * Extracted from IntegrationStrategyAgent.ts (lines 359-409)
 *
 * @module patterns.types
 */

export interface IntegrationPatternAnalysis {
  recommendedPatterns: IntegrationPattern[];
  patternComparison: PatternComparison[];
  antiPatterns: AntiPattern[];
  bestPractices: BestPractice[];
}

export interface IntegrationPattern {
  name: string;
  type: 'messaging' | 'data' | 'api' | 'event' | 'batch';
  description: string;
  benefits: string[];
  drawbacks: string[];
  applicability: string[];
  complexity: 'low' | 'medium' | 'high';
  maturity: 'emerging' | 'proven' | 'deprecated';
}

export interface PatternComparison {
  pattern1: string;
  pattern2: string;
  comparison: ComparisonCriteria;
  recommendation: string;
  reasoning: string;
}

export interface ComparisonCriteria {
  performance: number;
  complexity: number;
  maintainability: number;
  scalability: number;
  cost: number;
  riskLevel: number;
}

export interface AntiPattern {
  name: string;
  description: string;
  problems: string[];
  alternatives: string[];
  detection: string[];
}

export interface BestPractice {
  practice: string;
  category: 'design' | 'implementation' | 'testing' | 'deployment' | 'monitoring';
  description: string;
  benefits: string[];
  implementation: string;
  effort: 'low' | 'medium' | 'high';
}
