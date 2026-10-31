/**
 * Risk Assessment Service - Operational, technical, business, and compliance risk analysis
 * Extracted from ProcessOptimizationAgent for better separation of concerns
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { WorkflowStep, Constraint } from '../../interfaces';
import type {
  RiskAnalysis,
  OperationalRisk,
  TechnicalRisk,
  BusinessRisk,
  ComplianceRisk,
  OptimizationAnalysis
} from '../types/process-optimization';

@injectable()
export class RiskAssessmentService {
  constructor(@inject(TYPES.Logger) private logger: Logger) {}

  /**
   * Assess risks associated with process optimization
   */
  async assessRisks(
    workflow: WorkflowStep[],
    constraints: Constraint[],
    optimizationAnalysis: OptimizationAnalysis
  ): Promise<RiskAnalysis> {
    this.logger.info('Assessing process optimization risks', {
      workflowSteps: workflow.length,
      constraints: constraints.length,
      opportunities: optimizationAnalysis.opportunities.length
    });

    // Assess operational risks
    const operationalRisks = this.assessOperationalRisks(workflow, optimizationAnalysis);

    // Assess technical risks
    const technicalRisks = this.assessTechnicalRisks(optimizationAnalysis);

    // Assess business risks
    const businessRisks = this.assessBusinessRisks(workflow, optimizationAnalysis);

    // Assess compliance risks
    const complianceRisks = this.assessComplianceRisks(constraints);

    // Calculate overall risk score
    const overallRiskScore = this.calculateOverallRiskScore([
      ...operationalRisks,
      ...technicalRisks,
      ...businessRisks
    ]);

    this.logger.info('Risk assessment completed', {
      operationalRisks: operationalRisks.length,
      technicalRisks: technicalRisks.length,
      businessRisks: businessRisks.length,
      complianceRisks: complianceRisks.length,
      overallRiskScore
    });

    return {
      operationalRisks,
      technicalRisks,
      businessRisks,
      complianceRisks,
      overallRiskScore
    };
  }

  /**
   * Assess operational risks (capacity, dependency, quality, timing, resource)
   */
  private assessOperationalRisks(
    workflow: WorkflowStep[],
    optimization: OptimizationAnalysis
  ): OperationalRisk[] {
    const risks: OperationalRisk[] = [];

    // Capacity risk
    const capacityRisk = workflow.length > 20 ? 0.6 : 0.3;
    risks.push({
      type: 'capacity',
      description: 'Risk of capacity constraints during optimization implementation',
      probability: capacityRisk,
      impact: 0.7,
      riskScore: capacityRisk * 0.7,
      currentControls: ['Resource monitoring'],
      recommendedControls: ['Capacity planning', 'Phased rollout']
    });

    // Dependency risk
    const avgDependencies = workflow.reduce((sum, step) => sum + step.dependencies.length, 0) / workflow.length;
    if (avgDependencies > 2) {
      const dependencyRisk = Math.min(avgDependencies / 5, 0.8);
      risks.push({
        type: 'dependency',
        description: `High dependency complexity with average ${avgDependencies.toFixed(1)} dependencies per step`,
        probability: dependencyRisk,
        impact: 0.6,
        riskScore: dependencyRisk * 0.6,
        currentControls: ['Dependency mapping'],
        recommendedControls: ['Dependency decoupling', 'Parallel execution paths']
      });
    }

    // Quality risk
    const manualSteps = workflow.filter(step => step.type === 'manual').length;
    const manualRatio = manualSteps / workflow.length;
    if (manualRatio > 0.4) {
      risks.push({
        type: 'quality',
        description: `${(manualRatio * 100).toFixed(0)}% manual steps pose quality consistency risk`,
        probability: manualRatio,
        impact: 0.5,
        riskScore: manualRatio * 0.5,
        currentControls: ['Manual reviews', 'Quality checks'],
        recommendedControls: ['Automation', 'Standardization', 'Training programs']
      });
    }

    // Timing risk
    const totalDuration = workflow.reduce((sum, step) => sum + step.duration, 0);
    if (totalDuration > 240) { // Over 4 hours
      const timingRisk = Math.min(totalDuration / 480, 0.7);
      risks.push({
        type: 'timing',
        description: `Long process duration (${totalDuration} minutes) increases execution risk`,
        probability: timingRisk,
        impact: 0.6,
        riskScore: timingRisk * 0.6,
        currentControls: ['Time tracking'],
        recommendedControls: ['Process parallelization', 'Duration reduction', 'Checkpoint mechanisms']
      });
    }

    // Resource risk
    const resourceUsage = new Map<string, number>();
    workflow.forEach(step => {
      step.resources.forEach(resource => {
        resourceUsage.set(resource, (resourceUsage.get(resource) || 0) + 1);
      });
    });

    const maxResourceUsage = Math.max(...Array.from(resourceUsage.values()));
    if (maxResourceUsage > workflow.length * 0.5) {
      const resourceRisk = maxResourceUsage / workflow.length;
      risks.push({
        type: 'resource',
        description: 'Resource contention risk due to high resource utilization',
        probability: resourceRisk,
        impact: 0.7,
        riskScore: resourceRisk * 0.7,
        currentControls: ['Resource allocation'],
        recommendedControls: ['Resource pooling', 'Load balancing', 'Capacity expansion']
      });
    }

    return risks;
  }

  /**
   * Assess technical risks (integration, performance, scalability, reliability, security)
   */
  private assessTechnicalRisks(optimization: OptimizationAnalysis): TechnicalRisk[] {
    const risks: TechnicalRisk[] = [];

    // Integration risk for automation
    const automationOpps = optimization.opportunities.filter(opp => opp.type === 'automation');
    if (automationOpps.length > 0) {
      risks.push({
        type: 'integration',
        description: 'Risk of integration issues with automation platforms',
        probability: 0.4,
        impact: 0.8,
        riskScore: 0.32,
        technicalDebt: 0.3,
        mitigation: ['Proof of concept', 'Gradual rollout', 'Rollback procedures']
      });
    }

    // Performance risk for parallelization
    const parallelizationOpps = optimization.opportunities.filter(opp => opp.type === 'parallelization');
    if (parallelizationOpps.length > 0) {
      risks.push({
        type: 'performance',
        description: 'Risk of performance degradation from parallel execution overhead',
        probability: 0.3,
        impact: 0.5,
        riskScore: 0.15,
        technicalDebt: 0.2,
        mitigation: ['Performance testing', 'Resource monitoring', 'Optimization tuning']
      });
    }

    // Scalability risk
    const highEffortOpps = optimization.opportunities.filter(opp => opp.implementationEffort === 'high');
    if (highEffortOpps.length > 2) {
      risks.push({
        type: 'scalability',
        description: `${highEffortOpps.length} high-effort changes may not scale effectively`,
        probability: 0.5,
        impact: 0.6,
        riskScore: 0.3,
        technicalDebt: 0.4,
        mitigation: ['Scalability testing', 'Architecture review', 'Incremental deployment']
      });
    }

    // Reliability risk for elimination
    const eliminationOpps = optimization.opportunities.filter(opp => opp.type === 'elimination');
    if (eliminationOpps.length > 0) {
      risks.push({
        type: 'reliability',
        description: 'Risk of removing critical process steps',
        probability: 0.25,
        impact: 0.9,
        riskScore: 0.225,
        technicalDebt: 0.1,
        mitigation: ['Impact analysis', 'Pilot testing', 'Revert capability']
      });
    }

    // Security risk for consolidation
    const consolidationOpps = optimization.opportunities.filter(opp => opp.type === 'consolidation');
    if (consolidationOpps.length > 0) {
      risks.push({
        type: 'security',
        description: 'Consolidated processes may introduce new security vulnerabilities',
        probability: 0.2,
        impact: 0.8,
        riskScore: 0.16,
        technicalDebt: 0.15,
        mitigation: ['Security audit', 'Access control review', 'Compliance validation']
      });
    }

    return risks;
  }

  /**
   * Assess business risks (market, financial, strategic, regulatory, reputation)
   */
  private assessBusinessRisks(
    workflow: WorkflowStep[],
    optimization: OptimizationAnalysis
  ): BusinessRisk[] {
    const risks: BusinessRisk[] = [];

    // Strategic change management risk
    risks.push({
      type: 'strategic',
      description: 'Risk of user resistance to process changes',
      probability: 0.5,
      impact: 0.6,
      riskScore: 0.3,
      businessImpact: 'Delayed implementation and reduced adoption',
      stakeholderConcerns: ['Job displacement', 'Learning curve', 'Process reliability']
    });

    // Financial risk
    const totalInvestment = optimization.opportunities.reduce((sum, opp) => {
      const cost = opp.implementationEffort === 'high' ? 50000 :
                   opp.implementationEffort === 'medium' ? 25000 : 10000;
      return sum + cost;
    }, 0);

    if (totalInvestment > 100000) {
      risks.push({
        type: 'financial',
        description: `High investment required ($${totalInvestment.toLocaleString()}) for optimization`,
        probability: 0.4,
        impact: 0.7,
        riskScore: 0.28,
        businessImpact: 'Budget overrun and ROI timeline extension',
        stakeholderConcerns: ['Budget approval', 'Cash flow', 'Payback period']
      });
    }

    // Market timing risk
    if (optimization.opportunities.length > 5) {
      risks.push({
        type: 'market',
        description: 'Extended implementation may miss market opportunities',
        probability: 0.3,
        impact: 0.5,
        riskScore: 0.15,
        businessImpact: 'Competitive disadvantage during transition',
        stakeholderConcerns: ['Time to market', 'Competitive position']
      });
    }

    // Regulatory compliance risk
    const regulatoryImpact = workflow.filter(step =>
      step.name.toLowerCase().includes('compliance') ||
      step.name.toLowerCase().includes('audit')
    ).length;

    if (regulatoryImpact > 0) {
      risks.push({
        type: 'regulatory',
        description: `Changes may affect ${regulatoryImpact} compliance-related steps`,
        probability: 0.35,
        impact: 0.85,
        riskScore: 0.2975,
        businessImpact: 'Potential regulatory violations or audit failures',
        stakeholderConcerns: ['Regulatory approval', 'Audit trail', 'Documentation']
      });
    }

    // Reputation risk
    const customerFacingSteps = workflow.filter(step =>
      step.name.toLowerCase().includes('customer') ||
      step.name.toLowerCase().includes('client')
    ).length;

    if (customerFacingSteps > 0) {
      risks.push({
        type: 'reputation',
        description: `Changes affect ${customerFacingSteps} customer-facing processes`,
        probability: 0.25,
        impact: 0.75,
        riskScore: 0.1875,
        businessImpact: 'Customer satisfaction and brand reputation at risk',
        stakeholderConcerns: ['Customer experience', 'Service quality', 'Brand image']
      });
    }

    return risks;
  }

  /**
   * Assess compliance risks based on regulatory constraints
   */
  private assessComplianceRisks(constraints: Constraint[]): ComplianceRisk[] {
    const risks: ComplianceRisk[] = [];

    constraints.forEach(constraint => {
      if (constraint.type === 'regulatory') {
        risks.push({
          regulation: constraint.description,
          requirement: 'Process optimization must maintain compliance',
          currentCompliance: 0.9,
          requiredCompliance: 1.0,
          riskLevel: 'medium',
          remediation: ['Compliance review', 'Legal approval', 'Documentation updates']
        });
      }

      // Quality standards may be covered under technical or resource constraints
      if (constraint.type === 'technical') {
        risks.push({
          regulation: 'Technical Standards',
          requirement: constraint.description,
          currentCompliance: 0.85,
          requiredCompliance: 0.95,
          riskLevel: 'medium',
          remediation: ['Technical audits', 'Process validation', 'System upgrades']
        });
      }

      // Security requirements may be covered under technical or regulatory constraints
      if (constraint.type === 'resource') {
        risks.push({
          regulation: 'Resource Requirements',
          requirement: constraint.description,
          currentCompliance: 0.95,
          requiredCompliance: 1.0,
          riskLevel: 'low',
          remediation: ['Resource assessment', 'Capacity planning', 'Resource allocation review']
        });
      }
    });

    return risks;
  }

  /**
   * Calculate overall risk score (0-10 scale)
   */
  private calculateOverallRiskScore(risks: (OperationalRisk | TechnicalRisk | BusinessRisk)[]): number {
    if (risks.length === 0) return 0;

    const totalRiskScore = risks.reduce((sum, risk) => sum + risk.riskScore, 0);
    return (totalRiskScore / risks.length) * 10; // Scale to 0-10
  }

  /**
   * Convert probability number to string category
   */
  convertProbabilityToString(probability: number): 'low' | 'medium' | 'high' {
    if (probability < 0.3) return 'low';
    if (probability < 0.7) return 'medium';
    return 'high';
  }

  /**
   * Convert impact number to string category
   */
  convertImpactToString(impact: number): 'low' | 'medium' | 'high' {
    if (impact < 0.3) return 'low';
    if (impact < 0.7) return 'medium';
    return 'high';
  }
}
