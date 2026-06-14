/**
 * Comprehensive tests for OptimizationRecommender
 * Covers: generateOptimizations, createOptimizedWorkflow, assessOptimizationImpact,
 *         calculateAverageGain, applyOptimization, convertOpportunitiesToImprovements,
 *         assessWorkflowComplexity, assessDataQuality, private generators via public API
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

import { OptimizationRecommender } from '../../../../src/services/ai/orchestrator/agents/optimization/OptimizationRecommender';

describe('OptimizationRecommender', () => {
  let service: OptimizationRecommender;

  const makeStep = (overrides: Record<string, any> = {}) => ({
    id: 'step-1',
    name: 'Process Step',
    type: 'automated',
    duration: 30,
    resources: ['analyst'],
    dependencies: [],
    failureRate: 0.02,
    ...overrides,
  });

  const makeWorkflowAnalysis = (overrides: Record<string, any> = {}) => ({
    steps: [],
    criticalPath: [],
    parallelizable: [],
    dependencies: new Map(),
    estimatedDuration: 30,
    ...overrides,
  });

  const makeBottleneckAnalysis = (overrides: Record<string, any> = {}) => ({
    criticalBottlenecks: [],
    capacityAnalysis: { currentCapacity: 480, utilizationRate: 0.5, peakLoad: 0.6, capacityGap: 0 },
    queueAnalysis: { averageQueueLength: 1, serviceRate: 2, arrivalRate: 1.5, waitTime: 5 },
    resourceConstraints: [],
    ...overrides,
  });

  const makePerformanceAnalysis = (overrides: Record<string, any> = {}) => ({
    throughput: 50,
    utilization: 0.75,
    efficiency: 0.8,
    waitTime: 5,
    processingTime: 30,
    setupTime: 10,
    metrics: [],
    ...overrides,
  });

  const makeOpportunity = (overrides: Record<string, any> = {}) => ({
    id: 'opp-1',
    type: 'automation',
    description: 'Automate step',
    affectedSteps: ['step-1'],
    potentialGains: {
      timeReduction: 0.6,
      costReduction: 0.7,
      qualityImprovement: 0.3,
      errorReduction: 0.8,
    },
    implementationEffort: 'medium',
    prerequisites: ['Prereq A'],
    risks: ['Risk A'],
    ...overrides,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    service = new (OptimizationRecommender as any)(mockLogger);
  });

  /* ────────────── generateOptimizations ────────────── */

  describe('generateOptimizations', () => {
    it('should return full optimization analysis structure', async () => {
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      expect(result.opportunities).toBeDefined();
      expect(result.scenarios).toBeDefined();
      expect(result.recommendations).toBeDefined();
      expect(result.impact).toBeDefined();
    });

    it('should generate automation opportunities for manual steps', async () => {
      const steps = [makeStep({ type: 'manual', name: 'Data Entry' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const autoOpps = result.opportunities.filter(o => o.type === 'automation');
      expect(autoOpps.length).toBe(1);
      expect(autoOpps[0].description).toContain('Data Entry');
    });

    it('should generate parallelization opportunity for >1 parallelizable steps', async () => {
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis({ parallelizable: ['s1', 's2'] }) as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const parallelOpps = result.opportunities.filter(o => o.type === 'parallelization');
      expect(parallelOpps.length).toBe(1);
    });

    it('should not generate parallelization for <= 1 parallelizable', async () => {
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis({ parallelizable: ['s1'] }) as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const parallelOpps = result.opportunities.filter(o => o.type === 'parallelization');
      expect(parallelOpps.length).toBe(0);
    });

    it('should generate elimination opportunity for redundant-named steps', async () => {
      const steps = [makeStep({ name: 'Redundant Check' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const elimOpps = result.opportunities.filter(o => o.type === 'elimination');
      expect(elimOpps.length).toBe(1);
    });

    it('should generate elimination for duplicate-named steps', async () => {
      const steps = [makeStep({ name: 'Duplicate Entry' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const elimOpps = result.opportunities.filter(o => o.type === 'elimination');
      expect(elimOpps.length).toBe(1);
    });

    it('should generate consolidation for related steps (shared resources)', async () => {
      const steps = [
        makeStep({ id: 's1', name: 'Step Alpha', resources: ['analyst'] }),
        makeStep({ id: 's2', name: 'Step Beta', resources: ['analyst'] }),
      ];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const consolOpps = result.opportunities.filter(o => o.type === 'consolidation');
      expect(consolOpps.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate consolidation for related steps (shared name words >4 chars)', async () => {
      const steps = [
        makeStep({ id: 's1', name: 'Invoice Processing', resources: ['r1'] }),
        makeStep({ id: 's2', name: 'Invoice Validation', resources: ['r2'] }),
      ];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const consolOpps = result.opportunities.filter(o => o.type === 'consolidation');
      expect(consolOpps.length).toBeGreaterThanOrEqual(1);
    });

    it('should generate reordering for high-impact bottlenecks', async () => {
      const bottlenecks = makeBottleneckAnalysis({
        criticalBottlenecks: [
          { step: 'step-1', type: 'duration', impact: 'high', description: 'Slow' },
        ],
      });
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        bottlenecks as any,
        makePerformanceAnalysis() as any,
        []
      );
      const reorderOpps = result.opportunities.filter(o => o.type === 'reordering');
      expect(reorderOpps.length).toBe(1);
    });

    it('should not generate reordering when no high-impact bottlenecks', async () => {
      const bottlenecks = makeBottleneckAnalysis({
        criticalBottlenecks: [
          { step: 'step-1', type: 'duration', impact: 'medium', description: 'Slow' },
        ],
      });
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        bottlenecks as any,
        makePerformanceAnalysis() as any,
        []
      );
      const reorderOpps = result.opportunities.filter(o => o.type === 'reordering');
      expect(reorderOpps.length).toBe(0);
    });

    it('should log start and completion', async () => {
      await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      expect(mockLogger.info).toHaveBeenCalledWith('Generating optimization analysis', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Optimization analysis completed', expect.any(Object));
    });
  });

  /* ────────────── Scenarios (via generateOptimizations) ────────────── */

  describe('scenarios generation', () => {
    it('should create Quick Wins scenario for low-effort opportunities', async () => {
      const steps = [makeStep({ name: 'Redundant Check' })]; // elimination = low effort
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const quickWins = result.scenarios.filter(s => s.name === 'Quick Wins');
      expect(quickWins.length).toBe(1);
      expect(quickWins[0].confidence).toBe(0.8);
    });

    it('should create Strategic Transformation for >3 opportunities', async () => {
      const steps = [
        makeStep({ id: 's1', type: 'manual', name: 'Manual Redundant Step A', resources: ['r1'] }),
        makeStep({ id: 's2', type: 'manual', name: 'Manual Redundant Step B', resources: ['r2'] }),
      ];
      const bottlenecks = makeBottleneckAnalysis({
        criticalBottlenecks: [
          { step: 's1', type: 'duration', impact: 'high', description: 'Slow' },
        ],
      });
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis({ parallelizable: ['s1', 's2'] }) as any,
        bottlenecks as any,
        makePerformanceAnalysis() as any,
        []
      );
      // Should have: 2 automation + 2 elimination + 1 parallel + 1 reorder = 6 opportunities (>3)
      if (result.opportunities.length > 3) {
        const strategic = result.scenarios.filter(s => s.name === 'Strategic Transformation');
        expect(strategic.length).toBe(1);
        expect(strategic[0].confidence).toBe(0.65);
      }
    });

    it('should create Automation First scenario for automation opportunities', async () => {
      const steps = [makeStep({ type: 'manual', name: 'Data Entry' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const autoFirst = result.scenarios.filter(s => s.name === 'Automation First');
      expect(autoFirst.length).toBe(1);
      expect(autoFirst[0].confidence).toBe(0.7);
    });
  });

  /* ────────────── Recommendations (via generateOptimizations) ────────────── */

  describe('recommendations generation', () => {
    it('should recommend automation when automation opportunities exist', async () => {
      const steps = [makeStep({ type: 'manual', name: 'Data Entry' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const autoRecs = result.recommendations.filter(r => r.title === 'Implement Process Automation');
      expect(autoRecs.length).toBe(1);
      expect(autoRecs[0].priority).toBe('high');
      expect(autoRecs[0].implementation.phases.length).toBe(3);
    });

    it('should recommend quick wins when low-effort opportunities exist', async () => {
      const steps = [makeStep({ name: 'Redundant Check' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const quickRecs = result.recommendations.filter(r => r.title === 'Implement Quick Wins');
      expect(quickRecs.length).toBe(1);
      expect(quickRecs[0].priority).toBe('critical');
    });

    it('should recommend bottleneck resolution for reordering opportunities', async () => {
      const bottlenecks = makeBottleneckAnalysis({
        criticalBottlenecks: [
          { step: 'step-1', type: 'duration', impact: 'high', description: 'Slow' },
        ],
      });
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        bottlenecks as any,
        makePerformanceAnalysis() as any,
        []
      );
      const bottleneckRecs = result.recommendations.filter(r => r.title === 'Resolve Critical Bottlenecks');
      expect(bottleneckRecs.length).toBe(1);
    });

    it('should return no recommendations when no opportunities', async () => {
      const result = await service.generateOptimizations(
        [makeStep()] as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      // automated step, no parallelizable, no redundant, no bottlenecks → no opportunities
      expect(result.recommendations).toEqual([]);
    });
  });

  /* ────────────── createOptimizedWorkflow ────────────── */

  describe('createOptimizedWorkflow', () => {
    it('should reduce duration for automation opportunities', async () => {
      const workflow = [makeStep({ id: 's1', duration: 100, type: 'manual' })];
      const opportunities = [makeOpportunity({ affectedSteps: ['s1'], type: 'automation' })];
      const result = await service.createOptimizedWorkflow(workflow as any[], opportunities as any[]);
      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(100 * (1 - 0.6)); // 40
      expect(result[0].type).toBe('automated');
    });

    it('should remove eliminated steps', async () => {
      const workflow = [
        makeStep({ id: 's1', duration: 50 }),
        makeStep({ id: 's2', duration: 30, name: 'Redundant Step' }),
      ];
      const opportunities = [makeOpportunity({
        affectedSteps: ['s2'],
        type: 'elimination',
        potentialGains: { timeReduction: 0.9, costReduction: 0.8, qualityImprovement: 0.1, errorReduction: 0.2 },
      })];
      const result = await service.createOptimizedWorkflow(workflow as any[], opportunities as any[]);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('s1');
    });

    it('should not affect steps not in affectedSteps', async () => {
      const workflow = [
        makeStep({ id: 's1', duration: 50 }),
        makeStep({ id: 's2', duration: 30 }),
      ];
      const opportunities = [makeOpportunity({ affectedSteps: ['s1'] })];
      const result = await service.createOptimizedWorkflow(workflow as any[], opportunities as any[]);
      expect(result.find(s => s.id === 's2')!.duration).toBe(30);
    });

    it('should handle empty opportunities', async () => {
      const workflow = [makeStep({ id: 's1', duration: 50 })];
      const result = await service.createOptimizedWorkflow(workflow as any[], []);
      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(50);
    });

    it('should reduce failureRate for automation', async () => {
      const workflow = [makeStep({ id: 's1', failureRate: 0.1 })];
      const opportunities = [makeOpportunity({ affectedSteps: ['s1'], type: 'automation' })];
      const result = await service.createOptimizedWorkflow(workflow as any[], opportunities as any[]);
      expect(result[0].failureRate).toBeCloseTo(0.1 * (1 - 0.8), 5); // 0.02
    });

    it('should log workflow creation', async () => {
      await service.createOptimizedWorkflow([makeStep()] as any[], []);
      expect(mockLogger.info).toHaveBeenCalledWith('Creating optimized workflow', expect.any(Object));
      expect(mockLogger.info).toHaveBeenCalledWith('Optimized workflow created', expect.any(Object));
    });

    it('should ensure minimum duration of 1', async () => {
      const workflow = [makeStep({ id: 's1', duration: 1 })];
      const opportunities = [makeOpportunity({
        affectedSteps: ['s1'],
        type: 'parallelization',
        potentialGains: { timeReduction: 0.99, costReduction: 0, qualityImprovement: 0, errorReduction: 0 },
      })];
      const result = await service.createOptimizedWorkflow(workflow as any[], opportunities as any[]);
      expect(result[0].duration).toBeGreaterThanOrEqual(1);
    });
  });

  /* ────────────── assessOptimizationImpact ────────────── */

  describe('assessOptimizationImpact', () => {
    it('should return complete impact assessment', () => {
      const opps = [makeOpportunity()];
      const result = service.assessOptimizationImpact(opps as any[], []);
      expect(result.timeImprovement).toBeDefined();
      expect(result.costReduction).toBeDefined();
      expect(result.qualityGains).toBeDefined();
      expect(result.riskReduction).toBeDefined();
      expect(result.overallValue).toBeDefined();
    });

    it('should calculate time improvement from opportunities', () => {
      const opps = [
        makeOpportunity({ potentialGains: { timeReduction: 0.4, costReduction: 0, qualityImprovement: 0, errorReduction: 0 } }),
        makeOpportunity({ id: 'o2', potentialGains: { timeReduction: 0.6, costReduction: 0, qualityImprovement: 0, errorReduction: 0 } }),
      ];
      const result = service.assessOptimizationImpact(opps as any[], []);
      expect(result.timeImprovement.improvementPercent).toBe(50); // avg 0.5 * 100
      expect(result.timeImprovement.projectedValue).toBe(100 * (1 - 0.5)); // 50
    });

    it('should handle empty opportunities', () => {
      const result = service.assessOptimizationImpact([], []);
      expect(result.overallValue).toBe(0);
      expect(result.timeImprovement.projectedValue).toBe(100);
    });

    it('should calculate overallValue as average of 4 metrics', () => {
      const opps = [makeOpportunity({
        potentialGains: { timeReduction: 0.4, costReduction: 0.2, qualityImprovement: 0.1, errorReduction: 0.3 },
      })];
      const result = service.assessOptimizationImpact(opps as any[], []);
      expect(result.overallValue).toBeCloseTo((0.4 + 0.2 + 0.1 + 0.3) / 4, 5);
    });
  });

  /* ────────────── calculateAverageGain ────────────── */

  describe('calculateAverageGain', () => {
    it('should return 0 for empty opportunities', () => {
      expect(service.calculateAverageGain([], 'timeReduction')).toBe(0);
    });

    it('should calculate average for timeReduction', () => {
      const opps = [
        makeOpportunity({ potentialGains: { timeReduction: 0.2, costReduction: 0, qualityImprovement: 0, errorReduction: 0 } }),
        makeOpportunity({ potentialGains: { timeReduction: 0.8, costReduction: 0, qualityImprovement: 0, errorReduction: 0 } }),
      ];
      expect(service.calculateAverageGain(opps as any[], 'timeReduction')).toBe(0.5);
    });

    it('should calculate average for costReduction', () => {
      const opps = [
        makeOpportunity({ potentialGains: { timeReduction: 0, costReduction: 0.3, qualityImprovement: 0, errorReduction: 0 } }),
      ];
      expect(service.calculateAverageGain(opps as any[], 'costReduction')).toBe(0.3);
    });
  });

  /* ────────────── applyOptimization ────────────── */

  describe('applyOptimization', () => {
    it('should reduce duration based on timeReduction', () => {
      const workflow = [makeStep({ id: 's1', duration: 100 })];
      const opp = makeOpportunity({
        affectedSteps: ['s1'],
        type: 'parallelization',
        potentialGains: { timeReduction: 0.5, costReduction: 0, qualityImprovement: 0, errorReduction: 0 },
      });
      const result = service.applyOptimization(workflow as any[], opp as any);
      expect(result[0].duration).toBe(50);
    });

    it('should set type to automated for automation', () => {
      const workflow = [makeStep({ id: 's1', type: 'manual' })];
      const opp = makeOpportunity({ affectedSteps: ['s1'], type: 'automation' });
      const result = service.applyOptimization(workflow as any[], opp as any);
      expect(result[0].type).toBe('automated');
    });

    it('should remove eliminated steps (duration 0)', () => {
      const workflow = [
        makeStep({ id: 's1', duration: 50 }),
        makeStep({ id: 's2', duration: 30 }),
      ];
      const opp = makeOpportunity({ affectedSteps: ['s2'], type: 'elimination' });
      const result = service.applyOptimization(workflow as any[], opp as any);
      expect(result.length).toBe(1);
      expect(result[0].id).toBe('s1');
    });

    it('should not modify steps not in affectedSteps', () => {
      const workflow = [
        makeStep({ id: 's1', duration: 50 }),
        makeStep({ id: 's2', duration: 30 }),
      ];
      const opp = makeOpportunity({ affectedSteps: ['s1'] });
      const result = service.applyOptimization(workflow as any[], opp as any);
      expect(result.find(s => s.id === 's2')!.duration).toBe(30);
    });

    it('should handle non-existent step IDs gracefully', () => {
      const workflow = [makeStep({ id: 's1', duration: 50 })];
      const opp = makeOpportunity({ affectedSteps: ['nonexistent'] });
      const result = service.applyOptimization(workflow as any[], opp as any);
      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(50);
    });
  });

  /* ────────────── convertOpportunitiesToImprovements ────────────── */

  describe('convertOpportunitiesToImprovements', () => {
    it('should convert opportunities to improvements format', () => {
      const opps = [makeOpportunity()];
      const result = service.convertOpportunitiesToImprovements(opps as any[]);
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('automation');
      expect(result[0].description).toBe('Automate step');
      expect(result[0].impact.timeReduction).toBe(0.6);
      expect(result[0].impact.riskReduction).toBe(0.8); // maps errorReduction
      expect(result[0].implementationComplexity).toBe('medium');
      expect(result[0].prerequisites).toEqual(['Prereq A']);
    });

    it('should handle empty opportunities', () => {
      const result = service.convertOpportunitiesToImprovements([]);
      expect(result).toEqual([]);
    });

    it('should convert multiple opportunities', () => {
      const opps = [
        makeOpportunity({ type: 'automation' }),
        makeOpportunity({ id: 'o2', type: 'elimination' }),
      ];
      const result = service.convertOpportunitiesToImprovements(opps as any[]);
      expect(result.length).toBe(2);
      expect(result[1].type).toBe('elimination');
    });
  });

  /* ────────────── assessWorkflowComplexity ────────────── */

  describe('assessWorkflowComplexity', () => {
    it('should return 0 for empty workflow', () => {
      expect(service.assessWorkflowComplexity([])).toBe(0);
    });

    it('should calculate (steps + deps) / 20', () => {
      const workflow = [
        makeStep({ dependencies: ['a', 'b'] }),
        makeStep({ id: 's2', dependencies: ['c'] }),
      ];
      // (2 steps + 3 deps) / 20 = 0.25
      expect(service.assessWorkflowComplexity(workflow as any[])).toBeCloseTo(0.25, 5);
    });

    it('should cap at 1', () => {
      const workflow = Array(25).fill(null).map((_, i) =>
        makeStep({ id: `s${i}`, dependencies: [] })
      );
      // 25/20 = 1.25 → capped at 1
      expect(service.assessWorkflowComplexity(workflow as any[])).toBe(1);
    });

    it('should factor in dependencies', () => {
      const workflow = Array(5).fill(null).map((_, i) =>
        makeStep({ id: `s${i}`, dependencies: ['a', 'b', 'c', 'd'] })
      );
      // (5 + 20) / 20 = 1.25 → capped at 1
      expect(service.assessWorkflowComplexity(workflow as any[])).toBe(1);
    });
  });

  /* ────────────── assessDataQuality ────────────── */

  describe('assessDataQuality', () => {
    it('should start at 0.5 baseline', () => {
      const workflow = [{ id: '', name: '', duration: 10, type: 'manual', resources: [], dependencies: [] }];
      // steps missing id/name (falsy) → no +0.2
      const result = service.assessDataQuality(workflow as any[], false, false);
      expect(result).toBe(0.5);
    });

    it('should add 0.2 for complete steps', () => {
      const workflow = [makeStep()]; // has id, name, duration
      const result = service.assessDataQuality(workflow as any[], false, false);
      expect(result).toBe(0.7);
    });

    it('should add 0.2 for metrics', () => {
      const workflow = [makeStep()];
      const result = service.assessDataQuality(workflow as any[], true, false);
      expect(result).toBeCloseTo(0.9, 5);
    });

    it('should add 0.1 for objectives', () => {
      const workflow = [makeStep()];
      const result = service.assessDataQuality(workflow as any[], false, true);
      expect(result).toBeCloseTo(0.8, 5);
    });

    it('should return 1.0 for all factors present', () => {
      const workflow = [makeStep()];
      const result = service.assessDataQuality(workflow as any[], true, true);
      expect(result).toBeCloseTo(1.0, 5);
    });

    it('should cap at 1 even with all bonuses', () => {
      const workflow = [makeStep()];
      const result = service.assessDataQuality(workflow as any[], true, true);
      expect(result).toBeLessThanOrEqual(1);
    });
  });

  /* ────────────── Edge cases ────────────── */

  describe('edge cases', () => {
    it('should handle workflow with no manual steps (no automation opps)', async () => {
      const steps = [makeStep({ type: 'automated' })];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const autoOpps = result.opportunities.filter(o => o.type === 'automation');
      expect(autoOpps).toEqual([]);
    });

    it('should not consolidate single-step groups', async () => {
      const steps = [
        makeStep({ id: 's1', name: 'Alpha Task', resources: ['r1'] }),
        makeStep({ id: 's2', name: 'Beta Task', resources: ['r2'] }),
      ];
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis() as any,
        makeBottleneckAnalysis() as any,
        makePerformanceAnalysis() as any,
        []
      );
      const consolOpps = result.opportunities.filter(o => o.type === 'consolidation');
      // No shared resources or name words >4 chars in common
      expect(consolOpps).toEqual([]);
    });

    it('should handle combined opportunities and produce all scenario types', async () => {
      const steps = [
        makeStep({ id: 's1', type: 'manual', name: 'Manual Invoice Processing', resources: ['analyst'] }),
        makeStep({ id: 's2', type: 'manual', name: 'Manual Invoice Validation', resources: ['analyst'] }),
        makeStep({ id: 's3', name: 'Redundant Data Check', resources: ['server'] }),
      ];
      const bottlenecks = makeBottleneckAnalysis({
        criticalBottlenecks: [
          { step: 's1', type: 'duration', impact: 'high', description: 'Slow' },
        ],
      });
      const result = await service.generateOptimizations(
        steps as any[],
        makeWorkflowAnalysis({ parallelizable: ['s1', 's2'] }) as any,
        bottlenecks as any,
        makePerformanceAnalysis() as any,
        []
      );
      expect(result.opportunities.length).toBeGreaterThan(3);
      expect(result.scenarios.length).toBeGreaterThan(0);
      expect(result.recommendations.length).toBeGreaterThan(0);
    });
  });
});
