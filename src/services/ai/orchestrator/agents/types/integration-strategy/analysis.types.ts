/**
 * Integration Strategy Analysis Types
 *
 * Core types for architecture assessment and compatibility analysis.
 * Extracted from IntegrationStrategyAgent.ts (lines 27-77)
 *
 * @module analysis.types
 */

import type { SimplificationOpportunity } from './scalability.types';
import type { ScalabilityAnalysis } from './scalability.types';
import type { SecurityAnalysis } from './security.types';
import type { PerformanceAnalysis } from './performance.types';
import type { MaintainabilityAnalysis } from './maintainability.types';

export interface ArchitectureAssessment {
  compatibility: CompatibilityAnalysis;
  complexity: ComplexityAnalysis;
  scalability: ScalabilityAnalysis;
  security: SecurityAnalysis;
  performance: PerformanceAnalysis;
  maintainability: MaintainabilityAnalysis;
}

export interface CompatibilityAnalysis {
  overallScore: number;
  apiCompatibility: number;
  dataFormatCompatibility: number;
  protocolCompatibility: number;
  versionCompatibility: number;
  incompatibilities: Incompatibility[];
  mitigations: CompatibilityMitigation[];
}

export interface Incompatibility {
  type: 'api' | 'data' | 'protocol' | 'version' | 'security';
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  impact: string;
  workaround?: string;
}

export interface CompatibilityMitigation {
  incompatibility: string;
  strategy: 'adapter' | 'wrapper' | 'translation' | 'upgrade' | 'replacement';
  description: string;
  effort: 'low' | 'medium' | 'high';
  cost: number;
  timeline: number;
}

export interface ComplexityAnalysis {
  overallComplexity: 'low' | 'medium' | 'high' | 'very_high';
  technicalComplexity: number;
  businessComplexity: number;
  organizationalComplexity: number;
  complexityFactors: ComplexityFactor[];
  simplificationOpportunities: SimplificationOpportunity[];
}

export interface ComplexityFactor {
  factor: string;
  impact: 'low' | 'medium' | 'high';
  description: string;
  mitigation?: string;
}
