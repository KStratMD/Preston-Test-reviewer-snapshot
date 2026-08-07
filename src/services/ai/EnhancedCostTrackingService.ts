/**
 * Enhanced AI Cost Tracking Service - Week 9 Real AI Integration
 * Real-time tracking across OpenAI, Claude, Gemini, LMStudio, and OpenRouter providers
 * Target: ≤$0.20 per session, alert at $0.30, hard stop at $0.40
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import { logger, type Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../UnifiedTelemetryService';

export interface EnhancedCostEntry {
  sessionId: string;
  providerId: 'openai' | 'claude' | 'gemini' | 'lmstudio' | 'rule-based';
  requestId: string;
  timestamp: Date;
  tokensUsed: number;
  cost: number;
  operation: 'mapping' | 'quality_analysis' | 'routing_decision' | 'fallback' | 'other';
  sourceSystem?: string;
  targetSystem?: string;
  responseTime?: number;
  model?: string;
  tier?: 'default' | 'premium' | 'economy' | 'local';
  success?: boolean;
  userId?: string;
  organizationId?: string;
  tenantId: string;
  costSource: 'measured' | 'estimated';
}

export interface EnhancedSessionCosts {
  sessionId: string;
  totalCost: number;
  totalRequests: number;
  totalTokens: number;
  byProvider: Record<string, {
    cost: number;
    requests: number;
    tokens: number;
    averageResponseTime: number;
    successRate: number;
    model?: string;
  }>;
  byTier: Record<string, { cost: number; requests: number; tokens: number }>;
  firstRequest: Date;
  lastRequest: Date;
  alertTriggered: boolean;
  limitReached: boolean;
  routingDecisions: number;
  fallbackUsage: number;
}

export interface CostLimits {
  sessionTarget: number;      // $0.20 target
  sessionAlert: number;       // $0.30 alert threshold
  sessionHardLimit: number;   // $0.40 hard stop
  dailyLimit: number;         // Daily organization limit
  monthlyLimit: number;       // Monthly organization limit
}

export interface RealTimeTracking {
  activeRequests: number;
  recentCosts: number[];
  trendDirection: 'increasing' | 'stable' | 'decreasing';
  lastUpdateTime: number;
  providerHealth: Record<string, boolean>;
}

@injectable()
export class EnhancedCostTrackingService {
  private sessionCosts = new Map<string, EnhancedSessionCosts>();
  private costHistory: EnhancedCostEntry[] = [];
  private realTimeTracking = new Map<string, RealTimeTracking>();

  private readonly limits: CostLimits = {
    sessionTarget: 0.20,
    sessionAlert: 0.30,
    sessionHardLimit: 0.40,
    dailyLimit: 50.0,    // $50/day
    monthlyLimit: 1000.0  // $1000/month
  };

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.UnifiedTelemetryService) private telemetry: UnifiedTelemetryService
  ) {}

  /**
   * Record a cost entry for a request with real-time tracking
   */
  async recordCost(entry: Omit<EnhancedCostEntry, 'timestamp'>): Promise<void> {
    const costEntry: EnhancedCostEntry = {
      ...entry,
      timestamp: new Date()
    };

    // Add to history
    this.costHistory.push(costEntry);

    // Update session costs
    await this.updateSessionCosts(costEntry);

    // Update real-time tracking
    await this.updateRealTimeTracking(costEntry);

    // Record telemetry as feature usage
    await this.telemetry.recordFeatureUsed(
      `ai_cost_tracking_${entry.operation}_${entry.providerId}`,
      entry.sessionId
    );

    this.logger.debug('Cost recorded with real-time tracking', {
      sessionId: entry.sessionId,
      providerId: entry.providerId,
      cost: entry.cost,
      tokens: entry.tokensUsed,
      tier: entry.tier,
      model: entry.model,
      responseTime: entry.responseTime
    });

    // Trigger real-time alerts if needed
    await this.checkRealTimeAlerts(costEntry);
  }

  /**
   * Check if session can proceed with additional cost
   */
  async checkSessionLimits(sessionId: string, estimatedCost: number): Promise<{
    allowed: boolean;
    reason?: string;
    currentCost: number;
    projectedCost: number;
    recommendFallback?: boolean;
    suggestedProvider?: string;
    costSavingsOpportunity?: number;
  }> {
    const session = this.sessionCosts.get(sessionId);
    const currentCost = session?.totalCost || 0;
    const projectedCost = currentCost + estimatedCost;

    // Check hard limit
    if (projectedCost > this.limits.sessionHardLimit) {
      await this.telemetry.recordErrorOccurred(
        'cost-tracking',
        'SESSION_COST_LIMIT_EXCEEDED',
        `Session ${sessionId} exceeded cost limit: $${projectedCost.toFixed(4)} > $${this.limits.sessionHardLimit}`
      );

      return {
        allowed: false,
        reason: `Session cost limit exceeded. Current: $${currentCost.toFixed(4)}, Projected: $${projectedCost.toFixed(4)}, Limit: $${this.limits.sessionHardLimit}`,
        currentCost,
        projectedCost,
        suggestedProvider: 'lmstudio',
        costSavingsOpportunity: estimatedCost
      };
    }

    // Check alert threshold
    if (projectedCost > this.limits.sessionAlert && session && !session.alertTriggered) {
      await this.triggerCostAlert(sessionId, currentCost, projectedCost);
    }

    // Recommend fallback if approaching target
    const recommendFallback = projectedCost > this.limits.sessionTarget;
    let suggestedProvider: string | undefined;
    let costSavingsOpportunity: number | undefined;

    if (recommendFallback) {
      // Suggest most cost-effective provider
      if (session) {
        const providers = Object.entries(session.byProvider);
        const mostEfficient = providers.sort(([,a], [,b]) =>
          (a.cost / a.tokens || 0) - (b.cost / b.tokens || 0)
        )[0];

        suggestedProvider = mostEfficient?.[0] || 'lmstudio';
        costSavingsOpportunity = estimatedCost * 0.7; // Estimated savings
      } else {
        suggestedProvider = 'lmstudio';
        costSavingsOpportunity = estimatedCost;
      }
    }

    return {
      allowed: true,
      currentCost,
      projectedCost,
      recommendFallback,
      suggestedProvider,
      costSavingsOpportunity
    };
  }

  /**
   * Get intelligent cost optimization recommendations with provider insights
   */
  async getCostOptimizationRecommendations(sessionId?: string): Promise<{
    recommendations: string[];
    providerInsights: Record<string, {
      efficiency: number;
      suggestion: string;
      alternativeProviders: string[];
    }>;
    tierOptimization: {
      currentTier: string;
      recommendedTier: string;
      potentialSavings: number;
    };
    realTimeInsights: {
      costTrend: 'increasing' | 'stable' | 'decreasing';
      budgetUtilization: number;
      riskFactors: string[];
    };
  }> {
    const recommendations: string[] = [];
    const providerInsights: Record<string, unknown> = {};
    const tierOptimization = {
      currentTier: 'default',
      recommendedTier: 'default',
      potentialSavings: 0
    };

    const realTimeInsights = sessionId ? this.getRealTimeInsights(sessionId) : {
      costTrend: 'stable' as const,
      budgetUtilization: 0,
      riskFactors: [] as string[]
    };

    if (sessionId) {
      const session = this.sessionCosts.get(sessionId);

      if (session) {
        // Session-specific recommendations
        if (session.totalCost > this.limits.sessionTarget) {
          recommendations.push('Session cost exceeding target - consider tier optimization');
          recommendations.push('Switch to local LMStudio provider for remaining requests');
        }

        // Provider efficiency analysis
        Object.entries(session.byProvider).forEach(([provider, data]) => {
          const efficiency = data.tokens > 0 ? data.cost / data.tokens : 0;
          let suggestion = 'Operating within normal parameters';
          const alternatives: string[] = [];

          if (provider === 'claude' && efficiency > 0.00003) {
            suggestion = 'High cost per token - consider OpenAI for standard tasks';
            alternatives.push('openai', 'gemini');
          } else if (provider === 'openai' && efficiency > 0.00005) {
            suggestion = 'Consider Gemini for cost-sensitive operations';
            alternatives.push('gemini', 'lmstudio');
          } else if (provider === 'gemini' && data.successRate < 0.8) {
            suggestion = 'Low success rate - consider upgrading to OpenAI';
            alternatives.push('openai');
          }

          providerInsights[provider] = {
            efficiency,
            suggestion,
            alternativeProviders: alternatives
          };
        });

        // Tier optimization analysis
        const dominantTier = Object.entries(session.byTier)
          .sort(([,a], [,b]) => b.cost - a.cost)[0];

        if (dominantTier) {
          tierOptimization.currentTier = dominantTier[0];

          if (dominantTier[0] === 'premium' && dominantTier[1].cost > session.totalCost * 0.6) {
            tierOptimization.recommendedTier = 'default';
            tierOptimization.potentialSavings = dominantTier[1].cost * 0.4;
            recommendations.push('High premium tier usage - consider default tier for standard tasks');
          }
        }

        // Fallback analysis
        if (session.fallbackUsage > session.totalRequests * 0.3) {
          recommendations.push('High fallback usage detected - check primary provider configurations');
        }
      }
    }

    if (recommendations.length === 0) {
      recommendations.push('Cost usage is optimally distributed across providers');
    }

    return {
      recommendations,
      providerInsights: providerInsights as Record<string, { efficiency: number; suggestion: string; alternativeProviders: string[] }>,
      tierOptimization,
      realTimeInsights
    };
  }

  /**
   * Get real-time session insights
   */
  getRealTimeInsights(sessionId: string): {
    costTrend: 'increasing' | 'stable' | 'decreasing';
    budgetUtilization: number;
    providerDistribution: Record<string, number>;
    riskFactors: string[];
    optimizationOpportunities: string[];
  } {
    const session = this.sessionCosts.get(sessionId);
    const tracking = this.realTimeTracking.get(sessionId);

    if (!session || !tracking) {
      return {
        costTrend: 'stable',
        budgetUtilization: 0,
        providerDistribution: {},
        riskFactors: ['No session data available'],
        optimizationOpportunities: []
      };
    }

    const budgetUtilization = session.totalCost / this.limits.sessionTarget;
    const providerDistribution: Record<string, number> = {};
    const riskFactors: string[] = [];
    const optimizationOpportunities: string[] = [];

    // Calculate provider distribution
    Object.entries(session.byProvider).forEach(([provider, data]) => {
      providerDistribution[provider] = (data.cost / session.totalCost) * 100;
    });

    // Identify risk factors
    if (budgetUtilization > 0.8) {
      riskFactors.push('Budget utilization exceeds 80%');
    }
    if (tracking.trendDirection === 'increasing') {
      riskFactors.push('Cost trend is increasing');
    }
    if (session.fallbackUsage > session.totalRequests * 0.2) {
      riskFactors.push('High fallback usage indicates provider issues');
    }

    // Identify optimization opportunities
    const dominantProvider = Object.entries(providerDistribution)
      .sort(([,a], [,b]) => b - a)[0];

    if (dominantProvider && dominantProvider[1] > 70) {
      optimizationOpportunities.push(`Consider diversifying from ${dominantProvider[0]} (${dominantProvider[1].toFixed(1)}% of costs)`);
    }

    if (session.byProvider.claude && session.byProvider.openai) {
      const claudeShare = providerDistribution.claude || 0;
      if (claudeShare > 50) {
        optimizationOpportunities.push('High Claude usage - consider OpenAI for cost optimization');
      }
    }

    return {
      costTrend: tracking.trendDirection,
      budgetUtilization,
      providerDistribution,
      riskFactors,
      optimizationOpportunities
    };
  }

  /**
   * Generate provider-specific cost reports
   */
  async getProviderCostReport(timeframe: 'hour' | 'day' | 'month' = 'day'): Promise<{
    providers: Record<string, {
      totalCost: number;
      requests: number;
      averageCostPerRequest: number;
      efficiency: number;
      reliability: number;
      recommendedUsage: string;
    }>;
    tiers: Record<string, {
      totalCost: number;
      requests: number;
      averageCostPerRequest: number;
    }>;
    insights: {
      mostCostEffective: string;
      leastCostEffective: string;
      recommendedProvider: string;
      costSavingOpportunities: string[];
    };
  }> {
    const now = new Date();
    const startTime = this.getTimeframeStart(now, timeframe);
    const relevantEntries = this.costHistory.filter(entry => entry.timestamp >= startTime);

    // Internal accumulator types: mirror the function return-type shape but
    // mark the late-computed fields optional, since they're only set in the
    // post-aggregation pass below.
    type ProviderMetric = {
      totalCost: number;
      requests: number;
      tokens: number;
      responseTimes: number[];
      successes: number;
      averageCostPerRequest: number;
      efficiency: number;
      reliability: number;
      recommendedUsage: string;
    };
    type TierMetric = {
      totalCost: number;
      requests: number;
      averageCostPerRequest: number;
    };
    const providers: Record<string, ProviderMetric> = {};
    const tiers: Record<string, TierMetric> = {};

    // Calculate provider metrics
    relevantEntries.forEach(entry => {
      if (!providers[entry.providerId]) {
        providers[entry.providerId] = {
          totalCost: 0,
          requests: 0,
          tokens: 0,
          responseTimes: [],
          successes: 0,
          averageCostPerRequest: 0,
          efficiency: 0,
          reliability: 0,
          recommendedUsage: '',
        };
      }

      const provider = providers[entry.providerId];
      provider.totalCost += entry.cost;
      provider.requests += 1;
      provider.tokens += entry.tokensUsed;
      if (entry.success !== false) provider.successes += 1;

      if (entry.responseTime) {
        provider.responseTimes.push(entry.responseTime);
      }

      // Track tier usage
      if (entry.tier) {
        if (!tiers[entry.tier]) {
          tiers[entry.tier] = { totalCost: 0, requests: 0, averageCostPerRequest: 0 };
        }
        tiers[entry.tier].totalCost += entry.cost;
        tiers[entry.tier].requests += 1;
      }
    });

    // Calculate final metrics
    Object.keys(providers).forEach(providerId => {
      const provider = providers[providerId];
      provider.averageCostPerRequest = provider.requests > 0 ? provider.totalCost / provider.requests : 0;
      provider.efficiency = provider.tokens > 0 ? provider.totalCost / provider.tokens : 0;
      provider.reliability = provider.requests > 0 ? provider.successes / provider.requests : 0;

      // Generate recommendations
      if (providerId === 'lmstudio') {
        provider.recommendedUsage = 'High-volume, privacy-sensitive operations';
      } else if (providerId === 'claude') {
        provider.recommendedUsage = 'Complex analysis requiring high accuracy';
      } else if (providerId === 'openai') {
        provider.recommendedUsage = 'General-purpose tasks with balanced cost/performance';
      } else if (providerId === 'gemini') {
        provider.recommendedUsage = 'High-speed, cost-sensitive operations';
      } else {
        provider.recommendedUsage = 'Fallback and simple rule-based operations';
      }
    });

    // Calculate tier metrics
    Object.keys(tiers).forEach(tier => {
      const tierData = tiers[tier];
      tierData.averageCostPerRequest = tierData.requests > 0 ? tierData.totalCost / tierData.requests : 0;
    });

    // Generate insights
    const sortedProviders = Object.entries(providers).sort(([,a], [,b]) => a.efficiency - b.efficiency);
    const mostCostEffective = sortedProviders[0]?.[0] || 'none';
    const leastCostEffective = sortedProviders[sortedProviders.length - 1]?.[0] || 'none';

    // Recommend based on efficiency and cost
    let recommendedProvider = 'openai'; // Default
    if (providers.lmstudio && providers.lmstudio.reliability > 0.9) {
      recommendedProvider = 'lmstudio';
    } else if (providers.gemini && providers.gemini.efficiency < providers.openai?.efficiency) {
      recommendedProvider = 'gemini';
    }

    const costSavingOpportunities: string[] = [];
    if (providers.claude && providers.claude.totalCost > (providers.openai?.totalCost || 0) * 2) {
      costSavingOpportunities.push('High Claude usage - migrate suitable tasks to OpenAI');
    }
    if (providers.openai && !providers.lmstudio) {
      costSavingOpportunities.push('Configure LMStudio for local processing cost savings');
    }
    if (Object.keys(providers).length < 3) {
      costSavingOpportunities.push('Limited provider diversity - configure additional providers for optimization');
    }

    return {
      providers,
      tiers,
      insights: {
        mostCostEffective,
        leastCostEffective,
        recommendedProvider,
        costSavingOpportunities
      }
    };
  }

  // Session management methods
  getSessionCosts(sessionId: string): EnhancedSessionCosts | null {
    return this.sessionCosts.get(sessionId) || null;
  }

  async getSessionCost(sessionId: string): Promise<number> {
    const session = this.sessionCosts.get(sessionId);
    return session ? session.totalCost : 0;
  }

  getAllSessionCosts(): EnhancedSessionCosts[] {
    return Array.from(this.sessionCosts.values());
  }

  resetSession(sessionId: string): void {
    this.sessionCosts.delete(sessionId);
    this.realTimeTracking.delete(sessionId);
    this.costHistory = this.costHistory.filter(entry => entry.sessionId !== sessionId);
  }

  getCostLimits(): CostLimits {
    return { ...this.limits };
  }

  // Private helper methods

  private async updateSessionCosts(entry: EnhancedCostEntry): Promise<void> {
    let session = this.sessionCosts.get(entry.sessionId);

    if (!session) {
      session = {
        sessionId: entry.sessionId,
        totalCost: 0,
        totalRequests: 0,
        totalTokens: 0,
        byProvider: {},
        byTier: {},
        firstRequest: entry.timestamp,
        lastRequest: entry.timestamp,
        alertTriggered: false,
        limitReached: false,
        routingDecisions: 0,
        fallbackUsage: 0
      };
      this.sessionCosts.set(entry.sessionId, session);
    }

    // Update totals
    session.totalCost += entry.cost;
    session.totalRequests += 1;
    session.totalTokens += entry.tokensUsed;
    session.lastRequest = entry.timestamp;

    // Track routing decisions and fallbacks
    if (entry.operation === 'routing_decision') {
      session.routingDecisions += 1;
    }
    if (entry.operation === 'fallback') {
      session.fallbackUsage += 1;
    }

    // Update by provider with enhanced metrics
    if (!session.byProvider[entry.providerId]) {
      session.byProvider[entry.providerId] = {
        cost: 0,
        requests: 0,
        tokens: 0,
        averageResponseTime: 0,
        successRate: 1.0,
        model: entry.model
      };
    }
    const providerData = session.byProvider[entry.providerId];
    providerData.cost += entry.cost;
    providerData.requests += 1;
    providerData.tokens += entry.tokensUsed;

    // Update average response time
    if (entry.responseTime) {
      providerData.averageResponseTime =
        (providerData.averageResponseTime + entry.responseTime) / 2;
    }

    // Update success rate
    if (entry.success === false) {
      providerData.successRate = (providerData.successRate * providerData.requests - 1) / providerData.requests;
    }

    // Update by tier
    if (entry.tier) {
      if (!session.byTier[entry.tier]) {
        session.byTier[entry.tier] = { cost: 0, requests: 0, tokens: 0 };
      }
      session.byTier[entry.tier].cost += entry.cost;
      session.byTier[entry.tier].requests += 1;
      session.byTier[entry.tier].tokens += entry.tokensUsed;
    }

    // Check if limit reached
    if (session.totalCost >= this.limits.sessionHardLimit) {
      session.limitReached = true;
    }
  }

  private async updateRealTimeTracking(entry: EnhancedCostEntry): Promise<void> {
    let tracking = this.realTimeTracking.get(entry.sessionId);

    if (!tracking) {
      tracking = {
        activeRequests: 0,
        recentCosts: [],
        trendDirection: 'stable',
        lastUpdateTime: Date.now(),
        providerHealth: {}
      };
      this.realTimeTracking.set(entry.sessionId, tracking);
    }

    // Update recent costs (keep last 10 entries)
    tracking.recentCosts.push(entry.cost);
    if (tracking.recentCosts.length > 10) {
      tracking.recentCosts = tracking.recentCosts.slice(-10);
    }

    // Calculate trend direction
    if (tracking.recentCosts.length >= 5) {
      const recent = tracking.recentCosts.slice(-3);
      const earlier = tracking.recentCosts.slice(-6, -3);
      const recentAvg = recent.reduce((sum, cost) => sum + cost, 0) / recent.length;
      const earlierAvg = earlier.reduce((sum, cost) => sum + cost, 0) / earlier.length;

      if (recentAvg > earlierAvg * 1.2) {
        tracking.trendDirection = 'increasing';
      } else if (recentAvg < earlierAvg * 0.8) {
        tracking.trendDirection = 'decreasing';
      } else {
        tracking.trendDirection = 'stable';
      }
    }

    // Update provider health
    tracking.providerHealth[entry.providerId] = entry.success !== false;
    tracking.lastUpdateTime = Date.now();
  }

  private async checkRealTimeAlerts(entry: EnhancedCostEntry): Promise<void> {
    const session = this.sessionCosts.get(entry.sessionId);
    const tracking = this.realTimeTracking.get(entry.sessionId);

    if (!session || !tracking) return;

    // Alert on rapid cost increase
    if (tracking.trendDirection === 'increasing' && tracking.recentCosts.length >= 5) {
      const recentTotal = tracking.recentCosts.slice(-3).reduce((sum, cost) => sum + cost, 0);
      if (recentTotal > this.limits.sessionTarget * 0.3) {
        await this.telemetry.recordErrorOccurred(
          'cost-tracking',
          'RAPID_COST_INCREASE',
          `Session ${entry.sessionId} showing rapid cost increase trend`
        );

        this.logger.warn('Rapid cost increase detected', {
          sessionId: entry.sessionId,
          recentCosts: tracking.recentCosts,
          trend: tracking.trendDirection
        });
      }
    }
  }

  private async triggerCostAlert(sessionId: string, currentCost: number, projectedCost: number): Promise<void> {
    const session = this.sessionCosts.get(sessionId);
    if (session) {
      session.alertTriggered = true;
    }

    await this.telemetry.recordErrorOccurred(
      'cost-tracking',
      'SESSION_COST_ALERT',
      `Session ${sessionId} cost alert: $${projectedCost.toFixed(4)} > $${this.limits.sessionAlert}`
    );

    this.logger.warn('AI cost alert triggered', {
      sessionId,
      currentCost,
      projectedCost,
      alertThreshold: this.limits.sessionAlert
    });
  }

  private getTimeframeStart(now: Date, timeframe: 'hour' | 'day' | 'month'): Date {
    const start = new Date(now);

    switch (timeframe) {
      case 'hour':
        start.setMinutes(0, 0, 0);
        break;
      case 'day':
        start.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        break;
    }

    return start;
  }
}
