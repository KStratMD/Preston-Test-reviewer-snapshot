/**
 * Integration Strategy Template Types
 *
 * Internal types for architecture templates, industry standards, and implementation phases.
 * These types are used internally by IntegrationStrategyAgent and are NOT exported.
 * Extracted from IntegrationStrategyAgent.ts (lines 2597-2639)
 *
 * @module templates.types
 * @internal
 */

interface ArchitectureTemplate {
  name: string;
  sourceTypes: string[];
  targetTypes: string[];
  recommendedPatterns: string[];
  complexity: 'low' | 'medium' | 'high';
  typicalDuration: number;
  commonChallenges: string[];
  successFactors: string[];
}

interface IndustryStandard {
  name: string;
  standards: string[];
  complianceRequirements: string[];
  securityRequirements: string[];
  dataRequirements: string[];
}

interface ImplementationPhase {
  name: string;
  description: string;
  duration: number;
  cost: number;
  deliverables: string[];
  risks: string[];
  resources: ResourceRequirement[];
}

interface ResourceRequirement {
  type: 'human' | 'infrastructure' | 'software' | 'hardware';
  description: string;
  quantity: number;
  duration: number;
  cost: number;
}

interface PhaseDependency {
  fromPhase: string;
  toPhase: string;
  type: 'blocking' | 'preferred' | 'optional';
  description: string;
}

// Export types for use within IntegrationStrategyAgent only
export type {
  ArchitectureTemplate,
  IndustryStandard,
  ImplementationPhase,
  ResourceRequirement,
  PhaseDependency
};
