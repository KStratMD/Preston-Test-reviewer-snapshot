/**
 * Rule-Based Provider Adapter
 * Adapts existing RuleBasedAIProvider to work with ProviderRegistry interface
 */

import { logger, type Logger } from '../../../utils/Logger';
import { RuleBasedAIProvider } from './RuleBasedAIProvider';
import type {
  AIProvider,
  MappingContext,
  AISuggestion,
  DataContext,
  QualityAssessment,
  FieldDefinition
} from '../ProviderRegistry';
import { getAllFieldNames, getRecordValues, normalizeRecords } from '../utils/dataRecord';

export class RuleBasedProviderAdapter implements AIProvider {
  public readonly name = 'Rule-Based Heuristic Mapper';
  public readonly version = '1.0.0';

  private readonly ruleBasedProvider: RuleBasedAIProvider;

  constructor(private logger: Logger) {
    this.ruleBasedProvider = new RuleBasedAIProvider(logger);
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    return { ok: true, message: 'Rule-based provider ready' };
  }

  async generateMappingSuggestions(context: MappingContext): Promise<AISuggestion[]> {
    try {
      const suggestions: AISuggestion[] = [];

      // Use the semantic analyzer from RuleBasedAIProvider for each source field
      for (const sourceField of context.sourceFields) {
        const candidateFields = context.targetFields.map(f => f.name);

        const semanticMatches = await this.ruleBasedProvider.findSemanticMatches(
          sourceField.name,
          candidateFields,
          {
            sourceSystem: context.sourceSystem,
            targetSystem: context.targetSystem,
            domain: context.industry || 'general'
          }
        );

        // Convert semantic matches to AISuggestions
        for (const match of semanticMatches.slice(0, 3)) { // Top 3 matches
          const targetField = context.targetFields.find(f => f.name === match.field);
          if (targetField) {

            // Determine transformation type based on data types
            let transformationType: AISuggestion['transformationType'] = 'direct';
            if (sourceField.type !== targetField.type) {
              if (sourceField.type === 'string' && targetField.type === 'number') {
                transformationType = 'calculation';
              } else if (sourceField.type !== targetField.type) {
                transformationType = 'conditional';
              }
            }

            const suggestion: AISuggestion = {
              sourceField: sourceField.name,
              targetField: targetField.name,
              confidence: match.similarity,
              transformationType,
              reasoning: match.explanation,
              alternatives: [] // Will be populated with other matches
            };

            // Add alternatives from remaining matches
            const alternatives = semanticMatches
              .slice(1)
              .filter(alt => alt.field !== match.field)
              .slice(0, 2)
              .map(alt => ({
                sourceField: sourceField.name,
                targetField: alt.field,
                confidence: alt.similarity,
                transformationType: 'direct' as const,
                reasoning: alt.explanation
              }));

            suggestion.alternatives = alternatives;
            suggestions.push(suggestion);
          }
        }
      }

      // Filter and sort suggestions
      const filteredSuggestions = suggestions
        .filter(s => s.confidence >= 0.3) // Minimum confidence threshold
        .sort((a, b) => b.confidence - a.confidence);

      this.logger.debug('Rule-based mapping suggestions generated', {
        sourceSystem: context.sourceSystem,
        targetSystem: context.targetSystem,
        suggestionsCount: filteredSuggestions.length
      });

      return filteredSuggestions;

    } catch (error) {
      this.logger.error('Rule-based mapping failed', { error: String(error) });
      throw new Error(`Rule-based mapping failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  async analyzeDataQuality(data: unknown[], context: DataContext): Promise<QualityAssessment> {
    const issues: QualityAssessment['issues'] = [];
    const recommendations: string[] = [];

    if (data.length === 0) {
      return {
        overallScore: 0,
        issues: [{
          field: 'dataset',
          severity: 'high',
          type: 'completeness',
          message: 'No data provided for analysis',
          suggestion: 'Provide sample data for quality assessment'
        }],
        recommendations: ['Provide sample data for analysis']
      };
    }

    // Use the pattern analysis from RuleBasedAIProvider
    const normalizedRecords = normalizeRecords(data);
    const totalRecords = normalizedRecords.length;
    const fields = getAllFieldNames(normalizedRecords);

    for (const field of fields) {
      const fieldValues = getRecordValues(normalizedRecords, field);

      try {
        // Analyze field patterns
        const patternResult = await this.ruleBasedProvider.analyzeFieldPattern(
          field,
          fieldValues
        );

        // Check for completeness issues
        const missingValues = totalRecords - fieldValues.length;
        if (missingValues > totalRecords * 0.2) {
          const severity = missingValues > totalRecords * 0.5 ? 'high' : 'medium';
          issues.push({
            field,
            severity,
            type: 'completeness',
            message: `${field} has ${missingValues} missing values (${((missingValues / Math.max(totalRecords, 1)) * 100).toFixed(1)}%)`,
            suggestion: severity === 'high' ?
              `Address missing values in ${field} before integration` :
              `Consider data cleansing strategies for ${field}`
          });
        }

        // Check for consistency issues
        if (patternResult.confidence < 0.7 && patternResult.statistics.totalSamples > 1) {
          issues.push({
            field,
            severity: 'medium',
            type: 'consistency',
            message: `${field} has inconsistent data patterns (${(patternResult.confidence * 100).toFixed(1)}% consistency)`,
            suggestion: `Standardize data format for ${field}`
          });
        }

        // Check data type classification
        const typeClassification = await this.ruleBasedProvider.classifyDataType(fieldValues);
        if (typeClassification.confidence < 0.8) {
          issues.push({
            field,
            severity: 'low',
            type: 'validity',
            message: `${field} has unclear data type classification`,
            suggestion: `Review and validate data types for ${field}`
          });
        }

      } catch (error) {
        this.logger.warn('Failed to analyze field pattern', { field, error: String(error) });
      }
    }

    // Check sample size
    if (totalRecords < 5) {
      issues.push({
        field: 'dataset',
        severity: 'low',
        type: 'completeness',
        message: 'Small sample size may not be representative',
        suggestion: 'Provide larger sample dataset for more accurate analysis'
      });
    }

    // Generate recommendations
    recommendations.push(
      'Implement data validation rules before integration',
      'Consider data profiling for comprehensive quality assessment',
      'Set up data quality monitoring in production'
    );

    if (issues.length === 0) {
      recommendations.push('Data quality appears good for integration');
    }

    // Calculate overall score
    let score = 1.0;
    issues.forEach(issue => {
      switch (issue.severity) {
        case 'high': score -= 0.3; break;
        case 'medium': score -= 0.15; break;
        case 'low': score -= 0.05; break;
      }
    });

    score = Math.max(0, Math.min(1, score));

    return {
      overallScore: score,
      issues,
      recommendations
    };
  }
}