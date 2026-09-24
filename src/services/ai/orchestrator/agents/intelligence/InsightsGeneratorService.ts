/**
 * Insights Generator Service
 *
 * Handles generation of executive summaries, actionable insights,
 * risk assessments, and prioritized recommendations for the BusinessIntelligenceAgent.
 *
 * Responsibilities:
 * - Executive summary generation
 * - Actionable insights from analysis results
 * - Enhanced risk assessment compilation
 * - Prioritized recommendations
 * - Implementation plan conversion
 * - Risk mitigation strategies
 * - Risk matrix generation
 * - Compliance risk summaries
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type {
  BusinessImpactAnalysis,
  ComplianceValidationResult,
  ROICalculation,
  ExecutiveSummary,
  KeyFinding,
  BusinessValueSummary,
  ActionableInsight,
  EnhancedRiskAssessment,
  RiskCategoryAssessment,
  PrioritizedRecommendation,
  ImplementationPlan,
  ImplementationPhase,
  ResourceRequirement,
  Milestone,
  MitigationStrategy,
  RiskMatrixEntry,
  ComplianceRiskSummary,
  OrganizationProfile
} from '../types/business-intelligence';
import { MetricsCalculationService } from './MetricsCalculationService';

@injectable()
export class InsightsGeneratorService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.MetricsCalculationService) private metricsService: MetricsCalculationService
  ) {
    this.logger.debug('InsightsGeneratorService initialized');
  }

  /**
   * Generate executive summary from analysis results
   * Combines business impact, ROI, and compliance into high-level summary
   *
   * @param businessImpact - Business impact analysis results
   * @param roi - ROI calculation results
   * @param compliance - Compliance validation results
   * @param orgProfile - Organization profile
   * @returns Executive summary
   */
  async generateExecutiveSummary(
    businessImpact?: BusinessImpactAnalysis,
    roi?: ROICalculation,
    compliance?: ComplianceValidationResult,
    orgProfile?: OrganizationProfile
  ): Promise<ExecutiveSummary> {
    const overallScore = this.metricsService.calculateOverallScore(businessImpact, compliance);

    const keyFindings: KeyFinding[] = [];

    // Generate key findings from business impact
    if (businessImpact && businessImpact.businessValue) {
      const currentState = businessImpact.businessValue.currentState as any;
      const monetaryImpact = businessImpact.businessValue.monetaryImpact as any;

      keyFindings.push({
        category: 'opportunity',
        title: 'Data Quality Improvement Opportunity',
        description: `Current data quality score of ${Math.round(currentState.dataQualityScore * 100)}% presents significant improvement potential`,
        impact: currentState.dataQualityScore < 0.7 ? 'high' : 'medium',
        quantification: monetaryImpact.annualSavings,
        timeframe: '12-18 months'
      });
    }

    // Generate key findings from compliance
    if (compliance) {
      keyFindings.push({
        category: 'compliance',
        title: 'Regulatory Compliance Status',
        description: `Overall compliance level at ${Math.round(compliance.overallCompliance * 100)}%`,
        impact: compliance.overallCompliance < 0.8 ? 'high' : 'medium',
        timeframe: '6-12 months'
      });
    }

    // Calculate business value summary
    const businessValue: BusinessValueSummary = this.calculateBusinessValueSummary(
      businessImpact,
      compliance
    );

    return {
      overallScore,
      keyFindings,
      businessValue,
      riskLevel: this.metricsService.determineOverallRiskLevel(businessImpact, compliance),
      recommendedActions: this.metricsService.generateRecommendedActions(businessImpact, compliance),
      timeToValue: 12, // months
      investmentRequired: this.extractInvestmentCost(businessImpact) || 100000,
      projectedROI: this.extractProjectedROI(roi)
    };
  }

  /**
   * Generate actionable insights from analysis results
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @param orgProfile - Organization profile
   * @returns Array of actionable insights
   */
  async generateActionableInsights(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult,
    orgProfile?: OrganizationProfile
  ): Promise<ActionableInsight[]> {
    const insights: ActionableInsight[] = [];

    // Generate insights from business impact recommendations
    if (businessImpact && businessImpact.recommendations) {
      const recommendations = businessImpact.recommendations as {
        priority: string;
        category: string;
        title: string;
        description: string;
        businessJustification: string;
        implementationSteps: string[];
        estimatedROI: number;
        riskLevel: 'low' | 'medium' | 'high';
        resourceRequirements: ResourceRequirement[];
        dependsOn: string[];
      }[];

      for (const recommendation of recommendations) {
        insights.push({
          insightId: `insight-${recommendation.priority}-${Date.now()}`,
          category: recommendation.category as any,
          title: recommendation.title,
          description: recommendation.description,
          businessImpact: recommendation.businessJustification,
          implementationEffort: this.metricsService.mapEffortLevel(recommendation.resourceRequirements),
          timeToImplement: this.metricsService.calculateImplementationTime(recommendation.implementationSteps),
          estimatedCost: recommendation.resourceRequirements.reduce((sum, req) => sum + req.cost, 0),
          expectedBenefit: recommendation.estimatedROI * 1000, // Convert to dollars
          riskLevel: recommendation.riskLevel,
          dependencies: recommendation.dependsOn,
          successMetrics: [`ROI > ${recommendation.estimatedROI}%`, 'Implementation completed on time']
        });
      }
    }

    // Generate insights from compliance recommendations
    if (compliance && compliance.recommendations) {
      const recommendations = compliance.recommendations as {
        title: string;
        description: string;
        regulation: string;
        riskReduction: number;
        implementation: {
          phases: {
            name: string;
            description: string;
            duration: number;
            cost: number;
            deliverables: string[];
            dependencies: string[];
          }[];
          totalDuration: number;
          totalCost: number;
          dependencies: string[];
          successMetrics: string[];
        };
      }[];

      for (const recommendation of recommendations) {
        insights.push({
          insightId: `compliance-insight-${Date.now()}`,
          category: 'compliance',
          title: recommendation.title,
          description: recommendation.description,
          businessImpact: `Reduces compliance risk for ${recommendation.regulation}`,
          implementationEffort: recommendation.implementation.phases.length > 2 ? 'high' : 'medium',
          timeToImplement: recommendation.implementation.totalDuration,
          estimatedCost: recommendation.implementation.totalCost,
          expectedBenefit: recommendation.riskReduction * 100000, // Risk reduction value
          riskLevel: 'medium',
          dependencies: recommendation.implementation.dependencies,
          successMetrics: recommendation.implementation.successMetrics
        });
      }
    }

    return insights;
  }

  /**
   * Generate enhanced risk assessment
   * Combines operational, compliance, and other risk categories
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @param orgProfile - Organization profile
   * @returns Enhanced risk assessment
   */
  async generateEnhancedRiskAssessment(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult,
    orgProfile?: OrganizationProfile
  ): Promise<EnhancedRiskAssessment> {
    const riskCategories: RiskCategoryAssessment[] = [
      {
        category: 'operational',
        currentRiskLevel: this.extractOperationalRiskLevel(businessImpact),
        targetRiskLevel: 'low',
        likelihood: 0.6,
        impact: 0.7,
        riskScore: this.metricsService.calculateRiskScore(0.6, 0.7),
        trends: 'stable',
        keyRiskFactors: ['Data quality issues', 'Process inefficiencies']
      },
      {
        category: 'compliance',
        currentRiskLevel: compliance && compliance.overallCompliance < 0.8 ? 'high' : 'medium',
        targetRiskLevel: 'low',
        likelihood: compliance ? (1 - compliance.overallCompliance) : 0.3,
        impact: 0.9,
        riskScore: compliance ? Math.round((1 - compliance.overallCompliance) * 90) : 27,
        trends: 'improving',
        keyRiskFactors: this.extractComplianceCriticalIssues(compliance)
      }
    ];

    const overallRiskScore = Math.round(
      riskCategories.reduce((sum, cat) => sum + cat.riskScore, 0) / riskCategories.length
    );

    return {
      overallRiskScore,
      riskCategories,
      mitigationStrategies: this.generateMitigationStrategies(riskCategories),
      riskMatrix: this.generateRiskMatrix(businessImpact, compliance),
      complianceRisks: this.generateComplianceRiskSummary(compliance)
    };
  }

  /**
   * Generate prioritized recommendations
   * Combines and prioritizes recommendations from all analysis sources
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @param insights - Actionable insights
   * @returns Array of prioritized recommendations
   */
  async generatePrioritizedRecommendations(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult,
    insights?: ActionableInsight[]
  ): Promise<PrioritizedRecommendation[]> {
    const recommendations: PrioritizedRecommendation[] = [];

    // Generate recommendations from business impact
    if (businessImpact && businessImpact.recommendations) {
      const biRecommendations = businessImpact.recommendations as {
        priority: 'critical' | 'high' | 'medium' | 'low';
        title: string;
        description: string;
        businessJustification: string;
        estimatedROI: number;
        implementationTimeframe: string;
        riskLevel: 'low' | 'medium' | 'high';
        dependsOn: string[];
        resourceRequirements?: ResourceRequirement[];
        implementationSteps?: string[];
      }[];

      for (const rec of biRecommendations) {
        recommendations.push({
          recommendationId: `bi-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`,
          priority: rec.priority,
          category: this.metricsService.mapTimeframe(rec.implementationTimeframe),
          title: rec.title,
          description: rec.description,
          businessJustification: rec.businessJustification,
          expectedOutcome: `ROI of ${rec.estimatedROI}% expected within ${rec.implementationTimeframe}`,
          implementationPlan: this.convertToImplementationPlan(rec),
          successCriteria: [`Achieve ${rec.estimatedROI}% ROI`, 'Complete implementation on schedule'],
          riskConsiderations: [`Implementation risk: ${rec.riskLevel}`, 'Resource availability'],
          dependencies: rec.dependsOn
        });
      }
    }

    // Generate recommendations from compliance
    if (compliance && compliance.recommendations) {
      const compRecommendations = compliance.recommendations as {
        priority: 'critical' | 'high' | 'medium' | 'low';
        title: string;
        description: string;
        regulation: string;
        riskReduction: number;
        implementation: {
          phases: {
            name: string;
            description: string;
            duration: number;
            cost: number;
            deliverables: string[];
            dependencies: string[];
          }[];
          totalDuration: number;
          totalCost: number;
          resourceRequirements: {
            type: string;
            description: string;
            quantity: number;
            duration: number;
            cost: number;
            skills?: string[];
          }[];
          dependencies: string[];
          successMetrics: string[];
        };
      }[];

      for (const rec of compRecommendations) {
        recommendations.push({
          recommendationId: `comp-${Date.now()}-${Math.random().toString(36).slice(2, 2 + 9)}`,
          priority: rec.priority,
          category: 'short-term',
          title: rec.title,
          description: rec.description,
          businessJustification: `Improve ${rec.regulation} compliance and reduce regulatory risk`,
          expectedOutcome: `${Math.round(rec.riskReduction * 100)}% risk reduction for ${rec.regulation}`,
          implementationPlan: {
            phases: rec.implementation.phases.map((phase, index) => ({
              phaseNumber: index + 1,
              name: phase.name,
              description: phase.description,
              duration: phase.duration,
              cost: phase.cost,
              deliverables: phase.deliverables,
              dependencies: phase.dependencies,
              riskLevel: 'medium' as const
            })),
            totalDuration: rec.implementation.totalDuration,
            totalCost: rec.implementation.totalCost,
            resourceRequirements: rec.implementation.resourceRequirements.map(req => ({
              type: (req.type as 'human' | 'technical' | 'financial' | 'vendor'),
              description: req.description,
              quantity: req.quantity,
              duration: req.duration,
              cost: req.cost,
              skillsRequired: req.skills || []
            })),
            milestones: rec.implementation.phases.map(phase => ({
              name: `Complete ${phase.name}`,
              targetDate: new Date(Date.now() + phase.duration * 24 * 60 * 60 * 1000),
              description: phase.description,
              successCriteria: phase.deliverables,
              dependencies: phase.dependencies
            })),
            riskMitigation: ['Regular progress reviews', 'Stakeholder engagement', 'Change management']
          },
          successCriteria: rec.implementation.successMetrics,
          riskConsiderations: ['Regulatory timeline pressure', 'Resource allocation'],
          dependencies: rec.implementation.dependencies
        });
      }
    }

    // Sort by priority and potential impact
    return recommendations.sort((a, b) => {
      const priorityOrder = { 'critical': 4, 'high': 3, 'medium': 2, 'low': 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  /**
   * Convert recommendation to implementation plan
   *
   * @param recommendation - Recommendation object
   * @returns Implementation plan
   */
  private convertToImplementationPlan(recommendation: {
    description: string;
    resourceRequirements?: ResourceRequirement[];
    implementationSteps?: string[];
    dependsOn?: string[];
    riskLevel?: 'low' | 'medium' | 'high';
    title: string;
  }): ImplementationPlan {
    const calculateCost = (resources: ResourceRequirement[] | undefined): number => {
      if (!resources) return 100000;
      return resources.reduce((sum, req) => sum + (req.cost * req.quantity), 0);
    };

    return {
      phases: [{
        phaseNumber: 1,
        name: 'Implementation',
        description: recommendation.description,
        duration: 90,
        cost: calculateCost(recommendation.resourceRequirements),
        deliverables: recommendation.implementationSteps || [],
        dependencies: recommendation.dependsOn || [],
        riskLevel: recommendation.riskLevel || 'medium'
      }],
      totalDuration: 90,
      totalCost: calculateCost(recommendation.resourceRequirements),
      resourceRequirements: (recommendation.resourceRequirements || []).map((req) => ({
        type: req.type,
        description: req.description,
        quantity: req.quantity,
        duration: req.duration,
        cost: req.cost,
        skillsRequired: req.skillsRequired || []
      })),
      milestones: [{
        name: 'Implementation Complete',
        targetDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        description: 'Complete implementation of recommendation',
        successCriteria: [recommendation.title],
        dependencies: recommendation.dependsOn || []
      }],
      riskMitigation: ['Regular monitoring', 'Stakeholder communication']
    };
  }

  /**
   * Generate mitigation strategies for risk categories
   *
   * @param categories - Risk category assessments
   * @returns Array of mitigation strategies
   */
  private generateMitigationStrategies(categories: RiskCategoryAssessment[]): MitigationStrategy[] {
    return categories.map(cat => ({
      riskCategory: cat.category,
      strategy: `Implement controls to reduce ${cat.category} risk`,
      effectiveness: 0.7,
      implementationCost: 50000,
      timeToImplement: 60,
      resourceRequirements: ['Risk management team', 'Technical resources'],
      dependencies: ['Management approval', 'Resource allocation']
    }));
  }

  /**
   * Generate risk matrix from analysis results
   *
   * @param businessImpact - Business impact analysis
   * @param compliance - Compliance validation
   * @returns Array of risk matrix entries
   */
  private generateRiskMatrix(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult
  ): RiskMatrixEntry[] {
    const entries: RiskMatrixEntry[] = [];

    if (businessImpact && businessImpact.riskAssessment) {
      const riskAssessment = businessImpact.riskAssessment as any;
      if (riskAssessment.riskCategories) {
        for (const risk of riskAssessment.riskCategories) {
          entries.push({
            riskId: `risk-${risk.category}`,
            description: risk.description,
            likelihood: this.metricsService.mapLikelihood(risk.likelihood),
            impact: this.metricsService.mapImpact(risk.impact),
            riskScore: risk.riskScore,
            currentControls: ['Monitoring', 'Documentation'],
            additionalControls: [`Enhanced ${risk.category} controls`]
          });
        }
      }
    }

    return entries;
  }

  /**
   * Generate compliance risk summary
   *
   * @param compliance - Compliance validation results
   * @returns Array of compliance risk summaries
   */
  private generateComplianceRiskSummary(compliance?: ComplianceValidationResult): ComplianceRiskSummary[] {
    if (!compliance || !compliance.regulations) return [];

    const regulations = compliance.regulations as {
      regulation: string;
      complianceScore: number;
      gaps: { severity?: string; description: string }[];
      estimatedFineExposure: number;
    }[];

    return regulations.map((reg) => ({
      regulation: reg.regulation.toString(),
      currentComplianceLevel: reg.complianceScore,
      targetComplianceLevel: 0.95,
      gaps: reg.gaps.length,
      estimatedFineRisk: reg.estimatedFineExposure,
      priorityActions: reg.gaps
        .filter((gap) => gap.severity === 'critical' || gap.severity === 'high')
        .map((gap) => gap.description)
        .slice(0, 3)
    }));
  }

  // Private helper methods

  private calculateBusinessValueSummary(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult
  ): BusinessValueSummary {
    const defaultValues = {
      currentStateScore: 75,
      potentialImprovementScore: 25,
      annualSavingsOpportunity: 0,
      revenueUpliftOpportunity: 0,
      efficiencyGains: 15,
      riskReduction: 20
    };

    if (!businessImpact || !businessImpact.businessValue) {
      return defaultValues;
    }

    const businessValue = businessImpact.businessValue as any;
    const currentState = businessValue.currentState || {};
    const potentialImprovements = businessValue.potentialImprovements || {};
    const monetaryImpact = businessValue.monetaryImpact || {};

    return {
      currentStateScore: currentState.dataQualityScore ?
        Math.round(currentState.dataQualityScore * 100) : defaultValues.currentStateScore,
      potentialImprovementScore: potentialImprovements.qualityGainPercentage ?
        Math.round(potentialImprovements.qualityGainPercentage * 100) : defaultValues.potentialImprovementScore,
      annualSavingsOpportunity: monetaryImpact.annualSavings || defaultValues.annualSavingsOpportunity,
      revenueUpliftOpportunity: monetaryImpact.revenueOpportunity || defaultValues.revenueUpliftOpportunity,
      efficiencyGains: potentialImprovements.efficiencyGainPercentage ?
        Math.round(potentialImprovements.efficiencyGainPercentage * 100) : defaultValues.efficiencyGains,
      riskReduction: compliance ? Math.round((1 - compliance.overallCompliance) * 50) : defaultValues.riskReduction
    };
  }

  private extractInvestmentCost(businessImpact?: BusinessImpactAnalysis): number | undefined {
    if (!businessImpact || !businessImpact.businessValue) return undefined;
    const monetaryImpact = (businessImpact.businessValue as any).monetaryImpact;
    return monetaryImpact?.implementationCost;
  }

  private extractProjectedROI(roi?: ROICalculation): number {
    if (roi && (roi as any).riskAdjustedROI !== undefined) {
      return (roi as any).riskAdjustedROI;
    }
    return 250; // 250% default
  }

  private extractOperationalRiskLevel(businessImpact?: BusinessImpactAnalysis): 'low' | 'medium' | 'high' | 'critical' {
    if (!businessImpact || !businessImpact.riskAssessment) return 'medium';
    const riskAssessment = businessImpact.riskAssessment as any;
    return riskAssessment.overallRiskLevel || 'medium';
  }

  private extractComplianceCriticalIssues(compliance?: ComplianceValidationResult): string[] {
    if (!compliance || !compliance.criticalIssues) return ['Regulatory gaps'];
    return (compliance.criticalIssues as { description: string }[])
      .map(issue => issue.description);
  }
}
