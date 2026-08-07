/**
 * Integration Pattern Analysis Service
 * Handles integration pattern analysis, comparison, and selection
 * Extracted from IntegrationStrategyAgent (Phase 3, Batch 2, Service 1/3)
 */

import type {
  SystemProfile,
  BusinessRequirement
} from '../../../interfaces';

import type {
  IntegrationPatternAnalysis,
  IntegrationPattern,
  PatternComparison,
  ComparisonCriteria,
  AntiPattern,
  BestPractice
} from '../../types/integration-strategy/patterns.types';

import type { ArchitectureAssessment } from '../../types/integration-strategy/analysis.types';

export class IntegrationPatternAnalysisService {
  private integrationPatterns: Map<string, IntegrationPattern>;

  constructor(integrationPatterns: Map<string, IntegrationPattern>) {
    this.integrationPatterns = integrationPatterns;
  }

  /**
   * Analyze integration patterns for the given systems and requirements
   * PUBLIC method - main entry point for pattern analysis
   */
  public analyzeIntegrationPatterns(
    sourceSystem: SystemProfile,
    targetSystem: SystemProfile,
    requirements: BusinessRequirement[]
  ): IntegrationPatternAnalysis {
    // Find applicable patterns
    const recommendedPatterns = this.findApplicablePatterns(sourceSystem, targetSystem, requirements);

    // Compare patterns
    const patternComparison = this.comparePatterns(recommendedPatterns);

    // Identify anti-patterns
    const antiPatterns = this.identifyAntiPatterns(sourceSystem, targetSystem);

    // Generate best practices
    const bestPractices = this.generateBestPractices(sourceSystem, targetSystem, requirements);

    return {
      recommendedPatterns,
      patternComparison,
      antiPatterns,
      bestPractices
    };
  }

  /**
   * Select the best pattern based on requirements, assessment, and risks
   * PUBLIC method - pattern selection
   */
  public selectBestPattern(
    patterns: IntegrationPattern[],
    requirements: BusinessRequirement[],
    assessment: ArchitectureAssessment,
    risks: unknown[]
  ): IntegrationPattern {
    // Simple selection based on complexity and maturity
    const provenPatterns = patterns.filter(p => p.maturity === 'proven');
    if (provenPatterns.length > 0) {
      // Select the least complex proven pattern
      return provenPatterns.reduce((best, current) => {
        const complexityOrder = { low: 1, medium: 2, high: 3 };
        return complexityOrder[current.complexity] < complexityOrder[best.complexity] ? current : best;
      });
    }

    return patterns[0]; // Fallback to first pattern
  }

  /**
   * Assess pattern maturity score
   * PUBLIC method - maturity assessment
   */
  public assessPatternMaturity(analysis: IntegrationPatternAnalysis): number {
    const maturePatterns = analysis.recommendedPatterns.filter(p => p.maturity === 'proven').length;
    return maturePatterns / analysis.recommendedPatterns.length;
  }

  /**
   * Assess pattern scalability
   * PUBLIC method - scalability assessment
   */
  public assessPatternScalability(pattern: IntegrationPattern): 'low' | 'medium' | 'high' {
    // Simplified scalability assessment based on pattern type
    const scalabilityMap: Record<string, 'low' | 'medium' | 'high'> = {
      'api': 'high',
      'event': 'high',
      'batch': 'medium',
      'messaging': 'high',
      'data': 'low'
    };

    return scalabilityMap[pattern.type] || 'medium';
  }

  // ============================================================================
  // PRIVATE METHODS
  // ============================================================================

  private findApplicablePatterns(
    source: SystemProfile,
    target: SystemProfile,
    requirements: BusinessRequirement[]
  ): IntegrationPattern[] {
    return Array.from(this.integrationPatterns.values()).filter(pattern => {
      // Simple applicability check
      return pattern.maturity === 'proven';
    });
  }

  private comparePatterns(patterns: IntegrationPattern[]): PatternComparison[] {
    const comparisons: PatternComparison[] = [];

    for (let i = 0; i < patterns.length - 1; i++) {
      for (let j = i + 1; j < patterns.length; j++) {
        comparisons.push({
          pattern1: patterns[i].name,
          pattern2: patterns[j].name,
          comparison: {
            performance: 0.8,
            complexity: patterns[i].complexity === 'low' ? 0.9 : 0.5,
            maintainability: 0.7,
            scalability: 0.8,
            cost: 0.6,
            riskLevel: 0.3
          },
          recommendation: patterns[i].complexity < patterns[j].complexity ? patterns[i].name : patterns[j].name,
          reasoning: 'Based on complexity and maturity assessment'
        });
      }
    }

    return comparisons;
  }

  private identifyAntiPatterns(source: SystemProfile, target: SystemProfile): AntiPattern[] {
    const antiPatterns: AntiPattern[] = [];

    // Big Ball of Mud anti-pattern
    if (source.limitations.length > 5 || target.limitations.length > 5) {
      antiPatterns.push({
        name: 'Big Ball of Mud Integration',
        description: 'Overly complex integration with too many dependencies',
        problems: ['Hard to maintain', 'Brittle connections', 'Poor performance'],
        alternatives: ['Modular integration', 'API gateway pattern', 'Event-driven architecture'],
        detection: ['High coupling', 'Many point-to-point connections', 'Complex error handling']
      });
    }

    return antiPatterns;
  }

  private generateBestPractices(
    source: SystemProfile,
    target: SystemProfile,
    requirements: BusinessRequirement[]
  ): BestPractice[] {
    const practices: BestPractice[] = [];

    // Always include monitoring
    practices.push({
      practice: 'Comprehensive Monitoring',
      category: 'monitoring',
      description: 'Implement end-to-end monitoring and alerting',
      benefits: ['Early issue detection', 'Performance optimization', 'Business insights'],
      implementation: 'Deploy monitoring tools and establish dashboards',
      effort: 'medium'
    });

    // Data validation
    practices.push({
      practice: 'Data Validation Framework',
      category: 'implementation',
      description: 'Implement robust data validation at integration points',
      benefits: ['Data quality assurance', 'Error prevention', 'System reliability'],
      implementation: 'Create validation rules and automated testing',
      effort: 'medium'
    });

    return practices;
  }
}
