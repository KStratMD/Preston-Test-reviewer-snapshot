/**
 * Cleansing Recommender Service
 * Generates cleansing suggestions and quality recommendations
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { QualityRecommendation, CleansingSuggestion, QualityIssue, DataAnomaly } from '../../interfaces';
import type {
  AnomalyDetectionResult,
  QualityValidation,
  DataProfiling
} from '../types/data-quality';
import type { QualityAssessmentResult } from './QualityScoringService';

@injectable()
export class CleansingRecommender {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Generate comprehensive cleansing suggestions
   */
  async generateCleansingSuggestions(
    qualityAssessment: QualityAssessmentResult,
    anomalyResults: AnomalyDetectionResult
  ): Promise<CleansingSuggestion[]> {
    this.logger.info('Generating cleansing suggestions', {
      issuesCount: qualityAssessment.issues.length,
      anomaliesCount: anomalyResults.anomalies.length
    });

    const suggestions: CleansingSuggestion[] = [];

    // Generate suggestions based on quality issues
    qualityAssessment.issues.forEach((issue: QualityIssue) => {
      switch (issue.type) {
        case 'completeness':
          suggestions.push({
            field: issue.field,
            operation: 'validate',
            description: 'Implement null value handling strategy',
            automatable: true,
            riskLevel: 'low'
          });
          break;
        case 'validity':
          suggestions.push({
            field: issue.field,
            operation: 'standardize',
            description: 'Apply format standardization rules',
            automatable: true,
            riskLevel: 'medium'
          });
          break;
        case 'consistency':
          suggestions.push({
            field: issue.field,
            operation: 'format',
            description: 'Normalize field formatting',
            automatable: true,
            riskLevel: 'low'
          });
          break;
      }
    });

    // Generate suggestions based on anomalies
    anomalyResults.anomalies.forEach(anomaly => {
      if (anomaly.anomalyType === 'outlier') {
        suggestions.push({
          field: anomaly.field,
          operation: 'validate',
          description: 'Review and validate outlier values',
          automatable: false,
          riskLevel: 'high'
        });
      } else if (anomaly.anomalyType === 'missing_expected') {
        suggestions.push({
          field: anomaly.field,
          operation: 'enrich',
          description: 'Fill missing required values',
          automatable: true,
          riskLevel: 'medium'
        });
      } else if (anomaly.anomalyType === 'format_deviation') {
        suggestions.push({
          field: anomaly.field,
          operation: 'standardize',
          description: 'Standardize format variations',
          automatable: true,
          riskLevel: 'low'
        });
      }
    });

    this.logger.info('Cleansing suggestions generated', {
      suggestionsCount: suggestions.length
    });

    return suggestions;
  }

  /**
   * Generate quality improvement recommendations
   */
  async generateQualityRecommendations(
    qualityAssessment: QualityAssessmentResult,
    anomalyResults: AnomalyDetectionResult,
    validationResults: QualityValidation[]
  ): Promise<QualityRecommendation[]> {
    this.logger.info('Generating quality recommendations', {
      overallScore: (qualityAssessment.overallScore * 100).toFixed(1) + '%'
    });

    const recommendations: QualityRecommendation[] = [];

    // Quality-based recommendations
    if (qualityAssessment.overallScore < 0.8) {
      recommendations.push({
        priority: 'high',
        category: 'data_cleaning',
        description: 'Overall data quality is below acceptable threshold',
        estimatedImpact: 'Improved analytics accuracy and reliability',
        implementationEffort: 'medium'
      });
    }

    // Anomaly-based recommendations
    if (anomalyResults.anomalies.length > 0) {
      const highSeverityAnomalies = anomalyResults.anomalies.filter(a => a.severity === 'high');
      if (highSeverityAnomalies.length > 0) {
        recommendations.push({
          priority: 'high',
          category: 'data_cleaning',
          description: `${highSeverityAnomalies.length} high-severity anomalies require immediate attention`,
          estimatedImpact: 'Prevent data corruption and ensure business continuity',
          implementationEffort: 'high'
        });
      }
    }

    // Validation-based recommendations
    const failedValidations = validationResults.filter(v => v.overallScore < 0.9);
    if (failedValidations.length > 0) {
      recommendations.push({
        priority: 'medium',
        category: 'validation_rules',
        description: `${failedValidations.length} fields failing validation rules`,
        estimatedImpact: 'Improved data consistency and compliance',
        implementationEffort: 'low'
      });
    }

    this.logger.info('Quality recommendations generated', {
      recommendationsCount: recommendations.length
    });

    return recommendations;
  }

  /**
   * Suggest completion methods for missing data
   */
  suggestCompletionMethods(field: string, missingPercentage: number): string[] {
    const methods: string[] = [];

    if (missingPercentage < 0.1) {
      methods.push('Remove records with missing values');
    }

    if (missingPercentage < 0.3) {
      methods.push('Impute with mean/median/mode');
      methods.push('Forward/backward fill');
    }

    methods.push('Use ML model for imputation');
    methods.push('Request data from source systems');

    return methods;
  }

  /**
   * Suggest deduplication strategies
   */
  suggestDeduplicationStrategies(field: string, duplicatePercentage: number): string[] {
    const strategies: string[] = [];

    strategies.push('Exact match deduplication');

    if (duplicatePercentage > 0.05) {
      strategies.push('Fuzzy matching with similarity threshold');
      strategies.push('Entity resolution using ML');
    }

    strategies.push('Keep most recent record');
    strategies.push('Merge duplicate records');

    return strategies;
  }

  /**
   * Suggest standardization approaches
   */
  suggestStandardization(field: string, formatVariations: number): string[] {
    const approaches: string[] = [];

    approaches.push('Define canonical format');
    approaches.push('Apply regex-based transformations');

    if (formatVariations > 3) {
      approaches.push('Use NLP for format normalization');
      approaches.push('Implement format validation at input');
    }

    approaches.push('Create lookup table for mappings');

    return approaches;
  }

  /**
   * Suggest validation rules
   */
  suggestValidationRules(field: string, dataType: string, invalidPercentage: number): string[] {
    const rules: string[] = [];

    switch (dataType) {
      case 'string':
      case 'text':
        rules.push('Format validation (regex)');
        rules.push('Length constraints');
        rules.push('Character set validation');
        break;
      case 'number':
      case 'currency':
        rules.push('Range validation');
        rules.push('Precision validation');
        rules.push('Sign validation (positive/negative)');
        break;
      case 'date':
      case 'datetime':
        rules.push('Date format validation');
        rules.push('Date range validation');
        rules.push('Future/past date constraints');
        break;
      case 'email':
        rules.push('Email format validation');
        rules.push('Domain whitelist/blacklist');
        break;
      case 'phone':
        rules.push('Phone format validation');
        rules.push('Country code validation');
        break;
    }

    if (invalidPercentage > 0.2) {
      rules.push('Implement input validation');
      rules.push('Add data quality monitoring');
    }

    return rules;
  }

  /**
   * Prioritize recommendations by impact and effort
   */
  prioritizeRecommendations(recommendations: QualityRecommendation[]): QualityRecommendation[] {
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    const effortOrder = { low: 3, medium: 2, high: 1 };

    return recommendations.sort((a, b) => {
      const aPriorityScore = priorityOrder[a.priority] || 0;
      const bPriorityScore = priorityOrder[b.priority] || 0;

      if (aPriorityScore !== bPriorityScore) {
        return bPriorityScore - aPriorityScore;
      }

      const aEffortScore = effortOrder[a.implementationEffort] || 0;
      const bEffortScore = effortOrder[b.implementationEffort] || 0;

      return bEffortScore - aEffortScore;
    });
  }
}
