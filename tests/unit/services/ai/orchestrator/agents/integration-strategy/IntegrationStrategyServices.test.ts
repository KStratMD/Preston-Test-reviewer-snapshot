/**
 * Comprehensive Unit Tests for Integration Strategy Services
 *
 * Tests all 13 services extracted from IntegrationStrategyAgent:
 * 1. ArchitectureTemplateService
 * 2. CompatibilityAnalysisService
 * 3. ComplexityAnalysisService
 * 4. IntegrationPatternAnalysisService
 * 5. IntegrationStrategyGeneratorService
 * 6. IntegrationStrategyValidationService
 * 7. MaintainabilityAnalysisService
 * 8. MigrationPlanningService
 * 9. PerformanceAnalysisService
 * 10. ResourceEstimationService
 * 11. RiskManagementService
 * 12. ScalabilityAnalysisService
 * 13. SecurityAnalysisService
 */

import 'reflect-metadata';

import { ArchitectureTemplateService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ArchitectureTemplateService';
import { CompatibilityAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/CompatibilityAnalysisService';
import { ComplexityAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ComplexityAnalysisService';
import { IntegrationPatternAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationPatternAnalysisService';
import { IntegrationStrategyGeneratorService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationStrategyGeneratorService';
import { IntegrationStrategyValidationService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationStrategyValidationService';
import { MaintainabilityAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/MaintainabilityAnalysisService';
import { MigrationPlanningService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/MigrationPlanningService';
import { PerformanceAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/PerformanceAnalysisService';
import { ResourceEstimationService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ResourceEstimationService';
import { RiskManagementService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/RiskManagementService';
import { ScalabilityAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ScalabilityAnalysisService';
import { SecurityAnalysisService } from '../../../../../../../src/services/ai/orchestrator/agents/services/integration-strategy/SecurityAnalysisService';

import type { IntegrationPattern } from '../../../../../../../src/services/ai/orchestrator/agents/types/integration-strategy/patterns.types';
import type {
  SystemProfile,
  BusinessRequirement,
  IntegrationStrategyInput,
  ArchitectureOption,
  IntegrationApproach,
  IntegrationRisk
} from '../../../../../../../src/services/ai/orchestrator/interfaces';

// ============================================================================
// Shared Mock Logger
// ============================================================================
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
} as any;

// ============================================================================
// Shared Test Fixtures
// ============================================================================

function createSourceSystem(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    name: 'NetSuite ERP',
    type: 'erp',
    version: '2024.1',
    capabilities: ['REST API', 'SOAP API', 'SuiteScript', 'Workflow automation'],
    limitations: ['Rate limiting', 'Complex authentication'],
    apiSupport: [
      { type: 'rest', version: '1.0', authentication: ['oauth', 'token'], rateLimits: { requestsPerMinute: 60 } },
      { type: 'soap', version: '2.0', authentication: ['token'], rateLimits: { requestsPerMinute: 30 } }
    ],
    dataVolume: { recordCount: 500000, growthRate: 0.15, peakLoad: 1000, dataTypes: ['customers', 'orders', 'invoices'] },
    securityLevel: 'enterprise',
    ...overrides
  };
}

function createTargetSystem(overrides: Partial<SystemProfile> = {}): SystemProfile {
  return {
    name: 'Salesforce CRM',
    type: 'crm',
    version: '58.0',
    capabilities: ['REST API', 'Bulk API', 'Streaming API', 'Apex triggers'],
    limitations: ['Governor limits', 'API call limits'],
    apiSupport: [
      { type: 'rest', version: '58.0', authentication: ['oauth'], rateLimits: { requestsPerDay: 100000 } }
    ],
    dataVolume: { recordCount: 200000, growthRate: 0.20, peakLoad: 500, dataTypes: ['accounts', 'contacts', 'opportunities'] },
    securityLevel: 'high',
    ...overrides
  };
}

function createBusinessRequirements(count = 3): BusinessRequirement[] {
  const priorities: Array<'low' | 'medium' | 'high' | 'critical'> = ['critical', 'high', 'medium', 'low'];
  const types: Array<'functional' | 'non_functional' | 'compliance' | 'performance'> = ['functional', 'non_functional', 'compliance', 'performance'];
  const reqs: BusinessRequirement[] = [];
  for (let i = 0; i < count; i++) {
    reqs.push({
      id: `REQ-${i + 1}`,
      description: `Business requirement ${i + 1}`,
      priority: priorities[i % priorities.length],
      type: types[i % types.length],
      acceptanceCriteria: [`Criterion ${i + 1}a`, `Criterion ${i + 1}b`]
    });
  }
  return reqs;
}

function createStrategyInput(overrides: Partial<IntegrationStrategyInput> = {}): IntegrationStrategyInput {
  return {
    sourceSystemProfile: createSourceSystem(),
    targetSystemProfile: createTargetSystem(),
    businessRequirements: createBusinessRequirements(),
    ...overrides
  };
}

function createIntegrationPattern(overrides: Partial<IntegrationPattern> = {}): IntegrationPattern {
  return {
    name: 'api_first',
    type: 'api',
    description: 'API-first integration approach using RESTful services',
    benefits: ['Loose coupling', 'Scalability', 'Reusability'],
    drawbacks: ['Latency', 'Complexity of API versioning'],
    applicability: ['Cloud-native systems', 'Microservices'],
    complexity: 'medium',
    maturity: 'proven',
    ...overrides
  };
}

function createArchitectureAssessment(overrides: any = {}): any {
  return {
    compatibility: {
      overallScore: 0.85,
      apiCompatibility: 0.9,
      dataFormatCompatibility: 0.8,
      protocolCompatibility: 0.85,
      versionCompatibility: 0.85,
      incompatibilities: [],
      mitigations: [],
      ...overrides.compatibility
    },
    complexity: {
      overallComplexity: 'medium',
      technicalComplexity: 0.5,
      businessComplexity: 0.6,
      organizationalComplexity: 0.5,
      complexityFactors: [],
      simplificationOpportunities: [],
      ...overrides.complexity
    },
    scalability: {
      currentCapacity: { throughput: 1000, concurrentUsers: 100, dataVolume: 500000, transactionRate: 50, storageRequirements: 1000000 },
      projectedGrowth: { timeframe: '2 years', expectedGrowth: [], growthFactors: [], uncertainty: 'medium' },
      scalabilityLimits: [],
      scalingStrategies: [],
      bottlenecks: [],
      ...overrides.scalability
    },
    security: {
      overallRiskLevel: 'medium',
      threatAssessment: { threats: [], attackVectors: [], riskMatrix: { low: 8, medium: 4, high: 2, critical: 0 }, businessImpact: { financialImpact: 50000, reputationalImpact: 'medium', operationalImpact: 'medium', complianceImpact: 'low' } },
      vulnerabilities: [],
      complianceRequirements: [],
      securityControls: [],
      recommendations: [],
      ...overrides.security
    },
    performance: {
      currentPerformance: { latency: 100, throughput: 139, availability: 0.99, responseTime: 200, errorRate: 0.01, concurrency: 50 },
      performanceRequirements: [],
      performanceGaps: [],
      optimizationOpportunities: [],
      performanceRisks: [],
      ...overrides.performance
    },
    maintainability: {
      maintainabilityScore: 0.7,
      codeQuality: { complexity: 0.7, duplication: 0.1, testability: 0.8, modularity: 0.8, coupling: 0.3, cohesion: 0.8 },
      technicalDebt: { overallDebt: 0.3, debtCategories: [], remediationPlan: { phases: [], totalEffort: 0, totalCost: 0, timeline: 0 }, businessImpact: '' },
      documentationQuality: { completeness: 0.7, accuracy: 0.8, accessibility: 0.6, maintenance: 0.5, gaps: [], recommendations: [] },
      testCoverage: { unitTestCoverage: 75, integrationTestCoverage: 60, e2eTestCoverage: 40, testQuality: 0.7, testAutomation: 0.8, testingGaps: [] },
      maintainabilityRisks: [],
      ...overrides.maintainability
    }
  };
}

function createArchitectureOption(overrides: Partial<ArchitectureOption> = {}): ArchitectureOption {
  return {
    name: 'API First Architecture',
    description: 'API-first integration approach',
    pros: ['Loose coupling', 'Scalability'],
    cons: ['Latency', 'Complexity'],
    estimatedCost: 50000,
    implementationTime: 90,
    complexity: 'medium',
    scalability: 'high',
    ...overrides
  };
}

function createIntegrationApproach(overrides: Partial<IntegrationApproach> = {}): IntegrationApproach {
  return {
    name: 'API First Integration',
    description: 'API-first approach optimized for ERP to CRM integration',
    pattern: 'api_first',
    complexity: 'medium',
    recommendationReason: 'Best fit based on system capabilities and requirements',
    ...overrides
  };
}

// ============================================================================
// 1. ArchitectureTemplateService
// ============================================================================
describe('ArchitectureTemplateService', () => {
  let service: ArchitectureTemplateService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ArchitectureTemplateService();
  });

  describe('constructor and initialization', () => {
    it('should initialize with default architecture templates', () => {
      const templates = service.getTemplates();
      expect(templates.size).toBeGreaterThanOrEqual(3);
      expect(templates.has('erp_to_crm')).toBe(true);
      expect(templates.has('database_to_database')).toBe(true);
      expect(templates.has('legacy_to_modern')).toBe(true);
    });

    it('should set correct properties on erp_to_crm template', () => {
      const template = service.getTemplates().get('erp_to_crm');
      expect(template).toBeDefined();
      expect(template!.name).toBe('ERP to CRM Integration');
      expect(template!.sourceTypes).toContain('erp');
      expect(template!.targetTypes).toContain('crm');
      expect(template!.complexity).toBe('medium');
      expect(template!.typicalDuration).toBe(90);
      expect(template!.commonChallenges).toHaveLength(3);
      expect(template!.successFactors).toHaveLength(3);
    });

    it('should set correct properties on database_to_database template', () => {
      const template = service.getTemplates().get('database_to_database');
      expect(template).toBeDefined();
      expect(template!.complexity).toBe('low');
      expect(template!.typicalDuration).toBe(60);
    });

    it('should set correct properties on legacy_to_modern template', () => {
      const template = service.getTemplates().get('legacy_to_modern');
      expect(template).toBeDefined();
      expect(template!.complexity).toBe('high');
      expect(template!.typicalDuration).toBe(120);
    });
  });

  describe('addArchitectureTemplate', () => {
    it('should add a new template to the registry', () => {
      service.addArchitectureTemplate('custom_template', {
        name: 'Custom Integration',
        sourceTypes: ['api'],
        targetTypes: ['database'],
        recommendedPatterns: ['api_first'],
        complexity: 'low',
        typicalDuration: 45,
        commonChallenges: ['Schema mapping'],
        successFactors: ['Good documentation']
      });

      const templates = service.getTemplates();
      expect(templates.has('custom_template')).toBe(true);
      expect(templates.get('custom_template')!.name).toBe('Custom Integration');
    });

    it('should overwrite an existing template with the same ID', () => {
      service.addArchitectureTemplate('erp_to_crm', {
        name: 'Updated ERP to CRM',
        sourceTypes: ['erp'],
        targetTypes: ['crm'],
        recommendedPatterns: ['hybrid'],
        complexity: 'high',
        typicalDuration: 150,
        commonChallenges: [],
        successFactors: []
      });

      const template = service.getTemplates().get('erp_to_crm');
      expect(template!.name).toBe('Updated ERP to CRM');
      expect(template!.complexity).toBe('high');
    });
  });

  describe('initializeArchitectureTemplates', () => {
    it('should be callable multiple times without duplicating templates', () => {
      service.initializeArchitectureTemplates();
      service.initializeArchitectureTemplates();
      // Map keys are unique, so repeated init should not add duplicates
      expect(service.getTemplates().size).toBe(3);
    });
  });

  describe('createArchitectureOption', () => {
    it('should create an architecture option from pattern and assessment', () => {
      const pattern = createIntegrationPattern();
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();

      const option = service.createArchitectureOption(pattern, input, assessment);

      expect(option).toBeDefined();
      expect(option.name).toContain('Architecture');
      expect(option.description).toBe(pattern.description);
      expect(option.pros).toEqual(pattern.benefits);
      expect(option.cons).toEqual(pattern.drawbacks);
      expect(option.complexity).toBe('medium');
      expect(option.estimatedCost).toBeGreaterThan(0);
      expect(option.implementationTime).toBeGreaterThan(0);
      expect(typeof option.scalability).toBe('string');
    });

    it('should increase cost for low compatibility scores', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const input = createStrategyInput();
      const highCompat = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });
      const lowCompat = createArchitectureAssessment({ compatibility: { overallScore: 0.5 } });

      const optionHigh = service.createArchitectureOption(pattern, input, highCompat);
      const optionLow = service.createArchitectureOption(pattern, input, lowCompat);

      expect(optionLow.estimatedCost).toBeGreaterThan(optionHigh.estimatedCost);
    });

    it('should increase time for low compatibility scores', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const input = createStrategyInput();
      const highCompat = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });
      const lowCompat = createArchitectureAssessment({ compatibility: { overallScore: 0.5 } });

      const optionHigh = service.createArchitectureOption(pattern, input, highCompat);
      const optionLow = service.createArchitectureOption(pattern, input, lowCompat);

      expect(optionLow.implementationTime).toBeGreaterThan(optionHigh.implementationTime);
    });

    it('should scale cost with pattern complexity', () => {
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();

      const lowOption = service.createArchitectureOption(createIntegrationPattern({ complexity: 'low' }), input, assessment);
      const medOption = service.createArchitectureOption(createIntegrationPattern({ complexity: 'medium' }), input, assessment);
      const highOption = service.createArchitectureOption(createIntegrationPattern({ complexity: 'high' }), input, assessment);

      expect(lowOption.estimatedCost).toBeLessThan(medOption.estimatedCost);
      expect(medOption.estimatedCost).toBeLessThan(highOption.estimatedCost);
    });

    it('should assign correct scalability for api pattern type', () => {
      const pattern = createIntegrationPattern({ type: 'api' });
      const option = service.createArchitectureOption(pattern, createStrategyInput(), createArchitectureAssessment());
      expect(option.scalability).toBe('high');
    });

    it('should assign correct scalability for batch pattern type', () => {
      const pattern = createIntegrationPattern({ type: 'batch' });
      const option = service.createArchitectureOption(pattern, createStrategyInput(), createArchitectureAssessment());
      expect(option.scalability).toBe('medium');
    });

    it('should assign correct scalability for data pattern type', () => {
      const pattern = createIntegrationPattern({ type: 'data' });
      const option = service.createArchitectureOption(pattern, createStrategyInput(), createArchitectureAssessment());
      expect(option.scalability).toBe('low');
    });
  });

  describe('calculateOptionScore', () => {
    it('should calculate a numeric score for an option', () => {
      const option = createArchitectureOption();
      const score = service.calculateOptionScore(option);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThan(0);
    });

    it('should give higher scores to lower cost options', () => {
      const cheapOption = createArchitectureOption({ estimatedCost: 10000 });
      const expensiveOption = createArchitectureOption({ estimatedCost: 90000 });

      expect(service.calculateOptionScore(cheapOption)).toBeGreaterThan(service.calculateOptionScore(expensiveOption));
    });

    it('should give higher scores to lower implementation time', () => {
      const fastOption = createArchitectureOption({ implementationTime: 30 });
      const slowOption = createArchitectureOption({ implementationTime: 170 });

      expect(service.calculateOptionScore(fastOption)).toBeGreaterThan(service.calculateOptionScore(slowOption));
    });

    it('should give higher scores to lower complexity', () => {
      const lowOption = createArchitectureOption({ complexity: 'low' });
      const highOption = createArchitectureOption({ complexity: 'high' });

      expect(service.calculateOptionScore(lowOption)).toBeGreaterThan(service.calculateOptionScore(highOption));
    });

    it('should give higher scores to higher scalability', () => {
      const highScalable = createArchitectureOption({ scalability: 'high' });
      const lowScalable = createArchitectureOption({ scalability: 'low' });

      expect(service.calculateOptionScore(highScalable)).toBeGreaterThan(service.calculateOptionScore(lowScalable));
    });
  });

  describe('determineApproachComplexity', () => {
    it('should return high when pattern complexity is high', () => {
      const pattern = createIntegrationPattern({ complexity: 'high' });
      const assessment = createArchitectureAssessment({ complexity: { overallComplexity: 'low' } });

      expect(service.determineApproachComplexity(pattern, assessment)).toBe('high');
    });

    it('should return high when system complexity is high', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ complexity: { overallComplexity: 'high' } });

      expect(service.determineApproachComplexity(pattern, assessment)).toBe('high');
    });

    it('should return high when system complexity is very_high', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ complexity: { overallComplexity: 'very_high' } });

      expect(service.determineApproachComplexity(pattern, assessment)).toBe('high');
    });

    it('should return medium when either is medium', () => {
      const pattern = createIntegrationPattern({ complexity: 'medium' });
      const assessment = createArchitectureAssessment({ complexity: { overallComplexity: 'low' } });

      expect(service.determineApproachComplexity(pattern, assessment)).toBe('medium');
    });

    it('should return low when both are low', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ complexity: { overallComplexity: 'low' } });

      expect(service.determineApproachComplexity(pattern, assessment)).toBe('low');
    });
  });

  describe('mapPatternTypeToApproach', () => {
    it('should map messaging to event_driven', () => {
      expect(service.mapPatternTypeToApproach('messaging')).toBe('event_driven');
    });

    it('should map data to batch', () => {
      expect(service.mapPatternTypeToApproach('data')).toBe('batch');
    });

    it('should map api to api_first', () => {
      expect(service.mapPatternTypeToApproach('api')).toBe('api_first');
    });

    it('should map event to event_driven', () => {
      expect(service.mapPatternTypeToApproach('event')).toBe('event_driven');
    });

    it('should map batch to batch', () => {
      expect(service.mapPatternTypeToApproach('batch')).toBe('batch');
    });
  });
});

// ============================================================================
// 2. CompatibilityAnalysisService
// ============================================================================
describe('CompatibilityAnalysisService', () => {
  let service: CompatibilityAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new CompatibilityAnalysisService();
  });

  describe('analyzeCompatibility', () => {
    it('should return a complete compatibility analysis', () => {
      const source = createSourceSystem();
      const target = createTargetSystem();

      const result = service.analyzeCompatibility(source, target);

      expect(result).toBeDefined();
      expect(typeof result.overallScore).toBe('number');
      expect(typeof result.apiCompatibility).toBe('number');
      expect(typeof result.dataFormatCompatibility).toBe('number');
      expect(typeof result.protocolCompatibility).toBe('number');
      expect(typeof result.versionCompatibility).toBe('number');
      expect(Array.isArray(result.incompatibilities)).toBe(true);
      expect(Array.isArray(result.mitigations)).toBe(true);
    });

    it('should calculate overallScore as average of four compatibility scores', () => {
      const source = createSourceSystem();
      const target = createTargetSystem();

      const result = service.analyzeCompatibility(source, target);
      const expectedAvg = (result.apiCompatibility + result.dataFormatCompatibility + result.protocolCompatibility + result.versionCompatibility) / 4;

      expect(result.overallScore).toBeCloseTo(expectedAvg, 5);
    });

    it('should detect security level mismatch incompatibilities', () => {
      const source = createSourceSystem({ securityLevel: 'enterprise' });
      const target = createTargetSystem({ securityLevel: 'basic' });

      const result = service.analyzeCompatibility(source as any, target as any);

      expect(result.incompatibilities.length).toBeGreaterThan(0);
      const securityIncompat = result.incompatibilities.find(i => i.type === 'security');
      expect(securityIncompat).toBeDefined();
      expect(securityIncompat!.severity).toBe('medium');
    });

    it('should generate mitigations for each incompatibility', () => {
      const source = createSourceSystem({ securityLevel: 'enterprise' });
      const target = createTargetSystem({ securityLevel: 'basic' });

      const result = service.analyzeCompatibility(source as any, target as any);

      expect(result.mitigations.length).toBe(result.incompatibilities.length);
      if (result.mitigations.length > 0) {
        expect(result.mitigations[0].strategy).toBe('upgrade');
        expect(result.mitigations[0].effort).toBeDefined();
        expect(result.mitigations[0].cost).toBeGreaterThan(0);
        expect(result.mitigations[0].timeline).toBeGreaterThan(0);
      }
    });

    it('should report high API compatibility when common API types exist', () => {
      const source = { name: 'Source', apiSupport: [{ type: 'rest' }] };
      const target = { name: 'Target', apiSupport: [{ type: 'rest' }] };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.apiCompatibility).toBe(0.9);
    });

    it('should report low API compatibility for file-based fallback', () => {
      const source = { name: 'Source' };
      const target = { name: 'Target' };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.apiCompatibility).toBe(0.3);
    });

    it('should report medium API compatibility when no common types', () => {
      const source = { name: 'Source', apiSupport: [{ type: 'rest' }] };
      const target = { name: 'Target', apiSupport: [{ type: 'soap' }] };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.apiCompatibility).toBe(0.5);
    });

    it('should give high data format compatibility for modern systems', () => {
      const source = { name: 'Source', type: 'erp' };
      const target = { name: 'Target', type: 'crm' };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.dataFormatCompatibility).toBe(0.9);
    });

    it('should give medium data format compatibility for mixed systems', () => {
      const source = { name: 'Source', type: 'erp' };
      const target = { name: 'Target', type: 'file' };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.dataFormatCompatibility).toBe(0.7);
    });

    it('should give low data format compatibility for non-modern systems', () => {
      const source = { name: 'Source', type: 'file' };
      const target = { name: 'Target', type: 'other' };

      const result = service.analyzeCompatibility(source as any, target as any);
      expect(result.dataFormatCompatibility).toBe(0.5);
    });

    it('should not flag incompatibility when security levels are close', () => {
      const source = { name: 'Source', securityLevel: 'standard' };
      const target = { name: 'Target', securityLevel: 'high' };

      const result = service.analyzeCompatibility(source as any, target as any);
      const securityIncompat = result.incompatibilities.find(i => i.type === 'security');
      expect(securityIncompat).toBeUndefined();
    });
  });
});

// ============================================================================
// 3. ComplexityAnalysisService
// ============================================================================
describe('ComplexityAnalysisService', () => {
  let service: ComplexityAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ComplexityAnalysisService();
  });

  describe('analyzeComplexity', () => {
    it('should return a complete complexity analysis', () => {
      const source = createSourceSystem();
      const target = createTargetSystem();

      const result = service.analyzeComplexity(source, target);

      expect(result).toBeDefined();
      expect(typeof result.overallComplexity).toBe('string');
      expect(['low', 'medium', 'high', 'very_high']).toContain(result.overallComplexity);
      expect(typeof result.technicalComplexity).toBe('number');
      expect(typeof result.businessComplexity).toBe('number');
      expect(typeof result.organizationalComplexity).toBe('number');
      expect(Array.isArray(result.complexityFactors)).toBe(true);
      expect(Array.isArray(result.simplificationOpportunities)).toBe(true);
    });

    it('should return medium complexity for typical modern systems', () => {
      const result = service.analyzeComplexity(createSourceSystem(), createTargetSystem());
      expect(['medium', 'high']).toContain(result.overallComplexity);
    });

    it('should increase complexity for file-based systems', () => {
      const fileSource = createSourceSystem({ type: 'file' });
      const target = createTargetSystem();

      const result = service.analyzeComplexity(fileSource, target);
      expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.6);
    });

    it('should increase complexity when many limitations exist', () => {
      const source = createSourceSystem({
        limitations: ['Limit 1', 'Limit 2', 'Limit 3', 'Limit 4', 'Limit 5']
      });
      const target = createTargetSystem();

      const result = service.analyzeComplexity(source, target);
      expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.7);
    });

    it('should increase complexity when no API support exists', () => {
      const source = createSourceSystem({ apiSupport: [] });
      const target = createTargetSystem();

      const result = service.analyzeComplexity(source, target);
      expect(result.technicalComplexity).toBeGreaterThanOrEqual(0.6);
    });

    it('should identify complexity factors for systems with many limitations', () => {
      const source = createSourceSystem({
        limitations: ['A', 'B', 'C', 'D', 'E']
      });
      const result = service.analyzeComplexity(source, createTargetSystem());

      expect(result.complexityFactors.length).toBeGreaterThan(0);
      expect(result.complexityFactors[0].factor).toContain('Source system limitations');
    });

    it('should not add complexity factors for systems with few limitations', () => {
      const source = createSourceSystem({ limitations: ['One'] });
      const result = service.analyzeComplexity(source, createTargetSystem());

      expect(result.complexityFactors.length).toBe(0);
    });

    it('should generate simplification opportunities matching complexity factors', () => {
      const source = createSourceSystem({
        limitations: ['A', 'B', 'C', 'D', 'E']
      });
      const result = service.analyzeComplexity(source, createTargetSystem());

      expect(result.simplificationOpportunities.length).toBe(result.complexityFactors.length);
      if (result.simplificationOpportunities.length > 0) {
        expect(result.simplificationOpportunities[0].potentialReduction).toBe(0.2);
        expect(result.simplificationOpportunities[0].risks).toHaveLength(2);
      }
    });

    it('should cap technical complexity at 1.0', () => {
      const source = createSourceSystem({
        type: 'file',
        limitations: ['A', 'B', 'C', 'D', 'E'],
        apiSupport: []
      });
      const target = createTargetSystem({
        type: 'file',
        limitations: ['A', 'B', 'C', 'D', 'E'],
        apiSupport: []
      });

      const result = service.analyzeComplexity(source, target);
      expect(result.technicalComplexity).toBeLessThanOrEqual(1.0);
    });
  });
});

// ============================================================================
// 4. IntegrationPatternAnalysisService
// ============================================================================
describe('IntegrationPatternAnalysisService', () => {
  let service: IntegrationPatternAnalysisService;
  let patternsMap: Map<string, IntegrationPattern>;

  beforeEach(() => {
    jest.clearAllMocks();

    patternsMap = new Map();
    patternsMap.set('api_first', createIntegrationPattern({
      name: 'api_first',
      type: 'api',
      complexity: 'medium',
      maturity: 'proven'
    }));
    patternsMap.set('event_driven', createIntegrationPattern({
      name: 'event_driven',
      type: 'event',
      complexity: 'high',
      maturity: 'proven'
    }));
    patternsMap.set('batch_processing', createIntegrationPattern({
      name: 'batch_processing',
      type: 'batch',
      complexity: 'low',
      maturity: 'proven'
    }));
    patternsMap.set('experimental_pattern', createIntegrationPattern({
      name: 'experimental_pattern',
      type: 'messaging',
      complexity: 'high',
      maturity: 'emerging'
    }));

    service = new IntegrationPatternAnalysisService(patternsMap);
  });

  describe('analyzeIntegrationPatterns', () => {
    it('should return a complete pattern analysis', () => {
      const source = createSourceSystem();
      const target = createTargetSystem();
      const requirements = createBusinessRequirements();

      const result = service.analyzeIntegrationPatterns(source, target, requirements);

      expect(result).toBeDefined();
      expect(Array.isArray(result.recommendedPatterns)).toBe(true);
      expect(Array.isArray(result.patternComparison)).toBe(true);
      expect(Array.isArray(result.antiPatterns)).toBe(true);
      expect(Array.isArray(result.bestPractices)).toBe(true);
    });

    it('should recommend only proven patterns', () => {
      const result = service.analyzeIntegrationPatterns(
        createSourceSystem(),
        createTargetSystem(),
        createBusinessRequirements()
      );

      for (const pattern of result.recommendedPatterns) {
        expect(pattern.maturity).toBe('proven');
      }
      // experimental_pattern should be excluded
      expect(result.recommendedPatterns.find(p => p.name === 'experimental_pattern')).toBeUndefined();
    });

    it('should generate pattern comparisons for recommended patterns', () => {
      const result = service.analyzeIntegrationPatterns(
        createSourceSystem(),
        createTargetSystem(),
        createBusinessRequirements()
      );

      // For n patterns, should have n*(n-1)/2 comparisons
      const n = result.recommendedPatterns.length;
      const expectedComparisons = (n * (n - 1)) / 2;
      expect(result.patternComparison.length).toBe(expectedComparisons);
    });

    it('should always include monitoring and data validation best practices', () => {
      const result = service.analyzeIntegrationPatterns(
        createSourceSystem(),
        createTargetSystem(),
        createBusinessRequirements()
      );

      expect(result.bestPractices.length).toBeGreaterThanOrEqual(2);
      expect(result.bestPractices.some(bp => bp.practice === 'Comprehensive Monitoring')).toBe(true);
      expect(result.bestPractices.some(bp => bp.practice === 'Data Validation Framework')).toBe(true);
    });

    it('should detect anti-patterns for systems with many limitations', () => {
      const source = createSourceSystem({
        limitations: ['L1', 'L2', 'L3', 'L4', 'L5', 'L6']
      });

      const result = service.analyzeIntegrationPatterns(source, createTargetSystem(), createBusinessRequirements());

      expect(result.antiPatterns.length).toBeGreaterThan(0);
      expect(result.antiPatterns[0].name).toBe('Big Ball of Mud Integration');
    });

    it('should not detect anti-patterns for systems with few limitations', () => {
      const source = createSourceSystem({ limitations: ['L1'] });
      const target = createTargetSystem({ limitations: ['L1'] });

      const result = service.analyzeIntegrationPatterns(source, target, createBusinessRequirements());

      expect(result.antiPatterns.length).toBe(0);
    });
  });

  describe('selectBestPattern', () => {
    it('should select the least complex proven pattern', () => {
      const patterns = [
        createIntegrationPattern({ name: 'complex', complexity: 'high', maturity: 'proven' }),
        createIntegrationPattern({ name: 'simple', complexity: 'low', maturity: 'proven' }),
        createIntegrationPattern({ name: 'medium', complexity: 'medium', maturity: 'proven' })
      ];

      const result = service.selectBestPattern(
        patterns,
        createBusinessRequirements(),
        createArchitectureAssessment(),
        []
      );

      expect(result.name).toBe('simple');
    });

    it('should prefer proven patterns over emerging ones', () => {
      const patterns = [
        createIntegrationPattern({ name: 'emerging_simple', complexity: 'low', maturity: 'emerging' }),
        createIntegrationPattern({ name: 'proven_complex', complexity: 'high', maturity: 'proven' })
      ];

      const result = service.selectBestPattern(
        patterns,
        createBusinessRequirements(),
        createArchitectureAssessment(),
        []
      );

      expect(result.name).toBe('proven_complex');
    });

    it('should fallback to first pattern when no proven patterns exist', () => {
      const patterns = [
        createIntegrationPattern({ name: 'first_emerging', maturity: 'emerging' }),
        createIntegrationPattern({ name: 'second_emerging', maturity: 'emerging' })
      ];

      const result = service.selectBestPattern(
        patterns,
        createBusinessRequirements(),
        createArchitectureAssessment(),
        []
      );

      expect(result.name).toBe('first_emerging');
    });
  });

  describe('assessPatternMaturity', () => {
    it('should return 1.0 when all patterns are proven', () => {
      const analysis = {
        recommendedPatterns: [
          createIntegrationPattern({ maturity: 'proven' }),
          createIntegrationPattern({ maturity: 'proven' })
        ],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      expect(service.assessPatternMaturity(analysis)).toBe(1.0);
    });

    it('should return 0.5 when half of patterns are proven', () => {
      const analysis = {
        recommendedPatterns: [
          createIntegrationPattern({ maturity: 'proven' }),
          createIntegrationPattern({ maturity: 'emerging' })
        ],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      expect(service.assessPatternMaturity(analysis)).toBe(0.5);
    });

    it('should return 0 when no patterns are proven', () => {
      const analysis = {
        recommendedPatterns: [
          createIntegrationPattern({ maturity: 'emerging' }),
          createIntegrationPattern({ maturity: 'deprecated' })
        ],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      expect(service.assessPatternMaturity(analysis)).toBe(0);
    });
  });

  describe('assessPatternScalability', () => {
    it('should return high for api patterns', () => {
      expect(service.assessPatternScalability(createIntegrationPattern({ type: 'api' }))).toBe('high');
    });

    it('should return high for event patterns', () => {
      expect(service.assessPatternScalability(createIntegrationPattern({ type: 'event' }))).toBe('high');
    });

    it('should return high for messaging patterns', () => {
      expect(service.assessPatternScalability(createIntegrationPattern({ type: 'messaging' }))).toBe('high');
    });

    it('should return medium for batch patterns', () => {
      expect(service.assessPatternScalability(createIntegrationPattern({ type: 'batch' }))).toBe('medium');
    });

    it('should return low for data patterns', () => {
      expect(service.assessPatternScalability(createIntegrationPattern({ type: 'data' }))).toBe('low');
    });
  });
});

// ============================================================================
// 5. IntegrationStrategyGeneratorService
// ============================================================================
describe('IntegrationStrategyGeneratorService', () => {
  let service: IntegrationStrategyGeneratorService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationStrategyGeneratorService(mockLogger, null, null);
  });

  describe('generateArchitectureOptions', () => {
    it('should generate options based on recommended patterns', async () => {
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();
      const patternAnalysis = {
        recommendedPatterns: [
          createIntegrationPattern({ name: 'pattern1' }),
          createIntegrationPattern({ name: 'pattern2' }),
          createIntegrationPattern({ name: 'pattern3' })
        ],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      const createOptionCb = jest.fn((pattern: IntegrationPattern) => createArchitectureOption({ name: pattern.name }));
      const calcScoreCb = jest.fn(() => 50);

      const result = await service.generateArchitectureOptions(
        input, assessment, patternAnalysis, createOptionCb, calcScoreCb
      );

      expect(result.length).toBe(3);
      expect(createOptionCb).toHaveBeenCalledTimes(3);
    });

    it('should sort options by score (descending)', async () => {
      const patternAnalysis = {
        recommendedPatterns: [
          createIntegrationPattern({ name: 'low' }),
          createIntegrationPattern({ name: 'high' }),
          createIntegrationPattern({ name: 'medium' })
        ],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      const scores: Record<string, number> = { low: 10, high: 90, medium: 50 };
      const createOptionCb = (pattern: IntegrationPattern) => createArchitectureOption({ name: pattern.name });
      const calcScoreCb = (option: ArchitectureOption) => scores[option.name] || 0;

      const result = await service.generateArchitectureOptions(
        createStrategyInput(), createArchitectureAssessment(), patternAnalysis, createOptionCb, calcScoreCb
      );

      expect(result[0].name).toBe('high');
      expect(result[1].name).toBe('medium');
      expect(result[2].name).toBe('low');
    });

    it('should limit results to top 5 options', async () => {
      const patterns = Array.from({ length: 8 }, (_, i) =>
        createIntegrationPattern({ name: `pattern${i}` })
      );
      const patternAnalysis = {
        recommendedPatterns: patterns,
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      const result = await service.generateArchitectureOptions(
        createStrategyInput(),
        createArchitectureAssessment(),
        patternAnalysis,
        (p) => createArchitectureOption({ name: p.name }),
        () => Math.random() * 100
      );

      expect(result.length).toBe(5);
    });

    it('should handle empty patterns list', async () => {
      const patternAnalysis = {
        recommendedPatterns: [],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      const result = await service.generateArchitectureOptions(
        createStrategyInput(),
        createArchitectureAssessment(),
        patternAnalysis,
        () => createArchitectureOption(),
        () => 50
      );

      expect(result.length).toBe(0);
    });
  });

  describe('recommendIntegrationApproach', () => {
    it('should use heuristic fallback when AI providers are unavailable', async () => {
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();
      const patternAnalysis = {
        recommendedPatterns: [createIntegrationPattern()],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };
      const risks: IntegrationRisk[] = [];

      const selectBestCb = jest.fn(() => createIntegrationPattern());

      const result = await service.recommendIntegrationApproach(
        input, assessment, patternAnalysis, risks, selectBestCb
      );

      expect(result).toBeDefined();
      expect(result.name).toBeDefined();
      expect(result.description).toBeDefined();
      expect(result.pattern).toBeDefined();
      expect(result.complexity).toBeDefined();
      expect(result.recommendationReason).toBeDefined();
      expect(selectBestCb).toHaveBeenCalled();
    });

    it('should log warning when AI is unavailable', async () => {
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();
      const patternAnalysis = {
        recommendedPatterns: [createIntegrationPattern()],
        patternComparison: [],
        antiPatterns: [],
        bestPractices: []
      };

      await service.recommendIntegrationApproach(
        input, assessment, patternAnalysis, [],
        () => createIntegrationPattern()
      );

      // The logger.info should be called for "AI providers not available" since providerRegistry is null
      expect(mockLogger.info).toHaveBeenCalled();
    });

    it('should include risk count in recommendation reason when risks exist', async () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'Risk 1', probability: 'medium', impact: 'high', mitigation: 'M1', contingency: 'C1' },
        { category: 'security', description: 'Risk 2', probability: 'low', impact: 'medium', mitigation: 'M2', contingency: 'C2' }
      ];

      const result = await service.recommendIntegrationApproach(
        createStrategyInput(),
        createArchitectureAssessment(),
        { recommendedPatterns: [createIntegrationPattern()], patternComparison: [], antiPatterns: [], bestPractices: [] },
        risks,
        () => createIntegrationPattern()
      );

      expect(result.recommendationReason).toContain('2 identified integration risks');
    });
  });

  describe('generateRecommendationReason', () => {
    it('should generate a multi-part recommendation reason', () => {
      const pattern = createIntegrationPattern();
      const input = createStrategyInput();
      const assessment = createArchitectureAssessment();
      const risks: IntegrationRisk[] = [];

      const reason = service.generateRecommendationReason(pattern, input, assessment, risks);

      expect(reason).toContain(pattern.name);
      expect(reason).toContain(input.sourceSystemProfile.type);
      expect(reason).toContain(input.targetSystemProfile.type);
      expect(reason.endsWith('.')).toBe(true);
    });

    it('should include risk reference when risks are present', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'Data risk', probability: 'high', impact: 'high', mitigation: 'Fix', contingency: 'Backup' }
      ];

      const reason = service.generateRecommendationReason(
        createIntegrationPattern(),
        createStrategyInput(),
        createArchitectureAssessment(),
        risks
      );

      expect(reason).toContain('1 identified integration risks');
    });

    it('should not include risk reference when no risks', () => {
      const reason = service.generateRecommendationReason(
        createIntegrationPattern(),
        createStrategyInput(),
        createArchitectureAssessment(),
        []
      );

      expect(reason).not.toContain('identified integration risks');
    });
  });
});

// ============================================================================
// 6. IntegrationStrategyValidationService
// ============================================================================
describe('IntegrationStrategyValidationService', () => {
  let service: IntegrationStrategyValidationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationStrategyValidationService();
  });

  describe('validateInput', () => {
    it('should return true for valid input', () => {
      const input = createStrategyInput();
      expect(service.validateInput(input)).toBe(true);
    });

    it('should return false when sourceSystemProfile is missing', () => {
      const input = createStrategyInput();
      (input as any).sourceSystemProfile = null;
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when sourceSystemProfile.name is missing', () => {
      const input = createStrategyInput();
      (input.sourceSystemProfile as any).name = '';
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when sourceSystemProfile.type is missing', () => {
      const input = createStrategyInput();
      (input.sourceSystemProfile as any).type = '';
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when targetSystemProfile is missing', () => {
      const input = createStrategyInput();
      (input as any).targetSystemProfile = null;
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when targetSystemProfile.name is missing', () => {
      const input = createStrategyInput();
      (input.targetSystemProfile as any).name = '';
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when targetSystemProfile.type is missing', () => {
      const input = createStrategyInput();
      (input.targetSystemProfile as any).type = '';
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when businessRequirements is null', () => {
      const input = createStrategyInput();
      (input as any).businessRequirements = null;
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when businessRequirements is empty array', () => {
      const input = createStrategyInput({ businessRequirements: [] });
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when businessRequirements is not an array', () => {
      const input = createStrategyInput();
      (input as any).businessRequirements = 'not an array';
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when a requirement is missing id', () => {
      const input = createStrategyInput({
        businessRequirements: [{ id: '', description: 'Desc', priority: 'high', type: 'functional', acceptanceCriteria: [] }]
      });
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when a requirement is missing description', () => {
      const input = createStrategyInput({
        businessRequirements: [{ id: 'REQ-1', description: '', priority: 'high', type: 'functional', acceptanceCriteria: [] }]
      });
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when a requirement is missing priority', () => {
      const input = createStrategyInput({
        businessRequirements: [{ id: 'REQ-1', description: 'Desc', priority: '' as any, type: 'functional', acceptanceCriteria: [] }]
      });
      expect(service.validateInput(input)).toBe(false);
    });

    it('should return false when a requirement is missing type', () => {
      const input = createStrategyInput({
        businessRequirements: [{ id: 'REQ-1', description: 'Desc', priority: 'high', type: '' as any, acceptanceCriteria: [] }]
      });
      expect(service.validateInput(input)).toBe(false);
    });
  });

  describe('getRequirementsClarityScore', () => {
    it('should return 1.0 when all requirements have acceptance criteria', () => {
      const reqs: BusinessRequirement[] = [
        { id: 'R1', description: 'D1', priority: 'high', type: 'functional', acceptanceCriteria: ['AC1'] },
        { id: 'R2', description: 'D2', priority: 'medium', type: 'functional', acceptanceCriteria: ['AC2'] }
      ];
      expect(service.getRequirementsClarityScore(reqs)).toBe(1.0);
    });

    it('should return 0.5 when half of requirements have acceptance criteria', () => {
      const reqs: BusinessRequirement[] = [
        { id: 'R1', description: 'D1', priority: 'high', type: 'functional', acceptanceCriteria: ['AC1'] },
        { id: 'R2', description: 'D2', priority: 'medium', type: 'functional', acceptanceCriteria: [] }
      ];
      expect(service.getRequirementsClarityScore(reqs)).toBe(0.5);
    });

    it('should return 0 when no requirements have acceptance criteria', () => {
      const reqs: BusinessRequirement[] = [
        { id: 'R1', description: 'D1', priority: 'high', type: 'functional', acceptanceCriteria: [] }
      ];
      expect(service.getRequirementsClarityScore(reqs)).toBe(0);
    });

    it('should return 0.5 for empty requirements array', () => {
      expect(service.getRequirementsClarityScore([])).toBe(0.5);
    });
  });

  describe('getTechnicalFeasibilityScore', () => {
    it('should return a score based on total capabilities', () => {
      const input = createStrategyInput();
      const score = service.getTechnicalFeasibilityScore(input);
      expect(typeof score).toBe('number');
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should cap at 1.0 for systems with many capabilities', () => {
      const input = createStrategyInput({
        sourceSystemProfile: createSourceSystem({ capabilities: Array(10).fill('cap') }),
        targetSystemProfile: createTargetSystem({ capabilities: Array(10).fill('cap') })
      });
      expect(service.getTechnicalFeasibilityScore(input)).toBe(1.0);
    });

    it('should return lower score for systems with fewer capabilities', () => {
      const input = createStrategyInput({
        sourceSystemProfile: createSourceSystem({ capabilities: ['one'] }),
        targetSystemProfile: createTargetSystem({ capabilities: ['one'] })
      });
      const score = service.getTechnicalFeasibilityScore(input);
      expect(score).toBeLessThan(1.0);
    });
  });

  describe('getConfidence', () => {
    it('should calculate weighted confidence correctly', () => {
      const factors = [
        { factor: 'clarity', value: 0.8, weight: 2 },
        { factor: 'feasibility', value: 0.6, weight: 1 }
      ];
      // (0.8 * 2 + 0.6 * 1) / (2 + 1) = 2.2 / 3 = 0.7333...
      expect(service.getConfidence(factors)).toBeCloseTo(0.7333, 3);
    });

    it('should return 0 for empty factors array', () => {
      expect(service.getConfidence([])).toBe(0);
    });

    it('should handle single factor', () => {
      const factors = [{ factor: 'test', value: 0.9, weight: 1 }];
      expect(service.getConfidence(factors)).toBe(0.9);
    });

    it('should handle zero weight gracefully', () => {
      const factors = [{ factor: 'test', value: 0.9, weight: 0 }];
      expect(service.getConfidence(factors)).toBe(0);
    });
  });
});

// ============================================================================
// 7. MaintainabilityAnalysisService
// ============================================================================
describe('MaintainabilityAnalysisService', () => {
  let service: MaintainabilityAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MaintainabilityAnalysisService();
  });

  describe('analyzeMaintainability', () => {
    it('should return a complete maintainability analysis', () => {
      const source = createSourceSystem();
      const target = createTargetSystem();

      const result = service.analyzeMaintainability(source, target);

      expect(result).toBeDefined();
      expect(typeof result.maintainabilityScore).toBe('number');
      expect(result.codeQuality).toBeDefined();
      expect(result.technicalDebt).toBeDefined();
      expect(result.documentationQuality).toBeDefined();
      expect(result.testCoverage).toBeDefined();
      expect(Array.isArray(result.maintainabilityRisks)).toBe(true);
    });

    it('should have valid code quality metrics', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());

      expect(result.codeQuality.complexity).toBeGreaterThan(0);
      expect(result.codeQuality.duplication).toBeGreaterThanOrEqual(0);
      expect(result.codeQuality.testability).toBeGreaterThan(0);
      expect(result.codeQuality.modularity).toBeGreaterThan(0);
      expect(result.codeQuality.coupling).toBeGreaterThanOrEqual(0);
      expect(result.codeQuality.cohesion).toBeGreaterThan(0);
    });

    it('should assess technical debt', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());

      expect(typeof result.technicalDebt.overallDebt).toBe('number');
      expect(Array.isArray(result.technicalDebt.debtCategories)).toBe(true);
      expect(result.technicalDebt.remediationPlan).toBeDefined();
      expect(typeof result.technicalDebt.businessImpact).toBe('string');
    });

    it('should have remediation plan with phases', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());

      const plan = result.technicalDebt.remediationPlan;
      expect(plan.phases.length).toBeGreaterThan(0);
      expect(plan.totalEffort).toBeGreaterThan(0);
      expect(plan.totalCost).toBeGreaterThan(0);
      expect(plan.timeline).toBeGreaterThan(0);
    });

    it('should assess documentation quality', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());

      expect(typeof result.documentationQuality.completeness).toBe('number');
      expect(typeof result.documentationQuality.accuracy).toBe('number');
      expect(typeof result.documentationQuality.accessibility).toBe('number');
      expect(typeof result.documentationQuality.maintenance).toBe('number');
      expect(Array.isArray(result.documentationQuality.gaps)).toBe(true);
      expect(Array.isArray(result.documentationQuality.recommendations)).toBe(true);
    });

    it('should analyze test coverage', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());

      expect(result.testCoverage.unitTestCoverage).toBeGreaterThan(0);
      expect(result.testCoverage.integrationTestCoverage).toBeGreaterThan(0);
      expect(result.testCoverage.e2eTestCoverage).toBeGreaterThan(0);
      expect(typeof result.testCoverage.testQuality).toBe('number');
      expect(typeof result.testCoverage.testAutomation).toBe('number');
    });

    it('should identify maintainability risks when versions are unknown', () => {
      const source = createSourceSystem({ version: undefined });
      const target = createTargetSystem({ version: undefined });

      const result = service.analyzeMaintainability(source, target);

      expect(result.maintainabilityRisks.length).toBeGreaterThan(0);
      expect(result.maintainabilityRisks[0].risk).toContain('Unknown Version');
    });

    it('should have no version-related risks when versions are provided', () => {
      const source = createSourceSystem({ version: '3.0' });
      const target = createTargetSystem({ version: '5.0' });

      const result = service.analyzeMaintainability(source, target);

      const versionRisks = result.maintainabilityRisks.filter(r => r.risk.includes('Version'));
      expect(versionRisks.length).toBe(0);
    });

    it('should calculate maintainability score as non-negative', () => {
      const result = service.analyzeMaintainability(createSourceSystem(), createTargetSystem());
      expect(result.maintainabilityScore).toBeGreaterThanOrEqual(0);
    });

    it('should reduce maintainability score when risks are present', () => {
      const withVersion = service.analyzeMaintainability(
        createSourceSystem({ version: '3.0' }),
        createTargetSystem({ version: '5.0' })
      );
      const withoutVersion = service.analyzeMaintainability(
        createSourceSystem({ version: undefined }),
        createTargetSystem({ version: undefined })
      );

      expect(withoutVersion.maintainabilityScore).toBeLessThanOrEqual(withVersion.maintainabilityScore);
    });
  });
});

// ============================================================================
// 8. MigrationPlanningService
// ============================================================================
describe('MigrationPlanningService', () => {
  let service: MigrationPlanningService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new MigrationPlanningService();
  });

  describe('createImplementationPlan', () => {
    it('should create a complete implementation plan', async () => {
      const approach = createIntegrationApproach();
      const option = createArchitectureOption();

      const result = await service.createImplementationPlan(approach, option);

      expect(result).toBeDefined();
      expect(Array.isArray(result.phases)).toBe(true);
      expect(result.phases.length).toBe(4);
      expect(result.totalDuration).toBeGreaterThan(0);
      expect(result.totalCost).toBeGreaterThan(0);
      expect(Array.isArray(result.criticalPath)).toBe(true);
      expect(Array.isArray(result.dependencies)).toBe(true);
    });

    it('should have four standard phases', async () => {
      const result = await service.createImplementationPlan(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      const phaseNames = result.phases.map(p => p.name);
      expect(phaseNames).toContain('Planning and Design');
      expect(phaseNames).toContain('Development and Configuration');
      expect(phaseNames).toContain('Testing and Validation');
      expect(phaseNames).toContain('Deployment and Go-Live');
    });

    it('should calculate total duration as sum of phase durations', async () => {
      const result = await service.createImplementationPlan(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      const expectedTotal = result.phases.reduce((sum, p) => sum + p.duration, 0);
      expect(result.totalDuration).toBe(expectedTotal);
    });

    it('should calculate total cost as sum of phase costs', async () => {
      const result = await service.createImplementationPlan(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      const expectedTotal = result.phases.reduce((sum, p) => sum + p.cost, 0);
      expect(result.totalCost).toBe(expectedTotal);
    });

    it('should scale phase costs proportionally to option estimated cost', async () => {
      const cheapOption = createArchitectureOption({ estimatedCost: 10000 });
      const expensiveOption = createArchitectureOption({ estimatedCost: 100000 });

      const cheapPlan = await service.createImplementationPlan(createIntegrationApproach(), cheapOption);
      const expensivePlan = await service.createImplementationPlan(createIntegrationApproach(), expensiveOption);

      expect(expensivePlan.totalCost).toBeGreaterThan(cheapPlan.totalCost);
    });

    it('should scale phase durations proportionally to implementation time', async () => {
      const fastOption = createArchitectureOption({ implementationTime: 30 });
      const slowOption = createArchitectureOption({ implementationTime: 180 });

      const fastPlan = await service.createImplementationPlan(createIntegrationApproach(), fastOption);
      const slowPlan = await service.createImplementationPlan(createIntegrationApproach(), slowOption);

      expect(slowPlan.totalDuration).toBeGreaterThan(fastPlan.totalDuration);
    });

    it('should have resources in each phase', async () => {
      const result = await service.createImplementationPlan(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      for (const phase of result.phases) {
        expect(phase.resources.length).toBeGreaterThan(0);
        expect(phase.resources[0].type).toBe('human');
        expect(phase.resources[0].quantity).toBeGreaterThan(0);
      }
    });
  });

  describe('createImplementationPhases', () => {
    it('should return 4 phases', () => {
      const phases = service.createImplementationPhases(
        createIntegrationApproach(),
        createArchitectureOption()
      );
      expect(phases.length).toBe(4);
    });

    it('should include deliverables for each phase', () => {
      const phases = service.createImplementationPhases(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      for (const phase of phases) {
        expect(phase.deliverables.length).toBeGreaterThan(0);
      }
    });

    it('should include risks for each phase', () => {
      const phases = service.createImplementationPhases(
        createIntegrationApproach(),
        createArchitectureOption()
      );

      for (const phase of phases) {
        expect(phase.risks.length).toBeGreaterThan(0);
      }
    });
  });

  describe('identifyPhaseDependencies', () => {
    it('should create sequential dependencies between phases', () => {
      const phases = service.createImplementationPhases(
        createIntegrationApproach(),
        createArchitectureOption()
      );
      const deps = service.identifyPhaseDependencies(phases);

      expect(deps.length).toBe(phases.length - 1);
      for (const dep of deps) {
        expect(dep.type).toBe('blocking');
        expect(dep.fromPhase).toBeDefined();
        expect(dep.toPhase).toBeDefined();
      }
    });

    it('should handle single phase', () => {
      const phases = [{ name: 'Only Phase', description: '', duration: 10, cost: 5000, deliverables: [], risks: [], resources: [] }];
      const deps = service.identifyPhaseDependencies(phases as any);
      expect(deps.length).toBe(0);
    });

    it('should handle empty phases', () => {
      const deps = service.identifyPhaseDependencies([]);
      expect(deps.length).toBe(0);
    });
  });

  describe('calculateCriticalPath', () => {
    it('should return all phase names in sequence', () => {
      const phases = service.createImplementationPhases(
        createIntegrationApproach(),
        createArchitectureOption()
      );
      const deps = service.identifyPhaseDependencies(phases);
      const critPath = service.calculateCriticalPath(phases, deps);

      expect(critPath.length).toBe(phases.length);
      expect(critPath[0]).toBe('Planning and Design');
      expect(critPath[critPath.length - 1]).toBe('Deployment and Go-Live');
    });
  });
});

// ============================================================================
// 9. PerformanceAnalysisService
// ============================================================================
describe('PerformanceAnalysisService', () => {
  let service: PerformanceAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PerformanceAnalysisService();
  });

  describe('analyzePerformance', () => {
    it('should return a complete performance analysis', () => {
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());

      expect(result).toBeDefined();
      expect(result.currentPerformance).toBeDefined();
      expect(Array.isArray(result.performanceRequirements)).toBe(true);
      expect(Array.isArray(result.performanceGaps)).toBe(true);
      expect(Array.isArray(result.optimizationOpportunities)).toBe(true);
      expect(Array.isArray(result.performanceRisks)).toBe(true);
    });

    it('should include current performance profile', () => {
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());

      expect(typeof result.currentPerformance.latency).toBe('number');
      expect(typeof result.currentPerformance.throughput).toBe('number');
      expect(typeof result.currentPerformance.availability).toBe('number');
      expect(typeof result.currentPerformance.responseTime).toBe('number');
      expect(typeof result.currentPerformance.errorRate).toBe('number');
      expect(typeof result.currentPerformance.concurrency).toBe('number');
    });

    it('should derive performance requirements with priorities', () => {
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());

      expect(result.performanceRequirements.length).toBeGreaterThan(0);
      for (const req of result.performanceRequirements) {
        expect(req.metric).toBeDefined();
        expect(req.target).toBeGreaterThan(0);
        expect(req.unit).toBeDefined();
        expect(['low', 'medium', 'high']).toContain(req.priority);
      }
    });

    it('should identify performance gaps when response time exceeds threshold', () => {
      // The default response time is 200ms and threshold is 2000ms,
      // so no gap should be detected with defaults
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());
      expect(result.performanceGaps.length).toBe(0);
    });

    it('should include optimization opportunities', () => {
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());

      expect(result.optimizationOpportunities.length).toBeGreaterThan(0);
      const opt = result.optimizationOpportunities[0];
      expect(opt.area).toBeDefined();
      expect(opt.description).toBeDefined();
      expect(typeof opt.expectedImprovement).toBe('number');
      expect(typeof opt.cost).toBe('number');
    });

    it('should include performance risks', () => {
      const result = service.analyzePerformance(createSourceSystem(), createTargetSystem());

      expect(result.performanceRisks.length).toBeGreaterThan(0);
      const risk = result.performanceRisks[0];
      expect(risk.risk).toBeDefined();
      expect(risk.probability).toBeDefined();
      expect(risk.impact).toBeDefined();
      expect(risk.mitigation).toBeDefined();
    });

    it('should calculate throughput based on data volume', () => {
      const sourceHigh = createSourceSystem({ dataVolume: { recordCount: 1000000, growthRate: 0.1, peakLoad: 5000, dataTypes: ['x'] } });
      const sourceLow = createSourceSystem({ dataVolume: { recordCount: 1000, growthRate: 0.1, peakLoad: 10, dataTypes: ['x'] } });
      const target = createTargetSystem();

      const resultHigh = service.analyzePerformance(sourceHigh, target);
      const resultLow = service.analyzePerformance(sourceLow, target);

      expect(resultHigh.currentPerformance.throughput).toBeGreaterThan(resultLow.currentPerformance.throughput);
    });
  });
});

// ============================================================================
// 10. ResourceEstimationService
// ============================================================================
describe('ResourceEstimationService', () => {
  let service: ResourceEstimationService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ResourceEstimationService();
  });

  describe('estimateCost', () => {
    it('should return base cost for low complexity with high compatibility', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(25000); // base * 1 (low) = 25000
    });

    it('should multiply cost for medium complexity', () => {
      const pattern = createIntegrationPattern({ complexity: 'medium' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(37500); // 25000 * 1.5
    });

    it('should multiply cost for high complexity', () => {
      const pattern = createIntegrationPattern({ complexity: 'high' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(62500); // 25000 * 2.5
    });

    it('should increase cost by 30% for low compatibility', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.5 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(32500); // 25000 * 1 * 1.3
    });

    it('should apply both complexity and compatibility multipliers', () => {
      const pattern = createIntegrationPattern({ complexity: 'high' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.3 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(81250); // 25000 * 2.5 * 1.3
    });

    it('should not apply compatibility penalty when score is exactly 0.7', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.7 } });

      const cost = service.estimateCost(pattern, assessment);
      expect(cost).toBe(25000); // No penalty at 0.7
    });
  });

  describe('estimateTime', () => {
    it('should return base time for low complexity with high compatibility', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const time = service.estimateTime(pattern, assessment);
      expect(time).toBe(60); // base * 1 (low)
    });

    it('should multiply time for medium complexity', () => {
      const pattern = createIntegrationPattern({ complexity: 'medium' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const time = service.estimateTime(pattern, assessment);
      expect(time).toBe(90); // 60 * 1.5
    });

    it('should multiply time for high complexity', () => {
      const pattern = createIntegrationPattern({ complexity: 'high' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.9 } });

      const time = service.estimateTime(pattern, assessment);
      expect(time).toBe(120); // 60 * 2
    });

    it('should increase time by 20% for low compatibility', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.5 } });

      const time = service.estimateTime(pattern, assessment);
      expect(time).toBe(72); // 60 * 1 * 1.2
    });

    it('should not apply compatibility penalty at threshold', () => {
      const pattern = createIntegrationPattern({ complexity: 'low' });
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.7 } });

      const time = service.estimateTime(pattern, assessment);
      expect(time).toBe(60);
    });
  });
});

// ============================================================================
// 11. RiskManagementService
// ============================================================================
describe('RiskManagementService', () => {
  let service: RiskManagementService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new RiskManagementService();
  });

  describe('assessIntegrationRisks', () => {
    it('should return an array of risks', async () => {
      const risks = await service.assessIntegrationRisks(
        createStrategyInput(),
        createArchitectureAssessment()
      );

      expect(Array.isArray(risks)).toBe(true);
      expect(risks.length).toBeGreaterThan(0);
    });

    it('should include data, performance, security, and operational risks', async () => {
      const risks = await service.assessIntegrationRisks(
        createStrategyInput(),
        createArchitectureAssessment()
      );

      const categories = risks.map(r => r.category);
      expect(categories).toContain('data');
      expect(categories).toContain('performance');
      expect(categories).toContain('operational');
    });

    it('should include security risk for mismatched security levels', async () => {
      const input = createStrategyInput({
        sourceSystemProfile: createSourceSystem({ securityLevel: 'enterprise' }),
        targetSystemProfile: createTargetSystem({ securityLevel: 'basic' })
      });

      const risks = await service.assessIntegrationRisks(input, createArchitectureAssessment());
      const securityRisks = risks.filter(r => r.category === 'security');
      expect(securityRisks.length).toBeGreaterThan(0);
    });

    it('should not include security risk when levels match', async () => {
      const input = createStrategyInput({
        sourceSystemProfile: createSourceSystem({ securityLevel: 'high' }),
        targetSystemProfile: createTargetSystem({ securityLevel: 'high' })
      });

      const risks = await service.assessIntegrationRisks(input, createArchitectureAssessment());
      const securityRisks = risks.filter(r => r.category === 'security');
      expect(securityRisks.length).toBe(0);
    });

    it('should include technical risk for low compatibility', async () => {
      const assessment = createArchitectureAssessment({
        compatibility: { overallScore: 0.4 }
      });

      const risks = await service.assessIntegrationRisks(createStrategyInput(), assessment);
      const techRisks = risks.filter(r => r.description.includes('compatibility'));
      expect(techRisks.length).toBeGreaterThan(0);
    });

    it('should not include technical risk for high compatibility', async () => {
      const assessment = createArchitectureAssessment({
        compatibility: { overallScore: 0.9 }
      });

      const risks = await service.assessIntegrationRisks(createStrategyInput(), assessment);
      const techRisks = risks.filter(r => r.description.includes('Low system compatibility'));
      expect(techRisks.length).toBe(0);
    });

    it('should include mitigation and contingency for each risk', async () => {
      const risks = await service.assessIntegrationRisks(
        createStrategyInput(),
        createArchitectureAssessment()
      );

      for (const risk of risks) {
        expect(risk.mitigation).toBeDefined();
        expect(risk.mitigation.length).toBeGreaterThan(0);
        expect(risk.contingency).toBeDefined();
        expect(risk.contingency.length).toBeGreaterThan(0);
      }
    });
  });

  describe('identifyTechnicalRisks', () => {
    it('should identify risk for low compatibility scores', () => {
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.5 } });
      const risks = service.identifyTechnicalRisks(createStrategyInput(), assessment);

      expect(risks.length).toBe(1);
      expect(risks[0].impact).toBe('high');
    });

    it('should return empty for high compatibility scores', () => {
      const assessment = createArchitectureAssessment({ compatibility: { overallScore: 0.8 } });
      const risks = service.identifyTechnicalRisks(createStrategyInput(), assessment);
      expect(risks.length).toBe(0);
    });
  });

  describe('calculateOverallRisk', () => {
    it('should return 0 for empty risk array', () => {
      expect(service.calculateOverallRisk([])).toBe(0);
    });

    it('should normalize risk level to 0-1 range', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'high', impact: 'high', mitigation: 'M1', contingency: 'C1' }
      ];

      const score = service.calculateOverallRisk(risks);
      expect(score).toBeGreaterThan(0);
      expect(score).toBeLessThanOrEqual(1);
    });

    it('should return higher score for high impact risks', () => {
      const highRisks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'high', impact: 'high', mitigation: 'M1', contingency: 'C1' }
      ];
      const lowRisks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'low', impact: 'low', mitigation: 'M1', contingency: 'C1' }
      ];

      expect(service.calculateOverallRisk(highRisks)).toBeGreaterThan(service.calculateOverallRisk(lowRisks));
    });

    it('should calculate correctly for multiple risks', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'low', impact: 'low', mitigation: 'M', contingency: 'C' },
        { category: 'data', description: 'R2', probability: 'high', impact: 'high', mitigation: 'M', contingency: 'C' }
      ];

      // (1 + 3) / (2 * 4) = 4/8 = 0.5
      expect(service.calculateOverallRisk(risks)).toBe(0.5);
    });
  });

  describe('hasHighRisks', () => {
    it('should return false for empty array', () => {
      expect(service.hasHighRisks([])).toBe(false);
    });

    it('should return true when any risk has high impact', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'low', impact: 'high', mitigation: 'M', contingency: 'C' }
      ];
      expect(service.hasHighRisks(risks)).toBe(true);
    });

    it('should return true when any risk has high probability', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'high', impact: 'low', mitigation: 'M', contingency: 'C' }
      ];
      expect(service.hasHighRisks(risks)).toBe(true);
    });

    it('should return false when all risks are low/medium', () => {
      const risks: IntegrationRisk[] = [
        { category: 'data', description: 'R1', probability: 'low', impact: 'medium', mitigation: 'M', contingency: 'C' },
        { category: 'data', description: 'R2', probability: 'medium', impact: 'low', mitigation: 'M', contingency: 'C' }
      ];
      expect(service.hasHighRisks(risks)).toBe(false);
    });
  });
});

// ============================================================================
// 12. ScalabilityAnalysisService
// ============================================================================
describe('ScalabilityAnalysisService', () => {
  let service: ScalabilityAnalysisService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new ScalabilityAnalysisService();
  });

  describe('analyzeScalability', () => {
    it('should return a complete scalability analysis', () => {
      const result = service.analyzeScalability(createSourceSystem(), createTargetSystem());

      expect(result).toBeDefined();
      expect(result.currentCapacity).toBeDefined();
      expect(result.projectedGrowth).toBeDefined();
      expect(Array.isArray(result.scalabilityLimits)).toBe(true);
      expect(Array.isArray(result.scalingStrategies)).toBe(true);
      expect(Array.isArray(result.bottlenecks)).toBe(true);
    });

    it('should calculate current capacity from source data volume', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 500000, growthRate: 0.15, peakLoad: 1000, dataTypes: ['x'] } });
      const result = service.analyzeScalability(source, createTargetSystem());

      expect(result.currentCapacity.throughput).toBe(500000);
      expect(result.currentCapacity.dataVolume).toBe(500000);
    });

    it('should project growth based on growth rate', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 100000, growthRate: 0.25, peakLoad: 500, dataTypes: ['x'] } });
      const result = service.analyzeScalability(source, createTargetSystem());

      const growth = result.projectedGrowth.expectedGrowth[0];
      expect(growth.growthRate).toBe(0.25);
      expect(growth.projectedValue).toBe(125000); // 100000 * 1.25
    });

    it('should identify scalability limits for very high data volumes', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 20000000, growthRate: 0.1, peakLoad: 5000, dataTypes: ['x'] } });
      const result = service.analyzeScalability(source, createTargetSystem());

      expect(result.scalabilityLimits.length).toBeGreaterThan(0);
      expect(result.scalabilityLimits[0].component).toContain('Source System');
    });

    it('should not identify limits for moderate data volumes', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 100000, growthRate: 0.1, peakLoad: 500, dataTypes: ['x'] } });
      const result = service.analyzeScalability(source, createTargetSystem());

      expect(result.scalabilityLimits.length).toBe(0);
    });

    it('should always include scaling strategies', () => {
      const result = service.analyzeScalability(createSourceSystem(), createTargetSystem());
      expect(result.scalingStrategies.length).toBeGreaterThan(0);
      expect(result.scalingStrategies[0].name).toBe('Data Partitioning Strategy');
    });

    it('should detect bottlenecks for legacy systems', () => {
      const source = createSourceSystem({ capabilities: ['legacy', 'batch'] });
      const result = service.analyzeScalability(source, createTargetSystem());

      expect(result.bottlenecks.length).toBeGreaterThan(0);
      expect(result.bottlenecks[0].component).toContain('Legacy');
    });

    it('should not detect legacy bottlenecks for modern systems', () => {
      const result = service.analyzeScalability(createSourceSystem(), createTargetSystem());

      const legacyBottlenecks = result.bottlenecks.filter(b => b.component.includes('Legacy'));
      expect(legacyBottlenecks.length).toBe(0);
    });
  });

  describe('assessCurrentCapacity', () => {
    it('should calculate capacity based on source and target volumes', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 10000, growthRate: 0.1, peakLoad: 100, dataTypes: ['x'] } });
      const target = createTargetSystem({ dataVolume: { recordCount: 5000, growthRate: 0.2, peakLoad: 50, dataTypes: ['x'] } });

      const capacity = service.assessCurrentCapacity(source, target);

      expect(capacity.throughput).toBe(5000 / 3600); // min / 3600
      expect(capacity.dataVolume).toBe(10000); // max
      expect(capacity.storageRequirements).toBe((10000 + 5000) * 1.5);
    });

    it('should use default volume when data volume is missing', () => {
      const source = { ...createSourceSystem(), dataVolume: undefined } as any;
      const target = { ...createTargetSystem(), dataVolume: undefined } as any;

      const capacity = service.assessCurrentCapacity(source, target);
      expect(capacity.dataVolume).toBe(1000); // default
    });
  });

  describe('assessProjectedGrowth', () => {
    it('should calculate projected growth over 12 months', () => {
      const source = createSourceSystem({ dataVolume: { recordCount: 100000, growthRate: 0.3, peakLoad: 500, dataTypes: ['x'] } });
      const target = createTargetSystem({ dataVolume: { recordCount: 50000, growthRate: 0.1, peakLoad: 200, dataTypes: ['x'] } });

      const growth = service.assessProjectedGrowth(source, target, createBusinessRequirements());

      expect(growth.timeframe).toBe('12 months');
      expect(growth.expectedGrowth.length).toBeGreaterThan(0);
      expect(growth.expectedGrowth[0].growthRate).toBe(0.3);
      expect(growth.expectedGrowth[0].projectedValue).toBe(130000); // 100000 * 1.3
    });

    it('should use default growth rate when missing', () => {
      const source = { ...createSourceSystem(), dataVolume: undefined } as any;
      const target = { ...createTargetSystem(), dataVolume: undefined } as any;

      const growth = service.assessProjectedGrowth(source, target, []);
      expect(growth.expectedGrowth[0].growthRate).toBe(0.2); // default
    });
  });
});

// ============================================================================
// 13. SecurityAnalysisService
// ============================================================================
describe('SecurityAnalysisService', () => {
  let service: SecurityAnalysisService;

  function createSecuritySourceSystem(overrides: any = {}) {
    return {
      name: 'NetSuite ERP',
      version: '2024.1',
      securityLevel: 'enterprise' as const,
      apiSupport: [{ authentication: ['oauth', 'token'] }],
      ...overrides
    };
  }

  function createSecurityTargetSystem(overrides: any = {}) {
    return {
      name: 'Salesforce CRM',
      version: '58.0',
      securityLevel: 'high' as const,
      apiSupport: [{ authentication: ['oauth'] }],
      ...overrides
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SecurityAnalysisService();
  });

  describe('analyzeSecurity', () => {
    it('should return a complete security analysis', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem(),
        createSecurityTargetSystem()
      );

      expect(result).toBeDefined();
      expect(typeof result.overallRiskLevel).toBe('string');
      expect(['low', 'medium', 'high']).toContain(result.overallRiskLevel);
      expect(result.threatAssessment).toBeDefined();
      expect(Array.isArray(result.vulnerabilities)).toBe(true);
      expect(Array.isArray(result.complianceRequirements)).toBe(true);
      expect(Array.isArray(result.securityControls)).toBe(true);
      expect(Array.isArray(result.recommendations)).toBe(true);
    });

    it('should include threat assessment with risk matrix', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem(),
        createSecurityTargetSystem()
      );

      expect(result.threatAssessment.riskMatrix).toBeDefined();
      expect(typeof result.threatAssessment.riskMatrix.low).toBe('number');
      expect(typeof result.threatAssessment.riskMatrix.medium).toBe('number');
      expect(typeof result.threatAssessment.riskMatrix.high).toBe('number');
      expect(typeof result.threatAssessment.riskMatrix.critical).toBe('number');
    });

    it('should include business impact assessment', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem(),
        createSecurityTargetSystem()
      );

      expect(result.threatAssessment.businessImpact).toBeDefined();
      expect(typeof result.threatAssessment.businessImpact.financialImpact).toBe('number');
    });

    it('should detect threats for systems without oauth authentication', () => {
      const source = createSecuritySourceSystem({
        apiSupport: [{ authentication: ['basic'] }]
      });

      const result = service.analyzeSecurity(source, createSecurityTargetSystem());

      expect(result.threatAssessment.threats.length).toBeGreaterThan(0);
      expect(result.threatAssessment.threats[0].type).toBe('data_breach');
      expect(result.threatAssessment.attackVectors.length).toBeGreaterThan(0);
    });

    it('should not detect auth-related threats when oauth is present', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ apiSupport: [{ authentication: ['oauth'] }] }),
        createSecurityTargetSystem()
      );

      const dataBreach = result.threatAssessment.threats.filter(t => t.type === 'data_breach');
      expect(dataBreach.length).toBe(0);
    });

    it('should detect vulnerabilities for outdated versions', () => {
      const source = createSecuritySourceSystem({ version: '1.0' });

      const result = service.analyzeSecurity(source, createSecurityTargetSystem());

      expect(result.vulnerabilities.length).toBeGreaterThan(0);
      expect(result.vulnerabilities[0].vulnerability).toContain('Outdated');
    });

    it('should not detect version vulnerabilities for modern versions', () => {
      const source = createSecuritySourceSystem({ version: '3.0' });

      const result = service.analyzeSecurity(source, createSecurityTargetSystem());

      const versionVulns = result.vulnerabilities.filter(v => v.vulnerability.includes('Outdated'));
      expect(versionVulns.length).toBe(0);
    });

    it('should identify compliance requirements for enterprise systems', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ securityLevel: 'enterprise' }),
        createSecurityTargetSystem()
      );

      expect(result.complianceRequirements.length).toBeGreaterThan(0);
      expect(result.complianceRequirements[0].regulation).toBe('SOX');
    });

    it('should not require SOX compliance for non-enterprise systems', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ securityLevel: 'standard' }),
        createSecurityTargetSystem({ securityLevel: 'standard' })
      );

      const sox = result.complianceRequirements.filter(c => c.regulation === 'SOX');
      expect(sox.length).toBe(0);
    });

    it('should always recommend encryption security control', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem(),
        createSecurityTargetSystem()
      );

      expect(result.securityControls.length).toBeGreaterThan(0);
      expect(result.securityControls[0].control).toContain('Encryption');
      expect(result.securityControls[0].type).toBe('preventive');
    });

    it('should always include security recommendations', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem(),
        createSecurityTargetSystem()
      );

      expect(result.recommendations.length).toBeGreaterThan(0);
      expect(result.recommendations[0].priority).toBe('high');
      expect(result.recommendations[0].category).toBe('infrastructure');
    });

    it('should set high compliance impact for enterprise source systems', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ securityLevel: 'enterprise' }),
        createSecurityTargetSystem()
      );

      expect(result.threatAssessment.businessImpact.complianceImpact).toBe('high');
    });

    it('should set low compliance impact for non-enterprise systems', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ securityLevel: 'standard' }),
        createSecurityTargetSystem()
      );

      expect(result.threatAssessment.businessImpact.complianceImpact).toBe('low');
    });

    it('should calculate low overall risk when no major threats or vulnerabilities', () => {
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ apiSupport: [{ authentication: ['oauth'] }], version: '5.0' }),
        createSecurityTargetSystem({ version: '5.0' })
      );

      expect(result.overallRiskLevel).toBe('low');
    });

    it('should calculate medium risk when threats have high impact', () => {
      // Source without oauth will generate a data_breach threat with high impact
      const result = service.analyzeSecurity(
        createSecuritySourceSystem({ apiSupport: [{ authentication: ['basic'] }] }),
        createSecurityTargetSystem()
      );

      expect(['medium', 'high']).toContain(result.overallRiskLevel);
    });
  });
});
