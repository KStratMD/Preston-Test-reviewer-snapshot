import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { ReasoningTraceRepository } from '../../../../../src/database/repositories/ReasoningTraceRepository';
import type { Database } from '../../../../../src/database/types';

/**
 * ReasoningTraceRepository unit tests using in-memory SQLite.
 * Validates CRUD, JSON roundtrip, filtering, pagination, and cleanup.
 */
describe('ReasoningTraceRepository', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;
  let repo: ReasoningTraceRepository;

  beforeAll(async () => {
    sqlite = new BetterSqlite3(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: sqlite }),
    });

    // Create ai_sessions table
    await sql`
      CREATE TABLE ai_sessions (
        session_id TEXT PRIMARY KEY,
        user_id TEXT,
        workflow_type TEXT,
        started_at DATETIME NOT NULL,
        completed_at DATETIME,
        status TEXT,
        overall_confidence REAL,
        total_execution_time INTEGER,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `.execute(db);

    // Create reasoning_traces table
    await sql`
      CREATE TABLE reasoning_traces (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES ai_sessions(session_id) ON DELETE CASCADE,
        step_number INTEGER NOT NULL,
        agent_name TEXT NOT NULL,
        action TEXT NOT NULL,
        input_summary TEXT,
        output_summary TEXT,
        confidence REAL,
        reasoning TEXT,
        timestamp DATETIME NOT NULL,
        execution_time INTEGER,
        user_id TEXT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(session_id, step_number)
      )
    `.execute(db);

    // Create ai_usage_logs table (needed for getUsageLogsByDateRange)
    await sql`
      CREATE TABLE ai_usage_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL DEFAULT -1,
        organization_id INTEGER,
        provider_config_id INTEGER,
        task_model_config_id INTEGER,
        task_type TEXT NOT NULL,
        provider_type TEXT NOT NULL,
        model_version TEXT NOT NULL,
        prompt_tokens INTEGER NOT NULL DEFAULT 0,
        completion_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost REAL NOT NULL DEFAULT 0,
        request_type TEXT NOT NULL,
        session_id TEXT,
        execution_time_ms INTEGER NOT NULL DEFAULT 0,
        success INTEGER NOT NULL DEFAULT 1,
        error_message TEXT,
        records_processed INTEGER NOT NULL DEFAULT 0,
        fields_analyzed INTEGER NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `.execute(db);

    // Wire up repository with a fake DatabaseService
    const fakeDatabaseService = { getDatabase: () => db } as any;
    repo = new ReasoningTraceRepository(fakeDatabaseService);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    // Clear tables between tests (order matters for FK)
    await sql`DELETE FROM reasoning_traces`.execute(db);
    await sql`DELETE FROM ai_sessions`.execute(db);
  });

  describe('Session CRUD', () => {
    it('should insert and retrieve a session', async () => {
      await repo.insertSession({
        sessionId: 'sess-001',
        userId: 'user-1',
        workflowType: 'workflow',
        startedAt: new Date('2026-02-10T10:00:00Z'),
        metadata: { sourceSystem: 'NetSuite', targetSystem: 'BC' },
      });

      const session = await repo.getSession('sess-001');
      expect(session).not.toBeNull();
      expect(session!.session_id).toBe('sess-001');
      expect(session!.user_id).toBe('user-1');
      expect(session!.workflow_type).toBe('workflow');
      expect(session!.status).toBe('running');
    });

    it('should return null for nonexistent session', async () => {
      const session = await repo.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should update session with completion data', async () => {
      await repo.insertSession({
        sessionId: 'sess-002',
        startedAt: new Date('2026-02-10T10:00:00Z'),
      });

      await repo.updateSession('sess-002', {
        completedAt: new Date('2026-02-10T10:05:00Z'),
        status: 'completed',
        overallConfidence: 0.85,
        totalExecutionTime: 300000,
      });

      const session = await repo.getSession('sess-002');
      expect(session!.status).toBe('completed');
      expect(session!.overall_confidence).toBeCloseTo(0.85);
      expect(session!.total_execution_time).toBe(300000);
    });

    it('should count sessions', async () => {
      await repo.insertSession({ sessionId: 's1', startedAt: new Date() });
      await repo.insertSession({ sessionId: 's2', startedAt: new Date() });
      await repo.insertSession({ sessionId: 's3', startedAt: new Date() });

      const count = await repo.countSessions();
      expect(count).toBe(3);
    });
  });

  describe('Trace CRUD', () => {
    it('should insert and retrieve traces by session', async () => {
      await repo.insertSession({ sessionId: 'sess-t1', startedAt: new Date() });

      await repo.insertTrace({
        id: 'trace-001',
        sessionId: 'sess-t1',
        stepNumber: 1,
        agentName: 'FieldMappingAgent',
        action: 'analyze',
        inputSummary: '{"fields": ["revenue"]}',
        outputSummary: '{"mapping": "revenue_field"}',
        confidence: 0.92,
        reasoning: 'Semantic similarity match',
        timestamp: new Date('2026-02-10T10:01:00Z'),
        executionTime: 150,
        userId: 'user-1',
      });

      await repo.insertTrace({
        id: 'trace-002',
        sessionId: 'sess-t1',
        stepNumber: 2,
        agentName: 'QualityAgent',
        action: 'validate',
        confidence: 0.88,
        reasoning: 'Pattern confirmed',
        timestamp: new Date('2026-02-10T10:01:05Z'),
        executionTime: 80,
      });

      const traces = await repo.getTracesBySession('sess-t1');
      expect(traces).toHaveLength(2);
      expect(traces[0].step_number).toBe(1);
      expect(traces[0].agent_name).toBe('FieldMappingAgent');
      expect(traces[0].confidence).toBeCloseTo(0.92);
      expect(traces[1].step_number).toBe(2);
    });

    it('should return empty array for session with no traces', async () => {
      await repo.insertSession({ sessionId: 'sess-empty', startedAt: new Date() });
      const traces = await repo.getTracesBySession('sess-empty');
      expect(traces).toHaveLength(0);
    });

    it('should count traces by session', async () => {
      await repo.insertSession({ sessionId: 'sess-count', startedAt: new Date() });
      await repo.insertTrace({
        id: 't1', sessionId: 'sess-count', stepNumber: 1,
        agentName: 'A', action: 'a', timestamp: new Date(), executionTime: 10,
      });
      await repo.insertTrace({
        id: 't2', sessionId: 'sess-count', stepNumber: 2,
        agentName: 'B', action: 'b', timestamp: new Date(), executionTime: 20,
      });

      const count = await repo.countBySession('sess-count');
      expect(count).toBe(2);
    });
  });

  describe('JSON metadata roundtrip', () => {
    it('should persist and parse session metadata correctly', async () => {
      const metadata = { sourceSystem: 'NetSuite', targetSystem: 'BC', custom: { nested: true } };
      await repo.insertSession({
        sessionId: 'sess-json',
        startedAt: new Date(),
        metadata,
      });

      const session = await repo.getSession('sess-json');
      expect(session!.metadata).toEqual(metadata);
    });

    it('should handle null metadata', async () => {
      await repo.insertSession({ sessionId: 'sess-null', startedAt: new Date() });
      const session = await repo.getSession('sess-null');
      expect(session!.metadata).toBeNull();
    });
  });

  describe('Query with filters', () => {
    beforeEach(async () => {
      await repo.insertSession({
        sessionId: 'q1', userId: 'alice', startedAt: new Date('2026-02-01T00:00:00Z'),
      });
      await repo.insertSession({
        sessionId: 'q2', userId: 'bob', startedAt: new Date('2026-02-05T00:00:00Z'),
      });
      await repo.insertSession({
        sessionId: 'q3', userId: 'alice', startedAt: new Date('2026-02-10T00:00:00Z'),
      });
    });

    it('should filter by userId', async () => {
      const results = await repo.queryTraces({ userId: 'alice' });
      expect(results).toHaveLength(2);
      expect(results.every(r => r.user_id === 'alice')).toBe(true);
    });

    it('should filter by date range', async () => {
      const results = await repo.queryTraces({
        startDate: new Date('2026-02-03T00:00:00Z'),
        endDate: new Date('2026-02-08T00:00:00Z'),
      });
      expect(results).toHaveLength(1);
      expect(results[0].session_id).toBe('q2');
    });

    it('should filter by sessionIds', async () => {
      const results = await repo.queryTraces({ sessionIds: ['q1', 'q3'] });
      expect(results).toHaveLength(2);
    });
  });

  describe('Pagination', () => {
    beforeEach(async () => {
      for (let i = 1; i <= 10; i++) {
        await repo.insertSession({
          sessionId: `page-${i}`,
          startedAt: new Date(`2026-02-${String(i).padStart(2, '0')}T00:00:00Z`),
        });
      }
    });

    it('should limit results', async () => {
      const results = await repo.queryTraces({}, { limit: 3 });
      expect(results).toHaveLength(3);
    });

    it('should offset results', async () => {
      const all = await repo.queryTraces({});
      const offset = await repo.queryTraces({}, { offset: 5, limit: 3 });
      expect(offset).toHaveLength(3);
      // Results are ordered by started_at DESC, so offset 5 skips the 5 most recent
      expect(offset[0].session_id).toBe(all[5].session_id);
    });
  });

  describe('Cleanup by age', () => {
    it('should delete sessions older than retention period', async () => {
      // Insert old session (40 days ago)
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      await repo.insertSession({ sessionId: 'old', startedAt: oldDate });

      // Insert recent session
      await repo.insertSession({ sessionId: 'recent', startedAt: new Date() });

      const deleted = await repo.deleteOlderThan(30);
      expect(deleted).toBeGreaterThanOrEqual(1);

      const remaining = await repo.countSessions();
      expect(remaining).toBe(1);

      const session = await repo.getSession('recent');
      expect(session).not.toBeNull();
    });

    it('should cascade delete traces when session is deleted', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 40);
      await repo.insertSession({ sessionId: 'old-cascade', startedAt: oldDate });
      await repo.insertTrace({
        id: 'del-t1', sessionId: 'old-cascade', stepNumber: 1,
        agentName: 'A', action: 'a', timestamp: oldDate, executionTime: 10,
      });

      await repo.deleteOlderThan(30);

      const traces = await repo.getTracesBySession('old-cascade');
      expect(traces).toHaveLength(0);
    });
  });
});
