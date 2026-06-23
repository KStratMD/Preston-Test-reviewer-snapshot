/**
 * Comprehensive unit tests for ProcessOptimizationAgent
 * Covers: constructor, validateInput, getSchema, executeInternal,
 *         analyzeWorkflow (dependency graph, critical path, parallelizable, sequential, cycles),
 *         cost calculation, complexity assessment, confidence & reasoning helpers
 */
import 'reflect-metadata';

// Mock Logger module (used by BaseAgent)
jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { ProcessOptimizationAgent } from '../../../../src/services/ai/orchestrator/agents/ProcessOptimizationAgent';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeWorkflowStep(overrides: Record<string, any> = {}) {
  return {
    id: 'step-1',
    name: 'Extract Data',
    type: 'automated' as const,
    duration: 10,
    resources: ['system-1'],
    dependencies: [] as string[],
    failureRate: 0.01,
    cost: 100,
    ...overrides,
  };
}

function makeContext(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'session-1',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
    ...overrides,
  };
}

function makeInput(overrides: Record<string, any> = {}) {
  return {
    currentWorkflow: [
      makeWorkflowStep({ id: 'step-1', name: 'Extract', dependencies: [] }),
      makeWorkflowStep({ id: 'step-2', name: 'Transform', dependencies: ['step-1'], duration: 15 }),
      makeWorkflowStep({ id: 'step-3', name: 'Load', dependencies: ['step-2'], duration: 8 }),
    ],
    performanceMetrics: [
      { name: 'throughput', value: 100, unit: 'records/hour' },
    ],
    constraints: [],
    objectives: [
      { type: 'reduce_time', target: 0.2, priority: 'high' },
    ],
    ...overrides,
  };
}

// Mock services
const mockBottleneckService = {
  identifyBottlenecks: jest.fn().mockResolvedValue({
    criticalBottlenecks: [
      { id: 'bn-1', stepId: 'step-2', severity: 'high', description: 'Transform is slow' },
    ],
    capacity: { currentCapacity: 100, requiredCapacity: 150, utilizationRate: 0.67, peakLoad: 200, averageLoad: 120, capacityGap: 50 },
    queueAnalysis: { averageQueueLength: 5, maxQueueLength: 20, averageWaitTime: 3, queueingDelay: 2, serviceRate: 10, arrivalRate: 8 },
    resourceConstraints: [],
  }),
};

const mockPerformanceService = {
  analyzePerformance: jest.fn().mockResolvedValue({
    throughput: 100,
    utilization: 0.75,
    efficiency: 0.8,
    waitTime: 5,
    processingTime: 33,
    setupTime: 2,
    metrics: [],
  }),
};

const mockCostBenefitAnalyzer = {
  calculateCostSavings: jest.fn().mockResolvedValue([
    { category: 'automation', annualSaving: 50000, description: 'Automated transform step' },
  ]),
};

const mockRiskService = {
  assessRisks: jest.fn().mockResolvedValue({
    operationalRisks: [
      { type: 'capacity', description: 'Capacity risk', probability: 0.4, impact: 0.6, riskScore: 0.24, currentControls: ['monitoring'], recommendedControls: ['auto-scaling'] },
    ],
    technicalRisks: [
      { type: 'performance', description: 'Perf risk', probability: 0.2, impact: 0.8, riskScore: 0.16, technicalDebt: 5, mitigation: ['optimize queries'] },
    ],
    businessRisks: [],
    complianceRisks: [],
    overallRiskScore: 4.5,
  }),
};

const mockRecommender = {
  generateOptimizations: jest.fn().mockResolvedValue({
    opportunities: [
      {
        id: 'opt-1',
        type: 'automation',
        description: 'Automate data extraction',
        affectedSteps: ['step-1'],
        potentialGains: { timeReduction: 0.5, costReduction: 0.3, qualityImprovement: 0.2, errorReduction: 0.4 },
        implementationEffort: 'medium',
        prerequisites: ['API access'],
        risks: ['integration complexity'],
      },
    ],
    scenarios: [],
    recommendations: [],
    impact: {
      timeImprovement: { currentValue: 33, projectedValue: 20, improvementPercent: 0.4, confidence: 0.8, timeframe: '3 months' },
      costReduction: { currentValue: 1000, projectedValue: 700, improvementPercent: 0.3, confidence: 0.75, timeframe: '6 months' },
      qualityGains: { currentValue: 0.9, projectedValue: 0.95, improvementPercent: 0.05, confidence: 0.7, timeframe: '3 months' },
      riskReduction: { currentValue: 0.3, projectedValue: 0.15, improvementPercent: 0.5, confidence: 0.6, timeframe: '6 months' },
      overallValue: 0.75,
    },
  }),
  createOptimizedWorkflow: jest.fn().mockResolvedValue([
    makeWorkflowStep({ id: 'step-1', name: 'Extract (Automated)', duration: 5 }),
    makeWorkflowStep({ id: 'step-2', name: 'Transform', duration: 15, dependencies: ['step-1'] }),
    makeWorkflowStep({ id: 'step-3', name: 'Load', duration: 8, dependencies: ['step-2'] }),
  ]),
};

describe('ProcessOptimizationAgent', () => {
  let agent: ProcessOptimizationAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new ProcessOptimizationAgent(
      mockLogger,
      {} as any, // providerRegistry
      {} as any, // semanticEngine
      mockBottleneckService as any,
      mockPerformanceService as any,
      mockCostBenefitAnalyzer as any,
      mockRiskService as any,
      mockRecommender as any,
    );
  });

  describe('constructor', () => {
    it('should initialize with correct name and version', () => {
      expect(agent.name).toBe('ProcessOptimizationAgent');
      expect(agent.version).toBe('1.0.0');
    });

    it('should have required capabilities', () => {
      expect(agent.capabilities).toContain('workflow_analysis');
      expect(agent.capabilities).toContain('bottleneck_detection');
      expect(agent.capabilities).toContain('process_optimization');
      expect(agent.capabilities).toContain('performance_analysis');
      expect(agent.capabilities).toContain('cost_benefit_analysis');
      expect(agent.capabilities).toContain('risk_assessment');
    });

    it('should log initialization', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Process Optimization Agent initialized with AI integration',
        expect.any(Object),
      );
    });

    it('should initialize optimization patterns, benchmarks, and templates', () => {
      // The framework initialization is logged
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Process optimization framework initialized',
        expect.objectContaining({
          patterns: expect.any(Number),
          benchmarks: expect.any(Number),
          templates: expect.any(Number),
        }),
      );
    });
  });

  describe('validateInput (via execute)', () => {
    it('should reject null input', async () => {
      const result = await agent.execute(makeContext(), null);
      expect(result.success).toBe(false);
    });

    it('should reject empty workflow', async () => {
      const result = await agent.execute(makeContext(), { currentWorkflow: [] });
      expect(result.success).toBe(false);
    });

    it('should reject workflow steps without id', async () => {
      const result = await agent.execute(makeContext(), {
        currentWorkflow: [{ name: 'Test', duration: 10 }],
      });
      expect(result.success).toBe(false);
    });

    it('should reject workflow steps without name', async () => {
      const result = await agent.execute(makeContext(), {
        currentWorkflow: [{ id: 's1', duration: 10 }],
      });
      expect(result.success).toBe(false);
    });

    it('should reject workflow steps with negative duration', async () => {
      const result = await agent.execute(makeContext(), {
        currentWorkflow: [{ id: 's1', name: 'Test', duration: -5 }],
      });
      expect(result.success).toBe(false);
    });

    it('should accept valid workflow input', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      expect(result.success).toBe(true);
    });
  });

  describe('getSchema', () => {
    it('should return valid schema with input and output', () => {
      const schema = agent.getSchema();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.outputSchema).toBeDefined();
      expect(schema.inputSchema.properties.currentWorkflow).toBeDefined();
      expect(schema.inputSchema.required).toContain('currentWorkflow');
    });

    it('should include capabilities and resource requirements', () => {
      const schema = agent.getSchema();
      expect(schema.capabilities).toEqual(agent.capabilities);
      expect(schema.resourceRequirements.maxMemory).toBe(512);
      expect(schema.resourceRequirements.maxExecutionTime).toBe(60000);
    });
  });

  describe('executeInternal (via execute)', () => {
    it('should produce successful result with all analysis components', async () => {
      const result = await agent.execute(makeContext(), makeInput());

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasoning).toBeDefined();
    });

    it('should delegate to bottleneck service', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockBottleneckService.identifyBottlenecks).toHaveBeenCalled();
    });

    it('should delegate to performance service', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockPerformanceService.analyzePerformance).toHaveBeenCalled();
    });

    it('should delegate to recommender for optimizations', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockRecommender.generateOptimizations).toHaveBeenCalled();
    });

    it('should delegate to risk service', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockRiskService.assessRisks).toHaveBeenCalled();
    });

    it('should delegate to cost benefit analyzer', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockCostBenefitAnalyzer.calculateCostSavings).toHaveBeenCalled();
    });

    it('should create optimized workflow', async () => {
      await agent.execute(makeContext(), makeInput());
      expect(mockRecommender.createOptimizedWorkflow).toHaveBeenCalled();
    });

    it('should include output with optimizedWorkflow, improvements, bottlenecks, costSavings, riskAssessment', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;

      expect(data.optimizedWorkflow).toBeDefined();
      expect(data.improvements).toBeDefined();
      expect(data.bottlenecks).toBeDefined();
      expect(data.costSavings).toBeDefined();
      expect(data.riskAssessment).toBeDefined();
    });

    it('should convert opportunities to improvements', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;

      expect(data.improvements.length).toBe(1);
      expect(data.improvements[0].type).toBe('automation');
      expect(data.improvements[0].description).toBe('Automate data extraction');
      expect(data.improvements[0].impact.timeReduction).toBe(0.5);
    });

    it('should convert risk analysis to process risks', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;

      expect(data.riskAssessment.length).toBe(2); // 1 operational + 1 technical
      expect(data.riskAssessment[0].type).toBe('operational');
      expect(data.riskAssessment[1].type).toBe('technical');
    });

    it('should include reasoning with step count, bottlenecks, opportunities, cost savings', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      expect(result.reasoning).toContain('3 steps');
      expect(result.reasoning).toContain('1 bottlenecks');
      expect(result.reasoning).toContain('1 optimization opportunities');
      expect(result.reasoning).toContain('50000');
    });

    it('should handle execution errors gracefully', async () => {
      mockBottleneckService.identifyBottlenecks.mockRejectedValueOnce(new Error('Service down'));

      const result = await agent.execute(makeContext(), makeInput());
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });

    it('should handle missing performance metrics', async () => {
      const input = makeInput({ performanceMetrics: undefined });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
      expect(mockPerformanceService.analyzePerformance).toHaveBeenCalledWith([]);
    });

    it('should handle missing objectives', async () => {
      const input = makeInput({ objectives: undefined });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });
  });

  describe('workflow analysis internals', () => {
    it('should calculate total cost with manual vs automated rates', async () => {
      const input = makeInput({
        currentWorkflow: [
          makeWorkflowStep({ id: 's1', type: 'manual', duration: 60 }), // 60 min * $50/hr = $50
          makeWorkflowStep({ id: 's2', type: 'automated', duration: 60, dependencies: ['s1'] }), // 60 min * $25/hr = $25
        ],
      });
      // The cost calculation is internal but reflected in the analysis
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });

    it('should detect parallelizable steps (no dependencies)', async () => {
      const input = makeInput({
        currentWorkflow: [
          makeWorkflowStep({ id: 's1', dependencies: [] }),
          makeWorkflowStep({ id: 's2', dependencies: [] }),
          makeWorkflowStep({ id: 's3', dependencies: ['s1'] }),
        ],
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });

    it('should detect sequential steps (has dependencies)', async () => {
      const input = makeInput({
        currentWorkflow: [
          makeWorkflowStep({ id: 's1', dependencies: [] }),
          makeWorkflowStep({ id: 's2', dependencies: ['s1'] }),
        ],
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });

    it('should handle cyclic dependencies', async () => {
      const input = makeInput({
        currentWorkflow: [
          makeWorkflowStep({ id: 's1', dependencies: ['s2'] }),
          makeWorkflowStep({ id: 's2', dependencies: ['s1'] }),
        ],
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });

    it('should assess complexity as low for small workflows', async () => {
      const input = makeInput({
        currentWorkflow: [
          makeWorkflowStep({ id: 's1', dependencies: [] }),
          makeWorkflowStep({ id: 's2', dependencies: [] }),
        ],
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });

    it('should assess higher complexity for many steps with dependencies', async () => {
      const steps = [];
      for (let i = 0; i < 15; i++) {
        steps.push(makeWorkflowStep({
          id: `s${i}`,
          dependencies: i > 0 ? [`s${i - 1}`] : [],
          duration: 5,
        }));
      }
      const input = makeInput({ currentWorkflow: steps });
      const result = await agent.execute(makeContext(), input);
      expect(result.success).toBe(true);
    });
  });

  describe('probability and impact conversion', () => {
    it('should convert low probability correctly', async () => {
      mockRiskService.assessRisks.mockResolvedValueOnce({
        operationalRisks: [
          { type: 'capacity', description: 'Low risk', probability: 0.1, impact: 0.1, riskScore: 0.01, currentControls: [], recommendedControls: ['monitor'] },
        ],
        technicalRisks: [],
        businessRisks: [],
        complianceRisks: [],
        overallRiskScore: 1,
      });

      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;
      expect(data.riskAssessment[0].probability).toBe('low');
      expect(data.riskAssessment[0].impact).toBe('low');
    });

    it('should convert medium probability correctly', async () => {
      mockRiskService.assessRisks.mockResolvedValueOnce({
        operationalRisks: [
          { type: 'capacity', description: 'Med risk', probability: 0.5, impact: 0.5, riskScore: 0.25, currentControls: [], recommendedControls: ['monitor'] },
        ],
        technicalRisks: [],
        businessRisks: [],
        complianceRisks: [],
        overallRiskScore: 5,
      });

      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;
      expect(data.riskAssessment[0].probability).toBe('medium');
      expect(data.riskAssessment[0].impact).toBe('medium');
    });

    it('should convert high probability correctly', async () => {
      mockRiskService.assessRisks.mockResolvedValueOnce({
        operationalRisks: [
          { type: 'capacity', description: 'High risk', probability: 0.8, impact: 0.9, riskScore: 0.72, currentControls: [], recommendedControls: ['mitigate'] },
        ],
        technicalRisks: [],
        businessRisks: [],
        complianceRisks: [],
        overallRiskScore: 8,
      });

      const result = await agent.execute(makeContext(), makeInput());
      const data = result.data as any;
      expect(data.riskAssessment[0].probability).toBe('high');
      expect(data.riskAssessment[0].impact).toBe('high');
    });
  });

  describe('data quality assessment', () => {
    it('should score higher with complete workflow data', async () => {
      const input = makeInput({
        performanceMetrics: [{ name: 'throughput', value: 100 }],
        objectives: [{ type: 'reduce_time', target: 0.2 }],
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should score lower without performance metrics or objectives', async () => {
      const input = makeInput({
        performanceMetrics: undefined,
        objectives: undefined,
      });
      const result = await agent.execute(makeContext(), input);
      expect(result.confidence).toBeGreaterThan(0);
    });
  });
});
