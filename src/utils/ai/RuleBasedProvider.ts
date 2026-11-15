import { AIFieldMappingService } from "../../services/ai/AIFieldMappingService";
import { TrainingDataRepository } from "../../services/ai/TrainingDataRepository";
import type { Logger } from "../Logger";
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport } from "./types";

export class RuleBasedProvider implements AIProvider {
  public readonly mode = "rule-based" as const;
  private readonly service: AIFieldMappingService;

  constructor(logger: Logger) {
    const trainingDataRepo = new TrainingDataRepository(logger);
    this.service = new AIFieldMappingService(logger, trainingDataRepo);
  }

  async getCapabilities(): Promise<ProviderCapabilities> {
    return {
      name: "Rule-based Mapper",
      version: "1.0.0",
      features: ["Semantic field analysis", "Pattern recognition", "Data type inference"],
      transformationTypes: ["direct", "lookup", "calculation", "concatenation", "conditional"],
    };
  }

  async suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[]): Promise<AISuggestion[]> {
    const headers = sampleData.length > 0 ? Object.keys(sampleData[0]) : [];
    const mockSourceSchema = {
      systemType: sourceSystem,
      recordType: "generic",
      fields: headers.map(h => ({ name: h, type: "string" as const, required: false })),
    } as any;
    const mockTargetSchema = {
      systemType: targetSystem,
      recordType: "generic",
      fields: headers.map(h => ({ name: h, type: "string" as const, required: false })),
    } as any;
    const suggestions = await this.service.suggestFieldMappings(mockSourceSchema, mockTargetSchema, sampleData as any);
    return suggestions.map(s => ({ sourceField: s.sourceField, targetField: s.targetField, transformationType: s.transformationType }));
  }

  async assessQuality(suggestions: AISuggestion[]): Promise<AIQualityReport> {
    return { overallScore: suggestions.length ? 0.9 : 0, totalMappings: suggestions.length };
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> { return { ok: true, message: "Rule-based provider ready" }; }
}

