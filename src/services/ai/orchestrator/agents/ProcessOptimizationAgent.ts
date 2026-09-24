/**
 * Process Optimization Agent - Workflow analysis and bottleneck identification
 * Week 5 Implementation - Phase 2 Intelligence Amplification
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../inversify/types';
import { logger, type Logger } from '../../../../utils/Logger';
import { BaseAgent, type BaseAgentConfig } from '../BaseAgent';
import { BottleneckAnalysisService } from './optimization/BottleneckAnalysisService';
import { PerformanceMetricsService } from './optimization/PerformanceMetricsService';
import { CostBenefitAnalyzer } from './optimization/CostBenefitAnalyzer';
import { RiskAssessmentService } from './optimization/RiskAssessmentService';
import { OptimizationRecommender } from './optimization/OptimizationRecommender';
import type {
  AgentExecutionContext,
  AgentResult,
  AgentSchema,
  ProcessOptimizationInput,
  ProcessOptimizationOutput,
  WorkflowStep,
  ProcessImprovement,
  Bottleneck,
  CostSaving,
  ProcessRisk,
  PerformanceMetric,
  Constraint,
  Objective
} from '../interfaces';

export interface ProcessAnalysis {
  workflow: AnalyzedWorkflow;
  performance: PerformanceAnalysis;
  bottlenecks: BottleneckAnalysis;
  optimization: OptimizationAnalysis;
  risks: RiskAnalysis;
}

export interface AnalyzedWorkflow {
  totalSteps: number;
  criticalPath: string[];
  parallelizable: string[];
  sequential: string[];
  cyclicPaths: string[];
  totalDuration: number;
  totalCost: number;
  complexity: 'low' | 'medium' | 'high';
}

export interface PerformanceAnalysis {
  throughput: number;
  utilization: number;
  efficiency: number;
  waitTime: number;
  processingTime: number;
  setupTime: number;
  metrics: ProcessMetric[];
}

export interface ProcessMetric {
  name: string;
  current: number;
  target: number;
  unit: string;
  trend: 'improving' | 'stable' | 'declining';
  variance: number;
}

export interface BottleneckAnalysis {
  criticalBottlenecks: Bottleneck[];
  capacity: CapacityAnalysis;
  queueAnalysis: QueueAnalysis;
  resourceConstraints: ResourceConstraint[];
}

export interface CapacityAnalysis {
  currentCapacity: number;
  requiredCapacity: number;
  utilizationRate: number;
  peakLoad: number;
  averageLoad: number;
  capacityGap: number;
}

export interface QueueAnalysis {
  averageQueueLength: number;
  maxQueueLength: number;
  averageWaitTime: number;
  queueingDelay: number;
  serviceRate: number;
  arrivalRate: number;
}

export interface ResourceConstraint {
  resource: string;
  type: 'human' | 'system' | 'infrastructure' | 'external';
  currentUsage: number;
  maxCapacity: number;
  utilizationRate: number;
  isBottleneck: boolean;
  scalability: 'fixed' | 'scalable' | 'elastic';
}

export interface OptimizationAnalysis {
  opportunities: OptimizationOpportunity[];
  scenarios: OptimizationScenario[];
  recommendations: OptimizationRecommendation[];
  impact: ImpactAssessment;
}

export interface OptimizationOpportunity {
  id: string;
  type: 'automation' | 'parallelization' | 'elimination' | 'consolidation' | 'reordering';
  description: string;
  affectedSteps: string[];
  potentialGains: {
    timeReduction: number;
    costReduction: number;
    qualityImprovement: number;
    errorReduction: number;
  };
  implementationEffort: 'low' | 'medium' | 'high';
  prerequisites: string[];
  risks: string[];
}

export interface OptimizationScenario {
  name: string;
  description: string;
  changes: ProcessChange[];
  expectedOutcome: ScenarioOutcome;
  confidence: number;
  timeframe: string;
}

export interface ProcessChange {
  step: string;
  changeType: 'modify' | 'add' | 'remove' | 'replace';
  description: string;
  impact: ChangeImpact;
}

export interface ChangeImpact {
  duration: number;
  cost: number;
  quality: number;
  risk: 'low' | 'medium' | 'high';
}

export interface ScenarioOutcome {
  timeImprovement: number;
  costSavings: number;
  qualityGains: number;
  riskLevel: 'low' | 'medium' | 'high';
  roi: number;
  paybackPeriod: number;
}

export interface OptimizationRecommendation {
  priority: 'low' | 'medium' | 'high' | 'critical';
  category: 'quick_win' | 'strategic' | 'transformational' | 'experimental';
  title: string;
  description: string;
  benefits: string[];
  implementation: ImplementationPlan;
  success_metrics: string[];
}

export interface ImplementationPlan {
  phases: ImplementationPhase[];
  duration: number;
  resources: ResourceRequirement[];
  dependencies: string[];
  risks: ImplementationRisk[];
}

export interface ImplementationPhase {
  phase: number;
  name: string;
  description: string;
  duration: number;
  deliverables: string[];
  successCriteria: string[];
}

export interface ResourceRequirement {
  type: 'human' | 'technology' | 'infrastructure' | 'training';
  description: string;
  quantity: number;
  duration: number;
  cost: number;
}

export interface ImplementationRisk {
  risk: string;
  probability: 'low' | 'medium' | 'high';
  impact: 'low' | 'medium' | 'high';
  mitigation: string;
}

export interface RiskAnalysis {
  operationalRisks: OperationalRisk[];
  technicalRisks: TechnicalRisk[];
  businessRisks: BusinessRisk[];
  complianceRisks: ComplianceRisk[];
  overallRiskScore: number;
}

export interface OperationalRisk {
  type: 'capacity' | 'dependency' | 'quality' | 'timing' | 'resource';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  currentControls: string[];
  recommendedControls: string[];
}

export interface TechnicalRisk {
  type: 'integration' | 'performance' | 'scalability' | 'reliability' | 'security';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  technicalDebt: number;
  mitigation: string[];
}

export interface BusinessRisk {
  type: 'market' | 'financial' | 'strategic' | 'regulatory' | 'reputation';
  description: string;
  probability: number;
  impact: number;
  riskScore: number;
  businessImpact: string;
  stakeholderConcerns: string[];
}

export interface ComplianceRisk {
  regulation: string;
  requirement: string;
  currentCompliance: number;
  requiredCompliance: number;
  riskLevel: 'low' | 'medium' | 'high';
  remediation: string[];
}

export interface ImpactAssessment {
  timeImprovement: ImpactMetric;
  costReduction: ImpactMetric;
  qualityGains: ImpactMetric;
  riskReduction: ImpactMetric;
  overallValue: number;
}

export interface ImpactMetric {
  currentValue: number;
  projectedValue: number;
  improvementPercent: number;
  confidence: number;
  timeframe: string;
}

@injectable()
export class ProcessOptimizationAgent extends BaseAgent {
  private optimizationPatterns = new Map<string, OptimizationPattern>();
  private industryBenchmarks = new Map<string, Benchmark>();
  private processTemplates = new Map<string, ProcessTemplate>();
  private providerRegistry: unknown;
  private semanticEngine: unknown;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject('ProviderRegistry') providerRegistry: unknown,
    @inject(TYPES.SemanticAnalysisEngine) semanticEngine: unknown,
    @inject(TYPES.BottleneckAnalysisService) private bottleneckService: BottleneckAnalysisService,
    @inject(TYPES.PerformanceMetricsService) private performanceService: PerformanceMetricsService,
    @inject(TYPES.CostBenefitAnalyzer) private costBenefitAnalyzer: CostBenefitAnalyzer,
    @inject(TYPES.RiskAssessmentService) private riskService: RiskAssessmentService,
    @inject(TYPES.OptimizationRecommender) private recommender: OptimizationRecommender
  ) {
    const config: BaseAgentConfig = {
      name: 'ProcessOptimizationAgent',
      version: '1.0.0',
      capabilities: [
        'workflow_analysis',
        'bottleneck_detection',
        'process_optimization',
        'performance_analysis',
        'cost_benefit_analysis',
        'risk_assessment'
      ],
      dependencies: [],
      maxExecutionTime: 60000,
      confidenceThreshold: 0.6
    };

    super(config, logger);
    this.providerRegistry = providerRegistry;
    this.semanticEngine = semanticEngine;
    this.initializeOptimizationFramework();

    this.logger.info('Process Optimization Agent initialized with AI integration', {
      hasProviderRegistry: !!this.providerRegistry,
      hasSemanticEngine: !!this.semanticEngine
    });
  }

  protected async executeInternal(
    context: AgentExecutionContext,
    input: ProcessOptimizationInput
  ): Promise<AgentResult> {
    try {
      this.logger.info('Process optimization agent execution started', {
        sessionId: context.sessionId,
        workflowSteps: input.currentWorkflow.length,
        metricsCount: input.performanceMetrics?.length || 0
      });

      // Step 1: Analyze current workflow (orchestrator-level logic)
      const workflowAnalysis = await this.analyzeWorkflow(input.currentWorkflow);

      // Step 2: Identify bottlenecks (delegate to service)
      const bottleneckAnalysis = await this.bottleneckService.identifyBottlenecks(
        input.currentWorkflow,
        workflowAnalysis
      );

      // Step 3: Analyze performance metrics (delegate to service)
      const performanceAnalysis = await this.performanceService.analyzePerformance(
        input.performanceMetrics || []
      );

      // Step 4: Generate optimization opportunities (delegate to service)
      const optimizationAnalysis = await this.recommender.generateOptimizations(
        input.currentWorkflow,
        workflowAnalysis,
        bottleneckAnalysis,
        performanceAnalysis,
        input.objectives || []
      );

      // Step 5: Assess risks (delegate to service)
      const riskAnalysis = await this.riskService.assessRisks(
        input.currentWorkflow,
        input.constraints || [],
        optimizationAnalysis
      );

      // Step 6: Create optimized workflow (delegate to service)
      const optimizedWorkflow = await this.recommender.createOptimizedWorkflow(
        input.currentWorkflow,
        optimizationAnalysis.opportunities
      );

      // Step 7: Calculate cost savings (delegate to service)
      const costSavings = await this.costBenefitAnalyzer.calculateCostSavings(
        input.currentWorkflow,
        optimizedWorkflow,
        optimizationAnalysis
      );

      const output: ProcessOptimizationOutput = {
        optimizedWorkflow,
        improvements: this.convertOpportunitiesToImprovements(optimizationAnalysis.opportunities),
        bottlenecks: bottleneckAnalysis.criticalBottlenecks,
        costSavings,
        riskAssessment: this.convertRiskAnalysisToProcessRisks(riskAnalysis)
      };

      const confidence = this.calculateConfidence([
        { factor: 'workflow_complexity', value: this.assessWorkflowComplexity(input.currentWorkflow), weight: 0.2 },
        { factor: 'data_quality', value: this.assessDataQuality(input), weight: 0.3 },
        { factor: 'optimization_potential', value: optimizationAnalysis.impact.overallValue, weight: 0.3 },
        { factor: 'risk_level', value: 1 - (riskAnalysis.overallRiskScore / 10), weight: 0.2 }
      ]);

      const reasoning = this.mergeReasoning([
        `Analyzed workflow with ${input.currentWorkflow.length} steps and identified ${bottleneckAnalysis.criticalBottlenecks.length} bottlenecks`,
        `Found ${optimizationAnalysis.opportunities.length} optimization opportunities with ${(optimizationAnalysis.impact.overallValue * 100).toFixed(1)}% potential improvement`,
        `Projected cost savings: ${costSavings.reduce((sum, cs) => sum + cs.annualSaving, 0).toFixed(0)} annually`,
        `Risk assessment: ${riskAnalysis.overallRiskScore.toFixed(1)}/10 with ${riskAnalysis.operationalRisks.length} operational risks identified`
      ]);

      return this.createSuccessResult(output, confidence, reasoning);

    } catch (error) {
      this.logger.error('Process optimization agent execution failed', {
        sessionId: context.sessionId,
        error: String(error)
      });

      return this.createErrorResult(
        `Process optimization analysis failed: ${this.formatError(error)}`,
        ['Verify workflow data completeness', 'Check performance metrics format', 'Review constraint definitions']
      );
    }
  }

  protected async validateInputInternal(input: ProcessOptimizationInput): Promise<boolean> {
    if (!input.currentWorkflow || !Array.isArray(input.currentWorkflow) || input.currentWorkflow.length === 0) {
      return false;
    }

    // Validate workflow steps
    for (const step of input.currentWorkflow) {
      if (!step.id || typeof step.id !== 'string') {
        return false;
      }
      if (!step.name || typeof step.name !== 'string') {
        return false;
      }
      if (typeof step.duration !== 'number' || step.duration < 0) {
        return false;
      }
    }

    return true;
  }

  getSchema(): AgentSchema {
    return {
      inputSchema: {
        type: 'object',
        properties: {
          currentWorkflow: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                type: { type: 'string', enum: ['manual', 'automated', 'hybrid'] },
                duration: { type: 'number', minimum: 0 },
                resources: { type: 'array', items: { type: 'string' } },
                dependencies: { type: 'array', items: { type: 'string' } },
                failureRate: { type: 'number', minimum: 0, maximum: 1 }
              },
              required: ['id', 'name', 'type', 'duration', 'resources', 'dependencies']
            }
          },
          performanceMetrics: {
            type: 'array',
            items: { type: 'object' }
          },
          constraints: {
            type: 'array',
            items: { type: 'object' }
          },
          objectives: {
            type: 'array',
            items: { type: 'object' }
          }
        },
        required: ['currentWorkflow']
      },
      outputSchema: {
        type: 'object',
        properties: {
          optimizedWorkflow: {
            type: 'array',
            items: { type: 'object' }
          },
          improvements: {
            type: 'array',
            items: { type: 'object' }
          },
          bottlenecks: {
            type: 'array',
            items: { type: 'object' }
          },
          costSavings: {
            type: 'array',
            items: { type: 'object' }
          },
          riskAssessment: {
            type: 'array',
            items: { type: 'object' }
          }
        },
        required: ['optimizedWorkflow', 'improvements', 'bottlenecks', 'costSavings', 'riskAssessment']
      },
      capabilities: this.capabilities,
      resourceRequirements: {
        maxMemory: 512,
        maxExecutionTime: 60000
      }
    };
  }

  // Private methods

  private initializeOptimizationFramework(): void {
    // Initialize optimization patterns
    this.initializeOptimizationPatterns();

    // Initialize industry benchmarks
    this.initializeIndustryBenchmarks();

    // Initialize process templates
    this.initializeProcessTemplates();

    this.logger.info('Process optimization framework initialized', {
      patterns: this.optimizationPatterns.size,
      benchmarks: this.industryBenchmarks.size,
      templates: this.processTemplates.size
    });
  }

  private initializeOptimizationPatterns(): void {
    // Automation patterns
    this.addOptimizationPattern({
      id: 'manual_to_automated',
      name: 'Manual to Automated Conversion',
      description: 'Convert repetitive manual tasks to automated processes',
      applicability: ['manual', 'repetitive', 'rule-based'],
      expectedGains: { time: 0.8, cost: 0.7, quality: 0.9, errors: 0.9 },
      effort: 'medium',
      riskLevel: 'low'
    });

    // Parallelization patterns
    this.addOptimizationPattern({
      id: 'sequential_to_parallel',
      name: 'Sequential to Parallel Processing',
      description: 'Execute independent tasks in parallel',
      applicability: ['independent', 'sequential', 'waiting'],
      expectedGains: { time: 0.6, cost: 0.2, quality: 0.0, errors: 0.0 },
      effort: 'low',
      riskLevel: 'low'
    });

    // Elimination patterns
    this.addOptimizationPattern({
      id: 'redundant_elimination',
      name: 'Redundant Process Elimination',
      description: 'Remove unnecessary or duplicate process steps',
      applicability: ['redundant', 'duplicate', 'unnecessary'],
      expectedGains: { time: 0.9, cost: 0.8, quality: 0.1, errors: 0.2 },
      effort: 'low',
      riskLevel: 'medium'
    });

    // Consolidation patterns
    this.addOptimizationPattern({
      id: 'task_consolidation',
      name: 'Task Consolidation',
      description: 'Combine related tasks into single operations',
      applicability: ['fragmented', 'related', 'frequent'],
      expectedGains: { time: 0.3, cost: 0.4, quality: 0.2, errors: 0.3 },
      effort: 'medium',
      riskLevel: 'low'
    });
  }

  private initializeIndustryBenchmarks(): void {
    // Manufacturing benchmarks
    this.addIndustryBenchmark('manufacturing', {
      throughput: 85, // units per hour
      efficiency: 0.8,
      errorRate: 0.02,
      setupTime: 15, // minutes
      utilizationRate: 0.75
    });

    // Finance benchmarks
    this.addIndustryBenchmark('finance', {
      throughput: 50, // transactions per hour
      efficiency: 0.85,
      errorRate: 0.005,
      setupTime: 5, // minutes
      utilizationRate: 0.8
    });

    // Healthcare benchmarks
    this.addIndustryBenchmark('healthcare', {
      throughput: 20, // patients per hour
      efficiency: 0.7,
      errorRate: 0.001,
      setupTime: 10, // minutes
      utilizationRate: 0.85
    });
  }

  private initializeProcessTemplates(): void {
    // Data integration template
    this.addProcessTemplate('data_integration', {
      name: 'Data Integration Process',
      steps: ['extract', 'validate', 'transform', 'load', 'verify'],
      expectedDurations: [10, 5, 15, 8, 5], // minutes
      criticalPath: ['extract', 'transform', 'load'],
      parallelizableSteps: ['validate', 'verify']
    });

    // Customer onboarding template
    this.addProcessTemplate('customer_onboarding', {
      name: 'Customer Onboarding Process',
      steps: ['application', 'verification', 'approval', 'setup', 'training'],
      expectedDurations: [30, 20, 15, 45, 60], // minutes
      criticalPath: ['application', 'verification', 'approval', 'setup'],
      parallelizableSteps: ['training']
    });
  }

  private async analyzeWorkflow(workflow: WorkflowStep[]): Promise<AnalyzedWorkflow> {
    // Build dependency graph
    const dependencyGraph = this.buildDependencyGraph(workflow);

    // Find critical path
    const criticalPath = this.findCriticalPath(workflow, dependencyGraph);

    // Identify parallelizable steps
    const parallelizable = this.identifyParallelizableSteps(workflow, dependencyGraph);

    // Find sequential dependencies
    const sequential = this.identifySequentialSteps(workflow, dependencyGraph);

    // Detect cycles
    const cyclicPaths = this.detectCycles(dependencyGraph);

    // Calculate totals
    const totalDuration = this.calculateTotalDuration(workflow, criticalPath);
    const totalCost = this.calculateTotalCost(workflow);

    // Assess complexity
    const complexity = this.assessComplexity(workflow, dependencyGraph);

    return {
      totalSteps: workflow.length,
      criticalPath,
      parallelizable,
      sequential,
      cyclicPaths,
      totalDuration,
      totalCost,
      complexity
    };
  }


  // Utility methods

  private addOptimizationPattern(pattern: OptimizationPattern): void {
    this.optimizationPatterns.set(pattern.id, pattern);
  }

  private addIndustryBenchmark(industry: string, benchmark: Benchmark): void {
    this.industryBenchmarks.set(industry, benchmark);
  }

  private addProcessTemplate(templateId: string, template: ProcessTemplate): void {
    this.processTemplates.set(templateId, template);
  }

  private buildDependencyGraph(workflow: WorkflowStep[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    workflow.forEach(step => {
      graph.set(step.id, step.dependencies);
    });

    return graph;
  }

  private findCriticalPath(workflow: WorkflowStep[], graph: Map<string, string[]>): string[] {
    // Simplified critical path calculation
    const visited = new Set<string>();
    const path: string[] = [];

    const findLongestPath = (stepId: string): number => {
      if (visited.has(stepId)) return 0;
      visited.add(stepId);

      const step = workflow.find(s => s.id === stepId);
      if (!step) return 0;

      const dependencies = graph.get(stepId) || [];
      const maxDependencyTime = dependencies.length > 0
        ? Math.max(...dependencies.map(dep => findLongestPath(dep)))
        : 0;

      return step.duration + maxDependencyTime;
    };

    // Find the path with maximum duration
    let maxDuration = 0;
    let criticalStart = '';

    workflow.forEach(step => {
      visited.clear();
      const duration = findLongestPath(step.id);
      if (duration > maxDuration) {
        maxDuration = duration;
        criticalStart = step.id;
      }
    });

    // Reconstruct the critical path
    if (criticalStart) {
      path.push(criticalStart);
      // Simplified - would need full path reconstruction in production
    }

    return path;
  }

  private identifyParallelizableSteps(workflow: WorkflowStep[], graph: Map<string, string[]>): string[] {
    const parallelizable: string[] = [];

    workflow.forEach(step => {
      const dependencies = graph.get(step.id) || [];
      const dependents = Array.from(graph.values()).filter(deps => deps.includes(step.id));

      // Step is parallelizable if it has no dependencies on other parallelizable steps
      if (dependencies.length === 0 || !dependencies.some(dep => parallelizable.includes(dep))) {
        parallelizable.push(step.id);
      }
    });

    return parallelizable;
  }

  private identifySequentialSteps(workflow: WorkflowStep[], graph: Map<string, string[]>): string[] {
    const sequential: string[] = [];

    workflow.forEach(step => {
      const dependencies = graph.get(step.id) || [];
      if (dependencies.length > 0) {
        sequential.push(step.id);
      }
    });

    return sequential;
  }

  private detectCycles(graph: Map<string, string[]>): string[] {
    // Simplified cycle detection
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycles: string[] = [];

    const hasCycle = (node: string): boolean => {
      if (recursionStack.has(node)) {
        cycles.push(node);
        return true;
      }
      if (visited.has(node)) return false;

      visited.add(node);
      recursionStack.add(node);

      const neighbors = graph.get(node) || [];
      for (const neighbor of neighbors) {
        if (hasCycle(neighbor)) return true;
      }

      recursionStack.delete(node);
      return false;
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        hasCycle(node);
      }
    }

    return cycles;
  }

  private calculateTotalDuration(workflow: WorkflowStep[], criticalPath: string[]): number {
    return workflow
      .filter(step => criticalPath.includes(step.id))
      .reduce((sum, step) => sum + step.duration, 0);
  }

  private calculateTotalCost(workflow: WorkflowStep[]): number {
    // Simplified cost calculation
    return workflow.reduce((sum, step) => {
      const hourlyRate = step.type === 'manual' ? 50 : 25; // Different rates for manual vs automated
      return sum + (step.duration / 60) * hourlyRate;
    }, 0);
  }

  private assessComplexity(workflow: WorkflowStep[], graph: Map<string, string[]>): 'low' | 'medium' | 'high' {
    const stepCount = workflow.length;
    const dependencyCount = Array.from(graph.values()).reduce((sum, deps) => sum + deps.length, 0);
    const complexityScore = stepCount + dependencyCount * 2;

    if (complexityScore < 10) return 'low';
    if (complexityScore < 25) return 'medium';
    return 'high';
  }


  private convertOpportunitiesToImprovements(opportunities: OptimizationOpportunity[]): ProcessImprovement[] {
    return opportunities.map(opp => ({
      type: opp.type,
      description: opp.description,
      impact: {
        timeReduction: opp.potentialGains.timeReduction,
        costReduction: opp.potentialGains.costReduction,
        qualityImprovement: opp.potentialGains.qualityImprovement,
        riskReduction: opp.potentialGains.errorReduction
      },
      implementationComplexity: opp.implementationEffort,
      prerequisites: opp.prerequisites
    }));
  }

  private convertRiskAnalysisToProcessRisks(riskAnalysis: RiskAnalysis): ProcessRisk[] {
    const processRisks: ProcessRisk[] = [];

    // Convert operational risks
    riskAnalysis.operationalRisks.forEach(risk => {
      processRisks.push({
        type: 'operational',
        description: risk.description,
        probability: this.convertProbabilityToString(risk.probability),
        impact: this.convertImpactToString(risk.impact),
        mitigation: risk.recommendedControls.join(', ')
      });
    });

    // Convert technical risks
    riskAnalysis.technicalRisks.forEach(risk => {
      processRisks.push({
        type: 'technical',
        description: risk.description,
        probability: this.convertProbabilityToString(risk.probability),
        impact: this.convertImpactToString(risk.impact),
        mitigation: risk.mitigation.join(', ')
      });
    });

    return processRisks;
  }

  // Helper methods for type conversions and calculations

  private convertProbabilityToString(probability: number): 'low' | 'medium' | 'high' {
    if (probability < 0.3) return 'low';
    if (probability < 0.7) return 'medium';
    return 'high';
  }

  private convertImpactToString(impact: number): 'low' | 'medium' | 'high' {
    if (impact < 0.3) return 'low';
    if (impact < 0.7) return 'medium';
    return 'high';
  }

  private classifyResourceType(resource: string): 'human' | 'system' | 'infrastructure' | 'external' {
    if (resource.toLowerCase().includes('person') || resource.toLowerCase().includes('analyst')) {
      return 'human';
    }
    if (resource.toLowerCase().includes('system') || resource.toLowerCase().includes('server')) {
      return 'system';
    }
    if (resource.toLowerCase().includes('network') || resource.toLowerCase().includes('database')) {
      return 'infrastructure';
    }
    return 'external';
  }

  private assessResourceScalability(resource: string): 'fixed' | 'scalable' | 'elastic' {
    const resourceType = this.classifyResourceType(resource);

    switch (resourceType) {
      case 'human': return 'scalable';
      case 'system': return 'elastic';
      case 'infrastructure': return 'scalable';
      case 'external': return 'fixed';
      default: return 'scalable';
    }
  }

  private assessWorkflowComplexity(workflow: WorkflowStep[]): number {
    // Simple complexity assessment based on step count and dependencies
    const stepCount = workflow.length;
    const totalDependencies = workflow.reduce((sum, step) => sum + step.dependencies.length, 0);

    const complexityScore = (stepCount + totalDependencies) / 20; // Normalize to 0-1
    return Math.min(complexityScore, 1);
  }

  private assessDataQuality(input: ProcessOptimizationInput): number {
    // Assess completeness and consistency of input data
    let qualityScore = 0.5; // Base score

    // Check workflow completeness
    if (input.currentWorkflow.every(step =>
      step.id && step.name && step.duration !== undefined
    )) {
      qualityScore += 0.2;
    }

    // Check if performance metrics are provided
    if (input.performanceMetrics && input.performanceMetrics.length > 0) {
      qualityScore += 0.2;
    }

    // Check if objectives are provided
    if (input.objectives && input.objectives.length > 0) {
      qualityScore += 0.1;
    }

    return Math.min(qualityScore, 1);
  }

}

// Supporting interfaces and types

interface OptimizationPattern {
  id: string;
  name: string;
  description: string;
  applicability: string[];
  expectedGains: {
    time: number;
    cost: number;
    quality: number;
    errors: number;
  };
  effort: 'low' | 'medium' | 'high';
  riskLevel: 'low' | 'medium' | 'high';
}

interface Benchmark {
  throughput: number;
  efficiency: number;
  errorRate: number;
  setupTime: number;
  utilizationRate: number;
}

interface ProcessTemplate {
  name: string;
  steps: string[];
  expectedDurations: number[];
  criticalPath: string[];
  parallelizableSteps: string[];
}