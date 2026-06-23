/**
 * Architecture Template Service
 * Manages architecture templates and creates architecture options for integration strategies
 */

import type {
  ArchitectureTemplate,
  IndustryStandard
} from '../../types/integration-strategy/templates.types';
import type { IntegrationPattern } from '../../types/integration-strategy/patterns.types';
import type { ArchitectureAssessment } from '../../types/integration-strategy/analysis.types';
import type { IntegrationStrategyInput, ArchitectureOption } from '../../../interfaces';

export class ArchitectureTemplateService {
  private architectureTemplates = new Map<string, ArchitectureTemplate>();

  constructor() {
    this.initializeArchitectureTemplates();
  }

  /**
   * Initialize architecture templates with common integration patterns
   * PUBLIC (moved from private) - allows external initialization
   */
  public initializeArchitectureTemplates(): void {
    // ERP to CRM Template
    this.addArchitectureTemplate('erp_to_crm', {
      name: 'ERP to CRM Integration',
      sourceTypes: ['erp'],
      targetTypes: ['crm'],
      recommendedPatterns: ['api_first', 'event_driven'],
      complexity: 'medium',
      typicalDuration: 90,
      commonChallenges: ['Data model differences', 'Master data management', 'Real-time synchronization'],
      successFactors: ['Clear data ownership', 'Robust error handling', 'Comprehensive testing']
    });

    // Database to Database Template
    this.addArchitectureTemplate('database_to_database', {
      name: 'Database to Database Integration',
      sourceTypes: ['database'],
      targetTypes: ['database'],
      recommendedPatterns: ['batch_processing', 'event_driven'],
      complexity: 'low',
      typicalDuration: 60,
      commonChallenges: ['Schema differences', 'Data transformation', 'Performance optimization'],
      successFactors: ['ETL process design', 'Data validation', 'Monitoring and alerting']
    });

    // Legacy to Modern Template
    this.addArchitectureTemplate('legacy_to_modern', {
      name: 'Legacy to Modern System Integration',
      sourceTypes: ['file', 'database'],
      targetTypes: ['api', 'crm', 'erp'],
      recommendedPatterns: ['file_based', 'hybrid'],
      complexity: 'high',
      typicalDuration: 120,
      commonChallenges: ['Technology gap', 'Data quality', 'Limited API support'],
      successFactors: ['Incremental approach', 'Data cleansing', 'Change management']
    });
  }

  /**
   * Add an architecture template to the registry
   * PUBLIC - allows external template registration
   */
  public addArchitectureTemplate(templateId: string, template: ArchitectureTemplate): void {
    this.architectureTemplates.set(templateId, template);
  }

  /**
   * Get all architecture templates
   */
  public getTemplates(): Map<string, ArchitectureTemplate> {
    return this.architectureTemplates;
  }

  /**
   * Create an architecture option from a pattern and assessment
   * PUBLIC - main service method for option creation
   */
  public createArchitectureOption(
    pattern: IntegrationPattern,
    input: IntegrationStrategyInput,
    assessment: ArchitectureAssessment
  ): ArchitectureOption {
    const complexityMap = { low: 'low', medium: 'medium', high: 'high' };

    return {
      name: `${pattern.name.replace('_', ' ').toUpperCase()} Architecture`,
      description: pattern.description,
      pros: pattern.benefits,
      cons: pattern.drawbacks,
      estimatedCost: this.estimateCost(pattern, assessment),
      implementationTime: this.estimateTime(pattern, assessment),
      complexity: complexityMap[pattern.complexity] as 'low' | 'medium' | 'high',
      scalability: this.assessPatternScalability(pattern)
    };
  }

  /**
   * Calculate a score for an architecture option
   * Used for ranking and comparing options
   */
  public calculateOptionScore(option: ArchitectureOption): number {
    // Simple scoring algorithm
    let score = 0;

    // Cost factor (lower is better)
    score += (100000 - option.estimatedCost) / 100000 * 30;

    // Time factor (lower is better)
    score += (180 - option.implementationTime) / 180 * 25;

    // Complexity factor (lower is better)
    const complexityScores = { low: 30, medium: 20, high: 10 };
    score += complexityScores[option.complexity];

    // Scalability factor (higher is better)
    const scalabilityScores = { low: 5, medium: 10, high: 15 };
    score += scalabilityScores[option.scalability];

    return score;
  }

  /**
   * Determine approach complexity based on pattern and assessment
   */
  public determineApproachComplexity(
    pattern: IntegrationPattern,
    assessment: ArchitectureAssessment
  ): 'low' | 'medium' | 'high' {
    const patternComplexity = pattern.complexity;
    const systemComplexity = assessment.complexity.overallComplexity;

    if (patternComplexity === 'high' || systemComplexity === 'high' || systemComplexity === 'very_high') {
      return 'high';
    }
    if (patternComplexity === 'medium' || systemComplexity === 'medium') {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Estimate cost for integration pattern
   * PRIVATE - internal calculation method
   */
  private estimateCost(pattern: IntegrationPattern, assessment: ArchitectureAssessment): number {
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
   * Estimate implementation time for integration pattern
   * PRIVATE - internal calculation method
   */
  private estimateTime(pattern: IntegrationPattern, assessment: ArchitectureAssessment): number {
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

  /**
   * Map pattern type to integration approach
   * PUBLIC - utility method for pattern mapping
   */
  public mapPatternTypeToApproach(
    patternType: 'messaging' | 'data' | 'api' | 'event' | 'batch'
  ): 'batch' | 'real_time' | 'hybrid' | 'event_driven' | 'api_first' {
    const patternMapping = {
      'messaging': 'event_driven' as const,
      'data': 'batch' as const,
      'api': 'api_first' as const,
      'event': 'event_driven' as const,
      'batch': 'batch' as const
    };

    return patternMapping[patternType];
  }

  /**
   * Assess pattern scalability
   * PRIVATE - internal assessment method
   */
  private assessPatternScalability(pattern: IntegrationPattern): 'low' | 'medium' | 'high' {
    // Simplified scalability assessment based on pattern type
    const scalabilityMap = {
      'api': 'high',
      'event': 'high',
      'batch': 'medium',
      'messaging': 'high',
      'data': 'low'
    };

    return scalabilityMap[pattern.type] as 'low' | 'medium' | 'high' || 'medium';
  }
}
