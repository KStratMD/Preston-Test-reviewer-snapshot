import type { Logger } from "../Logger";
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport } from "./types";

export interface CloudAIConfig { model?: string; apiKeyMasked?: string }

export class CloudAIProvider implements AIProvider {
  public readonly mode = "cloud-api" as const;
  private readonly logger: Logger;
  private readonly config: CloudAIConfig;
  constructor(logger: Logger, config: CloudAIConfig = {}) { this.logger = logger; this.config = config; }
  async getCapabilities(): Promise<ProviderCapabilities> {
    return { name: "Cloud AI Provider", version: "0.1.0-demo", features: ["Semantic analysis","Confidence scoring","Advanced transforms"], transformationTypes: ["direct","lookup","calculation","concatenation","conditional"] };
  }
  async suggest(_s: string,_t: string, sampleData: unknown[]): Promise<AISuggestion[]> { const headers = sampleData[0]? Object.keys(sampleData[0]):[]; return headers.map(h=>({ sourceField:h,targetField:h,transformationType:"direct" })); }
  async assessQuality(s: AISuggestion[]): Promise<AIQualityReport> { return { overallScore: s.length?0.85:0, totalMappings: s.length }; }
  async testConnection(): Promise<{ ok: boolean; message?: string }> { if (!this.config.model) return { ok:false, message:"Cloud model not set" }; this.logger.info("Cloud AI test executed",{ model:this.config.model }); return { ok:true, message:`Cloud provider '${this.config.model}' reachable (demo)` }; }
}

