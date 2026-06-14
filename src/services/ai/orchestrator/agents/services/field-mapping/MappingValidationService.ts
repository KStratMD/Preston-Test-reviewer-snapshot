import type { DataSample, MappingSuggestion, TransformationRule } from '../../fieldMappingTypes';
import type { EnhancedFieldMapping, FieldMappingInput } from '../../../interfaces';

/**
 * Handles post-suggestion validation, alternative generation, and data-quality scoring.
 */
export class MappingValidationService {
  validateMappings(
    suggestions: MappingSuggestion[],
    input: FieldMappingInput,
    confidenceThreshold: number
  ): EnhancedFieldMapping[] {
    const validated: EnhancedFieldMapping[] = [];

    for (const suggestion of suggestions) {
      let isValid = true;
      let validationScore = 1.0;

      if (input.sampleData && input.sampleData.length > 0) {
        const sampleValidation = this.validateWithSampleData(suggestion, input.sampleData as DataSample[]);
        isValid = sampleValidation.isValid;
        validationScore = sampleValidation.score;
      }

      if (isValid && suggestion.confidence > confidenceThreshold) {
        validated.push({
          sourceField: suggestion.sourceField,
          targetField: suggestion.targetField,
          confidence: suggestion.confidence * validationScore,
          transformationType: suggestion.transformation.type,
          transformationLogic: suggestion.transformation.expression,
          validationRules: this.generateValidationRules(suggestion),
          businessRule: suggestion.reasoning.join('; '),
          dataQualityImpact: this.assessDataQualityImpact(suggestion),
          alternatives: suggestion.alternatives,
          origin: suggestion.origin,
          providerId: suggestion.providerId
        });
      }
    }

    return validated;
  }

  generateAlternatives(mappings: EnhancedFieldMapping[]): EnhancedFieldMapping[] {
    return mappings.map(mapping => {
      if (mapping.alternatives && mapping.alternatives.length > 0) {
        return mapping;
      }

      return {
        ...mapping,
        alternatives: []
      };
    });
  }

  private validateWithSampleData(
    suggestion: MappingSuggestion,
    sampleData: DataSample[]
  ): { isValid: boolean; score: number } {
    let validSamples = 0;

    for (const sample of sampleData) {
      const container: unknown = (sample as any)?.sourceValues && typeof (sample as any).sourceValues === 'object'
        ? (sample as any).sourceValues
        : sample as any;

      if (!container || typeof container !== 'object') {
        continue;
      }

      const sourceValue = (container as Record<string, unknown>)[suggestion.sourceField];

      if (sourceValue !== undefined) {
        try {
          const isValid = this.testTransformation(sourceValue, suggestion.transformation);
          if (isValid) validSamples++;
        } catch {
          // Ignore transformation errors and mark as invalid
        }
      }
    }

    const score = sampleData.length > 0 ? validSamples / sampleData.length : 1.0;
    return {
      isValid: score > 0.5,
      score
    };
  }

  private testTransformation(value: unknown, transformation: TransformationRule): boolean {
    switch (transformation.type) {
      case 'direct':
        return true;
      case 'calculation':
        return Boolean(transformation.expression);
      case 'lookup':
        return Boolean(transformation.lookupTable);
      default:
        return true;
    }
  }

  private generateValidationRules(suggestion: MappingSuggestion): string[] {
    const rules: string[] = [];
    rules.push('Validate data type compatibility');
    rules.push('Handle null/empty values appropriately');

    if (suggestion.targetField.toLowerCase().includes('email')) {
      rules.push('Validate email format');
    }

    if (suggestion.targetField.toLowerCase().includes('phone')) {
      rules.push('Validate phone number format');
    }

    return rules;
  }

  private assessDataQualityImpact(suggestion: MappingSuggestion): number {
    let impact = 0;

    if (suggestion.transformation.type === 'calculation') impact += 0.3;
    if (suggestion.transformation.type === 'conditional') impact += 0.4;
    if (suggestion.transformation.type === 'lookup') impact += 0.2;
    if (suggestion.confidence < 0.7) impact += 0.3;

    return Math.min(impact, 1.0);
  }
}
