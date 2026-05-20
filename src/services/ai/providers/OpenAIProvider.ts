/**
 * OpenAI Provider Implementation - Week 9 Real AI Integration
 * Enhanced with GPT-4o/GPT-4o-mini support and cost tracking
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
  extractFieldMetadata,
  type FieldMetadata
} from '../prompts/FieldMappingPrompts';
import { parseJsonFromText } from '../../../utils/json';
import { getAllFieldNames, getRecordValues } from '../utils/dataRecord';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';
import { isProviderGovernanceError } from '../../governance/OutboundGovernanceErrors';

export interface OpenAIConfig {
  apiKey: string;
  // Allow any model string so we can dynamically adopt new releases without code changes
  model: string; // previously: 'gpt-4o' | 'gpt-4o-mini'
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  organization?: string;
}

export interface OpenAIResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }[];
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export class OpenAIProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'cloud-api';
  public readonly name = 'OpenAI';
  public readonly version = '2.0.0';

  private lastTokenUsage?: TokenUsageInfo;
  private isHealthy = false;

  public get isAvailable(): boolean {
    return !!this.config.apiKey && this.isHealthy;
  }

  constructor(
    logger: Logger,
    private config: OpenAIConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    // Set defaults
    this.config = {
      baseURL: 'https://api.openai.com/v1',
      maxTokens: 1000,
      temperature: 0.3,
      ...config
    };
  }

  setModel(model: string) {
    // Provide a lightweight normalization so legacy configs still work
    if (model === 'gpt-4') {
      this.config.model = 'gpt-4o';
    } else {
      this.config.model = model;
    }
    this.logger.info('OpenAI model switched at runtime', { model: this.config.model });
  }

  getModel(): string {
    return this.config.model;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `OpenAI ${this.config.model}`,
      version: this.version,
      features: [
        'Advanced semantic field analysis',
        'Real-time confidence scoring',
        'Complex transformation suggestions',
        'Business rule understanding',
        'Multi-language support',
        'Cost optimization'
      ],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom']
    };
  }

  // Dynamic capability introspection: best-effort query to derive model feature flags.
  // Falls back to heuristic mapping based on name substrings; kept lightweight to avoid extra token cost.
  async introspectCapabilities(modelId: string): Promise<unknown> {
    const m = modelId.toLowerCase();
    const vision = /gpt-4o|vision/.test(m);
    const jsonMode = true;
    const toolUse = true;
    const streaming = true;
    const reasoning = /gpt-4|gpt-4o|opus|sonnet/.test(m);
    let contextWindow = 128000;
    if (m.includes('mini')) contextWindow = 128000;
    if (m.includes('gpt-4.1')) contextWindow = 128000;
    return {
      contextWindow,
      supports: { vision, jsonMode, toolUse, streaming, reasoning }
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Test with a simple completion to verify API key and model access
      const testPrompt = 'Respond with "OK" to confirm connectivity.';
      const response = await this.callOpenAI(testPrompt, { maxTokens: 10 });

      if (response.choices && response.choices.length > 0) {
        this.isHealthy = true;
        this.logger.info('OpenAI connection test successful', {
          model: this.config.model,
          tokensUsed: response.usage?.total_tokens
        });
        return {
          ok: true,
          message: `OpenAI ${this.config.model} connection successful`
        };
      } else {
        this.isHealthy = false;
        return {
          ok: false,
          message: 'OpenAI API returned empty response'
        };
      }
    } catch (error) {
      this.isHealthy = false;
      this.logger.error('OpenAI connection test failed', {
        model: this.config.model,
        error: String(error)
      });
      return {
        ok: false,
        message: `OpenAI connection failed: ${error.message}`
      };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    try {
      const startTime = Date.now();

      if (!sampleData || sampleData.length === 0) {
        this.logger.warn('No sample data provided for field mapping suggestions');
        return [];
      }

      const sourceFields = this.extractFields(sampleData);
      const prompt = this.buildFieldMappingPrompt(sourceSystem, targetSystem, sourceFields, sampleData);

      const response = await this.callOpenAI(prompt, {
        maxTokens: this.config.maxTokens || 2000,
        temperature: this.config.temperature || 0.3
      }, ctx);

      const suggestions = this.parseFieldMappingSuggestions(response, sourceFields);

      const executionTime = Date.now() - startTime;
      this.logger.info('OpenAI field mapping completed', {
        model: this.config.model,
        sourceFields: sourceFields.length,
        suggestions: suggestions.length,
        executionTime,
        tokens: response.usage?.total_tokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return suggestions;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('OpenAI field mapping failed', {
        model: this.config.model,
        error: error.message,
        sourceSystem,
        targetSystem
      });
      throw new Error(`OpenAI field mapping failed: ${error.message}`, { cause: error });
    }
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    try {
      const startTime = Date.now();

      const prompt = this.buildQualityAssessmentPrompt(suggestions);
      const response = await this.callOpenAI(prompt, {
        maxTokens: this.config.maxTokens || 1500,
        temperature: this.config.temperature || 0.3
      }, ctx);

      const qualityReport = this.parseQualityAssessment(response, suggestions);

      const executionTime = Date.now() - startTime;
      this.logger.info('OpenAI quality assessment completed', {
        model: this.config.model,
        suggestions: suggestions.length,
        overallScore: qualityReport.overallScore,
        executionTime,
        tokens: response.usage?.total_tokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return qualityReport;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('OpenAI quality assessment failed', {
        model: this.config.model,
        error: error.message
      });

      // Fallback to basic scoring
      return {
        overallScore: 0.7,
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

      // Convert ChatMessage[] to OpenAI message format
      const openAIMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`
      };

      if (this.config.organization) {
        headers['OpenAI-Organization'] = this.config.organization;
      }

      const body = {
        model: this.config.model,
        messages: openAIMessages,
        max_tokens: options?.maxTokens || this.config.maxTokens || 1000,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7
      };

      const identity = ctx ?? SYSTEM_IDENTITY;
      const outboundCtx: OutboundContext = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        destination: 'ai_provider',
        destinationDetail: `openai.${this.config.model}`,
        operationType: 'execute'
      };

      const response = await this.sendRequest(
        `${this.config.baseURL}/chat/completions`,
        body,
        { method: 'POST', headers },
        outboundCtx
      );

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
      }

      const result = await response.json() as OpenAIResponse;

      if (!result || !result.choices || result.choices.length === 0) {
        throw new Error('Invalid response from OpenAI API');
      }

      // Track token usage and cost
      if (result.usage) {
        const inputCost = result.usage.prompt_tokens * this.getCostPerToken();
        const outputCost = result.usage.completion_tokens * this.getCostPerToken() * 2;
        this.lastTokenUsage = {
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
          estimatedCost: inputCost + outputCost
        };
      }

      const executionTime = Date.now() - startTime;
      this.logger.info('OpenAI chat completion completed', {
        model: this.config.model,
        messages: messages.length,
        executionTime,
        tokens: result.usage?.total_tokens || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return {
        content: result.choices[0].message.content,
        usage: result.usage ? {
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens
        } : undefined
      };

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('OpenAI chat completion failed', {
        model: this.config.model,
        error: error.message
      });
      throw new Error(`OpenAI chat failed: ${error.message}`, { cause: error });
    }
  }

  // Backward compatibility methods
  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> {
    return this.suggest((context as any).sourceSystem || 'unknown', (context as any).targetSystem || 'unknown', (context as any).sampleData || []);
  }

  async analyzeDataQuality(data: unknown[], context: unknown): Promise<unknown> {
    // Simple quality analysis for backward compatibility
    return {
      overallScore: 0.8,
      issues: [],
      recommendations: ['Data quality analysis available through assessQuality method']
    };
  }

  // Utility methods for cost tracking and field analysis

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

  // Private methods

  private getCostPerToken(): number {
    // Heuristic pricing map; fall back to a conservative default
    const m = this.config.model.toLowerCase();
    if (m.includes('mini')) return 0.00000015; // ultra cheap tier
    if (m.includes('gpt-4o')) return 0.00003; // default GPT-4o family
    // Unknown future model – use default to avoid under-estimating cost
    return 0.00003;
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

  private async callOpenAI(prompt: string, options: { maxTokens: number; temperature?: number }, ctx?: IdentityContext): Promise<OpenAIResponse> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`
    };

    if (this.config.organization) {
      headers['OpenAI-Organization'] = this.config.organization;
    }

    const body = {
      model: this.config.model,
      messages: [
        {
          role: 'system',
          content: 'You are an expert data integration specialist helping with field mapping between different systems. Provide accurate, well-reasoned suggestions in the requested JSON format.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: options.maxTokens,
      temperature: options.temperature || this.config.temperature || 0.3
    };

    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `openai.${this.config.model}`,
      operationType: 'execute'
    };

    const response = await this.sendRequest(
      `${this.config.baseURL}/chat/completions`,
      body,
      { method: 'POST', headers },
      outboundCtx
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`OpenAI API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const result = await response.json() as OpenAIResponse;

    if (!result || !result.choices) {
      throw new Error('Invalid response from OpenAI API');
    }

    // Track token usage and cost
    if (result.usage) {
      const inputCost = result.usage.prompt_tokens * this.getCostPerToken();
      const outputCost = result.usage.completion_tokens * this.getCostPerToken() * 2; // Output tokens cost more
      this.lastTokenUsage = {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
        estimatedCost: inputCost + outputCost
      };
    }

    return result;
  }

  private parseFieldMappingSuggestions(response: OpenAIResponse, sourceFields: string[]): AISuggestion[] {
    try {
      const content = response.choices[0]?.message?.content;
      if (!content) return [];

      const parsed = parseJsonFromText<{ suggestions?: unknown[] }>(content);
      if (!parsed) {
        throw new Error('No JSON payload in OpenAI response');
      }
      const suggestions = parsed.suggestions || [];

      return suggestions
        .filter((s: unknown) => {
          const meetsConfidence = !(s as any).confidence || (s as any).confidence >= 70;
          return (s as any).sourceField && (s as any).targetField && sourceFields.includes((s as any).sourceField) && meetsConfidence;
        })
        .map((s: unknown) => ({
          sourceField: (s as any).sourceField,
          targetField: (s as any).targetField,
          transformationType: (s as any).transformationType || 'direct',
          confidence: (s as any).confidence || undefined,
          reasoning: (s as any).reasoning || undefined
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to parse OpenAI field mapping response', { error: message });
      return [];
    }
  }

  private parseQualityAssessment(response: OpenAIResponse, suggestions: AISuggestion[]): AIQualityReport {
    try {
      const content = response.choices[0]?.message?.content;
      if (!content) throw new Error('Empty response content');

      const parsed = parseJsonFromText<{ overallScore?: number }>(content);
      if (!parsed) throw new Error('No JSON found in response');

      return {
        overallScore: Math.min(Math.max(parsed.overallScore || 0.7, 0), 1),
        totalMappings: suggestions.length
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to parse OpenAI quality assessment', { error: message });
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    // Rough estimation: 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
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
