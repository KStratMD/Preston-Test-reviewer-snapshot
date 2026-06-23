/**
 * ROI Analysis Service
 *
 * Handles Return on Investment calculations, financial analysis,
 * and scenario modeling for the BusinessIntelligenceAgent.
 *
 * Responsibilities:
 * - ROI calculations (NPV, IRR, Payback Period)
 * - Financial benefit estimation
 * - Cost-benefit analysis
 * - Sensitivity analysis
 * - Risk-adjusted returns
 * - Scenario modeling (conservative, realistic, optimistic)
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../../../../inversify/types';
import type { Logger } from '../../../../../utils/Logger';
import type {
  BusinessImpactAnalysis,
  ROICalculation,
  ImplementationScenario
} from '../types/business-intelligence';

/**
 * Sensitivity analysis result for a single variable
 */
interface SensitivityAnalysisResult {
  variable: string;
  baseCase: number;
  pessimistic: number;
  optimistic: number;
  impactOnROI: number;
}

/**
 * Extended ROI calculation with additional analysis
 */
interface ExtendedROICalculation extends ROICalculation {
  calculationId: string;
  timestamp: Date;
  scenario: 'conservative' | 'realistic' | 'optimistic';
  initialInvestment: number;
  annualBenefits: number;
  annualCosts: number;
  riskAdjustedROI: number;
  sensitivityAnalysis: SensitivityAnalysisResult[];
}

@injectable()
export class ROIAnalysisService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger
  ) {
    this.logger.debug('ROIAnalysisService initialized');
  }

  /**
   * Calculate Simple ROI Percentage
   * Formula: ((Total Benefits - Total Costs) / Total Costs) * 100
   *
   * @param benefits - Total financial benefits
   * @param costs - Total costs (investment + operational)
   * @returns ROI percentage (e.g., 150 for 150%)
   */
  calculateSimpleROI(benefits: number, costs: number): number {
    if (costs === 0) return 0;
    return Math.round(((benefits - costs) / costs) * 100);
  }

  /**
   * Calculate Net ROI (Absolute Value)
   * Formula: Total Benefits - Total Costs
   *
   * @param benefits - Total financial benefits
   * @param costs - Total costs
   * @returns Net value in currency units
   */
  calculateNetROI(benefits: number, costs: number): number {
    return benefits - costs;
  }

  /**
   * Perform comprehensive ROI calculation
   * Includes NPV, IRR, payback period, and sensitivity analysis
   *
   * @param businessImpact - Business impact analysis results
   * @param scenario - Implementation scenario parameters
   * @returns Extended ROI calculation results
   */
  async performROICalculation(
    businessImpact: BusinessImpactAnalysis,
    scenario?: ImplementationScenario
  ): Promise<ExtendedROICalculation> {
    this.logger.debug('Performing ROI calculation', { scenario: scenario?.scenario });

    // Default scenario parameters
    const defaultScenario: Partial<ImplementationScenario> = {
      scenario: 'realistic',
      discountRate: 0.08,
      timeHorizonYears: 3,
      implementationApproach: 'phased'
    };

    const actualScenario = {
      ...defaultScenario,
      ...scenario,
      discountRate: 0.08, // Fixed discount rate for now
      timeHorizonYears: scenario?.timeframe || 3
    };

    // Estimate financial parameters from business impact
    const initialInvestment = businessImpact.businessValue.monetaryImpact.implementationCost || 150000;
    const annualBenefits = (businessImpact.businessValue.monetaryImpact.annualSavings +
      businessImpact.businessValue.monetaryImpact.revenueOpportunity) || 400000;
    // Use a default for annual costs if not explicitly available, or derive from operational cost
    const annualCosts = (businessImpact.businessValue.currentState.operationalCost * 0.1) || 50000;
    const netAnnualFlow = annualBenefits - annualCosts;

    // Calculate NPV
    const npv = this.calculateNPV(
      initialInvestment,
      netAnnualFlow,
      actualScenario.discountRate,
      actualScenario.timeHorizonYears
    );

    // Calculate IRR
    const irr = this.calculateIRR(
      initialInvestment,
      netAnnualFlow,
      actualScenario.timeHorizonYears
    );

    // Calculate payback period (in months)
    const paybackPeriod = this.calculatePaybackPeriod(
      initialInvestment,
      netAnnualFlow
    );

    // Calculate risk-adjusted ROI (85% adjustment for risk)
    const riskAdjustedROI = this.calculateRiskAdjustedROI(
      npv,
      initialInvestment,
      0.85
    );

    // Perform sensitivity analysis
    const sensitivityAnalysis = this.performSensitivityAnalysis(
      initialInvestment,
      annualBenefits,
      annualCosts
    );

    return {
      calculationId: `calc_${Date.now()}`,
      timestamp: new Date(),
      scenario: (actualScenario.scenario as 'conservative' | 'realistic' | 'optimistic') || 'realistic',
      initialInvestment,
      annualBenefits,
      annualCosts,
      totalInvestment: initialInvestment,
      expectedBenefits: annualBenefits * actualScenario.timeHorizonYears,
      paybackPeriod,
      netPresentValue: Math.round(npv),
      internalRateOfReturn: irr,
      riskAdjustedROI,
      sensitivityAnalysis
    };
  }

  /**
   * Calculate Net Present Value (NPV)
   *
   * @param initialInvestment - Upfront investment cost
   * @param annualCashFlow - Net annual cash flow
   * @param discountRate - Discount rate (0-1)
   * @param years - Time horizon in years
   * @returns NPV value
   */
  private calculateNPV(
    initialInvestment: number,
    annualCashFlow: number,
    discountRate: number,
    years: number
  ): number {
    let npv = -initialInvestment;

    for (let year = 1; year <= years; year++) {
      npv += annualCashFlow / Math.pow(1 + discountRate, year);
    }

    return npv;
  }

  /**
   * Calculate Internal Rate of Return (IRR)
   * Simplified calculation for demonstration
   *
   * @param initialInvestment - Upfront investment cost
   * @param annualCashFlow - Net annual cash flow
   * @param years - Time horizon in years
   * @returns IRR as decimal (0-1)
   */
  private calculateIRR(
    initialInvestment: number,
    annualCashFlow: number,
    years: number
  ): number {
    const totalCashFlow = annualCashFlow * years;
    const profit = totalCashFlow - initialInvestment;
    const irr = (profit / initialInvestment) / years;

    return Math.round(irr * 100) / 100;
  }

  /**
   * Calculate Payback Period
   * Time required to recover initial investment
   *
   * @param initialInvestment - Upfront investment cost
   * @param annualCashFlow - Net annual cash flow
   * @returns Payback period in months
   */
  private calculatePaybackPeriod(
    initialInvestment: number,
    annualCashFlow: number
  ): number {
    if (annualCashFlow <= 0) return Infinity;

    const yearsToPayback = initialInvestment / annualCashFlow;
    return Math.ceil(yearsToPayback * 12); // Convert to months
  }

  /**
   * Calculate Risk-Adjusted ROI
   * Applies risk factor to account for uncertainty
   *
   * @param npv - Net Present Value
   * @param initialInvestment - Upfront investment cost
   * @param riskFactor - Risk adjustment factor (0-1)
   * @returns Risk-adjusted ROI as decimal
   */
  private calculateRiskAdjustedROI(
    npv: number,
    initialInvestment: number,
    riskFactor: number
  ): number {
    if (initialInvestment === 0) return 0;

    const adjustedROI = (npv / initialInvestment) * riskFactor;
    return Math.round(adjustedROI * 100) / 100;
  }

  /**
   * Perform sensitivity analysis on key variables
   * Analyzes impact of changes in key assumptions
   *
   * @param initialInvestment - Base case investment
   * @param annualBenefits - Base case benefits
   * @param annualCosts - Base case costs
   * @returns Array of sensitivity analysis results
   */
  private performSensitivityAnalysis(
    initialInvestment: number,
    annualBenefits: number,
    annualCosts: number
  ): SensitivityAnalysisResult[] {
    return [
      {
        variable: 'Implementation Cost',
        baseCase: initialInvestment,
        pessimistic: initialInvestment * 1.2,
        optimistic: initialInvestment * 0.8,
        impactOnROI: -0.15
      },
      {
        variable: 'Annual Benefits',
        baseCase: annualBenefits,
        pessimistic: annualBenefits * 0.8,
        optimistic: annualBenefits * 1.2,
        impactOnROI: 0.20
      },
      {
        variable: 'Annual Costs',
        baseCase: annualCosts,
        pessimistic: annualCosts * 1.3,
        optimistic: annualCosts * 0.7,
        impactOnROI: -0.10
      }
    ];
  }

  /**
   * Calculate total cost of ownership (TCO)
   *
   * @param initialInvestment - Upfront costs
   * @param annualCosts - Recurring annual costs
   * @param years - Time horizon
   * @returns Total cost of ownership
   */
  calculateTotalCostOfOwnership(
    initialInvestment: number,
    annualCosts: number,
    years: number
  ): number {
    return initialInvestment + (annualCosts * years);
  }

  /**
   * Calculate benefit-cost ratio
   *
   * @param totalBenefits - Total expected benefits
   * @param totalCosts - Total costs
   * @returns Benefit-cost ratio
   */
  calculateBenefitCostRatio(
    totalBenefits: number,
    totalCosts: number
  ): number {
    if (totalCosts === 0) return 0;
    return Math.round((totalBenefits / totalCosts) * 100) / 100;
  }

  /**
   * Estimate break-even point
   * Number of months until cumulative benefits equal costs
   *
   * @param initialInvestment - Upfront investment
   * @param monthlyBenefits - Monthly benefit rate
   * @returns Break-even point in months
   */
  calculateBreakEvenPoint(
    initialInvestment: number,
    monthlyBenefits: number
  ): number {
    if (monthlyBenefits <= 0) return Infinity;
    return Math.ceil(initialInvestment / monthlyBenefits);
  }
}
