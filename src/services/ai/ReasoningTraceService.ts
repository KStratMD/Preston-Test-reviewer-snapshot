/**
 * @deprecated Use ReasoningTraceEngine with ReasoningTraceRepository instead.
 * ReasoningTraceEngine (src/services/ai/orchestrator/ReasoningTraceEngine.ts) now has
 * full DB persistence via ReasoningTraceRepository. This service is retained for
 * backward compatibility only and should not be used for new code.
 *
 * Original description:
 * Reasoning Trace Service - stub implementation for audit trails and explainability.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import type { DatabaseService } from '../../database/DatabaseService';
import type { ReasoningStep } from './orchestrator/interfaces';

export interface ReasoningTrace {
  id: string;
  sessionId: string;
  stepNumber: number;
  agentName: string;
  action: string;
  inputSummary?: string;
  outputSummary?: string;
  confidence: number;
  reasoning: string;
  timestamp: Date;
  executionTime: number;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface AISession {
  sessionId: string;
  userId?: string;
  workflowType?: string;
  startedAt: Date;
  completedAt?: Date;
  status: 'running' | 'completed' | 'failed';
  overallConfidence?: number;
  totalExecutionTime?: number;
  metadata?: Record<string, unknown>;
}

export interface ReasoningTraceQuery {
  sessionId?: string;
  userId?: string;
  agentName?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

@injectable()
export class ReasoningTraceService {
  private readonly DEFAULT_RETENTION_DAYS = 30;
  private initialized = false;
  // In-memory storage for stub implementation
  private traces = new Map<string, ReasoningTrace[]>();
  private sessions = new Map<string, AISession>();

  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.DatabaseService) private db: DatabaseService
  ) {
    this.logger.info('Reasoning Trace Service created (stub implementation)', {
      retentionDays: this.DEFAULT_RETENTION_DAYS
    });
  }

  /**
   * Initialize service (stub)
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.logger.info('Reasoning Trace Service initialized (stub - using in-memory storage)');
    this.initialized = true;
  }

  /**
   * Start a new AI session
   */
  async startSession(
    sessionId: string,
    userId?: string,
    workflowType?: string,
    metadata?: Record<string, unknown>
  ): Promise<void> {
    await this.ensureInitialized();

    const session: AISession = {
      sessionId,
      userId,
      workflowType,
      startedAt: new Date(),
      status: 'running',
      metadata
    };

    this.sessions.set(sessionId, session);
    this.logger.info('AI session started', { sessionId, userId, workflowType });
  }

  /**
   * Complete an AI session
   */
  async completeSession(
    sessionId: string,
    status: 'completed' | 'failed',
    overallConfidence?: number,
    totalExecutionTime?: number
  ): Promise<void> {
    await this.ensureInitialized();

    const session = this.sessions.get(sessionId);
    if (session) {
      session.completedAt = new Date();
      session.status = status;
      session.overallConfidence = overallConfidence;
      session.totalExecutionTime = totalExecutionTime;
      this.logger.info('AI session completed', { sessionId, status });
    }
  }

  /**
   * Store a reasoning step
   */
  async storeReasoningStep(
    sessionId: string,
    step: ReasoningStep,
    userId?: string
  ): Promise<void> {
    await this.ensureInitialized();

    const id = `${sessionId}-step-${step.step}`;
    const trace: ReasoningTrace = {
      id,
      sessionId,
      stepNumber: step.step,
      agentName: step.agent,
      action: step.action,
      inputSummary: this.summarize(step.input),
      outputSummary: this.summarize(step.output),
      confidence: step.confidence,
      reasoning: step.reasoning,
      timestamp: step.timestamp,
      executionTime: step.executionTime,
      userId
    };

    if (!this.traces.has(sessionId)) {
      this.traces.set(sessionId, []);
    }
    this.traces.get(sessionId)!.push(trace);

    this.logger.debug('Reasoning step stored', {
      sessionId,
      step: step.step,
      agent: step.agent
    });
  }

  /**
   * Retrieve all reasoning steps for a session
   */
  async getReasoningTrace(sessionId: string): Promise<ReasoningTrace[]> {
    await this.ensureInitialized();

    const traces = this.traces.get(sessionId) || [];
    this.logger.info('Reasoning trace retrieved', {
      sessionId,
      steps: traces.length
    });

    return traces.sort((a, b) => a.stepNumber - b.stepNumber);
  }

  /**
   * Retrieve AI session details
   */
  async getSession(sessionId: string): Promise<AISession | null> {
    await this.ensureInitialized();
    return this.sessions.get(sessionId) || null;
  }

  /**
   * Query reasoning traces with filters
   */
  async queryTraces(query: ReasoningTraceQuery): Promise<ReasoningTrace[]> {
    await this.ensureInitialized();

    let results: ReasoningTrace[] = [];

    // Collect all traces
    this.traces.forEach(traces => {
      results.push(...traces);
    });

    // Apply filters
    if (query.sessionId) {
      results = results.filter(t => t.sessionId === query.sessionId);
    }
    if (query.userId) {
      results = results.filter(t => t.userId === query.userId);
    }
    if (query.agentName) {
      results = results.filter(t => t.agentName === query.agentName);
    }
    if (query.startDate) {
      results = results.filter(t => t.timestamp >= query.startDate!);
    }
    if (query.endDate) {
      results = results.filter(t => t.timestamp <= query.endDate!);
    }

    // Sort and paginate
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    if (query.offset) {
      results = results.slice(query.offset);
    }
    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  /**
   * Delete reasoning traces older than retention period
   */
  async cleanupOldTraces(retentionDays: number = this.DEFAULT_RETENTION_DAYS): Promise<number> {
    await this.ensureInitialized();

    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;

    this.traces.forEach((traces, sessionId) => {
      const beforeCount = traces.length;
      this.traces.set(
        sessionId,
        traces.filter(t => t.timestamp >= cutoffDate)
      );
      deletedCount += beforeCount - this.traces.get(sessionId)!.length;
    });

    this.logger.info('Cleanup completed', {
      retentionDays,
      deletedTraces: deletedCount,
      cutoffDate: cutoffDate.toISOString()
    });

    return deletedCount;
  }

  /**
   * Export reasoning trace as JSON for compliance/audit
   */
  async exportTrace(sessionId: string): Promise<{
    session: AISession | null;
    reasoningSteps: ReasoningTrace[];
    exportedAt: Date;
  }> {
    const session = await this.getSession(sessionId);
    const reasoningSteps = await this.getReasoningTrace(sessionId);

    return {
      session,
      reasoningSteps,
      exportedAt: new Date()
    };
  }

  /**
   * Helper: Ensure service is initialized
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Helper: Summarize input/output for storage (truncate long data)
   */
  private summarize(data: unknown): string {
    try {
      const str = typeof data === 'string' ? data : JSON.stringify(data);
      return str.length > 500 ? str.substring(0, 500) + '...[truncated]' : str;
    } catch {
      return '[Unable to serialize]';
    }
  }
}
