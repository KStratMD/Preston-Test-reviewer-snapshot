/**
 * Grok (xAI) Provider - experimental scaffolding
 * NOTE: API surface may differ; adjust endpoints & parsing when official SDK/docs change.
 */
import type { Logger } from '../../../utils/Logger';
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport, AIProviderMode, ChatMessage, ChatResponse } from './types';
import { BaseProvider } from './BaseProvider';
import { OutboundGovernanceService, type OutboundContext } from '../../governance/OutboundGovernanceService';
import { SYSTEM_IDENTITY, type IdentityContext } from '../../governance/identityContext';

export interface GrokConfig {
  apiKey: string;
  model: string;
  baseURL?: string; // default guess; adjust when confirmed
  maxTokens?: number;
  temperature?: number;
}

interface GrokResponseChoice { message?: { content?: string }; text?: string }
interface GrokResponseUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
interface GrokResponse { id: string; choices?: GrokResponseChoice[]; usage?: GrokResponseUsage; model?: string }

export class GrokProvider extends BaseProvider implements AIProvider {
  public readonly mode: AIProviderMode = 'cloud-api';
  public readonly name = 'Grok';
  public readonly version = '0.1.0';

  private isHealthy = false;
  private lastUsage?: { tokens: number; cost: number };

  constructor(
    logger: Logger,
    private config: GrokConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    super(logger, outboundGovernance);
    this.config = {
      baseURL: config.baseURL || 'https://api.x.ai/v1',
      maxTokens: config.maxTokens || 1500,
      temperature: config.temperature ?? 0.2,
      ...config
    };
  }

  get isAvailable(): boolean { return !!this.config.apiKey && this.isHealthy; }

  setModel(model: string) { this.config.model = model; this.logger.info('Grok model switched', { model }); }
  getModel(): string { return this.config.model; }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: `Grok ${this.config.model}`,
      version: this.version,
      features: [
        'Semantic mapping',
        'Confidence scoring',
        'Transformation suggestions'
      ],
      transformationTypes: ['direct','lookup','calculation','concatenation','conditional','custom']
    };
  }

  // Dynamic capability introspection (light heuristic until richer API available)
  async introspectCapabilities(modelId: string): Promise<unknown> {
    const m = modelId.toLowerCase();
    const reasoning = /grok|reasoning|mixtral|llama/.test(m);
    const vision = /vision|grok-1\.5|grok-2/.test(m); // guess future variants
    const jsonMode = true; // assume structured outputs supported through prompts
    const toolUse = true; // assume baseline function/tool calling ability
    const streaming = true;
    const contextWindow = 131072; // heuristic 128K style window + small buffer
    return { contextWindow, supports: { reasoning, vision, jsonMode, toolUse, streaming } };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      const prompt = 'Return OK';
      await this.callGrok(prompt, { maxTokens: 5 });
      this.isHealthy = true;
      return { ok: true, message: `Grok ${this.config.model} reachable` };
    } catch (e: unknown) {
      this.isHealthy = false;
      return { ok: false, message: `Grok test failed: ${(e as any).message}` };
    }
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[], ctx?: IdentityContext): Promise<AISuggestion[]> {
    if (!sampleData?.length) return [];
    const fields = Object.keys(sampleData[0]);
    const prompt = this.buildMappingPrompt(sourceSystem, targetSystem, fields, sampleData);
    const resp = await this.callGrok(prompt, { maxTokens: this.config.maxTokens!, temperature: this.config.temperature }, ctx);
    return this.parseSuggestions(resp, fields);
  }

  async assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport> {
    return { overallScore: suggestions.length ? 0.82 : 0, totalMappings: suggestions.length };
  }

  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }, ctx?: IdentityContext): Promise<ChatResponse> {
    // Grok provider not currently implemented for help chat (experimental scaffolding)
    throw new Error('Chat is not yet implemented for Grok provider. Please use OpenAI, Claude, or LMStudio for conversational tasks.');
  }

  async generateMappingSuggestions(context: unknown): Promise<AISuggestion[]> { return this.suggest((context as any).sourceSystem, (context as any).targetSystem, (context as any).sampleData || []); }
  async analyzeDataQuality(): Promise<unknown> { return { overallScore: 0.8, issues: [], recommendations: [] }; }

  private getCostPerToken(): number { return 0.000028; }

  private buildMappingPrompt(source: string, target: string, fields: string[], sample: unknown[]): string {
    const sampleLines = sample.slice(0,3).map(r => fields.map(f=>`${f}: ${JSON.stringify((r as Record<string, unknown>)[f])}`).join(', ')).join('\n');
    return `Analyze mapping from ${source} to ${target}. Fields: ${fields.join(', ')}\nSample:\n${sampleLines}\nReturn JSON {\n  "suggestions": [ { "sourceField": "", "targetField": "", "transformationType": "direct|lookup|..." } ]\n}`;
  }

  private async callGrok(prompt: string, opts: { maxTokens: number; temperature?: number }, ctx?: IdentityContext): Promise<GrokResponse> {
    const body = { model: this.config.model, messages: [{ role: 'user', content: prompt }], max_tokens: opts.maxTokens, temperature: opts.temperature };
    
    const identity = ctx ?? SYSTEM_IDENTITY;
    const outboundCtx: OutboundContext = {
      tenantId: identity.tenantId,
      userId: identity.userId,
      destination: 'ai_provider',
      destinationDetail: `grok.${this.config.model}`,
      operationType: 'execute'
    };

    const res = await this.sendRequest(
      `${this.config.baseURL}/chat/completions`,
      body,
      { method: 'POST', headers: { 'Content-Type':'application/json','Authorization':`Bearer ${this.config.apiKey}` } },
      outboundCtx
    );
    
    if (!res.ok) { const errTxt = await res.text(); throw new Error(`Grok API ${res.status}: ${errTxt}`); }
    const json = await res.json() as GrokResponse;
    if (json.usage) {
      const tokens = json.usage.total_tokens || (json.usage.prompt_tokens||0)+(json.usage.completion_tokens||0);
      this.lastUsage = { tokens, cost: tokens * this.getCostPerToken() };
    }
    return json;
  }

  private parseSuggestions(resp: GrokResponse, fields: string[]): AISuggestion[] {
    try {
      const content = resp.choices?.[0]?.message?.content || resp.choices?.[0]?.text || '';
      const match = content.match(/\{[\s\S]*\}/);
      if (!match) return [];
      const parsed = JSON.parse(match[0]);
      return (parsed.suggestions || [])
        .filter((s: unknown) => (s as any).sourceField && (s as any).targetField && fields.includes((s as any).sourceField))
        .map((s: unknown) => ({
          sourceField: (s as any).sourceField,
          targetField: (s as any).targetField,
            transformationType: (s as any).transformationType || 'direct'
        }));
    } catch (e: unknown) {
      this.logger.warn('Grok suggestion parse failed', {
        error: e instanceof Error ? e.message : String(e)
      });
      return [];
    }
  }
}
