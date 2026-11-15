/**
 * Cost Benefit Analyzer - Cost savings calculation and ROI analysis
 * Extracted from ProcessOptimizationAgent for better separation of concerns
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type { WorkflowStep, CostSaving } from '../../interfaces';
import type { OptimizationAnalysis } from '../types/process-optimization';
import type { ROIAnalysisService } from '../intelligence/ROIAnalysisService';

@injectable()
export class CostBenefitAnalyzer {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.ROIAnalysisService) private roiService: ROIAnalysisService
  ) { }

  /**
   * Calculate cost savings from workflow optimization
   */
  async calculateCostSavings(
    currentWorkflow: WorkflowStep[],
    optimizedWorkflow: WorkflowStep[],
    optimizationAnalysis: OptimizationAnalysis
  ): Promise<CostSaving[]> {
    this.logger.info('Calculating cost savings', {
      currentSteps: currentWorkflow.length,
      optimizedSteps: optimizedWorkflow.length,
      opportunities: optimizationAnalysis.opportunities.length
    });

    const costSavings: CostSaving[] = [];

    // Calculate time savings
    const currentDuration = currentWorkflow.reduce((sum, step) => sum + step.duration, 0);
    const optimizedDuration = optimizedWorkflow.reduce((sum, step) => sum + step.duration, 0);
    const timeSavings = currentDuration - optimizedDuration;

    if (timeSavings > 0) {
      const annualSaving = timeSavings * 60 * 8760; // Assuming hourly rate
      const oneTimeCost = 5000; // Implementation cost

      costSavings.push({
        category: 'time',
        description: `Reduced process duration by ${timeSavings} minutes`,
        annualSaving,
        oneTimeCost,
        roi: this.roiService.calculateSimpleROI(annualSaving, oneTimeCost),
        confidence: 0.8
      });

      this.logger.info('Time savings calculated', {
        timeSavings,
        annualSaving,
        roi: annualSaving / oneTimeCost
      });
    }

    // Calculate labor cost savings from automation
    const automationOpportunities = optimizationAnalysis.opportunities.filter(
      o => o.type === 'automation'
    );

    if (automationOpportunities.length > 0) {
      const laborSavings = automationOpportunities.reduce(
        (sum, opp) => sum + opp.potentialGains.costReduction,
        0
      ) * 50000; // Average labor cost

      const oneTimeCost = 25000; // Automation implementation cost

      costSavings.push({
        category: 'labor',
        description: `Automated ${automationOpportunities.length} manual processes`,
        annualSaving: laborSavings,
        oneTimeCost,
        roi: this.roiService.calculateSimpleROI(laborSavings, oneTimeCost),
        confidence: 0.7
      });

      this.logger.info('Labor savings calculated', {
        automationCount: automationOpportunities.length,
        laborSavings,
        roi: laborSavings / oneTimeCost
      });
    }

    // Calculate quality improvement savings
    const qualityOpportunities = optimizationAnalysis.opportunities.filter(
      o => o.potentialGains.qualityImprovement > 0.1
    );

    if (qualityOpportunities.length > 0) {
      const qualitySavings = qualityOpportunities.reduce(
        (sum, opp) => sum + opp.potentialGains.qualityImprovement,
        0
      ) * 20000; // Estimated value per quality point

      const oneTimeCost = 10000; // Quality improvement implementation cost

      costSavings.push({
        category: 'maintenance',
        description: `Improved quality across ${qualityOpportunities.length} processes`,
        annualSaving: qualitySavings,
        oneTimeCost,
        roi: this.roiService.calculateSimpleROI(qualitySavings, oneTimeCost),
        confidence: 0.6
      });

      this.logger.info('Quality savings calculated', {
        qualityOpportunities: qualityOpportunities.length,
        qualitySavings,
        roi: qualitySavings / oneTimeCost
      });
    }

    // Calculate error reduction savings
    const errorReductionOpportunities = optimizationAnalysis.opportunities.filter(
      o => o.potentialGains.errorReduction > 0.2
    );

    if (errorReductionOpportunities.length > 0) {
      const errorSavings = errorReductionOpportunities.reduce(
        (sum, opp) => sum + opp.potentialGains.errorReduction,
        0
      ) * 15000; // Estimated cost per error avoided

      const oneTimeCost = 8000; // Error prevention implementation cost

      costSavings.push({
        category: 'maintenance',
        description: `Reduced errors across ${errorReductionOpportunities.length} processes`,
        annualSaving: errorSavings,
        oneTimeCost,
        roi: this.roiService.calculateSimpleROI(errorSavings, oneTimeCost),
        confidence: 0.75
      });

      this.logger.info('Error reduction savings calculated', {
        errorOpportunities: errorReductionOpportunities.length,
        errorSavings,
        roi: errorSavings / oneTimeCost
      });
    }

    const totalAnnualSavings = costSavings.reduce((sum, cs) => sum + cs.annualSaving, 0);
    const totalOneTimeCost = costSavings.reduce((sum, cs) => sum + cs.oneTimeCost, 0);

    this.logger.info('Cost savings analysis completed', {
      savingsCategories: costSavings.length,
      totalAnnualSavings,
      totalOneTimeCost,
      overallRoi: this.roiService.calculateSimpleROI(totalAnnualSavings, totalOneTimeCost)
    });

    return costSavings;
  }
}
