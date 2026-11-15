/**
 * Migration Planning Service - Implementation Planning and Phasing
 * Extracted from IntegrationStrategyAgent
 */

import type {
  IntegrationApproach,
  ArchitectureOption,
  TimelineConstraint,
  ImplementationPlan
} from '../../../interfaces';

import type {
  ImplementationPhase,
  PhaseDependency
} from '../../types/integration-strategy/templates.types';

export class MigrationPlanningService {
  /**
   * Create implementation plan
   */
  async createImplementationPlan(
    approach: IntegrationApproach,
    option: ArchitectureOption,
    timeline?: TimelineConstraint
  ): Promise<ImplementationPlan> {
    // Create phases based on approach and complexity
    const phases = this.createImplementationPhases(approach, option);

    // Calculate dependencies
    const dependencies = this.identifyPhaseDependencies(phases);

    // Calculate critical path
    const criticalPath = this.calculateCriticalPath(phases, dependencies);

    const totalDuration = phases.reduce((sum, phase) => sum + phase.duration, 0);
    const totalCost = phases.reduce((sum, phase) => sum + phase.cost, 0);

    return {
      phases,
      totalDuration,
      totalCost,
      criticalPath,
      dependencies
    };
  }

  /**
   * Create implementation phases
   */
  createImplementationPhases(
    approach: IntegrationApproach,
    option: ArchitectureOption
  ): ImplementationPhase[] {
    const phases: ImplementationPhase[] = [];

    // Planning phase
    phases.push({
      name: 'Planning and Design',
      description: 'Detailed planning, architecture design, and preparation',
      duration: 30,
      cost: option.estimatedCost * 0.2,
      deliverables: ['Technical specifications', 'Project plan', 'Risk assessment'],
      risks: ['Requirement changes', 'Design approval delays'],
      resources: [
        {
          type: 'human',
          description: 'Solution architect and business analyst',
          quantity: 2,
          duration: 30,
          cost: 15000
        }
      ]
    });

    // Development phase
    phases.push({
      name: 'Development and Configuration',
      description: 'System development, configuration, and unit testing',
      duration: option.implementationTime * 0.6,
      cost: option.estimatedCost * 0.5,
      deliverables: ['Integration components', 'Configuration files', 'Unit tests'],
      risks: ['Technical challenges', 'Integration complexity'],
      resources: [
        {
          type: 'human',
          description: 'Development team',
          quantity: 3,
          duration: option.implementationTime * 0.6,
          cost: option.estimatedCost * 0.4
        }
      ]
    });

    // Testing phase
    phases.push({
      name: 'Testing and Validation',
      description: 'Integration testing, user acceptance testing, and performance validation',
      duration: option.implementationTime * 0.25,
      cost: option.estimatedCost * 0.2,
      deliverables: ['Test results', 'Performance reports', 'User acceptance'],
      risks: ['Test failures', 'Performance issues'],
      resources: [
        {
          type: 'human',
          description: 'QA team and business users',
          quantity: 2,
          duration: option.implementationTime * 0.25,
          cost: option.estimatedCost * 0.15
        }
      ]
    });

    // Deployment phase
    phases.push({
      name: 'Deployment and Go-Live',
      description: 'Production deployment, data migration, and go-live support',
      duration: option.implementationTime * 0.15,
      cost: option.estimatedCost * 0.1,
      deliverables: ['Production deployment', 'Migrated data', 'Go-live support'],
      risks: ['Deployment issues', 'Data migration problems'],
      resources: [
        {
          type: 'human',
          description: 'DevOps and support team',
          quantity: 2,
          duration: option.implementationTime * 0.15,
          cost: option.estimatedCost * 0.05
        }
      ]
    });

    return phases;
  }

  /**
   * Identify phase dependencies
   */
  identifyPhaseDependencies(phases: ImplementationPhase[]): PhaseDependency[] {
    const dependencies: PhaseDependency[] = [];

    for (let i = 0; i < phases.length - 1; i++) {
      dependencies.push({
        fromPhase: phases[i].name,
        toPhase: phases[i + 1].name,
        type: 'blocking',
        description: `${phases[i + 1].name} depends on completion of ${phases[i].name}`
      });
    }

    return dependencies;
  }

  /**
   * Calculate critical path
   */
  calculateCriticalPath(
    phases: ImplementationPhase[],
    dependencies: PhaseDependency[]
  ): string[] {
    // Simplified critical path - all phases in sequence
    return phases.map(phase => phase.name);
  }
}
