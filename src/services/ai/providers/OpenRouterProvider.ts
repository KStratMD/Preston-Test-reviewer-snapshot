import type { Logger } from '../../../utils/Logger';
import type {
  AIProvider,
  ProviderCapabilities,
  AISuggestion,
  AIQualityReport,
  AIProviderMode,
  ChatMessage,
  ChatResponse,
} from './types';
import {
  buildOptimizedFieldMappingPrompt,
  buildOptimizedQualityPrompt,
  type FieldMetadata,
} from '../prompts/FieldMappingPrompts';
import {
  isOfficialOpenRouterBaseUrl,
  normalizeOpenRouterBaseUrl,
  normalizePositiveInteger,
} from '../utils/openRouter';
import { parseJsonFromText } from '../../../utils/json';
import { getAllFieldNames, getRecordValues } from '../utils/dataRecord';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';
import { isProviderGovernanceError } from '../../governance/OutboundGovernanceErrors';

export interface OpenRouterConfig {
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
  siteUrl?: string;
  siteName?: string;
  timeout?: number;
}

interface OpenRouterResponse {
  id: string;
  model: string;
  choices: {
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason?: string;
  }[];
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

interface OpenRouterModelRecord {
  id: string;
  name?: string;
  context_length?: number;
  created?: number | string;
  pricing?: {
    prompt?: string;
    completion?: string;
  };
  top_provider?: {
    context_length?: number;
  };
}

interface OpenRouterModelListResponse {
  data?: OpenRouterModelRecord[];
}

export interface TokenUsageInfo {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export class OpenRouterProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'cloud-api';
  public readonly name = 'OpenRouter';
  public readonly version = '1.0.0';

  private lastTokenUsage?: TokenUsageInfo;
  private isHealthy = false;

  public get isAvailable(): boolean {
    return !!this.config.apiKey && this.isHealthy;
  }

  constructor(
    logger: Logger,
    private config: OpenRouterConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    const mergedConfig = {
      baseURL: 'https://openrouter.ai/api/v1',
      temperature: 0.1,
      timeout: 30000,
      ...config,
    };

    this.config = {
      ...mergedConfig,
      baseURL: normalizeOpenRouterBaseUrl(mergedConfig.baseURL),
      maxTokens: normalizePositiveInteger(config.maxTokens),
      timeout: normalizePositiveInteger(mergedConfig.timeout, 30000) ?? 30000,
    };
  }

  setModel(model: string) {
    this.config.model = model;
    this.logger.info('OpenRouter model switched at runtime', { model });
  }

  getModel(): string {
    return this.config.model;
  }

  getLastTokenUsage(): TokenUsageInfo | undefined {
    return this.lastTokenUsage;
  }

  async getAvailableModels(): Promise<OpenRouterModelRecord[]> {
    const response = await fetch(`${this.getApiBaseUrl()}/models`, {
      method: 'GET',
      headers: this.buildHeaders(),
      signal: this.getTimeoutSignal(),
    });

    if (!response.ok) {
      throw new Error(`OpenRouter models request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json() as OpenRouterModelListResponse;
    return data.data || [];
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `OpenRouter ${this.config.model}`,
      version: this.version,
      features: [
        'Multi-model routing through one API',
        'Canonical OpenRouter model identifiers',
        'Optional proxy-compatible routing',
        'Dynamic model discovery',
        'Structured chat completions',
      ],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom'],
    };
  }

  async introspectCapabilities(modelId: string): Promise<unknown> {
    const normalized = modelId.toLowerCase();
    let contextWindow = 65536;

    if (normalized === 'openrouter/free') {
      contextWindow = 8192;
    } else if (normalized.includes('claude')) {
      contextWindow = 200000;
    } else if (normalized.includes('gemini')) {
      contextWindow = 1000000;
    } else if (normalized.includes('gpt-4o')) {
      contextWindow = 128000;
    } else if (normalized.includes('llama') || normalized.includes('nemotron')) {
      contextWindow = 131072;
    }

    return {
      contextWindow,
      supports: {
        vision: /claude|gpt-4o|gemini|vision|vl|multimodal/.test(normalized),
        jsonMode: normalized !== 'openrouter/free',
        toolUse: /claude|gpt|gemini|llama|qwen|nemotron/.test(normalized),
        streaming: true,
        reasoning: /claude|gpt|reasoning|deepseek|llama|qwen|nemotron|gemini/.test(normalized),
      },
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.callOpenRouterMessages([
        {
          role: 'user',
          content: 'Respond with OK.',
        },
      ], {
        maxTokens: 8,
        temperature: 0,
      });

      this.isHealthy = true;
      return {
        ok: true,
        message: `OpenRouter ${this.config.model} connection successful`,
      };
    } catch (error) {
      this.isHealthy = false;
      return {
        ok: false,
        message: `OpenRouter connection failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    if (!sampleData || sampleData.length === 0) {
      this.logger.warn('No sample data provided for OpenRouter field mapping suggestions');
      return [];
    }

    const sourceFields = this.extractFields(sampleData);
    const prompt = this.buildFieldMappingPrompt(sourceSystem, targetSystem, sourceFields, sampleData);
    const response = await this.callOpenRouterMessages([
      {
        role: 'system',
        content: 'You are an expert data integration specialist helping with field mapping between different systems. Provide accurate, well-reasoned suggestions in the requested JSON format.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      maxTokens: this.getMaxTokens(2000),
      temperature: this.config.temperature ?? 0.1,
    }, ctx);

    return this.parseFieldMappingSuggestions(response, sourceFields);
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    try {
      const prompt = this.buildQualityAssessmentPrompt(suggestions);
      const response = await this.callOpenRouterMessages([
        {
          role: 'system',
          content: 'You are an expert evaluator of field mapping suggestions. Return strict JSON only.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ], {
        maxTokens: this.getMaxTokens(1200),
        temperature: this.config.temperature ?? 0.1,
      }, ctx);

      return this.parseQualityAssessment(response, suggestions);
    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.warn('OpenRouter quality assessment failed, falling back to basic score', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        overallScore: suggestions.length ? 0.75 : 0,
        totalMappings: suggestions.length,
      };
    }
  }

  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }, ctx?: IdentityContext): Promise<ChatResponse> {
    const response = await this.callOpenRouterMessages(messages, {
      maxTokens: this.getMaxTokens(1000, options?.maxTokens),
      temperature: options?.temperature ?? this.config.temperature ?? 0.1,
    }, ctx);

    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter returned an empty chat response');
    }

    return {
      content,
      usage: response.usage ? {
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      } : undefined,
    };
  }

  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> {
    return this.suggest(
      (context as { sourceSystem?: string }).sourceSystem || 'unknown',
      (context as { targetSystem?: string }).targetSystem || 'unknown',
      (context as { sampleData?: unknown[] }).sampleData || [],
    );
  }

  async analyzeDataQuality(): Promise<unknown> {
    return {
      overallScore: 0.8,
      issues: [],
      recommendations: ['Use assessQuality() for a model-backed evaluation.'],
    };
  }

  getCostEstimate(inputText: string): { tokens: number; cost: number } {
    const tokens = Math.ceil(inputText.length / 4);
    return {
      tokens,
      cost: tokens * this.getCostPerToken(),
    };
  }

  private async callOpenRouterMessages(
    messages: { role: string; content: string }[],
    options: { maxTokens: number; temperature?: number },
    ctx?: IdentityContext,
  ): Promise<OpenRouterResponse> {
    const body = {
      model: this.resolveModelId(this.config.model),
      messages,
      max_tokens: options.maxTokens,
      temperature: options.temperature ?? this.config.temperature ?? 0.1,
    };

    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `openrouter.${this.config.model}`,
      operationType: 'execute'
    };

    const response = await this.sendRequest(
      `${this.getApiBaseUrl()}/chat/completions`,
      body,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        signal: this.getTimeoutSignal(),
      },
      outboundCtx
    );

    if (!response.ok) {
      const errorBody = await response.text().catch(() => '');
      throw new Error(`OpenRouter API error: ${response.status} ${response.statusText}${errorBody ? ` - ${errorBody}` : ''}`);
    }

    const result = await response.json() as OpenRouterResponse;
    if (!result || !Array.isArray(result.choices)) {
      throw new Error('Invalid response from OpenRouter API');
    }

    if (result.usage) {
      const costPerToken = this.getCostPerToken();
      this.lastTokenUsage = {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
        estimatedCost: (result.usage.prompt_tokens * costPerToken) + (result.usage.completion_tokens * costPerToken * 2),
      };
    }

    return result;
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    if (this.config.siteUrl) {
      headers['HTTP-Referer'] = this.config.siteUrl;
    }

    if (this.config.siteName) {
      headers['X-Title'] = this.config.siteName;
    }

    return headers;
  }

  private getApiBaseUrl(): string {
    return normalizeOpenRouterBaseUrl(this.config.baseURL);
  }

  private getTimeoutSignal(): AbortSignal | undefined {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(this.config.timeout ?? 30000);
    }
    return undefined;
  }

  private getMaxTokens(fallback: number, override?: number): number {
    const configMaxTokens = normalizePositiveInteger(this.config.maxTokens, fallback) ?? fallback;
    return normalizePositiveInteger(override, configMaxTokens) ?? configMaxTokens;
  }

  private isProxyBaseUrl(): boolean {
    return !isOfficialOpenRouterBaseUrl(this.getApiBaseUrl());
  }

  private resolveModelId(modelId: string): string {
    if (this.isProxyBaseUrl()) {
      return modelId.startsWith('openrouter/') ? modelId : `openrouter/${modelId}`;
    }

    if (
      modelId.startsWith('openrouter/') &&
      modelId !== 'openrouter/free' &&
      modelId !== 'openrouter/auto'
    ) {
      return modelId.slice('openrouter/'.length);
    }

    return modelId;
  }

  private getCostPerToken(): number {
    const normalized = this.config.model.toLowerCase();

    if (normalized === 'openrouter/free' || normalized.endsWith(':free')) {
      return 0;
    }
    if (normalized.includes('claude')) {
      return 0.000003;
    }
    if (normalized.includes('gpt-4o')) {
      return 0.000004;
    }
    if (normalized.includes('gemini') || normalized.includes('llama') || normalized.includes('nemotron')) {
      return 0.000001;
    }
    return 0.000003;
  }

  private extractFields(sampleData: unknown[]): string[] {
    return getAllFieldNames(sampleData);
  }

  private buildFieldMappingPrompt(sourceSystem: string, targetSystem: string, sourceFields: string[], sampleData: unknown[]): string {
    const fieldMetadata: FieldMetadata[] = sourceFields.map(fieldName => {
      const allValues = getRecordValues(sampleData, fieldName);
      return {
        name: fieldName,
        type: allValues.length > 0 ? this.inferType(allValues[0]) : 'unknown',
        sampleValues: allValues.slice(0, 3),
      };
    });

    return buildOptimizedFieldMappingPrompt(sourceSystem, targetSystem, fieldMetadata, sampleData);
  }

  private buildQualityAssessmentPrompt(suggestions: AISuggestion[]): string {
    return buildOptimizedQualityPrompt(suggestions, 'source', 'target');
  }

  private parseFieldMappingSuggestions(response: OpenRouterResponse, sourceFields: string[]): AISuggestion[] {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) {
        return [];
      }

      const parsed = parseJsonFromText<{ suggestions?: unknown[] }>(content);
      const suggestions = parsed?.suggestions || [];

      return suggestions
        .filter((suggestion: unknown) => {
          const confidence = (suggestion as { confidence?: number }).confidence;
          return (
            !!(suggestion as { sourceField?: string }).sourceField &&
            !!(suggestion as { targetField?: string }).targetField &&
            sourceFields.includes((suggestion as { sourceField: string }).sourceField) &&
            (confidence == null || confidence >= 70)
          );
        })
        .map((suggestion: unknown) => ({
          sourceField: (suggestion as { sourceField: string }).sourceField,
          targetField: (suggestion as { targetField: string }).targetField,
          transformationType: (suggestion as { transformationType?: string }).transformationType || 'direct',
          confidence: (suggestion as { confidence?: number }).confidence,
          reasoning: (suggestion as { reasoning?: string }).reasoning,
        }));
    } catch (error) {
      this.logger.warn('Failed to parse OpenRouter field mapping response', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  private parseQualityAssessment(response: OpenRouterResponse, suggestions: AISuggestion[]): AIQualityReport {
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Empty response content');
    }

    const parsed = parseJsonFromText<{ overallScore?: number }>(content);
    if (!parsed) {
      throw new Error('No JSON found in OpenRouter response');
    }

    return {
      overallScore: Math.min(Math.max(parsed.overallScore ?? 0.7, 0), 1),
      totalMappings: suggestions.length,
    };
  }

  private inferType(value: unknown): string {
    if (value === null || value === undefined) return 'unknown';
    if (typeof value === 'string') {
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) return 'date';
      if (/^[\w.+-]+@[\w.-]+\.\w+$/.test(value)) return 'email';
      if (/^\+?[\d\s\-()]+$/.test(value)) return 'phone';
      return 'string';
    }
    if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'decimal';
    if (typeof value === 'boolean') return 'boolean';
    if (Array.isArray(value)) return 'array';
    if (typeof value === 'object') return 'object';
    return 'unknown';
  }
}
