/**
 * Session Budget Enforcer - Week 9 Real AI Integration
 * Enforces $0.20 session budget with intelligent routing and cost optimization
 */

import { logger, type Logger } from '../../utils/Logger';
import { EnhancedCostTrackingService, type EnhancedCostEntry } from './EnhancedCostTrackingService';
import { IntelligentProviderRouter, type RoutingContext } from './providers/IntelligentProviderRouter';
import { ProviderFactory, type AIProviderType, type ProviderConfig } from './providers/ProviderFactory';
import { SYSTEM_IDENTITY } from '../governance/identityContext';

export interface BudgetConfig {
  sessionTarget: number;      // $0.20 target
  alertThreshold: number;     // $0.15 alert (75% of target)
  hardLimit: number;          // $0.30 hard limit (150% of target)
  gracePeriod: number;        // Additional requests allowed after alert
  fallbackStrategy: 'local' | 'rule-based' | 'deny';
}

export interface BudgetStatus {
  sessionId: string;
  currentCost: number;
  budgetUtilization: number;  // Percentage of target used
  remainingBudget: number;
  alertTriggered: boolean;
  enforcementActive: boolean;
  requestsInGracePeriod: number;
  suggestedActions: string[];
  nextRequestCostEstimate: number;
}

export interface BudgetDecision {
  allowed: boolean;
  reason: string;
  alternativeProvider?: AIProviderType;
  costSavings?: number;
  budgetImpact: {
    currentUtilization: number;
    projectedUtilization: number;
    remainingBudget: number;
  };
  enforcementActions: string[];
}

export class SessionBudgetEnforcer {
  private budgetConfig: BudgetConfig = {
    sessionTarget: 0.20,
    alertThreshold: 0.15,
    hardLimit: 0.30,
    gracePeriod: 3,
    fallbackStrategy: 'local'
  };

  private sessionStates = new Map<string, {
    alertTriggered: boolean;
    gracePeriodRequests: number;
    enforcementActive: boolean;
    lastOptimizationTime: number;
    providerOverrides: Map<string, AIProviderType>;
  }>();

  constructor(
    private logger: Logger,
    private costTracker: EnhancedCostTrackingService,
    private providerRouter: IntelligentProviderRouter,
    private providerFactory: ProviderFactory,
    budgetConfig?: Partial<BudgetConfig>
  ) {
    if (budgetConfig) {
      this.budgetConfig = { ...this.budgetConfig, ...budgetConfig };
    }
  }

  /**
   * Check if a request is allowed within budget constraints
   */
  async checkBudgetConstraints(
    sessionId: string,
    estimatedCost: number,
    context: RoutingContext
  ): Promise<BudgetDecision> {
    const sessionState = this.getOrCreateSessionState(sessionId);
    const sessionCosts = this.costTracker.getSessionCosts(sessionId);
    const currentCost = sessionCosts?.totalCost || 0;
    const projectedCost = currentCost + estimatedCost;

    const currentUtilization = currentCost / this.budgetConfig.sessionTarget;
    const projectedUtilization = projectedCost / this.budgetConfig.sessionTarget;
    const remainingBudget = Math.max(0, this.budgetConfig.sessionTarget - currentCost);

    // Check hard limit
    if (projectedCost > this.budgetConfig.hardLimit) {
      return {
        allowed: false,
        reason: `Session budget hard limit exceeded. Projected cost: $${projectedCost.toFixed(4)}, Limit: $${this.budgetConfig.hardLimit}`,
        budgetImpact: {
          currentUtilization,
          projectedUtilization,
          remainingBudget
        },
        enforcementActions: [
          'Request denied - hard budget limit reached',
          'Consider using local providers for remaining requests',
          'Review session budget allocation'
        ]
      };
    }

    // Check grace period after alert
    if (sessionState.alertTriggered && sessionState.gracePeriodRequests >= this.budgetConfig.gracePeriod) {
      const fallbackDecision = await this.handleBudgetExceeded(sessionId, estimatedCost, context);
      return fallbackDecision;
    }

    // Trigger alert if threshold exceeded
    if (!sessionState.alertTriggered && projectedCost > this.budgetConfig.alertThreshold) {
      await this.triggerBudgetAlert(sessionId, currentCost, projectedCost, context);
      sessionState.alertTriggered = true;
    }

    // Check for optimization opportunities
    const enforcementActions: string[] = [];
    let alternativeProvider: AIProviderType | undefined;
    let costSavings: number | undefined;

    if (projectedUtilization > 0.7) { // 70% of target
      const optimization = await this.getOptimizationRecommendation(sessionId, estimatedCost, context);
      if (optimization.provider !== this.getCurrentProvider(context)) {
        alternativeProvider = optimization.provider;
        costSavings = optimization.estimatedSavings;
        enforcementActions.push(`Switch to ${optimization.provider} for ${((optimization.estimatedSavings / estimatedCost) * 100).toFixed(1)}% cost savings`);
      }
    }

    // Update grace period tracking
    if (sessionState.alertTriggered) {
      sessionState.gracePeriodRequests++;
    }

    return {
      allowed: true,
      reason: projectedUtilization > 0.5 ? 'Request allowed with budget monitoring' : 'Request allowed within budget',
      alternativeProvider,
      costSavings,
      budgetImpact: {
        currentUtilization,
        projectedUtilization,
        remainingBudget
      },
      enforcementActions
    };
  }

  /**
   * Get current budget status for a session
   */
  getBudgetStatus(sessionId: string): BudgetStatus {
    const sessionState = this.getOrCreateSessionState(sessionId);
    const sessionCosts = this.costTracker.getSessionCosts(sessionId);
    const currentCost = sessionCosts?.totalCost || 0;
    const budgetUtilization = currentCost / this.budgetConfig.sessionTarget;
    const remainingBudget = Math.max(0, this.budgetConfig.sessionTarget - currentCost);

    const suggestedActions: string[] = [];

    if (budgetUtilization > 0.8) {
      suggestedActions.push('Switch to local LMStudio provider');
      suggestedActions.push('Use rule-based mapping where possible');
      suggestedActions.push('Reduce sample data size');
    } else if (budgetUtilization > 0.5) {
      suggestedActions.push('Consider cost-effective providers (Gemini)');
      suggestedActions.push('Monitor provider efficiency');
    }

    // Estimate next request cost based on session history
    const nextRequestCostEstimate = this.estimateNextRequestCost(sessionId);

    return {
      sessionId,
      currentCost,
      budgetUtilization,
      remainingBudget,
      alertTriggered: sessionState.alertTriggered,
      enforcementActive: sessionState.enforcementActive,
      requestsInGracePeriod: sessionState.gracePeriodRequests,
      suggestedActions,
      nextRequestCostEstimate
    };
  }

  /**
   * Enforce budget constraints with automatic optimization
   */
  async enforceBudgetOptimization(
    sessionId: string,
    context: RoutingContext
  ): Promise<{
    optimizedContext: RoutingContext;
    optimizations: string[];
    estimatedSavings: number;
  }> {
    const sessionState = this.getOrCreateSessionState(sessionId);
    const sessionCosts = this.costTracker.getSessionCosts(sessionId);
    const optimizations: string[] = [];
    let estimatedSavings = 0;
    const optimizedContext = { ...context };

    if (!sessionCosts) {
      return { optimizedContext, optimizations, estimatedSavings };
    }

    const budgetUtilization = sessionCosts.totalCost / this.budgetConfig.sessionTarget;

    // Automatic optimization based on budget utilization
    if (budgetUtilization > 0.8) {
      // High utilization - aggressive optimization
      optimizedContext.privacyLevel = optimizedContext.privacyLevel === 'confidential' ? 'confidential' : 'standard';
      optimizedContext.costSensitive = true;
      optimizedContext.latencyRequirement = 'relaxed';
      optimizations.push('Enabled aggressive cost optimization mode');
      estimatedSavings += 0.02; // Estimated $0.02 savings

      // Override provider preference to local
      sessionState.providerOverrides.set('default', 'lmstudio');
      optimizations.push('Switched to local LMStudio provider');
    } else if (budgetUtilization > 0.6) {
      // Medium utilization - moderate optimization
      optimizedContext.costSensitive = true;
      if (optimizedContext.complexity === 'high') {
        optimizedContext.complexity = 'medium';
        optimizations.push('Reduced complexity level for cost savings');
        estimatedSavings += 0.01;
      }
      optimizations.push('Enabled cost-sensitive routing');
    }

    // Data size optimization
    if (optimizedContext.dataSize > 1000 && budgetUtilization > 0.5) {
      optimizedContext.dataSize = Math.min(optimizedContext.dataSize, 500);
      optimizations.push('Reduced sample data size to minimize token usage');
      estimatedSavings += 0.005;
    }

    sessionState.lastOptimizationTime = Date.now();

    this.logger.info('Budget optimization applied', {
      sessionId,
      budgetUtilization,
      optimizations,
      estimatedSavings
    });

    return {
      optimizedContext,
      optimizations,
      estimatedSavings
    };
  }

  /**
   * Reset session budget state
   */
  resetSessionBudget(sessionId: string): void {
    this.sessionStates.delete(sessionId);
    this.costTracker.resetSession(sessionId);
    this.logger.info('Session budget state reset', { sessionId });
  }

  /**
   * Get budget analytics across all sessions
   */
  getBudgetAnalytics(): {
    totalSessions: number;
    sessionsWithinBudget: number;
    sessionsExceededTarget: number;
    sessionsExceededLimit: number;
    averageCostPerSession: number;
    budgetComplianceRate: number;
    costOptimizationOpportunities: string[];
  } {
    const allSessions = this.costTracker.getAllSessionCosts();
    const totalSessions = allSessions.length;
    const sessionsWithinBudget = allSessions.filter(s => s.totalCost <= this.budgetConfig.sessionTarget).length;
    const sessionsExceededTarget = allSessions.filter(s => s.totalCost > this.budgetConfig.sessionTarget && s.totalCost <= this.budgetConfig.hardLimit).length;
    const sessionsExceededLimit = allSessions.filter(s => s.totalCost > this.budgetConfig.hardLimit).length;

    const totalCost = allSessions.reduce((sum, s) => sum + s.totalCost, 0);
    const averageCostPerSession = totalSessions > 0 ? totalCost / totalSessions : 0;
    const budgetComplianceRate = totalSessions > 0 ? sessionsWithinBudget / totalSessions : 1;

    const costOptimizationOpportunities: string[] = [];
    if (budgetComplianceRate < 0.8) {
      costOptimizationOpportunities.push('Low budget compliance - review default provider configuration');
    }
    if (averageCostPerSession > this.budgetConfig.sessionTarget * 1.2) {
      costOptimizationOpportunities.push('High average session cost - implement proactive cost controls');
    }

    return {
      totalSessions,
      sessionsWithinBudget,
      sessionsExceededTarget,
      sessionsExceededLimit,
      averageCostPerSession,
      budgetComplianceRate,
      costOptimizationOpportunities
    };
  }

  // Private helper methods

  private getOrCreateSessionState(sessionId: string) {
    if (!this.sessionStates.has(sessionId)) {
      this.sessionStates.set(sessionId, {
        alertTriggered: false,
        gracePeriodRequests: 0,
        enforcementActive: false,
        lastOptimizationTime: 0,
        providerOverrides: new Map()
      });
    }
    return this.sessionStates.get(sessionId)!;
  }

  private async handleBudgetExceeded(
    sessionId: string,
    estimatedCost: number,
    context: RoutingContext
  ): Promise<BudgetDecision> {
    const sessionState = this.getOrCreateSessionState(sessionId);
    sessionState.enforcementActive = true;

    switch (this.budgetConfig.fallbackStrategy) {
      case 'local':
        return {
          allowed: true,
          reason: 'Budget exceeded - routing to local provider',
          alternativeProvider: 'lmstudio',
          costSavings: estimatedCost,
          budgetImpact: {
            currentUtilization: 1.0,
            projectedUtilization: 1.0,
            remainingBudget: 0
          },
          enforcementActions: [
            'Budget enforcement active',
            'All requests routed to local provider',
            'Consider reviewing session budget allocation'
          ]
        };

      case 'rule-based':
        return {
          allowed: true,
          reason: 'Budget exceeded - using rule-based fallback',
          alternativeProvider: 'rule-based',
          costSavings: estimatedCost,
          budgetImpact: {
            currentUtilization: 1.0,
            projectedUtilization: 1.0,
            remainingBudget: 0
          },
          enforcementActions: [
            'Budget enforcement active',
            'Using rule-based mapping only',
            'AI features temporarily disabled'
          ]
        };

      case 'deny':
      default:
        return {
          allowed: false,
          reason: 'Session budget exceeded - request denied',
          budgetImpact: {
            currentUtilization: 1.0,
            projectedUtilization: 1.0,
            remainingBudget: 0
          },
          enforcementActions: [
            'Budget enforcement active',
            'Requests denied until next session',
            'Consider increasing session budget'
          ]
        };
    }
  }

  private async triggerBudgetAlert(
    sessionId: string,
    currentCost: number,
    projectedCost: number,
    context: RoutingContext
  ): Promise<void> {
    this.logger.warn('Session budget alert triggered', {
      sessionId,
      currentCost,
      projectedCost,
      threshold: this.budgetConfig.alertThreshold,
      budgetUtilization: (projectedCost / this.budgetConfig.sessionTarget * 100).toFixed(1) + '%'
    });

    // Record alert in cost tracker
    await this.costTracker.recordCost({
      sessionId,
      providerId: 'rule-based',
      requestId: `budget-alert-${Date.now()}`,
      tokensUsed: 0,
      cost: 0,
      operation: 'other',
      responseTime: 0,
      tier: 'local',
      userId: context.userId,
      organizationId: context.organizationId,
      // RoutingContext has no tenantId; this is a system-level budget alert
      tenantId: SYSTEM_IDENTITY.tenantId,
      // budget alert synthetic record — no provider usage block
      costSource: 'estimated',
    });
  }

  private async getOptimizationRecommendation(
    sessionId: string,
    estimatedCost: number,
    context: RoutingContext
  ): Promise<{
    provider: AIProviderType;
    estimatedSavings: number;
    reasoning: string;
  }> {
    const recommendations = this.providerFactory.getRoutingRecommendations(context);

    // Prefer local providers for cost optimization
    if (recommendations.alternativeProviders.includes('lmstudio')) {
      return {
        provider: 'lmstudio',
        estimatedSavings: estimatedCost, // Local is free
        reasoning: 'Local provider eliminates API costs'
      };
    }

    // Next prefer cost-effective cloud providers
    if (recommendations.alternativeProviders.includes('gemini')) {
      return {
        provider: 'gemini',
        estimatedSavings: estimatedCost * 0.7, // Assume 70% savings
        reasoning: 'Gemini offers lowest cloud API costs'
      };
    }

    return {
      provider: recommendations.recommendedProvider,
      estimatedSavings: 0,
      reasoning: 'Current provider is optimal'
    };
  }

  private getCurrentProvider(context: RoutingContext): AIProviderType {
    // Simple heuristic to determine current provider based on context
    if (context.privacyLevel === 'confidential') return 'lmstudio';
    if (context.complexity === 'high') return 'claude';
    if (context.costSensitive) return 'gemini';
    return 'openai';
  }

  private estimateNextRequestCost(sessionId: string): number {
    const sessionCosts = this.costTracker.getSessionCosts(sessionId);
    if (!sessionCosts || sessionCosts.totalRequests === 0) {
      return 0.01; // Default estimate
    }

    return sessionCosts.totalCost / sessionCosts.totalRequests;
  }
}
