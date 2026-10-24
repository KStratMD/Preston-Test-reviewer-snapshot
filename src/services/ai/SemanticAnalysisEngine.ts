/**
 * Semantic Analysis Engine
 * 
 * Core service for AI-powered semantic understanding of fields, schemas, and mappings.
 * Integrates with LMStudio, OpenAI, Claude, and other LLM providers for intelligent analysis.
 * 
 * This is the foundation of the Universal Translator's semantic intelligence layer.
 * 
 * @module SemanticAnalysisEngine
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { SecureAIService } from './SecureAIService';
import type { Logger } from '../../utils/Logger';
import {
  FieldAnalysisRequest,
  SemanticAnalysis,
  FieldMappingRecommendation,
  SimilarityRequest,
  SimilarityResult,
  SchemaAnalysisRequest,
  SchemaAnalysisResult,
  LLMAnalysisOptions,
  ConfidenceFactors,
  FieldDefinition,
  SemanticRisk,
  ComplianceConsideration,
  AnalysisMetadata,
  IntegrationStrategy,
  TypeCompatibility,
  TransformationType,
  TransformationSuggestion
} from '../../types/semantic.types';
import {
  FIELD_MAPPING_PROMPT,
  SEMANTIC_SIMILARITY_PROMPT,
  SCHEMA_ANALYSIS_PROMPT,
  INDUSTRY_CONTEXT_PROMPT,
  populateTemplate,
  validateTemplateVariables
} from './prompts/FieldAnalysisPrompts';
import { parseJsonFromText } from '../../utils/json';

/**
 * Shape of a single mapping recommendation as returned by the LLM JSON response.
 * The LLM emits `targetFieldIndex` (an index into the request's `targetFields`
 * array); `mapRecommendationToField` resolves it to a concrete `FieldDefinition`.
 *
 * All properties are optional: the LLM is not contract-bound to populate every
 * field, so consumers must defend with `?? defaults` or null checks.
 */
interface RecommendationShape {
  targetFieldIndex?: number;
  confidence?: number;
  semanticSimilarity?: number;
  reasons?: string[];
  typeCompatibility?: TypeCompatibility;
  transformationType?: TransformationType;
}

/**
 * Shape of the parsed JSON response from `FIELD_MAPPING_PROMPT`.
 *
 * `primaryMapping` and `alternativeMappings[]` use the index-based
 * `RecommendationShape` because the LLM only sees field names/types and emits
 * indices; the engine resolves indices to `FieldDefinition` objects before
 * returning a `SemanticAnalysis` to callers.
 */
interface ParsedAnalysisShape {
  primaryMapping?: RecommendationShape;
  alternativeMappings?: RecommendationShape[];
  reasoning?: string;
  risks?: SemanticRisk[];
  compliance?: ComplianceConsideration[];
  transformation?: TransformationSuggestion;
}

function describeValueType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Object-shape guard for the parsed LLM response. Verifies the value is a
 * non-null, non-array object only — does NOT validate that primaryMapping /
 * alternativeMappings / etc. are present or well-formed. Per-field type
 * checks and defaults at consumption sites (e.g. `mapRecommendationToField`)
 * handle malformed nested fields. Throws `TypeError` on shape violation.
 */
function assertParsedAnalysisIsObject(value: unknown): asserts value is ParsedAnalysisShape {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `Expected LLM response to parse as a JSON object, got ${describeValueType(value)}`
    );
  }
}

/**
 * Object-shape guard for a single recommendation entry from
 * `alternativeMappings`. Same scope as `assertParsedAnalysisIsObject`:
 * verifies "non-null, non-array object" only; field-level validation
 * happens at consumption.
 */
function assertRecommendationIsObject(value: unknown): asserts value is RecommendationShape {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(
      `Expected recommendation to be a JSON object, got ${describeValueType(value)}`
    );
  }
}

const TRANSFORMATION_TYPES = new Set<TransformationType>([
  'direct', 'lookup', 'calculation', 'concatenation', 'split',
  'conditional', 'formatting', 'encryption', 'custom'
]);
const DATA_LOSS_RISKS = new Set<TypeCompatibility['dataLossRisk']>(['none', 'low', 'medium', 'high']);

function isValidTransformationType(v: unknown): v is TransformationType {
  return typeof v === 'string' && TRANSFORMATION_TYPES.has(v as TransformationType);
}

function isValidTypeCompatibility(v: unknown): v is TypeCompatibility {
  if (v === null || typeof v !== 'object') return false;
  const obj = v as Record<string, unknown>;
  return (
    typeof obj.compatible === 'boolean' &&
    typeof obj.confidence === 'number' &&
    typeof obj.dataLossRisk === 'string' &&
    DATA_LOSS_RISKS.has(obj.dataLossRisk as TypeCompatibility['dataLossRisk'])
  );
}

function coerceReasons(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((r): r is string => typeof r === 'string');
}

const DEFAULT_TYPE_COMPATIBILITY: TypeCompatibility = {
  compatible: false,
  confidence: 0,
  dataLossRisk: 'medium'
};

/**
 * Semantic Analysis Engine for Universal Translator
 *
 * Provides AI-powered semantic understanding of data fields and schemas.
 * Replaces rule-based heuristics with genuine LLM reasoning.
 */
@injectable()
export class SemanticAnalysisEngine {
  private static readonly SYNONYM_MAP: Record<string, string> = {
    email: 'email',
    mail: 'email',
    'e-mail': 'email',
    e_mail: 'email',
    phone: 'phone',
    telephone: 'phone',
    mobile: 'phone',
    cellphone: 'phone',
    firstname: 'first_name',
    'first-name': 'first_name',
    first: 'first_name',
    lastname: 'last_name',
    'last-name': 'last_name',
    surname: 'last_name',
    addr: 'address',
    address1: 'address',
    address2: 'address',
    zipcode: 'postal_code',
    postcode: 'postal_code',
    zip: 'postal_code',
    customer: 'customer',
    client: 'customer',
    account: 'customer',
    revenue: 'amount',
    amount: 'amount',
    total: 'amount',
    order: 'order',
    invoice: 'invoice'
  };

  private static readonly DOMAIN_WEIGHTS: Record<string, number> = {
    email: 1.3,
    phone: 1.25,
    customer: 1.2,
    amount: 1.2,
    address: 1.1,
    postal_code: 1.1,
    order: 1.15,
    invoice: 1.15,
    id: 1.1,
    sku: 1.15
  };

  private readonly logger: Logger;
  private readonly defaultProvider = process.env.DEFAULT_AI_PROVIDER || 'openai'; // Use configured default provider
  private readonly version = '1.0.0';

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.SecureAIService) private secureAIService: SecureAIService
  ) {
    this.logger = logger;
    this.logger.info('SemanticAnalysisEngine initialized', {
      context: 'SemanticAnalysisEngine',
      version: this.version,
      defaultProvider: this.defaultProvider
    });
  }

  /**
   * Analyze field mapping with semantic understanding
   * 
   * This is the core function that replaces rule-based string matching
   * with genuine AI semantic analysis.
   * 
   * @param request Field analysis request
   * @param options LLM analysis options
   * @returns Semantic analysis with recommendations
   */
  async analyzeFieldMapping(
    request: FieldAnalysisRequest,
    options?: LLMAnalysisOptions
  ): Promise<SemanticAnalysis> {
    const startTime = Date.now();
    
    try {
      this.logger.info('Starting field mapping analysis', {
        context: 'SemanticAnalysisEngine',
        sourceField: request.sourceField.name,
        targetFieldCount: request.targetFields.length,
        provider: options?.provider || this.defaultProvider
      });

      // Validate request
      this.validateFieldAnalysisRequest(request);

      // Build prompt from template
      const prompt = this.buildFieldMappingPrompt(request);

      // Call LLM provider
      const llmOptions: LLMAnalysisOptions = {
        provider: options?.provider || this.defaultProvider,
        model: options?.model,
        temperature: options?.temperature || FIELD_MAPPING_PROMPT.temperature,
        maxTokens: options?.maxTokens || FIELD_MAPPING_PROMPT.maxTokens,
        useCache: options?.useCache ?? true,
        budgetLimit: options?.budgetLimit || 0.05, // $0.05 per analysis max
        timeout: options?.timeout || 10000 // 10 second timeout
      };

      // Get AI analysis
      const response = await this.callLLMProvider(prompt, llmOptions);

      // Parse response
      const parsedAnalysis = this.parseFieldMappingResponse(response.content);

      // Calculate confidence factors
      const confidenceFactors = await this.calculateConfidenceFactors(
        request,
        parsedAnalysis
      );

      // primaryMapping is optional on ParsedAnalysisShape (the parser
      // only verifies "non-null object"); enforce its presence here so
      // mapRecommendationToField's assert doesn't surface as a generic
      // TypeError and the missing-required-field reason is explicit.
      if (!parsedAnalysis.primaryMapping) {
        throw new Error('LLM response is missing required primaryMapping');
      }
      // Map target field indices to actual FieldDefinition objects
      const primaryMapping = this.mapRecommendationToField(
        parsedAnalysis.primaryMapping,
        request.targetFields
      );

      const altMappingsArray = Array.isArray(parsedAnalysis.alternativeMappings)
        ? parsedAnalysis.alternativeMappings
        : [];
      const alternativeMappings = altMappingsArray.map(alt =>
        this.mapRecommendationToField(alt, request.targetFields)
      );

      // Build final analysis result. risks/compliance/reasoning come from
      // untrusted LLM JSON: `?? []` would let truthy non-arrays (e.g. an
      // object) through and violate the SemanticAnalysis type contract.
      // Use Array.isArray to coerce only real arrays; otherwise default.
      const analysis: SemanticAnalysis = {
        primaryMapping,
        alternativeMappings,
        reasoning: typeof parsedAnalysis.reasoning === 'string' ? parsedAnalysis.reasoning : '',
        confidence: confidenceFactors.overall,
        risks: Array.isArray(parsedAnalysis.risks) ? parsedAnalysis.risks : [],
        compliance: Array.isArray(parsedAnalysis.compliance) ? parsedAnalysis.compliance : [],
        transformation: parsedAnalysis.transformation,
        metadata: {
          provider: response.provider,
          model: response.model,
          timestamp: new Date(),
          responseTime: Date.now() - startTime,
          cost: response.cost || 0,
          tokensUsed: response.tokensUsed,
          version: this.version
        }
      };

      this.logger.info('Field mapping analysis completed', {
        context: 'SemanticAnalysisEngine',
        confidence: analysis.confidence,
        responseTime: analysis.metadata.responseTime,
        cost: analysis.metadata.cost,
        primaryTarget: analysis.primaryMapping.targetField.name
      });

      return analysis;

    } catch (error) {
      this.logger.error('Field mapping analysis failed', {
        context: 'SemanticAnalysisEngine',
        error: error instanceof Error ? error.message : String(error),
        sourceField: request.sourceField.name
      });

      // Return fallback analysis with low confidence
      return this.createFallbackAnalysis(request, error as Error, Date.now() - startTime);
    }
  }

  /**
   * Calculate semantic similarity between two fields
   * 
   * Faster, lower-cost operation for quick similarity checks.
   * 
   * @param request Similarity request
   * @param options LLM options
   * @returns Similarity result
   */
  async calculateSemanticSimilarity(
    request: SimilarityRequest,
    options?: LLMAnalysisOptions
  ): Promise<SimilarityResult> {
    try {
      // Try embeddings or calibrated fallback if requested
      if (request.useEmbeddings) {
        return await this.calculateSimilarityWithEmbeddings(request);
      }

      // Fall back to LLM analysis
      const prompt = populateTemplate(SEMANTIC_SIMILARITY_PROMPT, {
        field1: { name: request.text1 },
        field2: { name: request.text2 },
        context: request.context || ''
      });

      const llmOptions: LLMAnalysisOptions = {
        provider: options?.provider || this.defaultProvider,
        temperature: 0.1,
        maxTokens: 500,
        useCache: true,
        budgetLimit: 0.01 // Very low budget for similarity
      };

      const response = await this.callLLMProvider(prompt, llmOptions);
      const parsed = parseJsonFromText<{
        similarity?: number;
        explanation?: string;
        confidence?: number;
      }>(response.content);

      if (!parsed) {
        throw new Error('Semantic similarity response did not contain valid JSON');
      }

      return {
        score: parsed.similarity || 0,
        method: 'llm_analysis',
        explanation: parsed.explanation,
        confidence: parsed.confidence || 0.8
      };

    } catch (error) {
      this.logger.warn('Semantic similarity calculation failed, using heuristic fallback', {
        context: 'SemanticAnalysisEngine',
        error: error instanceof Error ? error.message : String(error)
      });

      // Fallback to simple heuristic
      return this.calculateSimilarityHeuristic(request);
    }
  }

  /**
   * Analyze complete schema compatibility
   * 
   * Analyzes all fields in source and target schemas and provides
   * overall integration strategy recommendations.
   * 
   * @param request Schema analysis request
   * @param options LLM options
   * @returns Schema analysis result
   */
  async analyzeSchemaMapping(
    request: SchemaAnalysisRequest,
    options?: LLMAnalysisOptions
  ): Promise<SchemaAnalysisResult> {
    const startTime = Date.now();

    try {
      this.logger.info('Starting schema mapping analysis', {
        context: 'SemanticAnalysisEngine',
        sourceSchema: request.sourceSchema.name,
        targetSchema: request.targetSchema.name,
        sourceFieldCount: request.sourceSchema.fields.length,
        targetFieldCount: request.targetSchema.fields.length
      });

      // Analyze individual field mappings
      const fieldMappings: SemanticAnalysis[] = [];
      
      for (const sourceField of request.sourceSchema.fields) {
        const fieldRequest: FieldAnalysisRequest = {
          sourceField,
          targetFields: request.targetSchema.fields,
          context: request.context,
          sampleData: request.sampleData
        };

        const analysis = await this.analyzeFieldMapping(fieldRequest, options);
        fieldMappings.push(analysis);
      }

      // Get overall schema-level analysis from LLM
      const schemaPrompt = populateTemplate(SCHEMA_ANALYSIS_PROMPT, {
        sourceSchema: request.sourceSchema,
        targetSchema: request.targetSchema,
        context: request.context
      });

      const llmOptions: LLMAnalysisOptions = {
        provider: options?.provider || this.defaultProvider,
        temperature: 0.1,
        maxTokens: 3000,
        budgetLimit: 0.10 // Higher budget for schema analysis
      };

      const response = await this.callLLMProvider(schemaPrompt, llmOptions);
      const schemaAnalysis = parseJsonFromText<{
        overallCompatibility?: number;
        integrationStrategy: IntegrationStrategy;
        schemaRisks?: SemanticRisk[];
      }>(response.content);

      if (!schemaAnalysis) {
        throw new Error('Schema analysis response did not contain valid JSON');
      }

      // Calculate unmapped fields
      const mappedTargetIndices = new Set(
        fieldMappings
          .map(fm => request.targetSchema.fields.indexOf(fm.primaryMapping.targetField))
          .filter(idx => idx !== -1)
      );

      const unmappedTargetFields = request.targetSchema.fields.filter(
        (_, idx) => !mappedTargetIndices.has(idx)
      );

      const unmappedSourceFields = request.sourceSchema.fields.filter((sf, idx) => {
        const mapping = fieldMappings[idx];
        return mapping.confidence < 0.5; // Consider low confidence as unmapped
      });

      const result: SchemaAnalysisResult = {
        fieldMappings,
        overallCompatibility: schemaAnalysis.overallCompatibility || 0,
        unmappedSourceFields,
        unmappedTargetFields,
        integrationStrategy: schemaAnalysis.integrationStrategy,
        schemaRisks: schemaAnalysis.schemaRisks || [],
        metadata: {
          provider: response.provider,
          model: response.model,
          timestamp: new Date(),
          responseTime: Date.now() - startTime,
          cost: response.cost || 0,
          tokensUsed: response.tokensUsed,
          version: this.version
        }
      };

      this.logger.info('Schema mapping analysis completed', {
        context: 'SemanticAnalysisEngine',
        overallCompatibility: result.overallCompatibility,
        mappedFields: fieldMappings.length - unmappedSourceFields.length,
        unmappedSource: unmappedSourceFields.length,
        unmappedTarget: unmappedTargetFields.length,
        responseTime: result.metadata.responseTime,
        totalCost: result.metadata.cost
      });

      return result;

    } catch (error) {
      this.logger.error('Schema mapping analysis failed', {
        context: 'SemanticAnalysisEngine',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Build field mapping prompt from request
   */
  private buildFieldMappingPrompt(request: FieldAnalysisRequest): string {
    const validation = validateTemplateVariables(FIELD_MAPPING_PROMPT, {
      sourceField: request.sourceField,
      targetFields: request.targetFields,
      context: request.context,
      samples: request.sampleData
    });

    if (!validation.valid) {
      throw new Error(`Missing required template variables: ${validation.missing.join(', ')}`);
    }

    return populateTemplate(FIELD_MAPPING_PROMPT, {
      sourceField: request.sourceField,
      targetFields: request.targetFields,
      context: request.context,
      samples: request.sampleData
    });
  }

  /**
   * Call LLM provider with retry logic
   */
  private async callLLMProvider(
    prompt: string,
    options: LLMAnalysisOptions
  ): Promise<{
    content: string;
    provider: string;
    model: string;
    cost?: number;
    tokensUsed?: { prompt: number; completion: number; total: number };
  }> {
    // TODO: Integrate with SecureAIService's provider selection
    // For now, direct integration with LMStudio

    const provider = options.provider || this.defaultProvider;
    const model = options.model || 'default';

    try {
      // Call the AI provider through SecureAIService
      const response = await this.secureAIService.callProvider({
        provider,
        model,
        messages: [
          {
            role: 'system',
            content: FIELD_MAPPING_PROMPT.systemMessage || ''
          },
          {
            role: 'user',
            content: prompt
          }
        ],
        temperature: options.temperature || 0.1,
        maxTokens: options.maxTokens || 2000
      });

      return {
        content: response.content,
        provider: response.provider || provider,
        model: response.model || model,
        cost: response.cost,
        tokensUsed: response.tokensUsed
      };

    } catch (error) {
      this.logger.error('LLM provider call failed', {
        context: 'SemanticAnalysisEngine',
        provider,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Parse field mapping response from LLM
   */
  private parseFieldMappingResponse(content: string): ParsedAnalysisShape {
    const parsed = parseJsonFromText(content);

    if (!parsed) {
      this.logger.error('Failed to parse LLM response', {
        context: 'SemanticAnalysisEngine',
        content: content.substring(0, 200)
      });
      throw new Error('Invalid JSON response from LLM');
    }

    assertParsedAnalysisIsObject(parsed);
    return parsed;
  }

  /**
   * Map recommendation index to actual FieldDefinition
   */
  private mapRecommendationToField(
    recommendation: unknown,
    targetFields: FieldDefinition[]
  ): FieldMappingRecommendation {
    assertRecommendationIsObject(recommendation);
    const { targetFieldIndex } = recommendation;
    const targetField =
      typeof targetFieldIndex === 'number' ? targetFields[targetFieldIndex] : undefined;

    if (!targetField) {
      throw new Error(`Invalid target field index: ${targetFieldIndex}`);
    }

    return {
      targetField,
      confidence: typeof recommendation.confidence === 'number' ? recommendation.confidence : 0,
      semanticSimilarity:
        typeof recommendation.semanticSimilarity === 'number' ? recommendation.semanticSimilarity : 0,
      reasons: coerceReasons(recommendation.reasons),
      typeCompatibility: isValidTypeCompatibility(recommendation.typeCompatibility)
        ? recommendation.typeCompatibility
        : DEFAULT_TYPE_COMPATIBILITY,
      transformationType: isValidTransformationType(recommendation.transformationType)
        ? recommendation.transformationType
        : 'direct'
    };
  }

  /**
   * Calculate confidence factors for mapping
   */
  private async calculateConfidenceFactors(
    request: FieldAnalysisRequest,
    analysis: ParsedAnalysisShape
  ): Promise<ConfidenceFactors> {
    const primary = analysis.primaryMapping ?? {};

    // Semantic similarity from LLM
    const semanticSimilarity = primary.semanticSimilarity ?? 0;

    // Type compatibility
    const typeCompatibility = primary.typeCompatibility?.compatible
      ? primary.typeCompatibility.confidence || 0.8
      : 0.3;

    // Context alignment (based on industry, process match)
    const contextAlignment = 0.7; // Simplified for now

    // Historical match (from learning service - simplified for now)
    const historicalMatch = 0.5;

    // Sample validation (if samples provided)
    const sampleValidation = request.sampleData ? 0.8 : 0.5;

    // Weighted average (adjust weights based on importance)
    const weights = {
      semantic: 0.35,
      type: 0.25,
      context: 0.15,
      historical: 0.15,
      sample: 0.10
    };

    const overall =
      semanticSimilarity * weights.semantic +
      typeCompatibility * weights.type +
      contextAlignment * weights.context +
      historicalMatch * weights.historical +
      sampleValidation * weights.sample;

    return {
      semanticSimilarity,
      typeCompatibility,
      contextAlignment,
      historicalMatch,
      sampleValidation,
      overall,
      explanation: `Confidence based on: semantic similarity (${Math.round(semanticSimilarity * 100)}%), ` +
        `type compatibility (${Math.round(typeCompatibility * 100)}%), ` +
        `context alignment (${Math.round(contextAlignment * 100)}%), ` +
        `historical patterns (${Math.round(historicalMatch * 100)}%), ` +
        `sample validation (${Math.round(sampleValidation * 100)}%)`
    };
  }

  /**
   * Create fallback analysis when LLM fails
   */
  private createFallbackAnalysis(
    request: FieldAnalysisRequest,
    error: Error,
    responseTime: number
  ): SemanticAnalysis {
    // Use simple heuristic as fallback
    const bestMatch = this.findBestHeuristicMatch(
      request.sourceField,
      request.targetFields
    );

    const fallbackRisk: SemanticRisk = {
      severity: 'high',
      category: 'business_logic',
      description: `AI analysis failed: ${error.message}. Using heuristic fallback with low confidence.`,
      affectedFields: [request.sourceField.name],
      mitigation: [
        'Review mapping manually',
        'Test thoroughly before production',
        'Consider re-running analysis with different provider'
      ]
    };

    return {
      primaryMapping: {
        targetField: bestMatch.field,
        confidence: bestMatch.score * 0.5, // Reduce confidence for fallback
        semanticSimilarity: bestMatch.score,
        reasons: ['Heuristic match - AI analysis unavailable'],
        typeCompatibility: {
          compatible: request.sourceField.type === bestMatch.field.type,
          confidence: 0.5,
          dataLossRisk: 'medium'
        },
        transformationType: 'direct'
      },
      alternativeMappings: [],
      reasoning: 'AI analysis failed. Fallback heuristic used. Manual review recommended.',
      confidence: bestMatch.score * 0.5,
      risks: [fallbackRisk],
      compliance: [],
      metadata: {
        provider: 'fallback-heuristic',
        model: 'rule-based',
        timestamp: new Date(),
        responseTime,
        cost: 0,
        version: this.version
      }
    };
  }

  /**
   * Find best match using simple heuristics (fallback only)
   */
  private findBestHeuristicMatch(
    sourceField: FieldDefinition,
    targetFields: FieldDefinition[]
  ): { field: FieldDefinition; score: number } {
    let bestField = targetFields[0];
    let bestScore = 0;

    for (const targetField of targetFields) {
      let score = 0;

      // Exact name match
      if (sourceField.name.toLowerCase() === targetField.name.toLowerCase()) {
        score += 0.9;
      }
      // Partial name match
      else if (
        sourceField.name.toLowerCase().includes(targetField.name.toLowerCase()) ||
        targetField.name.toLowerCase().includes(sourceField.name.toLowerCase())
      ) {
        score += 0.6;
      }

      // Type match
      if (sourceField.type === targetField.type) {
        score += 0.3;
      }

      if (score > bestScore) {
        bestScore = score;
        bestField = targetField;
      }
    }

    return { field: bestField, score: Math.min(bestScore, 1.0) };
  }

  /**
   * Calculate similarity using embeddings (when available)
   */
  private async calculateSimilarityWithEmbeddings(
    request: SimilarityRequest
  ): Promise<SimilarityResult> {
    // Attempt to use provider-backed embeddings when available
    if (this.secureAIService.supportsEmbeddings()) {
      const secureService = this.secureAIService as unknown as {
        generateEmbeddings?: (payload: string[]) => Promise<number[][]>;
      };

      if (typeof secureService.generateEmbeddings === 'function') {
        try {
          const vectors = await secureService.generateEmbeddings([request.text1, request.text2]);
          if (Array.isArray(vectors) && vectors.length === 2) {
            const similarity = this.cosineSimilarityFromVectors(vectors[0], vectors[1]);
            if (!Number.isNaN(similarity)) {
              return {
                score: similarity,
                method: 'embeddings',
                explanation: 'Cosine similarity calculated from provider embeddings',
                confidence: Math.min(0.95, Math.max(0.6, similarity))
              };
            }
          }
        } catch (error) {
          this.logger.warn('Embedding similarity failed, falling back to calibrated heuristic', {
            context: 'SemanticAnalysisEngine',
            error: error instanceof Error ? error.message : String(error)
          });
        }
      }
    }

    // Calibrated fallback: token, bigram, character n-gram, and prefix weighting
    const calibrated = this.computeCalibratedSimilarity(
      request.text1,
      request.text2,
      request.context
    );

    return {
      score: calibrated.score,
      method: 'calibrated_fallback',
      explanation: calibrated.explanation,
      confidence: calibrated.confidence
    };
  }

  private computeCalibratedSimilarity(
    rawText1: string,
    rawText2: string,
    context?: string
  ): { score: number; explanation: string; confidence: number } {
    const tokens1 = this.tokenize(rawText1);
    const tokens2 = this.tokenize(rawText2);

    const tokenProfile1 = this.buildFrequencyProfile(tokens1);
    const tokenProfile2 = this.buildFrequencyProfile(tokens2);
    const tokenScore = this.cosineSimilarityFromProfiles(tokenProfile1, tokenProfile2);

    const bigrams1 = this.createNGrams(tokens1, 2);
    const bigrams2 = this.createNGrams(tokens2, 2);
    const bigramScore = this.cosineSimilarityFromProfiles(
      this.buildFrequencyProfile(bigrams1),
      this.buildFrequencyProfile(bigrams2)
    );

    const charProfile1 = this.buildFrequencyProfile(this.createCharacterNGrams(rawText1, 3));
    const charProfile2 = this.buildFrequencyProfile(this.createCharacterNGrams(rawText2, 3));
    const charScore = this.cosineSimilarityFromProfiles(charProfile1, charProfile2);

    const prefixScore = this.computePrefixScore(rawText1, rawText2);
    const contextBoost = this.computeContextBoost(context, tokens1, tokens2);

    const aggregatedScore = this.clamp(
      tokenScore * 0.45 +
      bigramScore * 0.25 +
      charScore * 0.15 +
      prefixScore * 0.15 +
      contextBoost,
      0,
      1
    );

    const confidence = this.clamp(0.55 + aggregatedScore * 0.35, 0.5, 0.9);
    const explanation = [
      `Token overlap ${(tokenScore * 100).toFixed(0)}%`,
      `Bigram alignment ${(bigramScore * 100).toFixed(0)}%`,
      `Prefix/semantic boost ${(prefixScore * 100).toFixed(0)}%`,
      contextBoost > 0 ? `Context boost ${(contextBoost * 100).toFixed(0)}%` : undefined
    ].filter(Boolean).join(' | ');

    return { score: aggregatedScore, explanation, confidence };
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[_\-]+/g, ' ')
      .split(/\W+/)
      .map(token => this.normalizeToken(token))
      .filter(token => token.length > 0);
  }

  private normalizeToken(token: string): string {
    if (!token) {
      return token;
    }

    const synonym = SemanticAnalysisEngine.SYNONYM_MAP[token];
    if (synonym) {
      return synonym;
    }

    return token;
  }

  private buildFrequencyProfile(values: string[]): Map<string, number> {
    const profile = new Map<string, number>();
    values.forEach(value => {
      const weight = SemanticAnalysisEngine.DOMAIN_WEIGHTS[value] ?? 1;
      profile.set(value, (profile.get(value) ?? 0) + weight);
    });
    return profile;
  }

  private createNGrams(tokens: string[], size: number): string[] {
    if (tokens.length < size) {
      return [];
    }
    const ngrams: string[] = [];
    for (let i = 0; i <= tokens.length - size; i++) {
      ngrams.push(tokens.slice(i, i + size).join(' '));
    }
    return ngrams;
  }

  private createCharacterNGrams(text: string, size: number): string[] {
    const normalized = text.toLowerCase().replace(/\s+/g, ' ');
    if (normalized.length < size) {
      return [normalized];
    }

    const grams: string[] = [];
    for (let i = 0; i <= normalized.length - size; i++) {
      grams.push(normalized.slice(i, i + size));
    }
    return grams;
  }

  private cosineSimilarityFromProfiles(
    profileA: Map<string, number>,
    profileB: Map<string, number>
  ): number {
    if (profileA.size === 0 || profileB.size === 0) {
      return 0;
    }

    let dot = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    profileA.forEach((valueA, key) => {
      const valueB = profileB.get(key) ?? 0;
      dot += valueA * valueB;
      magnitudeA += valueA * valueA;
    });

    profileB.forEach(valueB => {
      magnitudeB += valueB * valueB;
    });

    if (magnitudeA === 0 || magnitudeB === 0) {
      return 0;
    }

    return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
  }

  private cosineSimilarityFromVectors(vectorA: number[], vectorB: number[]): number {
    if (!Array.isArray(vectorA) || !Array.isArray(vectorB) || vectorA.length !== vectorB.length) {
      return NaN;
    }

    let dot = 0;
    let magnitudeA = 0;
    let magnitudeB = 0;

    for (let i = 0; i < vectorA.length; i++) {
      const a = vectorA[i];
      const b = vectorB[i];
      dot += a * b;
      magnitudeA += a * a;
      magnitudeB += b * b;
    }

    if (magnitudeA === 0 || magnitudeB === 0) {
      return NaN;
    }

    return dot / (Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB));
  }

  private computePrefixScore(text1: string, text2: string): number {
    const normalized1 = text1.trim().toLowerCase();
    const normalized2 = text2.trim().toLowerCase();

    if (normalized1 === normalized2) {
      return 1;
    }

    if (normalized1.startsWith(normalized2) || normalized2.startsWith(normalized1)) {
      return 0.8;
    }

    return 0;
  }

  private computeContextBoost(
    context: string | undefined,
    tokens1: string[],
    tokens2: string[]
  ): number {
    if (!context) {
      return 0;
    }

    const contextTokens = this.tokenize(context);
    const sharedContext = contextTokens.filter(token =>
      tokens1.includes(token) && tokens2.includes(token)
    );

    if (sharedContext.length === 0) {
      return 0;
    }

    return this.clamp(sharedContext.length * 0.02, 0, 0.1);
  }

  private clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Calculate similarity using heuristics (fallback)
   */
  private calculateSimilarityHeuristic(request: SimilarityRequest): SimilarityResult {
    const text1Lower = request.text1.toLowerCase();
    const text2Lower = request.text2.toLowerCase();

    let score: number;

    // Exact match
    if (text1Lower === text2Lower) {
      score = 1.0;
    }
    // Contains match
    else if (text1Lower.includes(text2Lower) || text2Lower.includes(text1Lower)) {
      score = 0.7;
    }
    // Word overlap
    else {
      const words1 = text1Lower.split(/\W+/);
      const words2 = text2Lower.split(/\W+/);
      const intersection = words1.filter(w => words2.includes(w));
      score = intersection.length / Math.max(words1.length, words2.length);
    }

    return {
      score,
      method: 'heuristic',
      explanation: 'String-based heuristic similarity (fallback method)',
      confidence: 0.5
    };
  }

  /**
   * Validate field analysis request
   */
  private validateFieldAnalysisRequest(request: FieldAnalysisRequest): void {
    if (!request.sourceField || !request.sourceField.name) {
      throw new Error('Source field name is required');
    }

    if (!request.targetFields || request.targetFields.length === 0) {
      throw new Error('At least one target field is required');
    }

    if (!request.context) {
      throw new Error('Business context is required');
    }
  }
}
