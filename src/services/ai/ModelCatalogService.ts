import type { Logger } from '../../utils/Logger';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { ClaudeProvider } from './providers/ClaudeProvider';
import { ProviderRegistry } from './ProviderRegistry';
import { normalizeOpenRouterBaseUrl } from './utils/openRouter';
import { resolveLMStudioBaseUrl } from './utils/lmstudio';
import { getDistributedCache } from '../../utils/DistributedCache';
import { UnifiedTelemetryService } from '../UnifiedTelemetryService';

export interface ModelInfo {
  id: string;
  family?: string;
  contextWindow?: number;
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  releasedAt?: string;
  supports?: string[];
  provider: ProviderId;
  recommended?: boolean;
}

export type ProviderId = 'openai' | 'anthropic' | 'grok' | 'gemini' | 'lmstudio' | 'openrouter';

interface CachedCatalog {
  timestamp: number;
  models: ModelInfo[];
  fallbackUsed: boolean;
}

// Capability metadata (initial curated seed; can be expanded / externalized later)
interface ModelCapabilityRecord {
  contextWindow?: number;
  supports: {
    vision: boolean;
    jsonMode: boolean;
    toolUse: boolean;
    streaming: boolean;
    reasoning: boolean;
  };
}

type CapabilitySource = 'dynamic' | 'static';
type CapabilityIndex = Record<string, ModelCapabilityRecord>;

interface DynamicModelSetter {
  setModel(modelId: string): void;
}

interface DynamicModelGetter {
  getModel(): string | undefined;
}

interface CapabilityIntrospector {
  introspectCapabilities(modelId: string): Promise<unknown> | unknown;
}

interface ProviderAggregate {
  models: ModelInfo[];
  count: number;
  activeModel?: string;
  lastSwitch?: string;
  fallbackUsed?: boolean;
  cacheAgeMs?: number;
  capabilities?: CapabilityIndex;
  error?: string;
}

interface ModelCatalogAggregate {
  providers: Record<ProviderId, ProviderAggregate>;
  generatedAt: string;
  active?: {
    provider: ProviderId;
    model?: string;
    lastSwitch?: string;
  };
  activeModels?: Record<ProviderId, string | undefined>;
}

const capabilityMatrix: Record<ProviderId, Record<string, ModelCapabilityRecord>> = {
  openai: {
    'gpt-5.4': { contextWindow: 1000000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'gpt-5.4-mini': { contextWindow: 400000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'gpt-5.4-nano': { contextWindow: 400000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'gpt-4o': { contextWindow: 128000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'gpt-4o-mini': { contextWindow: 128000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: false } },
    'gpt-4.1': { contextWindow: 128000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } }
  },
  anthropic: {
    'claude-sonnet-4-6': { contextWindow: 1000000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: true } },
    'claude-haiku-4-5-20251001': { contextWindow: 200000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: true } },
    'claude-opus-4-8': { contextWindow: 1000000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: true } },
    'claude-3-5-sonnet-20241022': { contextWindow: 200000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: true } },
    'claude-3-opus-20240229': { contextWindow: 200000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: true } },
    'claude-3-haiku-20240307': { contextWindow: 200000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: false } }
  },
  grok: {
    'grok-beta': { contextWindow: 128000, supports: { vision: false, jsonMode: false, toolUse: true, streaming: true, reasoning: false } },
    'grok-vision-beta': { contextWindow: 128000, supports: { vision: true, jsonMode: false, toolUse: true, streaming: true, reasoning: false } }
  },
  gemini: {
    'gemini-1.5-flash': { contextWindow: 1000000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: false } },
    'gemini-1.5-pro': { contextWindow: 2000000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } }
  },
  lmstudio: {
    // Local models vary; treat as conservative defaults
    'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF': { contextWindow: 8192, supports: { vision: false, jsonMode: false, toolUse: false, streaming: true, reasoning: false } }
  },
  openrouter: {
    'anthropic/claude-3.5-sonnet': { contextWindow: 200000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'openai/gpt-4o': { contextWindow: 128000, supports: { vision: true, jsonMode: true, toolUse: true, streaming: true, reasoning: true } },
    'openrouter/free': { contextWindow: 8192, supports: { vision: false, jsonMode: false, toolUse: false, streaming: true, reasoning: false } },
    'nvidia/nemotron-3-super-120b-a12b': { contextWindow: 131072, supports: { vision: false, jsonMode: true, toolUse: true, streaming: true, reasoning: true } }
  }
};

export class ModelCatalogService {
  /**
   * Multi-provider model catalog and dynamic model selector.
   *
   * Features:
   *  - Per-provider model listing with 10m TTL cache (override via opts.refresh)
   *  - Fallback curated lists for providers without stable public listing (anthropic, grok, gemini, lmstudio offline)
   *  - Live listing attempt for OpenAI & LMStudio (local) with graceful degradation
   *  - Runtime model switching supporting both legacy direct provider references (openai, anthropic)
   *    and new generic registry-based providers (grok, gemini, lmstudio)
   *  - Structured result objects for switching to avoid throwing in routes
   *
   * Not Yet Implemented (future roadmap):
   *  - Capability metadata (vision, tool-use, json-mode, reasoning tokens)
   *  - Soft deprecation tags & stability tiers
   *  - Unified cost & latency stats enrichment per model
   */
  private cache: Record<string, CachedCatalog> = {};
  private cacheTTL = 10 * 60 * 1000; // 10 minutes
  private lastSwitch: Partial<Record<ProviderId, { model: string; timestamp: number }>> = {};
  private initializedPersistence = false;
  private dynamicCapabilityCache: Record<string, { timestamp: number; record: ModelCapabilityRecord; source: CapabilitySource }> = {};
  private dynamicCapabilityTTL = 5 * 60 * 1000; // 5 minutes

  constructor(
    private logger: Logger,
    private openaiProvider?: OpenAIProvider,
    private claudeProvider?: ClaudeProvider,
    private providerRegistry?: ProviderRegistry,
    private telemetry?: UnifiedTelemetryService
  ) {
    // Fire and forget persistence initialization
    this.restorePersistedState().catch(err => {
      this.logger.warn('Failed to restore persisted model catalog state', { error: String(err) });
    });
  }

  async listModels(provider: ProviderId, opts: { refresh?: boolean; search?: string } = {}): Promise<ModelInfo[]> {
    const key = provider;
    const now = Date.now();
    if (!opts.refresh && this.cache[key] && (now - this.cache[key].timestamp) < this.cacheTTL) {
      return this.filter(this.cache[key].models, opts.search);
    }

    let models: ModelInfo[];
    let fallbackUsed = false;
    try {
      switch (provider) {
        case 'openai':
          models = await this.fetchOpenAIModels(); break;
        case 'anthropic':
          models = await this.fetchAnthropicModels(); break;
        case 'grok':
          models = await this.fetchGrokModels(); break;
        case 'gemini':
          models = await this.fetchGeminiModels(); break;
        case 'lmstudio':
          models = await this.fetchLMStudioModels(); break;
        case 'openrouter':
          models = await this.fetchOpenRouterModels(); break;
        default:
          models = this.getFallback(provider);
      }
      this.cache[key] = { timestamp: now, models, fallbackUsed };
    } catch (err) {
      this.logger.warn('Model catalog fetch failed, using fallback list', { provider, error: String(err) });
      models = this.getFallback(provider);
      fallbackUsed = true;
      this.cache[key] = { timestamp: now, models, fallbackUsed };
    }

    return this.filter(models, opts.search);
  }

  async setActiveModel(provider: ProviderId, modelId: string): Promise<{ ok: boolean; message: string }> {
    const previous = this.getActiveModel(provider);
    const start = Date.now();
    try {
      if (provider === 'openai' && this.openaiProvider) {
        this.openaiProvider.setModel(modelId);
        this.lastSwitch[provider] = { model: modelId, timestamp: Date.now() };
        this.persistActive(provider).catch(()=>{});
        await this.recordTelemetry('model_switched', { provider, modelId, previousModel: previous });
        return { ok: true, message: `OpenAI model set to ${modelId}` };
      }
      if (provider === 'anthropic' && this.claudeProvider) {
        this.claudeProvider.setModel(modelId);
        this.lastSwitch[provider] = { model: modelId, timestamp: Date.now() };
        this.persistActive(provider).catch(()=>{});
        await this.recordTelemetry('model_switched', { provider, modelId, previousModel: previous });
        return { ok: true, message: `Anthropic model set to ${modelId}` };
      }
      // Generic path for newly added providers (via registry)
      if ((provider === 'grok' || provider === 'gemini' || provider === 'lmstudio' || provider === 'openrouter') && this.providerRegistry) {
        const regId = provider; // direct mapping; 'claude' handled above
        const entry = this.providerRegistry.getProvider(regId);
        if (this.hasModelSetter(entry)) {
          entry.setModel(modelId);
          this.lastSwitch[provider] = { model: modelId, timestamp: Date.now() };
          this.persistActive(provider).catch(()=>{});
          await this.recordTelemetry('model_switched', { provider, modelId, previousModel: previous });
          return { ok: true, message: `${provider} model set to ${modelId}` };
        }
        return { ok: false, message: 'Provider not registered or does not support dynamic model switching' };
      }
      return { ok: false, message: 'Provider not initialized' };
    } catch (err) {
      await this.recordTelemetry('model_switch_failed', { provider, modelId, previousModel: previous, error: String(err), durationMs: Date.now() - start });
      return { ok: false, message: String(err) };
    }
  }

  getActiveModel(provider: ProviderId): string | undefined {
    if (provider === 'openai') return this.openaiProvider?.getModel();
    if (provider === 'anthropic') return this.claudeProvider?.getModel();
    if (this.providerRegistry) {
      const regId = provider; // direct mapping; anthropic already handled
      const entry = this.providerRegistry.getProvider(regId);
      if (this.hasModelGetter(entry)) return entry.getModel();
    }
    return undefined;
  }

  getLastSwitch(provider: ProviderId): { model: string; timestamp: number } | undefined {
    return this.lastSwitch[provider];
  }

  /** Aggregate view across all providers (lightweight; uses cached lists where possible) */
  async aggregate(refresh = false, dynamicCapabilities = false): Promise<ModelCatalogAggregate> {
    const providers: ProviderId[] = ['openai','anthropic','grok','gemini','lmstudio','openrouter'];
    const providerSummaries = {} as Record<ProviderId, ProviderAggregate>;
    const result: ModelCatalogAggregate = { providers: providerSummaries, generatedAt: new Date().toISOString() };
    for (const p of providers) {
      try {
        const models = await this.listModels(p, { refresh });
        const cacheMeta = this.cache[p];
        result.providers[p] = {
          models,
          count: models.length,
          activeModel: this.getActiveModel(p),
          lastSwitch: this.lastSwitch[p]?.timestamp ? new Date(this.lastSwitch[p].timestamp).toISOString() : undefined,
          fallbackUsed: cacheMeta?.fallbackUsed || false,
          cacheAgeMs: cacheMeta ? (Date.now() - cacheMeta.timestamp) : undefined,
          capabilities: dynamicCapabilities ? await this.buildCapabilitiesIndexDynamic(p, models) : this.buildCapabilitiesIndex(p, models)
        };
      } catch (err) {
        result.providers[p] = {
          models: [],
          count: 0,
          error: String(err)
        };
      }
    }
    // Determine primary active provider using registry fallback order if available else openai
    let primary: ProviderId = 'openai';
    const fallbackOrder = this.readFallbackOrder(this.providerRegistry);
    if (fallbackOrder[0]) {
      primary = fallbackOrder[0];
    }
    result.active = {
      provider: primary,
      model: this.getActiveModel(primary),
      lastSwitch: this.lastSwitch[primary]?.timestamp ? new Date(this.lastSwitch[primary].timestamp).toISOString() : undefined
    };
    result.activeModels = Object.fromEntries(
      Object.entries(result.providers).map(([providerId, providerSummary]) => [
        providerId as ProviderId,
        providerSummary.activeModel,
      ])
    ) as Record<ProviderId, string | undefined>;
    return result;
  }

  private buildCapabilitiesIndex(provider: ProviderId, models: ModelInfo[]): CapabilityIndex {
    const matrix = capabilityMatrix[provider] || {};
    const out: CapabilityIndex = {};
    for (const m of models) {
      const caps = matrix[m.id];
      if (caps) {
        out[m.id] = {
          contextWindow: caps.contextWindow,
          supports: { ...caps.supports }
        };
        // Also enrich original model info with a flat supports array for backward compatibility
        this.applyCapabilitiesToModel(m, caps);
      }
    }
    return out;
  }

  /** Dynamic capability introspection (best-effort). Attempts to call provider.introspectCapabilities(modelId) if available. Falls back to static matrix. */
  private async buildCapabilitiesIndexDynamic(provider: ProviderId, models: ModelInfo[]): Promise<CapabilityIndex> {
    const out: CapabilityIndex = {};
    // try cached dynamic first
    for (const m of models) {
      const cacheKey = `${provider}:${m.id}`;
      const cached = this.dynamicCapabilityCache[cacheKey];
      if (cached && (Date.now() - cached.timestamp) < this.dynamicCapabilityTTL) {
        out[m.id] = cached.record;
        this.applyCapabilitiesToModel(m, cached.record, { overrideContextWindow: cached.source === 'dynamic' });
      }
    }
    // Determine provider instance
    let instance: unknown;
    if (provider === 'openai') instance = this.openaiProvider;
    else if (provider === 'anthropic') instance = this.claudeProvider;
    else if (this.providerRegistry) instance = this.providerRegistry.getProvider(provider);

    // If no instance or no models, fallback static for missing entries
    for (const model of models) {
      if (out[model.id]) continue; // already satisfied by cache
      let dynamic: ModelCapabilityRecord | undefined;
      let capabilitySource: CapabilitySource = 'static';
      try {
        if (this.hasCapabilityIntrospector(instance)) {
          dynamic = this.normalizeCapabilityRecord(await instance.introspectCapabilities(model.id));
          if (dynamic) {
            capabilitySource = 'dynamic';
          }
        }
      } catch (err) {
        this.logger.debug('Dynamic capability introspection failed for model, falling back', { provider, model: model.id, error: String(err) });
      }
      if (!dynamic) {
        // fallback to static
        const staticIndex = this.buildCapabilitiesIndex(provider, [model]);
        dynamic = staticIndex[model.id];
      }
      if (dynamic) {
        out[model.id] = dynamic;
        this.dynamicCapabilityCache[`${provider}:${model.id}`] = { timestamp: Date.now(), record: dynamic, source: capabilitySource };
        this.applyCapabilitiesToModel(model, dynamic, { overrideContextWindow: capabilitySource === 'dynamic' });
      }
    }
    await this.recordTelemetry('capability_introspection_performed', { provider, modelCount: models.length, dynamic: true });
    return out;
  }

  private filter(models: ModelInfo[], search?: string) {
    if (!search) return models;
    const s = search.toLowerCase();
    return models.filter(m => m.id.toLowerCase().includes(s) || (m.family || '').toLowerCase().includes(s));
  }

  private async fetchOpenAIModels(): Promise<ModelInfo[]> {
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY missing');
    const resp = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` }
    });
    if (!resp.ok) throw new Error(`OpenAI model list failed: ${resp.status}`);
  const data = await resp.json() as { data?: { id: string }[] };
    // Map minimal fields; OpenAI returns a large list - filter to chat/completions families
    const allowed = ['gpt', 'o', 'text', 'gpt-4', 'gpt-4o', 'gpt-5'];
    const models: ModelInfo[] = (data.data ?? [])
      .filter((m) => allowed.some(a => (m.id || '').includes(a)))
      .map((m) => ({ id: m.id, provider: 'openai', family: m.id.split('-').slice(0,2).join('-') }));
    // Ensure we include known recommended ones
    const recommended = ['gpt-5.4-mini', 'gpt-5.4-nano', 'gpt-4o-mini'];
    for (const r of recommended) {
      if (!models.find(m => m.id === r)) models.push({ id: r, provider: 'openai', family: r.startsWith('gpt-5') ? 'gpt-5.4' : 'gpt-4o', recommended: true });
    }
    return models;
  }

  private async fetchAnthropicModels(): Promise<ModelInfo[]> {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY missing');
    // Anthropic does not yet expose a public list endpoint for all models in the same way; use heuristic + optional docs call
    // For safety we rely on environment or a static curated list until official endpoint available.
    return this.getFallback('anthropic');
  }

  private async fetchGrokModels(): Promise<ModelInfo[]> {
    // No public listing yet; return curated fallback
    return this.getFallback('grok');
  }

  private async fetchGeminiModels(): Promise<ModelInfo[]> {
    // Gemini model listing endpoint varies; until stable API, use fallback
    return this.getFallback('gemini');
  }

  private async fetchLMStudioModels(): Promise<ModelInfo[]> {
    const base = resolveLMStudioBaseUrl(process.env.LMSTUDIO_BASE_URL);
    try {
      const headers: Record<string, string> = {};
      if (process.env.LMSTUDIO_API_KEY) {
        headers.Authorization = `Bearer ${process.env.LMSTUDIO_API_KEY}`;
      }

      const resp = await fetch(`${base}/v1/models`, { method: 'GET', headers });
      if (!resp.ok) throw new Error(`LMStudio list failed ${resp.status}`);
      const data = await resp.json() as { data?: { id: string }[] };
      const models = (data.data || []).map(m => ({ id: m.id, provider: 'lmstudio' as ProviderId, family: m.id.split('/')[0] }));
      if (!models.length) return this.getFallback('lmstudio');
      return models;
    } catch (err) {
      this.logger.warn('LMStudio model list failed, using fallback', { error: String(err) });
      return this.getFallback('lmstudio');
    }
  }

  private async fetchOpenRouterModels(): Promise<ModelInfo[]> {
    const base = normalizeOpenRouterBaseUrl(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1');
    const modelsUrl = `${base}/models`;

    if (!process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_BASE_URL) {
      return this.getFallback('openrouter');
    }

    try {
      const headers: Record<string, string> = {};
      if (process.env.OPENROUTER_API_KEY) {
        headers.Authorization = `Bearer ${process.env.OPENROUTER_API_KEY}`;
      }

      const resp = await fetch(modelsUrl, { method: 'GET', headers });
      if (!resp.ok) throw new Error(`OpenRouter list failed ${resp.status}`);
      const data = await resp.json() as {
        data?: {
          id: string;
          context_length?: number;
          created?: number | string;
          pricing?: { prompt?: string; completion?: string };
          top_provider?: { context_length?: number };
        }[];
      };

      const preferred = new Set([
        'openrouter/free',
        process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet',
        'anthropic/claude-3.5-sonnet',
        'openai/gpt-4o',
        'meta-llama/llama-3.1-70b-instruct',
        'nvidia/nemotron-3-super-120b-a12b',
      ]);
      const models = (data.data || [])
        .filter(model =>
          preferred.has(model.id) ||
          model.id.endsWith(':free') ||
          /claude|gpt-4o|gemini|llama|qwen|deepseek|nemotron|mistral/i.test(model.id)
        )
        .map((model) => {
          const parsedPrompt = model.pricing?.prompt !== undefined ? Number(model.pricing.prompt) : undefined;
          const parsedCompletion = model.pricing?.completion !== undefined ? Number(model.pricing.completion) : undefined;

          return {
            id: model.id,
            provider: 'openrouter' as ProviderId,
            family: model.id.split('/')[0],
            contextWindow: model.context_length || model.top_provider?.context_length,
            releasedAt: typeof model.created === 'number'
              ? new Date(model.created * 1000).toISOString()
              : typeof model.created === 'string'
                ? model.created
                : undefined,
            inputCostPerToken: Number.isFinite(parsedPrompt) ? parsedPrompt : undefined,
            outputCostPerToken: Number.isFinite(parsedCompletion) ? parsedCompletion : undefined,
            recommended: preferred.has(model.id),
          };
        })
        .sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended)) || a.id.localeCompare(b.id))
        .slice(0, 20);

      return models.length ? models : this.getFallback('openrouter');
    } catch (err) {
      this.logger.warn('OpenRouter model list failed, using fallback', { error: String(err) });
      return this.getFallback('openrouter');
    }
  }

  private getFallback(provider: ProviderId): ModelInfo[] {
    switch (provider) {
      case 'openai':
        return [
          // Current frontier/mini models (2026)
          { id: 'gpt-5.4-mini', provider: 'openai', family: 'gpt-5.4', recommended: true, releasedAt: '2026-06' },
          { id: 'gpt-5.4-nano', provider: 'openai', family: 'gpt-5.4', recommended: true, releasedAt: '2026-06' },
          { id: 'gpt-5.4', provider: 'openai', family: 'gpt-5.4', releasedAt: '2026-06' },
          // Latest reasoning models (2024)
          { id: 'o1-preview', provider: 'openai', family: 'o1', recommended: true, releasedAt: '2024-09' },
          { id: 'o1-mini', provider: 'openai', family: 'o1', recommended: true, releasedAt: '2024-09' },
          // GPT-4o family (2024)
          { id: 'gpt-4o', provider: 'openai', family: 'gpt-4o', recommended: true, releasedAt: '2024-05' },
          { id: 'gpt-4o-mini', provider: 'openai', family: 'gpt-4o', recommended: true, releasedAt: '2024-07' },
          // GPT-4 Turbo variants
          { id: 'gpt-4-turbo', provider: 'openai', family: 'gpt-4', releasedAt: '2024-04' },
          { id: 'gpt-4', provider: 'openai', family: 'gpt-4', releasedAt: '2023-03' },
          // GPT-3.5 Turbo
          { id: 'gpt-3.5-turbo', provider: 'openai', family: 'gpt-3.5', releasedAt: '2023-03' }
        ];
      case 'anthropic':
        return [
          // Claude 4 current production candidates
          { id: 'claude-haiku-4-5-20251001', provider: 'anthropic', family: 'claude-4', recommended: true, releasedAt: '2025-10-01' },
          { id: 'claude-sonnet-4-6', provider: 'anthropic', family: 'claude-4', recommended: true, releasedAt: '2026-06' },
          { id: 'claude-opus-4-8', provider: 'anthropic', family: 'claude-4', releasedAt: '2026-06' },
          // Claude 3.5 Sonnet (legacy)
          { id: 'claude-3-5-sonnet-20241022', provider: 'anthropic', family: 'claude-3-5', releasedAt: '2024-10-22' },
          { id: 'claude-3-5-sonnet-20240620', provider: 'anthropic', family: 'claude-3-5', releasedAt: '2024-06-20' },
          // Claude 3 family
          { id: 'claude-3-opus-20240229', provider: 'anthropic', family: 'claude-3', releasedAt: '2024-02-29' },
          { id: 'claude-3-sonnet-20240229', provider: 'anthropic', family: 'claude-3', releasedAt: '2024-02-29' },
          { id: 'claude-3-haiku-20240307', provider: 'anthropic', family: 'claude-3', releasedAt: '2024-03-07' }
        ];
      case 'grok':
        return [
          { id: 'grok-beta', provider: 'grok', family: 'grok', recommended: true },
          { id: 'grok-vision-beta', provider: 'grok', family: 'grok-vision' }
        ];
      case 'gemini':
        return [
          { id: 'gemini-1.5-flash', provider: 'gemini', family: 'gemini-1.5', recommended: true },
          { id: 'gemini-1.5-pro', provider: 'gemini', family: 'gemini-1.5' },
          { id: 'gemini-1.0-pro', provider: 'gemini', family: 'gemini-1.0' }
        ];
      case 'lmstudio':
        return [
          { id: process.env.LMSTUDIO_MODEL || 'lmstudio-community/Meta-Llama-3.1-8B-Instruct-GGUF', provider: 'lmstudio', family: 'local', recommended: true }
        ];
      case 'openrouter':
        return [
          { id: 'openrouter/free', provider: 'openrouter', family: 'free', recommended: true },
          { id: process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet', provider: 'openrouter', family: 'anthropic', recommended: true },
          { id: 'openai/gpt-4o', provider: 'openrouter', family: 'openai', recommended: true },
          { id: 'meta-llama/llama-3.1-70b-instruct', provider: 'openrouter', family: 'meta-llama' },
          { id: 'nvidia/nemotron-3-super-120b-a12b', provider: 'openrouter', family: 'nvidia' }
        ];
      default:
        return [];
    }
  }

  // ===== Persistence =====
  private async persistActive(provider: ProviderId) {
    try {
      const cache = getDistributedCache();
      const rec = this.lastSwitch[provider];
      if (!rec) return;
      await cache.set(`modelCatalog:active:${provider}`, rec, 24 * 60 * 60); // 24h TTL
    } catch (err) {
      this.logger.debug('Persist active model failed (non-fatal)', { provider, error: String(err) });
    }
  }

  private async restorePersistedState() {
    if (this.initializedPersistence) return;
    const providers: ProviderId[] = ['openai','anthropic','grok','gemini','lmstudio','openrouter'];
    try {
      const cache = getDistributedCache();
      for (const p of providers) {
        const rec = await cache.get<{ model: string; timestamp: number }>(`modelCatalog:active:${p}`);
        if (rec?.model) {
          // Only set in providers that currently exist
            try {
              if (p === 'openai' && this.openaiProvider) this.openaiProvider.setModel(rec.model);
              else if (p === 'anthropic' && this.claudeProvider) this.claudeProvider.setModel(rec.model);
              else if (this.providerRegistry) {
                const entry = this.providerRegistry.getProvider(p);
                if (this.hasModelSetter(entry)) entry.setModel(rec.model);
              }
              this.lastSwitch[p] = rec;
            } catch (err) {
              this.logger.debug('Failed to restore model for provider', { provider: p, error: String(err) });
            }
        }
      }
      this.initializedPersistence = true;
      this.logger.info('Model catalog persistence restored');
    } catch (err) {
      this.logger.warn('Failed to restore model catalog persistence (non-fatal)', { error: String(err) });
    }
  }

  // ===== Telemetry helper =====
  private async recordTelemetry(eventType: string, metadata: Record<string, unknown>) {
    try {
      if (!this.telemetry) return;
      await this.telemetry.recordGenericEvent(eventType, metadata);
    } catch {
      // swallow
    }
  }

  private hasModelSetter(provider: unknown): provider is DynamicModelSetter {
    return this.isRecord(provider) && typeof provider.setModel === 'function';
  }

  private hasModelGetter(provider: unknown): provider is DynamicModelGetter {
    return this.isRecord(provider) && typeof provider.getModel === 'function';
  }

  private hasCapabilityIntrospector(provider: unknown): provider is CapabilityIntrospector {
    return this.isRecord(provider) && typeof provider.introspectCapabilities === 'function';
  }

  private readFallbackOrder(providerRegistry?: ProviderRegistry): ProviderId[] {
    if (!providerRegistry) {
      return [];
    }

    try {
      const order = providerRegistry.getFallbackOrder();
      return Array.isArray(order) ? order.filter((provider): provider is ProviderId => this.isProviderId(provider)) : [];
    } catch {
      return [];
    }
  }

  private normalizeCapabilityRecord(value: unknown): ModelCapabilityRecord | undefined {
    if (!this.isRecord(value)) {
      return undefined;
    }

    const supports = value.supports;
    if (!this.isSupportMap(supports)) {
      return undefined;
    }

    if (value.contextWindow !== undefined && typeof value.contextWindow !== 'number') {
      return undefined;
    }
    const contextWindow = typeof value.contextWindow === 'number' ? value.contextWindow : undefined;

    return {
      contextWindow,
      supports,
    };
  }

  private applyCapabilitiesToModel(
    model: ModelInfo,
    caps: ModelCapabilityRecord,
    opts: { overrideContextWindow?: boolean } = {}
  ): void {
    model.supports = Object.entries(caps.supports)
      .filter(([, supported]) => supported)
      .map(([capability]) => capability);
    if (caps.contextWindow !== undefined && (opts.overrideContextWindow || !model.contextWindow)) {
      model.contextWindow = caps.contextWindow;
    }
  }

  private isSupportMap(value: unknown): value is ModelCapabilityRecord['supports'] {
    if (!this.isRecord(value)) {
      return false;
    }

    const requiredKeys: (keyof ModelCapabilityRecord['supports'])[] = [
      'vision',
      'jsonMode',
      'toolUse',
      'streaming',
      'reasoning',
    ];

    return requiredKeys.every(key => typeof value[key] === 'boolean');
  }

  private isProviderId(value: unknown): value is ProviderId {
    return value === 'openai' ||
      value === 'anthropic' ||
      value === 'grok' ||
      value === 'gemini' ||
      value === 'lmstudio' ||
      value === 'openrouter';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}
