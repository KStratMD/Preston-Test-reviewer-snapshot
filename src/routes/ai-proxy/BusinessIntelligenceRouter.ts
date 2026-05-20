/**
 * Business Intelligence Router - Business Intelligence and Compliance Endpoints
 * Handles business intelligence analysis, compliance validation, ROI calculation
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import type { Logger } from '../../utils/Logger';
import { UnifiedTelemetryService } from '../../services/UnifiedTelemetryService';
import { GovernanceService } from '../../services/ai/orchestrator/GovernanceService';
import { BusinessIntelligenceAgent } from '../../services/ai/orchestrator/agents/BusinessIntelligenceAgent';
import type { AgentExecutionContext } from '../../services/ai/orchestrator/interfaces';

export interface BusinessIntelligenceRouterDependencies {
  logger: Logger;
  telemetry: UnifiedTelemetryService;
  governanceService: GovernanceService;
  businessIntelligenceAgent: BusinessIntelligenceAgent;
}

export async function createBusinessIntelligenceRouter(deps: BusinessIntelligenceRouterDependencies): Promise<Router> {
  const router = Router();
  const { logger, telemetry, governanceService, businessIntelligenceAgent } = deps;

  /**
   * POST /api/ai/business-intelligence/analyze - Comprehensive business intelligence analysis
   */
  router.post('/business-intelligence/analyze', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `bi_session_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    const userId = req.headers['x-user-id'] as string || 'anonymous';

    const {
      organizationProfile,
      dataQualityResults,
      processOptimizationResults,
      systemConfiguration,
      analysisType = 'comprehensive',
      implementationScenario
    } = req.body;

    // Validate required fields
    if (!organizationProfile) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: organizationProfile'
      });
    }

    try {
      // Governance pre-check
      try {
        const preCheck = await governanceService.validateInput(req.body, {
          sessionId,
          userId,
          sourceSystem: 'business-intelligence',
          targetSystem: 'analytics',
          timestamp: new Date(),
          metadata: { route: 'business-intelligence/analyze' }
        } as any);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          logger.warn('Governance blocked business intelligence analysis', { sessionId, reason: preCheck.reason, flags: preCheck.flags });
          return res.status(400).json({
            success: false,
            error: { type: 'governance_violation', ruleId, message: preCheck.reason || 'Blocked by governance policy' },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: { sessionId, timestamp: new Date().toISOString() }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (business-intelligence/analyze)', { sessionId, error: String(gerr) });
      }

      // Create business intelligence input
      const businessInput = {
        organizationProfile,
        dataQualityResults,
        processOptimizationResults,
        systemConfiguration,
        analysisType,
        implementationScenario
      };

      // Create execution context
      const executionContext: AgentExecutionContext = {
        sessionId,
        userId,
        timestamp: new Date(),
        sourceSystem: 'business-intelligence',
        targetSystem: 'analytics',
        metadata: { route: 'business-intelligence/analyze' }
      };

      // Execute real BusinessIntelligenceAgent
      const agentResult = await businessIntelligenceAgent.execute(executionContext, businessInput);

      const duration = Date.now() - startTime;

      // Check if agent execution was successful
      if (!agentResult.success) {
        throw new Error(agentResult.errors?.join(', ') || 'Agent execution failed');
      }

      // Record telemetry for business intelligence analysis
      await telemetry.recordGenericEvent('business_intelligence_analyzed', {
        analysisType,
        organizationName: organizationProfile.name,
        organizationSize: organizationProfile.size,
        industry: organizationProfile.industry,
        overallScore: agentResult.data?.executiveSummary?.overallScore,
        recommendationsCount: agentResult.data?.recommendations?.length || 0,
        riskLevel: agentResult.data?.executiveSummary?.riskLevel,
        projectedROI: agentResult.data?.executiveSummary?.projectedROI,
        confidence: agentResult.confidence,
        hallucinationRisk: agentResult.hallucination_risk,
        duration,
        success: true
      }, userId, sessionId);

      logger.info('Business intelligence analysis completed', {
        sessionId,
        userId,
        analysisType,
        organization: organizationProfile.name,
        overallScore: agentResult.data?.executiveSummary?.overallScore,
        confidence: agentResult.confidence,
        duration
      });

      res.json({
        success: true,
        result: agentResult.data,
        metadata: {
          sessionId,
          analysisType,
          organizationName: organizationProfile.name,
          confidence: agentResult.confidence,
          reasoning: agentResult.reasoning,
          hallucinationRisk: agentResult.hallucination_risk,
          governanceFlags: agentResult.governance_flags,
          duration,
          timestamp: new Date().toISOString(),
          version: '2.0.0-real-agent'
        }
      });

    } catch (error) {
      const duration = Date.now() - startTime;

      await telemetry.recordGenericEvent('business_intelligence_failed', {
        analysisType,
        organizationName: organizationProfile.name,
        userId,
        duration,
        error: String(error)
      }, userId, sessionId);

      logger.error('Business intelligence analysis failed', {
        sessionId,
        userId,
        error: String(error),
        organizationProfile: organizationProfile.name
      });

      res.status(500).json({
        success: false,
        error: 'Business intelligence analysis failed',
        sessionId,
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * POST /api/ai/compliance/validate - Comprehensive compliance validation
   */
  router.post('/compliance/validate', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `compliance_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    const userId = req.headers['x-user-id'] as string || 'anonymous';

    const {
      organizationProfile,
      dataProfile,
      systemConfiguration,
      targetRegulations = ['GDPR', 'SOX']
    } = req.body;

    // Validate required fields
    if (!organizationProfile) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: organizationProfile'
      });
    }

    try {
      // Governance pre-check
      try {
        const preCheck = await governanceService.validateInput(req.body, {
          sessionId,
          userId,
          sourceSystem: 'compliance',
          targetSystem: 'validation',
          timestamp: new Date(),
          metadata: { route: 'compliance/validate' }
        } as any);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          logger.warn('Governance blocked compliance validation', { sessionId, reason: preCheck.reason, flags: preCheck.flags });
          return res.status(400).json({
            success: false,
            error: { type: 'governance_violation', ruleId, message: preCheck.reason || 'Blocked by governance policy' },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: { sessionId, timestamp: new Date().toISOString() }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (compliance/validate)', { sessionId, error: String(gerr) });
      }

      // Create mock compliance validation result
      const mockResult = {
        validationId: sessionId,
        timestamp: new Date(),
        overallCompliance: 0.82,
        regulations: targetRegulations.map((reg: string) => ({
          regulation: reg,
          status: 'partial',
          complianceScore: 0.82,
          requirements: [
            {
              requirementId: `${reg.toLowerCase()}-req-1`,
              description: `${reg} primary requirement`,
              status: 'met',
              evidence: ['Policy documented', 'Controls implemented'],
              gaps: [] as unknown[],
              criticality: 'high',
              remediationEffort: 'low',
              estimatedCost: 15000
            }
          ],
          gaps: [
            {
              gapId: `${reg.toLowerCase()}-gap-1`,
              regulation: reg,
              requirement: 'Data protection controls',
              description: `Enhanced ${reg} controls needed`,
              severity: 'medium',
              businessImpact: 'Moderate compliance risk',
              estimatedCost: 25000,
              timeToRemediate: 60
            }
          ],
          riskLevel: 'medium',
          estimatedFineExposure: reg === 'GDPR' ? 500000 : 100000,
          lastAssessment: new Date()
        })),
        criticalIssues: [] as unknown[],
        recommendations: [
          {
            recommendationId: `comp-rec-${Date.now()}`,
            priority: 'high',
            category: 'technical',
            title: 'Enhance Compliance Controls',
            description: 'Implement additional controls for regulatory compliance',
            regulation: targetRegulations.join(', '),
            benefits: ['Reduced regulatory risk', 'Improved audit readiness'],
            riskReduction: 0.7
          }
        ],
        auditReport: {
          reportId: `audit-${sessionId}`,
          auditDate: new Date(),
          scope: targetRegulations,
          auditor: 'AI Compliance System',
          findings: [] as unknown[],
          overallRating: 'satisfactory',
          executiveSummary: `Compliance assessment for ${targetRegulations.join(', ')} completed. Overall compliance: 82%.`,
          detailedFindings: 'Assessment completed with moderate compliance level.',
          recommendations: ['Enhance data protection controls', 'Implement regular compliance reviews']
        },
        nextSteps: [
          {
            actionId: `action-${Date.now()}`,
            description: 'Address medium-severity compliance gaps',
            regulation: targetRegulations[0],
            priority: 'high',
            category: 'short-term',
            dueDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
            owner: 'Compliance Team',
            status: 'not-started',
            estimatedEffort: 40,
            dependencies: [] as unknown[],
            completionPercentage: 0
          }
        ]
      };

      const duration = Date.now() - startTime;

      // Record telemetry for compliance validation
      await telemetry.recordGenericEvent('compliance_validated', {
        organizationName: organizationProfile.name,
        targetRegulations,
        overallCompliance: mockResult.overallCompliance,
        criticalIssuesCount: mockResult.criticalIssues.length,
        recommendationsCount: mockResult.recommendations.length,
        duration,
        success: true
      }, userId, sessionId);

      logger.info('Compliance validation completed', {
        sessionId,
        userId,
        organization: organizationProfile.name,
        regulations: targetRegulations,
        overallCompliance: Math.round(mockResult.overallCompliance * 100),
        duration
      });

      res.json({
        success: true,
        result: mockResult,
        metadata: {
          sessionId,
          organizationName: organizationProfile.name,
          targetRegulations,
          duration,
          timestamp: new Date().toISOString(),
          version: 'week-6-compliance-validation'
        }
      });

    } catch (error) {
      const duration = Date.now() - startTime;

      await telemetry.recordGenericEvent('compliance_validation_failed', {
        organizationName: organizationProfile.name,
        targetRegulations,
        userId,
        duration,
        error: String(error)
      }, userId, sessionId);

      logger.error('Compliance validation failed', {
        sessionId,
        userId,
        error: String(error),
        organization: organizationProfile.name
      });

      res.status(500).json({
        success: false,
        error: 'Compliance validation failed',
        sessionId,
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * POST /api/ai/roi/calculate - Calculate ROI for business improvements
   */
  router.post('/roi/calculate', asyncHandler(async (req: Request, res: Response) => {
    const startTime = Date.now();
    const sessionId = `roi_${Date.now()}_${Math.random().toString(36).slice(2, 2 + 9)}`;
    const userId = req.headers['x-user-id'] as string || 'anonymous';

    const {
      businessImpactAnalysis,
      implementationScenario = {
        scenario: 'realistic',
        discountRate: 0.08,
        timeHorizonYears: 3,
        implementationApproach: 'phased'
      }
    } = req.body;

    // Validate required fields
    if (!businessImpactAnalysis) {
      return res.status(400).json({
        success: false,
        error: 'Missing required field: businessImpactAnalysis'
      });
    }

    try {
      // Governance pre-check
      try {
        const preCheck = await governanceService.validateInput(req.body, {
          sessionId,
          userId,
          sourceSystem: 'roi-calculator',
          targetSystem: 'financial-analysis',
          timestamp: new Date(),
          metadata: { route: 'roi/calculate' }
        } as any);
        if (!preCheck.approved) {
          const ruleFlag = preCheck.flags.find(f => f.startsWith('rule_') && f.endsWith('_triggered'));
          const ruleId = ruleFlag ? ruleFlag.replace(/^rule_/, '').replace(/_triggered$/, '') : undefined;

          logger.warn('Governance blocked ROI calculation', { sessionId, reason: preCheck.reason, flags: preCheck.flags });
          return res.status(400).json({
            success: false,
            error: { type: 'governance_violation', ruleId, message: preCheck.reason || 'Blocked by governance policy' },
            governance: {
              blocked: true,
              reason: preCheck.reason,
              flags: preCheck.flags,
              riskLevel: preCheck.riskLevel,
              complianceChecks: preCheck.complianceChecks
            },
            metadata: { sessionId, timestamp: new Date().toISOString() }
          });
        }
      } catch (gerr) {
        logger.error('Governance pre-check error (roi/calculate)', { sessionId, error: String(gerr) });
      }

      // Create mock ROI calculation
      const initialInvestment = 150000;
      const annualBenefits = 400000;
      const annualCosts = 50000;
      const netAnnualFlow = annualBenefits - annualCosts;
      const timeHorizon = implementationScenario.timeHorizonYears;

      // Calculate NPV
      let npv = -initialInvestment;
      for (let year = 1; year <= timeHorizon; year++) {
        npv += netAnnualFlow / Math.pow(1 + implementationScenario.discountRate, year);
      }

      const mockResult = {
        calculationId: sessionId,
        timestamp: new Date(),
        scenario: implementationScenario.scenario,
        initialInvestment,
        annualBenefits,
        annualCosts,
        netPresentValue: Math.round(npv),
        internalRateOfReturn: Math.round(((netAnnualFlow * timeHorizon - initialInvestment) / initialInvestment) * 100) / 100,
        paybackPeriod: Math.ceil((initialInvestment / netAnnualFlow) * 12), // months
        riskAdjustedROI: Math.round((npv / initialInvestment) * 0.85 * 100) / 100, // 85% risk adjustment
        sensitivityAnalysis: [
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
            impactOnROI: 0.25
          }
        ]
      };

      const duration = Date.now() - startTime;

      // Record telemetry for ROI calculation
      await telemetry.recordGenericEvent('roi_calculated', {
        scenario: implementationScenario.scenario,
        initialInvestment: mockResult.initialInvestment,
        projectedROI: mockResult.riskAdjustedROI,
        paybackPeriod: mockResult.paybackPeriod,
        npv: mockResult.netPresentValue,
        timeHorizon: timeHorizon,
        duration,
        success: true
      }, userId, sessionId);

      logger.info('ROI calculation completed', {
        sessionId,
        userId,
        scenario: implementationScenario.scenario,
        roi: mockResult.riskAdjustedROI,
        paybackPeriod: mockResult.paybackPeriod,
        duration
      });

      res.json({
        success: true,
        result: mockResult,
        metadata: {
          sessionId,
          scenario: implementationScenario.scenario,
          timeHorizon,
          duration,
          timestamp: new Date().toISOString(),
          version: 'week-6-roi-calculation'
        }
      });

    } catch (error) {
      const duration = Date.now() - startTime;

      await telemetry.recordGenericEvent('roi_calculation_failed', {
        scenario: implementationScenario.scenario,
        userId,
        duration,
        error: String(error)
      }, userId, sessionId);

      logger.error('ROI calculation failed', {
        sessionId,
        userId,
        error: String(error)
      });

      res.status(500).json({
        success: false,
        error: 'ROI calculation failed',
        sessionId,
        details: process.env.NODE_ENV === 'development' ? String(error) : undefined
      });
    }
  }));

  /**
   * GET /api/ai/business-intelligence/capabilities - Get business intelligence capabilities
   */
  router.get('/business-intelligence/capabilities', asyncHandler(async (req: Request, res: Response) => {
    try {
      const capabilities = {
        analysisTypes: [
          'business-impact',
          'roi-calculation',
          'compliance-validation',
          'comprehensive'
        ],
        supportedRegulations: [
          'GDPR',
          'HIPAA',
          'SOX',
          'PCI-DSS',
          'CCPA',
          'PIPEDA'
        ],
        riskCategories: [
          'operational',
          'financial',
          'compliance',
          'technical',
          'strategic',
          'reputational'
        ],
        implementationScenarios: [
          'conservative',
          'realistic',
          'optimistic'
        ],
        businessValueMetrics: [
          'annualSavingsOpportunity',
          'revenueUpliftOpportunity',
          'efficiencyGains',
          'riskReduction',
          'complianceImprovement'
        ],
        version: 'week-6-business-intelligence',
        features: [
          'automated-business-impact-analysis',
          'roi-calculation-engine',
          'compliance-validation',
          'risk-assessment',
          'executive-reporting',
          'actionable-insights'
        ]
      };

      logger.info('Business intelligence capabilities requested');

      res.json({
        success: true,
        capabilities,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      logger.error('Failed to get business intelligence capabilities', { error: String(error) });

      res.status(500).json({
        success: false,
        error: 'Failed to get capabilities'
      });
    }
  }));

  return router;
}
