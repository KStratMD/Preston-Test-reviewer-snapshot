import type { Logger } from '../../../utils/Logger';
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport, ChatMessage, ChatResponse } from './types';

export interface CloudAIConfig {
  model?: string;
  apiKeyMasked?: string; // do not store plaintext here
}

export class CloudAIProvider implements AIProvider {
  readonly mode = 'cloud-api' as const;
  readonly isAvailable = true; // Legacy provider, always available
  private logger: Logger;
  private config: CloudAIConfig;

  constructor(logger: Logger, config: CloudAIConfig = {}) {
    this.logger = logger;
    this.config = config;
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: 'Cloud AI Provider',
      version: '0.1.0-demo',
      features: ['Semantic field analysis', 'Confidence scoring', 'Advanced transformations'],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional'],
    };
  }

  async suggest(_sourceSystem: string, _targetSystem: string, sampleData: unknown[]): Promise<AISuggestion[]> {
    // Demo: create trivial mapping suggestions from sample headers
    const headers = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
    return headers.map(h => ({ sourceField: h, targetField: h, transformationType: 'direct' }));
  }

  async assessQuality(suggestions: AISuggestion[]): Promise<AIQualityReport> {
    // Demo scoring
    return {
      overallScore: suggestions.length ? 0.85 : 0,
      totalMappings: suggestions.length,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    // Demo: require that a model name be set to consider this configured
    if (!this.config.model) {
      return { ok: false, message: 'Cloud model not set' };
    }
    // In a real implementation, ping provider API with a small request
    this.logger.info('Cloud AI test executed', { model: this.config.model });
    return { ok: true, message: `Cloud provider '${this.config.model}' reachable (demo)` };
  }

  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<ChatResponse> {
    // Legacy provider doesn't support chat
    throw new Error('Chat is not supported by the legacy Cloud AI provider. Please use OpenAI, Claude, or LMStudio for conversational tasks.');
  }
}

