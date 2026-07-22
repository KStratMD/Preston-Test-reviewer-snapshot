import 'reflect-metadata';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect, sql } from 'kysely';
import { ReasoningTraceEngine } from '../../../../src/services/ai/orchestrator/ReasoningTraceEngine';
import { ReasoningTraceRepository } from '../../../../src/database/repositories/ReasoningTraceRepository';
import type { Database } from '../../../../src/database/types';

/**
 * Full-stack integration test: ReasoningTraceEngine → ReasoningTraceRepository → SQLite
 * Validates that traces survive engine reset (simulates server restart).
 */
describe('Reasoning Traces Persistence Integration', () => {
  let db: Kysely<Database>;
  let sqlite: BetterSqlite3.Database;
  let repo: ReasoningTraceRepository;

  // Track engine instances for cleanup
  const engines: ReasoningTraceEngine[] = [];

  // Suppress logger output in tests
  const mockLogger: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };

  function createEngine(): ReasoningTraceEngine {
    const engine = new ReasoningTraceEngine(mockLogger, repo);
    engines.push(engine);
    return engine;
  }

  beforeAll(async () => {
    sqlite = new BetterSqlite3(':memory:');
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('foreign_keys = ON');

    db = new Kysely<Database>({
      dialect: new SqliteDialect({ database: sqlite }),
    });

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

    const fakeDatabaseService = { getDatabase: () => db } as any;
    repo = new ReasoningTraceRepository(fakeDatabaseService);
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM reasoning_traces`.execute(db);
    await sql`DELETE FROM ai_sessions`.execute(db);
  });

  afterEach(() => {
    engines.forEach(e => e.destroy());
    engines.length = 0;
  });

  it('should persist traces through full lifecycle: startTrace → recordStep → completeTrace', async () => {
    const engine = createEngine();

    // Start trace
    await engine.startTrace('int-sess-001', {
      sourceSystem: 'NetSuite',
      targetSystem: 'BusinessCentral',
      userId: 'user-42',
      businessProcess: 'field-mapping',
    });

    // Record steps
    await engine.recordStep('int-sess-001', {
      step: 1,
      agent: 'FieldMappingAgent',
      action: 'analyze',
      input: { fields: ['revenue'] },
      output: { mapping: 'revenue_field' },
      confidence: 0.92,
      reasoning: 'Semantic similarity match on revenue',
      timestamp: new Date(),
      executionTime: 150,
    });

    await engine.recordStep('int-sess-001', {
      step: 2,
      agent: 'QualityAgent',
      action: 'validate',
      input: { mapping: 'revenue_field' },
      output: { validated: true },
      confidence: 0.88,
      reasoning: 'Pattern confirmed against historical data',
      timestamp: new Date(),
      executionTime: 80,
    });

    // Complete trace
    const completed = await engine.completeTrace('int-sess-001', 'Field mapping completed successfully');
    expect(completed).not.toBeNull();
    expect(completed!.overallConfidence).toBeGreaterThan(0);

    // Verify DB has the data
    const session = await repo.getSession('int-sess-001');
    expect(session).not.toBeNull();
    expect(session!.status).toBe('completed');

    const traces = await repo.getTracesBySession('int-sess-001');
    expect(traces).toHaveLength(2);
    expect(traces[0].agent_name).toBe('FieldMappingAgent');
    expect(traces[1].agent_name).toBe('QualityAgent');
  });

  it('should survive engine reset (simulates server restart)', async () => {
    // Phase 1: Create traces with first engine instance
    const engine1 = createEngine();

    await engine1.startTrace('restart-sess', {
      sourceSystem: 'HubSpot',
      targetSystem: 'NetSuite',
      userId: 'user-99',
      businessProcess: 'sync',
    });

    await engine1.recordStep('restart-sess', {
      step: 1,
      agent: 'SyncAgent',
      action: 'sync',
      input: { records: 100 },
      output: { synced: 95 },
      confidence: 0.95,
      reasoning: 'Delta sync completed',
      timestamp: new Date(),
      executionTime: 5000,
    });

    await engine1.completeTrace('restart-sess');

    // Phase 2: Create a NEW engine instance (simulates restart — fresh in-memory cache)
    const engine2 = createEngine();

    // The new engine should lazy-load from DB
    const trace = await engine2.getTrace('restart-sess');
    expect(trace).not.toBeNull();
    expect(trace!.sessionId).toBe('restart-sess');
    expect(trace!.steps).toHaveLength(1);
    expect(trace!.steps[0].agent).toBe('SyncAgent');
    expect(trace!.steps[0].confidence).toBeCloseTo(0.95);

    // getSteps should also work via lazy-load
    const steps = await engine2.getSteps('restart-sess');
    expect(steps).toHaveLength(1);
    expect(steps[0].action).toBe('sync');
  });

  it('should query traces from DB across engine resets', async () => {
    // Insert directly via repo (simulating historical data)
    await repo.insertSession({
      sessionId: 'hist-001',
      userId: 'alice',
      startedAt: new Date('2026-02-01T00:00:00Z'),
      metadata: { sourceSystem: 'SAP', targetSystem: 'NetSuite' },
    });
    await repo.updateSession('hist-001', { status: 'completed', overallConfidence: 0.9 });

    await repo.insertSession({
      sessionId: 'hist-002',
      userId: 'bob',
      startedAt: new Date('2026-02-05T00:00:00Z'),
      metadata: { sourceSystem: 'Shopify', targetSystem: 'BC' },
    });
    await repo.updateSession('hist-002', { status: 'completed', overallConfidence: 0.7 });

    // queryTraces returns from in-memory (which is empty) but the repo has the data
    // The engine's queryTraces still filters in-memory; for full DB query, use repo directly
    const repoResults = await repo.queryTraces({ userId: 'alice' });
    expect(repoResults).toHaveLength(1);
    expect(repoResults[0].session_id).toBe('hist-001');
  });

  it('should handle recordStep when trace not started (graceful degradation)', async () => {
    const engine = createEngine();

    // recordStep without startTrace should log warning and return
    await engine.recordStep('nonexistent', {
      step: 1,
      agent: 'TestAgent',
      action: 'test',
      input: {},
      output: {},
      confidence: 0.5,
      reasoning: 'test',
      timestamp: new Date(),
      executionTime: 10,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Attempted to record step for unknown trace',
      expect.objectContaining({ sessionId: 'nonexistent' })
    );
  });

  it('should persist multi-step workflows with different step numbers and survive restart', async () => {
    const engine1 = createEngine();

    await engine1.startTrace('multi-step-sess', {
      sourceSystem: 'SAP',
      targetSystem: 'BC',
      userId: 'user-1',
      businessProcess: 'workflow',
    });

    // Record step 1
    await engine1.recordStep('multi-step-sess', {
      step: 1,
      agent: 'AgentA',
      action: 'analyze',
      input: { data: 'a' },
      output: { result: 'a' },
      confidence: 0.8,
      reasoning: 'Step A',
      timestamp: new Date(),
      executionTime: 100,
    });

    // Record step 2
    await engine1.recordStep('multi-step-sess', {
      step: 2,
      agent: 'AgentB',
      action: 'validate',
      input: { data: 'b' },
      output: { result: 'b' },
      confidence: 0.9,
      reasoning: 'Step B',
      timestamp: new Date(),
      executionTime: 200,
    });

    // Record step 3
    await engine1.recordStep('multi-step-sess', {
      step: 3,
      agent: 'AgentC',
      action: 'finalize',
      input: { data: 'c' },
      output: { result: 'c' },
      confidence: 0.95,
      reasoning: 'Step C final',
      timestamp: new Date(),
      executionTime: 50,
    });

    // Verify DB has 3 steps
    const dbTraces = await repo.getTracesBySession('multi-step-sess');
    expect(dbTraces).toHaveLength(3);
    expect(dbTraces.map(t => t.step_number)).toEqual([1, 2, 3]);

    // Simulate restart — new engine should lazy-load all 3 steps
    const engine2 = createEngine();
    const steps = await engine2.getSteps('multi-step-sess');
    expect(steps).toHaveLength(3);
    expect(steps[0].agent).toBe('AgentA');
    expect(steps[1].agent).toBe('AgentB');
    expect(steps[2].agent).toBe('AgentC');
  });

  it('should handle invalid JSON in input_summary without crashing (safeJsonParse)', async () => {
    const engine = createEngine();

    // Insert session + trace with corrupt JSON directly in DB
    await repo.insertSession({
      sessionId: 'corrupt-json-sess',
      userId: 'user-1',
      startedAt: new Date(),
      metadata: { sourceSystem: 'test', targetSystem: 'test' },
    });

    // Insert a trace row with truncated/invalid JSON in input_summary
    await sql`
      INSERT INTO reasoning_traces (id, session_id, step_number, agent_name, action,
        input_summary, output_summary, confidence, reasoning, timestamp, execution_time,
        created_at)
      VALUES ('corrupt-1', 'corrupt-json-sess', 1, 'TestAgent', 'test',
        '{"truncated": "this is brok', '{"also": "brok',
        0.7, 'test reasoning', ${new Date().toISOString()}, 100,
        ${new Date().toISOString()})
    `.execute(db);

    // getTrace should not throw — invalid JSON returns undefined
    const trace = await engine.getTrace('corrupt-json-sess');
    expect(trace).not.toBeNull();
    expect(trace!.steps).toHaveLength(1);
    expect(trace!.steps[0].input).toBeUndefined();
    expect(trace!.steps[0].output).toBeUndefined();
    expect(trace!.steps[0].agent).toBe('TestAgent');

    // getSteps should also handle it gracefully
    const engine2 = createEngine();
    const steps = await engine2.getSteps('corrupt-json-sess');
    expect(steps).toHaveLength(1);
    expect(steps[0].input).toBeUndefined();
    expect(steps[0].output).toBeUndefined();
  });

  it('should persist failed status via completeTrace(id, summary, "failed")', async () => {
    const engine = createEngine();

    await engine.startTrace('fail-sess', {
      sourceSystem: 'NS',
      targetSystem: 'BC',
      userId: 'user-1',
      businessProcess: 'sync',
    });

    await engine.recordStep('fail-sess', {
      step: 1,
      agent: 'SyncAgent',
      action: 'sync',
      input: { records: 50 },
      output: { error: 'timeout' },
      confidence: 0.1,
      reasoning: 'Connection timeout',
      timestamp: new Date(),
      executionTime: 30000,
    });

    // Complete with failed status
    const result = await engine.completeTrace('fail-sess', 'Workflow failed: timeout', 'failed');
    expect(result).not.toBeNull();

    // Verify DB has 'failed' status
    const session = await repo.getSession('fail-sess');
    expect(session).not.toBeNull();
    expect(session!.status).toBe('failed');
  });
});
