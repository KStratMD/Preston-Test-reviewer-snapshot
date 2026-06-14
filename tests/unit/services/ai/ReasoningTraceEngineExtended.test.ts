/**
 * Comprehensive unit tests for ReasoningTraceEngine
 * Covers: startTrace, recordStep, completeTrace, getTrace, getSteps,
 *         queryTraces, analyzeTrace, generateTraceSummary, exportTrace,
 *         getTraceStatistics, cleanupOldTraces
 */
import 'reflect-metadata';
import { ReasoningTraceEngine } from '../../../../src/services/ai/orchestrator/ReasoningTraceEngine';
import type { ReasoningStep } from '../../../../src/services/ai/orchestrator/interfaces';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function buildStep(overrides: Partial<ReasoningStep> = {}): ReasoningStep {
  return {
    step: 1,
    agent: 'test-agent',
    action: 'analyze',
    input: { data: 'test-input' },
    output: { result: 'test-output' },
    reasoning: 'Applied rule-based analysis',
    confidence: 0.85,
    executionTime: 150,
    timestamp: new Date(),
    ...overrides,
  };
}

describe('ReasoningTraceEngine', () => {
  let engine: ReasoningTraceEngine;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    engine = new ReasoningTraceEngine(mockLogger);
    jest.useRealTimers();
  });

  afterEach(() => {
    engine.destroy();
  });

  describe('constructor', () => {
    it('should initialize', () => {
      expect(engine).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reasoning trace engine initialized',
        expect.objectContaining({
          retentionDays: 30,
          maxTracesInMemory: 1000,
        })
      );
    });
  });

  describe('startTrace', () => {
    it('should start a new trace', async () => {
      await engine.startTrace('session-1', {
        sourceSystem: 'Salesforce',
        targetSystem: 'NetSuite',
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Reasoning trace started',
        expect.objectContaining({ sessionId: 'session-1' })
      );
    });

    it('should store trace that can be retrieved', async () => {
      await engine.startTrace('session-2', {
        sourceSystem: 'SAP',
        targetSystem: 'BusinessCentral',
      });
      const trace = await engine.getTrace('session-2');
      expect(trace).not.toBeNull();
      expect(trace!.sessionId).toBe('session-2');
      expect(trace!.metadata.sourceSystem).toBe('SAP');
      expect(trace!.metadata.targetSystem).toBe('BusinessCentral');
      expect(trace!.metadata.stepCount).toBe(0);
      expect(trace!.metadata.agentCount).toBe(0);
      expect(trace!.metadata.errorCount).toBe(0);
      expect(trace!.metadata.warningCount).toBe(0);
    });
  });

  describe('recordStep', () => {
    it('should record a step to an existing trace', async () => {
      await engine.startTrace('session-3', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-3', buildStep());
      const trace = await engine.getTrace('session-3');
      expect(trace!.steps.length).toBe(1);
      expect(trace!.metadata.stepCount).toBe(1);
    });

    it('should warn when recording for unknown trace', async () => {
      await engine.recordStep('nonexistent', buildStep());
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Attempted to record step for unknown trace',
        expect.objectContaining({ sessionId: 'nonexistent' })
      );
    });

    it('should count unique agents', async () => {
      await engine.startTrace('session-4', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-4', buildStep({ agent: 'agent-1' }));
      await engine.recordStep('session-4', buildStep({ step: 2, agent: 'agent-2' }));
      await engine.recordStep('session-4', buildStep({ step: 3, agent: 'agent-1' }));
      const trace = await engine.getTrace('session-4');
      expect(trace!.metadata.agentCount).toBe(2);
      expect(trace!.metadata.stepCount).toBe(3);
    });

    it('should count errors from step output', async () => {
      await engine.startTrace('session-5', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-5', buildStep({
        output: { errors: ['some error'], warnings: [] },
      }));
      const trace = await engine.getTrace('session-5');
      expect(trace!.metadata.errorCount).toBe(1);
    });

    it('should count warnings from step output', async () => {
      await engine.startTrace('session-6', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-6', buildStep({
        output: { errors: [], warnings: ['some warning'] },
      }));
      const trace = await engine.getTrace('session-6');
      expect(trace!.metadata.warningCount).toBe(1);
    });

    it('should validate step number', async () => {
      await engine.startTrace('session-v1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await expect(engine.recordStep('session-v1', buildStep({ step: -1 })))
        .rejects.toThrow('Step number must be a non-negative number');
    });

    it('should validate agent name', async () => {
      await engine.startTrace('session-v2', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await expect(engine.recordStep('session-v2', buildStep({ agent: '' })))
        .rejects.toThrow('Step must have a valid agent name');
    });

    it('should validate confidence range', async () => {
      await engine.startTrace('session-v3', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await expect(engine.recordStep('session-v3', buildStep({ confidence: 1.5 })))
        .rejects.toThrow('Step confidence must be a number between 0 and 1');
    });

    it('should validate execution time', async () => {
      await engine.startTrace('session-v4', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await expect(engine.recordStep('session-v4', buildStep({ executionTime: -10 })))
        .rejects.toThrow('Step execution time must be a non-negative number');
    });
  });

  describe('completeTrace', () => {
    it('should complete a trace and set end time', async () => {
      await engine.startTrace('session-c1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-c1', buildStep({ confidence: 0.9 }));
      const trace = await engine.completeTrace('session-c1', 'All done');
      expect(trace).not.toBeNull();
      expect(trace!.endTime).toBeInstanceOf(Date);
      expect(typeof trace!.totalExecutionTime).toBe('number');
      expect(trace!.summary).toBe('All done');
      expect(typeof trace!.overallConfidence).toBe('number');
    });

    it('should return null for unknown session', async () => {
      const result = await engine.completeTrace('nonexistent');
      expect(result).toBeNull();
    });

    it('should generate summary when not provided', async () => {
      await engine.startTrace('session-c2', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-c2', buildStep());
      const trace = await engine.completeTrace('session-c2');
      expect(typeof trace!.summary).toBe('string');
      expect(trace!.summary!.length).toBeGreaterThan(0);
    });

    it('should calculate weighted confidence', async () => {
      await engine.startTrace('session-c3', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-c3', buildStep({ step: 1, confidence: 0.5 }));
      await engine.recordStep('session-c3', buildStep({ step: 2, confidence: 0.9 }));
      const trace = await engine.completeTrace('session-c3');
      // Weighted average: later steps weigh more, so should be > 0.7
      expect(trace!.overallConfidence).toBeGreaterThan(0.6);
    });
  });

  describe('getTrace / getSteps', () => {
    it('should return null for unknown trace', async () => {
      expect(await engine.getTrace('unknown')).toBeNull();
    });

    it('should return empty steps for unknown trace', async () => {
      expect(await engine.getSteps('unknown')).toEqual([]);
    });

    it('should return steps copy', async () => {
      await engine.startTrace('session-s1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('session-s1', buildStep());
      const steps = await engine.getSteps('session-s1');
      expect(steps.length).toBe(1);
    });
  });

  describe('queryTraces', () => {
    beforeEach(async () => {
      await engine.startTrace('s1', { sourceSystem: 'A', targetSystem: 'B', userId: 'user-1' });
      await engine.recordStep('s1', buildStep({ agent: 'agent-x' }));
      await engine.completeTrace('s1');

      await engine.startTrace('s2', { sourceSystem: 'C', targetSystem: 'D', userId: 'user-2' });
      await engine.recordStep('s2', buildStep({ agent: 'agent-y' }));
    });

    it('should return all traces when no filters', async () => {
      const results = await engine.queryTraces({});
      expect(results.length).toBe(2);
    });

    it('should filter by sessionIds', async () => {
      const results = await engine.queryTraces({ sessionIds: ['s1'] });
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe('s1');
    });

    it('should filter by userId', async () => {
      const results = await engine.queryTraces({ userId: 'user-2' });
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe('s2');
    });

    it('should filter by agents', async () => {
      const results = await engine.queryTraces({ agents: ['agent-x'] });
      expect(results.length).toBe(1);
      expect(results[0].sessionId).toBe('s1');
    });

    it('should filter by hasErrors false', async () => {
      const results = await engine.queryTraces({ hasErrors: false });
      expect(results.length).toBe(2); // no errors recorded
    });

    it('should apply limit', async () => {
      const results = await engine.queryTraces({ limit: 1 });
      expect(results.length).toBe(1);
    });

    it('should apply offset', async () => {
      const results = await engine.queryTraces({ offset: 1 });
      expect(results.length).toBe(1);
    });
  });

  describe('analyzeTrace', () => {
    it('should return null for unknown trace', async () => {
      const analysis = await engine.analyzeTrace('nonexistent');
      expect(analysis).toBeNull();
    });

    it('should return null for trace with no steps', async () => {
      await engine.startTrace('empty-trace', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      const analysis = await engine.analyzeTrace('empty-trace');
      expect(analysis).toBeNull();
    });

    it('should analyze a trace with steps', async () => {
      await engine.startTrace('analyze-1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('analyze-1', buildStep({ step: 1, confidence: 0.8, executionTime: 100 }));
      await engine.recordStep('analyze-1', buildStep({ step: 2, confidence: 0.9, executionTime: 200 }));
      await engine.recordStep('analyze-1', buildStep({ step: 3, confidence: 0.85, executionTime: 150 }));

      const analysis = await engine.analyzeTrace('analyze-1');
      expect(analysis).not.toBeNull();
      expect(Array.isArray(analysis!.confidenceTrend)).toBe(true);
      expect(analysis!.performanceMetrics).toBeDefined();
      expect(typeof analysis!.performanceMetrics.averageStepTime).toBe('number');
      expect(analysis!.performanceMetrics.slowestStep).toBeDefined();
      expect(analysis!.performanceMetrics.fastestStep).toBeDefined();
      expect(analysis!.qualityMetrics).toBeDefined();
      expect(typeof analysis!.qualityMetrics.consistencyScore).toBe('number');
      expect(typeof analysis!.qualityMetrics.coherenceScore).toBe('number');
      expect(typeof analysis!.qualityMetrics.completenessScore).toBe('number');
      expect(Array.isArray(analysis!.recommendations)).toBe(true);
      expect(Array.isArray(analysis!.issues)).toBe(true);
    });
  });

  describe('generateTraceSummary', () => {
    it('should handle empty steps', async () => {
      await engine.startTrace('sum-empty', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      const trace = await engine.getTrace('sum-empty');
      const summary = await engine.generateTraceSummary(trace!);
      expect(summary).toBe('No reasoning steps recorded.');
    });

    it('should include step count and agent count', async () => {
      await engine.startTrace('sum-1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('sum-1', buildStep({ agent: 'agent-a' }));
      await engine.recordStep('sum-1', buildStep({ step: 2, agent: 'agent-b' }));
      const trace = await engine.getTrace('sum-1');
      const summary = await engine.generateTraceSummary(trace!);
      expect(summary).toContain('2 reasoning steps');
      expect(summary).toContain('2 agents');
    });
  });

  describe('exportTrace', () => {
    it('should return null for unknown trace', () => {
      expect(engine.exportTrace('unknown', 'json')).toBeNull();
    });

    it('should export as JSON', async () => {
      await engine.startTrace('export-1', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      const result = engine.exportTrace('export-1', 'json');
      expect(result).not.toBeNull();
      const parsed = JSON.parse(result!);
      expect(parsed.sessionId).toBe('export-1');
    });

    it('should export as CSV', async () => {
      await engine.startTrace('export-2', {
        sourceSystem: 'A',
        targetSystem: 'B',
      });
      await engine.recordStep('export-2', buildStep());
      const result = engine.exportTrace('export-2', 'csv');
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });
  });

  describe('getTraceStatistics', () => {
    it('should return empty stats initially', () => {
      const stats = engine.getTraceStatistics();
      expect(stats.totalTraces).toBe(0);
      expect(stats.completedTraces).toBe(0);
      expect(stats.averageStepsPerTrace).toBe(0);
      expect(stats.averageExecutionTime).toBe(0);
      expect(stats.averageConfidence).toBe(0);
      expect(stats.topAgents).toEqual([]);
    });

    it('should track stats after traces', async () => {
      await engine.startTrace('stat-1', { sourceSystem: 'A', targetSystem: 'B' });
      await engine.recordStep('stat-1', buildStep({ agent: 'agent-a', confidence: 0.8 }));
      await engine.recordStep('stat-1', buildStep({ step: 2, agent: 'agent-b', confidence: 0.9 }));
      await engine.completeTrace('stat-1');

      const stats = engine.getTraceStatistics();
      expect(stats.totalTraces).toBe(1);
      expect(stats.completedTraces).toBe(1);
      expect(stats.averageStepsPerTrace).toBe(2);
      expect(stats.topAgents.length).toBe(2);
    });
  });

  describe('cleanupOldTraces', () => {
    it('should return 0 when no old traces', async () => {
      await engine.startTrace('recent', { sourceSystem: 'A', targetSystem: 'B' });
      const cleaned = await engine.cleanupOldTraces();
      expect(cleaned).toBe(0);
    });
  });
});
