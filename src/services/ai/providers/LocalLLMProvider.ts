import type { Logger } from '../../../utils/Logger';
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport, ChatMessage, ChatResponse } from './types';

export interface LocalLLMConfig {
  baseUrl?: string;
  model?: string;
}

export class LocalLLMProvider implements AIProvider {
  readonly mode = 'local-llm' as const;
  readonly isAvailable = true; // Legacy provider, always available
  private logger: Logger;
  private config: LocalLLMConfig;

  constructor(logger: Logger, config: LocalLLMConfig = {}) {
    this.logger = logger;
    this.config = config;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: 'Local LLM Provider',
      version: '0.1.0-demo',
      features: ['Offline mappings', 'Deterministic prompts (demo)'],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional'],
    };
  }

  async suggest(_sourceSystem: string, _targetSystem: string, sampleData: unknown[]): Promise<AISuggestion[]> {
    const headers = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
    return headers.map(h => ({ sourceField: h, targetField: h, transformationType: 'direct' }));
  }

  async assessQuality(suggestions: AISuggestion[]): Promise<AIQualityReport> {
    return { overallScore: suggestions.length ? 0.8 : 0, totalMappings: suggestions.length };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    if (!this.config.baseUrl) return { ok: false, message: 'Local base URL not set' };
    // Demo: in real impl, GET `${baseUrl}/health` or similar
    this.logger.info('Local LLM test executed', { baseUrl: this.config.baseUrl, model: this.config.model });
    return { ok: true, message: `Local LLM at ${this.config.baseUrl} (demo)` };
  }

  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<ChatResponse> {
    // Legacy LocalLLM provider doesn't support chat
    throw new Error('Chat is not supported by the legacy LocalLLM provider. Please use LMStudio for local conversational tasks.');
  }
}

