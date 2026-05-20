/**
 * Optimization Recommender - Generate optimization opportunities, scenarios, and recommendations
 * Extracted from ProcessOptimizationAgent for better separation of concerns
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { WorkflowStep, ProcessImprovement, Objective } from '../../interfaces';
import type {
  OptimizationAnalysis,
  OptimizationOpportunity,
  OptimizationScenario,
  OptimizationRecommendation,
  ImpactAssessment,
  AnalyzedWorkflow,
  BottleneckAnalysis,
  PerformanceAnalysis,
  ProcessChange,
  ChangeImpact
} from '../types/process-optimization';

@injectable()
export class OptimizationRecommender {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Generate comprehensive optimization analysis with opportunities, scenarios, and recommendations
   */
  async generateOptimizations(
    workflow: WorkflowStep[],
    workflowAnalysis: AnalyzedWorkflow,
    bottleneckAnalysis: BottleneckAnalysis,
    performanceAnalysis: PerformanceAnalysis,
    objectives: Objective[]
  ): Promise<OptimizationAnalysis> {
    this.logger.info('Generating optimization analysis', {
      workflowSteps: workflow.length,
      bottlenecks: bottleneckAnalysis.criticalBottlenecks.length,
      objectives: objectives.length
    });

    // Generate opportunities
    const opportunities = await this.generateOptimizationOpportunities(
      workflow,
      bottleneckAnalysis,
      workflowAnalysis
    );

    // Create scenarios
    const scenarios = await this.createOptimizationScenarios(opportunities, workflow);

    // Generate recommendations
    const recommendations = await this.generateOptimizationRecommendations(
      opportunities,
      scenarios,
      objectives
    );

    // Assess impact
    const impact = this.assessOptimizationImpact(opportunities, scenarios);

    this.logger.info('Optimization analysis completed', {
      opportunities: opportunities.length,
      scenarios: scenarios.length,
      recommendations: recommendations.length,
      overallValue: impact.overallValue
    });

    return {
      opportunities,
      scenarios,
      recommendations,
      impact
    };
  }

  /**
   * Create optimized workflow by applying optimization opportunities
   */
  async createOptimizedWorkflow(
    currentWorkflow: WorkflowStep[],
    opportunities: OptimizationOpportunity[]
  ): Promise<WorkflowStep[]> {
    this.logger.info('Creating optimized workflow', {
      currentSteps: currentWorkflow.length,
      opportunities: opportunities.length
    });

    let optimizedWorkflow = [...currentWorkflow];

    // Apply optimization opportunities
    for (const opportunity of opportunities) {
      optimizedWorkflow = this.applyOptimization(optimizedWorkflow, opportunity);
    }

    const currentDuration = currentWorkflow.reduce((sum, step) => sum + step.duration, 0);
    const optimizedDuration = optimizedWorkflow.reduce((sum, step) => sum + step.duration, 0);

    this.logger.info('Optimized workflow created', {
      optimizedSteps: optimizedWorkflow.length,
      durationReduction: currentDuration - optimizedDuration,
      improvementPercent: ((currentDuration - optimizedDuration) / currentDuration * 100).toFixed(1)
    });

    return optimizedWorkflow;
  }

  /**
   * Generate optimization opportunities based on workflow analysis
   */
  private async generateOptimizationOpportunities(
    workflow: WorkflowStep[],
    bottleneckAnalysis: BottleneckAnalysis,
    workflowAnalysis: AnalyzedWorkflow
  ): Promise<OptimizationOpportunity[]> {
    const opportunities: OptimizationOpportunity[] = [];

    // Automation opportunities for manual steps
    const manualSteps = workflow.filter(step => step.type === 'manual');
    manualSteps.forEach(step => {
      opportunities.push({
        id: `automate_${step.id}`,
        type: 'automation',
        description: `Automate manual step: ${step.name}`,
        affectedSteps: [step.id],
        potentialGains: {
          timeReduction: 0.6,
          costReduction: 0.7,
          qualityImprovement: 0.3,
          errorReduction: 0.8
        },
        implementationEffort: 'medium',
        prerequisites: ['Process standardization', 'Technology platform'],
        risks: ['Implementation complexity', 'User adoption']
      });
    });

    // Parallelization opportunities
    if (workflowAnalysis.parallelizable.length > 1) {
      opportunities.push({
        id: 'parallelize_steps',
        type: 'parallelization',
        description: `Execute ${workflowAnalysis.parallelizable.length} steps in parallel`,
        affectedSteps: workflowAnalysis.parallelizable,
        potentialGains: {
          timeReduction: 0.4,
          costReduction: 0.1,
          qualityImprovement: 0.0,
          errorReduction: 0.0
        },
        implementationEffort: 'low',
        prerequisites: ['Resource availability'],
        risks: ['Coordination complexity']
      });
    }

    // Elimination opportunities for redundant steps
    const redundantSteps = workflow.filter(step =>
      step.name.toLowerCase().includes('duplicate') ||
      step.name.toLowerCase().includes('redundant')
    );

    redundantSteps.forEach(step => {
      opportunities.push({
        id: `eliminate_${step.id}`,
        type: 'elimination',
        description: `Eliminate redundant step: ${step.name}`,
        affectedSteps: [step.id],
        potentialGains: {
          timeReduction: 0.9,
          costReduction: 0.8,
          qualityImprovement: 0.1,
          errorReduction: 0.2
        },
        implementationEffort: 'low',
        prerequisites: ['Impact analysis', 'Stakeholder approval'],
        risks: ['Functionality loss', 'Compliance issues']
      });
    });

    // Consolidation opportunities for related steps
    const stepGroups = this.identifyRelatedSteps(workflow);
    stepGroups.forEach((group, index) => {
      if (group.length > 1) {
        opportunities.push({
          id: `consolidate_group_${index}`,
          type: 'consolidation',
          description: `Consolidate ${group.length} related steps`,
          affectedSteps: group.map(s => s.id),
          potentialGains: {
            timeReduction: 0.3,
            costReduction: 0.4,
            qualityImprovement: 0.2,
            errorReduction: 0.3
          },
          implementationEffort: 'medium',
          prerequisites: ['Process redesign', 'Tool integration'],
          risks: ['Complexity increase', 'Single point of failure']
        });
      }
    });

    // Reordering opportunities based on bottlenecks
    const bottleneckSteps = bottleneckAnalysis.criticalBottlenecks
      .filter(b => b.impact === 'high')
      .map(b => b.step);

    if (bottleneckSteps.length > 0) {
      opportunities.push({
        id: 'reorder_bottlenecks',
        type: 'reordering',
        description: `Reorder workflow to optimize bottleneck steps`,
        affectedSteps: bottleneckSteps,
        potentialGains: {
          timeReduction: 0.25,
          costReduction: 0.15,
          qualityImprovement: 0.1,
          errorReduction: 0.1
        },
        implementationEffort: 'low',
        prerequisites: ['Dependency analysis', 'Testing'],
        risks: ['Logic errors', 'Unexpected dependencies']
      });
    }

    return opportunities;
  }

  /**
   * Create optimization scenarios combining multiple opportunities
   */
  private async createOptimizationScenarios(
    opportunities: OptimizationOpportunity[],
    workflow: WorkflowStep[]
  ): Promise<OptimizationScenario[]> {
    const scenarios: OptimizationScenario[] = [];

    // Quick wins scenario (low-effort opportunities)
    const quickWins = opportunities.filter(opp => opp.implementationEffort === 'low');
    if (quickWins.length > 0) {
      scenarios.push({
        name: 'Quick Wins',
        description: 'Implement low-effort, high-impact improvements',
        changes: quickWins.map(opp => ({
          step: opp.affectedSteps[0],
          changeType: 'modify',
          description: opp.description,
          impact: {
            duration: -opp.potentialGains.timeReduction * 10,
            cost: -opp.potentialGains.costReduction * 1000,
            quality: opp.potentialGains.qualityImprovement,
            risk: 'low'
          }
        })),
        expectedOutcome: {
          timeImprovement: 0.2,
          costSavings: 5000,
          qualityGains: 0.1,
          riskLevel: 'low',
          roi: 2.5,
          paybackPeriod: 6
        },
        confidence: 0.8,
        timeframe: '3 months'
      });
    }

    // Strategic transformation scenario (all opportunities)
    if (opportunities.length > 3) {
      const avgTimeReduction = opportunities.reduce((sum, opp) =>
        sum + opp.potentialGains.timeReduction, 0) / opportunities.length;
      const avgCostReduction = opportunities.reduce((sum, opp) =>
        sum + opp.potentialGains.costReduction, 0) / opportunities.length;

      scenarios.push({
        name: 'Strategic Transformation',
        description: 'Comprehensive optimization across all identified opportunities',
        changes: opportunities.map(opp => ({
          step: opp.affectedSteps[0],
          changeType: 'modify',
          description: opp.description,
          impact: {
            duration: -opp.potentialGains.timeReduction * 15,
            cost: -opp.potentialGains.costReduction * 2000,
            quality: opp.potentialGains.qualityImprovement,
            risk: opp.implementationEffort === 'high' ? 'high' : 'medium'
          }
        })),
        expectedOutcome: {
          timeImprovement: avgTimeReduction,
          costSavings: avgCostReduction * 50000,
          qualityGains: 0.3,
          riskLevel: 'medium',
          roi: 3.5,
          paybackPeriod: 12
        },
        confidence: 0.65,
        timeframe: '12 months'
      });
    }

    // Automation-focused scenario
    const automationOpps = opportunities.filter(opp => opp.type === 'automation');
    if (automationOpps.length > 0) {
      scenarios.push({
        name: 'Automation First',
        description: 'Focus on automating manual processes for maximum efficiency gains',
        changes: automationOpps.map(opp => ({
          step: opp.affectedSteps[0],
          changeType: 'replace',
          description: opp.description,
          impact: {
            duration: -opp.potentialGains.timeReduction * 12,
            cost: -opp.potentialGains.costReduction * 1500,
            quality: opp.potentialGains.qualityImprovement,
            risk: 'medium'
          }
        })),
        expectedOutcome: {
          timeImprovement: 0.5,
          costSavings: 30000,
          qualityGains: 0.4,
          riskLevel: 'medium',
          roi: 3.0,
          paybackPeriod: 9
        },
        confidence: 0.7,
        timeframe: '9 months'
      });
    }

    return scenarios;
  }

  /**
   * Generate prioritized optimization recommendations
   */
  private async generateOptimizationRecommendations(
    opportunities: OptimizationOpportunity[],
    scenarios: OptimizationScenario[],
    objectives: Objective[]
  ): Promise<OptimizationRecommendation[]> {
    const recommendations: OptimizationRecommendation[] = [];

    // High-impact automation recommendation
    const automationOpps = opportunities.filter(opp => opp.type === 'automation');
    if (automationOpps.length > 0) {
      recommendations.push({
        priority: 'high',
        category: 'strategic',
        title: 'Implement Process Automation',
        description: `Automate ${automationOpps.length} manual processes to reduce errors and increase efficiency`,
        benefits: [
          'Reduce processing time by 60%',
          'Decrease error rates by 80%',
          'Free up human resources for higher-value tasks',
          'Improve consistency and quality'
        ],
        implementation: {
          phases: [
            {
              phase: 1,
              name: 'Process Analysis',
              description: 'Detailed analysis of automation candidates',
              duration: 30,
              deliverables: ['Process maps', 'Automation requirements', 'Tool selection'],
              successCriteria: ['Complete process documentation', 'Approved requirements']
            },
            {
              phase: 2,
              name: 'Platform Implementation',
              description: 'Deploy and configure automation platform',
              duration: 45,
              deliverables: ['Configured platform', 'Integration setup', 'Test environment'],
              successCriteria: ['Platform operational', 'Integrations validated']
            },
            {
              phase: 3,
              name: 'Process Migration',
              description: 'Migrate manual processes to automated workflows',
              duration: 60,
              deliverables: ['Automated workflows', 'Documentation', 'Training materials'],
              successCriteria: ['All processes migrated', 'Users trained']
            }
          ],
          duration: 135,
          resources: [
            {
              type: 'technology',
              description: 'Automation platform license',
              quantity: 1,
              duration: 135,
              cost: 25000
            },
            {
              type: 'human',
              description: 'Automation specialists',
              quantity: 2,
              duration: 135,
              cost: 40000
            },
            {
              type: 'training',
              description: 'User training programs',
              quantity: 50,
              duration: 10,
              cost: 5000
            }
          ],
          dependencies: ['Management approval', 'Budget allocation', 'Platform procurement'],
          risks: [
            {
              risk: 'User resistance to change',
              probability: 'medium',
              impact: 'medium',
              mitigation: 'Change management program and stakeholder engagement'
            },
            {
              risk: 'Technical integration complexity',
              probability: 'medium',
              impact: 'high',
              mitigation: 'Proof of concept and phased rollout approach'
            }
          ]
        },
        success_metrics: [
          'Time reduction percentage',
          'Error rate decrease',
          'User satisfaction scores',
          'ROI achievement',
          'Adoption rate'
        ]
      });
    }

    // Quick wins recommendation
    const quickWins = opportunities.filter(opp => opp.implementationEffort === 'low');
    if (quickWins.length > 0) {
      recommendations.push({
        priority: 'critical',
        category: 'quick_win',
        title: 'Implement Quick Wins',
        description: `Execute ${quickWins.length} low-effort, high-impact improvements for immediate results`,
        benefits: [
          'Fast time to value (3 months)',
          'Low implementation risk',
          'Build momentum for larger changes',
          'Demonstrate optimization value'
        ],
        implementation: {
          phases: [
            {
              phase: 1,
              name: 'Quick Assessment',
              description: 'Validate quick win opportunities',
              duration: 14,
              deliverables: ['Validation report', 'Implementation plan'],
              successCriteria: ['All opportunities confirmed']
            },
            {
              phase: 2,
              name: 'Rapid Implementation',
              description: 'Execute quick win changes',
              duration: 60,
              deliverables: ['Implemented changes', 'Monitoring setup'],
              successCriteria: ['All changes deployed', 'Metrics tracking active']
            }
          ],
          duration: 74,
          resources: [
            {
              type: 'human',
              description: 'Process improvement team',
              quantity: 1,
              duration: 74,
              cost: 10000
            }
          ],
          dependencies: ['Stakeholder approval'],
          risks: [
            {
              risk: 'Minimal impact realization',
              probability: 'low',
              impact: 'low',
              mitigation: 'Careful opportunity selection and validation'
            }
          ]
        },
        success_metrics: [
          'Number of improvements implemented',
          'Time reduction achieved',
          'Cost savings realized',
          'Stakeholder satisfaction'
        ]
      });
    }

    // Bottleneck resolution recommendation
    if (opportunities.some(opp => opp.type === 'reordering' || opp.description.includes('bottleneck'))) {
      recommendations.push({
        priority: 'high',
        category: 'strategic',
        title: 'Resolve Critical Bottlenecks',
        description: 'Address workflow bottlenecks through reordering and optimization',
        benefits: [
          'Improve workflow throughput',
          'Reduce wait times',
          'Better resource utilization',
          'Enhanced process reliability'
        ],
        implementation: {
          phases: [
            {
              phase: 1,
              name: 'Bottleneck Analysis',
              description: 'Deep dive into bottleneck root causes',
              duration: 21,
              deliverables: ['Analysis report', 'Resolution plan'],
              successCriteria: ['Root causes identified', 'Solutions validated']
            },
            {
              phase: 2,
              name: 'Process Redesign',
              description: 'Redesign workflow to eliminate bottlenecks',
              duration: 45,
              deliverables: ['Redesigned workflow', 'Implementation guide'],
              successCriteria: ['New workflow approved', 'Testing completed']
            }
          ],
          duration: 66,
          resources: [
            {
              type: 'human',
              description: 'Process engineers',
              quantity: 2,
              duration: 66,
              cost: 20000
            }
          ],
          dependencies: ['Process documentation', 'Stakeholder buy-in'],
          risks: [
            {
              risk: 'Unintended side effects',
              probability: 'medium',
              impact: 'medium',
              mitigation: 'Thorough testing and gradual rollout'
            }
          ]
        },
        success_metrics: [
          'Bottleneck resolution rate',
          'Throughput improvement',
          'Wait time reduction',
          'Process stability metrics'
        ]
      });
    }

    return recommendations;
  }

  /**
   * Assess overall impact of optimization opportunities
   */
  assessOptimizationImpact(
    opportunities: OptimizationOpportunity[],
    scenarios: OptimizationScenario[]
  ): ImpactAssessment {
    const timeImprovement = this.calculateAverageGain(opportunities, 'timeReduction');
    const costReduction = this.calculateAverageGain(opportunities, 'costReduction');
    const qualityGains = this.calculateAverageGain(opportunities, 'qualityImprovement');
    const errorReduction = this.calculateAverageGain(opportunities, 'errorReduction');

    return {
      timeImprovement: {
        currentValue: 100,
        projectedValue: 100 * (1 - timeImprovement),
        improvementPercent: timeImprovement * 100,
        confidence: 0.7,
        timeframe: '6 months'
      },
      costReduction: {
        currentValue: 100000,
        projectedValue: 100000 * (1 - costReduction),
        improvementPercent: costReduction * 100,
        confidence: 0.6,
        timeframe: '12 months'
      },
      qualityGains: {
        currentValue: 0.85,
        projectedValue: 0.85 * (1 + qualityGains),
        improvementPercent: qualityGains * 100,
        confidence: 0.8,
        timeframe: '6 months'
      },
      riskReduction: {
        currentValue: 0.15,
        projectedValue: 0.15 * (1 - errorReduction),
        improvementPercent: errorReduction * 100,
        confidence: 0.75,
        timeframe: '6 months'
      },
      overallValue: (timeImprovement + costReduction + qualityGains + errorReduction) / 4
    };
  }

  /**
   * Calculate average gain across opportunities for a specific metric
   */
  calculateAverageGain(
    opportunities: OptimizationOpportunity[],
    gainType: keyof OptimizationOpportunity['potentialGains']
  ): number {
    if (opportunities.length === 0) return 0;

    const totalGain = opportunities.reduce((sum, opp) => sum + opp.potentialGains[gainType], 0);
    return totalGain / opportunities.length;
  }

  /**
   * Apply optimization to workflow
   */
  applyOptimization(workflow: WorkflowStep[], opportunity: OptimizationOpportunity): WorkflowStep[] {
    const optimized = [...workflow];

    opportunity.affectedSteps.forEach(stepId => {
      const stepIndex = optimized.findIndex(step => step.id === stepId);
      if (stepIndex >= 0) {
        const step = { ...optimized[stepIndex] };

        // Apply optimization gains
        step.duration = Math.max(1, step.duration * (1 - opportunity.potentialGains.timeReduction));

        if (opportunity.type === 'automation') {
          step.type = 'automated';
          step.failureRate = (step.failureRate || 0) * (1 - opportunity.potentialGains.errorReduction);
        }

        if (opportunity.type === 'elimination') {
          // Mark for removal by setting duration to 0
          step.duration = 0;
        }

        optimized[stepIndex] = step;
      }
    });

    // Remove eliminated steps
    return optimized.filter(step => step.duration > 0);
  }

  /**
   * Convert opportunities to process improvements format
   */
  convertOpportunitiesToImprovements(opportunities: OptimizationOpportunity[]): ProcessImprovement[] {
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

  /**
   * Identify groups of related workflow steps
   */
  private identifyRelatedSteps(workflow: WorkflowStep[]): WorkflowStep[][] {
    const groups: WorkflowStep[][] = [];
    const processed = new Set<string>();

    workflow.forEach(step => {
      if (processed.has(step.id)) return;

      const relatedSteps = workflow.filter(s =>
        !processed.has(s.id) &&
        (s.resources.some(r => step.resources.includes(r)) ||
         s.name.split(' ').some(word => step.name.includes(word) && word.length > 4))
      );

      if (relatedSteps.length > 1) {
        groups.push(relatedSteps);
        relatedSteps.forEach(s => processed.add(s.id));
      }
    });

    return groups;
  }

  /**
   * Assess workflow complexity score (0-1)
   */
  assessWorkflowComplexity(workflow: WorkflowStep[]): number {
    const stepCount = workflow.length;
    const totalDependencies = workflow.reduce((sum, step) => sum + step.dependencies.length, 0);
    const complexityScore = (stepCount + totalDependencies) / 20;
    return Math.min(complexityScore, 1);
  }

  /**
   * Assess data quality score (0-1)
   */
  assessDataQuality(workflow: WorkflowStep[], hasMetrics: boolean, hasObjectives: boolean): number {
    let qualityScore = 0.5;

    if (workflow.every(step => step.id && step.name && step.duration !== undefined)) {
      qualityScore += 0.2;
    }

    if (hasMetrics) {
      qualityScore += 0.2;
    }

    if (hasObjectives) {
      qualityScore += 0.1;
    }

    return Math.min(qualityScore, 1);
  }
}
