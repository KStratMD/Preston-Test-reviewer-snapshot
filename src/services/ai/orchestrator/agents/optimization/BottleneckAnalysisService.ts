/**
 * Bottleneck Analysis Service
 * Extracted from ProcessOptimizationAgent.ts - October 27, 2025
 *
 * Provides bottleneck identification and analysis capabilities using both
 * AI-enhanced detection and heuristic fallback methods.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import { ProviderRegistry } from '../../../ProviderRegistry';
import type { WorkflowStep, Bottleneck } from '../../interfaces';
import type {
  BottleneckAnalysis,
  AnalyzedWorkflow,
  CapacityAnalysis,
  QueueAnalysis,
  ResourceConstraint
} from '../types/process-optimization/optimization.types';

@injectable()
export class BottleneckAnalysisService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ProviderRegistry) private providerRegistry: ProviderRegistry
  ) {}

  /**
   * Main bottleneck identification method
   * Uses AI-first approach with heuristic fallback
   */
  async identifyBottlenecks(
    workflow: WorkflowStep[],
    workflowAnalysis: AnalyzedWorkflow
  ): Promise<BottleneckAnalysis> {
    // AI-FIRST APPROACH: Try AI-enhanced bottleneck detection
    try {
      const aiResult = await this.identifyBottlenecksWithAI(workflow, workflowAnalysis);
      if (aiResult) {
        this.logger.info('Using AI-enhanced bottleneck detection', {
          bottlenecksFound: aiResult.criticalBottlenecks.length,
          aiConfidence: 0.85
        });
        return aiResult;
      }
    } catch (error) {
      this.logger.warn('AI bottleneck detection unavailable, using heuristic fallback', {
        error: String(error)
      });
    }

    // FALLBACK: Use heuristic methods
    const criticalBottlenecks: Bottleneck[] = [];

    // Identify duration-based bottlenecks
    const durationBottlenecks = this.identifyDurationBottlenecks(workflow);
    criticalBottlenecks.push(...durationBottlenecks);

    // Identify resource bottlenecks
    const resourceBottlenecks = this.identifyResourceBottlenecks(workflow);
    criticalBottlenecks.push(...resourceBottlenecks);

    // Identify failure rate bottlenecks
    const failureBottlenecks = this.identifyFailureBottlenecks(workflow);
    criticalBottlenecks.push(...failureBottlenecks);

    // Analyze capacity
    const capacity = this.analyzeCapacity(workflow);

    // Analyze queuing
    const queueAnalysis = this.analyzeQueuing(workflow);

    // Analyze resource constraints
    const resourceConstraints = this.analyzeResourceConstraints(workflow);

    return {
      criticalBottlenecks,
      capacity,
      queueAnalysis,
      resourceConstraints
    };
  }

  /**
   * AI-Enhanced Bottleneck Detection
   * Uses AI provider for intelligent bottleneck identification
   */
  private async identifyBottlenecksWithAI(
    workflow: WorkflowStep[],
    workflowAnalysis: AnalyzedWorkflow
  ): Promise<BottleneckAnalysis | null> {
    try {
      // Check if AI provider available
      const providerResult = await (this.providerRegistry as any).getAvailableProvider();
      if (!providerResult) {
        this.logger.debug('No AI provider available for bottleneck detection');
        return null;
      }

      const { provider, id: providerId } = providerResult;

      // Build AI prompt for bottleneck analysis
      const prompt = this.buildBottleneckDetectionPrompt(workflow, workflowAnalysis);

      // Call AI provider
      const aiResponse = await provider.complete({
        prompt,
        maxTokens: 2000,
        temperature: 0.3,
        stopSequences: []
      });

      // Parse AI response
      const aiBottlenecks = this.parseAIBottleneckResponse(aiResponse.completion);

      // Combine AI bottlenecks with heuristic validation
      const heuristicValidation = await this.validateAIBottlenecksWithHeuristics(
        aiBottlenecks,
        workflow
      );

      // Analyze capacity (use heuristic - no AI needed)
      const capacity = this.analyzeCapacity(workflow);

      // Analyze queuing (use heuristic)
      const queueAnalysis = this.analyzeQueuing(workflow);

      // Analyze resource constraints (use heuristic)
      const resourceConstraints = this.analyzeResourceConstraints(workflow);

      this.logger.info('AI bottleneck detection completed', {
        provider: providerId,
        aiBottlenecks: aiBottlenecks.length,
        validatedBottlenecks: heuristicValidation.length,
        combinedTotal: heuristicValidation.length
      });

      return {
        criticalBottlenecks: heuristicValidation,
        capacity,
        queueAnalysis,
        resourceConstraints
      };

    } catch (error) {
      this.logger.error('AI bottleneck detection failed', { error: String(error) });
      return null;
    }
  }

  /**
   * Build prompt for AI bottleneck detection
   */
  private buildBottleneckDetectionPrompt(workflow: WorkflowStep[], analysis: AnalyzedWorkflow): string {
    const workflowJson = JSON.stringify(workflow.map(step => ({
      id: step.id,
      name: step.name,
      type: step.type,
      duration: step.duration,
      resources: step.resources,
      dependencies: step.dependencies,
      failureRate: step.failureRate
    })), null, 2);

    return `You are a process optimization expert analyzing a workflow for bottlenecks.

**Workflow Analysis Summary:**
- Total Steps: ${analysis.totalSteps}
- Critical Path: ${analysis.criticalPath.join(' → ')}
- Total Duration: ${analysis.totalDuration} minutes
- Complexity: ${analysis.complexity}
- Parallelizable Steps: ${analysis.parallelizable.length}

**Workflow Details:**
${workflowJson}

**Task:** Identify critical bottlenecks in this workflow. For each bottleneck:
1. Specify the step ID
2. Describe the bottleneck issue
3. Assess impact (low, medium, high)
4. Identify root cause
5. Suggest solution
6. Estimate resolution time/effort

**Format your response as a JSON array:**
[
  {
    "step": "step_id",
    "description": "Clear description of the bottleneck",
    "impact": "low|medium|high",
    "rootCause": "Root cause analysis",
    "suggestedSolution": "Recommended solution",
    "estimatedResolution": "Expected improvement",
    "confidence": 0.8
  }
]

Respond ONLY with the JSON array. No additional text.`;
  }

  /**
   * Parse AI response to extract bottlenecks
   */
  private parseAIBottleneckResponse(aiResponse: string): Bottleneck[] {
    try {
      // Extract JSON from response
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        this.logger.warn('AI response does not contain valid JSON array');
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter(item => item.step && item.description)
        .map(item => ({
          step: item.step,
          description: item.description,
          impact: item.impact || 'medium',
          rootCause: item.rootCause || 'Unknown',
          suggestedSolution: item.suggestedSolution || 'Review and optimize',
          estimatedResolution: item.estimatedResolution || 'Requires analysis',
          aiConfidence: item.confidence || 0.7
        }));

    } catch (error) {
      this.logger.error('Failed to parse AI bottleneck response', { error: String(error) });
      return [];
    }
  }

  /**
   * Validate AI-detected bottlenecks using heuristics
   */
  private async validateAIBottlenecksWithHeuristics(
    aiBottlenecks: Bottleneck[],
    workflow: WorkflowStep[]
  ): Promise<Bottleneck[]> {
    const validatedBottlenecks: Bottleneck[] = [];

    // Run heuristic methods
    const durationBottlenecks = this.identifyDurationBottlenecks(workflow);
    const resourceBottlenecks = this.identifyResourceBottlenecks(workflow);
    const failureBottlenecks = this.identifyFailureBottlenecks(workflow);

    const allHeuristicBottlenecks = [
      ...durationBottlenecks,
      ...resourceBottlenecks,
      ...failureBottlenecks
    ];

    // Validate AI bottlenecks
    for (const aiBottleneck of aiBottlenecks) {
      // Check if heuristics confirm this bottleneck
      const heuristicConfirmation = allHeuristicBottlenecks.find(
        hb => hb.step === aiBottleneck.step
      );

      if (heuristicConfirmation) {
        // AI and heuristics agree - use AI description with heuristic confirmation
        validatedBottlenecks.push({
          ...aiBottleneck,
          description: `${aiBottleneck.description} (Confirmed by statistical analysis)`,
          confidence: 0.9
        });
      } else {
        // Only AI detected - include with lower confidence
        validatedBottlenecks.push({
          ...aiBottleneck,
          confidence: 0.7
        });
      }
    }

    // Add heuristic-only bottlenecks (AI might have missed these)
    for (const heuristicBottleneck of allHeuristicBottlenecks) {
      const alreadyIncluded = validatedBottlenecks.some(
        vb => vb.step === heuristicBottleneck.step
      );

      if (!alreadyIncluded) {
        validatedBottlenecks.push({
          ...heuristicBottleneck,
          confidence: 0.75
        });
      }
    }

    return validatedBottlenecks;
  }

  /**
   * Identify duration-based bottlenecks (heuristic)
   */
  private identifyDurationBottlenecks(workflow: WorkflowStep[]): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];
    const avgDuration = workflow.reduce((sum, step) => sum + step.duration, 0) / workflow.length;

    workflow.forEach(step => {
      if (step.duration > avgDuration * 2) {
        bottlenecks.push({
          step: step.id,
          description: `Step takes ${step.duration} minutes, significantly above average ${avgDuration.toFixed(1)}`,
          impact: 'high',
          rootCause: 'Long processing time',
          suggestedSolution: 'Consider automation or process simplification',
          estimatedResolution: `Reduce duration by ${Math.round((step.duration - avgDuration) * 0.6)} minutes`
        });
      }
    });

    return bottlenecks;
  }

  /**
   * Identify resource bottlenecks (heuristic)
   */
  private identifyResourceBottlenecks(workflow: WorkflowStep[]): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];
    const resourceUsage = new Map<string, number>();

    // Count resource usage
    workflow.forEach(step => {
      step.resources.forEach(resource => {
        resourceUsage.set(resource, (resourceUsage.get(resource) || 0) + 1);
      });
    });

    // Identify overused resources
    resourceUsage.forEach((usage, resource) => {
      if (usage > workflow.length * 0.6) { // Used in >60% of steps
        bottlenecks.push({
          step: resource,
          description: `Resource ${resource} is used in ${usage} out of ${workflow.length} steps`,
          impact: 'medium',
          rootCause: 'Resource overutilization',
          suggestedSolution: 'Consider resource pooling or alternative resources',
          estimatedResolution: 'Add additional resource capacity'
        });
      }
    });

    return bottlenecks;
  }

  /**
   * Identify failure rate bottlenecks (heuristic)
   */
  private identifyFailureBottlenecks(workflow: WorkflowStep[]): Bottleneck[] {
    const bottlenecks: Bottleneck[] = [];

    workflow.forEach(step => {
      if (step.failureRate && step.failureRate > 0.1) { // >10% failure rate
        bottlenecks.push({
          step: step.id,
          description: `Step has ${(step.failureRate * 100).toFixed(1)}% failure rate`,
          impact: 'high',
          rootCause: 'High failure rate causing rework',
          suggestedSolution: 'Improve process reliability and error handling',
          estimatedResolution: `Reduce failure rate to <5% through process improvements`
        });
      }
    });

    return bottlenecks;
  }

  /**
   * Analyze capacity
   */
  private analyzeCapacity(workflow: WorkflowStep[]): CapacityAnalysis {
    const totalDuration = workflow.reduce((sum, step) => sum + step.duration, 0);
    const workingHoursPerDay = 8 * 60; // 8 hours in minutes

    return {
      currentCapacity: workingHoursPerDay,
      requiredCapacity: totalDuration,
      utilizationRate: totalDuration / workingHoursPerDay,
      peakLoad: Math.max(...workflow.map(step => step.duration)),
      averageLoad: totalDuration / workflow.length,
      capacityGap: Math.max(0, totalDuration - workingHoursPerDay)
    };
  }

  /**
   * Analyze queuing
   */
  private analyzeQueuing(workflow: WorkflowStep[]): QueueAnalysis {
    // Simplified queuing analysis
    const totalSteps = workflow.length;
    const avgDuration = workflow.reduce((sum, step) => sum + step.duration, 0) / totalSteps;

    return {
      averageQueueLength: totalSteps * 0.3, // Estimated
      maxQueueLength: totalSteps,
      averageWaitTime: avgDuration * 0.2, // Estimated wait time
      queueingDelay: avgDuration * 0.1,
      serviceRate: 60 / avgDuration, // Services per hour
      arrivalRate: 50 // Estimated arrivals per hour
    };
  }

  /**
   * Analyze resource constraints
   */
  private analyzeResourceConstraints(workflow: WorkflowStep[]): ResourceConstraint[] {
    const constraints: ResourceConstraint[] = [];
    const resourceUsage = new Map<string, number>();

    // Analyze resource usage patterns
    workflow.forEach(step => {
      step.resources.forEach(resource => {
        resourceUsage.set(resource, (resourceUsage.get(resource) || 0) + step.duration);
      });
    });

    resourceUsage.forEach((totalDuration, resource) => {
      const utilizationRate = totalDuration / (8 * 60); // 8 hour day

      constraints.push({
        resource,
        type: this.classifyResourceType(resource),
        currentUsage: totalDuration,
        maxCapacity: 8 * 60, // 8 hours
        utilizationRate,
        isBottleneck: utilizationRate > 0.8,
        scalability: this.assessResourceScalability(resource)
      });
    });

    return constraints;
  }

  /**
   * Classify resource type
   */
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

  /**
   * Assess resource scalability
   */
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
}
