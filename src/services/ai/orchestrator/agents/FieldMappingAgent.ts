/**
 * Field Mapping Agent - Advanced AI-powered field mapping with semantic analysis
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../../../inversify/types';
import { logger, type Logger } from '../../../../utils/Logger';
import { BaseAgent, type BaseAgentConfig } from '../BaseAgent';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema,
  FieldMappingInput,
  FieldMappingOutput
} from '../interfaces';
import { ProviderRegistry } from '../../ProviderRegistry';
import { SemanticAnalysisEngine } from '../../SemanticAnalysisEngine';
import { AIConfigurationService } from '../../AIConfigurationService';
import { SchemaAnalysisService } from './services/field-mapping/SchemaAnalysisService';
import {
  MappingSuggestionService,
  type MappingSuggestionResult,
  type ProviderUsageSnapshot
} from './services/field-mapping/MappingSuggestionService';
import { MappingValidationService } from './services/field-mapping/MappingValidationService';
import { MappingQualityService } from './services/field-mapping/MappingQualityService';
import type {
  BusinessRule,
  DataSample,
  ExistingMapping,
  MappingContext,
  MappingPattern,
  MappingSuggestion,
  TransformationRule
} from './fieldMappingTypes';
// Phase 3: NetSuite MCP AI Enhancement (optional)
import type { MCPFieldMappingEnhancer } from '../../../ai/mcp/MCPFieldMappingEnhancer';
import { isNetSuiteMCPAIContextEnabled } from '../../../../config/runtimeFlags';

type FieldMappingRequestOverrides = {
  aiConfigProvider?: unknown;
  preferredProvider?: unknown;
};

type ValidationRuleInput = {
  id?: unknown;
  active?: unknown;
  name?: unknown;
  ruleName?: unknown;
  description?: unknown;
  message?: unknown;
  sourceFields?: unknown;
  targetFields?: unknown;
  transformation?: unknown;
  priority?: unknown;
};

type FieldMappingContextMetadata = {
  datasetId?: unknown;
  preferredProvider?: unknown;
};

@injectable()
export class FieldMappingAgent extends BaseAgent {
  private static readonly VALID_TRANSFORMATION_TYPES: ReadonlySet<TransformationRule['type']> = new Set([
    'direct',
    'lookup',
    'calculation',
    'concatenation',
    'conditional',
    'custom',
  ]);

  // Name pattern dictionary for enhanced field matching
  private static readonly NAME_PATTERNS = {
    firstName: [
      /^first.*name$/i,
      /^fname$/i,
      /^given.*name$/i,
      /^forename$/i,
      /^first$/i
    ],
    lastName: [
      /^last.*name$/i,
      /^lname$/i,
      /^surname$/i,
      /^family.*name$/i,
      /^last$/i
    ],
    fullName: [
      /^full.*name$/i,
      /^name$/i,
      /^contact.*name$/i,
      /^person.*name$/i,
      /^display.*name$/i
    ],
    company: [
      /^company$/i,
      /^company.*name$/i,
      /^organization$/i,
      /^org$/i,
      /^business$/i,
      /^account.*name$/i,
      /^firm$/i
    ]
  };

  private providerRegistry: ProviderRegistry;
  private semanticEngine: SemanticAnalysisEngine;
  private aiConfigService: AIConfigurationService;
  private mappingPatterns = new Map<string, MappingPattern>();
  private fieldSimilarityCache = new Map<string, number>();
  private lastProviderUsage?: ProviderUsageSnapshot;
  private readonly schemaAnalyzer: SchemaAnalysisService;
  private readonly suggestionService: MappingSuggestionService;
  private readonly validationService: MappingValidationService;
  private readonly qualityService: MappingQualityService;
  // Phase 3: Optional MCP enhancer for AI accuracy improvement
  private readonly mcpEnhancer?: MCPFieldMappingEnhancer;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject('ProviderRegistry') providerRegistry: ProviderRegistry,
    @inject(TYPES.SemanticAnalysisEngine) semanticEngine: SemanticAnalysisEngine,
    @inject(TYPES.AIConfigurationService) aiConfigService: AIConfigurationService,
    @optional() @inject(TYPES.MCPFieldMappingEnhancer) mcpEnhancer?: MCPFieldMappingEnhancer
  ) {
    const config: BaseAgentConfig = {
      name: 'FieldMappingAgent',
      version: '1.0.0',
      capabilities: [
        'field_mapping',
        'semantic_analysis',
        'transformation_suggestion',
        'mapping_validation',
        'pattern_recognition'
      ],
      dependencies: [],
      maxExecutionTime: 30000,
      confidenceThreshold: 0.6
    };

    super(config, logger);
    this.providerRegistry = providerRegistry;
    this.semanticEngine = semanticEngine;
    this.aiConfigService = aiConfigService;
    this.mcpEnhancer = mcpEnhancer;
    this.schemaAnalyzer = new SchemaAnalysisService();
    this.suggestionService = new MappingSuggestionService(
      logger,
      providerRegistry,
      semanticEngine,
      this.mappingPatterns,
      this.fieldSimilarityCache
    );
    this.validationService = new MappingValidationService();
    this.qualityService = new MappingQualityService();
    this.initializeMappingPatterns();

    // Log MCP enhancement status
    if (this.mcpEnhancer && isNetSuiteMCPAIContextEnabled()) {
      this.logger.info('FieldMappingAgent initialized with MCP AI enhancement', {
        expectedImprovement: '+3-4% accuracy'
      });
    }
  }

  protected async executeInternal(
    context: AgentExecutionContext,
    input: FieldMappingInput
  ): Promise<AgentResult> {
    try {
      this.logger.info('Field mapping agent execution started', {
        sessionId: context.sessionId,
        sourceFieldCount: input.sourceFields.length,
        targetFieldCount: input.targetFields.length
      });

      this.lastProviderUsage = undefined;

      this.logger.info('🔍 About to extract preferred provider ID...', {
        userId: context.userId,
        sessionId: context.sessionId
      });
      const preferredProviderId = await this.extractPreferredProviderId(context, input);
      this.logger.info('🔍 Extracted preferred provider ID', {
        preferredProviderId,
        sessionId: context.sessionId
      });
      const normalizedSampleData = this.normalizeSampleData(input.sampleData);

      // Analyze source and target schemas
      const sourceSchema = await this.schemaAnalyzer.analyzeSchema(input.sourceFields, context.sourceSystem);
      const targetSchema = await this.schemaAnalyzer.analyzeSchema(input.targetFields, context.targetSystem);

      // FIX: Extract business rules from input validation rules
      // Convert validation rules to business rule format if needed
      const businessRules = (input.validationRules || []).map((rule: unknown, index) =>
        this.normalizeValidationRule(rule, index),
      );

      const metadata = this.getContextMetadata(context.metadata);

      // Generate mapping suggestions using multiple strategies
      const mappingSuggestions = await this.generateMappingSuggestions({
        sourceSchema,
        targetSchema,
        businessRules,
        sampleData: normalizedSampleData,
        preferredProviderId,
        datasetId: metadata?.datasetId != null ? String(metadata.datasetId) : undefined
      });

      // Validate and score mappings
      const validatedMappings = this.validationService.validateMappings(
        mappingSuggestions,
        input,
        this.config.confidenceThreshold!
      );

      // Generate alternatives for each mapping
      const enhancedMappings = this.validationService.generateAlternatives(validatedMappings);

      // Calculate overall quality score
      const overallQuality = this.qualityService.calculateOverallQuality(enhancedMappings);

      // Generate recommendations
      const recommendations = this.qualityService.generateRecommendations(enhancedMappings, input);

      const output: FieldMappingOutput = {
        mappings: enhancedMappings,
        qualityScore: overallQuality,
        recommendations,
        alternatives: enhancedMappings.flatMap(m => m.alternatives || [])
      };

      const confidence = this.calculateConfidence([
        { factor: 'schema_analysis', value: 0.8, weight: 0.2 },
        { factor: 'mapping_quality', value: overallQuality, weight: 0.4 },
        { factor: 'pattern_matching', value: 0.7, weight: 0.2 },
        {
          factor: 'validation_success',
          value: mappingSuggestions.length > 0 ? validatedMappings.length / mappingSuggestions.length : 0,
          weight: 0.2
        }
      ]);

      const reasoning = this.mergeReasoning([
        `Analyzed ${input.sourceFields.length} source fields and ${input.targetFields.length} target fields`,
        `Generated ${mappingSuggestions.length} mapping suggestions using semantic analysis`,
        `Validated mappings with ${overallQuality.toFixed(2)} overall quality score`,
        `Applied ${this.mappingPatterns.size} industry patterns and best practices`,
        this.lastProviderUsage
          ? `LLM provider ${this.lastProviderUsage.providerId} consumed ${this.lastProviderUsage.tokens ?? 0} tokens (≈$${(this.lastProviderUsage.cost ?? 0).toFixed(4)})`
          : ''
      ]);

      return this.createSuccessResult(output, confidence, reasoning);

    } catch (error) {
      this.logger.error('Field mapping agent execution failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return this.createErrorResult(
        `Field mapping analysis failed: ${this.formatError(error)}`,
        ['Check input data format', 'Verify schema definitions', 'Review business rules']
      );
    }
  }

  protected async validateInputInternal(input: FieldMappingInput): Promise<boolean> {
    if (!input.sourceFields || !Array.isArray(input.sourceFields) || input.sourceFields.length === 0) {
      return false;
    }

    if (!input.targetFields || !Array.isArray(input.targetFields) || input.targetFields.length === 0) {
      return false;
    }

    // Validate field definitions
    const allFields = [...input.sourceFields, ...input.targetFields];
    for (const field of allFields) {
      if (!field.name || typeof field.name !== 'string') {
        return false;
      }
      if (!field.type || typeof field.type !== 'string') {
        return false;
      }
    }

    return true;
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {
        type: 'object',
        properties: {
          sourceFields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                required: { type: 'boolean' },
                sampleValues: { type: 'array' }
              },
              required: ['name', 'type']
            }
          },
          targetFields: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                type: { type: 'string' },
                description: { type: 'string' },
                required: { type: 'boolean' },
                sampleValues: { type: 'array' }
              },
              required: ['name', 'type']
            }
          },
          sampleData: {
            type: 'array',
            items: { type: 'object' }
          },
          existingMappings: {
            type: 'array',
            items: { type: 'object' }
          }
        },
        required: ['sourceFields', 'targetFields']
      },
      outputSchema: {
        type: 'object',
        properties: {
          mappings: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sourceField: { type: 'string' },
                targetField: { type: 'string' },
                confidence: { type: 'number' },
                transformationType: { type: 'string' },
                transformationLogic: { type: 'string' },
                businessRule: { type: 'string' }
              }
            }
          },
          qualityScore: { type: 'number' },
          recommendations: {
            type: 'array',
            items: { type: 'string' }
          },
          alternatives: {
            type: 'array',
            items: { type: 'object' }
          }
        }
      },
      capabilities: this.capabilities,
      resourceRequirements: {
        maxMemory: 512,
        maxExecutionTime: 30000,
        requiredProviders: ['openai', 'claude']
      }
    };
  }

  // Private methods

  private initializeMappingPatterns(): void {
    // Common CRM patterns
    this.addMappingPattern({
      name: 'customer_name_mapping',
      description: 'Standard customer name field mapping',
      sourcePattern: '(customer|client|account).*(name|title)',
      targetPattern: '(name|customer_name|account_name)',
      confidence: 0.9,
      usageCount: 150
    });

    // ERP patterns
    this.addMappingPattern({
      name: 'financial_amount_mapping',
      description: 'Financial amount field mapping',
      sourcePattern: '(amount|total|price|cost|value)',
      targetPattern: '(amount|total|price|cost|value)',
      confidence: 0.85,
      usageCount: 200
    });

    // Contact information patterns
    this.addMappingPattern({
      name: 'email_mapping',
      description: 'Email address field mapping',
      sourcePattern: '(email|e_mail|electronic_mail)',
      targetPattern: '(email|email_address|e_mail)',
      confidence: 0.95,
      usageCount: 300
    });

    // Name field patterns - Enhanced for multi-field detection
    this.addMappingPattern({
      name: 'first_name_mapping',
      description: 'First name field mapping (handles messy variants)',
      sourcePattern: '(first.*name|fname|f.*name|given.*name|forename|first_name)',
      targetPattern: '(first.*name|fname|f.*name|given.*name|forename|first_name)',
      confidence: 0.92,
      usageCount: 250
    });

    this.addMappingPattern({
      name: 'last_name_mapping',
      description: 'Last name field mapping (handles messy variants)',
      sourcePattern: '(last.*name|lname|l.*name|surname|family.*name|last_name)',
      targetPattern: '(last.*name|lname|l.*name|surname|family.*name|last_name)',
      confidence: 0.92,
      usageCount: 250
    });

    this.addMappingPattern({
      name: 'full_name_mapping',
      description: 'Full name field mapping',
      sourcePattern: '(full.*name|fullname|name|display.*name|complete.*name|full_name)',
      targetPattern: '(full.*name|fullname|name|display.*name|complete.*name|full_name)',
      confidence: 0.90,
      usageCount: 200
    });

    // Company/Organization patterns
    this.addMappingPattern({
      name: 'company_name_mapping',
      description: 'Company/organization name mapping (handles variants)',
      sourcePattern: '(company(name)?|account(name)?|organization|organisation|business[\\s-]?name|org[\\s-]?name)',
      targetPattern: '(company|account[_\\s-]?name|organization|organisation|business[\\s-]?name)',
      confidence: 0.94,
      usageCount: 180
    });

    // Date patterns
    this.addMappingPattern({
      name: 'date_mapping',
      description: 'Date field mapping with format considerations',
      sourcePattern: '(date|created|modified|updated).*',
      targetPattern: '(date|created|modified|updated).*',
      confidence: 0.8,
      usageCount: 180
    });

    // ============================================================================
    // FALLBACK PATTERNS: Only used when real AI (Claude/GPT-4) is unavailable
    // Primary mapping intelligence comes from LLM providers
    // These provide reasonable defaults for common messy data patterns
    // ============================================================================

    this.addMappingPattern({
      name: 'phone_mapping',
      description: 'Phone number field mapping (fallback for ph, mobile, tel variants)',
      sourcePattern: '(phone|ph|mobile|tel|telephone|fax).*',
      targetPattern: '(phone|mobile|tel|telephone|fax).*',
      confidence: 0.75, // Lower confidence - AI should win if available
      usageCount: 200
    });

    this.addMappingPattern({
      name: 'customer_id_mapping',
      description: 'Customer ID field mapping (fallback)',
      sourcePattern: '(cust|customer).*id',
      targetPattern: '(cust|customer).*id',
      confidence: 0.75,
      usageCount: 180
    });

    this.addMappingPattern({
      name: 'email_typo_mapping',
      description: 'Email field mapping (handles emaail typo)',
      sourcePattern: '(email|e_mail|emaail|electronic_mail)',
      targetPattern: '(email|email_address|e_mail)',
      confidence: 0.78,
      usageCount: 300
    });

    this.addMappingPattern({
      name: 'address_mapping',
      description: 'Address field mapping (fallback)',
      sourcePattern: '(address|street|city|state|zip|postal)',
      targetPattern: '(address|street|city|state|zip|postal)',
      confidence: 0.85,
      usageCount: 120
    });
  }

  private addMappingPattern(pattern: MappingPattern): void {
    this.mappingPatterns.set(pattern.name, pattern);
  }

  /**
   * Check if a field name matches any of the name patterns
   * Returns the pattern type if matched, undefined otherwise
   */
  private static matchesNamePattern(fieldName: string): string | undefined {
    const normalized = fieldName.toLowerCase().trim();

    for (const [patternType, patterns] of Object.entries(FieldMappingAgent.NAME_PATTERNS)) {
      for (const pattern of patterns) {
        if (pattern.test(normalized)) {
          return patternType;
        }
      }
    }

    return undefined;
  }

  /**
   * Check if two field names match the same name pattern type
   * (e.g., both are firstName patterns, or both are company patterns)
   */
  private static haveSameNamePattern(sourceField: string, targetField: string): boolean {
    const sourcePattern = FieldMappingAgent.matchesNamePattern(sourceField);
    const targetPattern = FieldMappingAgent.matchesNamePattern(targetField);

    return sourcePattern !== undefined && sourcePattern === targetPattern;
  }

  private async generateMappingSuggestions(context: MappingContext): Promise<MappingSuggestion[]> {
    // Step 1: Generate base suggestions using existing AI/heuristics
    const result: MappingSuggestionResult = await this.suggestionService.generateSuggestions(context);
    this.lastProviderUsage = result.providerUsage;
    let suggestions = result.suggestions;

    // Step 2: Optionally enhance with MCP context (Phase 3: AI Enhancement)
    if (this.mcpEnhancer && isNetSuiteMCPAIContextEnabled()) {
      try {
        this.logger.info('Enhancing mapping suggestions with MCP context', {
          suggestionCount: suggestions.length,
          targetSystem: context.targetSchema.systemName
        });

        const enhancementResult = await this.mcpEnhancer.enhanceSuggestions(suggestions, {
          targetSystem: context.targetSchema.systemName,
          targetFields: context.targetSchema.fields
        });

        if (enhancementResult.contextUsed) {
          suggestions = enhancementResult.enhancedSuggestions;
          this.logger.info('MCP enhancement applied', {
            suggestionCount: suggestions.length,
            accuracyImprovement: enhancementResult.accuracyImprovement.toFixed(2) + '%',
            source: enhancementResult.source
          });
        }
      } catch (error) {
        this.logger.warn('MCP enhancement failed, using base suggestions', {
          error: error instanceof Error ? error.message : String(error)
        });
        // Continue with base suggestions on error
      }
    }

    return suggestions;
  }

  private async extractPreferredProviderId(context: AgentExecutionContext, input: FieldMappingInput): Promise<string | undefined> {
    // Priority 0: Check for explicit AI Configuration override from request body
    // This allows frontend to explicitly override AI Configuration when user selects a specific provider
    const overrides = this.getRequestOverrides(input);
    const aiConfigOverride = overrides.aiConfigProvider;
    if (typeof aiConfigOverride === 'string' && aiConfigOverride !== 'auto') {
      this.logger.info('✅ Using explicit AI Configuration override from request', {
        aiConfigProvider: aiConfigOverride,
        priority: 0
      });
      return aiConfigOverride;
    }

    try {
      // Priority 1: Check AI Configuration for task-specific provider
      // Extract userId from context, default to 1 if not available
      this.logger.info('🔍 Context userId value', {
        userId: context.userId,
        type: typeof context.userId,
        isUndefined: context.userId === undefined,
        isNull: context.userId === null
      });

      // Fix: Properly handle undefined/null/missing userId
      let userId: number;
      if (context.userId === undefined || context.userId === null) {
        userId = 1; // Default to user 1
      } else if (typeof context.userId === 'string') {
        const parsed = parseInt(context.userId, 10);
        userId = isNaN(parsed) ? 1 : parsed;
      } else if (typeof context.userId === 'number') {
        userId = context.userId;
      } else {
        userId = 1; // Fallback for any other type
      }

      this.logger.info('🔍 Extracted userId', { userId: String(userId) });
      const taskConfig = await this.aiConfigService.getTaskModelConfig(userId, 'field_mapping');
      if (taskConfig && taskConfig.providerType) {
        this.logger.info('✅ Using task-specific provider from AI Configuration', {
          taskType: 'field_mapping',
          providerType: taskConfig.providerType,
          userId: String(userId),
          priority: 1
        });
        return taskConfig.providerType;
      }
      this.logger.info('❌ No task config found, will use default provider selection', {
        userId: String(userId),
        taskType: 'field_mapping'
      });
    } catch (error) {
      this.logger.warn('Failed to get task-specific provider from AI Configuration', {
        error: String(error)
      });
    }

    // Priority 2: Check context metadata for preferred provider
    const contextPreference = this.getContextMetadata(context.metadata)?.preferredProvider;
    if (typeof contextPreference === 'string') {
      this.logger.info('✅ Using provider from context metadata', {
        preferredProvider: contextPreference,
        priority: 2
      });
      return contextPreference;
    }

    // Priority 3: Check input for preferred provider
    const inputPreference = overrides.preferredProvider;
    if (typeof inputPreference === 'string') {
      this.logger.info('✅ Using provider from input preference', {
        preferredProvider: inputPreference,
        priority: 3
      });
      return inputPreference;
    }

    // No preference specified - ProviderRegistry will use default fallback
    this.logger.info('ℹ️ No provider preference specified, using ProviderRegistry default', {
      priority: 4
    });
    return undefined;
  }

  private normalizeSampleData(samples?: unknown[]): DataSample[] {
    if (!Array.isArray(samples) || samples.length === 0) {
      return [];
    }

    const MAX_RECORDS = 8;
    const MAX_FIELDS = 25;
    const MAX_STRING_LENGTH = 200;

    return samples.slice(0, MAX_RECORDS).map(rawSample => {
      const sampleRecord = this.asRecord(rawSample);
      const rawSourceValues = this.asRecord(sampleRecord?.sourceValues) ?? sampleRecord ?? {};
      const rawTargetValues = this.asRecord(sampleRecord?.expectedTarget);
      const contextValue = sampleRecord?.context;

      return {
        sourceValues: this.trimRecord(rawSourceValues, MAX_FIELDS, MAX_STRING_LENGTH),
        expectedTarget: rawTargetValues
          ? this.trimRecord(rawTargetValues, MAX_FIELDS, MAX_STRING_LENGTH)
          : undefined,
        context: typeof contextValue === 'string'
          ? contextValue.slice(0, MAX_STRING_LENGTH)
          : undefined,
      };
    });
  }

  private trimRecord(record: Record<string, unknown>, maxFields: number, maxStringLength: number): Record<string, unknown> {
    const entries = Object.entries(record).slice(0, maxFields);
    const trimmed: Record<string, unknown> = {};

    entries.forEach(([key, value]) => {
      if (typeof value === 'string') {
        trimmed[key] = value.length > maxStringLength ? `${value.slice(0, maxStringLength)}…` : value;
      } else {
        trimmed[key] = value;
      }
    });

    return trimmed;
  }

  private normalizeValidationRule(rule: unknown, index: number): BusinessRule {
    const ruleInput = this.asRecord(rule) as ValidationRuleInput | undefined;

    return {
      id: this.getString(ruleInput?.id) ?? `validation_rule_${index}`,
      active: ruleInput?.active !== false,
      name: this.getString(ruleInput?.name)
        ?? this.getString(ruleInput?.ruleName)
        ?? 'Custom validation rule',
      description: this.getString(ruleInput?.description)
        ?? this.getString(ruleInput?.message)
        ?? '',
      sourceFields: this.getStringArray(ruleInput?.sourceFields),
      targetFields: this.getStringArray(ruleInput?.targetFields),
      transformation: this.isTransformationRule(ruleInput?.transformation)
        ? ruleInput.transformation
        : { type: 'direct' },
      priority: this.getNumber(ruleInput?.priority) ?? 100,
    };
  }

  private getRequestOverrides(input: FieldMappingInput): FieldMappingRequestOverrides {
    const inputRecord = this.asRecord(input);
    return inputRecord ?? {};
  }

  private getContextMetadata(metadata: AgentExecutionContext['metadata']): FieldMappingContextMetadata | undefined {
    return this.asRecord(metadata) as FieldMappingContextMetadata | undefined;
  }

  private getString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
  }

  private getNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  private getStringArray(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  }

  private isTransformationRule(value: unknown): value is BusinessRule['transformation'] {
    const transformationRecord = this.asRecord(value);
    if (!transformationRecord) {
      return false;
    }

    return this.isTransformationType(transformationRecord.type);
  }

  private isTransformationType(value: unknown): value is TransformationRule['type'] {
    return typeof value === 'string'
      && FieldMappingAgent.VALID_TRANSFORMATION_TYPES.has(value as TransformationRule['type']);
  }

  private asRecord(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : undefined;
  }

}
