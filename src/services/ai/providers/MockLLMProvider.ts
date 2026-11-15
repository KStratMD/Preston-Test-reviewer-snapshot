/**
 * Mock LLM Provider for Week 2 Development & Testing
 * Simulates real AI providers with realistic responses and costs
 * Enables complete A/B testing without API keys
 */

import { logger, type Logger } from '../../../utils/Logger';
import { getAllFieldNames, getRecordValues, normalizeRecords } from '../utils/dataRecord';
import type {
  AIProvider,
  MappingContext,
  AISuggestion,
  DataContext,
  FieldDefinition,
  QualityAssessment
} from '../ProviderRegistry';

export interface MockLLMConfig {
  providerId: 'mock-openai' | 'mock-claude' | 'mock-gemini';
  name: string;
  version: string;
  simulatedLatency?: number; // ms
  simulatedCostPerToken?: number; // USD
  simulatedAccuracy?: number; // 0-1
  failureRate?: number; // 0-1, for chaos testing
}

export class MockLLMProvider implements AIProvider {
  public readonly name: string;
  public readonly version: string;

  private readonly config: MockLLMConfig;
  private readonly logger: Logger;

  constructor(logger: Logger, config: MockLLMConfig) {
    this.logger = logger;
    this.config = config;
    this.name = config.name;
    this.version = config.version;
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    // Simulate network latency
    await this.simulateLatency();

    return { ok: true, message: `${this.name} mock connection successful` };
  }

  async generateMappingSuggestions(context: MappingContext): Promise<AISuggestion[]> {
    await this.simulateLatency();

    // Generate realistic mock suggestions based on provider type
    const suggestions = this.generateRealisticSuggestions(context);

    this.logger.info(`${this.name} generated ${suggestions.length} mapping suggestions`, {
      providerId: this.config.providerId,
      sourceSystem: context.sourceSystem,
      targetSystem: context.targetSystem,
      suggestionsCount: suggestions.length
    });

    return suggestions;
  }

  async analyzeDataQuality(data: unknown[], context: DataContext): Promise<QualityAssessment> {
    await this.simulateLatency();

    return this.generateRealisticQualityAssessment(data, context);
  }

  /**
   * Get simulated cost information for this request
   */
  getSimulatedCost(tokensUsed: number): number {
    return tokensUsed * (this.config.simulatedCostPerToken || 0.0001);
  }

  /**
   * Get simulated token count for a request
   */
  getSimulatedTokenCount(context: MappingContext): number {
    // Simulate realistic token usage based on complexity
    const baseTokens = 100;
    const fieldComplexity = context.sourceFields.length + context.targetFields.length;
    const sampleDataTokens = context.sampleData ? JSON.stringify(context.sampleData).length / 4 : 0;

    return Math.round(baseTokens + fieldComplexity * 10 + sampleDataTokens);
  }

  private async simulateLatency(): Promise<void> {
    const latency = this.config.simulatedLatency || 10;
    await new Promise(resolve => setTimeout(resolve, latency));
  }

  private generateRealisticSuggestions(context: MappingContext): AISuggestion[] {
    const suggestions: AISuggestion[] = [];
    const accuracy = this.config.simulatedAccuracy || 0.85;

    // Provider-specific suggestion patterns
    const providerStyles = {
      'mock-openai': {
        confidenceRange: [0.7, 0.95],
        reasoningStyle: 'Detailed semantic analysis shows',
        transformationPreference: ['direct', 'calculation']
      },
      'mock-claude': {
        confidenceRange: [0.75, 0.92],
        reasoningStyle: 'Based on field name patterns and data types',
        transformationPreference: ['direct', 'conditional', 'lookup']
      },
      'mock-gemini': {
        confidenceRange: [0.72, 0.90],
        reasoningStyle: 'Multi-modal analysis indicates',
        transformationPreference: ['direct', 'concatenation']
      }
    };

    const style = providerStyles[this.config.providerId] || providerStyles['mock-openai'];

    // Generate suggestions for each source field
    context.sourceFields.forEach((sourceField, index) => {
      if (index < context.targetFields.length) {
        const targetField = context.targetFields[index];
        const baseConfidence = style.confidenceRange[0] +
          Math.random() * (style.confidenceRange[1] - style.confidenceRange[0]);

        // Adjust confidence based on semantic similarity (mock)
        const semanticBonus = this.calculateSemanticSimilarity(sourceField.name, targetField.name);
        const finalConfidence = Math.min(0.98, baseConfidence + semanticBonus);

        // Apply accuracy simulation
        const isAccurate = Math.random() < accuracy;
        const confidence = isAccurate ? finalConfidence : Math.max(0.3, finalConfidence - 0.4);

        suggestions.push({
          sourceField: sourceField.name,
          targetField: targetField.name,
          confidence,
          transformationType: style.transformationPreference[
            Math.floor(Math.random() * style.transformationPreference.length)
          ] as any,
          reasoning: `${style.reasoningStyle} strong correlation between "${sourceField.name}" and "${targetField.name}". Data types are compatible (${sourceField.type} → ${targetField.type}).`,
          alternatives: this.generateAlternatives(context.targetFields, targetField, style)
        });
      }
    });

    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private calculateSemanticSimilarity(source: string, target: string): number {
    // Simple semantic similarity mock
    const sourceNorm = source.toLowerCase().replace(/[_-]/g, '');
    const targetNorm = target.toLowerCase().replace(/[_-]/g, '');

    if (sourceNorm === targetNorm) return 0.2;
    if (sourceNorm.includes(targetNorm) || targetNorm.includes(sourceNorm)) return 0.15;

    // Common field patterns
    const patterns = [
      ['id', 'identifier'], ['name', 'title'], ['email', 'mail'],
      ['phone', 'tel'], ['address', 'addr'], ['date', 'time']
    ];

    for (const [a, b] of patterns) {
      if ((sourceNorm.includes(a) && targetNorm.includes(b)) ||
          (sourceNorm.includes(b) && targetNorm.includes(a))) {
        return 0.1;
      }
    }

    return 0;
  }

  private generateAlternatives(targetFields: FieldDefinition[], primaryTarget: FieldDefinition, style: unknown): AISuggestion[] {
    const alternatives: AISuggestion[] = [];
    const otherFields = targetFields.filter(f => f.name !== primaryTarget.name);

    // Generate 1-2 alternatives
    for (let i = 0; i < Math.min(2, otherFields.length); i++) {
      const altField = otherFields[i];
      alternatives.push({
        sourceField: '', // Will be set by parent
        targetField: altField.name,
        confidence: Math.random() * 0.3 + 0.4, // Lower confidence for alternatives
        transformationType: 'direct',
        reasoning: `Alternative mapping consideration: ${altField.name} could be relevant with additional transformation logic.`
      });
    }

    return alternatives;
  }

  private generateRealisticQualityAssessment(data: unknown[], context: DataContext): QualityAssessment {
    const issues: QualityAssessment['issues'] = [];
    const recommendations: string[] = [];

    // Simulate realistic quality analysis
    if (data.length > 0) {
      const normalizedRecords = normalizeRecords(data);
      const totalRecords = normalizedRecords.length;
      const fields = getAllFieldNames(normalizedRecords);

      // Check for missing values
      fields.forEach(field => {
        const presentValues = getRecordValues(normalizedRecords, field);
        const missingCount = totalRecords - presentValues.length;

        if (missingCount > 0) {
          issues.push({
            field,
            severity: missingCount > totalRecords * 0.5 ? 'high' : 'medium',
            type: 'completeness',
            message: `${field} has ${missingCount} missing values in dataset`,
            suggestion: `Consider data cleansing or default value strategies for ${field}`
          });
        }
      });

      // Simulate other quality checks
      if (totalRecords < 10) {
        issues.push({
          field: 'dataset',
          severity: 'low',
          type: 'completeness',
          message: 'Small sample size may not be representative',
          suggestion: 'Consider providing larger sample dataset for more accurate analysis'
        });
      }
    }

    // Generate provider-specific recommendations
    recommendations.push(
      'Validate data types across all fields before integration',
      'Implement data quality monitoring in production',
      'Consider data profiling for ongoing quality assurance'
    );

    const overallScore = Math.max(0.6, 1.0 - (issues.length * 0.1));

    return {
      overallScore,
      issues,
      recommendations
    };
  }
}