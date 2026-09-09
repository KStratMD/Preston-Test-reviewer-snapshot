/**
 * Comprehensive unit tests for BusinessIntelligenceAgent
 * Covers: constructor, execute (all 4 analysis types), validateInput,
 *         getSchema, performComplianceValidation, generateReasoning,
 *         assessHallucinationRisk, checkGovernanceFlags, error handling
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/Logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  Logger: class {
    debug = jest.fn();
    info = jest.fn();
    warn = jest.fn();
    error = jest.fn();
  },
}));

import { BusinessIntelligenceAgent } from '../../../../src/services/ai/orchestrator/agents/BusinessIntelligenceAgent';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

function makeOrgProfile(overrides: Record<string, any> = {}) {
  return {
    name: 'Acme Corp',
    industry: 'manufacturing',
    annualRevenue: 5000000,
    employeeCount: 200,
    regulatoryRequirements: ['GDPR', 'SOX'],
    ...overrides,
  };
}

function makeContext(overrides: Record<string, any> = {}) {
  return {
    sessionId: 'session-bi-1',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    confidenceThreshold: 0.5,
    maxExecutionTime: 30000,
    ...overrides,
  };
}

function makeInput(overrides: Record<string, any> = {}) {
  return {
    organizationProfile: makeOrgProfile(),
    analysisType: 'business-impact' as string,
    dataQualityResults: { overallScore: 85 },
    processOptimizationResults: { improvements: [] },
    implementationScenario: {
      scenario: 'realistic',
      timeframe: 12,
      budget: 500000,
      riskTolerance: 'medium',
    },
    ...overrides,
  };
}

const mockBusinessImpact = {
  overallScore: 78,
  categories: [],
  metrics: [],
};

const mockROI = {
  paybackPeriod: 8,
  netPresentValue: 250000,
  internalRateOfReturn: 0.25,
  totalCostOfOwnership: 400000,
};

const mockExecutiveSummary = {
  overallScore: 78,
  keyFindings: [],
  recommendations: [],
};

const mockActionableInsights = [
  { title: 'Optimize transform', priority: 'high', impact: 0.3 },
];

const mockRiskAssessment = {
  overallRiskScore: 45,
  categories: [],
  mitigations: [],
};

const mockRecommendations = [
  { title: 'Automate ETL', priority: 'high', estimatedROI: 0.3 },
];

// Mock services
const mockMetricsService = {
  calculateConfidence: jest.fn().mockReturnValue(0.85),
};

const mockROIService = {
  performROICalculation: jest.fn().mockResolvedValue(mockROI),
};

const mockForecastingService = {
  performBusinessImpactAnalysis: jest.fn().mockResolvedValue(mockBusinessImpact),
};

const mockInsightsService = {
  generateExecutiveSummary: jest.fn().mockResolvedValue(mockExecutiveSummary),
  generateActionableInsights: jest.fn().mockResolvedValue(mockActionableInsights),
  generateEnhancedRiskAssessment: jest.fn().mockResolvedValue(mockRiskAssessment),
  generatePrioritizedRecommendations: jest.fn().mockResolvedValue(mockRecommendations),
};

describe('BusinessIntelligenceAgent', () => {
  let agent: BusinessIntelligenceAgent;

  beforeEach(() => {
    jest.clearAllMocks();
    agent = new BusinessIntelligenceAgent(
      mockLogger,
      mockMetricsService as any,
      mockROIService as any,
      mockForecastingService as any,
      mockInsightsService as any,
    );
  });

  describe('constructor', () => {
    it('should initialize with correct name and version', () => {
      expect(agent.name).toBe('business-intelligence');
      expect(agent.version).toBe('2.0.0');
    });

    it('should have required capabilities', () => {
      expect(agent.capabilities).toContain('business_impact_analysis');
      expect(agent.capabilities).toContain('roi_calculation');
      expect(agent.capabilities).toContain('compliance_validation');
      expect(agent.capabilities).toContain('risk_assessment');
      expect(agent.capabilities).toContain('executive_reporting');
      expect(agent.capabilities).toContain('strategic_planning');
    });

    it('should log initialization', () => {
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Business Intelligence Agent initialized (Phase 2 Orchestrator)',
        expect.objectContaining({ version: '2.0.0' }),
      );
    });
  });

  describe('validateInput', () => {
    it('should return true for valid input', async () => {
      const result = await agent.validateInput(makeInput());
      expect(result).toBe(true);
    });

    it('should return false without organizationProfile', async () => {
      const result = await agent.validateInput({ analysisType: 'business-impact' });
      expect(result).toBe(false);
    });

    it('should return false without analysisType', async () => {
      const result = await agent.validateInput({ organizationProfile: makeOrgProfile() });
      expect(result).toBe(false);
    });

    it('should return false for invalid analysisType', async () => {
      const result = await agent.validateInput(makeInput({ analysisType: 'invalid-type' }));
      expect(result).toBe(false);
    });

    it('should return false for missing org name', async () => {
      const result = await agent.validateInput(
        makeInput({ organizationProfile: makeOrgProfile({ name: '' }) }),
      );
      expect(result).toBe(false);
    });

    it('should return false for missing industry', async () => {
      const result = await agent.validateInput(
        makeInput({ organizationProfile: makeOrgProfile({ industry: '' }) }),
      );
      expect(result).toBe(false);
    });

    it('should return false for zero revenue', async () => {
      const result = await agent.validateInput(
        makeInput({ organizationProfile: makeOrgProfile({ annualRevenue: 0 }) }),
      );
      expect(result).toBe(false);
    });

    it('should return false for negative revenue', async () => {
      const result = await agent.validateInput(
        makeInput({ organizationProfile: makeOrgProfile({ annualRevenue: -100 }) }),
      );
      expect(result).toBe(false);
    });

    it('should handle validation exception gracefully', async () => {
      const result = await agent.validateInput(null);
      expect(result).toBe(false);
    });
  });

  describe('execute - business-impact', () => {
    it('should perform business impact analysis', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(mockForecastingService.performBusinessImpactAnalysis).toHaveBeenCalled();
    });

    it('should not call ROI service for business-impact type', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(mockROIService.performROICalculation).not.toHaveBeenCalled();
    });

    it('should generate executive summary', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(mockInsightsService.generateExecutiveSummary).toHaveBeenCalled();
    });

    it('should generate actionable insights', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(mockInsightsService.generateActionableInsights).toHaveBeenCalled();
    });

    it('should generate risk assessment', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(mockInsightsService.generateEnhancedRiskAssessment).toHaveBeenCalled();
    });

    it('should generate recommendations', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(mockInsightsService.generatePrioritizedRecommendations).toHaveBeenCalled();
    });
  });

  describe('execute - roi-calculation', () => {
    it('should perform ROI calculation', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'roi-calculation' }));
      expect(result.success).toBe(true);
      expect(mockROIService.performROICalculation).toHaveBeenCalled();
    });

    it('should also perform business impact for ROI', async () => {
      await agent.execute(makeContext(), makeInput({ analysisType: 'roi-calculation' }));
      expect(mockForecastingService.performBusinessImpactAnalysis).toHaveBeenCalled();
    });

    it('should fail without required data for ROI', async () => {
      const result = await agent.execute(
        makeContext(),
        makeInput({ analysisType: 'roi-calculation', dataQualityResults: undefined, processOptimizationResults: undefined }),
      );
      expect(result.success).toBe(false);
      expect(result.errors![0]).toContain('Data quality and process optimization results required');
    });
  });

  describe('execute - compliance-validation', () => {
    it('should perform compliance validation', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'compliance-validation' }));
      expect(result.success).toBe(true);
      const data = result.data as any;
      expect(data.complianceValidation).toBeDefined();
      expect(data.complianceValidation.overallCompliance).toBe(0.85);
    });

    it('should include regulatory gaps', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'compliance-validation' }));
      const data = result.data as any;
      expect(data.complianceValidation.regulatoryGaps.length).toBeGreaterThan(0);
    });

    it('should include critical issues', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'compliance-validation' }));
      const data = result.data as any;
      expect(data.complianceValidation.criticalIssues.length).toBeGreaterThan(0);
    });

    it('should use org regulatory requirements', async () => {
      const result = await agent.execute(
        makeContext(),
        makeInput({
          analysisType: 'compliance-validation',
          organizationProfile: makeOrgProfile({ regulatoryRequirements: ['HIPAA'] }),
        }),
      );
      const data = result.data as any;
      expect(data.complianceValidation.regulatoryGaps[0].regulation).toBe('HIPAA');
    });

    it('should default to GDPR/SOX when no requirements specified', async () => {
      const result = await agent.execute(
        makeContext(),
        makeInput({
          analysisType: 'compliance-validation',
          organizationProfile: makeOrgProfile({ regulatoryRequirements: undefined }),
        }),
      );
      const data = result.data as any;
      expect(data.complianceValidation.regulations[0].regulation).toBe('GDPR');
    });
  });

  describe('execute - comprehensive', () => {
    it('should perform all analyses', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'comprehensive' }));
      expect(result.success).toBe(true);
      expect(mockForecastingService.performBusinessImpactAnalysis).toHaveBeenCalled();
      expect(mockROIService.performROICalculation).toHaveBeenCalled();
    });

    it('should skip ROI if no implementation scenario', async () => {
      const result = await agent.execute(
        makeContext(),
        makeInput({ analysisType: 'comprehensive', implementationScenario: undefined }),
      );
      expect(result.success).toBe(true);
      expect(mockROIService.performROICalculation).not.toHaveBeenCalled();
    });
  });

  describe('execute - unsupported type', () => {
    it('should fail for unsupported analysis type', async () => {
      // Bypass validateInput by using a type that passes validation but isn't handled
      // Since validateInput checks a fixed list, we need to test via direct validation
      const result = await agent.validateInput(makeInput({ analysisType: 'unknown-type' }));
      expect(result).toBe(false);
    });
  });

  describe('execute - error handling', () => {
    it('should return failure on service error', async () => {
      mockForecastingService.performBusinessImpactAnalysis.mockRejectedValueOnce(
        new Error('Forecasting service down'),
      );

      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.hallucination_risk).toBe('high');
      expect(result.governance_flags).toContain('execution_failure');
    });

    it('should include execution time on error', async () => {
      mockForecastingService.performBusinessImpactAnalysis.mockRejectedValueOnce(new Error('fail'));

      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(result.executionTime).toBeDefined();
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe('reasoning generation', () => {
    it('should include analysis type and org name', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(result.reasoning).toContain('business-impact');
      expect(result.reasoning).toContain('Acme Corp');
      expect(result.reasoning).toContain('manufacturing');
    });

    it('should include business impact score when available', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'business-impact' }));
      expect(result.reasoning).toContain('78');
    });

    it('should include ROI payback period when available', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'roi-calculation' }));
      expect(result.reasoning).toContain('8-month payback');
    });

    it('should include compliance level when available', async () => {
      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'compliance-validation' }));
      expect(result.reasoning).toContain('85%');
    });

    it('should include recommendation count', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      expect(result.reasoning).toContain('1 prioritized recommendations');
    });
  });

  describe('hallucination risk assessment', () => {
    it('should return low for normal scores', async () => {
      const result = await agent.execute(makeContext(), makeInput());
      expect(result.hallucination_risk).toBe('low');
    });

    it('should return medium for high IRR', async () => {
      mockROIService.performROICalculation.mockResolvedValueOnce({
        ...mockROI,
        internalRateOfReturn: 6.0, // > 5 = unrealistic
      });

      const result = await agent.execute(makeContext(), makeInput({ analysisType: 'roi-calculation' }));
      expect(result.hallucination_risk).toBe('medium');
    });

    it('should return high for score > 100', async () => {
      mockInsightsService.generateExecutiveSummary.mockResolvedValueOnce({
        ...mockExecutiveSummary,
        overallScore: 150,
      });

      const result = await agent.execute(makeContext(), makeInput());
      expect(result.hallucination_risk).toBe('high');
    });
  });

  describe('governance flags', () => {
    it('should flag high priority recommendations', async () => {
      mockInsightsService.generatePrioritizedRecommendations.mockResolvedValueOnce([
        { title: 'Critical fix', priority: 'critical', estimatedROI: 0.5 },
      ]);

      const result = await agent.execute(makeContext(), makeInput());
      expect(result.governance_flags).toContain('high_priority_recommendations');
    });

    it('should flag low confidence', async () => {
      mockMetricsService.calculateConfidence.mockReturnValueOnce(0.85).mockReturnValueOnce(0.6);

      const result = await agent.execute(makeContext(), makeInput());
      expect(result.governance_flags).toContain('low_confidence');
    });

    it('should flag high risk assessment', async () => {
      mockInsightsService.generateEnhancedRiskAssessment.mockResolvedValueOnce({
        overallRiskScore: 80,
        categories: [],
      });

      const result = await agent.execute(makeContext(), makeInput());
      expect(result.governance_flags).toContain('high_risk_assessment');
    });
  });

  describe('getSchema', () => {
    it('should return valid schema', () => {
      const schema = agent.getSchema();
      expect(schema.inputSchema).toBeDefined();
      expect(schema.outputSchema).toBeDefined();
      expect(schema.capabilities).toEqual(agent.capabilities);
    });

    it('should include resource requirements', () => {
      const schema = agent.getSchema();
      expect(schema.resourceRequirements.maxMemory).toBe(256);
      expect(schema.resourceRequirements.maxExecutionTime).toBe(60000);
    });
  });
});
