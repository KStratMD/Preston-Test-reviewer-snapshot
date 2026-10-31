/**
 * Integration Strategy Validation Service
 * Extracted from IntegrationStrategyAgent.ts - Phase 3, Batch 2, Service 3/3
 *
 * Handles input validation, requirements clarity assessment, and technical feasibility analysis
 */

import type {
  IntegrationStrategyInput,
  BusinessRequirement
} from '../../../interfaces';

export class IntegrationStrategyValidationService {
  /**
   * Validate integration strategy input
   * PUBLIC method (renamed from validateInputInternal)
   */
  public validateInput(input: IntegrationStrategyInput): boolean {
    // Validate source system profile
    if (!input.sourceSystemProfile || !input.sourceSystemProfile.name || !input.sourceSystemProfile.type) {
      return false;
    }

    // Validate target system profile
    if (!input.targetSystemProfile || !input.targetSystemProfile.name || !input.targetSystemProfile.type) {
      return false;
    }

    // Validate business requirements
    if (!input.businessRequirements || !Array.isArray(input.businessRequirements) || input.businessRequirements.length === 0) {
      return false;
    }

    // Validate each business requirement
    for (const requirement of input.businessRequirements) {
      if (!requirement.id || !requirement.description || !requirement.priority || !requirement.type) {
        return false;
      }
    }

    return true;
  }

  /**
   * Assess requirements clarity score
   * Evaluates completeness of business requirements based on acceptance criteria
   */
  private assessRequirementsClarityScore(requirements: BusinessRequirement[]): number {
    const completeRequirements = requirements.filter(req =>
      req.acceptanceCriteria && req.acceptanceCriteria.length > 0
    ).length;

    return requirements.length > 0 ? completeRequirements / requirements.length : 0.5;
  }

  /**
   * Assess technical feasibility
   * Evaluates feasibility based on system capabilities
   */
  private assessTechnicalFeasibility(input: IntegrationStrategyInput): number {
    // Simplified feasibility assessment
    const sourceCapabilities = input.sourceSystemProfile.capabilities.length;
    const targetCapabilities = input.targetSystemProfile.capabilities.length;

    return Math.min((sourceCapabilities + targetCapabilities) / 10, 1.0);
  }

  /**
   * Calculate confidence score
   * Calculates weighted confidence score from multiple factors
   */
  private calculateConfidence(factors: { factor: string; value: number; weight: number }[]): number {
    let totalWeight = 0;
    let weightedSum = 0;

    for (const { value, weight } of factors) {
      weightedSum += value * weight;
      totalWeight += weight;
    }

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  /**
   * Public method to get requirements clarity score
   * Exposed for use by IntegrationStrategyAgent
   */
  public getRequirementsClarityScore(requirements: BusinessRequirement[]): number {
    return this.assessRequirementsClarityScore(requirements);
  }

  /**
   * Public method to get technical feasibility score
   * Exposed for use by IntegrationStrategyAgent
   */
  public getTechnicalFeasibilityScore(input: IntegrationStrategyInput): number {
    return this.assessTechnicalFeasibility(input);
  }

  /**
   * Public method to calculate confidence
   * Exposed for use by IntegrationStrategyAgent
   */
  public getConfidence(factors: { factor: string; value: number; weight: number }[]): number {
    return this.calculateConfidence(factors);
  }
}
