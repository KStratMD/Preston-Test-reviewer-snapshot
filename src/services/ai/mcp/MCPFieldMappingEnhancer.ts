/**
 * MCP Field Mapping Enhancer - Phase 3: AI Enhancement
 *
 * Simple wrapper service that enhances field mapping accuracy using MCP knowledge.
 * Integrates with existing FieldMappingAgent without breaking changes.
 *
 * Usage in FieldMappingAgent:
 * ```typescript
 * @injectable()
 * class FieldMappingAgent {
 *   constructor(
 *     @optional() @inject(TYPES.MCPFieldMappingEnhancer) private mcpEnhancer?: MCPFieldMappingEnhancer
 *   ) {}
 *
 *   async execute(context, input) {
 *     // Generate base suggestions
 *     const suggestions = await this.generateBaseSuggestions(input);
 *
 *     // Optionally enhance with MCP context (if available and enabled)
 *     if (this.mcpEnhancer && isNetSuiteMCPAIContextEnabled()) {
 *       return await this.mcpEnhancer.enhanceSuggestions(suggestions, input);
 *     }
 *
 *     return suggestions;
 *   }
 * }
 * ```
 */

import type { MCPKnowledgeProvider } from './MCPKnowledgeProvider';
import type { Logger } from '../../../utils/Logger';
import type { MappingSuggestion } from '../orchestrator/agents/fieldMappingTypes';
import { isNetSuiteMCPAIContextEnabled } from '../../../config/runtimeFlags';

/**
 * Enhancement result
 */
export interface EnhancementResult {
  enhancedSuggestions: MappingSuggestion[];
  accuracyImprovement: number; // Estimated improvement in percentage points
  contextUsed: boolean;
  source: 'mcp' | 'fallback' | 'none';
}

/**
 * MCP Field Mapping Enhancer
 *
 * Enhances field mapping suggestions with rich NetSuite context from MCP.
 * Optional service that improves AI accuracy when MCP is available.
 */
export class MCPFieldMappingEnhancer {
  private readonly mcpKnowledge: MCPKnowledgeProvider;
  private readonly logger: Logger;
  private initialized = false;

  constructor(mcpKnowledge: MCPKnowledgeProvider, logger: Logger) {
    this.mcpKnowledge = mcpKnowledge;
    this.logger = logger;
  }

  /**
   * Initialize enhancer
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.mcpKnowledge.initialize();
    this.initialized = true;

    this.logger.info('MCP field mapping enhancer initialized');
  }

  /**
   * Enhance field mapping suggestions with MCP context
   *
   * @param suggestions - Base mapping suggestions
   * @param input - Mapping input with target system and fields
   * @returns Enhanced suggestions with improved confidence scores
   */
  async enhanceSuggestions(
    suggestions: MappingSuggestion[],
    input: { targetSystem?: string; targetFields?: { name: string }[]; entity?: string }
  ): Promise<EnhancementResult> {
    // Check feature flag
    if (!isNetSuiteMCPAIContextEnabled()) {
      this.logger.debug('MCP AI context disabled via feature flag');
      return {
        enhancedSuggestions: suggestions,
        accuracyImprovement: 0,
        contextUsed: false,
        source: 'none'
      };
    }

    // Only enhance NetSuite mappings
    if (!input.targetSystem || input.targetSystem.toLowerCase() !== 'netsuite') {
      this.logger.debug('Target system is not NetSuite, skipping MCP enhancement', {
        targetSystem: input.targetSystem
      });
      return {
        enhancedSuggestions: suggestions,
        accuracyImprovement: 0,
        contextUsed: false,
        source: 'none'
      };
    }

    try {
      this.ensureInitialized();

      const enhanced: MappingSuggestion[] = [];
      let totalConfidenceBoost = 0;
      let successfulEnhancements = 0;

      for (const suggestion of suggestions) {
        try {
          // Get rich field context from MCP
          // Use entity from input, default to 'customer' if not specified
          const entity = input.entity || 'customer';
          const context = await this.mcpKnowledge.getFieldContext(
            entity,
            suggestion.targetField
          );

          successfulEnhancements++;

          // Calculate confidence boost based on context quality
          let confidenceBoost = 0;

          // Boost 1: Field name match with common mappings
          if (context.commonMappings.some(m =>
            m.toLowerCase() === suggestion.sourceField.toLowerCase()
          )) {
            confidenceBoost += 0.05; // +5% for exact common mapping match
          }

          // Boost 2: Strong constraint match (required field mapped correctly)
          if (context.metadata?.required && suggestion.confidence > 0.7) {
            confidenceBoost += 0.02; // +2% for required field match
          }

          // Boost 3: Type compatibility confirmed
          if (context.dataType && suggestion.transformation?.type === 'direct') {
            confidenceBoost += 0.03; // +3% for direct type match
          }

          // Apply confidence boost (cap at 0.99)
          const newConfidence = Math.min(0.99, suggestion.confidence + confidenceBoost);

          // Enhance reasoning with MCP context
          const enhancedReasoning = [...suggestion.reasoning];
          if (confidenceBoost > 0) {
            let mcpContextReason = `MCP Context: ${context.description}`;
            if (context.constraints.length > 0) {
              mcpContextReason += ` (${context.constraints.join(', ')})`;
            }
            enhancedReasoning.push(mcpContextReason);
          }

          enhanced.push({
            ...suggestion,
            confidence: newConfidence,
            reasoning: enhancedReasoning
          });

          totalConfidenceBoost += confidenceBoost;

        } catch (error) {
          // If MCP context fetch fails for this field, keep original suggestion
          this.logger.warn('Failed to enhance suggestion with MCP context', {
            sourceField: suggestion.sourceField,
            targetField: suggestion.targetField,
            error: error instanceof Error ? error.message : String(error)
          });
          enhanced.push(suggestion);
        }
      }

      // If no enhancements succeeded, fall back to original suggestions
      if (successfulEnhancements === 0) {
        this.logger.warn('All MCP enhancement attempts failed, falling back to original suggestions');
        return {
          enhancedSuggestions: suggestions,
          accuracyImprovement: 0,
          contextUsed: false,
          source: 'fallback'
        };
      }

      const avgBoost = suggestions.length > 0 ? totalConfidenceBoost / suggestions.length : 0;
      const estimatedAccuracyImprovement = avgBoost * 100; // Convert to percentage points

      this.logger.info('Field mapping suggestions enhanced with MCP context', {
        suggestionCount: suggestions.length,
        successfulEnhancements,
        avgConfidenceBoost: avgBoost.toFixed(4),
        estimatedAccuracyImprovement: estimatedAccuracyImprovement.toFixed(2) + '%'
      });

      return {
        enhancedSuggestions: enhanced,
        accuracyImprovement: estimatedAccuracyImprovement,
        contextUsed: true,
        source: 'mcp'
      };

    } catch (error) {
      this.logger.error('Failed to enhance suggestions with MCP', {
        error: error instanceof Error ? error.message : String(error)
      });

      // Return original suggestions on error
      return {
        enhancedSuggestions: suggestions,
        accuracyImprovement: 0,
        contextUsed: false,
        source: 'fallback'
      };
    }
  }

  /**
   * Ensure enhancer is initialized
   */
  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('MCP field mapping enhancer not initialized. Call initialize() first.');
    }
  }
}
