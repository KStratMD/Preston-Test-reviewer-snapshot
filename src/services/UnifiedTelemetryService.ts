/**
 * Unified Telemetry Service
 * Implements ADR-003: Unified Telemetry Schema
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';

// Event types as defined in ADR-003
export interface TelemetryEvent {
  eventType: string;
  timestamp: string;
  userId?: string;
  sessionId?: string;
  appVersion?: string;
  metadata: Record<string, unknown>;
}

export interface AISuggestionRequestedEvent extends TelemetryEvent {
  eventType: 'ai_suggestion_requested';
  metadata: {
    provider: string;
    context: string;
    userId: string;
  };
}

export interface AISuggestionRespondedEvent extends TelemetryEvent {
  eventType: 'ai_suggestion_responded';
  metadata: {
    provider: string;
    latencyMs: number;
    costUsd: number;
    suggestionId: string;
    accuracyScore?: number;
  };
}

export interface AISuggestionAcceptedEvent extends TelemetryEvent {
  eventType: 'ai_suggestion_accepted';
  metadata: {
    suggestionId: string;
    userId: string;
  };
}

export interface FeatureUsedEvent extends TelemetryEvent {
  eventType: 'feature_used';
  metadata: {
    featureName: string;
    userId: string;
  };
}

export interface PageViewedEvent extends TelemetryEvent {
  eventType: 'page_viewed';
  metadata: {
    pageName: string;
    loadTimeMs: number;
  };
}

export interface ErrorOccurredEvent extends TelemetryEvent {
  eventType: 'error_occurred';
  metadata: {
    service: string;
    errorCode: string;
    details: string;
  };
}

// Week 5: Multi-Agent Orchestrator Events
export interface MultiAgentWorkflowExecutedEvent extends TelemetryEvent {
  eventType: 'multi_agent_workflow_executed';
  metadata: {
    sessionId: string;
    userId: string;
    workflowType: string;
    agentCount: number;
    duration: number;
    success: boolean;
    cost: number;
    agentResults: {
      agentType: string;
      success: boolean;
      duration: number;
      confidence: number;
    }[];
  };
}

export interface MultiAgentWorkflowFailedEvent extends TelemetryEvent {
  eventType: 'multi_agent_workflow_failed';
  metadata: {
    sessionId: string;
    userId: string;
    workflowType: string;
    duration: number;
    error: string;
    failurePoint: string;
  };
}

export interface SingleAgentExecutedEvent extends TelemetryEvent {
  eventType: 'single_agent_executed';
  metadata: {
    agentType: string;
    executionId: string;
    userId: string;
    duration: number;
    success: boolean;
    confidence: number;
    inputSize: number;
    outputSize: number;
    cost: number;
  };
}

export interface SingleAgentFailedEvent extends TelemetryEvent {
  eventType: 'single_agent_failed';
  metadata: {
    agentType: string;
    executionId: string;
    userId: string;
    duration: number;
    error: string;
    inputSize: number;
  };
}

export interface AgentHealthCheckEvent extends TelemetryEvent {
  eventType: 'agent_health_check';
  metadata: {
    agentId: string;
    agentType: string;
    healthStatus: 'healthy' | 'degraded' | 'unhealthy';
    responseTimeMs: number;
    errorRate: number;
    lastExecutionTime?: string;
  };
}

export interface GovernanceViolationEvent extends TelemetryEvent {
  eventType: 'governance_violation';
  metadata: {
    sessionId: string;
    agentType: string;
    violationType: 'pii_detected' | 'content_filtered' | 'hallucination_detected' | 'cost_limit_exceeded';
    severity: 'low' | 'medium' | 'high' | 'critical';
    details: string;
    action: 'blocked' | 'redacted' | 'flagged' | 'terminated';
  };
}

export type UnifiedTelemetryEvent =
  | AISuggestionRequestedEvent
  | AISuggestionRespondedEvent
  | AISuggestionAcceptedEvent
  | FeatureUsedEvent
  | PageViewedEvent
  | ErrorOccurredEvent
  | MultiAgentWorkflowExecutedEvent
  | MultiAgentWorkflowFailedEvent
  | SingleAgentExecutedEvent
  | SingleAgentFailedEvent
  | AgentHealthCheckEvent
  | GovernanceViolationEvent;

export interface TelemetryBackend {
  store(event: UnifiedTelemetryEvent): Promise<void>;
  query(filters: TelemetryQueryFilters): Promise<UnifiedTelemetryEvent[]>;
}

export interface TelemetryQueryFilters {
  eventType?: string;
  userId?: string;
  sessionId?: string;
  startTime?: Date;
  endTime?: Date;
  limit?: number;
}

@injectable()
export class UnifiedTelemetryService {
  private backend: TelemetryBackend;
  private eventBuffer: UnifiedTelemetryEvent[] = [];
  private flushInterval: NodeJS.Timeout | null = null;
  private readonly bufferSize = 100;
  private readonly flushIntervalMs = 5000; // 5 seconds

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    backend?: TelemetryBackend
  ) {
    this.backend = backend || new InMemoryTelemetryBackend();
    this.startBufferFlush();
  }

  /**
   * Record an AI suggestion request
   */
  async recordAISuggestionRequested(provider: string, context: string, userId: string): Promise<void> {
    const event: AISuggestionRequestedEvent = {
      eventType: 'ai_suggestion_requested',
      timestamp: new Date().toISOString(),
      userId,
      sessionId: this.generateSessionId(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        provider,
        context,
        userId
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record an AI suggestion response
   */
  async recordAISuggestionResponded(
    provider: string, 
    latencyMs: number, 
    costUsd: number, 
    suggestionId: string,
    accuracyScore?: number
  ): Promise<void> {
    const event: AISuggestionRespondedEvent = {
      eventType: 'ai_suggestion_responded',
      timestamp: new Date().toISOString(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        provider,
        latencyMs,
        costUsd,
        suggestionId,
        accuracyScore
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record an AI suggestion acceptance
   */
  async recordAISuggestionAccepted(suggestionId: string, userId: string): Promise<void> {
    const event: AISuggestionAcceptedEvent = {
      eventType: 'ai_suggestion_accepted',
      timestamp: new Date().toISOString(),
      userId,
      sessionId: this.generateSessionId(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        suggestionId,
        userId
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record feature usage
   */
  async recordFeatureUsed(featureName: string, userId: string): Promise<void> {
    const event: FeatureUsedEvent = {
      eventType: 'feature_used',
      timestamp: new Date().toISOString(),
      userId,
      sessionId: this.generateSessionId(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        featureName,
        userId
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record page view
   */
  async recordPageViewed(pageName: string, loadTimeMs: number): Promise<void> {
    const event: PageViewedEvent = {
      eventType: 'page_viewed',
      timestamp: new Date().toISOString(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        pageName,
        loadTimeMs
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record error occurrence
   */
  async recordErrorOccurred(service: string, errorCode: string, details: string): Promise<void> {
    const event: ErrorOccurredEvent = {
      eventType: 'error_occurred',
      timestamp: new Date().toISOString(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        service,
        errorCode,
        details
      }
    };

    await this.recordEvent(event);
  }

  // ===== WEEK 5: MULTI-AGENT ORCHESTRATOR TELEMETRY METHODS =====

  /**
   * Record multi-agent workflow execution
   */
  async recordMultiAgentWorkflowExecuted(
    sessionId: string,
    userId: string,
    workflowType: string,
    agentCount: number,
    duration: number,
    success: boolean,
    cost: number,
    agentResults: {
      agentType: string;
      success: boolean;
      duration: number;
      confidence: number;
    }[]
  ): Promise<void> {
    const event: MultiAgentWorkflowExecutedEvent = {
      eventType: 'multi_agent_workflow_executed',
      timestamp: new Date().toISOString(),
      userId,
      sessionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        sessionId,
        userId,
        workflowType,
        agentCount,
        duration,
        success,
        cost,
        agentResults
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record multi-agent workflow failure
   */
  async recordMultiAgentWorkflowFailed(
    sessionId: string,
    userId: string,
    workflowType: string,
    duration: number,
    error: string,
    failurePoint: string
  ): Promise<void> {
    const event: MultiAgentWorkflowFailedEvent = {
      eventType: 'multi_agent_workflow_failed',
      timestamp: new Date().toISOString(),
      userId,
      sessionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        sessionId,
        userId,
        workflowType,
        duration,
        error,
        failurePoint
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record single agent execution
   */
  async recordSingleAgentExecuted(
    agentType: string,
    executionId: string,
    userId: string,
    duration: number,
    success: boolean,
    confidence: number,
    inputSize: number,
    outputSize: number,
    cost: number
  ): Promise<void> {
    const event: SingleAgentExecutedEvent = {
      eventType: 'single_agent_executed',
      timestamp: new Date().toISOString(),
      userId,
      sessionId: executionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        agentType,
        executionId,
        userId,
        duration,
        success,
        confidence,
        inputSize,
        outputSize,
        cost
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record single agent failure
   */
  async recordSingleAgentFailed(
    agentType: string,
    executionId: string,
    userId: string,
    duration: number,
    error: string,
    inputSize: number
  ): Promise<void> {
    const event: SingleAgentFailedEvent = {
      eventType: 'single_agent_failed',
      timestamp: new Date().toISOString(),
      userId,
      sessionId: executionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        agentType,
        executionId,
        userId,
        duration,
        error,
        inputSize
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record agent health check
   */
  async recordAgentHealthCheck(
    agentId: string,
    agentType: string,
    healthStatus: 'healthy' | 'degraded' | 'unhealthy',
    responseTimeMs: number,
    errorRate: number,
    lastExecutionTime?: string
  ): Promise<void> {
    const event: AgentHealthCheckEvent = {
      eventType: 'agent_health_check',
      timestamp: new Date().toISOString(),
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        agentId,
        agentType,
        healthStatus,
        responseTimeMs,
        errorRate,
        lastExecutionTime
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Record governance violation
   */
  async recordGovernanceViolation(
    sessionId: string,
    agentType: string,
    violationType: 'pii_detected' | 'content_filtered' | 'hallucination_detected' | 'cost_limit_exceeded',
    severity: 'low' | 'medium' | 'high' | 'critical',
    details: string,
    action: 'blocked' | 'redacted' | 'flagged' | 'terminated'
  ): Promise<void> {
    const event: GovernanceViolationEvent = {
      eventType: 'governance_violation',
      timestamp: new Date().toISOString(),
      sessionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata: {
        sessionId,
        agentType,
        violationType,
        severity,
        details,
        action
      }
    };

    await this.recordEvent(event);
  }

  /**
   * Generic method to record any event with metadata
   */
  async recordGenericEvent(eventType: string, metadata: Record<string, unknown>, userId?: string, sessionId?: string): Promise<void> {
    const event: TelemetryEvent = {
      eventType,
      timestamp: new Date().toISOString(),
      userId,
      sessionId,
      appVersion: process.env.APP_VERSION || '1.0.0',
      metadata
    };

    await this.recordEvent(event as UnifiedTelemetryEvent);
  }

  /**
   * Query telemetry events
   */
  async queryEvents(filters: TelemetryQueryFilters): Promise<UnifiedTelemetryEvent[]> {
    return await this.backend.query(filters);
  }

  /**
   * Get telemetry statistics
   */
  async getStatistics(timeframe: 'hour' | 'day' | 'week' = 'day'): Promise<TelemetryStatistics> {
    const endTime = new Date();
    const startTime = new Date();
    
    switch (timeframe) {
      case 'hour':
        startTime.setHours(startTime.getHours() - 1);
        break;
      case 'day':
        startTime.setDate(startTime.getDate() - 1);
        break;
      case 'week':
        startTime.setDate(startTime.getDate() - 7);
        break;
    }

    const events = await this.backend.query({ startTime, endTime });
    
    return this.calculateStatistics(events);
  }

  /**
   * Shutdown telemetry service
   */
  async shutdown(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    
    // Flush remaining events
    await this.flushBuffer();
  }

  private async recordEvent(event: UnifiedTelemetryEvent): Promise<void> {
    this.eventBuffer.push(event);
    
    if (this.eventBuffer.length >= this.bufferSize) {
      await this.flushBuffer();
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const eventsToFlush = [...this.eventBuffer];
    this.eventBuffer = [];

    try {
      for (const event of eventsToFlush) {
        await this.backend.store(event);
      }
      
      this.logger.debug(`Flushed ${eventsToFlush.length} telemetry events`);
    } catch (error) {
      this.logger.error('Failed to flush telemetry events', { 
        error: String(error),
        eventCount: eventsToFlush.length 
      });
      
      // Re-add events to buffer for retry
      this.eventBuffer.unshift(...eventsToFlush);
    }
  }

  private startBufferFlush(): void {
    this.flushInterval = setInterval(async () => {
      await this.flushBuffer();
    }, this.flushIntervalMs);
  }

  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
  }

  private calculateStatistics(events: UnifiedTelemetryEvent[]): TelemetryStatistics {
    const stats: TelemetryStatistics = {
      totalEvents: events.length,
      eventsByType: {},
      aiSuggestions: {
        requested: 0,
        responded: 0,
        accepted: 0,
        avgLatencyMs: 0,
        totalCostUsd: 0,
        avgAccuracyScore: 0
      },
      features: {
        mostUsed: [],
        totalUsage: 0
      },
      pages: {
        mostViewed: [],
        avgLoadTimeMs: 0
      },
      errors: {
        totalErrors: 0,
        byService: {},
        byErrorCode: {}
      },
      // Week 5: Initialize agent-specific statistics
      multiAgentWorkflows: {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        avgDuration: 0,
        totalCost: 0,
        byWorkflowType: {}
      },
      singleAgents: {
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
        avgDuration: 0,
        avgConfidence: 0,
        totalCost: 0,
        byAgentType: {}
      },
      agentHealth: {
        totalChecks: 0,
        healthyAgents: 0,
        degradedAgents: 0,
        unhealthyAgents: 0,
        avgResponseTime: 0,
        byAgentType: {}
      },
      governance: {
        totalViolations: 0,
        bySeverity: {},
        byViolationType: {},
        byAction: {}
      }
    };

    const featureUsage = new Map<string, number>();
    const pageViews = new Map<string, number>();
    let totalLatency = 0;
    let totalCost = 0;
    let totalAccuracy = 0;
    let accuracyCount = 0;
    let totalLoadTime = 0;
    let pageViewCount = 0;

    // Week 5: Agent-specific tracking variables
    let multiAgentTotalDuration = 0;
    let multiAgentTotalCost = 0;
    let singleAgentTotalDuration = 0;
    let singleAgentTotalCost = 0;
    let singleAgentTotalConfidence = 0;
    let singleAgentConfidenceCount = 0;
    let agentHealthTotalResponseTime = 0;
    const workflowTypeStats = new Map<string, { executions: number; duration: number; cost: number; successes: number }>();
    const agentTypeStats = new Map<string, { executions: number; duration: number; cost: number; confidence: number; confidenceCount: number; successes: number }>();
    const agentHealthStats = new Map<string, { checks: number; responseTime: number; healthy: number; degraded: number; unhealthy: number; errorRate: number }>();

    for (const event of events) {
      // Count by event type
      stats.eventsByType[event.eventType] = (stats.eventsByType[event.eventType] || 0) + 1;

      switch (event.eventType) {
        case 'ai_suggestion_requested':
          stats.aiSuggestions.requested++;
          break;
        
        case 'ai_suggestion_responded':
          stats.aiSuggestions.responded++;
          totalLatency += event.metadata.latencyMs;
          totalCost += event.metadata.costUsd;
          if (event.metadata.accuracyScore) {
            totalAccuracy += event.metadata.accuracyScore;
            accuracyCount++;
          }
          break;
        
        case 'ai_suggestion_accepted':
          stats.aiSuggestions.accepted++;
          break;
        
        case 'feature_used':
          stats.features.totalUsage++;
          const featureName = event.metadata.featureName;
          featureUsage.set(featureName, (featureUsage.get(featureName) || 0) + 1);
          break;
        
        case 'page_viewed':
          pageViewCount++;
          totalLoadTime += event.metadata.loadTimeMs;
          const pageName = event.metadata.pageName;
          pageViews.set(pageName, (pageViews.get(pageName) || 0) + 1);
          break;
        
        case 'error_occurred':
          stats.errors.totalErrors++;
          const service = event.metadata.service;
          const errorCode = event.metadata.errorCode;
          stats.errors.byService[service] = (stats.errors.byService[service] || 0) + 1;
          stats.errors.byErrorCode[errorCode] = (stats.errors.byErrorCode[errorCode] || 0) + 1;
          break;

        // Week 5: Multi-Agent Orchestrator Events
        case 'multi_agent_workflow_executed':
          stats.multiAgentWorkflows.totalExecutions++;
          if (event.metadata.success) {
            stats.multiAgentWorkflows.successfulExecutions++;
          }
          multiAgentTotalDuration += event.metadata.duration;
          multiAgentTotalCost += event.metadata.cost;

          const workflowType = event.metadata.workflowType;
          const workflowStat = workflowTypeStats.get(workflowType) || { executions: 0, duration: 0, cost: 0, successes: 0 };
          workflowStat.executions++;
          workflowStat.duration += event.metadata.duration;
          workflowStat.cost += event.metadata.cost;
          if (event.metadata.success) workflowStat.successes++;
          workflowTypeStats.set(workflowType, workflowStat);
          break;

        case 'multi_agent_workflow_failed':
          stats.multiAgentWorkflows.totalExecutions++;
          stats.multiAgentWorkflows.failedExecutions++;
          multiAgentTotalDuration += event.metadata.duration;

          const failedWorkflowType = event.metadata.workflowType;
          const failedWorkflowStat = workflowTypeStats.get(failedWorkflowType) || { executions: 0, duration: 0, cost: 0, successes: 0 };
          failedWorkflowStat.executions++;
          failedWorkflowStat.duration += event.metadata.duration;
          workflowTypeStats.set(failedWorkflowType, failedWorkflowStat);
          break;

        case 'single_agent_executed':
          stats.singleAgents.totalExecutions++;
          if (event.metadata.success) {
            stats.singleAgents.successfulExecutions++;
          }
          singleAgentTotalDuration += event.metadata.duration;
          singleAgentTotalCost += event.metadata.cost;
          singleAgentTotalConfidence += event.metadata.confidence;
          singleAgentConfidenceCount++;

          const agentType = event.metadata.agentType;
          const agentStat = agentTypeStats.get(agentType) || { executions: 0, duration: 0, cost: 0, confidence: 0, confidenceCount: 0, successes: 0 };
          agentStat.executions++;
          agentStat.duration += event.metadata.duration;
          agentStat.cost += event.metadata.cost;
          agentStat.confidence += event.metadata.confidence;
          agentStat.confidenceCount++;
          if (event.metadata.success) agentStat.successes++;
          agentTypeStats.set(agentType, agentStat);
          break;

        case 'single_agent_failed':
          stats.singleAgents.totalExecutions++;
          stats.singleAgents.failedExecutions++;
          singleAgentTotalDuration += event.metadata.duration;

          const failedAgentType = event.metadata.agentType;
          const failedAgentStat = agentTypeStats.get(failedAgentType) || { executions: 0, duration: 0, cost: 0, confidence: 0, confidenceCount: 0, successes: 0 };
          failedAgentStat.executions++;
          failedAgentStat.duration += event.metadata.duration;
          agentTypeStats.set(failedAgentType, failedAgentStat);
          break;

        case 'agent_health_check':
          stats.agentHealth.totalChecks++;
          agentHealthTotalResponseTime += event.metadata.responseTimeMs;

          switch (event.metadata.healthStatus) {
            case 'healthy':
              stats.agentHealth.healthyAgents++;
              break;
            case 'degraded':
              stats.agentHealth.degradedAgents++;
              break;
            case 'unhealthy':
              stats.agentHealth.unhealthyAgents++;
              break;
          }

          const healthAgentType = event.metadata.agentType;
          const healthStat = agentHealthStats.get(healthAgentType) || { checks: 0, responseTime: 0, healthy: 0, degraded: 0, unhealthy: 0, errorRate: 0 };
          healthStat.checks++;
          healthStat.responseTime += event.metadata.responseTimeMs;
          healthStat.errorRate = (healthStat.errorRate * (healthStat.checks - 1) + event.metadata.errorRate) / healthStat.checks;
          switch (event.metadata.healthStatus) {
            case 'healthy': healthStat.healthy++; break;
            case 'degraded': healthStat.degraded++; break;
            case 'unhealthy': healthStat.unhealthy++; break;
          }
          agentHealthStats.set(healthAgentType, healthStat);
          break;

        case 'governance_violation':
          stats.governance.totalViolations++;
          stats.governance.bySeverity[event.metadata.severity] = (stats.governance.bySeverity[event.metadata.severity] || 0) + 1;
          stats.governance.byViolationType[event.metadata.violationType] = (stats.governance.byViolationType[event.metadata.violationType] || 0) + 1;
          stats.governance.byAction[event.metadata.action] = (stats.governance.byAction[event.metadata.action] || 0) + 1;
          break;
      }
    }

    // Calculate averages
    if (stats.aiSuggestions.responded > 0) {
      stats.aiSuggestions.avgLatencyMs = totalLatency / stats.aiSuggestions.responded;
      stats.aiSuggestions.totalCostUsd = totalCost;
    }
    
    if (accuracyCount > 0) {
      stats.aiSuggestions.avgAccuracyScore = totalAccuracy / accuracyCount;
    }
    
    if (pageViewCount > 0) {
      stats.pages.avgLoadTimeMs = totalLoadTime / pageViewCount;
    }

    // Sort most used features and pages
    stats.features.mostUsed = Array.from(featureUsage.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    stats.pages.mostViewed = Array.from(pageViews.entries())
      .sort(([,a], [,b]) => b - a)
      .slice(0, 10)
      .map(([name, count]) => ({ name, count }));

    // Week 5: Calculate agent-specific averages
    if (stats.multiAgentWorkflows.totalExecutions > 0) {
      stats.multiAgentWorkflows.avgDuration = multiAgentTotalDuration / stats.multiAgentWorkflows.totalExecutions;
      stats.multiAgentWorkflows.totalCost = multiAgentTotalCost;
    }

    if (stats.singleAgents.totalExecutions > 0) {
      stats.singleAgents.avgDuration = singleAgentTotalDuration / stats.singleAgents.totalExecutions;
      stats.singleAgents.totalCost = singleAgentTotalCost;
    }

    if (singleAgentConfidenceCount > 0) {
      stats.singleAgents.avgConfidence = singleAgentTotalConfidence / singleAgentConfidenceCount;
    }

    if (stats.agentHealth.totalChecks > 0) {
      stats.agentHealth.avgResponseTime = agentHealthTotalResponseTime / stats.agentHealth.totalChecks;
    }

    // Calculate workflow type statistics
    for (const [workflowType, workflowStat] of workflowTypeStats) {
      stats.multiAgentWorkflows.byWorkflowType[workflowType] = {
        executions: workflowStat.executions,
        successRate: workflowStat.executions > 0 ? workflowStat.successes / workflowStat.executions : 0,
        avgDuration: workflowStat.executions > 0 ? workflowStat.duration / workflowStat.executions : 0,
        avgCost: workflowStat.executions > 0 ? workflowStat.cost / workflowStat.executions : 0
      };
    }

    // Calculate agent type statistics
    for (const [agentType, agentStat] of agentTypeStats) {
      stats.singleAgents.byAgentType[agentType] = {
        executions: agentStat.executions,
        successRate: agentStat.executions > 0 ? agentStat.successes / agentStat.executions : 0,
        avgDuration: agentStat.executions > 0 ? agentStat.duration / agentStat.executions : 0,
        avgConfidence: agentStat.confidenceCount > 0 ? agentStat.confidence / agentStat.confidenceCount : 0,
        avgCost: agentStat.executions > 0 ? agentStat.cost / agentStat.executions : 0
      };
    }

    // Calculate agent health statistics
    for (const [agentType, healthStat] of agentHealthStats) {
      let healthStatus: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
      if (healthStat.unhealthy > healthStat.healthy && healthStat.unhealthy > healthStat.degraded) {
        healthStatus = 'unhealthy';
      } else if (healthStat.degraded > healthStat.healthy) {
        healthStatus = 'degraded';
      }

      stats.agentHealth.byAgentType[agentType] = {
        checks: healthStat.checks,
        healthStatus,
        avgResponseTime: healthStat.checks > 0 ? healthStat.responseTime / healthStat.checks : 0,
        errorRate: healthStat.errorRate
      };
    }

    return stats;
  }
}

export interface TelemetryStatistics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  aiSuggestions: {
    requested: number;
    responded: number;
    accepted: number;
    avgLatencyMs: number;
    totalCostUsd: number;
    avgAccuracyScore: number;
  };
  features: {
    mostUsed: { name: string; count: number }[];
    totalUsage: number;
  };
  pages: {
    mostViewed: { name: string; count: number }[];
    avgLoadTimeMs: number;
  };
  errors: {
    totalErrors: number;
    byService: Record<string, number>;
    byErrorCode: Record<string, number>;
  };
  // Week 5: Multi-Agent Orchestrator Statistics
  multiAgentWorkflows: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    avgDuration: number;
    totalCost: number;
    byWorkflowType: Record<string, {
      executions: number;
      successRate: number;
      avgDuration: number;
      avgCost: number;
    }>;
  };
  singleAgents: {
    totalExecutions: number;
    successfulExecutions: number;
    failedExecutions: number;
    avgDuration: number;
    avgConfidence: number;
    totalCost: number;
    byAgentType: Record<string, {
      executions: number;
      successRate: number;
      avgDuration: number;
      avgConfidence: number;
      avgCost: number;
    }>;
  };
  agentHealth: {
    totalChecks: number;
    healthyAgents: number;
    degradedAgents: number;
    unhealthyAgents: number;
    avgResponseTime: number;
    byAgentType: Record<string, {
      checks: number;
      healthStatus: 'healthy' | 'degraded' | 'unhealthy';
      avgResponseTime: number;
      errorRate: number;
    }>;
  };
  governance: {
    totalViolations: number;
    bySeverity: Record<string, number>;
    byViolationType: Record<string, number>;
    byAction: Record<string, number>;
  };
}

/**
 * In-memory telemetry backend for development/testing
 */
class InMemoryTelemetryBackend implements TelemetryBackend {
  private events: UnifiedTelemetryEvent[] = [];
  private readonly maxEvents = 10000; // Prevent memory leaks

  async store(event: UnifiedTelemetryEvent): Promise<void> {
    this.events.push(event);
    
    // Keep only the most recent events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents);
    }
  }

  async query(filters: TelemetryQueryFilters): Promise<UnifiedTelemetryEvent[]> {
    let filtered = [...this.events];

    if (filters.eventType) {
      filtered = filtered.filter(e => e.eventType === filters.eventType);
    }

    if (filters.userId) {
      filtered = filtered.filter(e => e.userId === filters.userId);
    }

    if (filters.sessionId) {
      filtered = filtered.filter(e => e.sessionId === filters.sessionId);
    }

    if (filters.startTime) {
      filtered = filtered.filter(e => new Date(e.timestamp) >= filters.startTime!);
    }

    if (filters.endTime) {
      filtered = filtered.filter(e => new Date(e.timestamp) <= filters.endTime!);
    }

    if (filters.limit) {
      filtered = filtered.slice(0, filters.limit);
    }

    return filtered;
  }
}