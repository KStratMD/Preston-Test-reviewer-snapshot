/**
 * AI Provider Registry - Centralized management of AI providers
 * Implements ADR-002: AI Provider Registry and Dynamic Dispatch
 */

import { injectable, inject } from "inversify";
import { TYPES } from "../../inversify/types";
import type { Logger } from "../../utils/Logger";

export interface AIProvider {
  readonly name: string;
  readonly version: string;
  testConnection(): Promise<{ ok: boolean; message?: string }>;
  generateMappingSuggestions(context: MappingContext): Promise<AISuggestion[]>;
  analyzeDataQuality(data: unknown[], context: DataContext): Promise<QualityAssessment>;
}

export interface MappingContext {
  sourceSystem: string;
  targetSystem: string;
  sourceFields: FieldDefinition[];
  targetFields: FieldDefinition[];
  sampleData?: unknown[];
  industry?: string;
  businessProcess?: string;
  datasetId?: string;
}

export interface FieldDefinition {
  name: string;
  type: string;
  description?: string;
  required?: boolean;
  sampleValues?: unknown[];
}

export interface AISuggestion {
  sourceField: string;
  sourceFields?: string[]; // For multi-field mappings (e.g., firstName + lastName → fullName)
  targetField: string;
  confidence: number;
  transformationType: "direct" | "lookup" | "calculation" | "concatenation" | "conditional";
  reasoning: string;
  alternatives?: AISuggestion[];
}

export interface DataContext {
  sourceSystem: string;
  businessPurpose: string;
  schema: FieldDefinition[];
}

export interface QualityAssessment {
  overallScore: number;
  issues: QualityIssue[];
  recommendations: string[];
}

export interface QualityIssue {
  field: string;
  severity: "low" | "medium" | "high";
  type: "completeness" | "consistency" | "accuracy" | "validity";
  message: string;
  suggestion: string;
}

@injectable()
export class ProviderRegistry {
  private providers = new Map<string, AIProvider>();
  private fallbackOrder: string[] = [];
  private providerHealthCache = new Map<string, { result: { ok: boolean; message?: string }; checkedAt: number }>();
  private providerHealthTTL = 5 * 60 * 1000; // 5 minutes

  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Register an AI provider
   */
  register(providerId: string, provider: AIProvider): void {
    this.providers.set(providerId, provider);
    this.providerHealthCache.delete(providerId);
    this.logger.info(`AI provider registered: ${providerId}`, {
      name: provider.name,
      version: provider.version,
    });
  }

  /**
   * Set fallback order for providers
   */
  setFallbackOrder(order: string[]): void {
    this.fallbackOrder = order;
    this.logger.info("AI provider fallback order set", { order });
  }

  getFallbackOrder(): string[] {
    return [...this.fallbackOrder];
  }

  /**
   * Get a specific provider
   */
  getProvider(providerId: string): AIProvider | null {
    return this.providers.get(providerId) || null;
  }

  /**
   * Get provider with fallback logic
   */
  async getAvailableProvider(preferredId?: string): Promise<{ provider: AIProvider; id: string } | null> {
    // Try preferred provider first
    if (preferredId) {
      this.logger.info(`🔍 Attempting to get preferred provider: ${preferredId}`);
      const provider = this.providers.get(preferredId);
      if (provider) {
        this.logger.info(`✅ Provider ${preferredId} found in registry, testing health...`);
        const test = await this.getHealthStatus(provider, preferredId);
        this.logger.info(`Health test result for ${preferredId}:`, { ok: test.ok, message: test.message });
        if (test.ok) {
          this.logger.info(`✅ Using preferred provider: ${preferredId}`);
          return { provider, id: preferredId };
        } else {
          this.logger.warn(`❌ Preferred provider ${preferredId} health check failed, trying fallback`);
        }
      } else {
        this.logger.warn(`❌ Preferred provider ${preferredId} not found in registry`);
      }
    }

    // Try fallback order
    for (const providerId of this.fallbackOrder) {
      const provider = this.providers.get(providerId);
      if (!provider) {
        continue;
      }
      const test = await this.getHealthStatus(provider, providerId);
      if (test.ok) {
        return { provider, id: providerId };
      }
    }

    // Try any available provider
    for (const [providerId, provider] of this.providers) {
      const test = await this.getHealthStatus(provider, providerId);
      if (test.ok) {
        return { provider, id: providerId };
      }
    }

    return null;
  }

  /**
   * List all registered providers
   */
  listProviders(): { id: string; name: string; version: string; available: boolean }[] {
    return Array.from(this.providers.entries()).map(([id, provider]) => ({
      id,
      name: provider.name,
      version: provider.version,
      available: this.providerHealthCache.get(id)?.result.ok ?? true,
    }));
  }

  /**
   * Test provider connectivity
   */
  private async testProvider(provider: AIProvider, providerId: string): Promise<{ ok: boolean; message?: string }> {
    try {
      const result = await provider.testConnection();
      if (!result.ok) {
        this.logger.warn(`Provider ${providerId} test failed`, { message: result.message });
      }
      return result;
    } catch (error) {
      this.logger.error(`Provider ${providerId} test error`, { error: String(error) });
      return { ok: false, message: `Connection test failed: ${error}` };
    }
  }

  private async getHealthStatus(provider: AIProvider, providerId: string): Promise<{ ok: boolean; message?: string }> {
    const cached = this.providerHealthCache.get(providerId);
    if (cached && Date.now() - cached.checkedAt < this.providerHealthTTL) {
      return cached.result;
    }

    const result = await this.testProvider(provider, providerId);
    this.providerHealthCache.set(providerId, { result, checkedAt: Date.now() });
    return result;
  }
}
