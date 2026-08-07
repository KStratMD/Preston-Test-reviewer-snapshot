import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { TransformationContext, TransformationResult } from '../TransformationEngine';
import { TransformationEngine } from '../TransformationEngine';
import type { FieldMapping, DataRecord } from '../../types';
import type { AIFieldMappingService, AIFieldMappingSuggestion, SchemaDefinition, NetSuiteSchema, MappingQualityReport } from './AIFieldMappingService';
import type { SemanticAnalyzer } from './SemanticAnalyzer';
import type { NetSuiteSchemaIntelligence } from './NetSuiteSchemaIntelligence';
import type { PatternRecognizer, DataPattern } from './PatternRecognizer';
import type { TrainingDataRepository } from './TrainingDataRepository';

export interface AITransformationOptions {
  enableAutoMapping: boolean;
  confidenceThreshold: number;
  enablePatternRecognition: boolean;
  enableSemanticAnalysis: boolean;
  enableNetSuiteIntelligence: boolean;
  learningMode: boolean;
  autoAcceptHighConfidence: boolean;
  validateMappingQuality: boolean;
}

export interface AITransformationResult extends TransformationResult {
  aiSuggestions: AIFieldMappingSuggestion[];
  mappingQuality?: MappingQualityReport;
  autoMappingsApplied: number;
  confidence: number;
  learningInsights: string[];
}

export interface SmartMappingRequest {
  sourceData: DataRecord[];
  sourceSchema: SchemaDefinition;
  targetSchema: NetSuiteSchema;
  existingMappings?: FieldMapping[];
  options?: Partial<AITransformationOptions>;
}

export interface SmartMappingResponse {
  suggestedMappings: FieldMapping[];
  aiSuggestions: AIFieldMappingSuggestion[];
  qualityReport: MappingQualityReport;
  confidence: number;
  recommendations: string[];
}

/**
 * AI-Enhanced Transformation Engine that extends the base TransformationEngine
 * with intelligent field mapping capabilities using machine learning and semantic analysis.
 */
@injectable()
export class AIEnhancedTransformationEngine extends TransformationEngine {
  private aiFieldMappingService: AIFieldMappingService;
  private semanticAnalyzer: SemanticAnalyzer;
  private netsuiteIntelligence: NetSuiteSchemaIntelligence;
  private patternRecognizer: PatternRecognizer;
  private trainingRepository: TrainingDataRepository;

  private readonly defaultOptions: AITransformationOptions = {
    enableAutoMapping: true,
    confidenceThreshold: 0.8,
    enablePatternRecognition: true,
    enableSemanticAnalysis: true,
    enableNetSuiteIntelligence: true,
    learningMode: true,
    autoAcceptHighConfidence: false,
    validateMappingQuality: true,
  };

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.AIFieldMappingService) aiFieldMappingService: AIFieldMappingService,
    @inject(TYPES.SemanticAnalyzer) semanticAnalyzer: SemanticAnalyzer,
    @inject(TYPES.NetSuiteSchemaIntelligence) netsuiteIntelligence: NetSuiteSchemaIntelligence,
    @inject(TYPES.PatternRecognizer) patternRecognizer: PatternRecognizer,
    @inject(TYPES.TrainingDataRepository) trainingRepository: TrainingDataRepository,
  ) {
    super(logger);
    this.aiFieldMappingService = aiFieldMappingService;
    this.semanticAnalyzer = semanticAnalyzer;
    this.netsuiteIntelligence = netsuiteIntelligence;
    this.patternRecognizer = patternRecognizer;
    this.trainingRepository = trainingRepository;
  }

  /**
   * Generate smart field mappings using AI analysis
   */
  async generateSmartMappings(request: SmartMappingRequest): Promise<SmartMappingResponse> {
    this.logger.info('Generating smart field mappings', {
      sourceSystem: request.sourceSchema.systemType,
      targetSystem: 'NetSuite',
      sourceFields: request.sourceSchema.fields.length,
      targetFields: request.targetSchema.fields.length,
      sampleRecords: request.sourceData.length,
    });

    const options = { ...this.defaultOptions, ...request.options };

    // Get AI suggestions
    const aiSuggestions = await this.aiFieldMappingService.suggestFieldMappings(
      request.sourceSchema,
      request.targetSchema,
      request.sourceData,
    );

    // Convert AI suggestions to field mappings
    const suggestedMappings = this.convertSuggestionsToMappings(aiSuggestions, options);

    // Merge with existing mappings if provided
    const allMappings = request.existingMappings ?
      this.mergeMappings(request.existingMappings, suggestedMappings) :
      suggestedMappings;

    // Validate mapping quality
    const qualityReport = await this.aiFieldMappingService.validateMappingQuality(
      allMappings,
      request.sourceSchema,
      request.targetSchema,
    );

    // Calculate overall confidence
    const confidence = this.calculateOverallConfidence(aiSuggestions, qualityReport);

    // Generate recommendations
    const recommendations = this.generateRecommendations(aiSuggestions, qualityReport, options);

    this.logger.info('Smart mappings generated', {
      suggestedMappings: suggestedMappings.length,
      overallConfidence: confidence,
      qualityScore: qualityReport.overallScore,
    });

    return {
      suggestedMappings: allMappings,
      aiSuggestions,
      qualityReport,
      confidence,
      recommendations,
    };
  }

  /**
   * Transform records with AI enhancement
   */
  async transformWithAI(
    context: TransformationContext,
    options: Partial<AITransformationOptions> = {},
  ): Promise<AITransformationResult> {
    const aiOptions = { ...this.defaultOptions, ...options };

    this.logger.debug('Starting AI-enhanced transformation', {
      mappings: context.mappings.length,
      rules: context.rules.length,
      aiOptions,
    });

    // Start with base transformation
    const baseResult = await this.transform(context);

    let aiSuggestions: AIFieldMappingSuggestion[] = [];
    let mappingQuality: MappingQualityReport | undefined;
    let autoMappingsApplied = 0;
    const learningInsights: string[] = [];

    try {
      // Generate AI suggestions if auto-mapping is enabled
      if (aiOptions.enableAutoMapping) {
        // This would require schema information - simplified for demo
        aiSuggestions = await this.generateMissingSuggestions(context, aiOptions);

        // Auto-apply high-confidence suggestions
        if (aiOptions.autoAcceptHighConfidence) {
          const autoApplied = await this.autoApplyHighConfidenceMappings(
            context,
            aiSuggestions,
            aiOptions.confidenceThreshold,
          );
          autoMappingsApplied = autoApplied.count;

          if (autoApplied.count > 0) {
            // Re-transform with new mappings
            const updatedResult = await this.transform({
              ...context,
              mappings: [...context.mappings, ...autoApplied.mappings],
            });

            // Merge results
            Object.assign(baseResult.transformedData.fields, updatedResult.transformedData.fields);
            baseResult.warnings.push(...updatedResult.warnings);
          }
        }
      }

      // Validate mapping quality if enabled
      if (aiOptions.validateMappingQuality && context.mappings.length > 0) {
        // This would require schema information - creating a mock schema for demo
        const mockSourceSchema = this.createMockSchema(context);
        const mockTargetSchema = await this.createMockNetSuiteSchema();

        mappingQuality = await this.aiFieldMappingService.validateMappingQuality(
          context.mappings,
          mockSourceSchema,
          mockTargetSchema,
        );
      }

      // Generate learning insights
      if (aiOptions.learningMode) {
        const insights = await this.generateLearningInsights(context, baseResult);
        learningInsights.push(...insights);
      }

      // Calculate overall confidence
      const confidence = this.calculateTransformationConfidence(
        baseResult,
        aiSuggestions,
        mappingQuality,
      );

      return {
        ...baseResult,
        aiSuggestions,
        mappingQuality,
        autoMappingsApplied,
        confidence,
        learningInsights,
      };

    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error in AI-enhanced transformation', error);

      // Return base result with AI error information
      return {
        ...baseResult,
        aiSuggestions: [],
        autoMappingsApplied: 0,
        confidence: 0.5,
        learningInsights: [`AI enhancement failed: ${err.message}`],
      };
    }
  }

  /**
   * Analyze field patterns in source data
   */
  async analyzeFieldPatterns(
    sourceData: DataRecord[],
    fieldName: string,
  ): Promise<DataPattern> {
    const values = sourceData
      .map(record => (record.fields as Record<string, unknown> | undefined)?.[fieldName])
      .filter(value => value != null);

    return await this.patternRecognizer.analyzeDataPattern(fieldName, values);
  }

  /**
   * Get semantic field suggestions
   */
  async getSemanticSuggestions(
    sourceFieldName: string,
    sourceFieldDefinition: unknown,
    targetSchema: NetSuiteSchema,
  ): Promise<AIFieldMappingSuggestion[]> {
    const semanticMatches = await this.semanticAnalyzer.analyzeFieldSemantics(
      sourceFieldDefinition as any,
      targetSchema,
    );

    return semanticMatches.map(match => ({
      sourceField: sourceFieldName,
      targetField: match.field,
      confidence: match.score,
      transformationType: 'direct' as const,
      explanation: match.explanation,
      alternatives: [] as AIFieldMappingSuggestion['alternatives'],
      netsuiteSpecific: {
        customFieldId: match.field.startsWith('custentity_') ? match.field : undefined,
      },
    }));
  }

  /**
   * Record user feedback for learning
   */
  async recordMappingFeedback(
    suggestion: AIFieldMappingSuggestion,
    accepted: boolean,
    alternativeUsed?: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.aiFieldMappingService.recordUserFeedback(suggestion, accepted, alternativeUsed);

    this.logger.info('Mapping feedback recorded', {
      sourceField: suggestion.sourceField,
      targetField: suggestion.targetField,
      accepted,
      alternativeUsed,
    });
  }

  /**
   * Convert AI suggestions to field mappings
   */
  private convertSuggestionsToMappings(
    suggestions: AIFieldMappingSuggestion[],
    options: AITransformationOptions,
  ): FieldMapping[] {
    return suggestions
      .filter(suggestion => suggestion.confidence >= options.confidenceThreshold)
      .map((suggestion): FieldMapping => ({
        sourceField: suggestion.sourceField,
        targetField: suggestion.targetField,
        transformationType: suggestion.transformationType,
        isRequired: false, // Would be determined by schema analysis
        defaultValue: undefined,
      }));
  }

  /**
   * Merge existing mappings with suggested mappings
   */
  private mergeMappings(
    existingMappings: FieldMapping[],
    suggestedMappings: FieldMapping[],
  ): FieldMapping[] {
    const existingFields = new Set(existingMappings.map(m => m.sourceField));
    const newMappings = suggestedMappings.filter(m => !existingFields.has(m.sourceField));

    return [...existingMappings, ...newMappings];
  }

  /**
   * Calculate overall confidence score
   */
  private calculateOverallConfidence(
    suggestions: AIFieldMappingSuggestion[],
    qualityReport: MappingQualityReport,
  ): number {
    if (suggestions.length === 0) return 0;

    const avgSuggestionConfidence = suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length;
    const qualityScore = qualityReport.overallScore;

    return (avgSuggestionConfidence + qualityScore) / 2;
  }

  /**
   * Generate recommendations based on AI analysis
   */
  private generateRecommendations(
    suggestions: AIFieldMappingSuggestion[],
    qualityReport: MappingQualityReport,
    options: AITransformationOptions,
  ): string[] {
    const recommendations: string[] = [];

    // High confidence suggestions
    const highConfidenceSuggestions = suggestions.filter(s => s.confidence > 0.9);
    if (highConfidenceSuggestions.length > 0) {
      recommendations.push(`${highConfidenceSuggestions.length} high-confidence field mappings ready for auto-acceptance`);
    }

    // Quality improvements
    if (qualityReport.overallScore < 0.8) {
      recommendations.push('Consider reviewing field mappings to improve overall quality');
    }

    // NetSuite-specific recommendations
    const netsuiteSpecificSuggestions = suggestions.filter(s => s.netsuiteSpecific?.customFieldId);
    if (netsuiteSpecificSuggestions.length > 0) {
      recommendations.push(`${netsuiteSpecificSuggestions.length} custom field mappings detected - verify field availability in target NetSuite account`);
    }

    // Pattern-based recommendations
    if (options.enablePatternRecognition) {
      recommendations.push('Enable pattern recognition for improved data validation');
    }

    return recommendations;
  }

  /**
   * Generate missing field mapping suggestions
   */
  private async generateMissingSuggestions(
    context: TransformationContext,
    options: AITransformationOptions,
  ): Promise<AIFieldMappingSuggestion[]> {
    // This is a simplified implementation
    // In a real scenario, this would analyze unmapped source fields

    const mappedSourceFields = new Set(context.mappings.map(m => m.sourceField));
    const sourceFields = Object.keys(context.sourceData.fields || {});
    const unmappedFields = sourceFields.filter(field => !mappedSourceFields.has(field));

    const suggestions: AIFieldMappingSuggestion[] = [];

    for (const field of unmappedFields.slice(0, 5)) { // Limit for demo
      suggestions.push({
        sourceField: field,
        targetField: this.suggestTargetField(field),
        confidence: 0.7,
        transformationType: 'direct',
        explanation: 'AI-suggested mapping based on field name similarity',
        alternatives: [],
        netsuiteSpecific: {
          customFieldId: field.startsWith('custom_') ? `custentity_${field}` : undefined,
        },
      });
    }

    return suggestions;
  }

  /**
   * Auto-apply high confidence mappings
   */
  private async autoApplyHighConfidenceMappings(
    context: TransformationContext,
    suggestions: AIFieldMappingSuggestion[],
    threshold: number,
  ): Promise<{ mappings: FieldMapping[]; count: number }> {
    const highConfidenceSuggestions = suggestions.filter(s => s.confidence >= threshold);

    const mappings: FieldMapping[] = highConfidenceSuggestions.map((suggestion): FieldMapping => ({
      sourceField: suggestion.sourceField,
      targetField: suggestion.targetField,
      transformationType: suggestion.transformationType,
      isRequired: false,
      defaultValue: undefined,
    }));

    return { mappings, count: mappings.length };
  }

  /**
   * Generate learning insights
   */
  private async generateLearningInsights(
    context: TransformationContext,
    result: TransformationResult,
  ): Promise<string[]> {
    const insights: string[] = [];

    // Analyze transformation success
    if (result.errors.length === 0) {
      insights.push('Transformation completed successfully - good mapping configuration');
    } else {
      insights.push(`${result.errors.length} transformation errors detected - review field mappings`);
    }

    // Analyze field coverage
    const mappedFields = context.mappings.length;
    const sourceFields = Object.keys(context.sourceData.fields || {}).length;
    const coverage = (mappedFields / sourceFields) * 100;

    if (coverage < 50) {
      insights.push(`Low field mapping coverage (${Math.round(coverage)}%) - consider adding more mappings`);
    }

    return insights;
  }

  /**
   * Calculate transformation confidence
   */
  private calculateTransformationConfidence(
    result: TransformationResult,
    suggestions: AIFieldMappingSuggestion[],
    qualityReport?: MappingQualityReport,
  ): number {
    let confidence = result.success ? 0.8 : 0.3;

    // Adjust based on errors
    if (result.errors.length > 0) {
      confidence -= result.errors.length * 0.1;
    }

    // Adjust based on AI suggestions
    if (suggestions.length > 0) {
      const avgSuggestionConfidence = suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length;
      confidence = (confidence + avgSuggestionConfidence) / 2;
    }

    // Adjust based on quality report
    if (qualityReport) {
      confidence = (confidence + qualityReport.overallScore) / 2;
    }

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Create mock schema for demo purposes
   */
  private createMockSchema(context: TransformationContext): SchemaDefinition {
    const sourceFields = Object.keys(context.sourceData.fields || {});

    return {
      systemType: 'Unknown',
      fields: sourceFields.map(field => ({
        name: field,
        type: 'string',
        required: false,
      })),
    };
  }

  /**
   * Create mock NetSuite schema for demo purposes
   */
  private async createMockNetSuiteSchema(): Promise<NetSuiteSchema> {
    return {
      systemType: 'NetSuite',
      recordType: 'customer',
      fields: [
        { name: 'companyname', type: 'string', required: true },
        { name: 'email', type: 'email', required: false },
        { name: 'phone', type: 'phone', required: false },
      ],
      customFields: [],
      relationships: [],
    };
  }

  /**
   * Simple target field suggestion based on field name
   */
  private suggestTargetField(sourceField: string): string {
    const mapping: Record<string, string> = {
      'name': 'companyname',
      'company': 'companyname',
      'email': 'email',
      'phone': 'phone',
      'address': 'defaultaddress',
    };

    const lowerField = sourceField.toLowerCase();
    for (const [key, value] of Object.entries(mapping)) {
      if (lowerField.includes(key)) {
        return value;
      }
    }

    return `custentity_${sourceField.toLowerCase()}`;
  }
}
