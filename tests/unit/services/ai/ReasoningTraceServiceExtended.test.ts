/**
 * Comprehensive unit tests for ReasoningTraceService
 * Covers: initialize, startSession, completeSession, storeReasoningStep,
 *         getReasoningTrace, getSession, queryTraces, cleanupOldTraces,
 *         exportTrace, ensureInitialized, summarize
 */
import 'reflect-metadata';
import { ReasoningTraceService } from '../../../../src/services/ai/ReasoningTraceService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockDb = {} as any;

function makeStep(overrides: Record<string, any> = {}) {
  return {
    step: 1,
    agent: 'QualityAgent',
    action: 'analyze_fields',
    input: { fields: ['Name', 'Email'] },
    output: { score: 0.95 },
    confidence: 0.92,
    reasoning: 'Field names match directly',
    timestamp: new Date(),
    executionTime: 150,
    ...overrides,
  };
}

describe('ReasoningTraceService', () => {
  let service: ReasoningTraceService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ReasoningTraceService(mockLogger, mockDb);
  });

  describe('constructor', () => {
    it('should log creation message', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reasoning Trace Service created (stub implementation)',
        expect.objectContaining({ retentionDays: 30 })
      );
    });
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reasoning Trace Service initialized (stub - using in-memory storage)'
      );
    });

    it('should be idempotent', async () => {
      await service.initialize();
      await service.initialize();
      const initCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Reasoning Trace Service initialized (stub - using in-memory storage)'
      );
      expect(initCalls.length).toBe(1);
    });
  });

  describe('startSession', () => {
    it('should create a new session', async () => {
      await service.startSession('sess-1', 'user-1', 'mapping');
      const session = await service.getSession('sess-1');
      expect(session).toBeDefined();
      expect(session!.sessionId).toBe('sess-1');
      expect(session!.userId).toBe('user-1');
      expect(session!.workflowType).toBe('mapping');
      expect(session!.status).toBe('running');
      expect(session!.startedAt).toBeInstanceOf(Date);
    });

    it('should log session start', async () => {
      await service.startSession('sess-log', 'user-1', 'quality');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI session started',
        expect.objectContaining({
          sessionId: 'sess-log',
          userId: 'user-1',
          workflowType: 'quality',
        })
      );
    });

    it('should store metadata', async () => {
      await service.startSession('sess-meta', 'user-1', 'mapping', { source: 'api' });
      const session = await service.getSession('sess-meta');
      expect(session!.metadata).toEqual({ source: 'api' });
    });

    it('should auto-initialize if not initialized', async () => {
      // Service not explicitly initialized, startSession should call ensureInitialized
      await service.startSession('sess-auto', 'user-1');
      const session = await service.getSession('sess-auto');
      expect(session).toBeDefined();
    });
  });

  describe('completeSession', () => {
    it('should mark session as completed', async () => {
      await service.startSession('sess-1');
      await service.completeSession('sess-1', 'completed', 0.95, 500);
      const session = await service.getSession('sess-1');
      expect(session!.status).toBe('completed');
      expect(session!.completedAt).toBeInstanceOf(Date);
      expect(session!.overallConfidence).toBe(0.95);
      expect(session!.totalExecutionTime).toBe(500);
    });

    it('should mark session as failed', async () => {
      await service.startSession('sess-fail');
      await service.completeSession('sess-fail', 'failed');
      const session = await service.getSession('sess-fail');
      expect(session!.status).toBe('failed');
    });

    it('should log completion', async () => {
      await service.startSession('sess-log2');
      await service.completeSession('sess-log2', 'completed');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI session completed',
        expect.objectContaining({ sessionId: 'sess-log2', status: 'completed' })
      );
    });

    it('should do nothing for nonexistent session', async () => {
      // Should not throw
      await service.completeSession('nonexistent', 'completed');
      const session = await service.getSession('nonexistent');
      expect(session).toBeNull();
    });
  });

  describe('storeReasoningStep', () => {
    it('should store a step', async () => {
      await service.startSession('sess-1');
      await service.storeReasoningStep('sess-1', makeStep(), 'user-1');
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces.length).toBe(1);
      expect(traces[0].agentName).toBe('QualityAgent');
      expect(traces[0].action).toBe('analyze_fields');
      expect(traces[0].confidence).toBe(0.92);
      expect(traces[0].userId).toBe('user-1');
    });

    it('should generate deterministic IDs', async () => {
      await service.storeReasoningStep('sess-1', makeStep({ step: 3 }));
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces[0].id).toBe('sess-1-step-3');
    });

    it('should store multiple steps in order', async () => {
      await service.storeReasoningStep('sess-1', makeStep({ step: 1 }));
      await service.storeReasoningStep('sess-1', makeStep({ step: 3 }));
      await service.storeReasoningStep('sess-1', makeStep({ step: 2 }));
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces.length).toBe(3);
      // getReasoningTrace sorts by stepNumber
      expect(traces[0].stepNumber).toBe(1);
      expect(traces[1].stepNumber).toBe(2);
      expect(traces[2].stepNumber).toBe(3);
    });

    it('should summarize long input/output', async () => {
      const longString = 'x'.repeat(600);
      await service.storeReasoningStep('sess-1', makeStep({
        input: longString,
        output: longString,
      }));
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces[0].inputSummary!.length).toBeLessThanOrEqual(515); // 500 + '...[truncated]'
      expect(traces[0].inputSummary).toContain('[truncated]');
    });

    it('should handle non-serializable data', async () => {
      const circular: any = {};
      circular.self = circular;
      await service.storeReasoningStep('sess-1', makeStep({ input: circular }));
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces[0].inputSummary).toBe('[Unable to serialize]');
    });

    it('should log step storage', async () => {
      await service.storeReasoningStep('sess-1', makeStep({ step: 5, agent: 'TestAgent' }));
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Reasoning step stored',
        expect.objectContaining({ sessionId: 'sess-1', step: 5, agent: 'TestAgent' })
      );
    });
  });

  describe('getReasoningTrace', () => {
    it('should return empty array for unknown session', async () => {
      const traces = await service.getReasoningTrace('unknown');
      expect(traces).toEqual([]);
    });

    it('should log retrieval', async () => {
      await service.storeReasoningStep('sess-1', makeStep());
      await service.getReasoningTrace('sess-1');
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reasoning trace retrieved',
        expect.objectContaining({ sessionId: 'sess-1', steps: 1 })
      );
    });

    it('should return traces sorted by step number', async () => {
      await service.storeReasoningStep('sess-1', makeStep({ step: 3 }));
      await service.storeReasoningStep('sess-1', makeStep({ step: 1 }));
      await service.storeReasoningStep('sess-1', makeStep({ step: 2 }));
      const traces = await service.getReasoningTrace('sess-1');
      expect(traces.map(t => t.stepNumber)).toEqual([1, 2, 3]);
    });
  });

  describe('getSession', () => {
    it('should return null for unknown session', async () => {
      const session = await service.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should return session details', async () => {
      await service.startSession('sess-details', 'user-1', 'mapping', { key: 'val' });
      const session = await service.getSession('sess-details');
      expect(session!.sessionId).toBe('sess-details');
      expect(session!.userId).toBe('user-1');
      expect(session!.workflowType).toBe('mapping');
      expect(session!.status).toBe('running');
    });
  });

  describe('queryTraces', () => {
    beforeEach(async () => {
      const now = new Date();
      const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      await service.storeReasoningStep('sess-1', makeStep({
        step: 1, agent: 'QualityAgent', timestamp: now,
      }), 'user-1');
      await service.storeReasoningStep('sess-1', makeStep({
        step: 2, agent: 'MappingAgent', timestamp: now,
      }), 'user-1');
      await service.storeReasoningStep('sess-2', makeStep({
        step: 1, agent: 'QualityAgent', timestamp: hourAgo,
      }), 'user-2');
      await service.storeReasoningStep('sess-3', makeStep({
        step: 1, agent: 'OptimizationAgent', timestamp: dayAgo,
      }), 'user-1');
    });

    it('should return all traces without filters', async () => {
      const results = await service.queryTraces({});
      expect(results.length).toBe(4);
    });

    it('should filter by sessionId', async () => {
      const results = await service.queryTraces({ sessionId: 'sess-1' });
      expect(results.length).toBe(2);
      expect(results.every(r => r.sessionId === 'sess-1')).toBe(true);
    });

    it('should filter by userId', async () => {
      const results = await service.queryTraces({ userId: 'user-1' });
      expect(results.length).toBe(3);
    });

    it('should filter by agentName', async () => {
      const results = await service.queryTraces({ agentName: 'QualityAgent' });
      expect(results.length).toBe(2);
    });

    it('should filter by date range', async () => {
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
      const results = await service.queryTraces({ startDate: twoHoursAgo });
      expect(results.length).toBe(3); // excludes dayAgo
    });

    it('should apply limit', async () => {
      const results = await service.queryTraces({ limit: 2 });
      expect(results.length).toBe(2);
    });

    it('should apply offset', async () => {
      const all = await service.queryTraces({});
      const offset = await service.queryTraces({ offset: 2 });
      expect(offset.length).toBe(all.length - 2);
    });

    it('should sort by timestamp descending', async () => {
      const results = await service.queryTraces({});
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].timestamp.getTime()).toBeGreaterThanOrEqual(
          results[i].timestamp.getTime()
        );
      }
    });
  });

  describe('cleanupOldTraces', () => {
    it('should delete old traces', async () => {
      const oldDate = new Date();
      oldDate.setDate(oldDate.getDate() - 45); // 45 days ago

      await service.storeReasoningStep('sess-old', makeStep({ timestamp: oldDate }));
      await service.storeReasoningStep('sess-new', makeStep({ timestamp: new Date() }));

      const deleted = await service.cleanupOldTraces(30);
      expect(deleted).toBe(1);

      const oldTraces = await service.getReasoningTrace('sess-old');
      expect(oldTraces.length).toBe(0);
      const newTraces = await service.getReasoningTrace('sess-new');
      expect(newTraces.length).toBe(1);
    });

    it('should use default retention of 30 days', async () => {
      const deleted = await service.cleanupOldTraces();
      expect(deleted).toBe(0);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleanup completed',
        expect.objectContaining({ retentionDays: 30 })
      );
    });

    it('should log cleanup results', async () => {
      await service.cleanupOldTraces(7);
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cleanup completed',
        expect.objectContaining({
          retentionDays: 7,
          deletedTraces: 0,
          cutoffDate: expect.any(String),
        })
      );
    });
  });

  describe('exportTrace', () => {
    it('should export session and traces', async () => {
      await service.startSession('sess-export', 'user-1', 'mapping');
      await service.storeReasoningStep('sess-export', makeStep({ step: 1 }));
      await service.storeReasoningStep('sess-export', makeStep({ step: 2 }));

      const exported = await service.exportTrace('sess-export');
      expect(exported.session).toBeDefined();
      expect(exported.session!.sessionId).toBe('sess-export');
      expect(exported.reasoningSteps.length).toBe(2);
      expect(exported.exportedAt).toBeInstanceOf(Date);
    });

    it('should return null session for unknown', async () => {
      const exported = await service.exportTrace('unknown');
      expect(exported.session).toBeNull();
      expect(exported.reasoningSteps).toEqual([]);
    });
  });
});
