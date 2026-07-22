import { injectable, inject } from 'inversify';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { DatabaseService } from '../DatabaseService';
import { TYPES } from '../../inversify/types';
import type {
  Database,
  AISessionRow,
  NewAISession,
  ReasoningTraceRow,
  NewReasoningTrace,
} from '../types';

/**
 * Parse a JSON field from the database.
 * SQLite returns TEXT (string), PostgreSQL returns parsed objects for JSONB.
 */
function parseJson<T>(value: unknown): T {
  if (typeof value === 'string') {
    return JSON.parse(value) as T;
  }
  return value as T;
}

/**
 * Convert a Date to ISO string for SQLite compatibility.
 * SQLite only binds numbers, strings, bigints, buffers, and null.
 */
function dateToStr(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : d;
}

export interface TraceQueryFilters {
  sessionIds?: string[];
  userId?: string;
  startDate?: Date;
  endDate?: Date;
  status?: string;
  minConfidence?: number;
}

export interface TracePagination {
  offset?: number;
  limit?: number;
}

/**
 * Repository for AI sessions and reasoning traces persistence.
 * Follows the MDMRepository pattern: Kysely-based, SQLite/PostgreSQL portable.
 */
@injectable()
export class ReasoningTraceRepository {
  private readonly db: Kysely<Database>;

  constructor(@inject(TYPES.DatabaseService) databaseService: DatabaseService) {
    this.db = databaseService.getDatabase();
  }

  // ── AI Sessions ───────────────────────────────────────────────────

  async insertSession(session: {
    sessionId: string;
    userId?: string;
    workflowType?: string;
    startedAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insertInto('ai_sessions')
      .values({
        session_id: session.sessionId,
        user_id: session.userId ?? null,
        workflow_type: session.workflowType ?? null,
        started_at: dateToStr(session.startedAt) as unknown as Date,
        status: 'running',
        metadata: session.metadata ? JSON.stringify(session.metadata) as unknown as object : null,
        created_at: dateToStr(new Date()) as unknown as Date,
      })
      .execute();
  }

  async updateSession(sessionId: string, updates: {
    completedAt?: Date;
    status?: string;
    overallConfidence?: number;
    totalExecutionTime?: number;
  }): Promise<void> {
    const values: Record<string, unknown> = {};
    if (updates.completedAt !== undefined) {
      values.completed_at = dateToStr(updates.completedAt);
    }
    if (updates.status !== undefined) {
      values.status = updates.status;
    }
    if (updates.overallConfidence !== undefined) {
      values.overall_confidence = updates.overallConfidence;
    }
    if (updates.totalExecutionTime !== undefined) {
      values.total_execution_time = updates.totalExecutionTime;
    }

    if (Object.keys(values).length === 0) return;

    await this.db.updateTable('ai_sessions')
      .set(values)
      .where('session_id', '=', sessionId)
      .execute();
  }

  async getSession(sessionId: string): Promise<AISessionRow | null> {
    const row = await this.db.selectFrom('ai_sessions')
      .selectAll()
      .where('session_id', '=', sessionId)
      .executeTakeFirst();

    if (!row) return null;

    return {
      ...row,
      metadata: row.metadata ? parseJson<object>(row.metadata) : null,
    };
  }

  // ── Reasoning Traces ──────────────────────────────────────────────

  async insertTrace(trace: {
    id: string;
    sessionId: string;
    stepNumber: number;
    agentName: string;
    action: string;
    inputSummary?: string;
    outputSummary?: string;
    confidence?: number;
    reasoning?: string;
    timestamp: Date;
    executionTime?: number;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.db.insertInto('reasoning_traces')
      .values({
        id: trace.id,
        session_id: trace.sessionId,
        step_number: trace.stepNumber,
        agent_name: trace.agentName,
        action: trace.action,
        input_summary: trace.inputSummary ?? null,
        output_summary: trace.outputSummary ?? null,
        confidence: trace.confidence ?? null,
        reasoning: trace.reasoning ?? null,
        timestamp: dateToStr(trace.timestamp) as unknown as Date,
        execution_time: trace.executionTime ?? null,
        user_id: trace.userId ?? null,
        metadata: trace.metadata ? JSON.stringify(trace.metadata) as unknown as object : null,
        created_at: dateToStr(new Date()) as unknown as Date,
      })
      .execute();
  }

  async getTracesBySession(sessionId: string): Promise<ReasoningTraceRow[]> {
    const rows = await this.db.selectFrom('reasoning_traces')
      .selectAll()
      .where('session_id', '=', sessionId)
      .orderBy('step_number', 'asc')
      .execute();

    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? parseJson<object>(row.metadata) : null,
    }));
  }

  async queryTraces(
    filters: TraceQueryFilters,
    pagination: TracePagination = {}
  ): Promise<AISessionRow[]> {
    let query = this.db.selectFrom('ai_sessions').selectAll();

    if (filters.sessionIds && filters.sessionIds.length > 0) {
      query = query.where('session_id', 'in', filters.sessionIds);
    }
    if (filters.userId) {
      query = query.where('user_id', '=', filters.userId);
    }
    if (filters.startDate) {
      query = query.where('started_at', '>=', dateToStr(filters.startDate) as unknown as Date);
    }
    if (filters.endDate) {
      query = query.where('started_at', '<=', dateToStr(filters.endDate) as unknown as Date);
    }
    if (filters.status) {
      query = query.where('status', '=', filters.status);
    }
    if (filters.minConfidence !== undefined) {
      query = query.where('overall_confidence', '>=', filters.minConfidence);
    }

    query = query.orderBy('started_at', 'desc');

    if (pagination.offset) {
      query = query.offset(pagination.offset);
    }
    if (pagination.limit) {
      query = query.limit(pagination.limit);
    }

    const rows = await query.execute();
    return rows.map(row => ({
      ...row,
      metadata: row.metadata ? parseJson<object>(row.metadata) : null,
    }));
  }

  async countSessions(): Promise<number> {
    const result = await sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM ai_sessions
    `.execute(this.db);
    return Number(result.rows[0]?.cnt ?? 0);
  }

  async countBySession(sessionId: string): Promise<number> {
    const result = await sql<{ cnt: number }>`
      SELECT COUNT(*) as cnt FROM reasoning_traces WHERE session_id = ${sessionId}
    `.execute(this.db);
    return Number(result.rows[0]?.cnt ?? 0);
  }

  async deleteOlderThan(days: number): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const cutoffStr = dateToStr(cutoff);

    // Delete old sessions — FK CASCADE handles reasoning_traces cleanup
    const result = await this.db.transaction().execute(async (trx) => {
      return await sql`
        DELETE FROM ai_sessions WHERE started_at < ${cutoffStr}
      `.execute(trx);
    });

    return Number(result.numAffectedRows ?? 0);
  }

  async getUsageLogsByDateRange(startDate: Date, endDate: Date): Promise<unknown[]> {
    const rows = await this.db.selectFrom('ai_usage_logs')
      .selectAll()
      .where('created_at', '>=', dateToStr(startDate) as unknown as Date)
      .where('created_at', '<=', dateToStr(endDate) as unknown as Date)
      .orderBy('created_at', 'desc')
      .execute();
    return rows;
  }
}
