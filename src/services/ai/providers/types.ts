import type { IdentityContext } from '../../governance/identityContext';

export type AIProviderMode = 'rule-based' | 'cloud-api' | 'local-llm' | 'local';

export interface AISuggestion {
  sourceField: string;
  sourceFields?: string[]; // For multi-field mappings (e.g., firstName + lastName → fullName)
  targetField: string;
  transformationType: string;
  // Phase 2 accuracy improvements: explicit confidence scoring
  confidence?: number; // 0-100, higher = more confident
  reasoning?: string; // Why this mapping makes sense
}

export interface AIQualityReport {
  overallScore: number;
  totalMappings: number;
}

export interface ProviderCapabilities {
  name: string;
  version: string;
  features: string[];
  transformationTypes: string[];
}

/**
 * Chat message for conversational AI tasks
 */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Response from chat completion
 */
export interface ChatResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
}

export interface AIProvider {
  readonly mode: AIProviderMode;
  readonly isAvailable: boolean;
  getCapabilities(): Promise<ProviderCapabilities>;
  suggest(
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[],
    ctx?: IdentityContext,
  ): Promise<AISuggestion[]>;
  assessQuality(suggestions: AISuggestion[], ctx?: IdentityContext): Promise<AIQualityReport>;
  testConnection(): Promise<{ ok: boolean; message?: string }>;

  /**
   * Generic chat completion for conversational tasks (e.g., help chat, Q&A)
   */
  chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }, ctx?: IdentityContext): Promise<ChatResponse>;

  // Backward compatibility methods for legacy interfaces
  generateMappingSuggestions?(context: unknown): Promise<AISuggestion[]>;
  analyzeDataQuality?(data: unknown[], context: unknown): Promise<unknown>;
}
