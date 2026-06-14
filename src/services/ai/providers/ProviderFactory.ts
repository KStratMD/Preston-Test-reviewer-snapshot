/**
 * Enhanced Provider Factory - Week 9 Real AI Integration
 * Intelligent routing between OpenAI, Claude, Gemini, LMStudio, and OpenRouter providers
 * with cost tracking and performance monitoring.
 */

import type { Logger } from '../../../utils/Logger';
import type { AIProvider, AISuggestion, AIQualityReport } from './types';
import { OpenAIProvider, type OpenAIConfig } from './OpenAIProvider';
import { ClaudeProvider, type ClaudeConfig } from './ClaudeProvider';
import { GeminiProvider, type GeminiConfig } from './GeminiProvider';
import { LMStudioProvider, type LMStudioConfig } from './LMStudioProvider';
import { OpenRouterProvider, type OpenRouterConfig } from './OpenRouterProvider';
import { OutboundGovernanceService } from '../../governance/OutboundGovernanceService';

export type AIProviderType = 'openai' | 'claude' | 'gemini' | 'lmstudio' | 'openrouter' | 'rule-based';
export type AIProviderTier = 'default' | 'premium' | 'economy' | 'local';

export interface ProviderConfig {
  tier: AIProviderTier;
  sessionBudget?: number; // In USD, default $0.20
  fallbackTier?: AIProviderTier;
  providers: {
    openai?: OpenAIConfig;
    claude?: ClaudeConfig;
    gemini?: GeminiConfig;
    lmstudio?: LMStudioConfig;
    openrouter?: OpenRouterConfig;
  };
}

export interface ProviderPerformanceMetrics {
  averageResponseTime: number;
  successRate: number;
  averageCost: number;
  totalRequests: number;
  lastUpdateTime: number;
}

export interface ProviderExecutionResult<T> {
  providerType: AIProviderType;
  result: T;
  costDelta: number;
}

export class ProviderFactory {
  private providers = new Map<AIProviderType, AIProvider>();
  private performanceMetrics = new Map<AIProviderType, ProviderPerformanceMetrics>();
  private sessionCosts = new Map<AIProviderType, number>();
  private currentConfig?: ProviderConfig;

  constructor(
    private logger: Logger,
    private outboundGovernance: OutboundGovernanceService
  ) {}

  /**
   * Initialize AI providers based on configuration
   */
  async configure(config: ProviderConfig): Promise<void> {
    this.currentConfig = config;
    await this.initializeProviders(config);

    // Test connectivity for all configured providers
    const connectivityTests = Array.from(this.providers.entries()).map(async ([type, provider]) => {
      try {
        const result = await provider.testConnection();
        this.logger.info(`Provider ${type} connectivity test`, result);
        return { type, available: result.ok };
      } catch (error) {
        this.logger.warn(`Provider ${type} connectivity failed`, { error: error.message });
        return { type, available: false };
      }
    });

    const results = await Promise.all(connectivityTests);
    const availableProviders = results.filter(r => r.available).map(r => r.type);

    this.logger.info('Provider factory configured', {
      tier: config.tier,
      sessionBudget: this.getConfiguredSessionBudget(config),
      availableProviders,
      fallbackTier: config.fallbackTier
    });
  }

  private async initializeProviders(config: ProviderConfig): Promise<void> {
    this.providers.clear();
    this.sessionCosts.clear();

    // Initialize OpenAI provider if configured
    if (config.providers.openai) {
      const openaiProvider = new OpenAIProvider(this.logger, config.providers.openai, this.outboundGovernance);
      this.providers.set('openai', openaiProvider);
      this.sessionCosts.set('openai', 0);
      this.initializeMetrics('openai');
    }

    // Initialize Claude provider if configured
    if (config.providers.claude) {
      const claudeProvider = new ClaudeProvider(this.logger, config.providers.claude, this.outboundGovernance);
      this.providers.set('claude', claudeProvider);
      this.sessionCosts.set('claude', 0);
      this.initializeMetrics('claude');
    }

    // Initialize Gemini provider if configured
    if (config.providers.gemini) {
      const geminiProvider = new GeminiProvider(this.logger, config.providers.gemini, this.outboundGovernance);
      this.providers.set('gemini', geminiProvider);
      this.sessionCosts.set('gemini', 0);
      this.initializeMetrics('gemini');
    }

    // Initialize LMStudio provider if configured
    if (config.providers.lmstudio) {
      const lmstudioProvider = new LMStudioProvider(this.logger, config.providers.lmstudio, this.outboundGovernance);
      this.providers.set('lmstudio', lmstudioProvider);
      this.sessionCosts.set('lmstudio', 0);
      this.initializeMetrics('lmstudio');
    }

    // Initialize OpenRouter provider if configured
    if (config.providers.openrouter) {
      const openrouterProvider = new OpenRouterProvider(this.logger, config.providers.openrouter, this.outboundGovernance);
      this.providers.set('openrouter', openrouterProvider);
      this.sessionCosts.set('openrouter', 0);
      this.initializeMetrics('openrouter');
    }

    this.logger.info('AI providers initialized', {
      configuredProviders: Array.from(this.providers.keys()),
      tier: config.tier,
      sessionBudget: this.getConfiguredSessionBudget(config)
    });
  }

  private initializeMetrics(providerType: AIProviderType): void {
    this.performanceMetrics.set(providerType, {
      averageResponseTime: 0,
      successRate: 1.0,
      averageCost: 0,
      totalRequests: 0,
      lastUpdateTime: Date.now()
    });
  }

  /**
   * Get the optimal provider based on intelligent routing
   */
  getOptimalProvider(context?: {
    complexity?: 'low' | 'medium' | 'high';
    urgency?: 'low' | 'medium' | 'high';
    dataSize?: number;
  }): AIProvider {
    if (!this.currentConfig) {
      throw new Error('Provider factory not configured');
    }

    const sessionBudget = this.getConfiguredSessionBudget();
    const tier = this.currentConfig.tier;

    // Check session budget constraints
    const totalSessionCost = Array.from(this.sessionCosts.values()).reduce((sum, cost) => sum + cost, 0);
    if (totalSessionCost >= sessionBudget) {
      const localTierProvider = this.getProviderForTier('local');
      const routedProviderType = this.getProviderType(localTierProvider);
      this.logBudgetGuardRouting(sessionBudget, totalSessionCost, routedProviderType);
      return localTierProvider;
    }

    // Intelligent routing based on tier and context
    let targetTier = tier;

    if (context?.complexity === 'high' && tier !== 'premium') {
      targetTier = 'premium';
    } else if (context?.urgency === 'high' && context?.complexity === 'low') {
      targetTier = 'economy';
    }

    return this.getProviderForTier(targetTier);
  }

  private getProviderForTier(tier: AIProviderTier): AIProvider {
    return this.getProviderForTierInternal(tier, new Set<AIProviderTier>());
  }

  getProviderByType(providerType: AIProviderType): AIProvider {
    const provider = this.providers.get(providerType);
    if (!provider) {
      throw new Error(`Provider ${providerType} not configured`);
    }

    if (!provider.isAvailable) {
      throw new Error(`Provider ${providerType} not available`);
    }

    return provider;
  }

  async executeFieldMappingWithProvider(
    providerType: AIProviderType,
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[],
  ): Promise<ProviderExecutionResult<AISuggestion[]>> {
    const resolvedProviderType = this.resolveProviderTypeForExecution(providerType);
    const provider = this.getProviderByType(resolvedProviderType);
    const initialCost = this.sessionCosts.get(resolvedProviderType) || 0;
    const startTime = Date.now();

    try {
      const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);
      await this.updateMetrics(resolvedProviderType, startTime, true, provider);
      const finalCost = this.sessionCosts.get(resolvedProviderType) || 0;
      return {
        providerType: resolvedProviderType,
        result: suggestions,
        costDelta: Math.max(0, finalCost - initialCost),
      };
    } catch (error) {
      await this.updateMetrics(resolvedProviderType, startTime, false, provider);
      throw error;
    }
  }

  async executeQualityAssessmentWithProvider(
    providerType: AIProviderType,
    suggestions: AISuggestion[],
  ): Promise<ProviderExecutionResult<AIQualityReport>> {
    const resolvedProviderType = this.resolveProviderTypeForExecution(providerType);
    const provider = this.getProviderByType(resolvedProviderType);
    const initialCost = this.sessionCosts.get(resolvedProviderType) || 0;
    const startTime = Date.now();

    try {
      const report = await provider.assessQuality(suggestions);
      await this.updateMetrics(resolvedProviderType, startTime, true, provider);
      const finalCost = this.sessionCosts.get(resolvedProviderType) || 0;
      return {
        providerType: resolvedProviderType,
        result: report,
        costDelta: Math.max(0, finalCost - initialCost),
      };
    } catch (error) {
      await this.updateMetrics(resolvedProviderType, startTime, false, provider);
      throw error;
    }
  }

  /**
   * Execute field mapping with cost tracking and performance monitoring
   */
  async executeFieldMapping(
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[],
    context?: {
      complexity?: 'low' | 'medium' | 'high';
      urgency?: 'low' | 'medium' | 'high';
      dataSize?: number;
    }
  ): Promise<AISuggestion[]> {
    const provider = this.getOptimalProvider(context);
    const startTime = Date.now();

    try {
      const suggestions = await provider.suggest(sourceSystem, targetSystem, sampleData);

      // Track performance and costs
      await this.updateMetrics(this.getProviderType(provider), startTime, true, provider);

      return suggestions;
    } catch (error) {
      await this.updateMetrics(this.getProviderType(provider), startTime, false, provider);
      throw error;
    }
  }

  /**
   * Execute quality assessment with tracking
   */
  async executeQualityAssessment(
    suggestions: AISuggestion[],
    context?: {
      complexity?: 'low' | 'medium' | 'high';
      urgency?: 'low' | 'medium' | 'high';
    }
  ): Promise<AIQualityReport> {
    const provider = this.getOptimalProvider(context);
    const startTime = Date.now();

    try {
      const report = await provider.assessQuality(suggestions);

      // Track performance and costs
      await this.updateMetrics(this.getProviderType(provider), startTime, true, provider);

      return report;
    } catch (error) {
      await this.updateMetrics(this.getProviderType(provider), startTime, false, provider);
      throw error;
    }
  }

  private getProviderType(provider: AIProvider): AIProviderType {
    for (const [type, p] of this.providers.entries()) {
      if (p === provider) return type;
    }
    return 'openai';
  }

  private async updateMetrics(
    providerType: AIProviderType,
    startTime: number,
    success: boolean,
    provider: AIProvider
  ): Promise<void> {
    const responseTime = Date.now() - startTime;
    const metrics = this.performanceMetrics.get(providerType);

    if (metrics) {
      metrics.totalRequests++;
      metrics.averageResponseTime = (metrics.averageResponseTime + responseTime) / 2;
      metrics.successRate = (metrics.successRate + (success ? 1 : 0)) / 2;
      metrics.lastUpdateTime = Date.now();

      // Track costs if provider supports it
      if ('getLastTokenUsage' in provider) {
        const usage = (provider as any).getLastTokenUsage();
        if (usage?.estimatedCost) {
          const currentSessionCost = this.sessionCosts.get(providerType) || 0;
          this.sessionCosts.set(providerType, currentSessionCost + usage.estimatedCost);
          metrics.averageCost = (metrics.averageCost + usage.estimatedCost) / 2;
        }
      }
    }
  }

  /**
   * Get all available providers with performance metrics
   */
  getAvailableProviders(): {
    type: AIProviderType;
    provider: AIProvider;
    metrics: ProviderPerformanceMetrics;
    sessionCost: number;
  }[] {
    return Array.from(this.providers.entries())
      .filter(([_, provider]) => provider.isAvailable)
      .map(([type, provider]) => ({
        type,
        provider,
        metrics: this.performanceMetrics.get(type) || this.getDefaultMetrics(),
        sessionCost: this.sessionCosts.get(type) || 0
      }));
  }

  private getDefaultMetrics(): ProviderPerformanceMetrics {
    return {
      averageResponseTime: 0,
      successRate: 1.0,
      averageCost: 0,
      totalRequests: 0,
      lastUpdateTime: Date.now()
    };
  }

  /**
   * Get session cost summary
   */
  getSessionCostSummary(): {
    totalCost: number;
    budgetRemaining: number;
    costsByProvider: Record<string, number>;
    budgetUtilization: number;
  } {
    const totalCost = Array.from(this.sessionCosts.values()).reduce((sum, cost) => sum + cost, 0);
    const budget = this.getConfiguredSessionBudget();

    return {
      totalCost,
      budgetRemaining: Math.max(0, budget - totalCost),
      costsByProvider: Object.fromEntries(this.sessionCosts.entries()),
      budgetUtilization: budget > 0 ? totalCost / budget : 1
    };
  }

  /**
   * Get intelligent routing recommendations
   */
  getRoutingRecommendations(context?: {
    complexity?: 'low' | 'medium' | 'high';
    urgency?: 'low' | 'medium' | 'high';
    dataSize?: number;
  }): {
    recommendedProvider: AIProviderType;
    reasoning: string;
    alternativeProviders: AIProviderType[];
    costEstimate: number;
  } {
    const sessionSummary = this.getSessionCostSummary();
    const availableProviders = this.getAvailableProviders();
    const availableProviderTypes = new Set(availableProviders.map(provider => provider.type));

    let recommendedProvider: AIProviderType = 'openai';
    let reasoning: string;

    if (sessionSummary.budgetUtilization > 0.8) {
      recommendedProvider = this.selectRecommendedProvider(
        ['lmstudio', 'gemini', 'openrouter', 'openai', 'claude'],
        availableProviderTypes,
        'lmstudio',
      );
      reasoning = this.getRecommendationReason('budget', recommendedProvider);
    } else if (context?.complexity === 'high') {
      recommendedProvider = this.selectRecommendedProvider(
        ['claude', 'openrouter', 'openai', 'gemini', 'lmstudio'],
        availableProviderTypes,
        'claude',
      );
      reasoning = this.getRecommendationReason('complexity', recommendedProvider);
    } else if (context?.urgency === 'high' && context?.complexity === 'low') {
      recommendedProvider = this.selectRecommendedProvider(
        ['gemini', 'openrouter', 'openai', 'lmstudio', 'claude'],
        availableProviderTypes,
        'gemini',
      );
      reasoning = this.getRecommendationReason('urgency', recommendedProvider);
    } else {
      recommendedProvider = this.selectRecommendedProvider(
        ['openai', 'openrouter', 'claude', 'gemini', 'lmstudio'],
        availableProviderTypes,
        'openai',
      );
      reasoning = this.getRecommendationReason('default', recommendedProvider);
    }

    const alternatives = availableProviders
      .map(p => p.type)
      .filter(type => type !== recommendedProvider);

    const provider = this.providers.get(recommendedProvider);
    let costEstimate = 0;
    if (provider && 'getCostEstimate' in provider) {
      costEstimate = (provider as any).getCostEstimate('typical request').cost;
    }

    return {
      recommendedProvider,
      reasoning,
      alternativeProviders: alternatives,
      costEstimate
    };
  }

  /**
   * Reset session costs
   */
  resetSessionCosts(): void {
    this.sessionCosts.clear();
    for (const providerType of this.providers.keys()) {
      this.sessionCosts.set(providerType, 0);
    }
    this.logger.info('Session costs reset');
  }

  private getProviderForTierInternal(tier: AIProviderTier, attemptedTiers: Set<AIProviderTier>): AIProvider {
    const preferredProviders = this.getPreferredProviderTypesForTier(tier);
    const preferredMatch = this.getFirstAvailableProvider(preferredProviders);

    if (preferredMatch) {
      if (preferredMatch.type !== preferredProviders[0]) {
        this.logger.warn(`Using fallback provider: ${preferredMatch.type}`);
      }
      return preferredMatch.provider;
    }

    const nextAttemptedTiers = new Set(attemptedTiers);
    nextAttemptedTiers.add(tier);

    const fallbackTier = this.currentConfig?.fallbackTier;
    if (fallbackTier && fallbackTier !== tier && !nextAttemptedTiers.has(fallbackTier)) {
      return this.getProviderForTierInternal(fallbackTier, nextAttemptedTiers);
    }

    const ultimateFallback = this.getFirstAvailableProvider(Array.from(this.providers.keys()));
    if (ultimateFallback) {
      this.logger.warn(`Using fallback provider: ${ultimateFallback.type}`);
      return ultimateFallback.provider;
    }

    throw new Error('No AI provider available');
  }

  private getPreferredProviderTypesForTier(tier: AIProviderTier): AIProviderType[] {
    switch (tier) {
      case 'premium':
        return ['claude', 'openrouter', 'openai', 'gemini', 'lmstudio'];
      case 'economy':
        return ['gemini', 'openrouter', 'openai', 'lmstudio', 'claude'];
      case 'local':
        return ['lmstudio', 'openai', 'gemini', 'openrouter', 'claude'];
      case 'default':
      default:
        return ['openai', 'openrouter', 'claude', 'gemini', 'lmstudio'];
    }
  }

  private getFirstAvailableProvider(providerTypes: AIProviderType[]): {
    type: AIProviderType;
    provider: AIProvider;
  } | null {
    for (const providerType of providerTypes) {
      const provider = this.providers.get(providerType);
      if (provider?.isAvailable) {
        return { type: providerType, provider };
      }
    }

    return null;
  }

  private selectRecommendedProvider(
    preferredProviders: AIProviderType[],
    availableProviders: Set<AIProviderType>,
    fallbackProvider: AIProviderType,
  ): AIProviderType {
    const preferredAvailable = preferredProviders.find(provider => availableProviders.has(provider));
    if (preferredAvailable) {
      return preferredAvailable;
    }

    if (availableProviders.size === 0) {
      this.logger.warn('No available providers found; returning fallback provider type as last resort', {
        fallbackProvider,
      });
      return fallbackProvider;
    }

    if (availableProviders.has(fallbackProvider)) {
      return fallbackProvider;
    }

    const firstAvailable = availableProviders.values().next();
    if (!firstAvailable.done) {
      return firstAvailable.value;
    }

    return fallbackProvider;
  }

  private resolveProviderTypeForExecution(providerType: AIProviderType): AIProviderType {
    const sessionBudget = this.getConfiguredSessionBudget();
    const totalSessionCost = Array.from(this.sessionCosts.values()).reduce((sum, cost) => sum + cost, 0);

    if (totalSessionCost >= sessionBudget) {
      const localTierProvider = this.getProviderForTier('local');
      const routedProviderType = this.getProviderType(localTierProvider);
      this.logBudgetGuardRouting(sessionBudget, totalSessionCost, routedProviderType);
      return routedProviderType;
    }

    return providerType;
  }

  private getConfiguredSessionBudget(config: ProviderConfig | undefined = this.currentConfig): number {
    const sessionBudget = config?.sessionBudget;

    if (sessionBudget == null || !Number.isFinite(sessionBudget)) {
      return 0.20;
    }

    return Math.max(0, sessionBudget);
  }

  private logBudgetGuardRouting(
    sessionBudget: number,
    totalSessionCost: number,
    routedProviderType: AIProviderType,
  ): void {
    const logContext = {
      configuredSessionBudget: sessionBudget,
      totalSessionCost,
      routedProviderType,
    };

    if (sessionBudget === 0) {
      this.logger.debug('Cloud budget disabled; routing via local tier fallback provider', logContext);
      return;
    }

    this.logger.warn('Session budget limit reached; routing via local tier fallback provider', logContext);
  }

  private getRecommendationReason(
    scenario: 'budget' | 'complexity' | 'urgency' | 'default',
    providerType: AIProviderType,
  ): string {
    const providerName = this.getProviderLabel(providerType);

    switch (scenario) {
      case 'budget':
        if (providerType === 'lmstudio') {
          return 'Budget threshold exceeded - routing to local provider';
        }
        if (providerType === 'gemini') {
          return 'Budget threshold exceeded - routing to Gemini as the lowest-cost cloud fallback';
        }
        if (providerType === 'openrouter') {
          return 'Budget threshold exceeded - routing to OpenRouter as a cost-effective cloud fallback provider';
        }
        return `Budget threshold exceeded - local provider unavailable, routing to ${providerName} as the next available provider`;
      case 'complexity':
        if (providerType === 'claude') {
          return 'High complexity task - using premium provider for best results';
        }
        if (providerType === 'openrouter') {
          return 'High complexity task - using OpenRouter for premium multi-model coverage';
        }
        return `High complexity task - preferred premium providers unavailable, routing to ${providerName}`;
      case 'urgency':
        if (providerType === 'gemini') {
          return 'High urgency, low complexity - using fast economy provider';
        }
        if (providerType === 'openrouter') {
          return 'High urgency, low complexity - using OpenRouter as the fastest available cloud fallback';
        }
        return `High urgency, low complexity - preferred fast providers unavailable, routing to ${providerName}`;
      case 'default':
      default:
        if (providerType === 'openai') {
          return 'Default provider selection';
        }
        if (providerType === 'openrouter') {
          return 'Default provider unavailable - using OpenRouter as the primary cloud fallback';
        }
        return `Default provider unavailable - routing to ${providerName}`;
    }
  }

  private getProviderLabel(providerType: AIProviderType): string {
    switch (providerType) {
      case 'openai':
        return 'OpenAI';
      case 'claude':
        return 'Claude';
      case 'gemini':
        return 'Gemini';
      case 'lmstudio':
        return 'LMStudio';
      case 'openrouter':
        return 'OpenRouter';
      case 'rule-based':
      default:
        return 'Rule-based';
    }
  }
}
