import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { FieldMapping, DataRecord, TransformationRule } from '../../types';
import type { FieldMappingAlternative } from './orchestrator/interfaces';
import type { TrainingDataRepository } from './TrainingDataRepository';
import { getRecordValues } from './utils/dataRecord';
import type { MDMFeedbackService, MappingQualityAdjustment } from '../mdm/MDMFeedbackService';

export interface SchemaDefinition {
  fields: FieldDefinition[];
  systemType: string;
  recordType?: string;
}

export interface FieldDefinition {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
  description?: string;
  required?: boolean;
  maxLength?: number;
  format?: string;
  customField?: boolean;
}

export interface NetSuiteSchema extends SchemaDefinition {
  recordType: 'customer' | 'vendor' | 'item' | 'salesorder' | 'invoice' | 'contact';
  customFields: NetSuiteCustomField[];
  relationships: NetSuiteRelationship[];
}

export interface NetSuiteCustomField {
  id: string;
  label: string;
  type: string;
  helpText?: string;
  recordType: string;
}

export interface NetSuiteRelationship {
  field: string;
  relatedRecord: string;
  type: 'lookup' | 'parent' | 'child';
}

export interface AIFieldMappingSuggestion {
  sourceField: string;
  targetField: string;
  confidence: number; // 0.0-1.0
  transformationType: 'direct' | 'calculation' | 'lookup' | 'concatenation';
  explanation: string;
  alternatives: FieldMappingAlternative[];
  businessRulesSuggested?: TransformationRule[];
  netsuiteSpecific?: NetSuiteMappingDetails;
  confidenceBreakdown?: ConfidenceBreakdownEntry[];
}

export type ConfidenceSignal = 'semantic' | 'pattern' | 'netsuite';

export interface ConfidenceBreakdownEntry {
  signal: ConfidenceSignal;
  rawScore: number;
  weight: number;
  adjustedScore: number;
  feedbackAdjustment: number;
}

export interface NetSuiteMappingDetails {
  customFieldId?: string;
  recordTypeSpecific?: boolean;
  requiresSubsidiary?: boolean;
  formulaField?: boolean;
  workflowDependent?: boolean;
}

export interface MappingQualityReport {
  overallScore: number;
  fieldMappings: FieldMappingQuality[];
  recommendations: string[];
  potentialIssues: MappingIssue[];
}

export interface FieldMappingQuality {
  sourceField: string;
  targetField: string;
  qualityScore: number;
  issues: string[];
  suggestions: string[];
}

export interface MappingIssue {
  severity: 'low' | 'medium' | 'high';
  field: string;
  message: string;
  suggestion: string;
}

export interface TrainingExample {
  id: string;
  sourceSystem: string;
  targetSystem: string;
  sourceField: string;
  targetField: string;
  transformationType: string;
  successRate: number;
  userFeedback: 'positive' | 'negative' | 'neutral';
  context: Record<string, unknown>;
  createdAt: Date;
}

/**
 * AI-powered field mapping service that provides intelligent suggestions
 * for mapping fields between different business systems, with specialized
 * support for NetSuite ERP integrations.
 * 
 * Now enhanced with MDM conflict feedback to adjust confidence based on
 * real-world data quality issues.
 */
@injectable()
export class AIFieldMappingService {
  private logger: Logger;
  private trainingRepository: TrainingDataRepository;
  private mdmFeedbackService?: MDMFeedbackService;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.TrainingDataRepository) trainingRepository: TrainingDataRepository,
    @inject(TYPES.MDMFeedbackService) @optional() mdmFeedbackService?: MDMFeedbackService,
  ) {
    this.logger = logger;
    this.trainingRepository = trainingRepository;
    this.mdmFeedbackService = mdmFeedbackService;

    if (mdmFeedbackService) {
      this.logger.info('[AIFieldMapping] MDM Feedback integration enabled');
    }
  }

  /**
   * Suggest field mappings using AI analysis
   */
  async suggestFieldMappings(
    sourceSchema: SchemaDefinition,
    targetSchema: NetSuiteSchema,
    sampleData: DataRecord[],
    options?: { datasetId?: string },
  ): Promise<AIFieldMappingSuggestion[]> {
    this.logger.info('Generating AI field mapping suggestions', {
      sourceSystem: sourceSchema.systemType,
      targetSystem: 'NetSuite',
      sourceFields: sourceSchema.fields.length,
      targetFields: targetSchema.fields.length,
      sampleRecords: sampleData.length,
    });

    // DEBUG: Log actual field names
    this.logger.debug('🔍 DEBUG - Source fields:', { fields: sourceSchema.fields.map(f => f.name) });
    this.logger.debug('🔍 DEBUG - Target fields:', { fields: targetSchema.fields.map(f => f.name) });

    const suggestions: AIFieldMappingSuggestion[] = [];

    for (const sourceField of sourceSchema.fields) {
      this.logger.debug(`🔍 DEBUG - Analyzing source field: ${sourceField.name} (${sourceField.type})`);

      const sampleValues = getRecordValues(sampleData, sourceField.name);

      const suggestion = await this.analyzeFieldMapping(
        sourceField,
        targetSchema,
        sampleData,
        sourceSchema.systemType,
        sampleValues,
        options?.datasetId,
      );

      if (suggestion) {
        this.logger.debug(`✅ DEBUG - Generated suggestion: ${suggestion.sourceField} → ${suggestion.targetField} (${Math.round(suggestion.confidence * 100)}%)`);
        suggestions.push(suggestion);
      } else {
        this.logger.debug(`❌ DEBUG - No suggestion generated for: ${sourceField.name}`);
      }
    }

    // Sort by confidence score
    suggestions.sort((a, b) => b.confidence - a.confidence);

    // Apply MDM conflict-based adjustments if feedback service available
    const adjustedSuggestions = await this.applyMDMFeedbackAdjustments(
      suggestions,
      sourceSchema.systemType
    );

    this.logger.info('Generated AI field mapping suggestions', {
      totalSuggestions: adjustedSuggestions.length,
      highConfidence: adjustedSuggestions.filter(s => s.confidence > 0.8).length,
      mediumConfidence: adjustedSuggestions.filter(s => s.confidence > 0.5 && s.confidence <= 0.8).length,
      mdmAdjustmentsApplied: !!this.mdmFeedbackService,
    });

    return adjustedSuggestions;
  }

  /**
   * Apply confidence adjustments based on MDM conflict history
   * Fields that frequently cause conflicts get lower confidence scores
   */
  private async applyMDMFeedbackAdjustments(
    suggestions: AIFieldMappingSuggestion[],
    sourceSystem: string
  ): Promise<AIFieldMappingSuggestion[]> {
    if (!this.mdmFeedbackService) {
      return suggestions;
    }

    try {
      const adjustments = await this.mdmFeedbackService.getMappingQualityAdjustments(sourceSystem);

      if (adjustments.length === 0) {
        return suggestions;
      }

      // Create adjustment lookup map
      const adjustmentMap = new Map<string, MappingQualityAdjustment>();
      for (const adj of adjustments) {
        adjustmentMap.set(adj.fieldName.toLowerCase(), adj);
      }

      // Apply adjustments to matching suggestions
      const adjustedSuggestions = suggestions.map(suggestion => {
        const fieldKey = suggestion.sourceField.toLowerCase();
        const adjustment = adjustmentMap.get(fieldKey);

        if (adjustment) {
          const originalConfidence = suggestion.confidence;
          const newConfidence = Math.max(0.1, originalConfidence * adjustment.confidenceAdjustment);

          this.logger.debug('[AIFieldMapping] Applied MDM feedback adjustment', {
            field: suggestion.sourceField,
            originalConfidence: Math.round(originalConfidence * 100),
            adjustedConfidence: Math.round(newConfidence * 100),
            reason: adjustment.reason
          });

          return {
            ...suggestion,
            confidence: newConfidence,
            explanation: `${suggestion.explanation}. Note: ${adjustment.reason}`
          };
        }

        return suggestion;
      });

      // Re-sort after adjustments
      adjustedSuggestions.sort((a, b) => b.confidence - a.confidence);

      this.logger.info('[AIFieldMapping] MDM feedback adjustments applied', {
        totalAdjustments: adjustments.length,
        fieldsAffected: adjustments.map(a => a.fieldName)
      });

      return adjustedSuggestions;
    } catch (error) {
      this.logger.warn('[AIFieldMapping] Failed to apply MDM feedback adjustments', {
        error: (error as Error).message
      });
      return suggestions;
    }
  }

  /**
   * Validate the quality of existing field mappings
   */
  async validateMappingQuality(
    mappings: FieldMapping[],
    sourceSchema: SchemaDefinition,
    targetSchema: NetSuiteSchema,
  ): Promise<MappingQualityReport> {
    this.logger.info('Validating field mapping quality', {
      mappingCount: mappings.length,
    });

    const fieldMappings: FieldMappingQuality[] = [];
    const recommendations: string[] = [];
    const potentialIssues: MappingIssue[] = [];

    for (const mapping of mappings) {
      const quality = await this.evaluateMappingQuality(
        mapping,
        sourceSchema,
        targetSchema,
      );

      fieldMappings.push(quality);

      if (quality.qualityScore < 0.7) {
        potentialIssues.push({
          severity: quality.qualityScore < 0.4 ? 'high' : 'medium',
          field: mapping.sourceField,
          message: `Low confidence mapping for ${mapping.sourceField} -> ${mapping.targetField}`,
          suggestion: quality.suggestions[0] || 'Review mapping configuration',
        });
      }
    }

    const overallScore = fieldMappings.reduce((sum, fm) => sum + fm.qualityScore, 0) / fieldMappings.length;

    // Generate recommendations
    if (overallScore < 0.8) {
      recommendations.push('Consider using AI suggestions to improve mapping accuracy');
    }

    if (potentialIssues.filter(i => i.severity === 'high').length > 0) {
      recommendations.push('Address high-severity mapping issues before deployment');
    }

    return {
      overallScore,
      fieldMappings,
      recommendations,
      potentialIssues,
    };
  }

  /**
   * Learn from user feedback to improve suggestions
   */
  async recordUserFeedback(
    suggestion: AIFieldMappingSuggestion,
    accepted: boolean,
    alternativeUsed?: string,
    options?: { datasetId?: string },
  ): Promise<void> {
    this.logger.info('Recording user feedback for AI learning', {
      sourceField: suggestion.sourceField,
      targetField: suggestion.targetField,
      confidence: suggestion.confidence,
      accepted,
      alternativeUsed,
    });

    // Store training example for future learning
    const trainingExample: TrainingExample = {
      id: `feedback_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
      sourceSystem: 'unknown', // Would be passed in real implementation
      targetSystem: 'NetSuite',
      sourceField: suggestion.sourceField,
      targetField: alternativeUsed || suggestion.targetField,
      transformationType: suggestion.transformationType,
      successRate: accepted ? 1.0 : 0.0,
      userFeedback: accepted ? 'positive' : 'negative',
      context: {
        originalSuggestion: suggestion,
        alternativeUsed,
        confidence: suggestion.confidence,
        signals: suggestion.confidenceBreakdown?.map(entry => entry.signal) ?? [],
      },
      createdAt: new Date(),
    };

    // In real implementation, this would be stored in a training database
    this.logger.debug('Training example created', { trainingExample });
    await this.trainingRepository.storeTrainingExample(trainingExample, options?.datasetId || 'default');
  }

  /**
   * Calculate learned base weights from training feedback
   * Applies signal effectiveness multipliers to baseline weights
   */
  private async getLearnedWeights(
    patternMatchesExist: boolean,
    adjustments: Partial<Record<ConfidenceSignal, number>>
  ): Promise<Record<ConfidenceSignal, number>> {
    // Baseline weights (starting point before learning)
    const baseline: Record<ConfidenceSignal, number> = {
      semantic: 0.5,
      pattern: patternMatchesExist ? 0.35 : 0.2,
      netsuite: 0.4,
    };

    // Apply learned adjustments from training feedback
    const learned: Record<ConfidenceSignal, number> = {} as Record<ConfidenceSignal, number>;

    for (const signal of Object.keys(baseline) as ConfidenceSignal[]) {
      const adjustment = adjustments[signal] ?? 1.0;
      learned[signal] = baseline[signal] * adjustment;
    }

    this.logger.debug('Calculated learned weights', { baseline, adjustments, learned });
    return learned;
  }

  private buildConfidenceBreakdown(
    signals: Partial<Record<ConfidenceSignal, number[]>>,
    baseWeights: Record<ConfidenceSignal, number>,
    adjustments: Partial<Record<ConfidenceSignal, number>>,
  ): ConfidenceBreakdownEntry[] {
    const breakdown: ConfidenceBreakdownEntry[] = [];
    let totalWeight = 0;

    (Object.keys(signals) as ConfidenceSignal[]).forEach(signal => {
      const values = signals[signal];
      if (!values || values.length === 0) {
        return;
      }

      const averageScore = values.reduce((sum, value) => sum + value, 0) / values.length;
      const feedbackAdjustment = adjustments[signal] ?? 1;
      const weight = baseWeights[signal] * feedbackAdjustment;
      totalWeight += weight;
      breakdown.push({
        signal,
        rawScore: Math.min(averageScore, 1),
        weight,
        adjustedScore: 0,
        feedbackAdjustment,
      });
    });

    if (breakdown.length === 0) {
      return breakdown;
    }

    if (totalWeight === 0) {
      totalWeight = breakdown.length;
      breakdown.forEach(entry => { entry.weight = 1; });
    }

    breakdown.forEach(entry => {
      entry.adjustedScore = Math.min(1, (entry.rawScore * entry.weight) / totalWeight);
    });

    return breakdown;
  }

  private calculateDynamicThreshold(
    breakdown: ConfidenceBreakdownEntry[],
    averageConfidence: number,
  ): number {
    // Signal diversity boost - multiple signals are more reliable
    const signalDiversityBoost = breakdown.length > 1 ? 0.05 : 0;

    // Signal strength - high raw scores across signals indicate confidence
    const signalStrength = breakdown.reduce((sum, entry) => sum + entry.rawScore, 0) / (breakdown.length || 1);

    // Feedback quality - consider how well-calibrated signals are based on training
    const feedbackQuality = breakdown.reduce((sum, entry) => sum + entry.feedbackAdjustment, 0) / (breakdown.length || 1);
    const feedbackBoost = feedbackQuality > 1.1 ? 0.05 : feedbackQuality < 0.9 ? -0.05 : 0;

    // Adaptive baseline based on historical performance
    const baseline = Math.max(0.20, Math.min(0.55, averageConfidence - 0.05));

    // Adjust threshold based on all factors
    const adjusted = baseline - signalDiversityBoost - (signalStrength > 0.8 ? 0.05 : 0) - feedbackBoost;

    // Minimum threshold of 0.3 to maintain quality while allowing feedback-driven learning
    return Math.max(0.3, adjusted);
  }

  /**
   * Analyze a single field mapping using multiple AI techniques
   */
  private async analyzeFieldMapping(
    sourceField: FieldDefinition,
    targetSchema: NetSuiteSchema,
    sampleData: DataRecord[],
    sourceSystemType: string,
    sampleValues: unknown[],
    datasetId?: string,
  ): Promise<AIFieldMappingSuggestion | null> {
    // Semantic analysis
    const semanticMatches = await this.findSemanticMatches(sourceField, targetSchema);

    // Pattern analysis on sample data
    const patternMatches = await this.analyzeDataPatterns(sourceField, sampleData, targetSchema, sampleValues);

    // NetSuite-specific intelligence
    const netsuiteMatches = await this.applyNetSuiteIntelligence(sourceField, targetSchema, sourceSystemType);

    // Combine all approaches
    const combinedMatch = await this.combineAnalysisResults(
      semanticMatches,
      patternMatches,
      netsuiteMatches,
      sourceField,
      sampleValues,
      datasetId,
    );

    return combinedMatch;
  }

  /**
   * Find semantic matches using NLP techniques
   */
  private async findSemanticMatches(
    sourceField: FieldDefinition,
    targetSchema: NetSuiteSchema,
  ): Promise<{ field: string; score: number; explanation: string }[]> {
    const matches: { field: string; score: number; explanation: string }[] = [];

    for (const targetField of targetSchema.fields) {
      const score = this.calculateSemanticSimilarity(sourceField, targetField);

      if (score > 0.3) {
        matches.push({
          field: targetField.name,
          score,
          explanation: 'Semantic similarity based on field name and type matching',
        });
      }
    }

    // Check custom fields
    for (const customField of targetSchema.customFields) {
      const score = this.calculateCustomFieldSimilarity(sourceField, customField);

      if (score > 0.3) {
        matches.push({
          field: customField.id,
          score,
          explanation: `Custom field match based on label: "${customField.label}"`,
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Analyze data patterns in sample data
   */
  private async analyzeDataPatterns(
    sourceField: FieldDefinition,
    sampleData: DataRecord[],
    targetSchema: NetSuiteSchema,
    cachedSampleValues?: unknown[],
  ): Promise<{ field: string; score: number; explanation: string }[]> {
    const matches: { field: string; score: number; explanation: string }[] = [];

    // Extract sample values for the source field
    const sampleValues = (cachedSampleValues && cachedSampleValues.length > 0)
      ? cachedSampleValues.slice(0, 100)
      : getRecordValues(sampleData, sourceField.name).slice(0, 100);

    if (sampleValues.length === 0) {
      return matches;
    }

    // Analyze data patterns
    const patterns = this.identifyDataPatterns(sampleValues);

    // Match patterns to NetSuite standard fields
    for (const targetField of targetSchema.fields) {
      const score = this.matchPatternsToField(patterns, targetField);

      if (score > 0.4) {
        matches.push({
          field: targetField.name,
          score,
          explanation: 'Data pattern analysis suggests compatibility',
        });
      }
    }

    // Match patterns to NetSuite custom fields
    for (const customField of targetSchema.customFields) {
      // Create a pseudo FieldDefinition for pattern matching
      // Type assertion: map custom field types to valid FieldDefinition types
      const validTypes = ['string', 'number', 'boolean', 'date', 'email', 'phone', 'currency', 'object'] as const;
      const fieldType = validTypes.includes(customField.type as any)
        ? (customField.type as FieldDefinition['type'])
        : 'string';

      const pseudoField: FieldDefinition = {
        name: customField.id,
        type: fieldType,
      };
      const score = this.matchPatternsToField(patterns, pseudoField);

      if (score > 0.4) {
        matches.push({
          field: customField.id,
          score,
          explanation: 'Data pattern analysis suggests compatibility with custom field',
        });
      }
    }

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply NetSuite-specific intelligence
   */
  private async applyNetSuiteIntelligence(
    sourceField: FieldDefinition,
    targetSchema: NetSuiteSchema,
    sourceSystemType: string,
  ): Promise<{ field: string; score: number; explanation: string }[]> {
    const matches: { field: string; score: number; explanation: string }[] = [];

    // NetSuite standard field mappings based on common patterns
    const netsuiteStandardMappings = this.getNetSuiteStandardMappings(sourceSystemType, targetSchema.recordType);

    const standardMatch = netsuiteStandardMappings[sourceField.name.toLowerCase()];
    if (standardMatch) {
      matches.push({
        field: standardMatch.targetField,
        score: standardMatch.confidence,
        explanation: `NetSuite standard mapping for ${sourceSystemType} integrations`,
      });
    }

    // Industry-specific patterns
    const industryMatches = this.applyIndustryPatterns(sourceField, targetSchema);
    matches.push(...industryMatches);

    return matches.sort((a, b) => b.score - a.score);
  }

  /**
   * Calculate semantic similarity between fields
   */
  private calculateSemanticSimilarity(sourceField: FieldDefinition, targetField: FieldDefinition): number {
    let score = 0;

    // Normalize field names for comparison
    const sourceName = sourceField.name.toLowerCase().replace(/[_\s-]/g, '');
    const targetName = targetField.name.toLowerCase().replace(/[_\s-]/g, '');
    const sourceOriginal = sourceField.name.toLowerCase();
    const targetOriginal = targetField.name.toLowerCase();

    // Exact name match
    if (sourceName === targetName) {
      score += 0.9;
    }

    // Partial name match (normalized)
    if (sourceName.includes(targetName) || targetName.includes(sourceName)) {
      score += 0.7;
    }

    // Common field name abbreviations
    const abbreviations: Record<string, string[]> = {
      'addr': ['address'],
      'st': ['state', 'street'],
      'cty': ['city'],
      'zip': ['zipcode', 'postalcode'],
      'num': ['number'],
      'amt': ['amount'],
      'qty': ['quantity'],
      'desc': ['description'],
      'nm': ['name'],
      'dt': ['date'],
      'phn': ['phone'],
      'em': ['email']
    };

    // Check abbreviation matches
    for (const [abbr, fullForms] of Object.entries(abbreviations)) {
      if (sourceName.includes(abbr)) {
        for (const full of fullForms) {
          if (targetName.includes(full)) {
            score += 0.6;
            break;
          }
        }
      }
      if (targetName.includes(abbr)) {
        for (const full of fullForms) {
          if (sourceName.includes(full)) {
            score += 0.6;
            break;
          }
        }
      }
    }

    // Type compatibility
    if (this.areTypesCompatible(sourceField.type, targetField.type)) {
      score += 0.4; // Increased weight for type compatibility
    }

    // Common synonyms and aliases
    const synonymScore = this.checkSynonyms(sourceOriginal, targetOriginal);
    score += synonymScore * 0.5;

    return Math.min(score, 1.0);
  }

  /**
   * Calculate similarity for custom fields
   */
  private calculateCustomFieldSimilarity(sourceField: FieldDefinition, customField: NetSuiteCustomField): number {
    let score = 0;

    const sourceName = sourceField.name.toLowerCase();
    const customLabel = customField.label.toLowerCase();

    // Label similarity
    if (sourceName === customLabel) {
      score += 0.8;
    } else if (sourceName.includes(customLabel) || customLabel.includes(sourceName)) {
      score += 0.6;
    }

    // Help text analysis
    if (customField.helpText) {
      const helpText = customField.helpText.toLowerCase();
      if (helpText.includes(sourceName)) {
        score += 0.3;
      }
    }

    return Math.min(score, 1.0);
  }

  /**
   * Identify patterns in data values
   */
  private identifyDataPatterns(values: unknown[]): { type: string; confidence: number; examples: unknown[]; details?: Record<string, unknown> } {
    // Email pattern
    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const emailCount = values.filter(v => typeof v === 'string' && emailPattern.test(v)).length;

    // Phone pattern
    const phonePattern = /^[\+]?[1-9][\d]{0,15}$/;
    const phoneCount = values.filter(v => typeof v === 'string' && phonePattern.test(v.replace(/[\s\-\(\)]/g, ''))).length;

    // Currency pattern
    const currencyPattern = /^\$?[\d,]+\.?\d{0,2}$/;
    const currencyCount = values.filter(v => typeof v === 'string' && currencyPattern.test(v)).length;

    // Date pattern - more strict detection
    const dateCount = values.filter(v => {
      if (typeof v !== 'string' && !(v instanceof Date)) return false;
      const date = new Date(v as any);
      if (isNaN(date.getTime())) return false;

      // Additional check: must contain common date separators or be ISO format
      const str = v.toString();
      const hasDateSeparators = str.includes('-') || str.includes('/') || str.includes(':');
      const looksLikeDate = /\d{2,4}[-/]\d{1,2}[-/]\d{1,4}|^\d{4}-\d{2}-\d{2}T/.test(str);

      return hasDateSeparators && (looksLikeDate || str.length >= 10);
    }).length;

    // Numeric range pattern
    const numericValues = values
      .map(value => {
        if (typeof value === 'number') return value;
        if (typeof value === 'string' && value.trim() !== '') {
          // First check if it looks like a number (not an ID like "L-100")
          // Must start with a digit or negative sign followed by digit
          if (!/^-?\d/.test(value.trim())) return null;

          const cleaned = value.replace(/[^\d.-]/g, '');
          // Only parse if there are actual digits (not empty string)
          if (cleaned.length === 0 || cleaned === '-') return null;

          // Reject if there are multiple hyphens (like "L-100" becomes "-100")
          const hyphenCount = (value.match(/-/g) || []).length;
          if (hyphenCount > 1) return null;

          const numeric = Number(cleaned);
          return Number.isFinite(numeric) ? numeric : null;
        }
        return null;
      })
      .filter((value): value is number => value !== null);

    const numericCount = numericValues.length;

    // Boolean pattern
    const booleanValues = values.filter(value => {
      if (typeof value === 'boolean') return true;
      if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        return ['true', 'false', 'yes', 'no', 'y', 'n', 'enabled', 'disabled'].includes(normalized);
      }
      return false;
    });

    // Industry codes (NAICS/SIC) or SKU-like identifiers
    const industryCodePattern = /^(naics|sic)?\d{2,6}$/i;
    const skuPattern = /^[A-Z0-9\-]{4,}$/;
    const industryCodeCount = values.filter(value => typeof value === 'string' && (industryCodePattern.test(value) || skuPattern.test(value))).length;

    const totalValues = values.length;

    // Return the most confident pattern
    if (emailCount / totalValues > 0.8) {
      return { type: 'email', confidence: emailCount / totalValues, examples: values.slice(0, 3) };
    } else if (phoneCount / totalValues > 0.7) {
      return { type: 'phone', confidence: phoneCount / totalValues, examples: values.slice(0, 3) };
    } else if (currencyCount / totalValues > 0.7) {
      return { type: 'currency', confidence: currencyCount / totalValues, examples: values.slice(0, 3) };
    } else if (dateCount / totalValues > 0.7) {
      return { type: 'date', confidence: dateCount / totalValues, examples: values.slice(0, 3) };
    } else if (numericCount / totalValues > 0.75) {
      const min = Math.min(...numericValues);
      const max = Math.max(...numericValues);
      const mean = numericValues.reduce((sum, value) => sum + value, 0) / numericValues.length;
      const variance = numericValues.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / numericValues.length;
      return {
        type: 'number-range',
        confidence: numericCount / totalValues,
        examples: numericValues.slice(0, 3),
        details: { min, max, variance },
      };
    } else if (booleanValues.length / totalValues > 0.75) {
      return {
        type: 'boolean',
        confidence: booleanValues.length / totalValues,
        examples: booleanValues.slice(0, 3),
      };
    } else if (industryCodeCount / totalValues > 0.6) {
      return {
        type: 'industry-code',
        confidence: industryCodeCount / totalValues,
        examples: values.slice(0, 3),
      };
    }

    return { type: 'unknown', confidence: 0, examples: [] };
  }

  /**
   * Match data patterns to NetSuite fields
   */
  private matchPatternsToField(patterns: { type: string; confidence: number; details?: Record<string, unknown> }, targetField: FieldDefinition): number {
    if (patterns.confidence < 0.5) return 0;

    const fieldName = targetField.name.toLowerCase();

    switch (patterns.type) {
      case 'email':
        if (fieldName.includes('email') || fieldName.includes('mail')) {
          return patterns.confidence;
        }
        break;
      case 'phone':
        if (fieldName.includes('phone') || fieldName.includes('tel') || fieldName.includes('mobile')) {
          return patterns.confidence;
        }
        break;
      case 'currency':
        if (fieldName.includes('amount') || fieldName.includes('price') || fieldName.includes('cost') || fieldName.includes('revenue')) {
          return patterns.confidence;
        }
        break;
      case 'date':
        if (fieldName.includes('date') || fieldName.includes('time') || fieldName.includes('created') || fieldName.includes('modified')) {
          return patterns.confidence;
        }
        break;
      case 'number-range':
        if (fieldName.includes('amount') || fieldName.includes('total') || fieldName.includes('quantity') || fieldName.includes('score')) {
          return Math.min(1, patterns.confidence + 0.1);
        }
        break;
      case 'boolean':
        if (fieldName.includes('active') || fieldName.includes('enabled') || fieldName.includes('flag') || fieldName.includes('status')) {
          return Math.min(1, patterns.confidence + 0.1);
        }
        break;
      case 'industry-code':
        if (fieldName.includes('naics') || fieldName.includes('sic') || fieldName.includes('industry') ||
          fieldName.includes('sku') || fieldName.includes('code') || fieldName.includes('loyalty') ||
          (fieldName.includes('id') && !fieldName.includes('guid') && !fieldName.includes('uuid'))) {
          return Math.min(1, patterns.confidence + 0.1);
        }
        break;
    }

    return 0;
  }

  /**
   * Get NetSuite standard mappings for common systems
   */
  private getNetSuiteStandardMappings(sourceSystem: string, recordType: string): Record<string, { targetField: string; confidence: number }> {
    const mappings: Record<string, { targetField: string; confidence: number }> = {};

    // Common mappings for Customer records
    if (recordType === 'customer') {
      mappings['name'] = { targetField: 'companyname', confidence: 0.9 };
      mappings['company'] = { targetField: 'companyname', confidence: 0.9 };
      mappings['companyname'] = { targetField: 'companyname', confidence: 1.0 };
      mappings['email'] = { targetField: 'email', confidence: 0.9 };
      mappings['phone'] = { targetField: 'phone', confidence: 0.9 };
      mappings['address'] = { targetField: 'defaultaddress', confidence: 0.8 };
    }

    // Salesforce-specific mappings
    if (sourceSystem.toLowerCase() === 'salesforce') {
      if (recordType === 'customer') {
        mappings['accountname'] = { targetField: 'companyname', confidence: 0.9 };
        mappings['billingcity'] = { targetField: 'billcity', confidence: 0.9 };
        mappings['billingstate'] = { targetField: 'billstate', confidence: 0.9 };
        mappings['billingcountry'] = { targetField: 'billcountry', confidence: 0.9 };
        mappings['annualrevenue'] = { targetField: 'creditlimit', confidence: 0.6 };
      }
    }

    return mappings;
  }

  /**
   * Apply industry-specific patterns
   */
  private applyIndustryPatterns(sourceField: FieldDefinition, targetSchema: NetSuiteSchema): { field: string; score: number; explanation: string }[] {
    // This would contain industry-specific mapping logic
    // For now, returning empty array
    return [];
  }

  /**
   * Check if field types are compatible
   */
  private areTypesCompatible(sourceType: string, targetType: string): boolean {
    if (sourceType === targetType) return true;

    // Compatible type mappings
    const compatibleTypes: Record<string, string[]> = {
      'string': ['string', 'email', 'phone'],
      'number': ['number', 'currency'],
      'date': ['date', 'string'],
      'boolean': ['boolean', 'string'],
    };

    return compatibleTypes[sourceType]?.includes(targetType) || false;
  }

  /**
   * Check for common field name synonyms
   */
  private checkSynonyms(source: string, target: string): number {
    const synonymGroups = [
      ['name', 'title', 'label', 'company', 'companyname'],
      ['email', 'emailaddress', 'mail'],
      ['phone', 'telephone', 'mobile', 'cell'],
      ['address', 'location', 'addr'],
      ['created', 'createddate', 'datecreated'],
      ['modified', 'updated', 'lastmodified', 'datemodified'],
    ];

    for (const group of synonymGroups) {
      if (group.includes(source) && group.includes(target)) {
        return 0.8;
      }
    }

    return 0;
  }

  /**
   * Combine analysis results from different approaches
   */
  private async combineAnalysisResults(
    semanticMatches: { field: string; score: number; explanation: string }[],
    patternMatches: { field: string; score: number; explanation: string }[],
    netsuiteMatches: { field: string; score: number; explanation: string }[],
    sourceField: FieldDefinition,
    sampleValues: unknown[],
    datasetId?: string,
  ): Promise<AIFieldMappingSuggestion | null> {
    const allMatches = new Map<string, {
      explanations: string[];
      signals: Partial<Record<ConfidenceSignal, number[]>>;
    }>();

    const registerMatch = (
      field: string,
      explanation: string,
      signal: ConfidenceSignal,
      score: number,
    ) => {
      if (!allMatches.has(field)) {
        allMatches.set(field, { explanations: [], signals: {} });
      }
      const entry = allMatches.get(field)!;
      entry.explanations.push(explanation);
      entry.signals[signal] = entry.signals[signal]
        ? [...entry.signals[signal]!, score]
        : [score];
    };

    semanticMatches.forEach(match => registerMatch(match.field, match.explanation, 'semantic', match.score));
    patternMatches.forEach(match => registerMatch(match.field, match.explanation, 'pattern', match.score));
    netsuiteMatches.forEach(match => registerMatch(match.field, match.explanation, 'netsuite', match.score));

    if (allMatches.size === 0) {
      return null;
    }

    // Use learned signal effectiveness from training data when available,
    // defaulting to neutral adjustments on error or absence
    const signalAdjustments: Partial<Record<ConfidenceSignal, number>> =
      await this.trainingRepository.getSignalEffectiveness(datasetId).catch(() => ({}));
    const datasetStats = await this.trainingRepository.getDatasetStatistics(datasetId).catch((): null => null);

    // Use learned weights instead of hardcoded values
    const baseWeights = await this.getLearnedWeights(patternMatches.length > 0, signalAdjustments);

    let bestMatch: {
      field: string;
      confidence: number;
      breakdown: ConfidenceBreakdownEntry[];
      explanations: string[];
    } | null = null;

    for (const [field, data] of allMatches.entries()) {
      const breakdown = this.buildConfidenceBreakdown(data.signals, baseWeights, signalAdjustments);
      const combinedScore = breakdown.reduce((sum, entry) => sum + entry.adjustedScore, 0);

      if (!bestMatch || combinedScore > bestMatch.confidence) {
        bestMatch = {
          field,
          confidence: Math.min(combinedScore, 1),
          breakdown,
          explanations: data.explanations,
        };
      }
    }

    if (!bestMatch) {
      this.logger.debug(`❌ DEBUG - Filtered out ${sourceField.name}: no matches found`);
      return null;
    }

    const averageConfidence = datasetStats?.averageConfidence ?? 0.65;
    const dynamicThreshold = this.calculateDynamicThreshold(bestMatch.breakdown, averageConfidence);

    if (bestMatch.confidence < dynamicThreshold) {
      this.logger.debug(`❌ DEBUG - Filtered out ${sourceField.name}: confidence ${Math.round(bestMatch.confidence * 100)}% below threshold ${Math.round(dynamicThreshold * 100)}%`);
      return null;
    }

    this.logger.debug(`🎯 DEBUG - Best match for ${sourceField.name}: ${bestMatch.field} (${Math.round(bestMatch.confidence * 100)}%)`);

    const alternatives: FieldMappingAlternative[] = [];
    for (const [field, data] of allMatches.entries()) {
      const breakdown = this.buildConfidenceBreakdown(data.signals, baseWeights, signalAdjustments);
      const score = breakdown.reduce((sum, entry) => sum + entry.adjustedScore, 0);

      if (score > dynamicThreshold * 0.7) {
        alternatives.push({
          targetField: field,
          confidence: Math.min(score, 1.0),
          transformationType: this.determineTransformationType(sourceField, field, sampleValues),
          explanation: data.explanations[0] || 'Alternative mapping option',
        });
      }
    }

    alternatives.sort((a, b) => b.confidence - a.confidence);

    return {
      sourceField: sourceField.name,
      targetField: bestMatch.field,
      confidence: bestMatch.confidence,
      transformationType: this.determineTransformationType(sourceField, bestMatch.field, sampleValues),
      explanation: bestMatch.explanations.join('; '),
      alternatives: alternatives.slice(0, 3),
      businessRulesSuggested: [],
      netsuiteSpecific: {
        customFieldId: bestMatch.field.startsWith('custentity_') ? bestMatch.field : undefined,
        recordTypeSpecific: true,
        requiresSubsidiary: false,
        formulaField: false,
        workflowDependent: false,
      },
      confidenceBreakdown: bestMatch.breakdown,
    };
  }

  /**
   * Determine the appropriate transformation type
   * Enhanced with sample data analysis and type mismatch detection
   */
  private determineTransformationType(
    sourceField: FieldDefinition,
    targetField: string,
    sampleValues?: unknown[]
  ): 'direct' | 'calculation' | 'lookup' | 'concatenation' {
    const targetName = targetField.toLowerCase();
    const sourceName = sourceField.name.toLowerCase();

    // NEW: Analyze sample data patterns if available
    if (sampleValues && sampleValues.length > 0) {
      const pattern = this.identifyDataPatterns(sampleValues);

      // Range bucketing detection - numeric ranges mapped to categories
      if (pattern.type === 'number-range' &&
        (targetName.includes('category') || targetName.includes('tier') ||
          targetName.includes('level') || targetName.includes('class'))) {
        this.logger.debug('Detected range bucketing transformation', { sourceField: sourceField.name, targetField });
        return 'lookup';
      }

      // Format conversion detection - dates/currency needing formatting
      if (pattern.type === 'date' &&
        (targetName.includes('formatted') || targetName.includes('display') || targetName.includes('text'))) {
        this.logger.debug('Detected date format conversion', { sourceField: sourceField.name, targetField });
        return 'calculation';
      }

      if (pattern.type === 'currency' && !targetName.includes('amount|price|cost|value')) {
        this.logger.debug('Detected currency format conversion', { sourceField: sourceField.name, targetField });
        return 'calculation';
      }

      // Boolean keyword detection - yes/no/true/false → boolean
      if (pattern.type === 'boolean-text' && sourceField.type === 'string') {
        this.logger.debug('Detected boolean text to boolean conversion', { sourceField: sourceField.name, targetField });
        return 'calculation';
      }
    }

    // NEW: Type mismatch detection
    if (sourceField.type === 'number' &&
      (targetName.includes('text') || targetName.includes('description') || targetName.includes('name'))) {
      this.logger.debug('Detected number to text conversion', { sourceField: sourceField.name, targetField });
      return 'calculation';
    }

    if (sourceField.type === 'string' &&
      (targetName.includes('amount') || targetName.includes('quantity') || targetName.includes('count'))) {
      this.logger.debug('Detected text to number conversion', { sourceField: sourceField.name, targetField });
      return 'calculation';
    }

    // Existing logic (unchanged)
    if (targetName.includes('id') || targetName.endsWith('ref') || targetName.includes('internalid')) {
      return 'lookup';
    }

    if (['amount', 'total', 'balance', 'margin', 'revenue'].some(token => targetName.includes(token))) {
      return 'calculation';
    }

    if (sourceField.type === 'date' && !targetName.includes('date')) {
      return 'calculation';
    }

    if (sourceField.type === 'string' && /first|last|given|family/.test(sourceName) && targetName.includes('name')) {
      return 'concatenation';
    }

    if (sourceField.type === 'boolean' && !targetName.includes('flag')) {
      return 'calculation';
    }

    if (targetName.includes('status') || targetName.includes('type')) {
      return 'lookup';
    }

    return 'direct';
  }

  /**
   * Evaluate the quality of an existing mapping
   */
  private async evaluateMappingQuality(
    mapping: FieldMapping,
    sourceSchema: SchemaDefinition,
    targetSchema: NetSuiteSchema,
  ): Promise<FieldMappingQuality> {
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Find source and target field definitions
    const sourceField = sourceSchema.fields.find(f => f.name === mapping.sourceField);
    const targetField = targetSchema.fields.find(f => f.name === mapping.targetField);

    let qualityScore = 1.0;

    // Check if fields exist
    if (!sourceField) {
      issues.push(`Source field '${mapping.sourceField}' not found in schema`);
      qualityScore -= 0.5;
    }

    if (!targetField) {
      // Check if it's a custom field
      const customField = targetSchema.customFields.find(f => f.id === mapping.targetField);
      if (!customField) {
        issues.push(`Target field '${mapping.targetField}' not found in NetSuite schema`);
        qualityScore -= 0.5;
      }
    }

    // Type compatibility check
    if (sourceField && targetField) {
      if (!this.areTypesCompatible(sourceField.type, targetField.type)) {
        issues.push(`Type mismatch: ${sourceField.type} -> ${targetField.type}`);
        suggestions.push('Consider adding data transformation for type compatibility');
        qualityScore -= 0.3;
      }
    }

    // Required field validation
    if (targetField?.required && !mapping.isRequired) {
      issues.push('Target field is required but mapping is not marked as required');
      suggestions.push('Mark this mapping as required or provide default value');
      qualityScore -= 0.2;
    }

    // Transformation type validation
    if (mapping.transformationType === 'direct' && sourceField && targetField) {
      if (sourceField.type !== targetField.type) {
        suggestions.push('Consider using \'calculation\' transformation for type conversion');
        qualityScore -= 0.1;
      }
    }

    return {
      sourceField: mapping.sourceField,
      targetField: mapping.targetField,
      qualityScore: Math.max(qualityScore, 0),
      issues,
      suggestions,
    };
  }

  /**
   * Suggest transformations for a specific field pair
   */
  async suggestTransformations(
    sourceField: { name: string; type: string; description?: string },
    targetField: { name: string; type: string; description?: string },
    context?: unknown,
  ): Promise<{ type: string; logic: string; confidence: number; explanation: string }[]> {
    const suggestions: { type: string; logic: string; confidence: number; explanation: string }[] = [];
    const sourceType = sourceField.type.toLowerCase();
    const targetType = targetField.type.toLowerCase();
    const sourceName = sourceField.name.toLowerCase();
    const targetName = targetField.name.toLowerCase();

    // Date transformations
    if (sourceType.includes('date') && targetType.includes('date')) {
      suggestions.push({
        type: 'format',
        logic: 'format_date(${value}, "YYYY-MM-DD")',
        confidence: 0.95,
        explanation: 'Standard ISO date format conversion',
      });
    }

    // String to number conversions
    if (sourceType.includes('string') && (targetType.includes('number') || targetType.includes('integer'))) {
      suggestions.push({
        type: 'convert',
        logic: 'parseFloat(${value}) || 0',
        confidence: 0.90,
        explanation: 'Convert string to number with fallback to 0',
      });
    }

    // Direct copy if types match
    if (sourceType === targetType) {
      suggestions.push({
        type: 'direct',
        logic: '${value}',
        confidence: 1.0,
        explanation: 'Direct copy - types match perfectly',
      });
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions;
  }

  /**
   * Suggest validation patterns for a field
   */
  async suggestValidationPatterns(
    fieldName: string,
    fieldType: string,
    targetSystem?: string,
  ): Promise<{ regex: string; description: string; confidence: number }[]> {
    const patterns: { regex: string; description: string; confidence: number }[] = [];
    const normalizedName = fieldName.toLowerCase();

    // Email patterns
    if (normalizedName.includes('email')) {
      patterns.push({
        regex: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$',
        description: 'Standard email validation',
        confidence: 0.95,
      });
    }

    // Phone patterns
    if (normalizedName.includes('phone')) {
      patterns.push({
        regex: '^[+]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?[(]?[0-9]{1,4}[)]?[-\\s\\.]?[0-9]{1,9}$',
        description: 'International phone number format',
        confidence: 0.90,
      });
    }

    patterns.sort((a, b) => b.confidence - a.confidence);
    return patterns;
  }

  /**
   * Validate transformation logic syntax and semantics
   */
  async validateTransformationLogic(
    logic: string,
    sourceType?: string,
    targetType?: string,
    availableFields?: string[],
  ): Promise<{ valid: boolean; errors: string[]; warnings: string[]; suggestions: string[] }> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const suggestions: string[] = [];

    if (!logic || logic.trim().length === 0) {
      errors.push('Transformation logic cannot be empty');
      return { valid: false, errors, warnings, suggestions };
    }

    // Check for dangerous patterns
    const dangerousPatterns = [
      { pattern: /eval\s*\(/i, message: 'eval() is dangerous and not allowed' },
      { pattern: /require\s*\(/i, message: 'require() is not allowed' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(logic)) {
        errors.push(message);
      }
    }

    return { valid: errors.length === 0, errors, warnings, suggestions };
  }

  /**
   * Suggest default values for a field
   */
  async suggestDefaultValues(
    fieldName: string,
    fieldType: string,
    targetSystem?: string,
    context?: unknown,
  ): Promise<{ value: string; description: string; confidence: number }[]> {
    const suggestions: { value: string; description: string; confidence: number }[] = [];
    const normalizedName = fieldName.toLowerCase();
    const normalizedType = fieldType.toLowerCase();

    // Boolean fields
    if (normalizedType.includes('boolean')) {
      if (normalizedName.includes('active') || normalizedName.includes('enabled')) {
        suggestions.push({
          value: 'true',
          description: 'Default to active/enabled',
          confidence: 0.85,
        });
      } else {
        suggestions.push({
          value: 'false',
          description: 'Conservative default (false)',
          confidence: 0.75,
        });
      }
    }

    // Status fields
    if (normalizedName.includes('status')) {
      suggestions.push({
        value: '"Pending"',
        description: 'Initial pending status',
        confidence: 0.82,
      });
    }

    // Number fields
    if (normalizedType.includes('number')) {
      suggestions.push({
        value: '0',
        description: 'Zero',
        confidence: 0.85,
      });
    }

    suggestions.sort((a, b) => b.confidence - a.confidence);
    return suggestions;
  }
}
