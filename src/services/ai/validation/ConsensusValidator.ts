/**
 * Consensus Validator - Phase 2 AI Accuracy Improvements
 * Uses multiple AI providers to cross-validate suggestions
 * Agreement between providers = higher confidence
 * Disagreement = flag for human review
 */

import type { AISuggestion } from '../providers/types';
import type { AIProvider } from '../providers/types';
import { logger } from '../../../utils/Logger';

export interface ConsensusResult {
  suggestion: AISuggestion;
  providerCount: number; // How many providers suggested this mapping
  agreementScore: number; // 0-100, percentage of providers that agree
  providers: string[]; // Which providers suggested this mapping
  alternativeMappings: AISuggestion[]; // Alternative suggestions from other providers
}

export interface ConsensusConfig {
  minProviderCount?: number; // Minimum providers that must agree (default: 2)
  minAgreementScore?: number; // Minimum agreement percentage (default: 50%)
  boostConfidenceOnAgreement?: boolean; // Boost confidence when multiple providers agree (default: true)
}

export class ConsensusValidator {
  private logger = logger;

  constructor(private config: ConsensusConfig = {}) {
    // Set defaults
    this.config = {
      minProviderCount: 2,
      minAgreementScore: 50,
      boostConfidenceOnAgreement: true,
      ...config
    };
  }

  /**
   * Get suggestions from multiple providers and find consensus
   */
  async getConsensusSuggestions(
    providers: AIProvider[],
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[]
  ): Promise<ConsensusResult[]> {
    if (providers.length < 2) {
      this.logger.warn('Consensus requires at least 2 providers', {
        providersAvailable: providers.length
      });
      return [];
    }

    try {
      // Get suggestions from all providers in parallel
      const providerSuggestions = await Promise.all(
        providers.map(async provider => {
          try {
            const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
            return {
              providerName: (provider as any).name || 'unknown',
              suggestions
            };
          } catch (error) {
            this.logger.warn('Provider failed during consensus', {
              provider: (provider as any).name,
              error: error.message
            });
            return {
              providerName: (provider as any).name || 'unknown',
              suggestions: []
            };
          }
        })
      );

      // Build consensus map: sourceField -> targetField -> providers that suggested it
      const consensusMap = new Map<string, Map<string, {
        providers: string[];
        suggestions: AISuggestion[];
      }>>();

      providerSuggestions.forEach(({ providerName, suggestions }) => {
        suggestions.forEach(suggestion => {
          if (!consensusMap.has(suggestion.sourceField)) {
            consensusMap.set(suggestion.sourceField, new Map());
          }

          const targetMap = consensusMap.get(suggestion.sourceField)!;
          if (!targetMap.has(suggestion.targetField)) {
            targetMap.set(suggestion.targetField, {
              providers: [],
              suggestions: []
            });
          }

          const entry = targetMap.get(suggestion.targetField)!;
          entry.providers.push(providerName);
          entry.suggestions.push(suggestion);
        });
      });

      // Build consensus results
      const consensusResults: ConsensusResult[] = [];
      const totalProviders = providerSuggestions.filter(p => p.suggestions.length > 0).length;

      consensusMap.forEach((targetMap, sourceField) => {
        const allTargets = Array.from(targetMap.entries());

        // Find the mapping with highest agreement
        allTargets.forEach(([targetField, entry]) => {
          const providerCount = entry.providers.length;
          const agreementScore = (providerCount / totalProviders) * 100;

          // Get the best suggestion (highest confidence if available)
          const bestSuggestion = entry.suggestions.reduce((best, current) => {
            const bestConf = best.confidence || 70;
            const currentConf = current.confidence || 70;
            return currentConf > bestConf ? current : best;
          }, entry.suggestions[0]);

          // Find alternative mappings (different target fields for same source)
          const alternatives = allTargets
            .filter(([target]) => target !== targetField)
            .map(([_, altEntry]) => altEntry.suggestions[0]);

          // Apply confidence boost if multiple providers agree
          let finalConfidence = bestSuggestion.confidence || 70;
          if (this.config.boostConfidenceOnAgreement && providerCount >= 2) {
            // Boost confidence by 5% per additional provider (max +15%)
            const boost = Math.min((providerCount - 1) * 5, 15);
            finalConfidence = Math.min(100, finalConfidence + boost);
          }

          consensusResults.push({
            suggestion: {
              ...bestSuggestion,
              confidence: finalConfidence,
              reasoning: this.buildConsensusReasoning(bestSuggestion.reasoning, entry.providers, providerCount, totalProviders)
            },
            providerCount,
            agreementScore,
            providers: entry.providers,
            alternativeMappings: alternatives
          });
        });
      });

      // Filter by consensus requirements
      const filtered = consensusResults.filter(result => {
        const meetsProviderCount = result.providerCount >= (this.config.minProviderCount || 2);
        const meetsAgreementScore = result.agreementScore >= (this.config.minAgreementScore || 50);
        return meetsProviderCount || meetsAgreementScore;
      });

      // Sort by agreement score (highest first)
      filtered.sort((a, b) => b.agreementScore - a.agreementScore);

      this.logger.info('Consensus validation completed', {
        totalProviders,
        totalSuggestions: consensusResults.length,
        consensusSuggestions: filtered.length,
        averageAgreement: filtered.length > 0
          ? filtered.reduce((sum, r) => sum + r.agreementScore, 0) / filtered.length
          : 0
      });

      return filtered;

    } catch (error) {
      this.logger.error('Consensus validation failed', { error: error.message });
      return [];
    }
  }

  /**
   * Build consensus reasoning that includes provider agreement info
   */
  private buildConsensusReasoning(
    originalReasoning: string | undefined,
    providers: string[],
    providerCount: number,
    totalProviders: number
  ): string {
    const agreementPercent = Math.round((providerCount / totalProviders) * 100);
    const consensusNote = `[Consensus: ${providerCount}/${totalProviders} providers agree (${agreementPercent}%) - ${providers.join(', ')}]`;

    if (originalReasoning) {
      return `${originalReasoning} ${consensusNote}`;
    }

    return consensusNote;
  }

  /**
   * Compare two suggestions to see if they match
   */
  private suggestionsMatch(a: AISuggestion, b: AISuggestion): boolean {
    return a.sourceField === b.sourceField &&
           a.targetField === b.targetField &&
           a.transformationType === b.transformationType;
  }

  /**
   * Get disagreements between providers (useful for identifying tricky mappings)
   */
  findDisagreements(consensusResults: ConsensusResult[]): ConsensusResult[] {
    return consensusResults.filter(result => {
      // Disagreement = less than 75% agreement OR has alternative mappings
      const hasLowAgreement = result.agreementScore < 75;
      const hasAlternatives = result.alternativeMappings.length > 0;
      return hasLowAgreement || hasAlternatives;
    });
  }

  /**
   * Get high-confidence consensus mappings (90%+ agreement)
   */
  getHighConfidenceMappings(consensusResults: ConsensusResult[]): ConsensusResult[] {
    return consensusResults.filter(result => result.agreementScore >= 90);
  }
}
