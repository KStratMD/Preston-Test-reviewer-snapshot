/**
 * Schema Validation Service - Phase 5 AI Accuracy Improvements
 * Validates AI suggestions against real target system schemas
 *
 * Purpose:
 * - Validate that target fields exist in target system
 * - Check type compatibility between source and target
 * - Validate format requirements (email, phone, date, etc.)
 * - Check length constraints and allowed values
 * - Provide confidence adjustments based on validation results
 * - Suggest alternatives when validation fails
 */

import { logger } from '../../../utils/Logger';
import type { AISuggestion } from '../providers/types';
import { SchemaDiscoveryService } from './SchemaDiscoveryService';
import type {
  SystemSchema,
  SchemaField,
  ValidationResult,
  SystemType,
  EntityType
} from './types';

export interface SchemaValidationConfig {
  strictMode?: boolean; // Fail on any validation error (default: false)
  warnOnMissingField?: boolean; // Warn if field doesn't exist (default: true)
  boostConfidenceOnValid?: boolean; // Boost confidence for valid mappings (default: true)
  confidenceBoostAmount?: number; // Amount to boost (default: +15)
  confidencePenaltyAmount?: number; // Amount to penalize (default: -20)
}

export class SchemaValidationService {
  private logger = logger;
  private config: Required<SchemaValidationConfig>;

  constructor(
    private schemaDiscovery: SchemaDiscoveryService,
    config: SchemaValidationConfig = {}
  ) {
    this.config = {
      strictMode: config.strictMode ?? false,
      warnOnMissingField: config.warnOnMissingField ?? true,
      boostConfidenceOnValid: config.boostConfidenceOnValid ?? true,
      confidenceBoostAmount: config.confidenceBoostAmount ?? 15,
      confidencePenaltyAmount: config.confidencePenaltyAmount ?? 20
    };
  }

  /**
   * Validate a single AI suggestion against target schema
   */
  async validateMapping(
    suggestion: AISuggestion,
    targetSystem: SystemType,
    targetEntity: EntityType,
    sourceFieldType?: string,
    sampleValues?: unknown[]
  ): Promise<ValidationResult> {
    try {
      // Get target system schema
      const schema = await this.schemaDiscovery.getSchema(targetSystem, targetEntity);

      // Find target field in schema
      const targetField = schema.fields.find(
        f => f.name.toLowerCase() === suggestion.targetField.toLowerCase()
      );

      if (!targetField) {
        return this.handleMissingField(suggestion, schema);
      }

      // Perform validation checks
      const checks = {
        fieldExists: true,
        typeCompatible: this.checkTypeCompatibility(sourceFieldType, targetField.type),
        formatValid: this.checkFormatValidity(sampleValues, targetField.format),
        lengthValid: this.checkLengthConstraints(sampleValues, targetField)
      };

      // Calculate confidence adjustment
      let confidenceBoost = 0;
      const warnings: string[] = [];

      if (checks.typeCompatible && checks.formatValid && checks.lengthValid) {
        // All checks passed
        confidenceBoost = this.config.boostConfidenceOnValid ? this.config.confidenceBoostAmount : 0;
      } else {
        // Some checks failed
        if (!checks.typeCompatible) {
          warnings.push(`Type mismatch: ${sourceFieldType} may not be compatible with ${targetField.type}`);
          confidenceBoost -= 10;
        }
        if (!checks.formatValid) {
          warnings.push(`Sample values don't match required format: ${targetField.format}`);
          confidenceBoost -= 10;
        }
        if (!checks.lengthValid) {
          warnings.push(`Some sample values exceed max length: ${targetField.maxLength}`);
          confidenceBoost -= 5;
        }
      }

      const result: ValidationResult = {
        valid: checks.typeCompatible && checks.formatValid && checks.lengthValid,
        warnings: warnings.length > 0 ? warnings : undefined,
        confidenceBoost: confidenceBoost > 0 ? confidenceBoost : undefined,
        confidencePenalty: confidenceBoost < 0 ? Math.abs(confidenceBoost) : undefined,
        metadata: checks
      };

      this.logger.debug('Schema validation completed', {
        targetField: suggestion.targetField,
        valid: result.valid,
        confidenceBoost,
        warnings: warnings.length
      });

      return result;

    } catch (error) {
      this.logger.error('Schema validation failed', {
        error: error.message,
        targetSystem,
        targetEntity,
        targetField: suggestion.targetField
      });

      // Return permissive result on error (don't block suggestions)
      return {
        valid: true,
        warnings: [`Schema validation error: ${error.message}`]
      };
    }
  }

  /**
   * Validate multiple suggestions in batch
   */
  async validateMappings(
    suggestions: AISuggestion[],
    targetSystem: SystemType,
    targetEntity: EntityType,
    sourceFieldTypes?: Record<string, string>,
    sampleData?: unknown[]
  ): Promise<Map<string, ValidationResult>> {
    const results = new Map<string, ValidationResult>();

    await Promise.all(
      suggestions.map(async (suggestion) => {
        const sourceFieldType = sourceFieldTypes?.[suggestion.sourceField];
        const sampleValues = sampleData?.map(d => (d as Record<string, unknown>)[suggestion.sourceField]);

        const result = await this.validateMapping(
          suggestion,
          targetSystem,
          targetEntity,
          sourceFieldType,
          sampleValues
        );

        results.set(suggestion.sourceField, result);
      })
    );

    return results;
  }

  /**
   * Apply validation results to suggestions (adjust confidence)
   */
  applyValidationResults(
    suggestions: AISuggestion[],
    validationResults: Map<string, ValidationResult>
  ): AISuggestion[] {
    return suggestions.map(suggestion => {
      const validation = validationResults.get(suggestion.sourceField);
      if (!validation) return suggestion;

      let adjustedConfidence = suggestion.confidence || 70;

      if (validation.confidenceBoost) {
        adjustedConfidence = Math.min(100, adjustedConfidence + validation.confidenceBoost);
      }

      if (validation.confidencePenalty) {
        adjustedConfidence = Math.max(0, adjustedConfidence - validation.confidencePenalty);
      }

      // Add validation info to reasoning
      let reasoning = suggestion.reasoning || '';
      if (validation.valid && validation.confidenceBoost) {
        reasoning += ` [Schema validated: +${validation.confidenceBoost}% confidence]`;
      }
      if (validation.warnings && validation.warnings.length > 0) {
        reasoning += ` [Warnings: ${validation.warnings.join('; ')}]`;
      }

      return {
        ...suggestion,
        confidence: adjustedConfidence,
        reasoning
      };
    });
  }

  /**
   * Handle missing field in target schema
   */
  private handleMissingField(
    suggestion: AISuggestion,
    schema: SystemSchema
  ): ValidationResult {
    const similarFields = this.findSimilarFields(suggestion.targetField, schema.fields);

    const error = `Field "${suggestion.targetField}" does not exist in ${schema.system} ${schema.entity}`;

    this.logger.warn('Target field not found in schema', {
      targetField: suggestion.targetField,
      system: schema.system,
      entity: schema.entity,
      similarFieldsCount: similarFields.length
    });

    return {
      valid: false,
      error,
      confidencePenalty: this.config.confidencePenaltyAmount,
      alternativeSuggestions: similarFields.length > 0 ? similarFields : undefined,
      metadata: {
        fieldExists: false,
        typeCompatible: false,
        formatValid: false,
        lengthValid: false
      }
    };
  }

  /**
   * Check type compatibility between source and target
   */
  private checkTypeCompatibility(sourceType?: string, targetType?: string): boolean {
    if (!sourceType || !targetType) return true; // Assume compatible if types unknown

    // Normalize types
    const source = sourceType.toLowerCase();
    const target = targetType.toLowerCase();

    // Exact match
    if (source === target) return true;

    // Compatible type mappings
    const compatibleMappings: Record<string, string[]> = {
      'string': ['string', 'text'],
      'number': ['number', 'integer', 'decimal', 'float', 'double', 'currency'],
      'integer': ['number', 'integer'],
      'decimal': ['number', 'decimal', 'float', 'double', 'currency'],
      'date': ['date', 'datetime', 'string'],
      'datetime': ['date', 'datetime', 'string'],
      'boolean': ['boolean', 'string'],
      'email': ['string', 'email'],
      'phone': ['string', 'phone'],
      'url': ['string', 'url']
    };

    const compatibleTargets = compatibleMappings[source];
    return compatibleTargets ? compatibleTargets.includes(target) : false;
  }

  /**
   * Check format validity of sample values
   */
  private checkFormatValidity(sampleValues?: unknown[], requiredFormat?: string): boolean {
    if (!requiredFormat || !sampleValues || sampleValues.length === 0) return true;

    const formatPatterns: Record<string, RegExp> = {
      'email': /^[\w-\.]+@[\w-\.]+\.\w+$/,
      'phone': /^\+?[\d\s\-\(\)]+$/,
      'url': /^https?:\/\/.+/,
      'date': /^\d{4}-\d{2}-\d{2}/,
      'datetime': /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      'uuid': /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    };

    const pattern = formatPatterns[requiredFormat.toLowerCase()];
    if (!pattern) return true; // Format not recognized, assume valid

    // Check if at least 80% of samples match the format
    const validSamples = sampleValues.filter(v => {
      if (v === null || v === undefined) return true; // Null values are OK
      return pattern.test(String(v));
    });

    return validSamples.length >= sampleValues.length * 0.8;
  }

  /**
   * Check length constraints
   */
  private checkLengthConstraints(sampleValues?: unknown[], field?: SchemaField): boolean {
    if (!field || !sampleValues || sampleValues.length === 0) return true;

    for (const value of sampleValues) {
      if (value === null || value === undefined) continue;

      const valueLength = String(value).length;

      if (field.maxLength && valueLength > field.maxLength) {
        return false;
      }

      if (field.minLength && valueLength < field.minLength) {
        return false;
      }
    }

    return true;
  }

  /**
   * Find similar fields using fuzzy matching
   */
  private findSimilarFields(targetField: string, schemaFields: SchemaField[]): SchemaField[] {
    const similarities = schemaFields.map(field => ({
      field,
      similarity: this.calculateSimilarity(targetField, field.name)
    }));

    return similarities
      .filter(({ similarity }) => similarity > 0.6) // 60% similarity threshold
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 3) // Top 3 most similar
      .map(({ field }) => field);
  }

  /**
   * Calculate string similarity (Levenshtein distance based)
   */
  private calculateSimilarity(str1: string, str2: string): number {
    const s1 = str1.toLowerCase();
    const s2 = str2.toLowerCase();

    // Quick checks
    if (s1 === s2) return 1.0;
    if (s1.includes(s2) || s2.includes(s1)) return 0.8;

    // Levenshtein distance
    const distance = this.levenshteinDistance(s1, s2);
    const maxLength = Math.max(s1.length, s2.length);

    return 1 - (distance / maxLength);
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private levenshteinDistance(str1: string, str2: string): number {
    const matrix: number[][] = [];

    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }

    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }

    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1, // substitution
            matrix[i][j - 1] + 1,     // insertion
            matrix[i - 1][j] + 1      // deletion
          );
        }
      }
    }

    return matrix[str2.length][str1.length];
  }
}
