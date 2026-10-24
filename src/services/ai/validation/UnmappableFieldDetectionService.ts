/**
 * Unmappable Field Detection Service
 * Detects source fields that have NO suitable equivalent in target ERP
 * Uses multi-factor analysis to distinguish "needs mapping" vs "needs new custom field"
 *
 * Detection Strategy:
 * 1. Analyze AI suggestions and confidence scores
 * 2. Check semantic similarity with target fields
 * 3. Verify type compatibility
 * 4. Check RAG history for similar mappings
 * 5. Require 3+ red flags to classify as unmappable
 * 6. Return structured results with reasons for unmappability
 */

import type { AISuggestion } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';
import type { RAGContext } from '../rag/types';
import { SemanticValidator, type ValidationContext } from './SemanticValidator';
import { SchemaDiscoveryService } from './SchemaDiscoveryService';
import type { SystemType, EntityType } from './types';
import { logger } from '../../../utils/Logger';

export interface UnmappableField {
  // Source field that cannot be mapped
  sourceField: FieldMetadata;
  // Confidence that this field is genuinely unmappable (0-100)
  unmappableConfidence: number;
  // LLM-powered classification of field category
  llmCategory?: 'business_field' | 'system_metadata' | 'technical_field' | 'garbage';
  // Confidence in the LLM classification (0-100)
  llmCategoryConfidence?: number;
  // LLM reasoning for the classification
  llmReasoning?: string[];
  // Red flags that indicate unmappability
  redFlags: RedFlag[];
  // Best attempt at mapping (even if poor)
  bestAttempt?: {
    targetField: string;
    confidence: number;
    reason: string;
  };
  // Suggested custom field creation
  customFieldRecommended: boolean;
}

export interface RedFlag {
  type: RedFlagType;
  severity: 'high' | 'medium' | 'low';
  description: string;
  evidence: Record<string, unknown>;
}

export enum RedFlagType {
  VERY_LOW_CONFIDENCE = 'very_low_confidence',
  LOW_SEMANTIC_SIMILARITY = 'low_semantic_similarity',
  NO_TYPE_COMPATIBILITY = 'no_type_compatibility',
  NO_HISTORICAL_MATCH = 'no_historical_match',
  ALL_ALTERNATIVES_POOR = 'all_alternatives_poor'
}

export interface DetectionConfig {
  // Confidence threshold below which field is suspicious (default: 50)
  suspiciousConfidenceThreshold?: number;
  // Semantic similarity threshold below which field is suspicious (default: 0.4)
  suspiciousSemanticThreshold?: number;
  // Number of red flags required to classify as unmappable (default: 3)
  redFlagThreshold?: number;
  // Maximum confidence for best attempt to still be considered unmappable (default: 60)
  maxBestAttemptConfidence?: number;
}

export class UnmappableFieldDetectionService {
  private semanticValidator: SemanticValidator;
  private schemaDiscovery?: SchemaDiscoveryService;
  private logger = logger;
  private static readonly DEFAULT_CLASSIFICATION: UnmappableField['llmCategory'] = 'business_field';

  // Default thresholds
  private readonly DEFAULT_SUSPICIOUS_CONFIDENCE = 50;
  private readonly DEFAULT_SUSPICIOUS_SEMANTIC = 0.4;
  private readonly DEFAULT_RED_FLAG_THRESHOLD = 3;
  private readonly DEFAULT_MAX_BEST_ATTEMPT = 60;

  constructor(schemaDiscovery?: SchemaDiscoveryService) {
    this.semanticValidator = new SemanticValidator();
    this.schemaDiscovery = schemaDiscovery;
  }

  /**
   * Detect unmappable fields from source field list and AI suggestions
   */
  async detectUnmappableFields(
    sourceFields: FieldMetadata[],
    targetFields: FieldMetadata[],
    suggestions: AISuggestion[],
    ragContextMap: Map<string, RAGContext>,
    config: DetectionConfig = {},
    existingMappings?: { sourceField?: string; sourceFields?: string[]; targetField: string }[]
  ): Promise<UnmappableField[]> {
    const startTime = Date.now();

    // Set defaults
    const suspiciousConfidenceThreshold = config.suspiciousConfidenceThreshold ?? this.DEFAULT_SUSPICIOUS_CONFIDENCE;
    const suspiciousSemanticThreshold = config.suspiciousSemanticThreshold ?? this.DEFAULT_SUSPICIOUS_SEMANTIC;
    const redFlagThreshold = config.redFlagThreshold ?? this.DEFAULT_RED_FLAG_THRESHOLD;
    const maxBestAttemptConfidence = config.maxBestAttemptConfidence ?? this.DEFAULT_MAX_BEST_ATTEMPT;

    // Create set of already mapped source fields
    const mappedSourceFields = new Set<string>();
    if (existingMappings && Array.isArray(existingMappings)) {
      for (const mapping of existingMappings) {
        if (mapping.sourceField) {
          mappedSourceFields.add(mapping.sourceField);
        }
        if (mapping.sourceFields && Array.isArray(mapping.sourceFields)) {
          mapping.sourceFields.forEach(sf => mappedSourceFields.add(sf));
        }
      }
    }

    // Create set of source fields used in multi-field patterns
    const multiFieldSourceFields = new Set<string>();
    for (const suggestion of suggestions) {
      if (Array.isArray(suggestion.sourceFields)) {
        suggestion.sourceFields.forEach(sf => multiFieldSourceFields.add(sf));
      }
    }

    this.logger.info('Starting unmappable field detection', {
      sourceFieldCount: sourceFields.length,
      targetFieldCount: targetFields.length,
      suggestionCount: suggestions.length,
      mappedFieldCount: mappedSourceFields.size,
      multiFieldSourceCount: multiFieldSourceFields.size
    });

    const unmappableFields: UnmappableField[] = [];

    for (const sourceField of sourceFields) {
      // SKIP: Fields that are already mapped
      if (mappedSourceFields.has(sourceField.name)) {
        this.logger.debug(`Skipping ${sourceField.name}: already mapped`);
        continue;
      }

      // SKIP: Fields that are part of multi-field patterns (e.g., firstName in "firstName + lastName → fullName")
      if (multiFieldSourceFields.has(sourceField.name)) {
        this.logger.debug(`Skipping ${sourceField.name}: used in multi-field pattern`);
        continue;
      }

      // Find all suggestions for this source field
      const fieldSuggestions = suggestions.filter(s => s.sourceField === sourceField.name);

      // SKIP: Fields with viable suggestions - use suspiciousConfidenceThreshold as the cutoff
      // If a field has a suggestion above the suspicious threshold, it's considered mappable
      if (fieldSuggestions.length > 0) {
        const bestConfidence = Math.max(...fieldSuggestions.map(s => s.confidence));
        if (bestConfidence >= suspiciousConfidenceThreshold) {
          this.logger.debug(`Skipping ${sourceField.name}: has viable suggestion (${Math.round(bestConfidence)}% ≥ ${suspiciousConfidenceThreshold}% threshold)`);
          continue;
        }
      }

      if (fieldSuggestions.length === 0) {
        // No suggestions at all - highly suspicious
        const redFlags: RedFlag[] = [{
          type: RedFlagType.ALL_ALTERNATIVES_POOR,
          severity: 'high',
          description: 'No mapping suggestions generated by AI',
          evidence: { sourceField: sourceField.name }
        }];

        // Classify field using pattern matching
        const classification = this.classifyField(sourceField, 95);

        unmappableFields.push({
          sourceField,
          unmappableConfidence: 95,
          llmCategory: classification.category,
          llmCategoryConfidence: classification.confidence,
          llmReasoning: classification.reasoning,
          redFlags,
          customFieldRecommended: true
        });
        continue;
      }

      // Get best suggestion
      const bestSuggestion = fieldSuggestions[0]; // Assume sorted by confidence

      // Perform multi-factor analysis
      const redFlags = await this.analyzeField(
        sourceField,
        targetFields,
        fieldSuggestions,
        ragContextMap.get(sourceField.name),
        {
          suspiciousConfidenceThreshold,
          suspiciousSemanticThreshold
        }
      );

      // Check if field qualifies as unmappable
      if (redFlags.length >= redFlagThreshold && bestSuggestion.confidence < maxBestAttemptConfidence) {
        // Calculate unmappable confidence based on red flags
        const unmappableConfidence = this.calculateUnmappableConfidence(redFlags, bestSuggestion.confidence);

        // Classify field using pattern matching
        const classification = this.classifyField(sourceField, unmappableConfidence);

        unmappableFields.push({
          sourceField,
          unmappableConfidence,
          llmCategory: classification.category,
          llmCategoryConfidence: classification.confidence,
          llmReasoning: classification.reasoning,
          redFlags,
          bestAttempt: {
            targetField: bestSuggestion.targetField,
            confidence: bestSuggestion.confidence,
            reason: bestSuggestion.reasoning || 'AI suggested this as best match'
          },
          customFieldRecommended: unmappableConfidence >= 75
        });
      }
    }

    const duration = Date.now() - startTime;
    this.logger.info('Unmappable field detection complete', {
      unmappableCount: unmappableFields.length,
      totalSourceFields: sourceFields.length,
      unmappablePercentage: ((unmappableFields.length / sourceFields.length) * 100).toFixed(1),
      duration
    });

    return unmappableFields;
  }

  /**
   * Multi-factor analysis to detect red flags
   */
  private async analyzeField(
    sourceField: FieldMetadata,
    targetFields: FieldMetadata[],
    suggestions: AISuggestion[],
    ragContext: RAGContext | undefined,
    thresholds: { suspiciousConfidenceThreshold: number; suspiciousSemanticThreshold: number }
  ): Promise<RedFlag[]> {
    const redFlags: RedFlag[] = [];

    const bestSuggestion = suggestions[0];

    // Red Flag 1: Very Low Confidence
    if (bestSuggestion.confidence < thresholds.suspiciousConfidenceThreshold) {
      redFlags.push({
        type: RedFlagType.VERY_LOW_CONFIDENCE,
        severity: bestSuggestion.confidence < 30 ? 'high' : 'medium',
        description: `Best mapping confidence is ${bestSuggestion.confidence}%, below threshold of ${thresholds.suspiciousConfidenceThreshold}%`,
        evidence: {
          bestConfidence: bestSuggestion.confidence,
          threshold: thresholds.suspiciousConfidenceThreshold,
          targetField: bestSuggestion.targetField
        }
      });
    }

    // Red Flag 2: Low Semantic Similarity
    try {
      const semanticSimilarity = await this.calculateSemanticSimilarity(
        sourceField.name,
        bestSuggestion.targetField
      );

      if (semanticSimilarity < thresholds.suspiciousSemanticThreshold) {
        redFlags.push({
          type: RedFlagType.LOW_SEMANTIC_SIMILARITY,
          severity: semanticSimilarity < 0.2 ? 'high' : 'medium',
          description: `Semantic similarity is ${(semanticSimilarity * 100).toFixed(1)}%, below threshold of ${(thresholds.suspiciousSemanticThreshold * 100).toFixed(1)}%`,
          evidence: {
            sourceField: sourceField.name,
            targetField: bestSuggestion.targetField,
            semanticSimilarity,
            threshold: thresholds.suspiciousSemanticThreshold
          }
        });
      }
    } catch (error) {
      this.logger.warn('Failed to calculate semantic similarity', { error, sourceField: sourceField.name });
    }

    // Red Flag 3: No Type Compatibility
    const hasCompatibleType = targetFields.some(tf =>
      this.areTypesCompatible(sourceField.type, tf.type)
    );

    if (!hasCompatibleType) {
      redFlags.push({
        type: RedFlagType.NO_TYPE_COMPATIBILITY,
        severity: 'high',
        description: `No target field has compatible type with source type "${sourceField.type}"`,
        evidence: {
          sourceType: sourceField.type,
          targetTypes: targetFields.map(tf => tf.type),
          compatibilityChecked: true
        }
      });
    }

    // Red Flag 4: No Historical Match
    if (!ragContext || ragContext.similarMappings.length === 0 || ragContext.similarMappings[0].similarity < 0.3) {
      redFlags.push({
        type: RedFlagType.NO_HISTORICAL_MATCH,
        severity: 'medium',
        description: 'No similar historical mappings found in knowledge base',
        evidence: {
          ragAvailable: !!ragContext,
          similarMappings: ragContext?.similarMappings.length ?? 0,
          topSimilarity: ragContext?.similarMappings[0]?.similarity ?? 0
        }
      });
    }

    // Red Flag 5: All Alternatives Poor
    const allAlternativesPoor = suggestions.every(s => s.confidence < 60);

    if (allAlternativesPoor) {
      redFlags.push({
        type: RedFlagType.ALL_ALTERNATIVES_POOR,
        severity: 'high',
        description: `All ${suggestions.length} mapping alternatives have confidence < 60%`,
        evidence: {
          alternativeCount: suggestions.length,
          confidences: suggestions.map(s => s.confidence),
          averageConfidence: suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length
        }
      });
    }

    return redFlags;
  }

  /**
   * Classify unmappable field using pattern matching
   * Returns category, confidence, and reasoning
   */
  private classifyField(
    field: FieldMetadata,
    unmappableConfidence: number
  ): { category: UnmappableField['llmCategory']; confidence: number; reasoning: string[] } {
    const fieldName = field.name.toLowerCase();
    const reasoning: string[] = [];

    // Pattern dictionaries (refined for better accuracy)
    const GARBAGE_PATTERNS = [
      // Only truly useless fields - be conservative!
      /^temp_/, /^tmp_/, /^test_/, /^debug_/, /^dummy_/,
      /^deprecated_/, /^unused_/, /^obsolete_/,
      /^_test/, /^_tmp/, /^_debug/,
      /_guid$/, /_uuid$/, /_hash$/, /_checksum$/  // Auto-generated IDs
    ];

    const SYSTEM_PATTERNS = [
      // Audit trail and system tracking
      /created_by/, /modified_by/, /updated_by/, /deleted_by/,
      /created_at/, /modified_at/, /updated_at/, /deleted_at/,
      /created_date/, /modified_date/, /updated_date/,
      /^version$/, /_version$/, /record_status/, /is_deleted/, /is_active/,
      /last_sync/, /sync_timestamp/, /etag/, /row_version/
    ];

    const TECHNICAL_PATTERNS = [
      // Integration and technical fields
      /^api_/, /_api$/, /webhook/, /callback/, /endpoint/,
      /^sync_/, /_sync$/, /integration_/, /external_id/, /ext_ref/,
      /reference_id/, /correlation_id/, /transaction_id/,
      /^system_/, /source_system/  // System identifiers (may be important for migration)
    ];

    const BUSINESS_PATTERNS = [
      // Core customer/contact fields
      /name/, /first/, /last/, /full_?name/, /contact/,
      /email/, /e_?mail/, /mail/, /phone/, /ph[o#]?ne/, /mobile/, /fax/,
      /address/, /addr/, /street/, /city/, /state/, /zip/, /postal/, /country/, /cntry/,

      // Company/organization fields
      /company/, /cmpny/, /organization/, /business/,
      /employee/, /staff/, /headcount/, /cnt/,
      /revenue/, /rev[_$]/, /sales/, /income/,
      /industry/, /sector/, /type/, /category/,

      // Standard business domain
      /customer_/, /client_/, /account_/,
      /product_/, /item_/, /sku_/,
      /order_/, /invoice_/, /payment_/,
      /discount/, /loyalty/, /preference/, /custom_/,
      /price/, /amount/, /quantity/, /total/,

      // Migration and legacy fields (often critical!)
      /legacy_/, /old_/, /internal_/, /source/,

      // Descriptive fields
      /note/, /comment/, /description/, /remark/,
      /score/, /rating/, /flag/, /status/, /active/,
      /code/, /title/, /label/, /region/, /territory/,
      /website/, /web/, /url/, /site/, /dept/, /department/
    ];

    // Check patterns in priority order

    // 1. Check for garbage patterns (highest priority)
    for (const pattern of GARBAGE_PATTERNS) {
      if (pattern.test(fieldName)) {
        reasoning.push(`Field name matches garbage pattern: ${pattern.source}`);
        reasoning.push('Likely system-generated or debug field with no business value');
        return { category: 'garbage', confidence: 90, reasoning };
      }
    }

    // 2. Check for system metadata patterns
    for (const pattern of SYSTEM_PATTERNS) {
      if (pattern.test(fieldName)) {
        reasoning.push(`Field name matches system metadata pattern: ${pattern.source}`);
        reasoning.push('Appears to be audit trail or system tracking field');
        return { category: 'system_metadata', confidence: 85, reasoning };
      }
    }

    // 3. Check for technical patterns
    for (const pattern of TECHNICAL_PATTERNS) {
      if (pattern.test(fieldName)) {
        reasoning.push(`Field name matches technical pattern: ${pattern.source}`);
        reasoning.push('Appears to be integration or technical configuration field');
        return { category: 'technical_field', confidence: 80, reasoning };
      }
    }

    // 4. Check for business patterns
    for (const pattern of BUSINESS_PATTERNS) {
      if (pattern.test(fieldName)) {
        reasoning.push(`Field name matches business domain pattern: ${pattern.source}`);
        reasoning.push('Appears to contain business-meaningful data');
        return { category: UnmappableFieldDetectionService.DEFAULT_CLASSIFICATION, confidence: 75, reasoning };
      }
    }

    // 5. No clear pattern match - default to business field for review
    // IMPORTANT: High unmappable confidence means "needs custom field", NOT "is garbage"!
    // If we can't map it, it's likely a business-specific field that needs to be created.
    reasoning.push('No clear pattern match found');
    if (unmappableConfidence >= 80) {
      reasoning.push('High unmappable confidence - likely business-specific field requiring custom field creation');
      return { category: UnmappableFieldDetectionService.DEFAULT_CLASSIFICATION, confidence: 65, reasoning };
    } else {
      reasoning.push('Medium unmappable confidence - review to determine if custom field needed');
      return { category: UnmappableFieldDetectionService.DEFAULT_CLASSIFICATION, confidence: 55, reasoning };
    }
  }

  /**
   * Calculate semantic similarity between two field names
   */
  private async calculateSemanticSimilarity(field1: string, field2: string): Promise<number> {
    // Calculate semantic similarity using normalized Levenshtein distance
    // The semantic validator uses string similarity, embeddings would be more accurate
    return this.calculateStringSimilarity(field1.toLowerCase(), field2.toLowerCase());
  }

  /**
   * Simple string similarity using Levenshtein distance
   */
  private calculateStringSimilarity(str1: string, str2: string): number {
    const distance = this.levenshteinDistance(str1, str2);
    const maxLength = Math.max(str1.length, str2.length);
    return maxLength === 0 ? 1.0 : 1.0 - (distance / maxLength);
  }

  /**
   * Levenshtein distance algorithm
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

  /**
   * Check if two types are compatible for mapping
   */
  private areTypesCompatible(sourceType: string, targetType: string): boolean {
    // Normalize types
    const source = sourceType.toLowerCase();
    const target = targetType.toLowerCase();

    // Exact match
    if (source === target) return true;

    // Compatible type groups
    const typeGroups: Record<string, string[]> = {
      string: ['string', 'text', 'varchar', 'char', 'nvarchar', 'nchar'],
      number: ['number', 'int', 'integer', 'bigint', 'smallint', 'float', 'double', 'decimal', 'numeric'],
      date: ['date', 'datetime', 'timestamp', 'time'],
      boolean: ['boolean', 'bool', 'bit'],
      email: ['email', 'string', 'text'],
      currency: ['currency', 'money', 'decimal', 'number']
    };

    // Check if source and target are in the same type group
    for (const [group, types] of Object.entries(typeGroups)) {
      if (types.includes(source) && types.includes(target)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Calculate unmappable confidence based on red flags and best attempt confidence
   */
  private calculateUnmappableConfidence(redFlags: RedFlag[], bestAttemptConfidence: number): number {
    // Base confidence from number of red flags
    let confidence = 0;

    // Each red flag contributes to unmappable confidence
    for (const flag of redFlags) {
      switch (flag.severity) {
        case 'high':
          confidence += 25;
          break;
        case 'medium':
          confidence += 15;
          break;
        case 'low':
          confidence += 5;
          break;
      }
    }

    // Adjust based on best attempt confidence (inverse relationship)
    const bestAttemptPenalty = bestAttemptConfidence / 2;
    confidence = confidence - bestAttemptPenalty;

    // Clamp to 0-100 range
    return Math.max(0, Math.min(100, confidence));
  }

  /**
   * Get summary statistics for unmappable field detection
   */
  getSummaryStatistics(unmappableFields: UnmappableField[]): {
    totalUnmappable: number;
    highConfidence: number; // >= 80%
    mediumConfidence: number; // 60-79%
    lowConfidence: number; // < 60%
    redFlagDistribution: Record<RedFlagType, number>;
    customFieldRecommendations: number;
  } {
    const stats = {
      totalUnmappable: unmappableFields.length,
      highConfidence: 0,
      mediumConfidence: 0,
      lowConfidence: 0,
      redFlagDistribution: {} as Record<RedFlagType, number>,
      customFieldRecommendations: 0
    };

    // Initialize red flag distribution
    for (const flagType of Object.values(RedFlagType)) {
      stats.redFlagDistribution[flagType as RedFlagType] = 0;
    }

    for (const field of unmappableFields) {
      // Confidence buckets
      if (field.unmappableConfidence >= 80) {
        stats.highConfidence++;
      } else if (field.unmappableConfidence >= 60) {
        stats.mediumConfidence++;
      } else {
        stats.lowConfidence++;
      }

      // Red flag distribution
      for (const flag of field.redFlags) {
        stats.redFlagDistribution[flag.type]++;
      }

      // Custom field recommendations
      if (field.customFieldRecommended) {
        stats.customFieldRecommendations++;
      }
    }

    return stats;
  }
}
