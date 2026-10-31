/**
 * ComplexityAnalysisService
 *
 * Analyzes integration complexity from technical, business, and organizational perspectives.
 * Identifies complexity factors and simplification opportunities.
 *
 * @description Part of IntegrationStrategyAgent refactoring (Phase 3, Batch 1)
 */

import type {
  ComplexityAnalysis,
  ComplexityFactor
} from '../../types/integration-strategy/analysis.types';
import type { SimplificationOpportunity } from '../../types/integration-strategy/scalability.types';

export class ComplexityAnalysisService {
  constructor() {}

  /**
   * Analyze complexity between source and target systems
   * @public - Main entry point
   */
  public analyzeComplexity(
    source: { name: string; type?: string; capabilities?: unknown; limitations?: string[]; apiSupport?: unknown[]; dataVolume?: { recordCount: number; growthRate: number }; securityLevel?: string; version?: string },
    target: { name: string; type?: string; capabilities?: unknown; limitations?: string[]; apiSupport?: unknown[]; dataVolume?: { recordCount: number; growthRate: number }; securityLevel?: string; version?: string }
  ): ComplexityAnalysis {
    // Technical complexity factors
    const technicalComplexity = this.calculateTechnicalComplexity(source, target);

    // Business complexity factors
    const businessComplexity = this.calculateBusinessComplexity(source, target);

    // Organizational complexity factors
    const organizationalComplexity = 0.5; // Placeholder

    const overallComplexity = this.determineOverallComplexity(technicalComplexity, businessComplexity, organizationalComplexity);

    // Identify complexity factors
    const complexityFactors = this.identifyComplexityFactors(source, target);

    // Find simplification opportunities
    const simplificationOpportunities = this.findSimplificationOpportunities(complexityFactors);

    return {
      overallComplexity,
      technicalComplexity,
      businessComplexity,
      organizationalComplexity,
      complexityFactors,
      simplificationOpportunities
    };
  }

  /**
   * Calculate technical complexity score
   * @private
   */
  private calculateTechnicalComplexity(
    source: { type?: string; limitations?: string[]; apiSupport?: unknown[] },
    target: { type?: string; limitations?: string[]; apiSupport?: unknown[] }
  ): number {
    let complexity = 0.5; // Base complexity

    // Add complexity based on system types
    if (source.type === 'file' || target.type === 'file') complexity += 0.1;
    if ((source.limitations?.length || 0) > 3 || (target.limitations?.length || 0) > 3) complexity += 0.2;
    if ((source.apiSupport?.length || 0) === 0 || (target.apiSupport?.length || 0) === 0) complexity += 0.1;

    return Math.min(complexity, 1.0);
  }

  /**
   * Calculate business complexity score
   * @private
   */
  private calculateBusinessComplexity(
    source: { name: string },
    target: { name: string }
  ): number {
    // Simplified business complexity assessment
    return 0.6; // Default medium complexity
  }

  /**
   * Determine overall complexity level
   * @private
   */
  private determineOverallComplexity(
    technical: number,
    business: number,
    organizational: number
  ): 'low' | 'medium' | 'high' | 'very_high' {
    const average = (technical + business + organizational) / 3;

    if (average < 0.3) return 'low';
    if (average < 0.6) return 'medium';
    if (average < 0.8) return 'high';
    return 'very_high';
  }

  /**
   * Identify specific complexity factors
   * @private
   */
  private identifyComplexityFactors(
    source: { name: string; limitations?: string[] },
    target: { name: string; limitations?: string[] }
  ): ComplexityFactor[] {
    const factors: ComplexityFactor[] = [];

    if ((source.limitations?.length || 0) > 3) {
      factors.push({
        factor: 'Source system limitations',
        impact: 'medium',
        description: `${source.name} has ${source.limitations?.length || 0} known limitations`,
        mitigation: 'Design workarounds or consider system upgrades'
      });
    }

    return factors;
  }

  /**
   * Find simplification opportunities
   * @private
   */
  private findSimplificationOpportunities(factors: ComplexityFactor[]): SimplificationOpportunity[] {
    return factors.map(factor => ({
      area: factor.factor,
      description: `Simplify ${factor.factor.toLowerCase()}`,
      potentialReduction: 0.2,
      implementation: 'Redesign approach to avoid complexity',
      risks: ['May limit functionality', 'Requires additional validation']
    }));
  }

  /**
   * Assess overall complexity for a given integration
   * @private
   */
  private assessOverallComplexity(
    source: { name: string; type?: string; capabilities?: unknown; limitations?: string[]; apiSupport?: unknown[] },
    target: { name: string; type?: string; capabilities?: unknown; limitations?: string[]; apiSupport?: unknown[] },
    requirements: { priority?: string }[]
  ): 'low' | 'medium' | 'high' | 'very_high' {
    const techComplexity = this.calculateTechnicalComplexity(source, target);
    const bizComplexity = this.calculateBusinessComplexity(source, target);
    const avgComplexity = (techComplexity + bizComplexity) / 2;

    if (avgComplexity < 0.3) return 'low';
    if (avgComplexity < 0.6) return 'medium';
    if (avgComplexity < 0.8) return 'high';
    return 'very_high';
  }

  /**
   * Assess technical complexity score
   * @private
   */
  private assessTechnicalComplexity(
    source: { type?: string; limitations?: string[] },
    target: { type?: string; limitations?: string[] }
  ): number {
    let complexity = 0.5;
    if (source.type === 'file' || target.type === 'file') complexity += 0.1;
    if ((source.limitations?.length || 0) > 3) complexity += 0.2;
    return Math.min(complexity, 1.0);
  }

  /**
   * Assess business complexity score
   * @private
   */
  private assessBusinessComplexity(requirements: { priority?: string }[]): number {
    if (!requirements || requirements.length === 0) return 0.3;
    const criticalCount = requirements.filter(r => r.priority === 'critical').length;
    return Math.min(0.3 + (criticalCount * 0.2), 1.0);
  }

  /**
   * Assess organizational complexity score
   * @private
   */
  private assessOrganizationalComplexity(
    source: { type?: string; securityLevel?: string },
    target: { type?: string; securityLevel?: string }
  ): number {
    const systemTypeDiff = source.type !== target.type ? 0.3 : 0.1;
    const enterpriseComplexity = (source.securityLevel === 'enterprise' || target.securityLevel === 'enterprise') ? 0.2 : 0.1;
    return Math.min(systemTypeDiff + enterpriseComplexity + 0.2, 1.0);
  }
}
