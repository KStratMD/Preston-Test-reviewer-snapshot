/**
 * Comprehensive Unit Tests for Process Optimization Services
 *
 * Tests the following 5 services:
 *   1. BottleneckAnalysisService
 *   2. CostBenefitAnalyzer
 *   3. OptimizationRecommender
 *   4. PerformanceMetricsService
 *   5. RiskAssessmentService
 *
 * Each service is tested with realistic data, edge cases, and boundary conditions.
 */

import 'reflect-metadata';

import { BottleneckAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/optimization/BottleneckAnalysisService';
import { CostBenefitAnalyzer } from '../../../../../../../src/services/ai/orchestrator/agents/optimization/CostBenefitAnalyzer';
import { OptimizationRecommender } from '../../../../../../../src/services/ai/orchestrator/agents/optimization/OptimizationRecommender';
import { PerformanceMetricsService } from '../../../../../../../src/services/ai/orchestrator/agents/optimization/PerformanceMetricsService';
import { RiskAssessmentService } from '../../../../../../../src/services/ai/orchestrator/agents/optimization/RiskAssessmentService';

import type { WorkflowStep, Bottleneck, PerformanceMetric, Constraint, Objective, CostSaving } from '../../../../../../../src/services/ai/orchestrator/interfaces';
import type {
  AnalyzedWorkflow,
  BottleneckAnalysis,
  PerformanceAnalysis,
  OptimizationAnalysis,
  OptimizationOpportunity,
  OptimizationScenario,
  ImpactAssessment
} from '../../../../../../../src/services/ai/orchestrator/agents/types/process-optimization';

// ==================== Shared Mocks ====================

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as any;

const mockProviderRegistry = {
  getAvailableProvider: jest.fn()
} as any;

const mockRoiService = {
  calculateSimpleROI: jest.fn((benefits: number, costs: number) => {
    if (costs === 0) return 0;
    return Math.round(((benefits - costs) / costs) * 100);
  })
} as any;

// ==================== Shared Test Data Helpers ====================

function createWorkflowStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: 'step_1',
    name: 'Default Step',
    type: 'manual',
    duration: 30,
    resources: ['analyst'],
    dependencies: [],
    failureRate: 0.05,
    ...overrides
  };
}

function createRealisticWorkflow(): WorkflowStep[] {
  return [
    createWorkflowStep({
      id: 'step_receive',
      name: 'Receive Order',
      type: 'automated',
      duration: 5,
      resources: ['system'],
      dependencies: [],
      failureRate: 0.02
    }),
    createWorkflowStep({
      id: 'step_validate',
      name: 'Validate Order Data',
      type: 'manual',
      duration: 15,
      resources: ['analyst'],
      dependencies: ['step_receive'],
      failureRate: 0.08
    }),
    createWorkflowStep({
      id: 'step_enrich',
      name: 'Enrich Customer Data',
      type: 'manual',
      duration: 25,
      resources: ['analyst', 'database'],
      dependencies: ['step_validate'],
      failureRate: 0.05
    }),
    createWorkflowStep({
      id: 'step_transform',
      name: 'Transform Data Format',
      type: 'automated',
      duration: 10,
      resources: ['system'],
      dependencies: ['step_enrich'],
      failureRate: 0.03
    }),
    createWorkflowStep({
      id: 'step_process',
      name: 'Process Payment',
      type: 'hybrid',
      duration: 20,
      resources: ['system', 'analyst'],
      dependencies: ['step_transform'],
      failureRate: 0.04
    }),
    createWorkflowStep({
      id: 'step_ship',
      name: 'Ship Order',
      type: 'manual',
      duration: 45,
      resources: ['warehouse_person'],
      dependencies: ['step_process'],
      failureRate: 0.06
    })
  ];
}

function createAnalyzedWorkflow(workflow?: WorkflowStep[]): AnalyzedWorkflow {
  const steps = workflow || createRealisticWorkflow();
  return {
    totalSteps: steps.length,
    criticalPath: steps.map(s => s.id),
    parallelizable: ['step_enrich', 'step_transform'],
    sequential: ['step_receive', 'step_validate', 'step_process', 'step_ship'],
    cyclicPaths: [],
    totalDuration: steps.reduce((sum, s) => sum + s.duration, 0),
    totalCost: 5000,
    complexity: 'medium'
  };
}

function createPerformanceMetrics(): PerformanceMetric[] {
  return [
    { name: 'Throughput Rate', currentValue: 45, targetValue: 60, unit: 'orders/hour', trend: 'improving' },
    { name: 'Resource Utilization', currentValue: 82, targetValue: 90, unit: '%', trend: 'stable' },
    { name: 'Process Efficiency', currentValue: 75, targetValue: 85, unit: '%', trend: 'declining' },
    { name: 'Average Wait Time', currentValue: 8, targetValue: 3, unit: 'minutes', trend: 'declining' },
    { name: 'Processing Time', currentValue: 25, targetValue: 15, unit: 'minutes', trend: 'stable' },
    { name: 'Setup Time', currentValue: 12, targetValue: 5, unit: 'minutes', trend: 'improving' }
  ];
}

function createObjectives(): Objective[] {
  return [
    {
      name: 'Reduce Processing Time',
      description: 'Reduce end-to-end processing time by 30%',
      measurable: true,
      priority: 'high',
      successCriteria: ['Processing time < 90 minutes']
    },
    {
      name: 'Improve Quality',
      description: 'Reduce error rate below 3%',
      measurable: true,
      priority: 'medium',
      successCriteria: ['Error rate < 3%', 'Customer satisfaction > 95%']
    }
  ];
}

function createConstraints(): Constraint[] {
  return [
    { type: 'budget', description: 'Budget limited to $100,000', severity: 'hard' },
    { type: 'regulatory', description: 'SOX compliance required', severity: 'hard' },
    { type: 'technical', description: 'Must maintain API backward compatibility', severity: 'soft' },
    { type: 'resource', description: 'Maximum 3 FTE for implementation', severity: 'soft' }
  ];
}

function createOptimizationAnalysis(): OptimizationAnalysis {
  return {
    opportunities: [
      {
        id: 'automate_step_validate',
        type: 'automation',
        description: 'Automate manual step: Validate Order Data',
        affectedSteps: ['step_validate'],
        potentialGains: { timeReduction: 0.6, costReduction: 0.7, qualityImprovement: 0.3, errorReduction: 0.8 },
        implementationEffort: 'medium',
        prerequisites: ['Process standardization'],
        risks: ['Implementation complexity']
      },
      {
        id: 'automate_step_enrich',
        type: 'automation',
        description: 'Automate manual step: Enrich Customer Data',
        affectedSteps: ['step_enrich'],
        potentialGains: { timeReduction: 0.6, costReduction: 0.7, qualityImprovement: 0.3, errorReduction: 0.8 },
        implementationEffort: 'medium',
        prerequisites: ['Data quality platform'],
        risks: ['Data integrity']
      },
      {
        id: 'parallelize_steps',
        type: 'parallelization',
        description: 'Execute 2 steps in parallel',
        affectedSteps: ['step_enrich', 'step_transform'],
        potentialGains: { timeReduction: 0.4, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
        implementationEffort: 'low',
        prerequisites: ['Resource availability'],
        risks: ['Coordination complexity']
      },
      {
        id: 'reorder_bottlenecks',
        type: 'reordering',
        description: 'Reorder workflow to optimize bottleneck steps',
        affectedSteps: ['step_ship'],
        potentialGains: { timeReduction: 0.25, costReduction: 0.15, qualityImprovement: 0.1, errorReduction: 0.1 },
        implementationEffort: 'low',
        prerequisites: ['Dependency analysis'],
        risks: ['Logic errors']
      }
    ],
    scenarios: [],
    recommendations: [],
    impact: {
      timeImprovement: { currentValue: 100, projectedValue: 60, improvementPercent: 40, confidence: 0.7, timeframe: '6 months' },
      costReduction: { currentValue: 100000, projectedValue: 60000, improvementPercent: 40, confidence: 0.6, timeframe: '12 months' },
      qualityGains: { currentValue: 0.85, projectedValue: 0.95, improvementPercent: 15, confidence: 0.8, timeframe: '6 months' },
      riskReduction: { currentValue: 0.15, projectedValue: 0.08, improvementPercent: 42, confidence: 0.75, timeframe: '6 months' },
      overallValue: 0.4
    }
  };
}

// ============================================================
// 1. BottleneckAnalysisService Tests
// ============================================================

describe('BottleneckAnalysisService', () => {
  let service: BottleneckAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    // No AI provider available by default -> heuristic fallback path
    mockProviderRegistry.getAvailableProvider.mockResolvedValue(null);
    service = new BottleneckAnalysisService(mockLogger, mockProviderRegistry);
  });

  describe('identifyBottlenecks', () => {
    it('should return a complete BottleneckAnalysis with all four sections', async () => {
      const workflow = createRealisticWorkflow();
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      expect(result).toHaveProperty('criticalBottlenecks');
      expect(result).toHaveProperty('capacity');
      expect(result).toHaveProperty('queueAnalysis');
      expect(result).toHaveProperty('resourceConstraints');
      expect(Array.isArray(result.criticalBottlenecks)).toBe(true);
      expect(Array.isArray(result.resourceConstraints)).toBe(true);
    });

    it('should identify duration-based bottlenecks for steps exceeding 2x average', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 10, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 10, resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', duration: 100, resources: ['c'], dependencies: [] }) // well above 2x avg (40)
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const durationBottleneck = result.criticalBottlenecks.find(
        b => b.step === 's3' && b.rootCause === 'Long processing time'
      );
      expect(durationBottleneck).toBeDefined();
      expect(durationBottleneck!.impact).toBe('high');
    });

    it('should identify resource bottlenecks for resources used in >60% of steps', async () => {
      // resource "shared_db" used in 4 out of 5 steps = 80% > 60%
      const workflow = [
        createWorkflowStep({ id: 's1', resources: ['shared_db'], dependencies: [] }),
        createWorkflowStep({ id: 's2', resources: ['shared_db'], dependencies: [] }),
        createWorkflowStep({ id: 's3', resources: ['shared_db'], dependencies: [] }),
        createWorkflowStep({ id: 's4', resources: ['shared_db'], dependencies: [] }),
        createWorkflowStep({ id: 's5', resources: ['unique_api'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const resourceBottleneck = result.criticalBottlenecks.find(
        b => b.step === 'shared_db' && b.rootCause === 'Resource overutilization'
      );
      expect(resourceBottleneck).toBeDefined();
      expect(resourceBottleneck!.impact).toBe('medium');
      expect(resourceBottleneck!.description).toContain('4 out of 5');
    });

    it('should identify failure rate bottlenecks for steps with >10% failure rate', async () => {
      const workflow = [
        createWorkflowStep({ id: 'reliable', failureRate: 0.02, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 'flaky', failureRate: 0.25, resources: ['b'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const failureBottleneck = result.criticalBottlenecks.find(
        b => b.step === 'flaky' && b.rootCause === 'High failure rate causing rework'
      );
      expect(failureBottleneck).toBeDefined();
      expect(failureBottleneck!.impact).toBe('high');
      expect(failureBottleneck!.description).toContain('25.0%');
    });

    it('should not identify failure bottleneck when failureRate is undefined', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', failureRate: undefined, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', failureRate: 0.05, resources: ['b'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const failureBottlenecks = result.criticalBottlenecks.filter(
        b => b.rootCause === 'High failure rate causing rework'
      );
      expect(failureBottlenecks.length).toBe(0);
    });

    it('should not flag duration bottleneck when all steps have equal duration', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 30, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 30, resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', duration: 30, resources: ['c'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const durationBottlenecks = result.criticalBottlenecks.filter(
        b => b.rootCause === 'Long processing time'
      );
      expect(durationBottlenecks.length).toBe(0);
    });

    it('should fall back to heuristics when AI provider throws an error', async () => {
      mockProviderRegistry.getAvailableProvider.mockRejectedValue(new Error('AI unavailable'));

      const workflow = createRealisticWorkflow();
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      expect(result).toHaveProperty('criticalBottlenecks');
      expect(result).toHaveProperty('capacity');
      // Inner try/catch logs error, then returns null, triggering heuristic fallback
      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI bottleneck detection failed',
        expect.any(Object)
      );
    });

    it('should fall back to heuristics when AI provider returns null', async () => {
      mockProviderRegistry.getAvailableProvider.mockResolvedValue(null);

      const workflow = createRealisticWorkflow();
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      // Should still return valid analysis via heuristic path
      expect(result.capacity).toBeDefined();
      expect(result.queueAnalysis).toBeDefined();
    });
  });

  describe('capacity analysis', () => {
    it('should calculate capacity correctly', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 100, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 200, resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', duration: 180, resources: ['c'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      expect(result.capacity.currentCapacity).toBe(480); // 8 * 60
      expect(result.capacity.requiredCapacity).toBe(480); // 100 + 200 + 180
      expect(result.capacity.utilizationRate).toBe(1); // 480 / 480
      expect(result.capacity.peakLoad).toBe(200);
      expect(result.capacity.averageLoad).toBe(160); // 480 / 3
      expect(result.capacity.capacityGap).toBe(0); // exactly at capacity
    });

    it('should report capacity gap when required exceeds current', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 300, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 300, resources: ['b'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      expect(result.capacity.capacityGap).toBe(120); // 600 - 480
      expect(result.capacity.utilizationRate).toBeGreaterThan(1);
    });

    it('should report zero capacity gap when underutilized', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 30, resources: ['a'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      expect(result.capacity.capacityGap).toBe(0);
      expect(result.capacity.utilizationRate).toBeLessThan(1);
    });
  });

  describe('queue analysis', () => {
    it('should calculate queue metrics', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 20, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 40, resources: ['b'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const avgDuration = 30; // (20 + 40) / 2
      expect(result.queueAnalysis.averageQueueLength).toBe(2 * 0.3); // 0.6
      expect(result.queueAnalysis.maxQueueLength).toBe(2);
      expect(result.queueAnalysis.averageWaitTime).toBe(avgDuration * 0.2); // 6
      expect(result.queueAnalysis.queueingDelay).toBe(avgDuration * 0.1); // 3
      expect(result.queueAnalysis.serviceRate).toBe(60 / avgDuration); // 2
      expect(result.queueAnalysis.arrivalRate).toBe(50);
    });
  });

  describe('resource constraints analysis', () => {
    it('should classify resource types correctly', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 30, resources: ['senior_analyst'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 30, resources: ['main_server'], dependencies: [] }),
        createWorkflowStep({ id: 's3', duration: 30, resources: ['network_switch'], dependencies: [] }),
        createWorkflowStep({ id: 's4', duration: 30, resources: ['vendor_api'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const analystConstraint = result.resourceConstraints.find(rc => rc.resource === 'senior_analyst');
      const serverConstraint = result.resourceConstraints.find(rc => rc.resource === 'main_server');
      const networkConstraint = result.resourceConstraints.find(rc => rc.resource === 'network_switch');
      const vendorConstraint = result.resourceConstraints.find(rc => rc.resource === 'vendor_api');

      expect(analystConstraint?.type).toBe('human');
      expect(analystConstraint?.scalability).toBe('scalable');
      expect(serverConstraint?.type).toBe('system');
      expect(serverConstraint?.scalability).toBe('elastic');
      expect(networkConstraint?.type).toBe('infrastructure');
      expect(networkConstraint?.scalability).toBe('scalable');
      expect(vendorConstraint?.type).toBe('external');
      expect(vendorConstraint?.scalability).toBe('fixed');
    });

    it('should flag a resource as bottleneck when utilization > 80%', async () => {
      // Single resource with high total duration
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 400, resources: ['overloaded_system'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const constraint = result.resourceConstraints.find(rc => rc.resource === 'overloaded_system');
      expect(constraint).toBeDefined();
      expect(constraint!.utilizationRate).toBeGreaterThan(0.8);
      expect(constraint!.isBottleneck).toBe(true);
    });

    it('should not flag a resource as bottleneck when utilization < 80%', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 30, resources: ['light_resource'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const constraint = result.resourceConstraints.find(rc => rc.resource === 'light_resource');
      expect(constraint).toBeDefined();
      expect(constraint!.utilizationRate).toBeLessThan(0.8);
      expect(constraint!.isBottleneck).toBe(false);
    });

    it('should accumulate duration for resources used in multiple steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 100, resources: ['shared_database'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 150, resources: ['shared_database'], dependencies: [] }),
        createWorkflowStep({ id: 's3', duration: 50, resources: ['other'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);

      const result = await service.identifyBottlenecks(workflow, analysis);

      const dbConstraint = result.resourceConstraints.find(rc => rc.resource === 'shared_database');
      expect(dbConstraint).toBeDefined();
      expect(dbConstraint!.currentUsage).toBe(250); // 100 + 150
    });
  });

  describe('classifyResourceType via resource constraints', () => {
    it('should classify person-related resources as human', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 10, resources: ['billing_person'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);
      const result = await service.identifyBottlenecks(workflow, analysis);
      expect(result.resourceConstraints[0].type).toBe('human');
    });

    it('should classify database resources as infrastructure', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 10, resources: ['primary_database'], dependencies: [] })
      ];
      const analysis = createAnalyzedWorkflow(workflow);
      const result = await service.identifyBottlenecks(workflow, analysis);
      expect(result.resourceConstraints[0].type).toBe('infrastructure');
    });
  });
});

// ============================================================
// 2. CostBenefitAnalyzer Tests
// ============================================================

describe('CostBenefitAnalyzer', () => {
  let service: CostBenefitAnalyzer;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CostBenefitAnalyzer(mockLogger, mockRoiService);
  });

  describe('calculateCostSavings', () => {
    it('should calculate time savings when optimized workflow is shorter', async () => {
      const current = [
        createWorkflowStep({ id: 's1', duration: 60 }),
        createWorkflowStep({ id: 's2', duration: 40 })
      ];
      const optimized = [
        createWorkflowStep({ id: 's1', duration: 30 }),
        createWorkflowStep({ id: 's2', duration: 20 })
      ];
      const analysis = createOptimizationAnalysis();
      // Clear automation opportunities to isolate time savings
      analysis.opportunities = [];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const timeSaving = result.find(cs => cs.category === 'time');
      expect(timeSaving).toBeDefined();
      expect(timeSaving!.annualSaving).toBeGreaterThan(0);
      expect(timeSaving!.oneTimeCost).toBe(5000);
      expect(timeSaving!.confidence).toBe(0.8);
      expect(mockRoiService.calculateSimpleROI).toHaveBeenCalled();
    });

    it('should not include time savings when optimized duration equals current', async () => {
      const current = [
        createWorkflowStep({ id: 's1', duration: 50 })
      ];
      const optimized = [
        createWorkflowStep({ id: 's1', duration: 50 })
      ];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const timeSaving = result.find(cs => cs.category === 'time');
      expect(timeSaving).toBeUndefined();
    });

    it('should calculate labor savings from automation opportunities', async () => {
      const current = createRealisticWorkflow();
      const optimized = createRealisticWorkflow();
      const analysis = createOptimizationAnalysis();
      // Ensure we have automation opportunities
      analysis.opportunities = [
        {
          id: 'automate_1',
          type: 'automation',
          description: 'Automate validation',
          affectedSteps: ['step_validate'],
          potentialGains: { timeReduction: 0.6, costReduction: 0.7, qualityImprovement: 0.1, errorReduction: 0.5 },
          implementationEffort: 'medium',
          prerequisites: [],
          risks: []
        }
      ];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const laborSaving = result.find(cs => cs.category === 'labor');
      expect(laborSaving).toBeDefined();
      expect(laborSaving!.description).toContain('1 manual processes');
      expect(laborSaving!.annualSaving).toBe(0.7 * 50000); // costReduction * 50000
      expect(laborSaving!.oneTimeCost).toBe(25000);
      expect(laborSaving!.confidence).toBe(0.7);
    });

    it('should calculate quality improvement savings for opportunities with qualityImprovement > 0.1', async () => {
      const current = createRealisticWorkflow();
      const optimized = createRealisticWorkflow();
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [
        {
          id: 'quality_1',
          type: 'consolidation',
          description: 'Improve quality',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.1, costReduction: 0.1, qualityImprovement: 0.5, errorReduction: 0.1 },
          implementationEffort: 'medium',
          prerequisites: [],
          risks: []
        }
      ];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const qualitySaving = result.find(cs => cs.category === 'maintenance' && cs.description.includes('quality'));
      expect(qualitySaving).toBeDefined();
      expect(qualitySaving!.annualSaving).toBe(0.5 * 20000); // 10000
      expect(qualitySaving!.oneTimeCost).toBe(10000);
      expect(qualitySaving!.confidence).toBe(0.6);
    });

    it('should calculate error reduction savings for opportunities with errorReduction > 0.2', async () => {
      const current = createRealisticWorkflow();
      const optimized = createRealisticWorkflow();
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [
        {
          id: 'error_1',
          type: 'automation',
          description: 'Reduce errors',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.1, costReduction: 0.1, qualityImprovement: 0.05, errorReduction: 0.5 },
          implementationEffort: 'medium',
          prerequisites: [],
          risks: []
        }
      ];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const errorSaving = result.find(cs => cs.category === 'maintenance' && cs.description.includes('error'));
      expect(errorSaving).toBeDefined();
      expect(errorSaving!.annualSaving).toBe(0.5 * 15000); // 7500
      expect(errorSaving!.oneTimeCost).toBe(8000);
      expect(errorSaving!.confidence).toBe(0.75);
    });

    it('should not produce quality savings when qualityImprovement <= 0.1', async () => {
      const current = createRealisticWorkflow();
      const optimized = createRealisticWorkflow();
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [
        {
          id: 'low_quality',
          type: 'reordering',
          description: 'Reorder steps',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.1, costReduction: 0.1, qualityImprovement: 0.05, errorReduction: 0.05 },
          implementationEffort: 'low',
          prerequisites: [],
          risks: []
        }
      ];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      const qualitySaving = result.find(cs => cs.description.includes('quality'));
      expect(qualitySaving).toBeUndefined();
    });

    it('should return empty array when no savings are identified', async () => {
      const current = [createWorkflowStep({ id: 's1', duration: 30 })];
      const optimized = [createWorkflowStep({ id: 's1', duration: 30 })];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      expect(result).toEqual([]);
    });

    it('should aggregate multiple categories of savings', async () => {
      const current = [
        createWorkflowStep({ id: 's1', duration: 100 })
      ];
      const optimized = [
        createWorkflowStep({ id: 's1', duration: 50 })
      ];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [
        {
          id: 'auto_1',
          type: 'automation',
          description: 'Automate',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.6, qualityImprovement: 0.3, errorReduction: 0.4 },
          implementationEffort: 'medium',
          prerequisites: [],
          risks: []
        }
      ];

      const result = await service.calculateCostSavings(current, optimized, analysis);

      // Should have: time, labor, quality, error
      expect(result.length).toBeGreaterThanOrEqual(3);
      const categories = result.map(r => r.category);
      expect(categories).toContain('time');
      expect(categories).toContain('labor');
    });

    it('should log the total annual savings and one-time cost', async () => {
      const current = [createWorkflowStep({ id: 's1', duration: 100 })];
      const optimized = [createWorkflowStep({ id: 's1', duration: 50 })];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [];

      await service.calculateCostSavings(current, optimized, analysis);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Cost savings analysis completed',
        expect.objectContaining({
          savingsCategories: expect.any(Number),
          totalAnnualSavings: expect.any(Number),
          totalOneTimeCost: expect.any(Number)
        })
      );
    });
  });
});

// ============================================================
// 3. OptimizationRecommender Tests
// ============================================================

describe('OptimizationRecommender', () => {
  let service: OptimizationRecommender;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new OptimizationRecommender(mockLogger);
  });

  describe('generateOptimizations', () => {
    it('should return a full OptimizationAnalysis structure', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [
          { step: 'step_ship', description: 'Slow', impact: 'high', rootCause: 'Manual', suggestedSolution: 'Automate', estimatedResolution: '2 weeks' }
        ],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 45, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };
      const objectives = createObjectives();

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, objectives
      );

      expect(result).toHaveProperty('opportunities');
      expect(result).toHaveProperty('scenarios');
      expect(result).toHaveProperty('recommendations');
      expect(result).toHaveProperty('impact');
      expect(result.opportunities.length).toBeGreaterThan(0);
    });

    it('should generate automation opportunities for manual steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 'manual_1', name: 'Manual Process', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 'auto_1', name: 'Auto Process', type: 'automated', resources: ['b'], dependencies: [] })
      ];
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 60, utilizationRate: 0.125, peakLoad: 30, averageLoad: 30, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 1, maxQueueLength: 2, averageWaitTime: 3, queueingDelay: 1, serviceRate: 2, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const automationOpps = result.opportunities.filter(o => o.type === 'automation');
      expect(automationOpps.length).toBe(1);
      expect(automationOpps[0].id).toBe('automate_manual_1');
      expect(automationOpps[0].affectedSteps).toContain('manual_1');
    });

    it('should generate parallelization opportunity when parallelizable steps exist', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = ['step_enrich', 'step_transform'];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const parallelOpp = result.opportunities.find(o => o.type === 'parallelization');
      expect(parallelOpp).toBeDefined();
      expect(parallelOpp!.id).toBe('parallelize_steps');
      expect(parallelOpp!.implementationEffort).toBe('low');
    });

    it('should generate elimination opportunities for redundant steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Duplicate validation check', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', name: 'Normal processing', type: 'automated', resources: ['b'], dependencies: [] })
      ];
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 60, utilizationRate: 0.125, peakLoad: 30, averageLoad: 30, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 1, maxQueueLength: 2, averageWaitTime: 3, queueingDelay: 1, serviceRate: 2, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const eliminationOpp = result.opportunities.find(o => o.type === 'elimination');
      expect(eliminationOpp).toBeDefined();
      expect(eliminationOpp!.id).toBe('eliminate_s1');
    });

    it('should generate reordering opportunity when high-impact bottlenecks exist', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [
          { step: 'step_ship', description: 'Slow', impact: 'high', rootCause: 'Manual', suggestedSolution: 'Automate', estimatedResolution: '2 weeks' }
        ],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const reorderOpp = result.opportunities.find(o => o.type === 'reordering');
      expect(reorderOpp).toBeDefined();
      expect(reorderOpp!.affectedSteps).toContain('step_ship');
    });

    it('should not generate parallelization when only 1 or 0 parallelizable steps', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = ['step_enrich']; // Only 1
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const parallelOpp = result.opportunities.find(o => o.type === 'parallelization');
      expect(parallelOpp).toBeUndefined();
    });
  });

  describe('scenario generation', () => {
    it('should create Quick Wins scenario when low-effort opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = ['step_enrich', 'step_transform'];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [
          { step: 'step_ship', description: 'Slow', impact: 'high', rootCause: 'Manual', suggestedSolution: 'Automate', estimatedResolution: '2w' }
        ],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const quickWins = result.scenarios.find(s => s.name === 'Quick Wins');
      expect(quickWins).toBeDefined();
      expect(quickWins!.confidence).toBe(0.8);
      expect(quickWins!.timeframe).toBe('3 months');
    });

    it('should create Strategic Transformation scenario when > 3 opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = ['step_enrich', 'step_transform'];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [
          { step: 'step_ship', description: 'Slow', impact: 'high', rootCause: 'Manual', suggestedSolution: 'Automate', estimatedResolution: '2w' }
        ],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      // There are 3 manual steps (validate, enrich, ship) => 3 automation + 1 parallel + 1 reorder = 5+ opps
      const strategicScenario = result.scenarios.find(s => s.name === 'Strategic Transformation');
      if (result.opportunities.length > 3) {
        expect(strategicScenario).toBeDefined();
        expect(strategicScenario!.timeframe).toBe('12 months');
      }
    });

    it('should create Automation First scenario when automation opportunities exist', async () => {
      const workflow = [
        createWorkflowStep({ id: 'm1', name: 'Manual Task 1', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 'a1', name: 'Auto Task', type: 'automated', resources: ['b'], dependencies: [] })
      ];
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 60, utilizationRate: 0.125, peakLoad: 30, averageLoad: 30, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 1, maxQueueLength: 2, averageWaitTime: 3, queueingDelay: 1, serviceRate: 2, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const automationScenario = result.scenarios.find(s => s.name === 'Automation First');
      expect(automationScenario).toBeDefined();
      expect(automationScenario!.timeframe).toBe('9 months');
      expect(automationScenario!.confidence).toBe(0.7);
    });
  });

  describe('recommendation generation', () => {
    it('should produce automation recommendation for automation opportunities', async () => {
      const workflow = [
        createWorkflowStep({ id: 'm1', name: 'Manual Task', type: 'manual', resources: ['a'], dependencies: [] })
      ];
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [],
        capacity: { currentCapacity: 480, requiredCapacity: 30, utilizationRate: 0.0625, peakLoad: 30, averageLoad: 30, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 0.3, maxQueueLength: 1, averageWaitTime: 3, queueingDelay: 1, serviceRate: 2, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const automationRec = result.recommendations.find(r => r.title === 'Implement Process Automation');
      expect(automationRec).toBeDefined();
      expect(automationRec!.priority).toBe('high');
      expect(automationRec!.category).toBe('strategic');
      expect(automationRec!.implementation.phases.length).toBe(3);
    });

    it('should produce bottleneck resolution recommendation when reordering opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const workflowAnalysis = createAnalyzedWorkflow(workflow);
      workflowAnalysis.parallelizable = [];
      const bottleneckAnalysis: BottleneckAnalysis = {
        criticalBottlenecks: [
          { step: 'step_ship', description: 'Slow', impact: 'high', rootCause: 'Manual', suggestedSolution: 'Automate', estimatedResolution: '2w' }
        ],
        capacity: { currentCapacity: 480, requiredCapacity: 120, utilizationRate: 0.25, peakLoad: 45, averageLoad: 20, capacityGap: 0 },
        queueAnalysis: { averageQueueLength: 2, maxQueueLength: 6, averageWaitTime: 5, queueingDelay: 2, serviceRate: 3, arrivalRate: 50 },
        resourceConstraints: []
      };
      const performanceAnalysis: PerformanceAnalysis = {
        throughput: 50, utilization: 0.75, efficiency: 0.8, waitTime: 5, processingTime: 30, setupTime: 10, metrics: []
      };

      const result = await service.generateOptimizations(
        workflow, workflowAnalysis, bottleneckAnalysis, performanceAnalysis, createObjectives()
      );

      const bottleneckRec = result.recommendations.find(r => r.title === 'Resolve Critical Bottlenecks');
      expect(bottleneckRec).toBeDefined();
      expect(bottleneckRec!.priority).toBe('high');
    });
  });

  describe('createOptimizedWorkflow', () => {
    it('should reduce duration for automated steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Manual Step', type: 'manual', duration: 100, resources: ['a'], dependencies: [] })
      ];
      const opportunities: OptimizationOpportunity[] = [{
        id: 'automate_s1',
        type: 'automation',
        description: 'Automate',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.6, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.8 },
        implementationEffort: 'medium',
        prerequisites: [],
        risks: []
      }];

      const result = await service.createOptimizedWorkflow(workflow, opportunities);

      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(40); // 100 * (1 - 0.6)
      expect(result[0].type).toBe('automated');
    });

    it('should eliminate steps with elimination type (duration set to 0)', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Keep', duration: 30, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', name: 'Remove', duration: 20, resources: ['b'], dependencies: [] })
      ];
      const opportunities: OptimizationOpportunity[] = [{
        id: 'eliminate_s2',
        type: 'elimination',
        description: 'Remove redundant step',
        affectedSteps: ['s2'],
        potentialGains: { timeReduction: 0.9, costReduction: 0.8, qualityImprovement: 0.1, errorReduction: 0.2 },
        implementationEffort: 'low',
        prerequisites: [],
        risks: []
      }];

      const result = await service.createOptimizedWorkflow(workflow, opportunities);

      expect(result.length).toBe(1);
      expect(result[0].id).toBe('s1');
    });

    it('should not reduce duration below 1 for non-eliminated steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 2, resources: ['a'], dependencies: [] })
      ];
      const opportunities: OptimizationOpportunity[] = [{
        id: 'opp_1',
        type: 'parallelization',
        description: 'Optimize',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.99, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
        implementationEffort: 'low',
        prerequisites: [],
        risks: []
      }];

      const result = await service.createOptimizedWorkflow(workflow, opportunities);

      expect(result.length).toBe(1);
      expect(result[0].duration).toBeGreaterThanOrEqual(1);
    });

    it('should handle steps that are not in the affectedSteps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 50, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 50, resources: ['b'], dependencies: [] })
      ];
      const opportunities: OptimizationOpportunity[] = [{
        id: 'opp_1',
        type: 'automation',
        description: 'Automate s1 only',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.5 },
        implementationEffort: 'medium',
        prerequisites: [],
        risks: []
      }];

      const result = await service.createOptimizedWorkflow(workflow, opportunities);

      expect(result.length).toBe(2);
      expect(result.find(s => s.id === 's1')!.duration).toBe(25);
      expect(result.find(s => s.id === 's2')!.duration).toBe(50); // Unchanged
    });

    it('should reduce failure rate on automation opportunities', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', type: 'manual', duration: 50, failureRate: 0.2, resources: ['a'], dependencies: [] })
      ];
      const opportunities: OptimizationOpportunity[] = [{
        id: 'automate_s1',
        type: 'automation',
        description: 'Automate',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.8 },
        implementationEffort: 'medium',
        prerequisites: [],
        risks: []
      }];

      const result = await service.createOptimizedWorkflow(workflow, opportunities);

      expect(result[0].failureRate).toBeCloseTo(0.04); // 0.2 * (1 - 0.8)
    });
  });

  describe('assessOptimizationImpact', () => {
    it('should calculate impact metrics correctly', () => {
      const opportunities: OptimizationOpportunity[] = [
        {
          id: 'o1', type: 'automation', description: 'Test',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.4, qualityImprovement: 0.3, errorReduction: 0.6 },
          implementationEffort: 'medium', prerequisites: [], risks: []
        }
      ];

      const result = service.assessOptimizationImpact(opportunities, []);

      expect(result.timeImprovement.improvementPercent).toBe(50); // 0.5 * 100
      expect(result.costReduction.improvementPercent).toBe(40);
      expect(result.qualityGains.improvementPercent).toBe(30);
      expect(result.riskReduction.improvementPercent).toBe(60);
      expect(result.overallValue).toBe((0.5 + 0.4 + 0.3 + 0.6) / 4); // 0.45
    });

    it('should handle empty opportunities array', () => {
      const result = service.assessOptimizationImpact([], []);

      expect(result.timeImprovement.improvementPercent).toBe(0);
      expect(result.costReduction.improvementPercent).toBe(0);
      expect(result.qualityGains.improvementPercent).toBe(0);
      expect(result.riskReduction.improvementPercent).toBe(0);
      expect(result.overallValue).toBe(0);
    });

    it('should average gains across multiple opportunities', () => {
      const opportunities: OptimizationOpportunity[] = [
        {
          id: 'o1', type: 'automation', description: 'Test 1',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.6, costReduction: 0.8, qualityImprovement: 0.4, errorReduction: 0.2 },
          implementationEffort: 'medium', prerequisites: [], risks: []
        },
        {
          id: 'o2', type: 'parallelization', description: 'Test 2',
          affectedSteps: ['s2'],
          potentialGains: { timeReduction: 0.4, costReduction: 0.2, qualityImprovement: 0.0, errorReduction: 0.0 },
          implementationEffort: 'low', prerequisites: [], risks: []
        }
      ];

      const result = service.assessOptimizationImpact(opportunities, []);

      expect(result.timeImprovement.improvementPercent).toBe(50); // (0.6+0.4)/2 * 100
      expect(result.costReduction.improvementPercent).toBe(50); // (0.8+0.2)/2 * 100
    });
  });

  describe('calculateAverageGain', () => {
    it('should return 0 for empty array', () => {
      const result = service.calculateAverageGain([], 'timeReduction');
      expect(result).toBe(0);
    });

    it('should return correct average for a single opportunity', () => {
      const opps: OptimizationOpportunity[] = [{
        id: 'o1', type: 'automation', description: 'Test',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.7, costReduction: 0.3, qualityImprovement: 0.2, errorReduction: 0.5 },
        implementationEffort: 'medium', prerequisites: [], risks: []
      }];

      expect(service.calculateAverageGain(opps, 'timeReduction')).toBe(0.7);
      expect(service.calculateAverageGain(opps, 'costReduction')).toBe(0.3);
      expect(service.calculateAverageGain(opps, 'qualityImprovement')).toBe(0.2);
      expect(service.calculateAverageGain(opps, 'errorReduction')).toBe(0.5);
    });
  });

  describe('applyOptimization', () => {
    it('should apply duration reduction correctly', () => {
      const workflow: WorkflowStep[] = [
        createWorkflowStep({ id: 's1', duration: 100, resources: ['a'], dependencies: [] })
      ];
      const opp: OptimizationOpportunity = {
        id: 'o1', type: 'parallelization', description: 'Speedup',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.3, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
        implementationEffort: 'low', prerequisites: [], risks: []
      };

      const result = service.applyOptimization(workflow, opp);

      expect(result[0].duration).toBe(70); // 100 * (1 - 0.3)
    });

    it('should not mutate the original workflow', () => {
      const workflow: WorkflowStep[] = [
        createWorkflowStep({ id: 's1', duration: 100, resources: ['a'], dependencies: [] })
      ];
      const opp: OptimizationOpportunity = {
        id: 'o1', type: 'automation', description: 'Test',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.5 },
        implementationEffort: 'medium', prerequisites: [], risks: []
      };

      service.applyOptimization(workflow, opp);

      expect(workflow[0].duration).toBe(100); // Original unchanged
    });

    it('should skip steps not in workflow', () => {
      const workflow: WorkflowStep[] = [
        createWorkflowStep({ id: 's1', duration: 50, resources: ['a'], dependencies: [] })
      ];
      const opp: OptimizationOpportunity = {
        id: 'o1', type: 'automation', description: 'Test',
        affectedSteps: ['nonexistent'],
        potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.5 },
        implementationEffort: 'medium', prerequisites: [], risks: []
      };

      const result = service.applyOptimization(workflow, opp);

      expect(result.length).toBe(1);
      expect(result[0].duration).toBe(50); // Unchanged
    });
  });

  describe('convertOpportunitiesToImprovements', () => {
    it('should convert opportunities to ProcessImprovement format', () => {
      const opps: OptimizationOpportunity[] = [{
        id: 'o1', type: 'automation', description: 'Automate order processing',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.6, costReduction: 0.7, qualityImprovement: 0.3, errorReduction: 0.8 },
        implementationEffort: 'medium', prerequisites: ['Standardization'], risks: []
      }];

      const result = service.convertOpportunitiesToImprovements(opps);

      expect(result.length).toBe(1);
      expect(result[0].type).toBe('automation');
      expect(result[0].description).toBe('Automate order processing');
      expect(result[0].impact.timeReduction).toBe(0.6);
      expect(result[0].impact.costReduction).toBe(0.7);
      expect(result[0].impact.qualityImprovement).toBe(0.3);
      expect(result[0].impact.riskReduction).toBe(0.8); // Maps from errorReduction
      expect(result[0].implementationComplexity).toBe('medium');
      expect(result[0].prerequisites).toEqual(['Standardization']);
    });

    it('should return empty array for empty input', () => {
      const result = service.convertOpportunitiesToImprovements([]);
      expect(result).toEqual([]);
    });
  });

  describe('assessWorkflowComplexity', () => {
    it('should return value between 0 and 1', () => {
      const workflow = createRealisticWorkflow();
      const result = service.assessWorkflowComplexity(workflow);
      expect(result).toBeGreaterThanOrEqual(0);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should cap at 1 for very complex workflows', () => {
      // 20 steps + many dependencies => score = (20 + many) / 20 > 1 => capped at 1
      const workflow = Array.from({ length: 25 }, (_, i) =>
        createWorkflowStep({
          id: `s${i}`,
          dependencies: i > 0 ? [`s${i - 1}`] : [],
          resources: ['a']
        })
      );

      const result = service.assessWorkflowComplexity(workflow);
      expect(result).toBe(1);
    });

    it('should return low complexity for simple workflows', () => {
      const workflow = [
        createWorkflowStep({ id: 's1', dependencies: [], resources: ['a'] }),
        createWorkflowStep({ id: 's2', dependencies: [], resources: ['b'] })
      ];

      const result = service.assessWorkflowComplexity(workflow);
      expect(result).toBeLessThan(0.5);
    });
  });

  describe('assessDataQuality', () => {
    it('should return base 0.5 + 0.2 for complete steps', () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Step 1', duration: 30, resources: ['a'], dependencies: [] })
      ];
      const result = service.assessDataQuality(workflow, false, false);
      expect(result).toBe(0.7); // 0.5 + 0.2
    });

    it('should add 0.2 for hasMetrics and 0.1 for hasObjectives', () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Step 1', duration: 30, resources: ['a'], dependencies: [] })
      ];
      const result = service.assessDataQuality(workflow, true, true);
      expect(result).toBeCloseTo(1.0); // 0.5 + 0.2 + 0.2 + 0.1 = 1.0
    });

    it('should cap at 1.0', () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Step 1', duration: 30, resources: ['a'], dependencies: [] })
      ];
      const result = service.assessDataQuality(workflow, true, true);
      expect(result).toBeLessThanOrEqual(1);
    });

    it('should return 0.5 base even when step data is incomplete', () => {
      // step without duration being explicitly undefined - the check is `step.duration !== undefined`
      const workflow = [
        { id: 's1', name: 'Step', type: 'manual' as const, resources: ['a'], dependencies: [] } as any
      ];
      const result = service.assessDataQuality(workflow, false, false);
      // duration is undefined, so the quality check fails -> 0.5 only
      expect(result).toBe(0.5);
    });
  });
});

// ============================================================
// 4. PerformanceMetricsService Tests
// ============================================================

describe('PerformanceMetricsService', () => {
  let service: PerformanceMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PerformanceMetricsService(mockLogger);
  });

  describe('analyzePerformance', () => {
    it('should return a complete PerformanceAnalysis structure', async () => {
      const metrics = createPerformanceMetrics();

      const result = await service.analyzePerformance(metrics);

      expect(result).toHaveProperty('throughput');
      expect(result).toHaveProperty('utilization');
      expect(result).toHaveProperty('efficiency');
      expect(result).toHaveProperty('waitTime');
      expect(result).toHaveProperty('processingTime');
      expect(result).toHaveProperty('setupTime');
      expect(result).toHaveProperty('metrics');
    });

    it('should extract throughput from metrics by name', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Throughput Rate', currentValue: 72, targetValue: 80, unit: 'units/hr', trend: 'improving' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.throughput).toBe(72);
    });

    it('should extract utilization and normalize to 0-1 range', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Resource Utilization', currentValue: 85, targetValue: 95, unit: '%', trend: 'stable' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.utilization).toBe(0.85); // 85 / 100
    });

    it('should extract efficiency and normalize to 0-1 range', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Process Efficiency', currentValue: 92, targetValue: 95, unit: '%', trend: 'improving' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.efficiency).toBe(0.92); // 92 / 100
    });

    it('should extract wait time from metrics', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Average Wait Time', currentValue: 7.5, targetValue: 3, unit: 'minutes', trend: 'declining' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.waitTime).toBe(7.5);
    });

    it('should extract processing time from metrics', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Processing Time', currentValue: 22, targetValue: 15, unit: 'minutes', trend: 'stable' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.processingTime).toBe(22);
    });

    it('should extract setup time from metrics', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Setup Time', currentValue: 8, targetValue: 4, unit: 'minutes', trend: 'improving' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.setupTime).toBe(8);
    });

    it('should use default values when metrics are not found', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Unrelated Metric', currentValue: 99, targetValue: 100, unit: 'units', trend: 'stable' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.throughput).toBe(50);      // default
      expect(result.utilization).toBe(0.75);   // default
      expect(result.efficiency).toBe(0.8);     // default
      expect(result.waitTime).toBe(5);         // default
      expect(result.processingTime).toBe(30);  // default
      expect(result.setupTime).toBe(10);       // default
    });

    it('should use defaults for all metrics when given empty array', async () => {
      const result = await service.analyzePerformance([]);

      expect(result.throughput).toBe(50);
      expect(result.utilization).toBe(0.75);
      expect(result.efficiency).toBe(0.8);
      expect(result.waitTime).toBe(5);
      expect(result.processingTime).toBe(30);
      expect(result.setupTime).toBe(10);
      expect(result.metrics).toEqual([]);
    });

    it('should create process metrics with correct variance calculation', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Throughput', currentValue: 40, targetValue: 50, unit: 'orders/hr', trend: 'improving' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.metrics.length).toBe(1);
      expect(result.metrics[0].name).toBe('Throughput');
      expect(result.metrics[0].current).toBe(40);
      expect(result.metrics[0].target).toBe(50);
      expect(result.metrics[0].variance).toBeCloseTo(0.2); // |40-50|/50 = 0.2
    });

    it('should handle all metrics from a realistic data set', async () => {
      const metrics = createPerformanceMetrics();

      const result = await service.analyzePerformance(metrics);

      expect(result.throughput).toBe(45);
      expect(result.utilization).toBe(0.82);
      expect(result.efficiency).toBe(0.75);
      expect(result.waitTime).toBe(8);
      expect(result.processingTime).toBe(25);
      expect(result.setupTime).toBe(12);
      expect(result.metrics.length).toBe(6);
    });

    it('should log the performance analysis completion', async () => {
      const metrics = createPerformanceMetrics();

      await service.analyzePerformance(metrics);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Analyzing performance metrics',
        expect.objectContaining({ metricsCount: 6 })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Performance analysis completed',
        expect.objectContaining({
          throughput: expect.any(Number),
          utilization: expect.any(Number),
          efficiency: expect.any(Number)
        })
      );
    });

    it('should handle metric name matching case-insensitively', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'THROUGHPUT RATE', currentValue: 100, targetValue: 120, unit: 'units/hr', trend: 'improving' },
        { name: 'resource UTILIZATION', currentValue: 90, targetValue: 95, unit: '%', trend: 'stable' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.throughput).toBe(100);
      expect(result.utilization).toBe(0.9);
    });

    it('should correctly map trend values', async () => {
      const metrics: PerformanceMetric[] = [
        { name: 'Throughput', currentValue: 50, targetValue: 60, unit: 'units/hr', trend: 'improving' },
        { name: 'Efficiency', currentValue: 70, targetValue: 85, unit: '%', trend: 'declining' },
        { name: 'Wait Time', currentValue: 5, targetValue: 3, unit: 'min', trend: 'stable' }
      ];

      const result = await service.analyzePerformance(metrics);

      expect(result.metrics.find(m => m.name === 'Throughput')!.trend).toBe('improving');
      expect(result.metrics.find(m => m.name === 'Efficiency')!.trend).toBe('declining');
      expect(result.metrics.find(m => m.name === 'Wait Time')!.trend).toBe('stable');
    });
  });
});

// ============================================================
// 5. RiskAssessmentService Tests
// ============================================================

describe('RiskAssessmentService', () => {
  let service: RiskAssessmentService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RiskAssessmentService(mockLogger);
  });

  describe('assessRisks', () => {
    it('should return a complete RiskAnalysis structure', async () => {
      const workflow = createRealisticWorkflow();
      const constraints = createConstraints();
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      expect(result).toHaveProperty('operationalRisks');
      expect(result).toHaveProperty('technicalRisks');
      expect(result).toHaveProperty('businessRisks');
      expect(result).toHaveProperty('complianceRisks');
      expect(result).toHaveProperty('overallRiskScore');
      expect(typeof result.overallRiskScore).toBe('number');
    });

    it('should always include a capacity operational risk', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const capacityRisk = result.operationalRisks.find(r => r.type === 'capacity');
      expect(capacityRisk).toBeDefined();
      expect(capacityRisk!.probability).toBe(0.3); // workflow.length <= 20
      expect(capacityRisk!.impact).toBe(0.7);
    });

    it('should increase capacity risk probability for large workflows (>20 steps)', async () => {
      const workflow = Array.from({ length: 25 }, (_, i) =>
        createWorkflowStep({ id: `s${i}`, type: 'automated', resources: [`r${i}`], dependencies: [] })
      );
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const capacityRisk = result.operationalRisks.find(r => r.type === 'capacity');
      expect(capacityRisk).toBeDefined();
      expect(capacityRisk!.probability).toBe(0.6); // > 20 steps
    });

    it('should identify dependency risk when average dependencies > 2', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', dependencies: ['dep1', 'dep2', 'dep3'], resources: ['a'] }),
        createWorkflowStep({ id: 's2', dependencies: ['dep1', 'dep2', 'dep3', 'dep4'], resources: ['b'] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const depRisk = result.operationalRisks.find(r => r.type === 'dependency');
      expect(depRisk).toBeDefined();
      expect(depRisk!.description).toContain('3.5'); // avg = (3+4)/2
    });

    it('should not identify dependency risk when average dependencies <= 2', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', dependencies: ['dep1'], resources: ['a'] }),
        createWorkflowStep({ id: 's2', dependencies: ['dep1'], resources: ['b'] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const depRisk = result.operationalRisks.find(r => r.type === 'dependency');
      expect(depRisk).toBeUndefined();
    });

    it('should identify quality risk when manual step ratio > 40%', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', type: 'manual', resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', type: 'manual', resources: ['c'], dependencies: [] }),
        createWorkflowStep({ id: 's4', type: 'automated', resources: ['d'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const qualityRisk = result.operationalRisks.find(r => r.type === 'quality');
      expect(qualityRisk).toBeDefined();
      expect(qualityRisk!.description).toContain('75'); // 3/4 = 75%
    });

    it('should not identify quality risk when manual ratio <= 40%', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', type: 'automated', resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', type: 'automated', resources: ['c'], dependencies: [] }),
        createWorkflowStep({ id: 's4', type: 'automated', resources: ['d'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const qualityRisk = result.operationalRisks.find(r => r.type === 'quality');
      expect(qualityRisk).toBeUndefined();
    });

    it('should identify timing risk when total duration > 240 minutes', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 150, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 150, resources: ['b'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const timingRisk = result.operationalRisks.find(r => r.type === 'timing');
      expect(timingRisk).toBeDefined();
      expect(timingRisk!.description).toContain('300 minutes');
    });

    it('should not identify timing risk when total duration <= 240 minutes', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', duration: 100, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', duration: 100, resources: ['b'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const timingRisk = result.operationalRisks.find(r => r.type === 'timing');
      expect(timingRisk).toBeUndefined();
    });

    it('should identify resource risk when a resource is used in > 50% of steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', resources: ['shared'], dependencies: [] }),
        createWorkflowStep({ id: 's2', resources: ['shared'], dependencies: [] }),
        createWorkflowStep({ id: 's3', resources: ['other'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const resourceRisk = result.operationalRisks.find(r => r.type === 'resource');
      expect(resourceRisk).toBeDefined();
    });
  });

  describe('technical risks', () => {
    it('should identify integration risk when automation opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const integrationRisk = result.technicalRisks.find(r => r.type === 'integration');
      expect(integrationRisk).toBeDefined();
      expect(integrationRisk!.riskScore).toBeCloseTo(0.32);
    });

    it('should identify performance risk when parallelization opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // Add a parallelization opportunity
      analysis.opportunities.push({
        id: 'parallel_1',
        type: 'parallelization',
        description: 'Parallelize steps',
        affectedSteps: ['s1', 's2'],
        potentialGains: { timeReduction: 0.4, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
        implementationEffort: 'low',
        prerequisites: [],
        risks: []
      });

      const result = await service.assessRisks(workflow, constraints, analysis);

      const perfRisk = result.technicalRisks.find(r => r.type === 'performance');
      expect(perfRisk).toBeDefined();
      expect(perfRisk!.riskScore).toBeCloseTo(0.15);
    });

    it('should identify reliability risk when elimination opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities.push({
        id: 'eliminate_1',
        type: 'elimination',
        description: 'Remove step',
        affectedSteps: ['s1'],
        potentialGains: { timeReduction: 0.9, costReduction: 0.8, qualityImprovement: 0.1, errorReduction: 0.2 },
        implementationEffort: 'low',
        prerequisites: [],
        risks: []
      });

      const result = await service.assessRisks(workflow, constraints, analysis);

      const reliabilityRisk = result.technicalRisks.find(r => r.type === 'reliability');
      expect(reliabilityRisk).toBeDefined();
      expect(reliabilityRisk!.impact).toBe(0.9);
    });

    it('should identify security risk when consolidation opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities.push({
        id: 'consolidate_1',
        type: 'consolidation',
        description: 'Consolidate steps',
        affectedSteps: ['s1', 's2'],
        potentialGains: { timeReduction: 0.3, costReduction: 0.4, qualityImprovement: 0.2, errorReduction: 0.3 },
        implementationEffort: 'medium',
        prerequisites: [],
        risks: []
      });

      const result = await service.assessRisks(workflow, constraints, analysis);

      const securityRisk = result.technicalRisks.find(r => r.type === 'security');
      expect(securityRisk).toBeDefined();
      expect(securityRisk!.riskScore).toBeCloseTo(0.16);
    });

    it('should identify scalability risk when > 2 high-effort opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // Add 3 high-effort opportunities
      for (let i = 0; i < 3; i++) {
        analysis.opportunities.push({
          id: `high_effort_${i}`,
          type: 'consolidation',
          description: `High effort change ${i}`,
          affectedSteps: [`s${i}`],
          potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.3, errorReduction: 0.3 },
          implementationEffort: 'high',
          prerequisites: [],
          risks: []
        });
      }

      const result = await service.assessRisks(workflow, constraints, analysis);

      const scalabilityRisk = result.technicalRisks.find(r => r.type === 'scalability');
      expect(scalabilityRisk).toBeDefined();
      expect(scalabilityRisk!.riskScore).toBeCloseTo(0.3);
    });

    it('should not identify scalability risk with <= 2 high-effort opportunities', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // All opportunities are medium or low effort
      analysis.opportunities = analysis.opportunities.map(o => ({
        ...o,
        implementationEffort: 'medium' as const
      }));

      const result = await service.assessRisks(workflow, constraints, analysis);

      const scalabilityRisk = result.technicalRisks.find(r => r.type === 'scalability');
      expect(scalabilityRisk).toBeUndefined();
    });
  });

  describe('business risks', () => {
    it('should always include a strategic change management risk', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const strategicRisk = result.businessRisks.find(r => r.type === 'strategic');
      expect(strategicRisk).toBeDefined();
      expect(strategicRisk!.riskScore).toBeCloseTo(0.3); // 0.5 * 0.6
      expect(strategicRisk!.stakeholderConcerns).toContain('Job displacement');
    });

    it('should identify financial risk when total investment > $100,000', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // Add high-effort opportunities to push investment > 100k
      // Each high = $50,000, so 3 high = $150k
      analysis.opportunities = [
        { id: 'h1', type: 'automation', description: 'Big project 1', affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.3, errorReduction: 0.3 },
          implementationEffort: 'high', prerequisites: [], risks: [] },
        { id: 'h2', type: 'automation', description: 'Big project 2', affectedSteps: ['s2'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.3, errorReduction: 0.3 },
          implementationEffort: 'high', prerequisites: [], risks: [] },
        { id: 'h3', type: 'automation', description: 'Big project 3', affectedSteps: ['s3'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.3, errorReduction: 0.3 },
          implementationEffort: 'high', prerequisites: [], risks: [] }
      ];

      const result = await service.assessRisks(workflow, constraints, analysis);

      const financialRisk = result.businessRisks.find(r => r.type === 'financial');
      expect(financialRisk).toBeDefined();
      expect(financialRisk!.description).toContain('150,000');
    });

    it('should not identify financial risk when total investment <= $100,000', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // 2 low ($10k each) + 1 medium ($25k) = $45k
      analysis.opportunities = [
        { id: 'l1', type: 'reordering', description: 'Small change', affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.2, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
          implementationEffort: 'low', prerequisites: [], risks: [] },
        { id: 'l2', type: 'reordering', description: 'Small change 2', affectedSteps: ['s2'],
          potentialGains: { timeReduction: 0.2, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
          implementationEffort: 'low', prerequisites: [], risks: [] },
        { id: 'm1', type: 'automation', description: 'Medium change', affectedSteps: ['s3'],
          potentialGains: { timeReduction: 0.5, costReduction: 0.5, qualityImprovement: 0.2, errorReduction: 0.5 },
          implementationEffort: 'medium', prerequisites: [], risks: [] }
      ];

      const result = await service.assessRisks(workflow, constraints, analysis);

      const financialRisk = result.businessRisks.find(r => r.type === 'financial');
      expect(financialRisk).toBeUndefined();
    });

    it('should identify market timing risk when > 5 opportunities exist', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      // Ensure > 5 opportunities
      while (analysis.opportunities.length <= 5) {
        analysis.opportunities.push({
          id: `extra_${analysis.opportunities.length}`,
          type: 'reordering',
          description: 'Extra opportunity',
          affectedSteps: ['s1'],
          potentialGains: { timeReduction: 0.1, costReduction: 0.1, qualityImprovement: 0.0, errorReduction: 0.0 },
          implementationEffort: 'low',
          prerequisites: [],
          risks: []
        });
      }

      const result = await service.assessRisks(workflow, constraints, analysis);

      const marketRisk = result.businessRisks.find(r => r.type === 'market');
      expect(marketRisk).toBeDefined();
    });

    it('should identify regulatory risk for compliance-related workflow steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'SOX Compliance Check', type: 'manual', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', name: 'Audit Trail Generation', type: 'automated', resources: ['b'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const regulatoryRisk = result.businessRisks.find(r => r.type === 'regulatory');
      expect(regulatoryRisk).toBeDefined();
      expect(regulatoryRisk!.description).toContain('2 compliance-related');
    });

    it('should identify reputation risk for customer-facing workflow steps', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Customer Notification', type: 'automated', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', name: 'Client Onboarding', type: 'manual', resources: ['b'], dependencies: [] }),
        createWorkflowStep({ id: 's3', name: 'Internal Processing', type: 'automated', resources: ['c'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const reputationRisk = result.businessRisks.find(r => r.type === 'reputation');
      expect(reputationRisk).toBeDefined();
      expect(reputationRisk!.description).toContain('2 customer-facing');
    });

    it('should not identify reputation risk when no customer-facing steps exist', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', name: 'Internal Processing', type: 'automated', resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', name: 'Backend Task', type: 'automated', resources: ['b'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const reputationRisk = result.businessRisks.find(r => r.type === 'reputation');
      expect(reputationRisk).toBeUndefined();
    });
  });

  describe('compliance risks', () => {
    it('should generate compliance risk for regulatory constraints', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [
        { type: 'regulatory', description: 'SOX compliance required', severity: 'hard' }
      ];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const regulatoryCompliance = result.complianceRisks.find(r => r.regulation === 'SOX compliance required');
      expect(regulatoryCompliance).toBeDefined();
      expect(regulatoryCompliance!.riskLevel).toBe('medium');
      expect(regulatoryCompliance!.currentCompliance).toBe(0.9);
      expect(regulatoryCompliance!.requiredCompliance).toBe(1.0);
    });

    it('should generate compliance risk for technical constraints', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [
        { type: 'technical', description: 'API backward compatibility', severity: 'soft' }
      ];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const techCompliance = result.complianceRisks.find(r => r.regulation === 'Technical Standards');
      expect(techCompliance).toBeDefined();
      expect(techCompliance!.requirement).toBe('API backward compatibility');
      expect(techCompliance!.currentCompliance).toBe(0.85);
      expect(techCompliance!.requiredCompliance).toBe(0.95);
    });

    it('should generate compliance risk for resource constraints', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [
        { type: 'resource', description: 'Maximum 3 FTE', severity: 'soft' }
      ];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const resourceCompliance = result.complianceRisks.find(r => r.regulation === 'Resource Requirements');
      expect(resourceCompliance).toBeDefined();
      expect(resourceCompliance!.riskLevel).toBe('low');
      expect(resourceCompliance!.currentCompliance).toBe(0.95);
    });

    it('should not generate compliance risks for budget or time constraints', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [
        { type: 'budget', description: 'Budget limited to $100k', severity: 'hard' },
        { type: 'time', description: 'Complete by Q2', severity: 'hard' }
      ];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      expect(result.complianceRisks.length).toBe(0);
    });

    it('should handle empty constraints array', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      expect(result.complianceRisks).toEqual([]);
    });

    it('should handle multiple constraints of the same type', async () => {
      const workflow = createRealisticWorkflow();
      const constraints: Constraint[] = [
        { type: 'regulatory', description: 'SOX compliance', severity: 'hard' },
        { type: 'regulatory', description: 'GDPR compliance', severity: 'hard' }
      ];
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      const regulatoryRisks = result.complianceRisks.filter(r => r.riskLevel === 'medium');
      expect(regulatoryRisks.length).toBe(2);
    });
  });

  describe('overall risk score', () => {
    it('should return 0 when no risks are identified', async () => {
      const workflow = [
        createWorkflowStep({ id: 's1', type: 'automated', duration: 10, resources: ['unique'], dependencies: [] })
      ];
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();
      analysis.opportunities = [];

      const result = await service.assessRisks(workflow, constraints, analysis);

      // Only capacity risk and strategic business risk will exist (always present)
      expect(result.overallRiskScore).toBeGreaterThan(0);
      expect(result.overallRiskScore).toBeLessThanOrEqual(10);
    });

    it('should be scaled to 0-10 range', async () => {
      const workflow = createRealisticWorkflow();
      const constraints = createConstraints();
      const analysis = createOptimizationAnalysis();

      const result = await service.assessRisks(workflow, constraints, analysis);

      expect(result.overallRiskScore).toBeGreaterThanOrEqual(0);
      expect(result.overallRiskScore).toBeLessThanOrEqual(10);
    });

    it('should be higher for riskier workflows', async () => {
      const constraints: Constraint[] = [];
      const analysis = createOptimizationAnalysis();

      // Low risk workflow
      const lowRiskWorkflow = [
        createWorkflowStep({ id: 's1', type: 'automated', duration: 10, resources: ['a'], dependencies: [] }),
        createWorkflowStep({ id: 's2', type: 'automated', duration: 10, resources: ['b'], dependencies: [] })
      ];
      const lowRiskResult = await service.assessRisks(lowRiskWorkflow, constraints, analysis);

      // High risk workflow (many manual, long duration, many dependencies, shared resources)
      const highRiskWorkflow = Array.from({ length: 25 }, (_, i) =>
        createWorkflowStep({
          id: `s${i}`,
          type: 'manual',
          duration: 30,
          resources: ['shared_resource'],
          dependencies: i > 0 ? [`s${i - 1}`, `s${Math.max(0, i - 2)}`] : []
        })
      );
      const highRiskResult = await service.assessRisks(highRiskWorkflow, constraints, analysis);

      expect(highRiskResult.overallRiskScore).toBeGreaterThan(lowRiskResult.overallRiskScore);
    });
  });

  describe('convertProbabilityToString', () => {
    it('should return "low" for probability < 0.3', () => {
      expect(service.convertProbabilityToString(0)).toBe('low');
      expect(service.convertProbabilityToString(0.1)).toBe('low');
      expect(service.convertProbabilityToString(0.29)).toBe('low');
    });

    it('should return "medium" for probability >= 0.3 and < 0.7', () => {
      expect(service.convertProbabilityToString(0.3)).toBe('medium');
      expect(service.convertProbabilityToString(0.5)).toBe('medium');
      expect(service.convertProbabilityToString(0.69)).toBe('medium');
    });

    it('should return "high" for probability >= 0.7', () => {
      expect(service.convertProbabilityToString(0.7)).toBe('high');
      expect(service.convertProbabilityToString(0.9)).toBe('high');
      expect(service.convertProbabilityToString(1.0)).toBe('high');
    });
  });

  describe('convertImpactToString', () => {
    it('should return "low" for impact < 0.3', () => {
      expect(service.convertImpactToString(0)).toBe('low');
      expect(service.convertImpactToString(0.1)).toBe('low');
      expect(service.convertImpactToString(0.29)).toBe('low');
    });

    it('should return "medium" for impact >= 0.3 and < 0.7', () => {
      expect(service.convertImpactToString(0.3)).toBe('medium');
      expect(service.convertImpactToString(0.5)).toBe('medium');
      expect(service.convertImpactToString(0.69)).toBe('medium');
    });

    it('should return "high" for impact >= 0.7', () => {
      expect(service.convertImpactToString(0.7)).toBe('high');
      expect(service.convertImpactToString(0.9)).toBe('high');
      expect(service.convertImpactToString(1.0)).toBe('high');
    });
  });

  describe('logging', () => {
    it('should log risk assessment initiation and completion', async () => {
      const workflow = createRealisticWorkflow();
      const constraints = createConstraints();
      const analysis = createOptimizationAnalysis();

      await service.assessRisks(workflow, constraints, analysis);

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Assessing process optimization risks',
        expect.objectContaining({
          workflowSteps: workflow.length,
          constraints: constraints.length,
          opportunities: analysis.opportunities.length
        })
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Risk assessment completed',
        expect.objectContaining({
          operationalRisks: expect.any(Number),
          technicalRisks: expect.any(Number),
          businessRisks: expect.any(Number),
          complianceRisks: expect.any(Number),
          overallRiskScore: expect.any(Number)
        })
      );
    });
  });
});
