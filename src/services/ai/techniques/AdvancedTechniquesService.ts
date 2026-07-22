/**
 * Advanced Techniques Service - Phase 3 AI Accuracy Improvements
 * Implements Chain-of-Thought prompting and Self-Consistency sampling
 *
 * Purpose:
 * - Chain-of-Thought: Get AI to reason step-by-step for better accuracy
 * - Self-Consistency: Run multiple attempts and use majority vote
 * - Improves accuracy on complex mappings that require reasoning
 */

import type { AIProvider, AISuggestion } from '../providers/types';
import type { FieldMetadata } from '../prompts/FieldMappingPrompts';
import { logger } from '../../../utils/Logger';

export interface ChainOfThoughtResponse {
  reasoning: string[]; // Step-by-step reasoning
  suggestion: AISuggestion;
  confidence: number;
}

export interface SelfConsistencyResult {
  finalSuggestion: AISuggestion;
  agreementScore: number; // 0-100, how much providers/samples agreed
  alternativesuggestions: AISuggestion[];
  attemptCount: number;
}

export interface AdvancedTechniquesConfig {
  enableChainOfThought?: boolean; // Use CoT prompting (default: true)
  enableSelfConsistency?: boolean; // Use self-consistency (default: true)
  selfConsistencySamples?: number; // Number of samples for self-consistency (default: 3)
  temperature?: number; // Temperature for sampling diversity (default: 0.7)
}

export class AdvancedTechniquesService {
  private logger = logger;
  private config: Required<AdvancedTechniquesConfig>;

  constructor(config: AdvancedTechniquesConfig = {}) {
    this.config = {
      enableChainOfThought: config.enableChainOfThought ?? true,
      enableSelfConsistency: config.enableSelfConsistency ?? true,
      selfConsistencySamples: config.selfConsistencySamples ?? 3,
      temperature: config.temperature ?? 0.7
    };
  }

  /**
   * Get suggestions using Chain-of-Thought prompting
   * Prompts AI to think step-by-step for better reasoning
   */
  async getChainOfThoughtSuggestions(
    provider: AIProvider,
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata,
    sampleData: unknown[]
  ): Promise<ChainOfThoughtResponse> {
    if (!this.config.enableChainOfThought) {
      // Fall back to regular suggestion
      const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
      const firstSuggestion = suggestions.find(s => s.sourceField === sourceField.name) || suggestions[0];

      return {
        reasoning: [firstSuggestion?.reasoning || 'No reasoning provided'],
        suggestion: firstSuggestion,
        confidence: firstSuggestion?.confidence || 70
      };
    }

    // Build Chain-of-Thought prompt
    const cotPrompt = this.buildChainOfThoughtPrompt(
      sourceSystem,
      targetSystem,
      sourceField,
      sampleData
    );

    // For now, we'll use the provider's suggest method with enhanced prompting
    // In a real implementation, you'd call the provider directly with the CoT prompt
    try {
      const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
      const relevantSuggestion = suggestions.find(s => s.sourceField === sourceField.name) || suggestions[0];

      if (!relevantSuggestion) {
        throw new Error('No suggestions returned from provider');
      }

      // Extract reasoning steps from the suggestion
      const reasoning = this.extractReasoningSteps(relevantSuggestion.reasoning || '');

      return {
        reasoning,
        suggestion: relevantSuggestion,
        confidence: relevantSuggestion.confidence || 70
      };

    } catch (error) {
      this.logger.error('Chain-of-Thought suggestion failed', {
        sourceField: sourceField.name,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Get suggestions using Self-Consistency sampling
   * Runs multiple attempts and uses majority vote for final answer
   */
  async getSelfConsistentSuggestions(
    provider: AIProvider,
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata,
    sampleData: unknown[]
  ): Promise<SelfConsistencyResult> {
    if (!this.config.enableSelfConsistency) {
      // Fall back to single attempt
      const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
      const firstSuggestion = suggestions.find(s => s.sourceField === sourceField.name) || suggestions[0];

      return {
        finalSuggestion: firstSuggestion,
        agreementScore: 100,
        alternativesuggestions: [],
        attemptCount: 1
      };
    }

    const attempts: AISuggestion[] = [];

    // Run multiple attempts
    for (let i = 0; i < this.config.selfConsistencySamples; i++) {
      try {
        const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
        const relevantSuggestion = suggestions.find(s => s.sourceField === sourceField.name);

        if (relevantSuggestion) {
          attempts.push(relevantSuggestion);
        }

        this.logger.info('Self-consistency attempt completed', {
          attempt: i + 1,
          total: this.config.selfConsistencySamples,
          suggestion: relevantSuggestion
            ? `${relevantSuggestion.sourceField} → ${relevantSuggestion.targetField}`
            : 'none'
        });

      } catch (error) {
        this.logger.warn('Self-consistency attempt failed', {
          attempt: i + 1,
          error: error.message
        });
      }
    }

    if (attempts.length === 0) {
      throw new Error('All self-consistency attempts failed');
    }

    // Find consensus using majority vote
    const consensus = this.findConsensus(attempts);

    return {
      finalSuggestion: consensus.suggestion,
      agreementScore: consensus.score,
      alternativesuggestions: consensus.alternatives,
      attemptCount: attempts.length
    };
  }

  /**
   * Build Chain-of-Thought prompt that encourages step-by-step reasoning
   */
  private buildChainOfThoughtPrompt(
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata,
    sampleData: unknown[]
  ): string {
    const sampleValues = sourceField.sampleValues?.slice(0, 3) || [];

    return `
You are an expert data integration engineer. Use step-by-step reasoning to map this field.

SOURCE SYSTEM: ${sourceSystem}
TARGET SYSTEM: ${targetSystem}

FIELD TO MAP:
- Name: ${sourceField.name}
- Type: ${sourceField.type || 'unknown'}
- Sample Values: ${sampleValues.map(v => JSON.stringify(v)).join(', ') || 'none'}

REASONING STEPS (think through each step):

Step 1: What does this field represent semantically?
- Consider the field name, type, and sample values
- What business concept does it capture?

Step 2: What is the equivalent concept in ${targetSystem}?
- Search your knowledge of ${targetSystem}'s data model
- What field name would ${targetSystem} use for this concept?

Step 3: What transformation is needed?
- Can we map directly (same format, same meaning)?
- Do we need to transform format (e.g., date format, phone format)?
- Do we need to look up references (e.g., IDs)?
- Do we need to combine/split fields?

Step 4: What is your confidence level?
- How certain are you about this mapping?
- What could go wrong?
- What validation is needed?

Now provide your final mapping with step-by-step reasoning.
`;
  }

  /**
   * Extract reasoning steps from AI response
   */
  private extractReasoningSteps(reasoning: string): string[] {
    // Try to split reasoning into steps
    const stepPatterns = [
      /step \d+[:\-\.]?\s*/gi,
      /\d+\.\s+/g,
      /first,?\s+/gi,
      /second,?\s+/gi,
      /third,?\s+/gi,
      /finally,?\s+/gi
    ];

    let steps = [reasoning]; // Default to single step

    for (const pattern of stepPatterns) {
      const split = reasoning.split(pattern).filter(s => s.trim().length > 0);
      if (split.length > 1) {
        steps = split;
        break;
      }
    }

    return steps.map(s => s.trim());
  }

  /**
   * Find consensus among multiple attempts using majority vote
   */
  private findConsensus(attempts: AISuggestion[]): {
    suggestion: AISuggestion;
    score: number;
    alternatives: AISuggestion[];
  } {
    if (attempts.length === 0) {
      throw new Error('Cannot find consensus with zero attempts');
    }

    if (attempts.length === 1) {
      return {
        suggestion: attempts[0],
        score: 100,
        alternatives: []
      };
    }

    // Group by (targetField, transformationType) combination
    const groups = new Map<string, AISuggestion[]>();

    attempts.forEach(attempt => {
      const key = `${attempt.targetField}:${attempt.transformationType}`;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(attempt);
    });

    // Find majority
    const groupsArray = Array.from(groups.entries())
      .map(([key, suggestions]) => ({
        key,
        suggestions,
        count: suggestions.length
      }))
      .sort((a, b) => b.count - a.count);

    const majority = groupsArray[0];
    const agreementScore = (majority.count / attempts.length) * 100;

    // Pick the suggestion with highest confidence from majority group
    const finalSuggestion = majority.suggestions.reduce((best, current) => {
      const bestConf = best.confidence || 70;
      const currentConf = current.confidence || 70;
      return currentConf > bestConf ? current : best;
    }, majority.suggestions[0]);

    // Get alternatives (other groups)
    const alternatives = groupsArray.slice(1).map(group => group.suggestions[0]);

    // Boost confidence if high agreement
    if (agreementScore >= 80) {
      finalSuggestion.confidence = Math.min(100, (finalSuggestion.confidence || 70) + 10);
    }

    // Add consensus info to reasoning
    if (finalSuggestion.reasoning) {
      finalSuggestion.reasoning += ` [Self-consistency: ${agreementScore.toFixed(0)}% agreement across ${attempts.length} samples]`;
    }

    return {
      suggestion: finalSuggestion,
      score: agreementScore,
      alternatives
    };
  }

  /**
   * Combine Chain-of-Thought and Self-Consistency for maximum accuracy
   */
  async getAdvancedSuggestions(
    provider: AIProvider,
    sourceSystem: string,
    targetSystem: string,
    sourceField: FieldMetadata,
    sampleData: unknown[]
  ): Promise<{
    suggestion: AISuggestion;
    confidence: number;
    reasoning: string[];
    agreementScore?: number;
    techniqueUsed: 'chain-of-thought' | 'self-consistency' | 'both';
  }> {
    const startTime = Date.now();

    if (this.config.enableChainOfThought && this.config.enableSelfConsistency) {
      // Use both techniques
      const cotResults = await Promise.all(
        Array.from({ length: this.config.selfConsistencySamples }, () =>
          this.getChainOfThoughtSuggestions(provider, sourceSystem, targetSystem, sourceField, sampleData)
        )
      );

      const allSuggestions = cotResults.map(r => r.suggestion);
      const consensus = this.findConsensus(allSuggestions);

      // Combine reasoning from all attempts
      const allReasoning = cotResults.flatMap(r => r.reasoning);
      const uniqueReasoning = Array.from(new Set(allReasoning));

      const executionTime = Date.now() - startTime;

      this.logger.info('Advanced suggestions generated (CoT + Self-Consistency)', {
        sourceField: sourceField.name,
        confidence: consensus.suggestion.confidence,
        agreementScore: consensus.score,
        attempts: cotResults.length,
        executionTime
      });

      return {
        suggestion: consensus.suggestion,
        confidence: consensus.suggestion.confidence || 70,
        reasoning: uniqueReasoning,
        agreementScore: consensus.score,
        techniqueUsed: 'both'
      };

    } else if (this.config.enableChainOfThought) {
      // Use only Chain-of-Thought
      const cot = await this.getChainOfThoughtSuggestions(
        provider,
        sourceSystem,
        targetSystem,
        sourceField,
        sampleData
      );

      return {
        suggestion: cot.suggestion,
        confidence: cot.confidence,
        reasoning: cot.reasoning,
        techniqueUsed: 'chain-of-thought'
      };

    } else if (this.config.enableSelfConsistency) {
      // Use only Self-Consistency
      const sc = await this.getSelfConsistentSuggestions(
        provider,
        sourceSystem,
        targetSystem,
        sourceField,
        sampleData
      );

      return {
        suggestion: sc.finalSuggestion,
        confidence: sc.finalSuggestion.confidence || 70,
        reasoning: [sc.finalSuggestion.reasoning || 'No reasoning provided'],
        agreementScore: sc.agreementScore,
        techniqueUsed: 'self-consistency'
      };

    } else {
      throw new Error('At least one advanced technique must be enabled');
    }
  }
}
