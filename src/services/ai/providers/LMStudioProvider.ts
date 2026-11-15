/**
 * LMStudio Provider Implementation - Week 9 Real AI Integration
 * Local Llama 3.1 8B Instruct integration via LMStudio for local tier routing
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
import { getAllFieldNames, getRecordValues } from '../utils/dataRecord';
import { parseJsonFromText } from '../../../utils/json';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';
import { isProviderGovernanceError } from '../../governance/OutboundGovernanceErrors';
import { resolveLMStudioBaseUrl } from '../utils/lmstudio';

export interface LMStudioConfig {
  baseURL: string; // Default: resolved per environment, falling back to localhost or the WSL host gateway
  model: string;   // Default: 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF'
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  timeout?: number;
}

export interface LMStudioResponse {
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
  estimatedCost: number; // Always 0 for local
}

export class LMStudioProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'local';
  public readonly name = 'LMStudio';
  public readonly version = '2.0.0';

  private lastTokenUsage?: TokenUsageInfo;
  private isHealthy = false;

  public get isAvailable(): boolean {
    return this.isHealthy; // No API key needed for local
  }

  constructor(
    logger: Logger,
    private config: LMStudioConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    const resolvedBaseURL = resolveLMStudioBaseUrl(config.baseURL);

    // Set defaults for LMStudio
    this.config = {
      ...config,
      baseURL: resolvedBaseURL,
      model: config.model || 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF',
      maxTokens: config.maxTokens ?? 1000,
      temperature: config.temperature ?? 0.3,
      timeout: config.timeout ?? 120000, // 120 second timeout for local model inference
    };
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `LMStudio ${this.config.model}`,
      version: this.version,
      features: [
        'Local processing with complete privacy',
        'No API costs or rate limits',
        'Offline operation capability',
        'Custom model fine-tuning support',
        'High-speed local inference',
        'Enterprise data security'
      ],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom']
    };
  }

  // Dynamic capability introspection (pure heuristic: we inspect model name patterns)
  async introspectCapabilities(modelId: string): Promise<unknown> {
    const m = modelId.toLowerCase();
    const reasoning = /llama|mistral|phi|qwen|deepseek/.test(m);
    const vision = /vision|multimodal|mm|vl|llava/.test(m);
    const jsonMode = true; // can enforce via prompting locally
    const toolUse = /tool|agent/.test(m); // only flag if model name hints at tool/agent tuning
    const streaming = true; // local server streams tokens even if we choose not to
    let contextWindow = 8192; // default smaller window for many GGUF models
    if (/70b|405b|mixtral|qwen|deepseek/.test(m)) contextWindow = 32768;
    if (/8b|13b|14b|7b|11b/.test(m)) contextWindow = 8192;
    return {
      contextWindow,
      supports: { reasoning, vision, jsonMode, toolUse, streaming }
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Test with a simple completion to verify LMStudio is running
      const testPrompt = 'Respond with "OK" to confirm connectivity.';
      const response = await this.callLMStudio(testPrompt, { maxTokens: 10 });

      if (response.choices && response.choices.length > 0) {
        this.isHealthy = true;
        this.logger.info('LMStudio connection test successful', {
          model: this.config.model,
          baseURL: this.config.baseURL,
          tokensUsed: response.usage?.total_tokens
        });
        return {
          ok: true,
          message: `LMStudio ${this.config.model} connection successful`
        };
      } else {
        this.isHealthy = false;
        return {
          ok: false,
          message: 'LMStudio returned empty response'
        };
      }
    } catch (error) {
      this.isHealthy = false;
      this.logger.error('LMStudio connection test failed', {
        model: this.config.model,
        baseURL: this.config.baseURL,
        error: String(error)
      });

      if (error.message.includes('ECONNREFUSED')) {
        return {
          ok: false,
          message: 'LMStudio not running - please start LMStudio and load a model'
        };
      }

      return {
        ok: false,
        message: `LMStudio connection failed: ${error.message}`
      };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    try {
      const startTime = Date.now();

      if (!sampleData || sampleData.length === 0) {
        this.logger.warn('No sample data provided for LMStudio field mapping suggestions');
        return [];
      }

      const sourceFields = this.extractFields(sampleData);
      const prompt = this.buildFieldMappingPrompt(sourceSystem, targetSystem, sourceFields, sampleData);

      const response = await this.callLMStudio(prompt, {
        maxTokens: this.config.maxTokens || 1500,
        temperature: this.config.temperature || 0.3
      }, ctx);

      const suggestions = this.parseFieldMappingSuggestions(response, sourceFields);

      const executionTime = Date.now() - startTime;
      this.logger.info('LMStudio field mapping completed', {
        model: this.config.model,
        sourceFields: sourceFields.length,
        suggestions: suggestions.length,
        executionTime,
        tokens: response.usage?.total_tokens || 0,
        cost: 0 // Local processing is free
      });

      return suggestions;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('LMStudio field mapping failed', {
        model: this.config.model,
        error: error.message,
        sourceSystem,
        targetSystem
      });
      throw new Error(`LMStudio field mapping failed: ${error.message}`, { cause: error });
    }
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    try {
      const startTime = Date.now();

      const prompt = this.buildQualityAssessmentPrompt(suggestions);
      const response = await this.callLMStudio(prompt, {
        maxTokens: this.config.maxTokens || 1000,
        temperature: this.config.temperature || 0.3
      }, ctx);

      const qualityReport = this.parseQualityAssessment(response, suggestions);

      const executionTime = Date.now() - startTime;
      this.logger.info('LMStudio quality assessment completed', {
        model: this.config.model,
        suggestions: suggestions.length,
        overallScore: qualityReport.overallScore,
        executionTime,
        tokens: response.usage?.total_tokens || 0,
        cost: 0 // Local processing is free
      });

      return qualityReport;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('LMStudio quality assessment failed', {
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

      // Convert ChatMessage[] to LMStudio/OpenAI-compatible message format
      const lmstudioMessages = messages.map(msg => ({
        role: msg.role,
        content: msg.content
      }));

      const body = {
        model: this.config.model,
        messages: lmstudioMessages,
        max_tokens: options?.maxTokens || this.config.maxTokens || 1000,
        temperature: options?.temperature ?? this.config.temperature ?? 0.7,
        stream: false
      };

      const identity = ctx ?? SYSTEM_IDENTITY;
      const outboundCtx: OutboundContext = {
        tenantId: identity.tenantId,
        userId: identity.userId,
        destination: 'ai_provider',
        destinationDetail: `lmstudio.${this.config.model}`,
        operationType: 'execute'
      };

      const response = await this.sendRequest(
        `${this.config.baseURL}/v1/chat/completions`,
        body,
        {
          method: 'POST',
          headers: this.buildHeaders(),
          signal: AbortSignal.timeout(this.config.timeout ?? 120000)
        },
        outboundCtx
      );

      if (!response.ok) {
        let errorMessage = `LMStudio API error: ${response.status} ${response.statusText}`;
        try {
          const errorData = await response.json();
          errorMessage += ` - ${JSON.stringify(errorData)}`;
        } catch {
          // Ignore JSON parse errors for error responses
        }
        throw new Error(errorMessage);
      }

      const result = await response.json() as LMStudioResponse;

      if (!result || !result.choices || result.choices.length === 0) {
        throw new Error('Invalid response from LMStudio API');
      }

      // Track token usage (cost is always 0 for local)
      if (result.usage) {
        this.lastTokenUsage = {
          promptTokens: result.usage.prompt_tokens,
          completionTokens: result.usage.completion_tokens,
          totalTokens: result.usage.total_tokens,
          estimatedCost: 0 // Local processing is free
        };
      }

      const executionTime = Date.now() - startTime;
      this.logger.info('LMStudio chat completion completed', {
        model: this.config.model,
        messages: messages.length,
        executionTime,
        tokens: result.usage?.total_tokens || 0,
        cost: 0
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
      this.logger.error('LMStudio chat completion failed', {
        model: this.config.model,
        error: error.message
      });

      if (error.message.includes('ECONNREFUSED')) {
        throw new Error('LMStudio not running - please start LMStudio and load a model', { cause: error });
      }

      throw new Error(`LMStudio chat failed: ${error.message}`, { cause: error });
    }
  }

  // Backward compatibility methods
  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> {
    return this.suggest((context as any).sourceSystem || 'unknown', (context as any).targetSystem || 'unknown', (context as any).sampleData || []);
  }

  async analyzeDataQuality(data: unknown[], context: unknown): Promise<unknown> {
    // Simple quality analysis for backward compatibility
    return {
      overallScore: 0.7,
      issues: [],
      recommendations: ['Local data quality analysis available through assessQuality method']
    };
  }

  // Utility methods for cost tracking and field analysis

  getCostEstimate(inputText: string): { tokens: number; cost: number } {
    const tokens = this.estimateTokens(inputText);
    return {
      tokens,
      cost: 0 // Local processing is always free
    };
  }

  getLastTokenUsage(): TokenUsageInfo | undefined {
    return this.lastTokenUsage;
  }

  // LMStudio specific methods

  async getAvailableModels(): Promise<string[]> {
    try {
      const response = await fetch(`${this.config.baseURL}/v1/models`, {
        method: 'GET',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(this.config.timeout ?? 120000)
      });

      if (!response.ok) {
        throw new Error(`Failed to get models: ${response.status}`);
      }

      const data = await response.json() as { data?: { id: string }[] };
      return data.data?.map((model) => model.id) || [];
    } catch (error) {
      this.logger.warn('Failed to get available models from LMStudio', { error: error.message });
      return [];
    }
  }

  // Private methods

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

  private async callLMStudio(prompt: string, options: { maxTokens: number; temperature?: number }, ctx?: IdentityContext): Promise<LMStudioResponse> {
    const body = {
      model: this.config.model,
      messages: [
        {
          role: 'user',
          content: prompt
        }
      ],
      max_tokens: options.maxTokens,
      temperature: options.temperature || this.config.temperature || 0.3,
      stream: false
    };

    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `lmstudio.${this.config.model}`,
      operationType: 'execute'
    };

    const response = await this.sendRequest(
      `${this.config.baseURL}/v1/chat/completions`,
      body,
      {
        method: 'POST',
        headers: this.buildHeaders(),
        signal: AbortSignal.timeout(this.config.timeout ?? 120000)
      },
      outboundCtx
    );

    if (!response.ok) {
      let errorMessage = `LMStudio API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = await response.json();
        errorMessage += ` - ${JSON.stringify(errorData)}`;
      } catch {
        // Ignore JSON parse errors for error responses
      }
      throw new Error(errorMessage);
    }

    const result = await response.json() as LMStudioResponse;

    if (!result || !result.choices) {
      throw new Error('Invalid response from LMStudio API');
    }

    // Track token usage (cost is always 0 for local)
    if (result.usage) {
      this.lastTokenUsage = {
        promptTokens: result.usage.prompt_tokens,
        completionTokens: result.usage.completion_tokens,
        totalTokens: result.usage.total_tokens,
        estimatedCost: 0 // Local processing is free
      };
    }

    return result;
  }

  private parseFieldMappingSuggestions(response: LMStudioResponse, sourceFields: string[]): AISuggestion[] {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) return [];

      const parsed = parseJsonFromText<{ suggestions?: unknown[] }>(content);
      if (!parsed) {
        throw new Error('No JSON payload in LMStudio response');
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
      this.logger.warn('Failed to parse LMStudio field mapping response', { error: message });
      return [];
    }
  }

  private parseQualityAssessment(response: LMStudioResponse, suggestions: AISuggestion[]): AIQualityReport {
    try {
      const content = response.choices?.[0]?.message?.content;
      if (!content) throw new Error('Empty response content');

      const parsed = parseJsonFromText<{ overallScore?: number }>(content);
      if (!parsed) throw new Error('No JSON found in response');

      return {
        overallScore: Math.min(Math.max(parsed.overallScore || 0.7, 0), 1),
        totalMappings: suggestions.length
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn('Failed to parse LMStudio quality assessment', { error: message });
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    // Llama estimation: roughly 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (this.config.apiKey) {
      headers.Authorization = `Bearer ${this.config.apiKey}`;
    }

    return headers;
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
