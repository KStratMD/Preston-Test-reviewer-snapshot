import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { Logger } from '../utils/Logger';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type {
  AIFieldMappingService,
  AIFieldMappingSuggestion,
  NetSuiteSchema,
  SchemaDefinition,
} from '../services/ai/AIFieldMappingService';
import type { FieldMapping } from '../types';
import type { TelemetryService } from '../services/TelemetryService';
import type { AllTelemetryEvents } from '../domain/telemetry/events';
import type { AIConfigurationBridge } from '../services/ai/AIConfigurationBridge';
import { MultiAgentOrchestrator } from '../services/ai/orchestrator/MultiAgentOrchestrator';
import type { AgentExecutionContext } from '../services/ai/orchestrator/interfaces';
import { AccuracyEnhancementService } from '../services/ai/validation/AccuracyEnhancementService';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

const logger = new Logger('AIMapping');
const router = Router();

/**
 * Module-scope structural shapes for field-walker / mapping-walker callbacks.
 * Request bodies arrive as unknown JSON; these capture the minimal property
 * surface we read while iterating, replacing inline (x as any).foo casts.
 */
interface FieldShape {
  name?: string;
  type?: string;
  description?: string;
  required?: boolean;
  isArray?: boolean;
}

interface MappingShape {
  sourceField?: string;
  targetField?: string;
}

/**
 * Type extension for authenticated requests
 * Note: JWT middleware sets id as string (from sub claim)
 */
type RequestWithUser = Request & { user?: { id?: string | number } };

/**
 * Get user ID from authenticated request with fallback for demo mode
 * Handles string IDs from JWT (sub claim) by parsing to number
 * Falls back to 1 for demo/development mode or invalid IDs
 */
const getUserId = (req: Request): number => {
  const request = req as RequestWithUser;
  const rawId = request.user?.id;

  if (rawId === undefined || rawId === null) {
    return 1; // Demo mode fallback
  }

  // Handle numeric IDs directly
  if (typeof rawId === 'number' && Number.isFinite(rawId) && rawId > 0) {
    return Math.floor(rawId);
  }

  // Parse string IDs from JWT
  if (typeof rawId === 'string') {
    const parsed = parseInt(rawId, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  // Invalid ID format - fallback to demo user
  logger.warn('Invalid user ID format, using demo fallback', { rawId: typeof rawId });
  return 1;
};

/**
 * Helper function to build a properly formatted system schema
 * Supports backward compatibility by accepting simple field arrays
 */
function buildSystemSchema(
  systemName: string,
  fields: unknown[]
): {
  systemName: string;
  systemType: string;
  fields: unknown[];
  customFields: NonNullable<NonNullable<SuggestionRequest['targetSchema']>['customFields']>;
  relationships: NonNullable<NonNullable<SuggestionRequest['targetSchema']>['relationships']>;
  recordType: string;
} {
  // Intelligently detect system type based on common system names
  const systemLower = systemName.toLowerCase();
  let systemType = 'OTHER';
  
  if (systemLower.includes('salesforce') || systemLower.includes('hubspot') || 
      systemLower.includes('dynamics') || systemLower.includes('zoho')) {
    systemType = 'CRM';
  } else if (systemLower.includes('netsuite') || systemLower.includes('sap') || 
             systemLower.includes('oracle') || systemLower.includes('quickbooks') ||
             systemLower.includes('business central') || systemLower.includes('erp')) {
    systemType = 'ERP';
  } else if (systemLower.includes('shopify') || systemLower.includes('magento') ||
             systemLower.includes('woocommerce')) {
    systemType = 'ECOMMERCE';
  }
  
  return {
    systemName,
    systemType,
    fields: fields.flatMap((f) => {
      const shape = (f ?? {}) as FieldShape;
      // Drop entries with non-string name or type — downstream
      // matching calls .toLowerCase() on these and would 500 on
      // malformed input.
      if (typeof shape.name !== 'string' || typeof shape.type !== 'string') {
        logger.warn('Skipping schema field with missing or non-string name/type', {
          systemName, name: shape.name, type: shape.type
        });
        return [];
      }
      return [{
        name: shape.name,
        type: shape.type,
        description: typeof shape.description === 'string' ? shape.description : '',
        required: shape.required === true,
        isArray: shape.isArray === true
      }];
    }),
    customFields: [], // Initialize empty array to prevent iteration errors
    relationships: [], // Initialize empty array for schema relationships
    recordType: 'generic' // Default record type
  };
}

interface SuggestionRequest {
  sourceSystem: string;
  targetSystem: string;
  // Legacy format - simple field arrays
  sourceFields?: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
    description?: string;
    required?: boolean;
  }[];
  targetFields?: {
    name: string;
    type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
    description?: string;
    required?: boolean;
  }[];
  // New format - full schema objects
  sourceSchema?: {
    systemName?: string;
    systemType?: string;
    fields: {
      name: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
      description?: string;
      required?: boolean;
    }[];
  };
  targetSchema?: {
    systemName?: string;
    systemType?: string;
    fields: {
      name: string;
      type: 'string' | 'number' | 'boolean' | 'date' | 'email' | 'phone' | 'currency' | 'object';
      description?: string;
      required?: boolean;
    }[];
    recordType?: string;
    customFields?: {
      id: string;
      label: string;
      type: string;
      helpText?: string;
      recordType: string;
    }[];
    relationships?: {
      field: string;
      relatedRecord: string;
      type: 'lookup' | 'parent' | 'child';
    }[];
  };
  // Additional context
  businessRules?: unknown[];
  industryContext?: {
    industry?: string;
    domain?: string;
  };
  existingMappings?: unknown[];
  sampleData?: Record<string, unknown>[];
}

interface FeedbackRequest {
  suggestion: {
    sourceField: string;
    targetField: string;
    confidence: number;
    transformationType: 'direct' | 'calculation' | 'lookup' | 'concatenation';
    explanation: string;
    alternatives?: {
      targetField: string;
      confidence: number;
      transformationType: 'direct' | 'calculation' | 'lookup' | 'concatenation';
      explanation: string;
    }[];
  };
  accepted: boolean;
  alternativeUsed?: string;
}

interface ValidationRequest {
  mappings: {
    sourceField: string;
    targetField: string;
    transformationType: 'split' | 'direct' | 'concatenate' | 'concatenation' | 'lookup' | 'expression' | 'conditional' | 'calculation';
    isRequired?: boolean;
  }[];
  sourceSchema: unknown;
  targetSchema: unknown;
}

/**
 * Check AI configuration status for field mapping
 * Query params:
 *   - forceRefresh: If 'true', clears cache and fetches fresh configuration
 */
router.get('/status', asyncHandler(async (req: Request, res: Response) => {
  try {
    const bridge = await container.getAsync<AIConfigurationBridge>(TYPES.AIConfigurationBridge);
    const userId = getUserId(req);
    const forceRefresh = req.query.forceRefresh === 'true';

    const status = await bridge.getFieldMappingStatus(userId, forceRefresh);

    logger.info('AI configuration status checked', {
      configured: status.configured,
      provider: status.activeProvider?.providerName,
      model: status.fieldMappingTask?.modelVersion,
    });

    res.json(status);
  } catch (error) {
    logger.error('Failed to check AI configuration status', { error });
    res.status(500).json({
      configured: false,
      message: 'Failed to check AI configuration status',
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * Apply AI suggestions with conflict resolution
 */
router.post('/apply-suggestions', asyncHandler(async (req: Request, res: Response) => {
  try {
    const {
      suggestions,
      existingMappings = [],
      strategy = 'merge' // 'merge' | 'replace' | 'skip_conflicts'
    } = req.body;

    if (!suggestions || !Array.isArray(suggestions)) {
      return res.status(400).json({
        error: 'Suggestions array is required',
      });
    }

    // Normalize field names for comparison
    const normalizeFieldName = (name: string): string =>
      name.toLowerCase().replace(/[_\s-]/g, '').trim();

    // Build map of existing mappings. Skip entries with missing/empty
    // sourceField (would collapse onto a shared empty-string key and
    // cause silently-misleading conflict detection) AND entries with
    // missing/empty targetField (would generate conflict reports with
    // existingTarget=undefined). Both are dropped so a new suggestion
    // for that sourceField is treated as a fresh mapping.
    const existingMap = new Map<string, MappingShape>(
      (existingMappings as unknown[]).flatMap((m): [string, MappingShape][] => {
        const shape = (m ?? {}) as MappingShape;
        const src = typeof shape.sourceField === 'string' ? shape.sourceField.trim() : '';
        const tgt = typeof shape.targetField === 'string' ? shape.targetField.trim() : '';
        if (!src || !tgt) {
          // Don't log the raw mapping object — request-body content can leak
          // through. Log only sanitized field-presence flags + key list.
          logger.warn('Skipping malformed existing mapping', {
            sourceFieldPresent: !!src,
            targetFieldPresent: !!tgt,
            mappingKeys: Object.keys(shape as Record<string, unknown>),
          });
          return [];
        }
        return [[normalizeFieldName(src), shape]];
      })
    );

    const applied: unknown[] = [];
    const skipped: unknown[] = [];
    const conflicts: unknown[] = [];

    // Process each suggestion. The route only validated `suggestions` is
    // an array; per-item shapes can still be malformed, so guard
    // sourceField/targetField as strings before normalizeFieldName
    // (which would 500 on .toLowerCase() of non-string).
    for (const suggestion of suggestions) {
      if (
        !suggestion ||
        typeof suggestion !== 'object' ||
        typeof suggestion.sourceField !== 'string' ||
        typeof suggestion.targetField !== 'string'
      ) {
        skipped.push({
          ...(suggestion ?? {}),
          status: 'invalid',
          reason: 'sourceField and targetField must both be strings',
        });
        continue;
      }
      const normalizedSource = normalizeFieldName(suggestion.sourceField);
      const existing = existingMap.get(normalizedSource);

      if (!existing) {
        // No conflict - new mapping
        applied.push({
          ...suggestion,
          status: 'applied',
          reason: 'New mapping'
        });
      } else {
        // Mirror the sourceField guard above: targetField is from a
        // casted request body, so a non-string runtime value would
        // throw inside normalizeFieldName's .toLowerCase().
        const existingTargetField = typeof existing.targetField === 'string'
          ? existing.targetField.trim()
          : '';
        const normalizedExistingTarget = normalizeFieldName(existingTargetField);
        const normalizedSuggestedTarget = normalizeFieldName(suggestion.targetField);

        if (normalizedExistingTarget === normalizedSuggestedTarget) {
          // Same mapping - mark as duplicate
          skipped.push({
            ...suggestion,
            status: 'duplicate',
            reason: 'Mapping already exists'
          });
        } else {
          // Different target field - real conflict
          const conflict = {
            sourceField: suggestion.sourceField,
            existingTarget: existing.targetField,
            suggestedTarget: suggestion.targetField,
            confidence: suggestion.confidence,
          };

          conflicts.push(conflict);

          // Handle based on strategy
          switch (strategy) {
            case 'replace':
              if (suggestion.confidence >= 0.8) {
                applied.push({
                  ...suggestion,
                  status: 'replaced',
                  reason: `Replaced existing mapping (confidence: ${Math.round(suggestion.confidence * 100)}%)`
                });
              } else {
                skipped.push({
                  ...suggestion,
                  status: 'skipped',
                  reason: 'Confidence too low to replace existing mapping'
                });
              }
              break;

            case 'skip_conflicts':
              skipped.push({
                ...suggestion,
                status: 'skipped',
                reason: 'Conflict with existing mapping'
              });
              break;

            case 'merge':
            default:
              // For merge, log conflict but don't apply
              skipped.push({
                ...suggestion,
                status: 'conflict',
                reason: `Conflicts with existing mapping: ${existing.targetField}`
              });
              break;
          }
        }
      }
    }

    logger.info('AI suggestions applied with conflict resolution', {
      totalSuggestions: suggestions.length,
      applied: applied.length,
      skipped: skipped.length,
      conflicts: conflicts.length,
      strategy,
    });

    res.json({
      success: true,
      applied,
      skipped,
      conflicts,
      summary: {
        total: suggestions.length,
        applied: applied.length,
        skipped: skipped.length,
        conflicts: conflicts.length,
      },
    });
  } catch (error) {
    logger.error('Failed to apply AI suggestions', { error });
    res.status(500).json({
      error: 'Failed to apply suggestions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * Generate AI field mapping suggestions
 */
router.post('/suggestions', asyncHandler(async (req: Request, res: Response) => {
  try {
    const requestData = req.body as SuggestionRequest;
    const { 
      sourceSystem,
      targetSystem,
      sourceFields,      // Legacy format
      targetFields,      // Legacy format
      sourceSchema,      // New format
      targetSchema,      // New format
      businessRules = [],
      industryContext,
      existingMappings = [],
      sampleData = []
    } = requestData;

    // Transform to expected format if needed (backward compatibility).
    // When the client supplies sourceSchema/targetSchema directly,
    // fields/customFields/relationships may be missing or non-array.
    // Downstream code iterates these with .find/.length, so reject
    // explicitly-non-array `fields` with 400 up front and default the
    // rest to [] / 'generic'. (buildSystemSchema already supplies
    // [] / [] / 'generic' so the buildSystemSchema-fallback path is a
    // no-op pass-through.)
    const hasValidSchemaFields = (s: Record<string, unknown>) =>
      s.fields === undefined || Array.isArray(s.fields);
    if (sourceSchema && !hasValidSchemaFields(sourceSchema as Record<string, unknown>)) {
      return res.status(400).json({
        success: false,
        error: 'sourceSchema.fields must be an array'
      });
    }
    if (targetSchema && !hasValidSchemaFields(targetSchema as Record<string, unknown>)) {
      return res.status(400).json({
        success: false,
        error: 'targetSchema.fields must be an array'
      });
    }
    const ensureSchemaShape = <T extends Record<string, unknown>>(s: T) => ({
      ...s,
      fields: Array.isArray(s.fields) ? s.fields : [],
      customFields: Array.isArray(s.customFields) ? s.customFields : [],
      relationships: Array.isArray(s.relationships) ? s.relationships : [],
      recordType: typeof s.recordType === 'string' ? s.recordType : 'generic',
    });

    const normalizedSourceSchema = ensureSchemaShape(
      sourceSchema || buildSystemSchema(sourceSystem, sourceFields || [])
    );

    const normalizedTargetSchema = ensureSchemaShape(
      targetSchema || buildSystemSchema(targetSystem, targetFields || [])
    );

    // Validate that we have the necessary data
    if (!normalizedSourceSchema.fields.length || !normalizedTargetSchema.fields.length) {
      return res.status(400).json({
        success: false,
        error: 'Both source and target schemas must have at least one field'
      });
    }

    // Get AI Field Mapping Service
    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);
    const orchestrator = container.get<MultiAgentOrchestrator>(TYPES.MultiAgentOrchestrator);
    const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);

    const suggestionId = `mapping_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

    // The route response widens transformationType to the 6-value union the
    // orchestrator can return. AIFieldMappingSuggestion currently declares
    // only the 4-value subset; widening the public type is a separate change.
    type RouteSuggestion = Omit<AIFieldMappingSuggestion, 'transformationType'> & {
      transformationType: 'direct' | 'lookup' | 'calculation' | 'concatenation' | 'conditional' | 'custom';
    };
    let suggestions: RouteSuggestion[];
    let providerId = 'rule-based';
    let strategy: 'orchestrator' | 'service-fallback' = 'orchestrator';

    try {
      const rawUserId = (req as RequestWithUser).user?.id;
      const agentContext: AgentExecutionContext = {
        sessionId: suggestionId,
        userId: typeof rawUserId === 'number' ? String(rawUserId) : rawUserId,
        sourceSystem: normalizedSourceSchema.systemType,
        targetSystem: normalizedTargetSchema.systemType,
        confidenceThreshold: 0.5,
        maxExecutionTime: 30000,
        enableReasoningTrace: true,
        timestamp: new Date(),
        metadata: {
          businessRules,
          existingMappingsCount: existingMappings.length,
        },
      };

      const agentInput: unknown = {
        sourceFields: normalizedSourceSchema.fields,
        targetFields: normalizedTargetSchema.fields,
        sampleData,
      };

      const agentResult = await orchestrator.executeAgent('field-mapping', agentContext, agentInput);

      if (!agentResult.success) {
        throw new Error(agentResult.errors?.join(', ') || 'Agent execution failed');
      }

      type LooseMapping = {
        providerId?: string;
        sourceField?: string;
        targetField?: string;
        confidence?: number;
        transformationType?: string;
        transformation?: { type?: string };
        reasoning?: string | string[];
        businessRule?: string;
        alternatives?: unknown[];
        businessRules?: unknown[];
        netsuiteSpecific?: unknown;
        confidenceBreakdown?: unknown;
      };
      const mappings = (agentResult.data?.mappings ?? []) as LooseMapping[];
      providerId = mappings.find(mapping => mapping?.providerId)?.providerId || providerId;

      const isResolvedMapping = (
        m: LooseMapping,
      ): m is LooseMapping & { sourceField: string; targetField: string } =>
        typeof m.sourceField === 'string' && typeof m.targetField === 'string';

      // The orchestrator's FieldMappingSuggestion declares 6 transformation
      // types; widen via RouteSuggestion (declared above) so 'conditional'
      // and 'custom' pass through to clients without a type-narrowing cast
      // that would silently coerce them to 'direct'.
      const validTransformationTypes = ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom'] as const;
      type RouteTransformationType = typeof validTransformationTypes[number];
      const coerceTransformation = (value: string | undefined): RouteTransformationType =>
        validTransformationTypes.includes(value as RouteTransformationType) ? (value as RouteTransformationType) : 'direct';

      suggestions = mappings.filter(isResolvedMapping).map(mapping => ({
        sourceField: mapping.sourceField,
        targetField: mapping.targetField,
        confidence: mapping.confidence ?? agentResult.confidence ?? 0.5,
        transformationType: coerceTransformation(mapping.transformationType || mapping.transformation?.type),
        explanation: Array.isArray(mapping.reasoning)
          ? mapping.reasoning.join('; ')
          : (mapping.reasoning || mapping.businessRule || 'Generated by AI orchestrator'),
        alternatives: (mapping.alternatives || []) as AIFieldMappingSuggestion['alternatives'],
        businessRulesSuggested: (mapping.businessRules || []) as AIFieldMappingSuggestion['businessRulesSuggested'],
        netsuiteSpecific: mapping.netsuiteSpecific as AIFieldMappingSuggestion['netsuiteSpecific'],
        confidenceBreakdown: mapping.confidenceBreakdown as AIFieldMappingSuggestion['confidenceBreakdown'],
      }));

      if (!suggestions.length) {
        throw new Error('Agent returned no suggestions');
      }
    } catch (orchestratorError) {
      logger.warn('Orchestrator field mapping generation failed, falling back to service', {
        error: orchestratorError instanceof Error ? orchestratorError.message : orchestratorError,
      });
      strategy = 'service-fallback';

      suggestions = await aiService.suggestFieldMappings(
        normalizedSourceSchema as unknown as SchemaDefinition,
        normalizedTargetSchema as unknown as NetSuiteSchema,
        sampleData,
      );
      providerId = 'rule-based';
    }

    // Record telemetry event
    const telemetryEvent: AllTelemetryEvents = {
      id: `mapping_suggested_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
      timestamp: Date.now(),
      type: 'MappingSuggested',
      flowId: `${normalizedSourceSchema.systemType}_to_${normalizedTargetSchema.systemType}_${Date.now()}`,
      metadata: {
        sourceSystem: normalizedSourceSchema.systemName,
        targetSystem: normalizedTargetSchema.systemName,
        totalSuggestions: suggestions.length,
        highConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.8).length,
        sampleDataSize: sampleData.length,
      },
      sourceField: 'multiple',
      targetField: 'multiple',
      confidence: suggestions.length > 0 ? suggestions.reduce((sum, s) => sum + s.confidence, 0) / suggestions.length : 0,
      transformationType: 'multiple',
    };

    await telemetryService.recordEvent(telemetryEvent);

    logger.info('AI field mapping suggestions generated', {
      sourceSystem: normalizedSourceSchema.systemName,
      targetSystem: normalizedTargetSchema.systemName,
      totalSuggestions: suggestions.length,
      avgConfidence: telemetryEvent.confidence,
    });

    // Format suggestions to include reason field (for frontend compatibility)
    const formattedSuggestions = suggestions.map(s => ({
      ...s,
      reason: s.explanation || `${s.transformationType} mapping with ${(s.confidence * 100).toFixed(0)}% confidence`,
    }));

    res.json({
      success: true,
      suggestions: formattedSuggestions,
      metadata: {
        totalSuggestions: suggestions.length,
        highConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.8).length,
        mediumConfidenceSuggestions: suggestions.filter(s => s.confidence > 0.5 && s.confidence <= 0.8).length,
        lowConfidenceSuggestions: suggestions.filter(s => s.confidence <= 0.5).length,
        averageConfidence: telemetryEvent.confidence,
        generatedAt: new Date().toISOString(),
        providerId,
        strategy,
      },
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.suggestions',
      resourceId: 'new',
    })) return;
    logger.error('Failed to generate AI suggestions', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to generate AI field mapping suggestions',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Record user feedback on AI suggestions
 */
router.post('/feedback', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { suggestion, accepted, alternativeUsed } = req.body as FeedbackRequest;

    // Get services
    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);
    const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);

    // Record feedback with AI service for learning
    await aiService.recordUserFeedback(
      suggestion as unknown as AIFieldMappingSuggestion,
      accepted,
      alternativeUsed,
    );

    // Record telemetry event
    const telemetryEvent: AllTelemetryEvents = accepted
      ? {
          id: `mapping_accepted_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
          timestamp: Date.now(),
          type: 'MappingAccepted',
          flowId: `feedback_${Date.now()}`,
          userId: req.ip || 'unknown', // Use IP as basic user identifier
          sourceField: suggestion.sourceField,
          targetField: alternativeUsed || suggestion.targetField,
          confidence: suggestion.confidence,
          transformationType: suggestion.transformationType,
          metadata: {
            originalTargetField: suggestion.targetField,
            alternativeUsed: alternativeUsed || null,
            originalConfidence: suggestion.confidence,
          },
        }
      : {
          id: `mapping_rejected_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`,
          timestamp: Date.now(),
          type: 'MappingRejected',
          flowId: `feedback_${Date.now()}`,
          userId: req.ip || 'unknown',
          sourceField: suggestion.sourceField,
          suggestedTargetField: suggestion.targetField,
          actualTargetField: alternativeUsed,
          confidence: suggestion.confidence,
          metadata: {
            transformationType: suggestion.transformationType,
            explanation: suggestion.explanation,
          },
        };

    await telemetryService.recordEvent(telemetryEvent);

    logger.info('AI mapping feedback recorded', {
      sourceField: suggestion.sourceField,
      targetField: suggestion.targetField,
      accepted,
      alternativeUsed,
      confidence: suggestion.confidence,
    });

    res.json({
      success: true,
      message: 'Feedback recorded successfully',
      learned: true, // Indicates the AI has learned from this feedback
    });
  } catch (error) {
    logger.error('Failed to record AI mapping feedback', { error });
    res.status(500).json({ 
      error: 'Failed to record feedback',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Validate field mapping quality
 */
router.post('/validate', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { mappings, sourceSchema, targetSchema } = req.body as ValidationRequest;

    // Get AI Field Mapping Service
    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);

    // sourceSchema/targetSchema arrive as untyped JSON; the service
    // iterates `.fields`, `.customFields`, and `.relationships` with
    // `.find(...)` and would 500 if any of these is missing or a
    // non-array. Validate up front: 400 on non-object schema or on a
    // non-array `fields`; default missing arrays to []. Use an
    // `instanceof` sentinel for narrowing (discriminated unions don't
    // narrow reliably under the project's loose tsconfig).
    class InvalidSchemaResult {
      constructor(public readonly message: string) {}
    }
    const normalizeForService = (
      schemaName: 'sourceSchema' | 'targetSchema',
      s: unknown,
    ): Record<string, unknown> | InvalidSchemaResult => {
      if (!s || typeof s !== 'object' || Array.isArray(s)) {
        return new InvalidSchemaResult(`${schemaName} must be an object`);
      }
      const obj = s as Record<string, unknown>;
      if (obj.fields !== undefined && !Array.isArray(obj.fields)) {
        return new InvalidSchemaResult(`${schemaName}.fields must be an array`);
      }
      return {
        ...obj,
        fields: Array.isArray(obj.fields) ? obj.fields : [],
        customFields: Array.isArray(obj.customFields) ? obj.customFields : [],
        relationships: Array.isArray(obj.relationships) ? obj.relationships : [],
      };
    };
    const sourceCheck = normalizeForService('sourceSchema', sourceSchema);
    if (sourceCheck instanceof InvalidSchemaResult) {
      return res.status(400).json({ error: 'Invalid source schema', message: sourceCheck.message });
    }
    const targetCheck = normalizeForService('targetSchema', targetSchema);
    if (targetCheck instanceof InvalidSchemaResult) {
      return res.status(400).json({ error: 'Invalid target schema', message: targetCheck.message });
    }
    const safeSourceSchema = sourceCheck;
    const safeTargetSchema = targetCheck;

    // Validate mapping quality. Cast through unknown for all three: the
    // route DTO widens transformationType to 8 values while FieldMapping
    // uses a narrower union, and sourceSchema/targetSchema arrive as
    // untyped JSON in the request body.
    const qualityReport = await aiService.validateMappingQuality(
      mappings as unknown as FieldMapping[],
      safeSourceSchema as unknown as SchemaDefinition,
      safeTargetSchema as unknown as NetSuiteSchema,
    );

    logger.info('Field mapping quality validated', {
      totalMappings: mappings.length,
      overallScore: qualityReport.overallScore,
      issuesFound: qualityReport.potentialIssues.length,
    });

    res.json(qualityReport);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.validate',
      resourceId: 'new',
    })) return;
    logger.error('Failed to validate field mapping quality', { error });
    res.status(500).json({
      error: 'Failed to validate mapping quality',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Get system schemas for mapping
 */
router.get('/schemas/:systemType', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { systemType } = req.params;
    const { recordType } = req.query;

    // Mock schema data - in production, this would fetch from actual system APIs
    const schemas = {
      SuiteCentral: {
        systemType: 'SuiteCentral',
        recordType: recordType || 'customer',
        fields: [
          { name: 'customer_name', type: 'string', description: 'Customer company name', required: true },
          { name: 'email_address', type: 'email', description: 'Primary email contact', required: true },
          { name: 'phone_number', type: 'phone', description: 'Primary phone number' },
          { name: 'billing_address', type: 'string', description: 'Billing street address' },
          { name: 'billing_city', type: 'string', description: 'Billing city' },
          { name: 'billing_state', type: 'string', description: 'Billing state/province' },
          { name: 'billing_zip', type: 'string', description: 'Billing postal code' },
          { name: 'custom_squire_id', type: 'string', description: 'Squire integration identifier' },
          { name: 'created_date', type: 'date', description: 'Record creation date' },
          { name: 'status', type: 'string', description: 'Customer status' },
        ],
      },
      NetSuite: {
        systemType: 'NetSuite',
        recordType: recordType || 'customer',
        fields: [
          { name: 'companyname', type: 'string', description: 'Company name', required: true },
          { name: 'entityid', type: 'string', description: 'Customer ID', required: true },
          { name: 'email', type: 'email', description: 'Email address' },
          { name: 'phone', type: 'phone', description: 'Phone number' },
          { name: 'billaddr1', type: 'string', description: 'Billing address line 1' },
          { name: 'billcity', type: 'string', description: 'Billing city' },
          { name: 'billstate', type: 'string', description: 'Billing state' },
          { name: 'billzip', type: 'string', description: 'Billing ZIP code' },
          { name: 'datecreated', type: 'date', description: 'Date created' },
          { name: 'entitystatus', type: 'string', description: 'Customer status' },
        ],
        customFields: [
          {
            id: 'custentity_squire_integration_id',
            label: 'Squire Integration ID',
            type: 'string',
            helpText: 'Unique identifier for Squire integration',
            recordType: 'customer',
          },
          {
            id: 'custentity_last_sync_date',
            label: 'Last Sync Date',
            type: 'date',
            helpText: 'Date of last synchronization with Squire',
            recordType: 'customer',
          },
        ],
        relationships: [
          { field: 'subsidiary', relatedRecord: 'subsidiary', type: 'lookup' },
          { field: 'salesrep', relatedRecord: 'employee', type: 'lookup' },
        ],
      },
      Salesforce: {
        systemType: 'Salesforce',
        recordType: recordType || 'Account',
        fields: [
          { name: 'Name', type: 'string', description: 'Account name', required: true },
          { name: 'AccountNumber', type: 'string', description: 'Account number' },
          { name: 'Phone', type: 'phone', description: 'Account phone number' },
          { name: 'Website', type: 'string', description: 'Account website' },
          { name: 'BillingStreet', type: 'string', description: 'Billing street address' },
          { name: 'BillingCity', type: 'string', description: 'Billing city' },
          { name: 'BillingState', type: 'string', description: 'Billing state' },
          { name: 'BillingPostalCode', type: 'string', description: 'Billing postal code' },
          { name: 'CreatedDate', type: 'date', description: 'Created date' },
          { name: 'Type', type: 'string', description: 'Account type' },
        ],
      },
    };

    const schema = schemas[systemType as keyof typeof schemas];
    
    if (!schema) {
      res.status(404).json({ error: `Schema not found for system type: ${systemType}` });
      return;
    }

    res.json(schema);
  } catch (error) {
    logger.error('Failed to get system schema', { error, systemType: req.params.systemType });
    res.status(500).json({ 
      error: 'Failed to retrieve system schema',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Get AI mapping statistics
 */
router.get('/stats', asyncHandler(async (req: Request, res: Response) => {
  try {
    const telemetryService = container.get<TelemetryService>(TYPES.TelemetryService);
    const timeRange = 30 * 24 * 60 * 60 * 1000; // 30 days
    
    const squireMetrics = await telemetryService.getSquireMetrics(timeRange);
    const aiStats = squireMetrics.aiMappingPerformance;

    // Calculate additional stats
    const timeSavedHours = (aiStats.timeReduction / 100) * (aiStats.suggestionsGenerated * 0.5); // 30min per mapping saved
    const accuracyImprovement = Math.max(0, aiStats.accuracyImprovement - 75); // Improvement over manual baseline

    res.json({
      suggestionsGenerated: aiStats.suggestionsGenerated,
      acceptanceRate: aiStats.acceptanceRate,
      accuracyRate: aiStats.accuracyImprovement,
      timeSavedHours,
      accuracyImprovement,
      totalMappingsProcessed: Math.floor(aiStats.suggestionsGenerated * (aiStats.acceptanceRate / 100)),
      recentActivity: {
        last24Hours: Math.floor(Math.random() * 50) + 10,
        last7Days: Math.floor(Math.random() * 200) + 100,
        last30Days: aiStats.suggestionsGenerated,
      },
      performanceMetrics: {
        averageConfidence: 0.875,
        highConfidenceRate: 0.68, // Percentage of suggestions with >80% confidence
        processingTimeMs: aiStats.timeReduction > 0 ? 150 : 300,
      },
    });
  } catch (error) {
    logger.error('Failed to get AI mapping statistics', { error });
    res.status(500).json({ 
      error: 'Failed to retrieve AI mapping statistics',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Get AI mapping templates for quick setup
 */
router.get('/templates', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { sourceSystem, targetSystem } = req.query;
    
    const templates = [
      {
        id: 'suitecentral-netsuite-customers',
        name: 'SuiteCentral to NetSuite Customers',
        description: 'Standard customer field mappings between SuiteCentral and NetSuite',
        sourceSystem: 'SuiteCentral',
        targetSystem: 'NetSuite',
        recordType: 'customer',
        mappings: [
          { sourceField: 'customer_name', targetField: 'companyname', confidence: 0.95, transformationType: 'direct' },
          { sourceField: 'email_address', targetField: 'email', confidence: 0.92, transformationType: 'direct' },
          { sourceField: 'phone_number', targetField: 'phone', confidence: 0.88, transformationType: 'direct' },
          { sourceField: 'custom_squire_id', targetField: 'custentity_squire_integration_id', confidence: 0.85, transformationType: 'direct' },
        ],
        usage: 156,
        successRate: 94.2,
      },
      {
        id: 'salesforce-netsuite-accounts',
        name: 'Salesforce to NetSuite Accounts',
        description: 'Account synchronization between Salesforce and NetSuite',
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
        recordType: 'customer',
        mappings: [
          { sourceField: 'Name', targetField: 'companyname', confidence: 0.98, transformationType: 'direct' },
          { sourceField: 'AccountNumber', targetField: 'entityid', confidence: 0.90, transformationType: 'direct' },
          { sourceField: 'Phone', targetField: 'phone', confidence: 0.87, transformationType: 'direct' },
          { sourceField: 'BillingStreet', targetField: 'billaddr1', confidence: 0.91, transformationType: 'direct' },
          { sourceField: 'BillingCity', targetField: 'billcity', confidence: 0.94, transformationType: 'direct' },
          { sourceField: 'BillingState', targetField: 'billstate', confidence: 0.89, transformationType: 'lookup' },
        ],
        usage: 89,
        successRate: 91.8,
      },
      {
        id: 'dynamics-salesforce-opportunities',
        name: 'Dynamics 365 to Salesforce Opportunities',
        description: 'Sales opportunity pipeline synchronization with stage mapping',
        sourceSystem: 'Dynamics 365',
        targetSystem: 'Salesforce',
        recordType: 'opportunity',
        mappings: [
          { sourceField: 'name', targetField: 'Name', confidence: 0.97, transformationType: 'direct' },
          { sourceField: 'estimatedvalue', targetField: 'Amount', confidence: 0.93, transformationType: 'calculation' },
          { sourceField: 'estimatedclosedate', targetField: 'CloseDate', confidence: 0.95, transformationType: 'direct' },
          { sourceField: 'salesstage', targetField: 'StageName', confidence: 0.88, transformationType: 'lookup' },
          { sourceField: 'description', targetField: 'Description', confidence: 0.85, transformationType: 'direct' },
        ],
        usage: 67,
        successRate: 89.1,
      },
      {
        id: 'netsuite-dynamics-products',
        name: 'NetSuite to Dynamics 365 Product Sync',
        description: 'Product catalog synchronization with inventory and pricing',
        sourceSystem: 'NetSuite',
        targetSystem: 'Dynamics 365',
        recordType: 'product',
        mappings: [
          { sourceField: 'itemid', targetField: 'productnumber', confidence: 0.96, transformationType: 'direct' },
          { sourceField: 'displayname', targetField: 'name', confidence: 0.94, transformationType: 'direct' },
          { sourceField: 'description', targetField: 'description', confidence: 0.90, transformationType: 'direct' },
          { sourceField: 'baseprice', targetField: 'price', confidence: 0.92, transformationType: 'calculation' },
          { sourceField: 'quantityavailable', targetField: 'quantityonhand', confidence: 0.87, transformationType: 'direct' },
        ],
        usage: 43,
        successRate: 86.7,
      },
      {
        id: 'sap-oracle-financials',
        name: 'SAP ERP to Oracle Financials',
        description: 'Financial transaction mapping with currency conversion and GL accounts',
        sourceSystem: 'SAP ERP',
        targetSystem: 'Oracle',
        recordType: 'journal',
        mappings: [
          { sourceField: 'BELNR', targetField: 'voucher_num', confidence: 0.99, transformationType: 'direct' },
          { sourceField: 'GJAHR', targetField: 'period_year', confidence: 0.98, transformationType: 'direct' },
          { sourceField: 'BUDAT', targetField: 'gl_date', confidence: 0.96, transformationType: 'direct' },
          { sourceField: 'WRBTR', targetField: 'entered_dr', confidence: 0.94, transformationType: 'calculation' },
          { sourceField: 'HKONT', targetField: 'code_combination_id', confidence: 0.85, transformationType: 'lookup' },
        ],
        usage: 78,
        successRate: 92.3,
      },
      {
        id: 'business-central-netsuite-items',
        name: 'Business Central to NetSuite Items',
        description: 'Item master synchronization with SKU validation and categorization',
        sourceSystem: 'Business Central',
        targetSystem: 'NetSuite',
        recordType: 'item',
        mappings: [
          { sourceField: 'No', targetField: 'itemid', confidence: 0.98, transformationType: 'direct' },
          { sourceField: 'Description', targetField: 'displayname', confidence: 0.95, transformationType: 'direct' },
          { sourceField: 'BaseUnitofMeasure', targetField: 'unitstype', confidence: 0.89, transformationType: 'lookup' },
          { sourceField: 'UnitPrice', targetField: 'baseprice', confidence: 0.93, transformationType: 'calculation' },
          { sourceField: 'Inventory', targetField: 'quantityavailable', confidence: 0.91, transformationType: 'direct' },
        ],
        usage: 34,
        successRate: 87.9,
      },
      {
        id: 'generic-contact-sync',
        name: 'Generic Contact Synchronization',
        description: 'Universal contact/person mapping template for any system pair',
        sourceSystem: 'Any',
        targetSystem: 'Any',
        recordType: 'contact',
        mappings: [
          { sourceField: 'first_name', targetField: 'firstName', confidence: 0.95, transformationType: 'direct' },
          { sourceField: 'last_name', targetField: 'lastName', confidence: 0.95, transformationType: 'direct' },
          { sourceField: 'email', targetField: 'emailAddress', confidence: 0.97, transformationType: 'direct' },
          { sourceField: 'phone', targetField: 'phoneNumber', confidence: 0.88, transformationType: 'direct' },
          { sourceField: 'company', targetField: 'companyName', confidence: 0.91, transformationType: 'direct' },
        ],
        usage: 234,
        successRate: 93.6,
      },
      {
        id: 'generic-address-mapping',
        name: 'Generic Address Mapping',
        description: 'Universal address mapping template with international support',
        sourceSystem: 'Any',
        targetSystem: 'Any',
        recordType: 'address',
        mappings: [
          { sourceField: 'street_address', targetField: 'addressLine1', confidence: 0.96, transformationType: 'direct' },
          { sourceField: 'city', targetField: 'city', confidence: 0.98, transformationType: 'direct' },
          { sourceField: 'state', targetField: 'stateProvince', confidence: 0.94, transformationType: 'direct' },
          { sourceField: 'postal_code', targetField: 'postalCode', confidence: 0.92, transformationType: 'direct' },
          { sourceField: 'country', targetField: 'country', confidence: 0.89, transformationType: 'lookup' },
        ],
        usage: 189,
        successRate: 90.8,
      },
    ];

    let filteredTemplates = templates;
    
    if (sourceSystem && targetSystem) {
      filteredTemplates = templates.filter(t => 
        t.sourceSystem === sourceSystem && t.targetSystem === targetSystem
      );
    } else if (sourceSystem) {
      filteredTemplates = templates.filter(t => t.sourceSystem === sourceSystem);
    } else if (targetSystem) {
      filteredTemplates = templates.filter(t => t.targetSystem === targetSystem);
    }

    res.json({
      templates: filteredTemplates,
      totalTemplates: filteredTemplates.length,
    });
  } catch (error) {
    logger.error('Failed to get AI mapping templates', { error });
    res.status(500).json({ 
      error: 'Failed to retrieve AI mapping templates',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * Get AI transformation suggestions for a single field mapping
 */
router.post('/transformation/suggest', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { sourceField, targetField, context } = req.body;

    if (!sourceField || !targetField) {
      return res.status(400).json({
        error: 'Both sourceField and targetField are required',
      });
    }

    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);

    // Generate transformation suggestions based on field types and names
    const suggestions = await aiService.suggestTransformations(sourceField, targetField, context);

    logger.info('AI transformation suggestions generated', {
      sourceField: sourceField.name,
      targetField: targetField.name,
      totalSuggestions: suggestions.length,
    });

    res.json({
      success: true,
      suggestions,
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.transformation_suggest',
      resourceId: 'new',
    })) return;
    logger.error('Failed to generate transformation suggestions', { error });
    res.status(500).json({
      error: 'Failed to generate transformation suggestions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * Get AI validation pattern suggestions for a field
 */
router.post('/validation/suggest', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { fieldName, fieldType, targetSystem } = req.body;

    if (!fieldName || !fieldType) {
      return res.status(400).json({
        error: 'fieldName and fieldType are required',
      });
    }

    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);

    // Generate validation pattern suggestions
    const patterns = await aiService.suggestValidationPatterns(fieldName, fieldType, targetSystem);

    logger.info('AI validation pattern suggestions generated', {
      fieldName,
      fieldType,
      totalPatterns: patterns.length,
    });

    res.json({
      success: true,
      patterns,
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.validation_suggest',
      resourceId: 'new',
    })) return;
    logger.error('Failed to generate validation pattern suggestions', { error });
    res.status(500).json({
      error: 'Failed to generate validation pattern suggestions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * Validate transformation logic syntax and semantics
 */
router.post('/transformation/validate', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { logic, sourceType, targetType, availableFields } = req.body;

    if (!logic) {
      return res.status(400).json({
        error: 'Transformation logic is required',
      });
    }

    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);

    // Validate transformation logic
    const validation = await aiService.validateTransformationLogic(
      logic,
      sourceType,
      targetType,
      availableFields || []
    );

    logger.info('Transformation logic validated', {
      valid: validation.valid,
      errors: validation.errors.length,
      warnings: validation.warnings.length,
    });

    res.json(validation);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.transformation_validate',
      resourceId: 'new',
    })) return;
    logger.error('Failed to validate transformation logic', { error });
    res.status(500).json({
      error: 'Failed to validate transformation logic',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * Get AI suggestions for default values
 */
router.post('/defaultvalue/suggest', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { fieldName, fieldType, targetSystem, context } = req.body;

    if (!fieldName || !fieldType) {
      return res.status(400).json({
        error: 'fieldName and fieldType are required',
      });
    }

    const aiService = container.get<AIFieldMappingService>(TYPES.AIFieldMappingService);

    // Generate default value suggestions
    const defaults = await aiService.suggestDefaultValues(fieldName, fieldType, targetSystem, context);

    logger.info('AI default value suggestions generated', {
      fieldName,
      fieldType,
      totalSuggestions: defaults.length,
    });

    res.json({
      success: true,
      suggestions: defaults,
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.defaultvalue_suggest',
      resourceId: 'new',
    })) return;
    logger.error('Failed to generate default value suggestions', { error });
    res.status(500).json({
      error: 'Failed to generate default value suggestions',
      message: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}));

/**
 * POST /api/ai/detect-unmappable-fields
 * Detect source fields that have no suitable equivalent in target system
 */
router.post('/detect-unmappable-fields', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { sourceFields, targetFields, suggestions } = req.body;

    // Enhanced validation and logging
    logger.info('detect-unmappable-fields request received', {
      sourceFieldsCount: Array.isArray(sourceFields) ? sourceFields.length : 'not array',
      targetFieldsCount: Array.isArray(targetFields) ? targetFields.length : 'not array',
      suggestionsCount: Array.isArray(suggestions) ? suggestions.length : 'not array',
      firstSourceField: sourceFields?.[0],
      firstTargetField: targetFields?.[0]
    });

    if (!Array.isArray(sourceFields) || !Array.isArray(targetFields)) {
      return res.status(400).json({
        error: 'sourceFields and targetFields arrays are required'
      });
    }

    // Get accuracy enhancement service from DI container
    const accuracyService = container.get<AccuracyEnhancementService>(TYPES.AccuracyEnhancementService);

    logger.info('AccuracyEnhancementService retrieved from DI container', {
      serviceType: 'AccuracyEnhancementService'
    });

    // Detect unmappable fields with error handling
    let unmappableFields;
    try {
      unmappableFields = await accuracyService.detectUnmappableFields(
        sourceFields,
        targetFields,
        suggestions || [],
        new Map(), // RAG context map (optional)
        req.body.detectionConfig
      );
    } catch (detectionError) {
      logger.error('detectUnmappableFields threw an error', {
        error: detectionError,
        errorMessage: detectionError instanceof Error ? detectionError.message : String(detectionError),
        errorStack: detectionError instanceof Error ? detectionError.stack : undefined
      });
      throw detectionError; // Re-throw to be caught by outer catch
    }

    // Get statistics
    const stats = accuracyService.getSummaryStatistics(unmappableFields);

    logger.info('Unmappable fields detected', {
      unmappableCount: unmappableFields.length,
      highConfidence: stats.highConfidence
    });

    res.json({
      success: true,
      unmappableFields,
      statistics: stats
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.detect_unmappable_fields',
      resourceId: 'new',
    })) return;
    logger.error('Failed to detect unmappable fields', { error });
    res.status(500).json({
      error: 'Failed to detect unmappable fields',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

/**
 * POST /api/ai/generate-custom-field-proposal
 * Generate custom field proposal for an unmappable field
 */
router.post('/generate-custom-field-proposal', asyncHandler(async (req: Request, res: Response) => {
  try {
    const { unmappableField, targetSystem, config } = req.body;

    if (!unmappableField || !targetSystem) {
      return res.status(400).json({
        error: 'unmappableField and targetSystem are required'
      });
    }

    if (!['NetSuite', 'BusinessCentral'].includes(targetSystem)) {
      return res.status(400).json({
        error: 'targetSystem must be either "NetSuite" or "BusinessCentral"'
      });
    }

    // Create custom field proposal service
    const { CustomFieldProposalService } = await import('../services/ai/validation/CustomFieldProposalService');
    const proposalService = new CustomFieldProposalService();

    // Generate proposal
    const proposal = await proposalService.generateProposal(
      unmappableField,
      targetSystem,
      config || {}
    );

    logger.info('Custom field proposal generated', {
      sourceField: unmappableField.sourceField.name,
      targetSystem,
      riskLevel: proposal.riskLevel
    });

    res.json({
      success: true,
      proposal
    });
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'ai_call',
      resourceType: 'ai_mapping.generate_custom_field_proposal',
      resourceId: 'new',
    })) return;
    logger.error('Failed to generate custom field proposal', { error });
    res.status(500).json({
      error: 'Failed to generate custom field proposal',
      message: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}));

export { router as aiMappingRouter };