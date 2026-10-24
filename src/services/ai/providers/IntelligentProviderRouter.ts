/**
 * Intelligent Provider Router - Week 9 Real AI Integration
 * Advanced context-aware routing with machine learning insights and adaptive optimization.
 */

import { type Logger } from '../../../utils/Logger';
import type { AIProvider, AISuggestion, AIQualityReport } from './types';
import { ProviderFactory, type AIProviderType, type AIProviderTier, type ProviderConfig } from './ProviderFactory';
import type { OutboundGovernanceService } from '../../governance/OutboundGovernanceService';

export interface RoutingContext {
  // Task characteristics
  complexity: 'low' | 'medium' | 'high';
  urgency: 'low' | 'medium' | 'high';
  accuracy_requirement: 'standard' | 'high' | 'critical';

  // Data characteristics
  dataSize: number;
  fieldCount: number;
  dataQuality: 'clean' | 'moderate' | 'messy';

  // Business requirements
  costSensitive: boolean;
  latencyRequirement: 'relaxed' | 'moderate' | 'strict';
  privacyLevel: 'standard' | 'sensitive' | 'confidential';

  // Historical context
  previousSuccessRate?: number;
  preferredProvider?: AIProviderType;

  // Identity context
  userId?: string;
  organizationId?: string;
}

export interface RoutingDecision {
  selectedProvider: AIProviderType;
  reroutedFrom?: AIProviderType;
  confidence: number;
  reasoning: string[];
  alternativeProviders: {
    provider: AIProviderType;
    score: number;
    reasoning: string;
  }[];
  estimatedCost: number;
  estimatedLatency: number;
  riskFactors: string[];
}

export interface ProviderScore {
  provider: AIProviderType;
  score: number;
  factors: {
    capability: number;
    cost: number;
    latency: number;
    availability: number;
    privacy: number;
    track_record: number;
  };
  reasoning: string[];
}

export class IntelligentProviderRouter {
  private providerFactory: ProviderFactory;
  private initializationPromise: Promise<void>;
  private routingHistory: {
    context: RoutingContext;
    decision: RoutingDecision;
    outcome: {
      success: boolean;
      actualCost: number;
      actualLatency: number;
      qualityScore?: number;
    };
    timestamp: number;
  }[] = [];

  constructor(
    private logger: Logger,
    config: ProviderConfig,
    outboundGovernance: OutboundGovernanceService
  ) {
    this.providerFactory = new ProviderFactory(logger, outboundGovernance);
    this.initializationPromise = this.providerFactory.configure(config);
  }

  /**
   * Route request to optimal provider using intelligent analysis
   */
  async routeRequest(
    sourceSystem: string,
    targetSystem: string,
    sampleData: unknown[],
    context: RoutingContext
  ): Promise<{
    suggestions: AISuggestion[];
    decision: RoutingDecision;
    performance: {
      actualCost: number;
      actualLatency: number;
      provider: AIProviderType;
    };
  }> {
    await this.initializationPromise;
    const startTime = Date.now();

    // Analyze context and make routing decision
    const decision = await this.makeRoutingDecision(context, sampleData);

    this.logger.info('Routing decision made', {
      selectedProvider: decision.selectedProvider,
      confidence: decision.confidence,
      reasoning: decision.reasoning,
      context
    });

    try {
      // Execute the request with selected provider
      const execution = await this.providerFactory.executeFieldMappingWithProvider(
        decision.selectedProvider,
        sourceSystem,
        targetSystem,
        sampleData,
      );
      const executedProvider = execution.providerType;
      const suggestions = execution.result;
      const actualCost = execution.costDelta;
      const sessionSummary = this.providerFactory.getSessionCostSummary();
      const effectiveDecision = executedProvider === decision.selectedProvider
        ? decision
        : await this.buildReroutedDecision(
            decision,
            executedProvider,
            context,
            sampleData,
            sessionSummary,
          );

      const actualLatency = Date.now() - startTime;

      const performance = {
        actualCost,
        actualLatency,
        provider: executedProvider
      };

      // Record successful routing outcome
      this.recordRoutingOutcome(context, effectiveDecision, {
        success: true,
        actualCost,
        actualLatency
      });

      return {
        suggestions,
        decision: effectiveDecision,
        performance
      };

    } catch (error) {
      // Record failed routing outcome
      this.recordRoutingOutcome(context, decision, {
        success: false,
        actualCost: 0,
        actualLatency: Date.now() - startTime
      });

      this.logger.error('Routing execution failed', {
        selectedProvider: decision.selectedProvider,
        error: error.message,
        context
      });

      throw error;
    }
  }

  /**
   * Make intelligent routing decision based on context analysis
   */
  private async makeRoutingDecision(
    context: RoutingContext,
    sampleData: unknown[]
  ): Promise<RoutingDecision> {
    const availableProviders = this.providerFactory.getAvailableProviders();
    const sessionSummary = this.providerFactory.getSessionCostSummary();

    // Score each available provider
    const providerScores = await Promise.all(
      availableProviders.map(p => this.scoreProvider(p.type, context, sampleData))
    );

    // Sort by score (highest first)
    providerScores.sort((a, b) => b.score - a.score);

    if (providerScores.length === 0) {
      throw new Error('No providers available for routing');
    }

    const selectedScore = providerScores[0];
    const alternatives = providerScores.slice(1, 4); // Top 3 alternatives

    // Build routing decision
    const decision: RoutingDecision = {
      selectedProvider: selectedScore.provider,
      confidence: selectedScore.score,
      reasoning: selectedScore.reasoning,
      alternativeProviders: alternatives.map(score => ({
        provider: score.provider,
        score: score.score,
        reasoning: score.reasoning.join(', ')
      })),
      estimatedCost: this.estimateProviderCost(selectedScore.provider, context),
      estimatedLatency: this.estimateProviderLatency(selectedScore.provider, context),
      riskFactors: this.identifyRiskFactors(selectedScore.provider, context, sessionSummary)
    };

    return decision;
  }

  private async buildReroutedDecision(
    originalDecision: RoutingDecision,
    executedProvider: AIProviderType,
    context: RoutingContext,
    sampleData: unknown[],
    sessionSummary: {
      totalCost: number;
      budgetRemaining: number;
      costsByProvider: Record<string, number>;
      budgetUtilization: number;
    },
  ): Promise<RoutingDecision> {
    const availableProviders = this.providerFactory.getAvailableProviders();
    const providerScores = await Promise.all(
      availableProviders.map(p => this.scoreProvider(p.type, context, sampleData))
    );
    providerScores.sort((a, b) => b.score - a.score);

    const executedScore = providerScores.find(score => score.provider === executedProvider)
      || await this.scoreProvider(executedProvider, context, sampleData);
    const alternatives = providerScores
      .filter(score => score.provider !== executedProvider)
      .slice(0, 3);

    return {
      selectedProvider: executedProvider,
      reroutedFrom: originalDecision.selectedProvider,
      confidence: executedScore.score,
      reasoning: [
        ...executedScore.reasoning,
        `Session budget guard rerouted execution from ${originalDecision.selectedProvider} to ${executedProvider}`,
      ],
      alternativeProviders: alternatives.map(score => ({
        provider: score.provider,
        score: score.score,
        reasoning: score.reasoning.join(', ')
      })),
      estimatedCost: this.estimateProviderCost(executedProvider, context),
      estimatedLatency: this.estimateProviderLatency(executedProvider, context),
      riskFactors: this.identifyRiskFactors(executedProvider, context, sessionSummary),
    };
  }

  /**
   * Score a provider based on context requirements
   */
  private async scoreProvider(
    providerType: AIProviderType,
    context: RoutingContext,
    sampleData: unknown[]
  ): Promise<ProviderScore> {
    const factors = {
      capability: 0,
      cost: 0,
      latency: 0,
      availability: 0,
      privacy: 0,
      track_record: 0
    };

    const reasoning: string[] = [];

    // Capability scoring based on provider strengths
    factors.capability = this.scoreCapability(providerType, context);
    if (factors.capability > 0.8) {
      reasoning.push(`Excellent capability match for ${context.complexity} complexity`);
    }

    // Cost scoring
    factors.cost = this.scoreCost(providerType, context);
    if (context.costSensitive && factors.cost > 0.8) {
      reasoning.push('Cost-effective option for budget-conscious requirement');
    }

    // Latency scoring
    factors.latency = this.scoreLatency(providerType, context);
    if (context.urgency === 'high' && factors.latency > 0.8) {
      reasoning.push('Fast response time meets urgency requirement');
    }

    // Availability scoring
    factors.availability = this.scoreAvailability(providerType);
    if (factors.availability < 0.5) {
      reasoning.push('Provider availability concerns detected');
    }

    // Privacy scoring
    factors.privacy = this.scorePrivacy(providerType, context);
    if (context.privacyLevel === 'confidential' && factors.privacy > 0.9) {
      reasoning.push('Meets confidential data privacy requirements');
    }

    // Track record scoring
    factors.track_record = this.scoreTrackRecord(providerType, context);
    if (factors.track_record > 0.8) {
      reasoning.push('Strong historical performance for similar tasks');
    }

    // Calculate weighted overall score
    const weights = this.getWeights(context);
    const score =
      factors.capability * weights.capability +
      factors.cost * weights.cost +
      factors.latency * weights.latency +
      factors.availability * weights.availability +
      factors.privacy * weights.privacy +
      factors.track_record * weights.track_record;

    return {
      provider: providerType,
      score: Math.min(score, 1.0),
      factors,
      reasoning
    };
  }

  private scoreCapability(providerType: AIProviderType, context: RoutingContext): number {
    const capabilityMap = {
      'claude': { low: 0.9, medium: 0.95, high: 1.0 },
      'openai': { low: 0.85, medium: 0.9, high: 0.95 },
      'openrouter': { low: 0.87, medium: 0.93, high: 0.97 },
      'gemini': { low: 0.8, medium: 0.85, high: 0.75 },
      'lmstudio': { low: 0.7, medium: 0.75, high: 0.6 },
      'rule-based': { low: 0.6, medium: 0.4, high: 0.2 }
    };

    return capabilityMap[providerType]?.[context.complexity] || 0.5;
  }

  private scoreCost(providerType: AIProviderType, context: RoutingContext): number {
    const costMap = {
      'lmstudio': 1.0,    // Free local processing
      'gemini': 0.9,      // Very low cost
      'openrouter': 0.8,  // Lower-cost cloud aggregation
      'openai': 0.6,      // Moderate cost
      'claude': 0.4,      // Higher cost
      'rule-based': 1.0   // Free
    };

    const baseScore = costMap[providerType] || 0.5;
    return context.costSensitive ? baseScore : 0.8; // Less weight on cost if not sensitive
  }

  private scoreLatency(providerType: AIProviderType, context: RoutingContext): number {
    const latencyMap = {
      'gemini': 0.95,     // Fastest
      'openai': 0.85,     // Fast
      'openrouter': 0.82, // Depends on routed upstream provider
      'lmstudio': 0.8,    // Depends on hardware
      'claude': 0.75,     // Slower but thorough
      'rule-based': 1.0   // Instant
    };

    return latencyMap[providerType] || 0.5;
  }

  private scoreAvailability(providerType: AIProviderType): number {
    const availableProviders = this.providerFactory.getAvailableProviders();
    const provider = availableProviders.find(p => p.type === providerType);

    if (!provider) return 0;

    return provider.metrics.successRate;
  }

  private scorePrivacy(providerType: AIProviderType, context: RoutingContext): number {
    const privacyMap = {
      'lmstudio': 1.0,    // Fully local
      'rule-based': 1.0,  // No external calls
      'openai': 0.7,      // Cloud with good policies
      'claude': 0.7,      // Cloud with good policies
      'openrouter': 0.65, // Cloud router with third-party upstreams
      'gemini': 0.6       // Cloud
    };

    const baseScore = privacyMap[providerType] || 0.5;

    if (context.privacyLevel === 'confidential') {
      return providerType === 'lmstudio' ? 1.0 : 0.3;
    }

    return baseScore;
  }

  private scoreTrackRecord(providerType: AIProviderType, context: RoutingContext): number {
    const relevantHistory = this.routingHistory.filter(h =>
      h.decision.selectedProvider === providerType &&
      h.context.complexity === context.complexity
    );

    if (relevantHistory.length === 0) return 0.7; // Neutral for new providers

    const successRate = relevantHistory.filter(h => h.outcome.success).length / relevantHistory.length;
    const avgQuality = relevantHistory
      .filter(h => h.outcome.qualityScore)
      .reduce((sum, h) => sum + (h.outcome.qualityScore || 0), 0) / relevantHistory.length;

    return (successRate + (avgQuality || 0.7)) / 2;
  }

  private getWeights(context: RoutingContext) {
    const baseWeights = {
      capability: 0.3,
      cost: 0.15,
      latency: 0.15,
      availability: 0.2,
      privacy: 0.1,
      track_record: 0.1
    };

    // Adjust weights based on context
    if (context.accuracy_requirement === 'critical') {
      baseWeights.capability = 0.5;
      baseWeights.track_record = 0.2;
    }

    if (context.costSensitive) {
      baseWeights.cost = 0.3;
      baseWeights.capability = 0.25;
    }

    if (context.urgency === 'high') {
      baseWeights.latency = 0.3;
      baseWeights.availability = 0.25;
    }

    if (context.privacyLevel === 'confidential') {
      baseWeights.privacy = 0.4;
      baseWeights.capability = 0.2;
    }

    return baseWeights;
  }

  private estimateProviderCost(providerType: AIProviderType, context: RoutingContext): number {
    const availableProviders = this.providerFactory.getAvailableProviders();
    const provider = availableProviders.find(p => p.type === providerType);

    if (!provider) return 0;

    // Base estimate on data size and complexity
    const complexityMultiplier = { low: 1, medium: 1.5, high: 2.5 };
    const baseEstimate = provider.metrics.averageCost * complexityMultiplier[context.complexity];

    return Math.max(baseEstimate, 0.001); // Minimum cost estimate
  }

  private estimateProviderLatency(providerType: AIProviderType, context: RoutingContext): number {
    const availableProviders = this.providerFactory.getAvailableProviders();
    const provider = availableProviders.find(p => p.type === providerType);

    if (!provider) return 5000; // 5 second default

    const complexityMultiplier = { low: 1, medium: 1.3, high: 1.8 };
    return provider.metrics.averageResponseTime * complexityMultiplier[context.complexity];
  }

  private identifyRiskFactors(
    providerType: AIProviderType,
    context: RoutingContext,
    sessionSummary: unknown
  ): string[] {
    const risks: string[] = [];

    // Budget risk
    if ((sessionSummary as any).budgetUtilization > 0.8) {
      risks.push('Session budget nearly exhausted');
    }

    // Privacy risk
    if (context.privacyLevel === 'confidential' && !['lmstudio', 'rule-based'].includes(providerType)) {
      risks.push('Confidential data being sent to cloud provider');
    }

    // Availability risk
    const availableProviders = this.providerFactory.getAvailableProviders();
    const provider = availableProviders.find(p => p.type === providerType);
    if (provider && provider.metrics.successRate < 0.9) {
      risks.push('Provider has recent reliability issues');
    }

    // Capability risk
    if (context.complexity === 'high' && ['gemini', 'lmstudio'].includes(providerType)) {
      risks.push('Provider may struggle with high complexity requirements');
    }

    return risks;
  }

  private recordRoutingOutcome(
    context: RoutingContext,
    decision: RoutingDecision,
    outcome: {
      success: boolean;
      actualCost: number;
      actualLatency: number;
      qualityScore?: number;
    }
  ): void {
    this.routingHistory.push({
      context,
      decision,
      outcome,
      timestamp: Date.now()
    });

    // Keep only last 1000 routing decisions for memory management
    if (this.routingHistory.length > 1000) {
      this.routingHistory = this.routingHistory.slice(-1000);
    }

    this.logger.info('Routing outcome recorded', {
      provider: decision.selectedProvider,
      success: outcome.success,
      cost: outcome.actualCost,
      latency: outcome.actualLatency
    });
  }

  /**
   * Get routing analytics and insights
   */
  getRoutingAnalytics(): {
    totalRoutings: number;
    successRate: number;
    averageCost: number;
    averageLatency: number;
    providerUsage: Record<AIProviderType, number>;
    topPerformingProvider: AIProviderType;
    recommendations: string[];
  } {
    if (this.routingHistory.length === 0) {
      return {
        totalRoutings: 0,
        successRate: 0,
        averageCost: 0,
        averageLatency: 0,
        providerUsage: {} as Record<AIProviderType, number>,
        topPerformingProvider: 'openai',
        recommendations: ['No routing history available yet']
      };
    }

    const totalRoutings = this.routingHistory.length;
    const successfulRoutings = this.routingHistory.filter(h => h.outcome.success);
    const successRate = successfulRoutings.length / totalRoutings;

    const averageCost = successfulRoutings.reduce((sum, h) => sum + h.outcome.actualCost, 0) / successfulRoutings.length;
    const averageLatency = successfulRoutings.reduce((sum, h) => sum + h.outcome.actualLatency, 0) / successfulRoutings.length;

    const providerUsage: Record<string, number> = {};
    this.routingHistory.forEach(h => {
      providerUsage[h.decision.selectedProvider] = (providerUsage[h.decision.selectedProvider] || 0) + 1;
    });

    const topPerformingProvider = Object.entries(providerUsage)
      .sort(([,a], [,b]) => b - a)[0]?.[0] as AIProviderType || 'openai';

    const recommendations = this.generateRecommendations();

    return {
      totalRoutings,
      successRate,
      averageCost,
      averageLatency,
      providerUsage: providerUsage as Record<AIProviderType, number>,
      topPerformingProvider,
      recommendations
    };
  }

  private generateRecommendations(): string[] {
    const recommendations: string[] = [];
    const sessionSummary = this.providerFactory.getSessionCostSummary();

    if (sessionSummary.budgetUtilization > 0.9) {
      recommendations.push('Consider increasing session budget or using more local providers');
    }

    if (this.routingHistory.length > 10) {
      const recentFailures = this.routingHistory.slice(-10).filter(h => !h.outcome.success);
      if (recentFailures.length > 3) {
        recommendations.push('High recent failure rate - check provider configurations');
      }
    }

    const availableProviders = this.providerFactory.getAvailableProviders();
    if (availableProviders.length < 2) {
      recommendations.push('Configure additional providers for better fallback options');
    }

    return recommendations;
  }
}
