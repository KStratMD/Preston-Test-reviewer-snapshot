/**
 * Claude Provider Implementation - Week 9 Real AI Integration
 * Anthropic Claude integration for premium tier routing
 * Phase 1 Accuracy Improvements: Optimized prompts + few-shot learning
 */

import { logger, type Logger } from '../../../utils/Logger';
import type {
  AIProvider,
  ProviderCapabilities,
  AISuggestion,
  AIQualityReport,
  AIProviderMode,
  ChatMessage,
  ChatResponse
} from './types';
import {
  buildOptimizedFieldMappingPrompt,
  buildOptimizedQualityPrompt,
  type FieldMetadata
} from '../prompts/FieldMappingPrompts';
import {
  buildClaudeHeaders,
  normalizeClaudeBaseUrl,
} from '../utils/claude';
import type { ClaudeAuthMode } from '../utils/claude';
import { getAllFieldNames, getRecordValues } from '../utils/dataRecord';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';
import { isProviderGovernanceError } from '../../governance/OutboundGovernanceErrors';
import { tableCostUSD } from '../../cost/modelPricing';

export interface ClaudeConfig {
  apiKey: string;
  // Allow dynamic model strings for future Anthropic releases
  model: string; // previously: 'claude-3-5-sonnet-20241022'
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  authMode?: ClaudeAuthMode;
  timeout?: number; // Request timeout in ms (default: 30000)
}

export type { ClaudeAuthMode } from '../utils/claude';

export interface ClaudeResponse {
  id: string;
  type: string;
  role: string;
  content: {
    type: string;
    text: string;
  }[];
  model: string;
  stop_reason: string;
  stop_sequence: string | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export interface TokenUsageInfo {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export class ClaudeProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'cloud-api';
  public readonly name = 'Claude';
  public readonly version = '2.0.0';

  private lastTokenUsage?: TokenUsageInfo;
  private isHealthy = false;

  public get isAvailable(): boolean {
    return !!this.config.apiKey && this.isHealthy;
  }

  constructor(
    logger: Logger,
    private config: ClaudeConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    // Set defaults
    const mergedConfig: ClaudeConfig = {
      baseURL: 'https://api.anthropic.com/v1',
      maxTokens: 1000,
      temperature: 0.3,
      authMode: 'auto',
      ...config
    };

    this.config = {
      ...mergedConfig,
      baseURL: normalizeClaudeBaseUrl(mergedConfig.baseURL),
    };
  }

  setModel(model: string) {
    this.config.model = model;
    this.logger.info('Claude model switched at runtime', { model });
  }

  getModel(): string {
    return this.config.model;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `Claude ${this.config.model}`,
      version: this.version,
      features: [
        'Advanced reasoning and analysis',
        'Complex business logic understanding',
        'High-quality confidence scoring',
        'Sophisticated transformation suggestions',
        'Multi-step problem solving',
        'Premium accuracy for complex mappings'
      ],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom']
    };
  }

  // Dynamic capability introspection (heuristic - no extra API round trip for now)
  async introspectCapabilities(modelId: string): Promise<unknown> {
    const m = modelId.toLowerCase();
    const reasoning = /opus|sonnet|haiku/.test(m); // all Claude 3.x families support reasoning to varying depths
    const vision = /opus|sonnet/.test(m); // assume higher tiers have vision/multimodal
    const jsonMode = true;
    const toolUse = true; // tool use / function calling supported in Claude 3.5
    const streaming = true;
    let contextWindow = 200000; // public docs cite large windows; heuristic baseline
    if (m.includes('haiku')) contextWindow = 200000;
    if (m.includes('opus')) contextWindow = 300000; // assume larger
    return {
      contextWindow,
      supports: { reasoning, vision, jsonMode, toolUse, streaming }
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Test with a simple completion to verify API key and model access
      const testPrompt = 'Respond with "OK" to confirm connectivity.';
      const response = await this.callClaude(testPrompt, { maxTokens: 10, temperature: 0.1 });

      if (response.content && response.content.length > 0) {
        this.isHealthy = true;
        this.logger.info('Claude connection test successful', {
          model: this.config.model,
          tokensUsed: response.usage?.input_tokens + response.usage?.output_tokens
        });
        return {
          ok: true,
          message: `Claude ${this.config.model} connection successful`
        };
      } else {
        this.isHealthy = false;
        return {
          ok: false,
          message: 'Claude API returned empty response'
        };
      }
    } catch (error) {
      this.isHealthy = false;
      this.logger.error('Claude connection test failed', {
        model: this.config.model,
        error: String(error)
      });
      return {
        ok: false,
        message: `Claude connection failed: ${error.message}`
      };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    try {
      const startTime = Date.now();

      if (!sampleData || sampleData.length === 0) {
        this.logger.warn('No sample data provided for Claude field mapping suggestions');
        return [];
      }

      const sourceFields = this.extractFields(sampleData);
      const prompt = this.buildFieldMappingPrompt(sourceSystem, targetSystem, sourceFields, sampleData);

      const response = await this.callClaude(prompt, {
        maxTokens: this.config.maxTokens || 2000,
        temperature: this.config.temperature || 0.1
      }, ctx);

      const suggestions = this.parseFieldMappingSuggestions(response, sourceFields);

      const executionTime = Date.now() - startTime;
      this.logger.info('Claude field mapping completed', {
        model: this.config.model,
        sourceFields: sourceFields.length,
        suggestions: suggestions.length,
        executionTime,
        tokens: response.usage?.input_tokens + response.usage?.output_tokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return suggestions;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('Claude field mapping failed', {
        model: this.config.model,
        error: error.message,
        sourceSystem,
        targetSystem
      });
      throw new Error(`Claude field mapping failed: ${error.message}`, { cause: error });
    }
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    try {
      const startTime = Date.now();

      const prompt = this.buildQualityAssessmentPrompt(suggestions);
      const response = await this.callClaude(prompt, {
        maxTokens: this.config.maxTokens || 1500,
        temperature: this.config.temperature || 0.1
      }, ctx);

      const qualityReport = this.parseQualityAssessment(response, suggestions);

      const executionTime = Date.now() - startTime;
      this.logger.info('Claude quality assessment completed', {
        model: this.config.model,
        suggestions: suggestions.length,
        overallScore: qualityReport.overallScore,
        executionTime,
        tokens: response.usage?.input_tokens + response.usage?.output_tokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return qualityReport;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('Claude quality assessment failed', {
        model: this.config.model,
        error: error.message
      });

      // Fallback to basic scoring
      return {
        overallScore: 0.8,
        totalMappings: suggestions.length
      };
    }
  }

  /**
   * Generic chat completion for conversational tasks
   */
  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }, ctx?: IdentityContext): Promise<ChatResponse> {
    try {
      const startTime = Date.now();

      // Separate system messages from user/assistant messages
      const systemMessages = messages.filter(m => m.role === 'system');
      const conversationMessages = messages.filter(m => m.role !== 'system');

      // Claude uses a separate 'system' parameter, not in messages array
      const systemPrompt = systemMessages.length > 0
        ? systemMessages.map(m => m.content).join('\n\n')
        : undefined;

      // Convert to Claude message format
      const claudeMessages = conversationMessages.map(msg => ({
        role: msg.role === 'assistant' ? 'assistant' : 'user',
        content: msg.content
      }));

      const headers = this.buildHeaders();

      const body: {
        model: string;
        max_tokens: number;
        temperature: number;
        messages: typeof claudeMessages;
        system?: string;
      } = {
        model: this.config.model,
        max_tokens: options?.maxTokens || this.config.maxTokens || 1000,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        messages: claudeMessages
      };

      // Add system prompt if present
      if (systemPrompt) {
        body.system = systemPrompt;
      }

      const timeoutMs = this.config.timeout ?? 30000;
      
      const identity = ctx ?? SYSTEM_IDENTITY;
      const outboundCtx: OutboundContext = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        destination: 'ai_provider',
        destinationDetail: `claude.${this.config.model}`,
        operationType: 'execute'
      };

      const response = await this.sendRequest(
        `${this.config.baseURL}/messages`,
        body,
        {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(timeoutMs)
        },
        outboundCtx
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`Claude API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
      }

      const result = await response.json() as ClaudeResponse;

      if (!result || !result.content || result.content.length === 0) {
        throw new Error('Invalid response from Claude API');
      }

      // Track token usage and cost via the shared estimator (see estimateUsageCostUSD).
      if (result.usage) {
        this.lastTokenUsage = {
          inputTokens: result.usage.input_tokens,
          outputTokens: result.usage.output_tokens,
          totalTokens: result.usage.input_tokens + result.usage.output_tokens,
          estimatedCost: this.estimateUsageCostUSD(result.usage.input_tokens, result.usage.output_tokens)
        };
      }

      const executionTime = Date.now() - startTime;
      this.logger.info('Claude chat completion completed', {
        model: this.config.model,
        messages: messages.length,
        executionTime,
        tokens: this.lastTokenUsage?.totalTokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return {
        content: result.content[0].text,
        usage: result.usage ? {
          promptTokens: result.usage.input_tokens,
          completionTokens: result.usage.output_tokens,
          totalTokens: result.usage.input_tokens + result.usage.output_tokens
        } : undefined
      };

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('Claude chat completion failed', {
        model: this.config.model,
        error: error.message
      });
      throw new Error(`Claude chat failed: ${error.message}`, { cause: error });
    }
  }

  // Backward compatibility methods
  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> {
    const ctx = (context ?? {}) as { sourceSystem?: string; targetSystem?: string; sampleData?: unknown[] };
    return this.suggest(ctx.sourceSystem || 'unknown', ctx.targetSystem || 'unknown', ctx.sampleData || []);
  }

  async analyzeDataQuality(data: unknown[], context: unknown): Promise<unknown> {
    // Simple quality analysis for backward compatibility
    return {
      overallScore: 0.85,
      issues: [],
      recommendations: ['Advanced data quality analysis available through assessQuality method']
    };
  }

  getCostEstimate(inputText: string): { tokens: number; cost: number } {
    const tokens = this.estimateTokens(inputText);
    const costPerToken = this.getCostPerToken();
    return {
      tokens,
      cost: tokens * costPerToken
    };
  }

  getLastTokenUsage(): TokenUsageInfo | undefined {
    return this.lastTokenUsage;
  }

  /**
   * Estimate spend for one call. Uses the canonical input/output rate table
   * (accurate per-model output:input ratio) and falls back to the flat
   * per-token heuristic only for models with no published rate. Shared by
   * every cost site so the request paths cannot diverge — divergence between
   * them was a real cost-understatement bug.
   */
  private estimateUsageCostUSD(inputTokens: number, outputTokens: number): number {
    const accurate = tableCostUSD(this.config.model, inputTokens, outputTokens);
    if (accurate !== null) return accurate;
    const perToken = this.getCostPerToken();
    return inputTokens * perToken + outputTokens * perToken * 3;
  }

  private getCostPerToken(): number {
    // Heuristic pricing: treat 'haiku' as cheaper, 'sonnet' mid, 'opus' premium
    const m = this.config.model.toLowerCase();
    if (m.includes('haiku-4-5')) return 0.000001;
    if (m.includes('haiku')) return 0.0000015;
    if (m.includes('opus-4-8')) return 0.000005;
    if (m.includes('opus')) return 0.000006; // assume ~2x sonnet
    return 0.000003; // default sonnet tier
  }

  private extractFields(sampleData: unknown[]): string[] {
    return getAllFieldNames(sampleData);
  }

  private buildFieldMappingPrompt(sourceSystem: string, targetSystem: string, sourceFields: string[], sampleData: unknown[]): string {
    // Extract enhanced metadata from sample data
    const fieldMetadata: FieldMetadata[] = sourceFields.map(fieldName => {
      const allValues = getRecordValues(sampleData, fieldName);
      return {
        name: fieldName,
        type: allValues.length > 0 ? this.inferType(allValues[0]) : 'unknown',
        sampleValues: allValues.slice(0, 3)
      };
    });

    // Use optimized prompt with few-shot learning
    return buildOptimizedFieldMappingPrompt(sourceSystem, targetSystem, fieldMetadata, sampleData);
  }

  private buildQualityAssessmentPrompt(suggestions: AISuggestion[]): string {
    // Use optimized quality assessment prompt
    // Note: We don't have sourceSystem/targetSystem in this context, using generic
    return buildOptimizedQualityPrompt(suggestions, 'source', 'target');
  }

  private async callClaude(prompt: string, options: { maxTokens: number; temperature: number }, ctx?: IdentityContext): Promise<ClaudeResponse> {
    const headers = this.buildHeaders();

    const body = {
      model: this.config.model,
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      system: 'You are Claude, Anthropic\'s advanced AI assistant specializing in complex business system integration and sophisticated data mapping analysis. Provide intelligent, well-reasoned suggestions in the requested JSON format.',
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ]
    };

    const timeoutMs = this.config.timeout ?? 30000;
    
    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `claude.${this.config.model}`,
      operationType: 'execute'
    };

    const response = await this.sendRequest(
      `${this.config.baseURL}/messages`,
      body,
      {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(timeoutMs)
      },
      outboundCtx
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Claude API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const result = await response.json() as ClaudeResponse;

    if (!result || !result.content) {
      throw new Error('Invalid response from Claude API');
    }

    // Track token usage and cost via the shared estimator (see estimateUsageCostUSD).
    if (result.usage) {
      this.lastTokenUsage = {
        inputTokens: result.usage.input_tokens,
        outputTokens: result.usage.output_tokens,
        totalTokens: result.usage.input_tokens + result.usage.output_tokens,
        estimatedCost: this.estimateUsageCostUSD(result.usage.input_tokens, result.usage.output_tokens)
      };
    }

    return result;
  }

  private parseFieldMappingSuggestions(response: ClaudeResponse, sourceFields: string[]): AISuggestion[] {
    try {
      const content = response.content?.[0]?.text;
      if (!content) return [];

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      const suggestions = parsed.suggestions || [];

      type RawSuggestion = {
        sourceField?: string;
        targetField?: string;
        transformationType?: AISuggestion['transformationType'];
        confidence?: number;
        reasoning?: string;
      };

      return (suggestions as RawSuggestion[])
        .filter(s => {
          // Phase 2: Filter by confidence threshold (≥70%)
          const meetsConfidence = s.confidence == null || s.confidence >= 70;
          return s.sourceField && s.targetField && sourceFields.includes(s.sourceField) && meetsConfidence;
        })
        .map(s => ({
          sourceField: s.sourceField as string,
          targetField: s.targetField as string,
          transformationType: s.transformationType || 'direct',
          confidence: s.confidence ?? undefined,
          reasoning: s.reasoning || undefined
        }));
    } catch (error) {
      this.logger.warn('Failed to parse Claude field mapping response', { error: error.message });
      return [];
    }
  }

  private parseQualityAssessment(response: ClaudeResponse, suggestions: AISuggestion[]): AIQualityReport {
    try {
      const content = response.content?.[0]?.text;
      if (!content) throw new Error('Empty response content');

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        overallScore: Math.min(Math.max(parsed.overallScore || 0.8, 0), 1),
        totalMappings: suggestions.length
      };
    } catch (error) {
      this.logger.warn('Failed to parse Claude quality assessment', { error: error.message });
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    // Claude estimation: roughly 1 token ≈ 3.5 characters for English text
    return Math.ceil(text.length / 3.5);
  }

  private buildHeaders(): Record<string, string> {
    return buildClaudeHeaders(this.config.apiKey, {
      baseURL: this.config.baseURL,
      authMode: this.config.authMode,
    });
  }

  private inferType(value: unknown): string {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'string') {
      // Check for special formats
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
      if (/^[\w-\.]+@[\w-\.]+\.\w+$/.test(value)) return 'email';
      if (/^\+?[\d\s\-\(\)]+$/.test(value)) return 'phone';
      return 'string';
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? 'integer' : 'decimal';
    }
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'unknown';
  }
}
