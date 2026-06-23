import { AIFieldMappingService } from '../AIFieldMappingService';
import { TrainingDataRepository } from '../TrainingDataRepository';
import type { Logger } from '../../../utils/Logger';
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport, ChatMessage, ChatResponse } from './types';

export class RuleBasedProvider implements AIProvider {
  readonly mode = 'rule-based' as const;
  readonly isAvailable = true; // Rule-based provider is always available
  private readonly service: AIFieldMappingService;

  constructor(logger: Logger) {
    const trainingDataRepo = new TrainingDataRepository(logger);
    this.service = new AIFieldMappingService(logger, trainingDataRepo);
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: 'Rule-based Mapper',
      version: '1.0.0',
      features: ['Semantic field analysis', 'Pattern recognition', 'Data type inference'],
      transformationTypes: ['direct', 'lookup', 'calculation', 'concatenation', 'conditional'],
    };
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[]): Promise<AISuggestion[]> {
    // Build simple schemas based on sample headers; leverage service internals
    const headers = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
    const mockSourceSchema = {
      systemType: sourceSystem,
      recordType: 'generic',
      fields: headers.map(h => ({ name: h, type: 'string' as const, required: false })),
      customFields: [],
    } as any;
    const mockTargetSchema = {
      systemType: targetSystem,
      recordType: 'generic',
      fields: headers.map(h => ({ name: h, type: 'string' as const, required: false })),
      customFields: [],
    } as any;
    const suggestions = await this.service.suggestFieldMappings(mockSourceSchema, mockTargetSchema, sampleData as any);
    return suggestions.map(s => ({ sourceField: s.sourceField, targetField: s.targetField, transformationType: s.transformationType }));
  }

  async assessQuality(suggestions: AISuggestion[]): Promise<AIQualityReport> {
    return {
      overallScore: suggestions.length ? 0.9 : 0,
      totalMappings: suggestions.length,
    };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    // Rule-based has no external deps
    return { ok: true, message: 'Rule-based provider ready' };
  }

  async chat(messages: ChatMessage[], options?: {
    maxTokens?: number;
    temperature?: number;
  }): Promise<ChatResponse> {
    // Rule-based provider doesn't support conversational chat
    throw new Error('Chat is not supported by the rule-based provider. Please use OpenAI, Claude, OpenRouter, or LMStudio for conversational tasks.');
  }
}
