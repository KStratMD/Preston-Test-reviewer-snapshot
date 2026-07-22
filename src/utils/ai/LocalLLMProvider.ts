import type { Logger } from "../Logger";
import type { AIProvider, ProviderCapabilities, AISuggestion, AIQualityReport } from "./types";

export interface LocalLLMConfig { baseUrl?: string; model?: string }

export class LocalLLMProvider implements AIProvider {
  public readonly mode = "local-llm" as const;
  private readonly logger: Logger; private readonly config: LocalLLMConfig;
  constructor(logger: Logger, config: LocalLLMConfig = {}) { this.logger = logger; this.config = config; }
  async getCapabilities(): Promise<ProviderCapabilities> {
    return { name: "Local LLM Provider", version: "0.1.0-demo", features: ["Offline mappings"], transformationTypes: ["direct","lookup","calculation","concatenation","conditional"] };
  }
  async suggest(_s:string,_t:string,sampleData:unknown[]): Promise<AISuggestion[]>{ const headers=sampleData[0]?Object.keys(sampleData[0]):[]; return headers.map(h=>({ sourceField:h,targetField:h,transformationType:"direct" })); }
  async assessQuality(s:AISuggestion[]): Promise<AIQualityReport>{ return { overallScore: s.length?0.8:0, totalMappings: s.length }; }
  async testConnection(): Promise<{ok:boolean;message?:string}>{ if(!this.config.baseUrl) return { ok:false, message:"Local base URL not set" }; this.logger.info("Local LLM test executed",{ baseUrl:this.config.baseUrl, model:this.config.model }); return { ok:true, message:`Local LLM at ${this.config.baseUrl} (demo)` }; }
}

