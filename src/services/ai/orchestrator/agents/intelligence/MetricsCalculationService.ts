/**
 * Metrics Calculation Service
 *
 * Handles business metrics computation, scoring, and mapping functions
 * for the BusinessIntelligenceAgent.
 *
 * Responsibilities:
 * - Overall score calculations
 * - Risk level determination
 * - Implementation time estimation
 * - Effort level mapping
 * - Timeframe categorization
 * - Likelihood and impact scoring
 * - Confidence calculations
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type {
  BusinessImpactAnalysis,
  ComplianceValidationResult,
  BusinessIntelligenceInput,
  BusinessIntelligenceOutput,
  ResourceRequirement
} from '../types/business-intelligence';
import type { ROIAnalysisService } from './ROIAnalysisService';

@injectable()
export class MetricsCalculationService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ROIAnalysisService) private roiService: ROIAnalysisService
  ) {
    this.logger.debug('MetricsCalculationService initialized');
  }

  /**
   * Calculate overall business intelligence score
   * Combines business impact and compliance scores
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @returns Overall score (0-100)
   */
  calculateOverallScore(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult
  ): number {
    let score = 70; // Base score

    if (businessImpact && businessImpact.overallScore !== undefined) {
      score = businessImpact.overallScore;
    }

    if (compliance) {
      const complianceScore = Math.round(compliance.overallCompliance * 100);
      score = businessImpact ? (score + complianceScore) / 2 : complianceScore;
    }

    return Math.round(score);
  }

  /**
   * Determine overall risk level based on business impact and compliance
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @returns Risk level category
   */
  determineOverallRiskLevel(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult
  ): 'low' | 'medium' | 'high' | 'critical' {
    let riskLevel: 'low' | 'medium' | 'high' | 'critical' = 'medium';

    // Check business impact risk assessment
    if (businessImpact && businessImpact.riskAssessment) {
      const riskAssessment = businessImpact.riskAssessment as { overallRiskLevel?: 'low' | 'medium' | 'high' | 'critical' };
      if (riskAssessment.overallRiskLevel) {
        riskLevel = riskAssessment.overallRiskLevel;
      }
    }

    // Escalate to high if critical compliance issues exist
    if (compliance && Array.isArray(compliance.criticalIssues) && compliance.criticalIssues.length > 0) {
      riskLevel = 'high';
    }

    return riskLevel;
  }

  /**
   * Generate list of recommended actions from analysis results
   * Prioritizes critical and high priority recommendations
   *
   * @param businessImpact - Business impact analysis results
   * @param compliance - Compliance validation results
   * @returns Top 5 recommended actions
   */
  generateRecommendedActions(
    businessImpact?: BusinessImpactAnalysis,
    compliance?: ComplianceValidationResult
  ): string[] {
    const actions: string[] = [];

    // Extract high-priority business impact recommendations
    if (businessImpact && businessImpact.recommendations) {
      const recommendations = businessImpact.recommendations as {
        priority?: string;
        title: string;
      }[];

      actions.push(...recommendations
        .filter((rec) => rec.priority === 'critical' || rec.priority === 'high')
        .map((rec) => rec.title)
      );
    }

    // Extract high-priority compliance recommendations
    if (compliance && compliance.recommendations) {
      const recommendations = compliance.recommendations as {
        priority?: string;
        title: string;
      }[];

      actions.push(...recommendations
        .filter((rec) => rec.priority === 'critical' || rec.priority === 'high')
        .map((rec) => rec.title)
      );
    }

    // Return top 5 actions
    return actions.slice(0, 5);
  }

  /**
   * Map resource requirements to effort level
   *
   * @param resourceRequirements - List of resource requirements
   * @returns Effort level (low/medium/high)
   */
  mapEffortLevel(resourceRequirements: ResourceRequirement[]): 'low' | 'medium' | 'high' {
    const totalCost = resourceRequirements.reduce((sum, req) => sum + req.cost, 0);

    if (totalCost > 100000) return 'high';
    if (totalCost > 50000) return 'medium';
    return 'low';
  }

  /**
   * Calculate estimated implementation time based on number of steps
   *
   * @param steps - List of implementation steps
   * @returns Estimated time in days
   */
  calculateImplementationTime(steps: string[]): number {
    // Estimate 15 days per step
    return steps.length * 15;
  }

  /**
   * Map timeframe description to category
   *
   * @param timeframe - Timeframe description
   * @returns Timeframe category
   */
  mapTimeframe(timeframe: string): 'immediate' | 'short-term' | 'medium-term' | 'long-term' {
    const lowerTimeframe = timeframe.toLowerCase();

    if (lowerTimeframe.includes('immediate') || lowerTimeframe.includes('1 month')) {
      return 'immediate';
    }
    if (lowerTimeframe.includes('3 months') || lowerTimeframe.includes('quarter')) {
      return 'short-term';
    }
    if (lowerTimeframe.includes('6 months') || lowerTimeframe.includes('year')) {
      return 'medium-term';
    }
    return 'long-term';
  }

  /**
   * Map likelihood probability to category
   *
   * @param likelihood - Likelihood value (0-1)
   * @returns Likelihood category
   */
  mapLikelihood(likelihood: number): 'very-low' | 'low' | 'medium' | 'high' | 'very-high' {
    if (likelihood >= 0.8) return 'very-high';
    if (likelihood >= 0.6) return 'high';
    if (likelihood >= 0.4) return 'medium';
    if (likelihood >= 0.2) return 'low';
    return 'very-low';
  }

  /**
   * Map impact score to category
   *
   * @param impact - Impact value (0-1)
   * @returns Impact category
   */
  mapImpact(impact: number): 'negligible' | 'minor' | 'moderate' | 'major' | 'catastrophic' {
    if (impact >= 0.8) return 'catastrophic';
    if (impact >= 0.6) return 'major';
    if (impact >= 0.4) return 'moderate';
    if (impact >= 0.2) return 'minor';
    return 'negligible';
  }

  /**
   * Calculate confidence score for analysis output
   * Based on completeness and quality of results
   *
   * @param output - Business intelligence output
   * @returns Confidence score (0-1)
   */
  calculateConfidence(output: BusinessIntelligenceOutput): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on completeness
    if (output.businessImpactAnalysis) confidence += 0.15;
    if (output.roiCalculation) confidence += 0.15;
    if (output.complianceValidation) confidence += 0.10;
    if (output.actionableInsights && output.actionableInsights.length > 0) confidence += 0.05;
    if (output.recommendations && output.recommendations.length > 0) confidence += 0.05;

    return Math.min(confidence, 1.0);
  }

  /**
   * Calculate time to value (months) based on implementation plan
   *
   * @param implementationDays - Total implementation time in days
   * @returns Time to value in months
   */
  calculateTimeToValue(implementationDays: number): number {
    // Convert days to months and add buffer
    const months = Math.ceil(implementationDays / 30);

    // Add 20% buffer for unforeseen delays
    return Math.ceil(months * 1.2);
  }

  /**
   * Calculate investment required from resource requirements
   *
   * @param resourceRequirements - List of resource requirements
   * @returns Total investment cost
   */
  calculateInvestmentRequired(resourceRequirements: ResourceRequirement[]): number {
    return resourceRequirements.reduce((sum, req) => sum + (req.cost * req.quantity), 0);
  }

  /**
   * Calculate projected ROI percentage
   *
   * @param expectedBenefits - Expected financial benefits
   * @param investment - Total investment cost
   * @returns ROI as percentage
   */
  calculateProjectedROI(expectedBenefits: number, investment: number): number {
    return this.roiService.calculateSimpleROI(expectedBenefits, investment);
  }

  /**
   * Calculate risk score from likelihood and impact
   *
   * @param likelihood - Risk likelihood (0-1)
   * @param impact - Risk impact (0-1)
   * @returns Risk score (0-100)
   */
  calculateRiskScore(likelihood: number, impact: number): number {
    return Math.round(likelihood * impact * 100);
  }

  /**
   * Aggregate multiple scores into weighted average
   *
   * @param scores - Array of score objects with value and weight
   * @returns Weighted average score
   */
  calculateWeightedScore(scores: { value: number; weight: number }[]): number {
    const totalWeight = scores.reduce((sum, s) => sum + s.weight, 0);
    if (totalWeight === 0) return 0;

    const weightedSum = scores.reduce((sum, s) => sum + (s.value * s.weight), 0);
    return Math.round(weightedSum / totalWeight);
  }
}
