/**
 * Semantic Validator - Phase 2 AI Accuracy Improvements
 * Validates field mappings and calibrates confidence scores based on:
 * - Type compatibility checks
 * - Format validation (email, phone, date patterns)
 * - Business logic rules (ID transformations, etc.)
 * - Sample data analysis
 */

import type { AISuggestion } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';

export interface ValidationResult {
  isValid: boolean;
  adjustedConfidence: number; // Calibrated confidence after validation
  warnings: string[]; // List of validation warnings
  errors: string[]; // List of validation errors
}

export interface ValidationContext {
  sourceSystem: string;
  targetSystem: string;
  sourceFieldsMetadata: FieldMetadata[];
  targetFieldsMetadata?: FieldMetadata[];
}

export class SemanticValidator {
  /**
   * Validate a single suggestion and calibrate its confidence
   */
  validateSuggestion(
    suggestion: AISuggestion,
    context: ValidationContext
  ): ValidationResult {
    const warnings: string[] = [];
    const errors: string[] = [];
    let confidencePenalty = 0;

    // Get source field metadata
    const sourceField = context.sourceFieldsMetadata.find(f => f.name === suggestion.sourceField);

    if (!sourceField) {
      errors.push(`Source field "${suggestion.sourceField}" not found in metadata`);
      return {
        isValid: false,
        adjustedConfidence: 0,
        warnings,
        errors
      };
    }

    // 1. Type compatibility check
    const typeCheck = this.validateTypeCompatibility(
      sourceField.type || 'unknown',
      suggestion.transformationType
    );
    if (!typeCheck.compatible) {
      if (typeCheck.severity === 'error') {
        errors.push(typeCheck.message);
        confidencePenalty += 30;
      } else {
        warnings.push(typeCheck.message);
        confidencePenalty += 10;
      }
    }

    // 2. Format validation for special types
    const formatCheck = this.validateFormat(sourceField, suggestion);
    if (!formatCheck.valid) {
      warnings.push(formatCheck.message);
      confidencePenalty += 5;
    }

    // 3. Business logic validation
    const businessCheck = this.validateBusinessLogic(sourceField, suggestion, context);
    if (!businessCheck.valid) {
      warnings.push(businessCheck.message);
      confidencePenalty += businessCheck.penalty;
    }

    // 4. Transformation type validation
    const transformCheck = this.validateTransformation(sourceField, suggestion);
    if (!transformCheck.valid) {
      warnings.push(transformCheck.message);
      confidencePenalty += transformCheck.penalty;
    }

    // Calculate adjusted confidence
    const originalConfidence = suggestion.confidence || 70; // Default to 70 if not provided
    const adjustedConfidence = Math.max(0, Math.min(100, originalConfidence - confidencePenalty));

    // If adjusted confidence drops below 70%, mark as invalid
    const isValid = errors.length === 0 && adjustedConfidence >= 70;

    return {
      isValid,
      adjustedConfidence,
      warnings,
      errors
    };
  }

  /**
   * Validate type compatibility between source type and transformation
   */
  private validateTypeCompatibility(
    sourceType: string,
    transformationType: string
  ): { compatible: boolean; severity: 'error' | 'warning'; message: string } {
    // Direct mappings require compatible types
    if (transformationType === 'direct') {
      // Complex types may need transformation
      if (sourceType === 'date' || sourceType === 'array' || sourceType === 'object') {
        return {
          compatible: false,
          severity: 'warning',
          message: `Direct mapping from ${sourceType} may require transformation for proper formatting`
        };
      }
    }

    // Lookup transformations typically for IDs
    if (transformationType === 'lookup') {
      if (sourceType !== 'string' && sourceType !== 'integer') {
        return {
          compatible: false,
          severity: 'warning',
          message: `Lookup transformation unusual for type ${sourceType}, typically used for IDs`
        };
      }
    }

    return { compatible: true, severity: 'warning', message: '' };
  }

  /**
   * Validate format consistency (email, phone, date patterns)
   */
  private validateFormat(
    sourceField: FieldMetadata,
    suggestion: AISuggestion
  ): { valid: boolean; message: string } {
    const sourceType = sourceField.type || 'unknown';
    const targetFieldLower = suggestion.targetField.toLowerCase();

    // Email validation
    if (sourceType === 'email') {
      if (!targetFieldLower.includes('email') && !targetFieldLower.includes('mail')) {
        return {
          valid: false,
          message: `Email field mapping to non-email target "${suggestion.targetField}" may be incorrect`
        };
      }
    }

    // Phone validation
    if (sourceType === 'phone') {
      if (!targetFieldLower.includes('phone') && !targetFieldLower.includes('tel') &&
          !targetFieldLower.includes('mobile')) {
        return {
          valid: false,
          message: `Phone field mapping to non-phone target "${suggestion.targetField}" may be incorrect`
        };
      }
    }

    // Date validation
    if (sourceType === 'date') {
      if (!targetFieldLower.includes('date') && !targetFieldLower.includes('time') &&
          !targetFieldLower.includes('created') && !targetFieldLower.includes('modified') &&
          !targetFieldLower.includes('updated')) {
        return {
          valid: false,
          message: `Date field mapping to non-date target "${suggestion.targetField}" may be incorrect`
        };
      }
    }

    return { valid: true, message: '' };
  }

  /**
   * Validate business logic rules
   */
  private validateBusinessLogic(
    sourceField: FieldMetadata,
    suggestion: AISuggestion,
    context: ValidationContext
  ): { valid: boolean; message: string; penalty: number } {
    const sourceFieldLower = suggestion.sourceField.toLowerCase();
    const targetFieldLower = suggestion.targetField.toLowerCase();

    // ID fields should typically use lookup transformations
    if ((sourceFieldLower.includes('id') || sourceFieldLower.includes('_id')) &&
        (targetFieldLower.includes('id') || targetFieldLower.includes('_id'))) {
      if (suggestion.transformationType === 'direct') {
        return {
          valid: false,
          message: `ID field mapping "${suggestion.sourceField}" → "${suggestion.targetField}" should typically use 'lookup' transformation, not 'direct'`,
          penalty: 15
        };
      }
    }

    // Name fields split/concat validation
    if (sourceFieldLower.includes('name') && targetFieldLower.includes('name')) {
      const sourceIsFull = sourceFieldLower.includes('full') || sourceFieldLower === 'name';
      const targetIsFirst = targetFieldLower.includes('first') || targetFieldLower.includes('fname');
      const targetIsLast = targetFieldLower.includes('last') || targetFieldLower.includes('lname');

      if (sourceIsFull && (targetIsFirst || targetIsLast)) {
        if (suggestion.transformationType !== 'concatenation') {
          return {
            valid: false,
            message: `Mapping full name to first/last name should use 'concatenation' transformation`,
            penalty: 10
          };
        }
      }
    }

    // Currency/amount fields should preserve decimal precision
    if ((sourceFieldLower.includes('amount') || sourceFieldLower.includes('price') ||
         sourceFieldLower.includes('cost')) && sourceField.type === 'decimal') {
      if (suggestion.transformationType === 'direct') {
        // Warning, not error - may need calculation for currency conversion
        return {
          valid: true,
          message: `Currency field "${suggestion.sourceField}" may need 'calculation' for currency conversion`,
          penalty: 5
        };
      }
    }

    return { valid: true, message: '', penalty: 0 };
  }

  /**
   * Validate transformation type appropriateness
   */
  private validateTransformation(
    sourceField: FieldMetadata,
    suggestion: AISuggestion
  ): { valid: boolean; message: string; penalty: number } {
    const sourceType = sourceField.type || 'unknown';
    const transformation = suggestion.transformationType;

    // Date fields typically need calculation transformation
    if (sourceType === 'date' && transformation === 'direct') {
      return {
        valid: false,
        message: `Date field "${suggestion.sourceField}" typically requires 'calculation' transformation for format conversion`,
        penalty: 10
      };
    }

    // Check if transformation is recognized
    const validTransformations = ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom'];
    if (!validTransformations.includes(transformation)) {
      return {
        valid: false,
        message: `Unknown transformation type "${transformation}"`,
        penalty: 20
      };
    }

    return { valid: true, message: '', penalty: 0 };
  }

  /**
   * Batch validate multiple suggestions and filter by adjusted confidence
   */
  validateBatch(
    suggestions: AISuggestion[],
    context: ValidationContext,
    minConfidence = 70
  ): (AISuggestion & { validationResult: ValidationResult })[] {
    return suggestions
      .map(suggestion => {
        const validationResult = this.validateSuggestion(suggestion, context);
        return {
          ...suggestion,
          confidence: validationResult.adjustedConfidence, // Update with calibrated confidence
          validationResult
        };
      })
      .filter(item => item.validationResult.isValid && item.confidence >= minConfidence)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0)); // Sort by confidence descending
  }
}
