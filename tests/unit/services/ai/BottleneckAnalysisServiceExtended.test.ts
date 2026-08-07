/**
 * Comprehensive tests for BottleneckAnalysisService
 * Covers: identifyBottlenecks (AI-first with heuristic fallback),
 *         duration/resource/failure bottlenecks, capacity/queue/resource analysis
 */

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../../src/utils/Logger', () => ({
  logger: mockLogger,
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { BottleneckAnalysisService } from '../../../../src/services/ai/orchestrator/agents/optimization/BottleneckAnalysisService';

describe('BottleneckAnalysisService', () => {
  let service: BottleneckAnalysisService;
  let mockProviderRegistry: any;

  const makeWorkflowStep = (overrides: Record<string, any> = {}) => ({
    id: 'step-1',
    name: 'Step 1',
    type: 'process',
    duration: 30,
    resources: ['analyst'],
    dependencies: [],
    failureRate: 0.02,
    ...overrides,
  });

  const makeWorkflowAnalysis = (overrides: Record<string, any> = {}) => ({
    totalSteps: 3,
    criticalPath: ['step-1', 'step-2', 'step-3'],
    parallelizable: [],
    sequential: ['step-1', 'step-2', 'step-3'],
    cyclicPaths: [],
    totalDuration: 90,
    totalCost: 5000,
    complexity: 'medium' as const,
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockProviderRegistry = {
      getAvailableProvider: jest.fn().mockResolvedValue(null),
      getAvailableProviders: jest.fn().mockResolvedValue([]),
    };
    service = new (BottleneckAnalysisService as any)(mockLogger, mockProviderRegistry);
  });

  /* ────────────── identifyBottlenecks (heuristic fallback) ────────────── */

  describe('identifyBottlenecks (heuristic fallback)', () => {
    it('should return bottleneck analysis structure', async () => {
      const workflow = [makeWorkflowStep()];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.criticalBottlenecks).toBeDefined();
      expect(result.capacity).toBeDefined();
      expect(result.queueAnalysis).toBeDefined();
      expect(result.resourceConstraints).toBeDefined();
    });

    it('should identify duration bottlenecks', async () => {
      const workflow = [
        makeWorkflowStep({ id: 'fast1', duration: 10 }),
        makeWorkflowStep({ id: 'fast2', duration: 10 }),
        makeWorkflowStep({ id: 'slow', duration: 100 }), // avg=40, threshold=80, 100 > 80
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const durationBottlenecks = result.criticalBottlenecks.filter(b => b.description.includes('minutes'));
      expect(durationBottlenecks.length).toBeGreaterThan(0);
      expect(durationBottlenecks[0].step).toBe('slow');
      expect(durationBottlenecks[0].impact).toBe('high');
    });

    it('should not flag steps near average duration', async () => {
      const workflow = [
        makeWorkflowStep({ id: 's1', duration: 30 }),
        makeWorkflowStep({ id: 's2', duration: 35 }),
        makeWorkflowStep({ id: 's3', duration: 25 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const durationBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'Long processing time');
      expect(durationBottlenecks).toEqual([]);
    });

    it('should identify resource bottlenecks (>60% usage)', async () => {
      // 'analyst' used in 4 of 5 steps = 80% > 60% threshold
      const workflow = [
        makeWorkflowStep({ id: 's1', resources: ['analyst'] }),
        makeWorkflowStep({ id: 's2', resources: ['analyst'] }),
        makeWorkflowStep({ id: 's3', resources: ['analyst'] }),
        makeWorkflowStep({ id: 's4', resources: ['analyst'] }),
        makeWorkflowStep({ id: 's5', resources: ['server'] }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const resourceBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'Resource overutilization');
      expect(resourceBottlenecks.length).toBeGreaterThan(0);
      expect(resourceBottlenecks[0].step).toBe('analyst');
      expect(resourceBottlenecks[0].impact).toBe('medium');
    });

    it('should not flag resources used in few steps', async () => {
      const workflow = [
        makeWorkflowStep({ id: 's1', resources: ['analyst'] }),
        makeWorkflowStep({ id: 's2', resources: ['server'] }),
        makeWorkflowStep({ id: 's3', resources: ['database'] }),
        makeWorkflowStep({ id: 's4', resources: ['network'] }),
        makeWorkflowStep({ id: 's5', resources: ['api'] }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const resourceBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'Resource overutilization');
      expect(resourceBottlenecks).toEqual([]);
    });

    it('should identify failure rate bottlenecks (>10%)', async () => {
      const workflow = [
        makeWorkflowStep({ id: 'reliable', failureRate: 0.05 }),
        makeWorkflowStep({ id: 'flaky', failureRate: 0.25 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const failureBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'High failure rate causing rework');
      expect(failureBottlenecks.length).toBe(1);
      expect(failureBottlenecks[0].step).toBe('flaky');
      expect(failureBottlenecks[0].impact).toBe('high');
      expect(failureBottlenecks[0].description).toContain('25.0%');
    });

    it('should not flag steps with low failure rate', async () => {
      const workflow = [
        makeWorkflowStep({ id: 's1', failureRate: 0.05 }),
        makeWorkflowStep({ id: 's2', failureRate: 0.08 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const failureBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'High failure rate causing rework');
      expect(failureBottlenecks).toEqual([]);
    });

    it('should handle steps with no failureRate', async () => {
      const workflow = [
        makeWorkflowStep({ id: 's1', failureRate: undefined }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const failureBottlenecks = result.criticalBottlenecks.filter(b => b.rootCause === 'High failure rate causing rework');
      expect(failureBottlenecks).toEqual([]);
    });

    it('should combine all types of bottlenecks', async () => {
      const workflow = [
        makeWorkflowStep({ id: 'fast', duration: 5, resources: ['analyst'], failureRate: 0.01 }),
        makeWorkflowStep({ id: 'slow-flaky', duration: 100, resources: ['analyst'], failureRate: 0.3 }),
        makeWorkflowStep({ id: 'normal', duration: 10, resources: ['analyst'], failureRate: 0.02 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Duration bottleneck + failure bottleneck + resource bottleneck (analyst in 3/3 steps)
      expect(result.criticalBottlenecks.length).toBeGreaterThanOrEqual(2);
    });
  });

  /* ────────────── identifyBottlenecks (AI path) ────────────── */

  describe('identifyBottlenecks (AI path)', () => {
    it('should use AI when provider is available', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            step: 'step-1',
            description: 'AI detected bottleneck',
            impact: 'high',
            rootCause: 'Complex processing',
            suggestedSolution: 'Optimize',
            estimatedResolution: '2 hours',
            confidence: 0.9,
          }]),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test-provider',
      });

      const workflow = [makeWorkflowStep({ id: 'step-1', duration: 30 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(mockProvider.complete).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Using AI-enhanced bottleneck detection',
        expect.any(Object)
      );
    });

    it('should fall back to heuristic when AI provider returns null', async () => {
      mockProviderRegistry.getAvailableProvider.mockResolvedValue(null);
      const workflow = [makeWorkflowStep({ id: 's1', duration: 10, failureRate: 0.2 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Should still find failure bottleneck via heuristic
      expect(result.criticalBottlenecks.length).toBeGreaterThan(0);
    });

    it('should fall back to heuristic when AI throws error', async () => {
      // Inner catch in identifyBottlenecksWithAI catches the error and returns null
      // So logger.error fires (not warn), and outer method falls through to heuristic
      mockProviderRegistry.getAvailableProvider.mockRejectedValue(new Error('Provider error'));
      const workflow = [makeWorkflowStep({ id: 's1', duration: 10, failureRate: 0.2 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI bottleneck detection failed',
        expect.any(Object)
      );
      expect(result.criticalBottlenecks.length).toBeGreaterThan(0);
    });

    it('should fall back when AI inner method catches error', async () => {
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: { complete: jest.fn().mockRejectedValue(new Error('AI call failed')) },
        id: 'test',
      });
      const workflow = [makeWorkflowStep({ id: 's1', failureRate: 0.2 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Inner catch returns null → outer fallback
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI bottleneck detection failed',
        expect.any(Object)
      );
    });

    it('should parse AI response with missing JSON array', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({ completion: 'No JSON here' }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [makeWorkflowStep()];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // AI returns empty bottlenecks, heuristic-only ones added
      expect(result).toBeDefined();
    });

    it('should parse AI response with invalid JSON', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({ completion: '[invalid json]' }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [makeWorkflowStep()];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to parse AI bottleneck response',
        expect.any(Object)
      );
    });

    it('should validate AI bottlenecks against heuristics (confirmed)', async () => {
      // AI finds bottleneck at 'slow' step, heuristic also finds it (duration > 2x avg)
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            step: 'slow',
            description: 'AI: This step is slow',
            impact: 'high',
          }]),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      // avg = 40, threshold = 80, 100 > 80 → heuristic also finds 'slow'
      const workflow = [
        makeWorkflowStep({ id: 'fast1', duration: 10, failureRate: 0.01 }),
        makeWorkflowStep({ id: 'fast2', duration: 10, failureRate: 0.01 }),
        makeWorkflowStep({ id: 'slow', duration: 100, failureRate: 0.01 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const confirmed = result.criticalBottlenecks.find(
        b => b.step === 'slow' && b.description?.includes('Confirmed')
      );
      expect(confirmed).toBeDefined();
      expect(confirmed!.confidence).toBe(0.9);
    });

    it('should include AI-only bottlenecks with lower confidence', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            step: 'ai-only-step',
            description: 'Only AI found this',
            impact: 'medium',
          }]),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [
        makeWorkflowStep({ id: 'ai-only-step', duration: 30, failureRate: 0.01 }),
        makeWorkflowStep({ id: 's2', duration: 30, failureRate: 0.01 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const aiOnly = result.criticalBottlenecks.find(b => b.step === 'ai-only-step');
      expect(aiOnly).toBeDefined();
      expect(aiOnly!.confidence).toBe(0.7);
    });

    it('should include heuristic-only bottlenecks missed by AI', async () => {
      // AI finds nothing, but heuristic finds failure rate issue
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({ completion: '[]' }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [
        makeWorkflowStep({ id: 'flaky', duration: 30, failureRate: 0.5 }),
        makeWorkflowStep({ id: 'ok', duration: 30, failureRate: 0.01 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const heuristicOnly = result.criticalBottlenecks.find(b => b.step === 'flaky');
      expect(heuristicOnly).toBeDefined();
      expect(heuristicOnly!.confidence).toBe(0.75);
    });

    it('should filter AI response items without step or description', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([
            { step: 'valid', description: 'Valid bottleneck' },
            { step: '', description: '' }, // empty strings → falsy
            { description: 'No step' }, // missing step
            { step: 'no-desc' }, // missing description
          ]),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [makeWorkflowStep({ id: 'valid', duration: 30 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Only 'valid' should be included from AI results
      const aiBottlenecks = result.criticalBottlenecks.filter(b => b.step === 'valid');
      expect(aiBottlenecks.length).toBe(1);
    });

    it('should apply default values for missing AI response fields', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify([{
            step: 'x',
            description: 'Minimal',
          }]),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [makeWorkflowStep({ id: 'x', duration: 30 })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const bottleneck = result.criticalBottlenecks.find(b => b.step === 'x');
      expect(bottleneck).toBeDefined();
      expect(bottleneck!.impact).toBe('medium'); // default
    });
  });

  /* ────────────── Capacity Analysis ────────────── */

  describe('capacity analysis', () => {
    it('should calculate capacity metrics', async () => {
      const workflow = [
        makeWorkflowStep({ duration: 60 }),
        makeWorkflowStep({ duration: 120 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.capacity.currentCapacity).toBe(480); // 8 hours * 60
      expect(result.capacity.requiredCapacity).toBe(180);
      expect(result.capacity.utilizationRate).toBeCloseTo(180 / 480, 2);
      expect(result.capacity.peakLoad).toBe(120);
      expect(result.capacity.averageLoad).toBe(90);
      expect(result.capacity.capacityGap).toBe(0); // 180 < 480
    });

    it('should report capacity gap when over capacity', async () => {
      const workflow = Array(10).fill(null).map(() => makeWorkflowStep({ duration: 60 }));
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Total duration = 600 minutes, capacity = 480
      expect(result.capacity.capacityGap).toBe(120);
    });
  });

  /* ────────────── Queue Analysis ────────────── */

  describe('queue analysis', () => {
    it('should calculate queue metrics', async () => {
      const workflow = [
        makeWorkflowStep({ duration: 20 }),
        makeWorkflowStep({ duration: 40 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const avgDuration = 30;
      expect(result.queueAnalysis.averageQueueLength).toBeCloseTo(2 * 0.3, 2);
      expect(result.queueAnalysis.maxQueueLength).toBe(2);
      expect(result.queueAnalysis.averageWaitTime).toBeCloseTo(avgDuration * 0.2, 2);
      expect(result.queueAnalysis.queueingDelay).toBeCloseTo(avgDuration * 0.1, 2);
      expect(result.queueAnalysis.serviceRate).toBeCloseTo(60 / avgDuration, 2);
      expect(result.queueAnalysis.arrivalRate).toBe(50);
    });
  });

  /* ────────────── Resource Constraints ────────────── */

  describe('resource constraints', () => {
    it('should analyze resource constraints for each resource', async () => {
      const workflow = [
        makeWorkflowStep({ resources: ['analyst', 'server'], duration: 30 }),
        makeWorkflowStep({ resources: ['analyst'], duration: 60 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints.length).toBe(2);

      const analystConstraint = result.resourceConstraints.find(r => r.resource === 'analyst');
      expect(analystConstraint).toBeDefined();
      expect(analystConstraint!.currentUsage).toBe(90); // 30 + 60
      expect(analystConstraint!.maxCapacity).toBe(480);
      expect(analystConstraint!.utilizationRate).toBeCloseTo(90 / 480, 2);
    });

    it('should flag high utilization as bottleneck', async () => {
      const workflow = [
        makeWorkflowStep({ resources: ['server'], duration: 400 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const serverConstraint = result.resourceConstraints.find(r => r.resource === 'server');
      expect(serverConstraint!.isBottleneck).toBe(true); // 400/480 > 0.8
    });

    it('should not flag low utilization as bottleneck', async () => {
      const workflow = [
        makeWorkflowStep({ resources: ['server'], duration: 30 }),
      ];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      const serverConstraint = result.resourceConstraints.find(r => r.resource === 'server');
      expect(serverConstraint!.isBottleneck).toBe(false);
    });

    it('should classify human resources', async () => {
      const workflow = [makeWorkflowStep({ resources: ['person-A'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('human');
      expect(result.resourceConstraints[0].scalability).toBe('scalable');
    });

    it('should classify system resources', async () => {
      const workflow = [makeWorkflowStep({ resources: ['system-X'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('system');
      expect(result.resourceConstraints[0].scalability).toBe('elastic');
    });

    it('should classify infrastructure resources', async () => {
      const workflow = [makeWorkflowStep({ resources: ['database-main'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('infrastructure');
      expect(result.resourceConstraints[0].scalability).toBe('scalable');
    });

    it('should classify network as infrastructure', async () => {
      const workflow = [makeWorkflowStep({ resources: ['network-gateway'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('infrastructure');
    });

    it('should classify analyst as human', async () => {
      const workflow = [makeWorkflowStep({ resources: ['data-analyst'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('human');
    });

    it('should classify unknown resources as external', async () => {
      const workflow = [makeWorkflowStep({ resources: ['third-party-api'] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints[0].type).toBe('external');
      expect(result.resourceConstraints[0].scalability).toBe('fixed');
    });
  });

  /* ────────────── Edge cases ────────────── */

  describe('edge cases', () => {
    it('should handle single step workflow', async () => {
      const workflow = [makeWorkflowStep()];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result).toBeDefined();
      expect(result.capacity).toBeDefined();
    });

    it('should handle workflow with no resources', async () => {
      const workflow = [makeWorkflowStep({ resources: [] })];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      expect(result.resourceConstraints).toEqual([]);
    });

    it('should handle AI response that is not an array', async () => {
      const mockProvider = {
        complete: jest.fn().mockResolvedValue({
          completion: JSON.stringify({ not: 'an array' }),
        }),
      };
      mockProviderRegistry.getAvailableProvider.mockResolvedValue({
        provider: mockProvider,
        id: 'test',
      });
      const workflow = [makeWorkflowStep()];
      const result = await service.identifyBottlenecks(workflow as any[], makeWorkflowAnalysis() as any);
      // Non-array parsed → returns empty bottlenecks
      expect(result).toBeDefined();
    });
  });
});
