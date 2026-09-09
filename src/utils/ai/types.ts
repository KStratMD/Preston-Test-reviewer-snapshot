export type AIProviderMode = "rule-based" | "cloud-api" | "local-llm";
export interface AISuggestion { sourceField: string; targetField: string; transformationType: string }
export interface AIQualityReport { overallScore: number; totalMappings: number }
export interface ProviderCapabilities { name: string; version: string; features: string[]; transformationTypes: string[] }
export interface AIProvider {
  readonly mode: AIProviderMode;
  getCapabilities(): Promise<ProviderCapabilities>;
  suggest(sourceSystem: string, targetSystem: string, sampleData: unknown[]): Promise<AISuggestion[]>;
  assessQuality(suggestions: AISuggestion[]): Promise<AIQualityReport>;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
}

