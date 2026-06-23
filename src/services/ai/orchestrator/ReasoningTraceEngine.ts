/**
 * Reasoning Trace Engine - Captures and manages agent reasoning traces
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject, optional } from 'inversify';
import { TYPES } from '../../../inversify/types';
import { logger, type Logger } from '../../../utils/Logger';
import type { ReasoningStep } from './interfaces';
import type { ReasoningTraceRepository } from '../../../database/repositories/ReasoningTraceRepository';
import { uuidv4 } from '../../../utils/uuid';
import { getElapsedMsFromDates } from './timing';

const MAX_JSON_LENGTH = 10000;

function safeTruncateJson(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const json = JSON.stringify(value);
  return json.length > MAX_JSON_LENGTH ? undefined : json;
}

function safeJsonParse(value: string | null | undefined): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export interface ReasoningTrace {
  sessionId: string;
  steps: ReasoningStep[];
  startTime: Date;
  endTime?: Date;
  totalExecutionTime?: number;
  overallConfidence?: number;
  summary?: string;
  metadata: TraceMetadata;
}

export interface TraceMetadata {
  userId?: string;
  sourceSystem: string;
  targetSystem: string;
  businessProcess?: string;
  industry?: string;
  agentCount: number;
  stepCount: number;
  errorCount: number;
  warningCount: number;
}

export interface TraceAnalysis {
  confidenceTrend: number[];
  performanceMetrics: {
    averageStepTime: number;
    slowestStep: ReasoningStep;
    fastestStep: ReasoningStep;
    totalTime: number;
  };
  qualityMetrics: {
    consistencyScore: number;
    coherenceScore: number;
    completenessScore: number;
  };
  recommendations: string[];
  issues: TraceIssue[];
}

export interface TraceIssue {
  severity: 'low' | 'medium' | 'high';
  type: 'performance' | 'confidence' | 'reasoning' | 'consistency';
  step?: number;
  message: string;
  suggestion: string;
}

export interface TraceQuery {
  sessionIds?: string[];
  userId?: string;
  dateRange?: {
    start: Date;
    end: Date;
  };
  agents?: string[];
  minConfidence?: number;
  maxExecutionTime?: number;
  hasErrors?: boolean;
  limit?: number;
  offset?: number;
}

@injectable()
export class ReasoningTraceEngine {
  private traces = new Map<string, ReasoningTrace>();
  private stepCounters = new Map<string, number>();
  private traceRetentionDays = 30;
  private maxTracesInMemory = 1000;

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ReasoningTraceRepository) @optional() private repo?: ReasoningTraceRepository
  ) {
    this.initializeEngine();
  }

  /**
   * Start a new reasoning trace for a session
   */
  async startTrace(
    sessionId: string,
    metadata: Omit<TraceMetadata, 'agentCount' | 'stepCount' | 'errorCount' | 'warningCount'>
  ): Promise<void> {
    const trace: ReasoningTrace = {
      sessionId,
      steps: [],
      startTime: new Date(),
      metadata: {
        ...metadata,
        agentCount: 0,
        stepCount: 0,
        errorCount: 0,
        warningCount: 0
      }
    };

    this.traces.set(sessionId, trace);
    this.stepCounters.set(sessionId, 0);

    // Persist session to DB (awaited for reliability — core differentiator)
    if (this.repo) {
      try {
        await this.repo.insertSession({
          sessionId,
          userId: metadata.userId,
          workflowType: metadata.businessProcess,
          startedAt: trace.startTime,
          metadata: { sourceSystem: metadata.sourceSystem, targetSystem: metadata.targetSystem },
        });
      } catch (err) {
        this.logger.warn('Failed to persist trace session to DB', { sessionId, error: String(err) });
      }
    }

    this.logger.info('Reasoning trace started', {
      sessionId,
      sourceSystem: metadata.sourceSystem,
      targetSystem: metadata.targetSystem
    });
  }

  /**
   * Get the next step number for a session.
   * Uses a synchronous counter (no async gap) so concurrent Promise.all
   * agents each get a unique number — JS single-thread guarantees atomicity.
   */
  getNextStepNumber(sessionId: string): number {
    const current = this.stepCounters.get(sessionId) ?? 0;
    const next = current + 1;
    this.stepCounters.set(sessionId, next);
    return next;
  }

  /**
   * Record a reasoning step
   */
  async recordStep(sessionId: string, step: ReasoningStep): Promise<void> {
    const trace = this.traces.get(sessionId);
    if (!trace) {
      this.logger.warn('Attempted to record step for unknown trace', {
        sessionId,
        agent: step.agent
      });
      return;
    }

    // Validate step
    this.validateStep(step);

    // Add step to trace
    trace.steps.push(step);
    trace.metadata.stepCount++;

    // Update agent count if new agent
    const uniqueAgents = new Set(trace.steps.map(s => s.agent));
    trace.metadata.agentCount = uniqueAgents.size;

    // Count errors and warnings
    if (step.output && typeof step.output === 'object') {
      if ((step.output as any).errors && (step.output as any).errors.length > 0) {
        trace.metadata.errorCount++;
      }
      if ((step.output as any).warnings && (step.output as any).warnings.length > 0) {
        trace.metadata.warningCount++;
      }
    }

    // Write-through to DB
    if (this.repo) {
      try {
        await this.repo.insertTrace({
          id: uuidv4(),
          sessionId,
          stepNumber: step.step,
          agentName: step.agent,
          action: step.action,
          inputSummary: safeTruncateJson(step.input),
          outputSummary: safeTruncateJson(step.output),
          confidence: step.confidence,
          reasoning: step.reasoning,
          timestamp: step.timestamp,
          executionTime: step.executionTime,
          userId: trace.metadata.userId,
        });
      } catch (err) {
        this.logger.warn('Failed to persist reasoning step to DB', { sessionId, step: step.step, error: String(err) });
      }
    }

    this.logger.debug('Reasoning step recorded', {
      sessionId,
      step: step.step,
      agent: step.agent,
      action: step.action,
      confidence: step.confidence,
      executionTime: step.executionTime
    });

    // Check for trace completion indicators
    await this.checkTraceCompletion(sessionId);
  }

  /**
   * Complete a reasoning trace
   */
  async completeTrace(sessionId: string, summary?: string, status?: 'completed' | 'failed'): Promise<ReasoningTrace | null> {
    const trace = this.traces.get(sessionId);
    if (!trace) {
      return null;
    }

    trace.endTime = new Date();
    trace.totalExecutionTime = getElapsedMsFromDates(trace.startTime, trace.endTime);
    trace.summary = summary || await this.generateTraceSummary(trace);

    // Calculate overall confidence
    trace.overallConfidence = this.calculateOverallConfidence(trace.steps);

    // Persist completion to DB
    if (this.repo) {
      try {
        await this.repo.updateSession(sessionId, {
          completedAt: trace.endTime,
          status: status || 'completed',
          overallConfidence: trace.overallConfidence,
          totalExecutionTime: trace.totalExecutionTime,
        });
      } catch (err) {
        this.logger.warn('Failed to persist trace completion to DB', { sessionId, error: String(err) });
      }
    }

    this.logger.info('Reasoning trace completed', {
      sessionId,
      stepCount: trace.metadata.stepCount,
      agentCount: trace.metadata.agentCount,
      totalTime: trace.totalExecutionTime,
      overallConfidence: trace.overallConfidence
    });

    return trace;
  }

  /**
   * Get a reasoning trace by session ID (lazy-loads from DB on cache miss)
   */
  async getTrace(sessionId: string): Promise<ReasoningTrace | null> {
    const cached = this.traces.get(sessionId);
    if (cached) return cached;

    // Lazy-load from DB on cache miss
    if (this.repo) {
      try {
        const session = await this.repo.getSession(sessionId);
        if (session) {
          const rows = await this.repo.getTracesBySession(sessionId);
          const steps: ReasoningStep[] = rows.map(r => ({
            step: r.step_number,
            agent: r.agent_name,
            action: r.action,
            input: safeJsonParse(r.input_summary as string),
            output: safeJsonParse(r.output_summary as string),
            confidence: r.confidence ?? 0,
            reasoning: r.reasoning ?? '',
            timestamp: new Date(r.timestamp as unknown as string),
            executionTime: r.execution_time ?? 0,
          }));
          const trace: ReasoningTrace = {
            sessionId,
            steps,
            startTime: new Date(session.started_at as unknown as string),
            endTime: session.completed_at ? new Date(session.completed_at as unknown as string) : undefined,
            totalExecutionTime: session.total_execution_time ?? undefined,
            overallConfidence: session.overall_confidence ?? undefined,
            metadata: {
              userId: session.user_id ?? undefined,
              sourceSystem: (session.metadata as any)?.sourceSystem ?? 'unknown',
              targetSystem: (session.metadata as any)?.targetSystem ?? 'unknown',
              businessProcess: session.workflow_type ?? undefined,
              agentCount: new Set(steps.map(s => s.agent)).size,
              stepCount: steps.length,
              errorCount: steps.filter(s => s.output && typeof s.output === 'object' && (s.output as any).errors && (s.output as any).errors.length > 0).length,
              warningCount: steps.filter(s => s.output && typeof s.output === 'object' && (s.output as any).warnings && (s.output as any).warnings.length > 0).length,
            },
          };
          this.traces.set(sessionId, trace);
          this.stepCounters.set(sessionId, steps.length > 0 ? Math.max(...steps.map(s => s.step)) : 0);
          return trace;
        }
      } catch (err) {
        this.logger.warn('Failed to lazy-load trace from DB', { sessionId, error: String(err) });
      }
    }

    return null;
  }

  /**
   * Get reasoning steps for a session (lazy-loads from DB on cache miss)
   */
  async getSteps(sessionId: string): Promise<ReasoningStep[]> {
    const trace = this.traces.get(sessionId);
    if (trace) return [...trace.steps];

    // Lazy-load from DB on cache miss
    if (this.repo) {
      try {
        const rows = await this.repo.getTracesBySession(sessionId);
        if (rows.length > 0) {
          return rows.map(r => ({
            step: r.step_number,
            agent: r.agent_name,
            action: r.action,
            input: safeJsonParse(r.input_summary as string),
            output: safeJsonParse(r.output_summary as string),
            confidence: r.confidence ?? 0,
            reasoning: r.reasoning ?? '',
            timestamp: new Date(r.timestamp as unknown as string),
            executionTime: r.execution_time ?? 0,
          }));
        }
      } catch (err) {
        this.logger.warn('Failed to lazy-load steps from DB', { sessionId, error: String(err) });
      }
    }

    return [];
  }

  /**
   * Query traces based on criteria.
   * Delegates session-level filters to the DB repo when available (full history),
   * then applies step-level filters (agents, hasErrors) in memory.
   * Falls back to in-memory-only when no repo is configured.
   */
  async queryTraces(query: TraceQuery): Promise<ReasoningTrace[]> {
    let results: ReasoningTrace[];

    if (this.repo) {
      try {
        // Delegate session-level filters to DB
        const rows = await this.repo.queryTraces(
          {
            sessionIds: query.sessionIds,
            userId: query.userId,
            startDate: query.dateRange?.start,
            endDate: query.dateRange?.end,
            minConfidence: query.minConfidence,
          },
          // Only pass pagination when no step-level filters need post-filtering
          (!query.agents && query.hasErrors === undefined && query.maxExecutionTime === undefined)
            ? { offset: query.offset, limit: query.limit }
            : {}
        );

        // Hydrate full traces (lazy-loads steps via getTrace)
        const hydrated = await Promise.all(
          rows.map(r => this.getTrace(r.session_id))
        );
        results = hydrated.filter((t): t is ReasoningTrace => t !== null);
      } catch (err) {
        this.logger.warn('queryTraces DB fallback to in-memory', { error: String(err) });
        results = Array.from(this.traces.values());
      }
    } else {
      results = Array.from(this.traces.values());
    }

    // Apply filters that require step/trace data (not expressible in DB query)
    if (!this.repo) {
      // In-memory path: apply all filters locally
      if (query.sessionIds) {
        results = results.filter(trace => query.sessionIds!.includes(trace.sessionId));
      }
      if (query.userId) {
        results = results.filter(trace => trace.metadata.userId === query.userId);
      }
      if (query.dateRange) {
        results = results.filter(trace =>
          trace.startTime >= query.dateRange!.start &&
          trace.startTime <= query.dateRange!.end
        );
      }
      if (query.minConfidence !== undefined) {
        results = results.filter(trace =>
          trace.overallConfidence !== undefined &&
          trace.overallConfidence >= query.minConfidence!
        );
      }
    }

    // Step-level filters (always applied in memory)
    if (query.agents) {
      results = results.filter(trace =>
        query.agents!.some(agent =>
          trace.steps.some(step => step.agent === agent)
        )
      );
    }

    if (query.maxExecutionTime !== undefined) {
      results = results.filter(trace =>
        trace.totalExecutionTime !== undefined &&
        trace.totalExecutionTime <= query.maxExecutionTime!
      );
    }

    if (query.hasErrors !== undefined) {
      results = results.filter(trace =>
        query.hasErrors ? trace.metadata.errorCount > 0 : trace.metadata.errorCount === 0
      );
    }

    // Sort by start time (newest first)
    results.sort((a, b) => b.startTime.getTime() - a.startTime.getTime());

    // Apply pagination (when not already applied at DB level)
    if (!this.repo || query.agents || query.hasErrors !== undefined || query.maxExecutionTime !== undefined) {
      const offset = query.offset || 0;
      const limit = query.limit || results.length;
      results = results.slice(offset, offset + limit);
    }

    return results;
  }

  /**
   * Analyze a reasoning trace for quality and performance
   */
  async analyzeTrace(sessionId: string): Promise<TraceAnalysis | null> {
    const trace = this.traces.get(sessionId);
    if (!trace || trace.steps.length === 0) {
      return null;
    }

    const analysis: TraceAnalysis = {
      confidenceTrend: this.analyzeConfidenceTrend(trace.steps),
      performanceMetrics: this.analyzePerformance(trace.steps),
      qualityMetrics: this.analyzeQuality(trace.steps),
      recommendations: [],
      issues: []
    };

    // Generate recommendations based on analysis
    analysis.recommendations = await this.generateRecommendations(trace, analysis);
    analysis.issues = await this.identifyIssues(trace, analysis);

    this.logger.info('Trace analysis completed', {
      sessionId,
      confidenceRange: [
        Math.min(...analysis.confidenceTrend),
        Math.max(...analysis.confidenceTrend)
      ],
      avgStepTime: analysis.performanceMetrics.averageStepTime,
      qualityScore: (
        analysis.qualityMetrics.consistencyScore +
        analysis.qualityMetrics.coherenceScore +
        analysis.qualityMetrics.completenessScore
      ) / 3,
      issueCount: analysis.issues.length
    });

    return analysis;
  }

  /**
   * Generate a human-readable summary of the reasoning trace
   */
  async generateTraceSummary(trace: ReasoningTrace): Promise<string> {
    if (trace.steps.length === 0) {
      return 'No reasoning steps recorded.';
    }

    const agents = new Set(trace.steps.map(s => s.agent));
    const avgConfidence = trace.steps.reduce((sum, s) => sum + s.confidence, 0) / trace.steps.length;
    const totalTime = trace.totalExecutionTime || 0;

    const summaryParts = [
      `Executed ${trace.steps.length} reasoning steps across ${agents.size} agents`,
      `Average confidence: ${(avgConfidence * 100).toFixed(1)}%`,
      `Total execution time: ${totalTime}ms`
    ];

    if (trace.metadata.errorCount > 0) {
      summaryParts.push(`Encountered ${trace.metadata.errorCount} errors`);
    }

    if (trace.metadata.warningCount > 0) {
      summaryParts.push(`Generated ${trace.metadata.warningCount} warnings`);
    }

    // Add key reasoning insights
    const highConfidenceSteps = trace.steps.filter(s => s.confidence >= 0.8);
    if (highConfidenceSteps.length > 0) {
      summaryParts.push(`${highConfidenceSteps.length} high-confidence steps`);
    }

    return summaryParts.join('. ') + '.';
  }

  /**
   * Export trace data for external analysis
   */
  exportTrace(sessionId: string, format: 'json' | 'csv'): string | null {
    const trace = this.traces.get(sessionId);
    if (!trace) {
      return null;
    }

    if (format === 'json') {
      return JSON.stringify(trace, null, 2);
    } else if (format === 'csv') {
      return this.convertTraceToCsv(trace);
    }

    return null;
  }

  /**
   * Get trace statistics
   */
  getTraceStatistics(): {
    totalTraces: number;
    completedTraces: number;
    averageStepsPerTrace: number;
    averageExecutionTime: number;
    averageConfidence: number;
    topAgents: { agent: string; usage: number }[];
  } {
    const allTraces = Array.from(this.traces.values());
    const completedTraces = allTraces.filter(t => t.endTime);

    const totalSteps = allTraces.reduce((sum, t) => sum + t.steps.length, 0);
    const totalTime = completedTraces.reduce((sum, t) => sum + (t.totalExecutionTime || 0), 0);

    const allSteps = allTraces.flatMap(t => t.steps);
    const avgConfidence = allSteps.length > 0
      ? allSteps.reduce((sum, s) => sum + s.confidence, 0) / allSteps.length
      : 0;

    // Calculate agent usage
    const agentUsage = new Map<string, number>();
    allSteps.forEach(step => {
      agentUsage.set(step.agent, (agentUsage.get(step.agent) || 0) + 1);
    });

    const topAgents = Array.from(agentUsage.entries())
      .map(([agent, usage]) => ({ agent, usage }))
      .sort((a, b) => b.usage - a.usage)
      .slice(0, 10);

    return {
      totalTraces: allTraces.length,
      completedTraces: completedTraces.length,
      averageStepsPerTrace: allTraces.length > 0 ? totalSteps / allTraces.length : 0,
      averageExecutionTime: completedTraces.length > 0 ? totalTime / completedTraces.length : 0,
      averageConfidence: avgConfidence,
      topAgents
    };
  }

  /**
   * Clean up old traces based on retention policy
   */
  async cleanupOldTraces(): Promise<number> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.traceRetentionDays);

    let cleanedCount = 0;
    for (const [sessionId, trace] of this.traces) {
      if (trace.startTime < cutoffDate) {
        this.traces.delete(sessionId);
        this.stepCounters.delete(sessionId);
        cleanedCount++;
      }
    }

    // Also cleanup if we exceed max traces in memory
    if (this.traces.size > this.maxTracesInMemory) {
      const sortedTraces = Array.from(this.traces.entries())
        .sort(([, a], [, b]) => a.startTime.getTime() - b.startTime.getTime());

      const toRemove = sortedTraces.slice(0, this.traces.size - this.maxTracesInMemory);
      toRemove.forEach(([sessionId]) => {
        this.traces.delete(sessionId);
        this.stepCounters.delete(sessionId);
        cleanedCount++;
      });
    }

    // Purge from DB
    if (this.repo) {
      try {
        const dbCleaned = await this.repo.deleteOlderThan(this.traceRetentionDays);
        cleanedCount += dbCleaned;
      } catch (err) {
        this.logger.warn('Failed to purge old traces from DB', { error: String(err) });
      }
    }

    if (cleanedCount > 0) {
      this.logger.info('Cleaned up old traces', {
        cleanedCount,
        remainingTraces: this.traces.size
      });
    }

    return cleanedCount;
  }

  // Private methods

  private cleanupTimer?: ReturnType<typeof setInterval>;

  private initializeEngine(): void {
    this.logger.info('Reasoning trace engine initialized', {
      retentionDays: this.traceRetentionDays,
      maxTracesInMemory: this.maxTracesInMemory
    });

    // Start periodic cleanup (fire-and-forget with error swallowing)
    this.cleanupTimer = setInterval(() => {
      void this.cleanupOldTraces().catch(err =>
        this.logger.error('Trace cleanup failed', { error: String(err) })
      );
    }, 3600000); // Every hour
  }

  /**
   * Stop the periodic cleanup timer. Call in tests to prevent open handle warnings.
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private validateStep(step: ReasoningStep): void {
    if (typeof step.step !== 'number' || step.step < 0) {
      throw new Error('Step number must be a non-negative number');
    }

    if (!step.agent || typeof step.agent !== 'string') {
      throw new Error('Step must have a valid agent name');
    }

    if (!step.action || typeof step.action !== 'string') {
      throw new Error('Step must have a valid action');
    }

    if (typeof step.confidence !== 'number' || step.confidence < 0 || step.confidence > 1) {
      throw new Error('Step confidence must be a number between 0 and 1');
    }

    if (typeof step.executionTime !== 'number' || step.executionTime < 0) {
      throw new Error('Step execution time must be a non-negative number');
    }
  }

  private async checkTraceCompletion(sessionId: string): Promise<void> {
    const trace = this.traces.get(sessionId);
    if (!trace) return;

    // Auto-complete if we detect final steps
    const lastStep = trace.steps[trace.steps.length - 1];
    if (lastStep && (
      lastStep.action === 'complete' ||
      lastStep.action === 'finalize' ||
      lastStep.reasoning.toLowerCase().includes('final')
    )) {
      await this.completeTrace(sessionId, 'Auto-completed based on final step detection');
    }
  }

  private calculateOverallConfidence(steps: ReasoningStep[]): number {
    if (steps.length === 0) return 0;

    // Weighted average with more recent steps having higher weight
    let totalWeight = 0;
    let weightedSum = 0;

    steps.forEach((step, index) => {
      const weight = index + 1; // Later steps have higher weight
      totalWeight += weight;
      weightedSum += step.confidence * weight;
    });

    return totalWeight > 0 ? weightedSum / totalWeight : 0;
  }

  private analyzeConfidenceTrend(steps: ReasoningStep[]): number[] {
    return steps.map(step => step.confidence);
  }

  private analyzePerformance(steps: ReasoningStep[]): TraceAnalysis['performanceMetrics'] {
    if (steps.length === 0) {
      return {
        averageStepTime: 0,
        slowestStep: {} as ReasoningStep,
        fastestStep: {} as ReasoningStep,
        totalTime: 0
      };
    }

    const totalTime = steps.reduce((sum, step) => sum + step.executionTime, 0);
    const averageStepTime = totalTime / steps.length;
    const slowestStep = steps.reduce((slowest, step) =>
      step.executionTime > slowest.executionTime ? step : slowest
    );
    const fastestStep = steps.reduce((fastest, step) =>
      step.executionTime < fastest.executionTime ? step : fastest
    );

    return {
      averageStepTime,
      slowestStep,
      fastestStep,
      totalTime
    };
  }

  private analyzeQuality(steps: ReasoningStep[]): TraceAnalysis['qualityMetrics'] {
    if (steps.length === 0) {
      return {
        consistencyScore: 0,
        coherenceScore: 0,
        completenessScore: 0
      };
    }

    // Simple quality metrics based on confidence and reasoning length
    const avgConfidence = steps.reduce((sum, s) => sum + s.confidence, 0) / steps.length;
    const avgReasoningLength = steps.reduce((sum, s) => sum + s.reasoning.length, 0) / steps.length;

    const consistencyScore = 1 - (Math.abs(avgConfidence - 0.7) / 0.7); // Consistency around 70%
    const coherenceScore = Math.min(1, avgReasoningLength / 100); // Better reasoning = higher score
    const completenessScore = Math.min(1, steps.length / 5); // More steps = more complete

    return {
      consistencyScore: Math.max(0, Math.min(1, consistencyScore)),
      coherenceScore: Math.max(0, Math.min(1, coherenceScore)),
      completenessScore: Math.max(0, Math.min(1, completenessScore))
    };
  }

  private async generateRecommendations(
    trace: ReasoningTrace,
    analysis: TraceAnalysis
  ): Promise<string[]> {
    const recommendations: string[] = [];

    // Performance recommendations
    if (analysis.performanceMetrics.averageStepTime > 5000) {
      recommendations.push('Consider optimizing agent execution time - average step time is high');
    }

    // Confidence recommendations
    const avgConfidence = analysis.confidenceTrend.reduce((a, b) => a + b, 0) / analysis.confidenceTrend.length;
    if (avgConfidence < 0.6) {
      recommendations.push('Overall confidence is low - consider reviewing input data quality');
    }

    // Quality recommendations
    if (analysis.qualityMetrics.coherenceScore < 0.5) {
      recommendations.push('Reasoning quality could be improved - consider more detailed explanations');
    }

    return recommendations;
  }

  private async identifyIssues(
    trace: ReasoningTrace,
    analysis: TraceAnalysis
  ): Promise<TraceIssue[]> {
    const issues: TraceIssue[] = [];

    // Performance issues
    const slowSteps = trace.steps.filter(step => step.executionTime > 10000);
    slowSteps.forEach(step => {
      issues.push({
        severity: 'medium',
        type: 'performance',
        step: step.step,
        message: `Step ${step.step} took ${step.executionTime}ms to execute`,
        suggestion: 'Consider optimizing agent logic or increasing timeout'
      });
    });

    // Confidence issues
    const lowConfidenceSteps = trace.steps.filter(step => step.confidence < 0.3);
    lowConfidenceSteps.forEach(step => {
      issues.push({
        severity: 'high',
        type: 'confidence',
        step: step.step,
        message: `Step ${step.step} has very low confidence (${step.confidence})`,
        suggestion: 'Review input data quality or agent logic'
      });
    });

    return issues;
  }

  private convertTraceToCsv(trace: ReasoningTrace): string {
    const headers = [
      'Step',
      'Agent',
      'Action',
      'Confidence',
      'Execution Time',
      'Timestamp',
      'Reasoning'
    ];

    const rows = trace.steps.map(step => [
      step.step.toString(),
      step.agent,
      step.action,
      step.confidence.toString(),
      step.executionTime.toString(),
      step.timestamp.toISOString(),
      `"${step.reasoning.replace(/"/g, '""')}"`
    ]);

    return [headers.join(','), ...rows.map(row => row.join(','))].join('\n');
  }
}
