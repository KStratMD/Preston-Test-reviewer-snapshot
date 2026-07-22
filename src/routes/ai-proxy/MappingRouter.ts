/**
 * Mapping Router - AI Field Mapping Endpoints
 * Handles field mapping suggestions, transformations, validations, and defaults
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../middleware/asyncHandler';
import type { Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../../services/UnifiedTelemetryService';
import { CostTrackingService } from '../../services/ai/CostTrackingService';
import { GovernanceService, GovernanceResult } from '../../services/ai/orchestrator/GovernanceService';
import type { MultiAgentOrchestrator } from '../../services/ai/orchestrator/MultiAgentOrchestrator';
import { AgentExecutionContext } from '../../services/ai/orchestrator/interfaces';
import { getProviderDisplayName, isProviderDemo } from './utils/provider-utils';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../../services/governance/identityContext';

export interface MappingRouterDependencies {
  logger: Logger;
  telemetry: UnifiedTelemetryService;
  costTracking: CostTrackingService;
  governanceService: GovernanceService;
  orchestrator: MultiAgentOrchestrator;
}

// ---- schemas ----------------------------------------------------------------

/**
 * Field definition shape required by FieldMappingAgent.validateInputInternal —
 * each field must have a name + type. Tightened from `unknown[]` after Copilot
 * review on PR #668: the agent fails closed (success=false) on malformed input
 * and the Zod 400 path is the right place to reject it instead.
 */
const FieldDefinitionSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
}).passthrough();

/**
 * POST /mapping/suggestions request body.
 *
 * sampleData has no fixed shape (passed through opaquely to the agent).
 */
const SuggestionsBodySchema = z.object({
  sourceSystem: z.string().min(1),
  targetSystem: z.string().min(1),
  sourceFields: z.array(FieldDefinitionSchema).min(1),
  targetFields: z.array(FieldDefinitionSchema).min(1),
  sampleData: z.unknown().optional(),
  industry: z.string().optional(),
  businessProcess: z.string().optional(),
  preferredProvider: z.string().optional(),
  datasetId: z.string().optional(),
});

const TransformationSuggestBodySchema = z.object({
  sourceField: z.object({ name: z.string().min(1) }).passthrough(),
  targetField: z.object({ name: z.string().min(1) }).passthrough(),
  context: z.object({ sampleData: z.unknown().optional() }).passthrough().optional(),
  preferredProvider: z.string().optional(),
  datasetId: z.string().optional(),
});

const ValidationSuggestBodySchema = z.object({
  fieldName: z.string().min(1),
  fieldType: z.string().min(1),
  targetSystem: z.string().optional(),
  preferredProvider: z.string().optional(),
  datasetId: z.string().optional(),
});

const DefaultValueSuggestBodySchema = z.object({
  fieldName: z.string().min(1),
  fieldType: z.string().min(1),
  targetSystem: z.string().optional(),
  context: z.unknown().optional(),
  preferredProvider: z.string().optional(),
});

const TransformationValidateBodySchema = z.object({
  logic: z.string().min(1),
  sourceType: z.string().optional(),
  targetType: z.string().optional(),
  availableFields: z.array(z.unknown()).optional(),
  preferredProvider: z.string().optional(),
});

const SuggestionAcceptParamsSchema = z.object({
  suggestionId: z.string().min(1),
});

// ---- runtime mapping shape --------------------------------------------------

/**
 * Runtime shape of the mapping objects returned by the field-mapping agent.
 *
 * The orchestrator's `EnhancedFieldMapping` interface (in interfaces.ts) and
 * the agent-internal `MappingSuggestion` interface (in fieldMappingTypes.ts)
 * both contribute fields here at runtime — the agent emits a hybrid object.
 * This interface is router-scoped (defined here rather than in a shared
 * types module) but exported for reuse and testing; it captures the union
 * of fields this router actually reads, replacing the previous
 * `(mapping as any).field` access pattern.
 */
export interface AgentMapping {
  sourceField?: string;
  targetField?: string;
  confidence?: number;
  reasoning?: string | string[];
  businessRule?: string;
  transformationType?: string;
  transformationLogic?: string;
  transformation?: { type?: string; logic?: string };
  providerId?: string;
}

/**
 * Suggestion shape returned to the client for one agent mapping. `reason` is
 * the pre-existing human-readable string (byte-compatible fallback chain);
 * `reasoning` is the additive structured contract consumed by later PRs'
 * frontend restyle. Its contract: a non-empty array of strings when the
 * agent supplied reasoning, or `undefined` otherwise. An empty array
 * (`[]`) or empty string (`''`) input is treated as "no reasoning
 * supplied" and normalized to `undefined` — never surfaced as `[]`.
 */
export interface AgentMappingSuggestion {
  id: string;
  sourceField?: string;
  targetField?: string;
  confidence?: number;
  reason: string;
  transformationType: string;
  transformationLogic?: string;
  reasoning?: string[];
}

/**
 * Pure projection from one agent-produced mapping to the API's suggestion
 * shape. Exported for focused unit testing (tests/unit/ai/routes/MappingRouter.suggestions.test.ts) —
 * kept side-effect-free so those tests don't need to spin up the route/orchestrator.
 */
export function projectAgentMappingSuggestion(
  mapping: AgentMapping,
  suggestionId: string,
  index: number
): AgentMappingSuggestion {
  // Structured reasoning contract: non-empty array of strings, or undefined.
  // Empty array / empty string inputs are treated as "no reasoning supplied".
  const reasoningList = Array.isArray(mapping.reasoning)
    ? mapping.reasoning.map(String)
    : mapping.reasoning !== undefined && mapping.reasoning !== null && String(mapping.reasoning) !== ''
      ? [String(mapping.reasoning)]
      : undefined;

  return {
    id: `${suggestionId}_${index}`, // Unique ID for each suggestion (fixes Alpine x-for warnings)
    sourceField: mapping.sourceField,
    targetField: mapping.targetField,
    confidence: mapping.confidence,
    // NOTE: `reason`'s fallback chain is intentionally untouched, including
    // its byte-compatible quirk where `reasoning: []` produces `''`
    // (`[].join('. ') === ''`) rather than falling through to businessRule.
    reason: Array.isArray(mapping.reasoning)
      ? mapping.reasoning.join('. ')
      : (mapping.reasoning || mapping.businessRule || `Mapped via ${mapping.transformationType || mapping.transformation?.type || 'direct'} transformation`),
    transformationType: mapping.transformationType || mapping.transformation?.type || 'direct',
    transformationLogic: mapping.transformationLogic || mapping.transformation?.logic,
    reasoning: reasoningList && reasoningList.length > 0 ? reasoningList : undefined
  };
}

export async function createMappingRouter(deps: MappingRouterDependencies): Promise<Router> {
  const router = Router();
  const { logger, telemetry, costTracking, governanceService, orchestrator } = deps;
  const getExecutionTimeout = (providerId?: string): number => {
    if (providerId === 'lmstudio') {
      const envTimeout = process.env.LMSTUDIO_TIMEOUT;
      const parsedTimeout = envTimeout !== undefined ? Number(envTimeout) : 120000;
      return Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120000;
    }
    return 30000;
  };

  /**
   * POST /api/ai/mapping/suggestions - Generate field mapping suggestions
   */
  router.post('/mapping/suggestions', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const suggestionId = `suggestion_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    // C5: identity from verified sources (req.auth / req.user / req.tenantContext).
    // Anonymous callers fall back to SYSTEM_IDENTITY.userId.
    const { userId } = extractIdentityContext(req);

    const parsed = SuggestionsBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await telemetry.recordErrorOccurred(
        'ai-proxy',
        'VALIDATION_ERROR',
        `Validation failed for /mapping/suggestions: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`
      );

      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        issues: parsed.error.issues
      });
    }

    const {
      sourceSystem,
      targetSystem,
      sourceFields,
      targetFields,
      sampleData,
      industry,
      businessProcess,
      preferredProvider,
      datasetId
    } = parsed.data;

    try {
      // Governance pre-check
      try {
        const preCheckContext: AgentExecutionContext = {
          sessionId: suggestionId,
          userId,
          sourceSystem,
          targetSystem,
          timestamp: new Date(),
          metadata: { route: 'mapping/suggestions' }
        };
        const preCheck = await governanceService.validateInput(parsed.data, preCheckContext);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          logger.warn('Governance blocked mapping suggestions', { suggestionId, reason: preCheck.reason, flags: preCheck.flags });
          return res.status(400).json({
            success: false,
            error: { type: 'governance_violation', ruleId, message: preCheck.reason || 'Blocked by governance policy' },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: { suggestionId, timestamp: new Date().toISOString() }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (mapping/suggestions)', { suggestionId, error: String(gerr) });
      }
      // Wrap main flow in an inner try so we can record telemetry on internal failures
      try {
        // Record telemetry: AI suggestion requested
        await telemetry.recordAISuggestionRequested(
          preferredProvider || 'auto',
          `${sourceSystem} → ${targetSystem}`,
          userId
        );

        // Execute field mapping agent through orchestrator (Week 5 architecture)
        const agentContext: AgentExecutionContext = {
          sessionId: suggestionId,
          userId,
          sourceSystem,
          targetSystem,
          industry,
          businessProcess,
          confidenceThreshold: 0.5, // Default confidence threshold
          maxExecutionTime: getExecutionTimeout(preferredProvider),
          enableReasoningTrace: true,
          timestamp: new Date(),
          metadata: {
            requestId: suggestionId,
            preferredProvider,
            datasetId
          }
        };

        // FieldMappingInput interface expects only fields and sample data
        const agentInput = {
          sourceFields,
          targetFields,
          sampleData
        };

        logger.info('Executing FieldMappingAgent via orchestrator', {
          sessionId: suggestionId,
          sourceSystem,
          targetSystem
        });

        // Execute the field-mapping agent
        logger.info('Executing field-mapping agent', {
          agentContext,
          agentInput: {
            sourceFieldCount: agentInput.sourceFields.length,
            targetFieldCount: agentInput.targetFields.length,
            hasSampleData: !!agentInput.sampleData
          }
        });

        const agentResult = await orchestrator.executeAgent('field-mapping', agentContext, agentInput);

        logger.info('Agent execution result', {
          success: agentResult.success,
          confidence: agentResult.confidence,
          errorCount: agentResult.errors?.length || 0,
          errors: agentResult.errors,
          dataKeys: agentResult.data ? Object.keys(agentResult.data) : []
        });

        if (!agentResult.success) {
          const errorMsg = agentResult.errors?.join(', ') || 'Agent execution failed';
          logger.error('Agent execution failed with errors', {
            errors: agentResult.errors,
            warnings: agentResult.warnings,
            reasoning: agentResult.reasoning
          });
          throw new Error(errorMsg);
        }

        // Extract mappings from agent result (FieldMappingOutput has 'mappings' not 'suggestions')
        // Convert EnhancedFieldMapping to AISuggestion format.
        // `let` rather than `const` so the C3 output-redaction hand-off
        // below can substitute the sanitized form when
        // `governanceResult.redactedData` is populated.
        const mappings: AgentMapping[] = (agentResult.data?.mappings as AgentMapping[] | undefined) || [];
        let suggestions = mappings.map((mapping, index) => projectAgentMappingSuggestion(mapping, suggestionId, index));

        // FIX: Extract ACTUAL provider used (not requested provider)
        // Agent may fall back to mock/rule-based providers OR pure heuristics if LLM unavailable
        const hasAnyLLMProvider = mappings.some(m => Boolean(m.providerId));
        const actualProviderId = mappings.find(m => Boolean(m.providerId))?.providerId;

        // Fallback extraction: agent may include the actual provider in reasoning text
        let providerFromReasoning: string | undefined;
        if (!hasAnyLLMProvider && Array.isArray(agentResult.reasoning)) {
          const line = agentResult.reasoning.find(r => /LLM provider\s+([a-zA-Z0-9_-]+)/i.test(String(r)));
          if (line) {
            const match = /LLM provider\s+([a-zA-Z0-9_-]+)/i.exec(String(line));
            if (match && match[1]) {
              providerFromReasoning = match[1].toLowerCase();
            }
          }
        }

        // Determine provider attribution with graceful fallbacks
        const providerId = hasAnyLLMProvider
          ? (actualProviderId || preferredProvider || 'rule-based')
          : (providerFromReasoning || 'rule-based');

        const duration = Date.now() - startTime;
        const avgConfidence = agentResult.confidence ||
          (suggestions.length > 0 ? suggestions.reduce((sum: number, s: { confidence?: number }) => sum + (s.confidence ?? 0), 0) / suggestions.length : 0);

        // Get cost and token usage from cost service (agent should have recorded it)
        let tokensUsed: number | undefined;
        let estimatedCost: number;
        try {
          // Try to get cost from the session (agent execution should have recorded it)
          estimatedCost = await costTracking.getSessionCost(suggestionId);

          // If no cost recorded yet, use heuristic
          if (!estimatedCost || estimatedCost === 0) {
            tokensUsed = suggestions.length * 60; // heuristic ~60 tokens per suggestion
            estimatedCost = tokensUsed * 0.00003 * 1.5;
          } else {
            // Get token usage from cost service
            const tokenUsage = await costTracking.getTokenUsage(suggestionId);
            tokensUsed = Object.values(tokenUsage.byProvider).reduce((sum, val) => sum + val, 0);
          }
        } catch (err) {
          // Legacy fallback based on latency duration
          tokensUsed = suggestions.length * 60;
          estimatedCost = duration > 5000 ? 0.02 : 0.01;
        }

        // Record cost best-effort
        try {
          await costTracking.recordCost({
            sessionId: suggestionId,
            providerId,
            requestId: suggestionId,
            tokensUsed: tokensUsed || 0,
            cost: estimatedCost,
            operation: 'mapping',
            sourceSystem,
            targetSystem,
            userId,
            // C5: read from the verified tenantContext bridge — populated by
            // tenantIsolation middleware from one of three verified sources
            // (Bearer-JWT claim, configured resolveTenant callback, or
            // trustedTenants fast-path), and NEVER from an unverified
            // x-tenant-id header in production thanks to the
            // `disableHeaderExtraction: true` invariant frozen by the
            // audit-tenant-isolation-invariant CI gate. Unauthenticated
            // callers get undefined.
            organizationId: req.tenantContext?.organizationId,
            responseTime: duration,
            // tenantId from verified tenantContext bridge (same source as organizationId above)
            tenantId: req.tenantContext?.tenantId ?? SYSTEM_IDENTITY.tenantId,
            // cost was computed via heuristic (token count × rate), not a provider usage block
            costSource: 'estimated',
          });
        } catch (cerr) {
          logger.warn('Failed to record AI cost (non-fatal)', { error: String(cerr), providerId });
        }

        // Governance post-check on output (non-blocking; enrich response)
        let governanceResult: GovernanceResult | undefined;
        try {
          const outputContext: AgentExecutionContext = {
            sessionId: suggestionId,
            userId,
            // C3 (Copilot R7): include the verified-source tenantId so
            // `GovernanceService.validateOutput()` resolves the tenant's
            // posture instead of short-circuiting to DEFAULT_POSTURE. Without
            // this, tenant opt-outs (e.g. governance.auto_redact='false') and
            // audit-only opt-ins (governance.allow_pii='true') would never
            // apply on this route. `req.tenantContext.tenantId` is populated
            // only from verified sources (Bearer JWT, configured
            // `resolveTenant`, or `trustedTenants` fast-path) thanks to the
            // `disableHeaderExtraction: true` invariant frozen by the
            // `audit-tenant-isolation-invariant` CI gate; the header path
            // cannot reach this field in production.
            tenantId: req.tenantContext?.tenantId,
            timestamp: new Date(),
            sourceSystem,
            targetSystem,
            metadata: { route: 'mapping/suggestions', phase: 'output' }
          };
          governanceResult = await governanceService.validateOutput(suggestions, outputContext);
          // C3 (Codex R1): when validateOutput populates redactedData on the
          // approval path — tenant posture has `autoRedact:true` and PII
          // was detected in the suggestion payload — substitute the
          // sanitized form into the response. Without this, the new
          // `output_pii_auto_redacted` flag would lie: the response would
          // still contain the original PII while the flag claimed it had
          // been redacted.
          if (
            governanceResult.approved !== false
            && governanceResult.redactedData !== undefined
          ) {
            suggestions = governanceResult.redactedData as typeof suggestions;
          }
        } catch (gerr) {
          logger.warn('Governance output validation error', { error: String(gerr), suggestionId });
        }

        // Record telemetry: AI suggestion responded (with refined cost)
        await telemetry.recordAISuggestionResponded(
          providerId,
          duration,
          estimatedCost,
          suggestionId,
          avgConfidence
        );

        // Log telemetry
        logger.info('AI mapping suggestions generated', {
          providerId,
          sourceSystem,
          targetSystem,
          suggestionsCount: suggestions.length,
          duration,
          avgConfidence,
          estimatedCost,
          tokensUsed,
          suggestionId,
          userId,
          governanceFlags: governanceResult?.flags
        });

        const isDemoProvider = isProviderDemo(providerId);
        const isLiveAI = !isDemoProvider;

        // Extract fallback reason from agent warnings or errors if available
        let fallbackReason: string | undefined;
        if (isDemoProvider && (preferredProvider && preferredProvider !== 'rule-based')) {
          // Preferred provider was specified but we fell back to rule-based
          if (agentResult.warnings && agentResult.warnings.length > 0) {
            fallbackReason = agentResult.warnings.join('; ');
          } else if (agentResult.errors && agentResult.errors.length > 0) {
            // Check if there were non-fatal errors that caused fallback
            fallbackReason = 'AI provider unavailable, using rule-based suggestions';
          } else {
            fallbackReason = `Requested provider '${preferredProvider}' unavailable, using rule-based suggestions`;
          }
        }

        res.json({
          success: true,
          suggestions,
          providerId,                                    // Provider ID (e.g., 'openai', 'mock-openai')
          providerName: getProviderDisplayName(providerId),  // UI-friendly name (e.g., 'OpenAI GPT-4o')
          isDemo: isDemoProvider,                       // True for mock/rule-based providers
          isLiveAI,                                     // True when real AI provider succeeded
          ...(fallbackReason && { fallbackReason }),    // Only include if fallback occurred
          cost: { estimatedCost, tokensUsed },
          governance: governanceResult ? {
            approved: governanceResult.approved !== false,
            flags: governanceResult.flags || [],
            riskLevel: governanceResult.riskLevel
          } : undefined,
          metadata: {
            providerId,
            providerName: 'field-mapping-agent',
            agentVersion: '1.0.0',
            confidence: avgConfidence,
            duration,
            suggestionsCount: suggestions.length,
            avgConfidence,
            suggestionId,
            timestamp: new Date().toISOString()
          }
        });
      } catch (err) {
        const duration = Date.now() - startTime;

        // Record internal error telemetry and a failed responded event for cost/accounting
        await telemetry.recordErrorOccurred(
          'ai-proxy',
          'SUGGESTION_GENERATION_FAILED',
          String(err)
        );

        await telemetry.recordAISuggestionResponded(
          preferredProvider || 'unknown',
          duration,
          0, // No cost for failed requests
          suggestionId,
          0 // No accuracy for failed requests
        );

        // Rethrow so outer catch (existing in file) handles the HTTP response logging/return
        throw err;
      }
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.mapping_suggestions',
        resourceId: 'new',
      })) return;
      logger.error('AI mapping suggestions failed', {
        error: error,
        sourceSystem,
        targetSystem
      });

      res.status(500).json({
        success: false,
        error: 'Failed to generate mapping suggestions',
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * POST /api/ai/proxy/mapping/transformation/suggest - AI transformation suggestions
   * Phase 2: Real AI integration for Advanced Field Mapping Editor
   */
  router.post('/mapping/transformation/suggest', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `transform_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    // C5: identity from verified sources only.
    const { userId } = extractIdentityContext(req);

    const parsed = TransformationSuggestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        issues: parsed.error.issues
      });
    }

    const { sourceField, targetField, context, preferredProvider, datasetId } = parsed.data;

    try {
      // Execute field mapping agent with transformation context
      const agentContext: AgentExecutionContext = {
        sessionId,
        userId,
        sourceSystem: 'transformation-editor',
        targetSystem: 'transformation-editor',
        timestamp: new Date(),
        confidenceThreshold: 0.5,
        maxExecutionTime: getExecutionTimeout(preferredProvider),
        metadata: { requestId: sessionId, preferredProvider, context, datasetId }
      };

      // Pass field definitions (name + type) so FieldMappingAgent.validateInputInternal accepts them.
      const agentInput = {
        sourceFields: [{ name: sourceField.name, type: 'string' }],
        targetFields: [{ name: targetField.name, type: 'string' }],
        sampleData: context?.sampleData || {}
      };

      const agentResult = await orchestrator.executeAgent('field-mapping', agentContext, agentInput);

      if (!agentResult.success) {
        logger.error('Transformation suggestion agent failed', {
          sessionId,
          errors: agentResult.errors,
        });
        return res.status(500).json({
          success: false,
          error: agentResult.errors?.join(', ') || 'Failed to generate transformation suggestions',
        });
      }

      const mappings: AgentMapping[] = (agentResult.data?.mappings as AgentMapping[] | undefined) || [];
      const suggestions = mappings.map(m => ({
        type: m.transformationType || 'direct',
        logic: m.transformationLogic || '',
        explanation: Array.isArray(m.reasoning) ? m.reasoning.join('. ') : m.reasoning,
        confidence: m.confidence || 0.75
      }));

      const providerId = mappings.find(m => Boolean(m.providerId))?.providerId || preferredProvider || 'rule-based';
      const duration = Date.now() - startTime;

      res.json({
        success: true,
        suggestions,
        providerId,
        providerName: getProviderDisplayName(providerId),
        isDemo: isProviderDemo(providerId),
        metadata: { sessionId, duration, timestamp: new Date().toISOString() }
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.transformation_suggest',
        resourceId: 'new',
      })) return;
      logger.error('Transformation suggestions failed', { error: String(error) });
      res.status(500).json({ success: false, error: 'Failed to generate transformation suggestions' });
    }
  }));

  /**
   * POST /api/ai/proxy/mapping/validation/suggest - AI validation pattern suggestions
   * Phase 2: Real AI integration for Advanced Field Mapping Editor
   */
  router.post('/mapping/validation/suggest', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `validation_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

    const parsed = ValidationSuggestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        issues: parsed.error.issues
      });
    }

    const { fieldType, preferredProvider } = parsed.data;

    try {
      // Validation patterns are deterministic from fieldType. The agent call
      // was previously made only to surface an opportunistic providerId, but
      // preferredProvider already provides the same fallback. Skipping the
      // agent call avoids running it with a malformed input shape (Copilot
      // review on PR #668).
      const patterns = [
        { regex: fieldType === 'email' ? '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$' : '.*', description: `${fieldType} validation pattern`, confidence: 0.9 },
        { regex: fieldType === 'phone' ? '^\\+?[1-9]\\d{1,14}$' : '.*', description: `Alternative ${fieldType} pattern`, confidence: 0.8 }
      ];

      const providerId = preferredProvider || 'rule-based';
      const duration = Date.now() - startTime;

      res.json({
        success: true,
        patterns,
        providerId,
        providerName: getProviderDisplayName(providerId),
        isDemo: isProviderDemo(providerId),
        metadata: { sessionId, duration, timestamp: new Date().toISOString() }
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.validation_suggest',
        resourceId: 'new',
      })) return;
      logger.error('Validation pattern suggestions failed', { error: String(error) });
      res.status(500).json({ success: false, error: 'Failed to generate validation patterns' });
    }
  }));

  /**
   * POST /api/ai/proxy/mapping/defaultvalue/suggest - AI default value suggestions
   * Phase 2: Real AI integration for Advanced Field Mapping Editor
   */
  router.post('/mapping/defaultvalue/suggest', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `default_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

    const parsed = DefaultValueSuggestBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        issues: parsed.error.issues
      });
    }

    const { fieldType, preferredProvider } = parsed.data;

    try {
      // Generate default value suggestions
      const suggestions = [
        { value: fieldType === 'string' ? '""' : (fieldType === 'number' ? '0' : 'null'), description: `Standard default for ${fieldType}`, confidence: 0.85 },
        { value: fieldType === 'boolean' ? 'false' : (fieldType === 'date' ? 'new Date()' : '""'), description: `Alternative default for ${fieldType}`, confidence: 0.75 }
      ];

      const providerId = preferredProvider || 'rule-based';
      const duration = Date.now() - startTime;

      res.json({
        success: true,
        suggestions,
        providerId,
        providerName: getProviderDisplayName(providerId),
        isDemo: isProviderDemo(providerId),
        metadata: { sessionId, duration, timestamp: new Date().toISOString() }
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.defaultvalue_suggest',
        resourceId: 'new',
      })) return;
      logger.error('Default value suggestions failed', { error: String(error) });
      res.status(500).json({ success: false, error: 'Failed to generate default value suggestions' });
    }
  }));

  /**
   * POST /api/ai/proxy/mapping/transformation/validate - AI transformation validation
   * Phase 2: Real AI integration for Advanced Field Mapping Editor
   */
  router.post('/mapping/transformation/validate', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `validate_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;

    const parsed = TransformationValidateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Validation failed',
        issues: parsed.error.issues
      });
    }

    const { logic, sourceType, targetType, preferredProvider } = parsed.data;

    try {
      // Simple validation logic (can be enhanced with real AI analysis)
      const errors: string[] = [];
      const warnings: string[] = [];
      const suggestions: string[] = [];

      // Basic syntax validation
      if (logic.includes('${') && !logic.includes('}')) {
        errors.push('Unclosed variable substitution ${...}');
      }

      // Check for common issues
      if (logic.length > 500) {
        warnings.push('Transformation logic is very long - consider breaking into smaller steps');
      }

      if (sourceType && targetType && sourceType !== targetType && !logic.includes('convert')) {
        suggestions.push(`Consider adding type conversion from ${sourceType} to ${targetType}`);
      }

      const valid = errors.length === 0;
      const providerId = preferredProvider || 'rule-based';
      const duration = Date.now() - startTime;

      res.json({
        success: true,
        valid,
        errors,
        warnings,
        suggestions,
        providerId,
        providerName: getProviderDisplayName(providerId),
        isDemo: isProviderDemo(providerId),
        metadata: { sessionId, duration, timestamp: new Date().toISOString() }
      });
    } catch (error) {
      if (await handleApprovalQueueError(error, req, res, {
        operationType: 'ai_call',
        resourceType: 'ai_proxy.transformation_validate',
        resourceId: 'new',
      })) return;
      logger.error('Transformation validation failed', { error: String(error) });
      res.status(500).json({ success: false, error: 'Failed to validate transformation' });
    }
  }));

  /**
   * POST /api/ai/suggestions/:suggestionId/accept - Accept an AI suggestion
   */
  router.post('/suggestions/:suggestionId/accept', asyncHandler(async (req: Request, res: Response) => {
    const paramsParsed = SuggestionAcceptParamsSchema.safeParse(req.params);
    if (!paramsParsed.success) {
      return res.status(400).json({
        success: false,
        error: 'Invalid suggestionId'
      });
    }
    const { suggestionId } = paramsParsed.data;
    // C5: identity from verified sources only.
    const { userId } = extractIdentityContext(req);

    try {
      // Record telemetry: AI suggestion accepted
      await telemetry.recordAISuggestionAccepted(suggestionId, userId);

      logger.info('AI suggestion accepted', { suggestionId, userId });

      res.json({
        success: true,
        message: 'Suggestion accepted',
        suggestionId,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      await telemetry.recordErrorOccurred(
        'ai-proxy',
        'SUGGESTION_ACCEPT_FAILED',
        String(error)
      );

      logger.error('Failed to accept AI suggestion', {
        error: String(error),
        suggestionId,
        userId
      });

      res.status(500).json({
        success: false,
        error: 'Failed to accept suggestion',
        suggestionId
      });
    }
  }));

  return router;
}
