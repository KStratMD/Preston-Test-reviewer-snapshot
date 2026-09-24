/**
 * Resource Estimation Service - Cost and Time Estimation
 * Extracted from IntegrationStrategyAgent
 */

import type {
  ArchitectureAssessment
} from '../../types/integration-strategy/analysis.types';

import type {
  IntegrationPattern
} from '../../types/integration-strategy/patterns.types';

export class ResourceEstimationService {
  /**
   * Estimate cost for integration pattern
   */
  estimateCost(pattern: IntegrationPattern, assessment: ArchitectureAssessment): number {
    let baseCost = 25000; // Base cost

    // Adjust for complexity
    const complexityMultiplier = { low: 1, medium: 1.5, high: 2.5 };
    baseCost *= complexityMultiplier[pattern.complexity];

    // Adjust for system compatibility
    if (assessment.compatibility.overallScore < 0.7) {
      baseCost *= 1.3; // 30% increase for low compatibility
    }

    return Math.round(baseCost);
  }

  /**
   * Estimate time for integration pattern
   */
  estimateTime(pattern: IntegrationPattern, assessment: ArchitectureAssessment): number {
    let baseTime = 60; // Base time in days

    // Adjust for complexity
    const complexityMultiplier = { low: 1, medium: 1.5, high: 2 };
    baseTime *= complexityMultiplier[pattern.complexity];

    // Adjust for system compatibility
    if (assessment.compatibility.overallScore < 0.7) {
      baseTime *= 1.2; // 20% increase for low compatibility
    }

    return Math.round(baseTime);
  }
}
