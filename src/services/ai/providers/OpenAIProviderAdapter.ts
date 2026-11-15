/**
 * OpenAI Provider Adapter
 * Bridges OpenAIProvider to ProviderRegistry contract with confidence heuristics.
 */
import { logger, type Logger } from '../../../utils/Logger';
import { OpenAIProvider } from './OpenAIProvider';
import type {
  AIProvider as RegistryProvider,
  MappingContext,
  AISuggestion,
  DataContext,
  QualityAssessment,
  FieldDefinition
} from '../ProviderRegistry';

export class OpenAIProviderAdapter implements RegistryProvider {
  public readonly name: string;
  public readonly version: string;
  private lastEstimatedTokens: number | undefined;
  private lastEstimatedCost: number | undefined;

  constructor(private readonly logger: Logger, private readonly openai: OpenAIProvider) {
    this.name = `OpenAI LLM`;
    this.version = openai.version || 'unknown';
  }

  async testConnection(): Promise<{ ok: boolean; message?: string }> {
    try {
      return await this.openai.testConnection();
    } catch (e) {
      return { ok: false, message: String(e) };
    }
  }

  async generateMappingSuggestions(context: MappingContext): Promise<AISuggestion[]> {
    const synthetic = context.sampleData && context.sampleData.length > 0
      ? context.sampleData
      : [this.syntheticRecord(context.sourceFields)];

    const raw = await this.openai.suggest(context.sourceSystem, context.targetSystem, synthetic);

    let quality = 0.75;
    try {
      const q = await this.openai.assessQuality(raw as any);
      if (q && typeof q.overallScore === 'number') quality = q.overallScore;
    } catch (err) {
      this.logger.debug('OpenAI quality assessment failed (non-fatal)', { error: String(err) });
    }

    const limited = raw.slice(0, 50).map((s, i) => ({
      sourceField: s.sourceField,
      targetField: s.targetField,
      confidence: Number(Math.max(0.1, quality - i * 0.02).toFixed(3)),
      transformationType: (s as any).transformationType || 'direct',
      reasoning: `OpenAI semantic mapping rank ${i + 1}`,
      alternatives: [] as AISuggestion[]
    }));

    // Attempt to derive usage metrics from underlying provider if exposed
    try {
      const usage: unknown = (this.openai as any).getLastTokenUsage?.();
      if (usage && (usage as any).totalTokens) {
        this.lastEstimatedTokens = (usage as any).totalTokens;
        this.lastEstimatedCost = (usage as any).estimatedCost ?? ((usage as any).totalTokens * 0.00003 * 1.5);
      } else {
        // Fallback heuristic: size of limited suggestions JSON ~4 chars per token average
        const approxTokens = Math.ceil(JSON.stringify(limited).length / 4);
        this.lastEstimatedTokens = approxTokens;
        this.lastEstimatedCost = approxTokens * 0.00003 * 1.5;
      }
    } catch (err) {
      this.logger.debug('Failed to capture token usage (non-fatal)', { error: String(err) });
    }

    return limited;
  }

  async analyzeDataQuality(data: unknown[], context: DataContext): Promise<QualityAssessment> {
    if (!data || data.length === 0) {
      return {
        overallScore: 0.2,
        issues: [{
          field: 'dataset', severity: 'high', type: 'completeness', message: 'No data provided', suggestion: 'Add sample records'
        }],
        recommendations: ['Provide representative sample records']
      };
    }
    const fields = Object.keys(data[0] as Record<string, unknown>);
    const issues: QualityAssessment['issues'] = [];
    fields.forEach(f => {
      const nulls = data.filter(r => (r as Record<string, unknown>)[f] == null).length;
      if (nulls / data.length > 0.2) {
        issues.push({
          field: f,
          severity: nulls / data.length > 0.5 ? 'high' : 'medium',
          type: 'completeness',
          message: `${nulls}/${data.length} null values`,
          suggestion: 'Clean / backfill'
        });
      }
    });
    const score = Math.max(0, 1 - issues.length * 0.05);
    return { overallScore: Number(score.toFixed(3)), issues, recommendations: issues.length ? ['Address quality issues'] : ['Data appears clean'] };
  }

  private syntheticRecord(fields: FieldDefinition[]): unknown {
    const rec: Record<string, unknown> = {};
    fields.slice(0, 8).forEach(f => { rec[f.name] = this.exampleValue(f.type); });
    return rec;
  }
  private exampleValue(t: string): unknown {
    switch (t.toLowerCase()) {
      case 'number':
      case 'integer': return 42;
      case 'date': return new Date().toISOString();
      case 'boolean': return true;
      default: return 'sample';
    }
  }

  /**
   * Expose last estimated usage metrics so routes / services can record cost.
   */
  public getUsageMetrics(): { tokens: number; cost: number } | undefined {
    if (this.lastEstimatedTokens != null && this.lastEstimatedCost != null) {
      return { tokens: this.lastEstimatedTokens, cost: this.lastEstimatedCost };
    }
    return undefined;
  }
}
