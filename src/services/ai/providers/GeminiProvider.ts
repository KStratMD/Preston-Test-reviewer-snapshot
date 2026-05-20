import { type Logger } from '../../../utils/Logger';
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport, AIProviderMode, ChatMessage, ChatResponse } from './types';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';
import { isProviderGovernanceError } from '../../governance/OutboundGovernanceErrors';

export interface GeminiConfig {
  apiKey: string;
  model: string; // allow dynamic updates
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface GeminiResponse {
  candidates: {
    content: {
      parts: {
        text: string;
      }[];
      role: string;
    };
    finishReason: string;
    index: number;
    safetyRatings: {
      category: string;
      probability: string;
    }[];
  }[];
  usageMetadata: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export interface TokenUsageInfo {
  promptTokens: number;
  candidatesTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export class GeminiProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'cloud-api';
  public readonly name = 'Gemini';
  public readonly version = '2.0.0';

  private lastTokenUsage?: TokenUsageInfo;
  private isHealthy = false;

  public get isAvailable(): boolean {
    return !!this.config.apiKey && this.isHealthy;
  }

  constructor(
    logger: Logger,
    private config: GeminiConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    // Set defaults
    this.config = {
      baseURL: 'https://generativelanguage.googleapis.com/v1beta',
      maxTokens: 1000,
      temperature: 0.4,
      ...config
    };
  }

  setModel(model: string) {
    this.config.model = model;
    this.logger.info('Gemini model switched at runtime', { model });
  }

  getModel(): string { return this.config.model; }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `Google ${this.config.model}`,
      version: this.version,
      features: [
        'Fast field analysis for high-volume processing',
        'Cost-effective mapping suggestions',
        'Rapid confidence scoring',
        'Efficient transformation recommendations',
        'Multi-modal understanding capability',
        'Economy tier optimization'
      ],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional', 'custom']
    };
  }

  // Dynamic capability introspection (heuristic - avoids extra quota consumption)
  async introspectCapabilities(modelId: string): Promise<unknown> {
    const m = modelId.toLowerCase();
    const reasoning = /pro|1\.5|flash/.test(m); // assume reasoning across major Gemini 1.5 variants
    const vision = true; // Gemini models generally multimodal
    const jsonMode = true;
    const toolUse = true; // function calling & tool use available
    const streaming = true;
    let contextWindow = 1000000; // Gemini 1.5 context up to 1M tokens (heuristic)
    if (m.includes('flash')) contextWindow = 1000000;
    if (m.includes('nano')) contextWindow = 128000;
    return {
      contextWindow,
      supports: { reasoning, vision, jsonMode, toolUse, streaming }
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      // Test with a simple completion to verify API key and model access
      const testPrompt = 'Respond with "OK" to confirm connectivity.';
      const response = await this.callGemini(testPrompt, { maxTokens: 10 });

      if (response.candidates && response.candidates.length > 0) {
        this.isHealthy = true;
        this.logger.info('Gemini connection test successful', {
          model: this.config.model,
          tokensUsed: response.usageMetadata?.totalTokenCount
        });
        return {
          ok: true,
          message: `Gemini ${this.config.model} connection successful`
        };
      } else {
        this.isHealthy = false;
        return {
          ok: false,
          message: 'Gemini API returned empty response'
        };
      }
    } catch (error) {
      this.isHealthy = false;
      this.logger.error('Gemini connection test failed', {
        model: this.config.model,
        error: String(error)
      });
      return {
        ok: false,
        message: `Gemini connection failed: ${error.message}`
      };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    try {
      const startTime = Date.now();

      if (!sampleData || sampleData.length === 0) {
        this.logger.warn('No sample data provided for Gemini field mapping suggestions');
        return [];
      }

      const sourceFields = this.extractFields(sampleData);
      const prompt = this.buildFieldMappingPrompt(sourceSystem, targetSystem, sourceFields, sampleData);

      const response = await this.callGemini(prompt, {
        maxTokens: this.config.maxTokens || 1500,
        temperature: this.config.temperature || 0.4
      }, ctx);

      const suggestions = this.parseFieldMappingSuggestions(response, sourceFields);

      const executionTime = Date.now() - startTime;
      this.logger.info('Gemini field mapping completed', {
        model: this.config.model,
        sourceFields: sourceFields.length,
        suggestions: suggestions.length,
        executionTime,
        tokens: response.usageMetadata?.totalTokenCount || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return suggestions;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('Gemini field mapping failed', {
        model: this.config.model,
        error: error.message,
        sourceSystem,
        targetSystem
      });
      throw new Error(`Gemini field mapping failed: ${error.message}`, { cause: error });
    }
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    try {
      const startTime = Date.now();

      const prompt = this.buildQualityAssessmentPrompt(suggestions);
      const response = await this.callGemini(prompt, {
        maxTokens: this.config.maxTokens || 1000,
        temperature: this.config.temperature || 0.4
      }, ctx);

      const qualityReport = this.parseQualityAssessment(response, suggestions);

      const executionTime = Date.now() - startTime;
      this.logger.info('Gemini quality assessment completed', {
        model: this.config.model,
        suggestions: suggestions.length,
        overallScore: qualityReport.overallScore,
        executionTime,
        tokens: response.usageMetadata?.totalTokenCount || 0,
        cost: this.lastTokenUsage?.estimatedCost || 0
      });

      return qualityReport;

    } catch (error) {
      if (isProviderGovernanceError(error)) {
        throw error;
      }
      this.logger.error('Gemini quality assessment failed', {
        model: this.config.model,
        error: error.message
      });

      // Fallback to basic scoring
      return {
        overallScore: 0.75,
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
    // Gemini provider not currently implemented for help chat
    // Future enhancement: implement Gemini chat API integration
    throw new Error('Chat is not yet implemented for Gemini provider. Please use OpenAI, Claude, or LMStudio for conversational tasks.');
  }

  // Backward compatibility methods
  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> {
    return this.suggest((context as any).sourceSystem || 'unknown', (context as any).targetSystem || 'unknown', (context as any).sampleData || []);
  }

  async analyzeDataQuality(data: unknown[], context: unknown): Promise<unknown> {
    // Simple quality analysis for backward compatibility
    return {
      overallScore: 0.75,
      issues: [],
      recommendations: ['Cost-effective data quality analysis available through assessQuality method']
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
    // Gemini pricing (as of 2024) - input token costs
    switch (this.config.model) {
      case 'gemini-1.5-pro':
        return 0.00000015; // heuristic higher cost
      default:
        return 0.000000075; // flash or unknown low-cost tier
    }
  }

  private extractFields(sampleData: unknown[]): string[] {
    if (!sampleData || sampleData.length === 0) return [];
    return Object.keys(sampleData[0] || {});
  }

  private buildFieldMappingPrompt(sourceSystem: string, targetSystem: string, sourceFields: string[], sampleData: unknown[]): string {
    const sampleValues = sampleData.slice(0, 3).map(record =>
      sourceFields.map(field => `${field}: ${JSON.stringify((record as Record<string, unknown>)[field])}`).join(', ')
    ).join('\n');

    return `
Analyze field mapping from ${sourceSystem} to ${targetSystem} for efficient, cost-effective processing.

Source Fields: ${sourceFields.join(', ')}

Sample Data:
${sampleValues}

Please provide field mapping suggestions in JSON format:
{
  "suggestions": [
    {
      "sourceField": "field_name",
      "targetField": "suggested_target_field",
      "transformationType": "direct|lookup|calculation|concatenation|conditional|custom"
    }
  ]
}

Focus on:
1. Clear semantic relationships between field names
2. Obvious data type patterns and compatibility
3. Common integration patterns for ${sourceSystem} → ${targetSystem}
4. Efficient, straightforward transformations

Provide confident, practical mappings optimized for speed and cost-effectiveness. Each suggestion should be clear and actionable.
`;
  }

  private buildQualityAssessmentPrompt(suggestions: AISuggestion[]): string {
    const mappingSummary = suggestions.map(s =>
      `${s.sourceField} → ${s.targetField} (${s.transformationType})`
    ).join('\n');

    return `
Provide efficient quality assessment of these field mapping suggestions:

${mappingSummary}

Provide a quality assessment in JSON format:
{
  "overallScore": 0.75,
  "analysis": {
    "strengths": ["List of mapping strengths"],
    "weaknesses": ["List of potential issues"],
    "risks": ["List of integration risks"]
  },
  "recommendations": ["Specific improvement suggestions"]
}

Evaluate efficiently:
1. Mapping coverage and logical consistency
2. Transformation simplicity and efficiency
3. Obvious data quality risks
4. Practical integration considerations
`;
  }

  private async callGemini(prompt: string, options: { maxTokens: number; temperature?: number }, ctx?: IdentityContext): Promise<GeminiResponse> {
    const endpoint = `${this.config.baseURL}/models/${this.config.model}:generateContent`;

    const body = {
      contents: [
        {
          parts: [
            {
              text: `You are Gemini, Google's advanced AI assistant optimized for efficient data integration analysis. Provide practical, cost-effective suggestions in the requested JSON format.\n\n${prompt}`
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: options.maxTokens,
        temperature: options.temperature || this.config.temperature || 0.4
      }
    };

    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `gemini.${this.config.model}`,
      operationType: 'execute'
    };

    const response = await this.sendRequest(
      `${endpoint}?key=${this.config.apiKey}`,
      body,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        }
      },
      outboundCtx
    );

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
      throw new Error(`Gemini API error: ${response.status} ${response.statusText} - ${JSON.stringify(errorData)}`);
    }

    const result = await response.json() as GeminiResponse;

    if (!result || !result.candidates) {
      throw new Error('Invalid response from Gemini API');
    }

    // Track token usage and cost
    if (result.usageMetadata) {
      const inputCost = result.usageMetadata.promptTokenCount * this.getCostPerToken();
      const outputCost = result.usageMetadata.candidatesTokenCount * this.getCostPerToken();
      this.lastTokenUsage = {
        promptTokens: result.usageMetadata.promptTokenCount,
        candidatesTokens: result.usageMetadata.candidatesTokenCount,
        totalTokens: result.usageMetadata.totalTokenCount,
        estimatedCost: inputCost + outputCost
      };
    }

    return result;
  }

  private parseFieldMappingSuggestions(response: GeminiResponse, sourceFields: string[]): AISuggestion[] {
    try {
      const content = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) return [];

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      const suggestions = parsed.suggestions || [];

      return suggestions
        .filter((s: unknown) => (s as any).sourceField && (s as any).targetField && sourceFields.includes((s as any).sourceField))
        .map((s: unknown) => ({
          sourceField: (s as any).sourceField,
          targetField: (s as any).targetField,
          transformationType: (s as any).transformationType || 'direct'
        }));
    } catch (error) {
      this.logger.warn('Failed to parse Gemini field mapping response', { error: error.message });
      return [];
    }
  }

  private parseQualityAssessment(response: GeminiResponse, suggestions: AISuggestion[]): AIQualityReport {
    try {
      const content = response.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!content) throw new Error('Empty response content');

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found in response');

      const parsed = JSON.parse(jsonMatch[0]);

      return {
        overallScore: Math.min(Math.max(parsed.overallScore || 0.75, 0), 1),
        totalMappings: suggestions.length
      };
    } catch (error) {
      this.logger.warn('Failed to parse Gemini quality assessment', { error: error.message });
      throw error;
    }
  }

  private estimateTokens(text: string): number {
    // Gemini estimation: roughly 1 token ≈ 4 characters for English text
    return Math.ceil(text.length / 4);
  }
}
