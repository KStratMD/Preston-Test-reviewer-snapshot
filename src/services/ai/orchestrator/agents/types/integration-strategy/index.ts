/**
 * Integration Strategy Types - Central Export
 *
 * Centralized exports for all Integration Strategy Agent type definitions.
 * This allows consumers to import from a single location:
 *
 * @example
 * import {
 *   ArchitectureAssessment,
 *   SecurityAnalysis,
 *   PerformanceAnalysis
 * } from './types/integration-strategy';
 *
 * @module integration-strategy
 */

// Analysis types (6 interfaces)
export type {
  ArchitectureAssessment,
  CompatibilityAnalysis,
  Incompatibility,
  CompatibilityMitigation,
  ComplexityAnalysis,
  ComplexityFactor
} from './analysis.types';

// Scalability types (7 interfaces)
export type {
  SimplificationOpportunity,
  ScalabilityAnalysis,
  CapacityProfile,
  GrowthProjection,
  GrowthMetric,
  ScalabilityLimit,
  ScalingStrategy,
  ScalabilityBottleneck
} from './scalability.types';

// Security types (11 interfaces)
export type {
  SecurityAnalysis,
  ThreatAssessment,
  SecurityThreat,
  AttackVector,
  RiskMatrix,
  BusinessImpact,
  SecurityVulnerability,
  ComplianceRequirement,
  SecurityControl,
  SecurityRecommendation
} from './security.types';

// Performance types (5 interfaces)
export type {
  PerformanceAnalysis,
  PerformanceProfile,
  PerformanceRequirement,
  PerformanceGap,
  PerformanceOptimization,
  PerformanceRisk
} from './performance.types';

// Maintainability types (10 interfaces)
export type {
  MaintainabilityAnalysis,
  CodeQualityMetrics,
  TechnicalDebtAssessment,
  DebtCategory,
  RemediationPlan,
  RemediationPhase,
  DocumentationAssessment,
  TestCoverageAnalysis,
  MaintainabilityRisk
} from './maintainability.types';

// Pattern types (6 interfaces)
export type {
  IntegrationPatternAnalysis,
  IntegrationPattern,
  PatternComparison,
  ComparisonCriteria,
  AntiPattern,
  BestPractice
} from './patterns.types';

// Template types (5 interfaces - internal use only)
export type {
  ArchitectureTemplate,
  IndustryStandard,
  ImplementationPhase,
  ResourceRequirement,
  PhaseDependency
} from './templates.types';
