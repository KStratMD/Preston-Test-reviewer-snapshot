/**
 * Comprehensive tests for integration-strategy sub-services (batch 3):
 * ArchitectureTemplateService, IntegrationPatternAnalysisService,
 * IntegrationStrategyValidationService, IntegrationStrategyGeneratorService,
 * MigrationPlanningService
 */

import { ArchitectureTemplateService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/ArchitectureTemplateService';
import { IntegrationPatternAnalysisService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationPatternAnalysisService';
import { IntegrationStrategyValidationService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationStrategyValidationService';
import { IntegrationStrategyGeneratorService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/IntegrationStrategyGeneratorService';
import { MigrationPlanningService } from '../../../../src/services/ai/orchestrator/agents/services/integration-strategy/MigrationPlanningService';

/* ────────────── ArchitectureTemplateService ────────────── */

describe('ArchitectureTemplateService', () => {
  let service: ArchitectureTemplateService;

  beforeEach(() => {
    service = new ArchitectureTemplateService();
  });

  describe('initializeArchitectureTemplates', () => {
    it('should initialize with 3 default templates', () => {
      const templates = service.getTemplates();
      expect(templates.size).toBe(3);
      expect(templates.has('erp_to_crm')).toBe(true);
      expect(templates.has('database_to_database')).toBe(true);
      expect(templates.has('legacy_to_modern')).toBe(true);
    });

    it('should have correct erp_to_crm template', () => {
      const t = service.getTemplates().get('erp_to_crm')!;
      expect(t.name).toBe('ERP to CRM Integration');
      expect(t.sourceTypes).toContain('erp');
      expect(t.targetTypes).toContain('crm');
      expect(t.complexity).toBe('medium');
      expect(t.typicalDuration).toBe(90);
    });

    it('should have correct database_to_database template', () => {
      const t = service.getTemplates().get('database_to_database')!;
      expect(t.complexity).toBe('low');
      expect(t.typicalDuration).toBe(60);
    });

    it('should have correct legacy_to_modern template', () => {
      const t = service.getTemplates().get('legacy_to_modern')!;
      expect(t.complexity).toBe('high');
      expect(t.typicalDuration).toBe(120);
    });
  });

  describe('addArchitectureTemplate', () => {
    it('should add a custom template', () => {
      service.addArchitectureTemplate('custom', {
        name: 'Custom Integration',
        sourceTypes: ['api'],
        targetTypes: ['api'],
        recommendedPatterns: ['api_first'],
        complexity: 'low',
        typicalDuration: 30,
        commonChallenges: [],
        successFactors: [],
      });
      expect(service.getTemplates().has('custom')).toBe(true);
      expect(service.getTemplates().size).toBe(4);
    });
  });

  describe('createArchitectureOption', () => {
    const pattern = {
      name: 'api_first',
      description: 'API-first integration pattern',
      type: 'api' as const,
      benefits: ['High scalability'],
      drawbacks: ['API dependency'],
      complexity: 'medium' as const,
      maturity: 'proven' as const,
    };
    const input = { sourceSystemProfile: { name: 'SF' }, targetSystemProfile: { name: 'NS' } } as any;
    const assessment = { compatibility: { overallScore: 0.85 }, complexity: {} } as any;

    it('should create option with uppercase name', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      expect(option.name).toContain('API');
      expect(option.name).toContain('Architecture');
    });

    it('should pass through pros and cons from pattern', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      expect(option.pros).toEqual(['High scalability']);
      expect(option.cons).toEqual(['API dependency']);
    });

    it('should estimate cost based on complexity and compatibility', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      // medium complexity: 25000 * 1.5 = 37500, compatibility > 0.7 so no increase
      expect(option.estimatedCost).toBe(37500);
    });

    it('should add 30% to cost for low compatibility', () => {
      const lowCompat = { compatibility: { overallScore: 0.5 } } as any;
      const option = service.createArchitectureOption(pattern as any, input, lowCompat);
      // 25000 * 1.5 * 1.3 = 48750
      expect(option.estimatedCost).toBe(48750);
    });

    it('should estimate time based on complexity', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      // medium: 60 * 1.5 = 90
      expect(option.implementationTime).toBe(90);
    });

    it('should set complexity from pattern', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      expect(option.complexity).toBe('medium');
    });

    it('should assess scalability based on pattern type', () => {
      const option = service.createArchitectureOption(pattern as any, input, assessment);
      // api type -> high scalability
      expect(option.scalability).toBe('high');
    });
  });

  describe('calculateOptionScore', () => {
    it('should calculate score for low complexity option', () => {
      const option = {
        estimatedCost: 25000,
        implementationTime: 60,
        complexity: 'low' as const,
        scalability: 'high' as const,
      } as any;
      const score = service.calculateOptionScore(option);
      // cost: (100000-25000)/100000*30 = 22.5
      // time: (180-60)/180*25 = 16.67
      // complexity: 30
      // scalability: 15
      expect(score).toBeCloseTo(84.17, 1);
    });

    it('should give lower score for high complexity', () => {
      const low = { estimatedCost: 25000, implementationTime: 60, complexity: 'low' as const, scalability: 'medium' as const } as any;
      const high = { estimatedCost: 25000, implementationTime: 60, complexity: 'high' as const, scalability: 'medium' as const } as any;
      expect(service.calculateOptionScore(low)).toBeGreaterThan(service.calculateOptionScore(high));
    });

    it('should give lower score for higher cost', () => {
      const cheap = { estimatedCost: 10000, implementationTime: 60, complexity: 'medium' as const, scalability: 'medium' as const } as any;
      const expensive = { estimatedCost: 90000, implementationTime: 60, complexity: 'medium' as const, scalability: 'medium' as const } as any;
      expect(service.calculateOptionScore(cheap)).toBeGreaterThan(service.calculateOptionScore(expensive));
    });
  });

  describe('determineApproachComplexity', () => {
    it('should return high for high pattern complexity', () => {
      const pattern = { complexity: 'high' } as any;
      const assessment = { complexity: { overallComplexity: 'low' } } as any;
      expect(service.determineApproachComplexity(pattern, assessment)).toBe('high');
    });

    it('should return high for very_high system complexity', () => {
      const pattern = { complexity: 'low' } as any;
      const assessment = { complexity: { overallComplexity: 'very_high' } } as any;
      expect(service.determineApproachComplexity(pattern, assessment)).toBe('high');
    });

    it('should return medium for medium pattern complexity', () => {
      const pattern = { complexity: 'medium' } as any;
      const assessment = { complexity: { overallComplexity: 'low' } } as any;
      expect(service.determineApproachComplexity(pattern, assessment)).toBe('medium');
    });

    it('should return low when both are low', () => {
      const pattern = { complexity: 'low' } as any;
      const assessment = { complexity: { overallComplexity: 'low' } } as any;
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

/* ────────────── IntegrationPatternAnalysisService ────────────── */

describe('IntegrationPatternAnalysisService', () => {
  let service: IntegrationPatternAnalysisService;

  const makePattern = (overrides: Record<string, any> = {}) => ({
    name: 'api_first',
    description: 'API-first integration',
    type: 'api' as const,
    benefits: ['Scalable'],
    drawbacks: ['Coupling'],
    complexity: 'low' as const,
    maturity: 'proven' as const,
    ...overrides,
  });

  const makePatterns = () => {
    const map = new Map<string, any>();
    map.set('api_first', makePattern());
    map.set('batch', makePattern({ name: 'batch', type: 'batch', complexity: 'medium', maturity: 'proven' }));
    map.set('experimental', makePattern({ name: 'experimental', maturity: 'emerging' }));
    return map;
  };

  const makeSystem = (overrides: Record<string, any> = {}) => ({
    name: 'TestSystem',
    type: 'crm',
    capabilities: ['api'],
    limitations: [],
    ...overrides,
  });

  beforeEach(() => {
    service = new IntegrationPatternAnalysisService(makePatterns());
  });

  describe('analyzeIntegrationPatterns', () => {
    it('should return full pattern analysis', () => {
      const result = service.analyzeIntegrationPatterns(makeSystem() as any, makeSystem() as any, []);
      expect(result.recommendedPatterns).toBeDefined();
      expect(result.patternComparison).toBeDefined();
      expect(result.antiPatterns).toBeDefined();
      expect(result.bestPractices).toBeDefined();
    });

    it('should only recommend proven patterns', () => {
      const result = service.analyzeIntegrationPatterns(makeSystem() as any, makeSystem() as any, []);
      expect(result.recommendedPatterns.length).toBe(2); // api_first and batch
      result.recommendedPatterns.forEach(p => {
        expect(p.maturity).toBe('proven');
      });
    });

    it('should generate comparisons between proven patterns', () => {
      const result = service.analyzeIntegrationPatterns(makeSystem() as any, makeSystem() as any, []);
      // 2 proven patterns -> 1 comparison (C(2,2) = 1)
      expect(result.patternComparison.length).toBe(1);
      expect(result.patternComparison[0].pattern1).toBeDefined();
      expect(result.patternComparison[0].pattern2).toBeDefined();
    });

    it('should detect anti-patterns for systems with many limitations', () => {
      const limited = makeSystem({ limitations: ['a', 'b', 'c', 'd', 'e', 'f'] });
      const result = service.analyzeIntegrationPatterns(limited as any, makeSystem() as any, []);
      expect(result.antiPatterns.length).toBeGreaterThan(0);
      expect(result.antiPatterns[0].name).toContain('Big Ball of Mud');
    });

    it('should detect no anti-patterns for systems with few limitations', () => {
      const result = service.analyzeIntegrationPatterns(makeSystem() as any, makeSystem() as any, []);
      expect(result.antiPatterns).toEqual([]);
    });

    it('should always include best practices', () => {
      const result = service.analyzeIntegrationPatterns(makeSystem() as any, makeSystem() as any, []);
      expect(result.bestPractices.length).toBe(2);
      expect(result.bestPractices[0].practice).toContain('Monitoring');
      expect(result.bestPractices[1].practice).toContain('Data Validation');
    });
  });

  describe('selectBestPattern', () => {
    it('should prefer proven patterns', () => {
      const patterns = [
        makePattern({ name: 'emerging', maturity: 'emerging', complexity: 'low' }),
        makePattern({ name: 'proven', maturity: 'proven', complexity: 'medium' }),
      ] as any[];
      const result = service.selectBestPattern(patterns, [], {} as any, []);
      expect(result.name).toBe('proven');
    });

    it('should select least complex among proven', () => {
      const patterns = [
        makePattern({ name: 'high', maturity: 'proven', complexity: 'high' }),
        makePattern({ name: 'low', maturity: 'proven', complexity: 'low' }),
      ] as any[];
      const result = service.selectBestPattern(patterns, [], {} as any, []);
      expect(result.name).toBe('low');
    });

    it('should fall back to first pattern when none are proven', () => {
      const patterns = [
        makePattern({ name: 'first', maturity: 'emerging' }),
        makePattern({ name: 'second', maturity: 'emerging' }),
      ] as any[];
      const result = service.selectBestPattern(patterns, [], {} as any, []);
      expect(result.name).toBe('first');
    });
  });

  describe('assessPatternMaturity', () => {
    it('should return ratio of proven patterns', () => {
      const analysis = {
        recommendedPatterns: [
          makePattern({ maturity: 'proven' }),
          makePattern({ maturity: 'proven' }),
          makePattern({ maturity: 'emerging' }),
        ],
      } as any;
      expect(service.assessPatternMaturity(analysis)).toBeCloseTo(2 / 3, 2);
    });

    it('should return 1 when all proven', () => {
      const analysis = {
        recommendedPatterns: [makePattern({ maturity: 'proven' })],
      } as any;
      expect(service.assessPatternMaturity(analysis)).toBe(1);
    });
  });

  describe('assessPatternScalability', () => {
    it('should return high for api type', () => {
      expect(service.assessPatternScalability(makePattern({ type: 'api' }) as any)).toBe('high');
    });

    it('should return high for event type', () => {
      expect(service.assessPatternScalability(makePattern({ type: 'event' }) as any)).toBe('high');
    });

    it('should return medium for batch type', () => {
      expect(service.assessPatternScalability(makePattern({ type: 'batch' }) as any)).toBe('medium');
    });

    it('should return low for data type', () => {
      expect(service.assessPatternScalability(makePattern({ type: 'data' }) as any)).toBe('low');
    });

    it('should return medium for unknown type', () => {
      expect(service.assessPatternScalability(makePattern({ type: 'unknown' }) as any)).toBe('medium');
    });
  });
});

/* ────────────── IntegrationStrategyValidationService ────────────── */

describe('IntegrationStrategyValidationService', () => {
  let service: IntegrationStrategyValidationService;

  beforeEach(() => {
    service = new IntegrationStrategyValidationService();
  });

  const makeInput = (overrides: Record<string, any> = {}) => ({
    sourceSystemProfile: { name: 'SF', type: 'crm', capabilities: ['api', 'rest'], limitations: [] },
    targetSystemProfile: { name: 'NS', type: 'erp', capabilities: ['api'], limitations: [] },
    businessRequirements: [
      { id: '1', description: 'Sync contacts', priority: 'high', type: 'functional' },
    ],
    ...overrides,
  });

  describe('validateInput', () => {
    it('should validate correct input', () => {
      expect(service.validateInput(makeInput() as any)).toBe(true);
    });

    it('should reject missing source system', () => {
      expect(service.validateInput(makeInput({ sourceSystemProfile: null }) as any)).toBe(false);
    });

    it('should reject source without name', () => {
      expect(service.validateInput(makeInput({
        sourceSystemProfile: { type: 'crm' },
      }) as any)).toBe(false);
    });

    it('should reject source without type', () => {
      expect(service.validateInput(makeInput({
        sourceSystemProfile: { name: 'SF' },
      }) as any)).toBe(false);
    });

    it('should reject missing target system', () => {
      expect(service.validateInput(makeInput({ targetSystemProfile: null }) as any)).toBe(false);
    });

    it('should reject target without name', () => {
      expect(service.validateInput(makeInput({
        targetSystemProfile: { type: 'erp' },
      }) as any)).toBe(false);
    });

    it('should reject missing business requirements', () => {
      expect(service.validateInput(makeInput({ businessRequirements: null }) as any)).toBe(false);
    });

    it('should reject empty business requirements', () => {
      expect(service.validateInput(makeInput({ businessRequirements: [] }) as any)).toBe(false);
    });

    it('should reject requirement without id', () => {
      expect(service.validateInput(makeInput({
        businessRequirements: [{ description: 'x', priority: 'high', type: 'functional' }],
      }) as any)).toBe(false);
    });

    it('should reject requirement without description', () => {
      expect(service.validateInput(makeInput({
        businessRequirements: [{ id: '1', priority: 'high', type: 'functional' }],
      }) as any)).toBe(false);
    });

    it('should reject requirement without priority', () => {
      expect(service.validateInput(makeInput({
        businessRequirements: [{ id: '1', description: 'x', type: 'functional' }],
      }) as any)).toBe(false);
    });

    it('should reject requirement without type', () => {
      expect(service.validateInput(makeInput({
        businessRequirements: [{ id: '1', description: 'x', priority: 'high' }],
      }) as any)).toBe(false);
    });
  });

  describe('getRequirementsClarityScore', () => {
    it('should return 1.0 when all have acceptance criteria', () => {
      const reqs = [
        { acceptanceCriteria: ['done'] },
        { acceptanceCriteria: ['complete'] },
      ] as any[];
      expect(service.getRequirementsClarityScore(reqs)).toBe(1.0);
    });

    it('should return 0.0 when none have acceptance criteria', () => {
      const reqs = [{ acceptanceCriteria: [] }, {}] as any[];
      expect(service.getRequirementsClarityScore(reqs)).toBe(0.0);
    });

    it('should return 0.5 for empty requirements', () => {
      expect(service.getRequirementsClarityScore([])).toBe(0.5);
    });

    it('should return ratio for mixed requirements', () => {
      const reqs = [
        { acceptanceCriteria: ['done'] },
        { acceptanceCriteria: [] },
        {},
      ] as any[];
      expect(service.getRequirementsClarityScore(reqs)).toBeCloseTo(1 / 3, 2);
    });
  });

  describe('getTechnicalFeasibilityScore', () => {
    it('should cap at 1.0', () => {
      const input = makeInput({
        sourceSystemProfile: { name: 'SF', type: 'crm', capabilities: ['a', 'b', 'c', 'd', 'e', 'f'] },
        targetSystemProfile: { name: 'NS', type: 'erp', capabilities: ['a', 'b', 'c', 'd', 'e'] },
      });
      expect(service.getTechnicalFeasibilityScore(input as any)).toBe(1.0);
    });

    it('should scale based on capability count', () => {
      const input = makeInput({
        sourceSystemProfile: { name: 'SF', type: 'crm', capabilities: ['api'] },
        targetSystemProfile: { name: 'NS', type: 'erp', capabilities: ['api'] },
      });
      // (1 + 1) / 10 = 0.2
      expect(service.getTechnicalFeasibilityScore(input as any)).toBeCloseTo(0.2, 2);
    });
  });

  describe('getConfidence', () => {
    it('should calculate weighted average', () => {
      const factors = [
        { factor: 'a', value: 0.8, weight: 2 },
        { factor: 'b', value: 0.6, weight: 1 },
      ];
      // (0.8*2 + 0.6*1) / (2+1) = 2.2/3 = 0.733
      expect(service.getConfidence(factors)).toBeCloseTo(0.733, 2);
    });

    it('should return 0 for empty factors', () => {
      expect(service.getConfidence([])).toBe(0);
    });

    it('should handle single factor', () => {
      expect(service.getConfidence([{ factor: 'x', value: 0.9, weight: 1 }])).toBe(0.9);
    });
  });
});

/* ────────────── IntegrationStrategyGeneratorService ────────────── */

describe('IntegrationStrategyGeneratorService', () => {
  let service: IntegrationStrategyGeneratorService;
  const mockLogger = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new IntegrationStrategyGeneratorService(mockLogger, null, null);
  });

  describe('generateArchitectureOptions', () => {
    it('should generate options from patterns via callback', async () => {
      const patternAnalysis = {
        recommendedPatterns: [
          { name: 'api_first' },
          { name: 'batch' },
        ],
      } as any;
      const createOption = jest.fn((p: any) => ({ name: p.name, estimatedCost: 10000 }));
      const calcScore = jest.fn((o: any) => o.estimatedCost);

      const result = await service.generateArchitectureOptions(
        {} as any, {} as any, patternAnalysis, createOption, calcScore,
      );
      expect(result.length).toBe(2);
      expect(createOption).toHaveBeenCalledTimes(2);
    });

    it('should sort by score descending', async () => {
      const patternAnalysis = {
        recommendedPatterns: [{ name: 'a' }, { name: 'b' }],
      } as any;
      const createOption = jest.fn((p: any) => ({ name: p.name }));
      const calcScore = jest.fn((o: any) => o.name === 'b' ? 100 : 50);

      const result = await service.generateArchitectureOptions(
        {} as any, {} as any, patternAnalysis, createOption, calcScore,
      );
      expect(result[0].name).toBe('b');
    });

    it('should limit to top 5 options', async () => {
      const patterns = Array.from({ length: 8 }, (_, i) => ({ name: `p${i}` }));
      const patternAnalysis = { recommendedPatterns: patterns } as any;
      const createOption = jest.fn((p: any) => ({ name: p.name }));
      const calcScore = jest.fn(() => 1);

      const result = await service.generateArchitectureOptions(
        {} as any, {} as any, patternAnalysis, createOption, calcScore,
      );
      expect(result.length).toBe(5);
    });
  });

  describe('recommendIntegrationApproach', () => {
    it('should use heuristic fallback when no AI providers', async () => {
      const input = {
        sourceSystemProfile: { name: 'SF', type: 'crm' },
        targetSystemProfile: { name: 'NS', type: 'erp' },
      } as any;
      const assessment = {
        compatibility: { overallScore: 0.85 },
        complexity: { overallComplexity: 'medium' },
        security: { overallRiskLevel: 'low' },
      } as any;
      const patternAnalysis = {
        recommendedPatterns: [
          { name: 'api_first', description: 'API integration', type: 'api', complexity: 'low', benefits: ['Fast'] },
        ],
      } as any;
      const selectCallback = jest.fn(() => patternAnalysis.recommendedPatterns[0]);

      const result = await service.recommendIntegrationApproach(
        input, assessment, patternAnalysis, [], selectCallback,
      );
      expect(result.name).toContain('API');
      expect(result.pattern).toBe('api_first');
      expect(result.complexity).toBe('medium'); // medium system complexity
      expect(selectCallback).toHaveBeenCalled();
    });

    it('should log error and fall back when AI provider throws', async () => {
      const service2 = new IntegrationStrategyGeneratorService(
        mockLogger,
        { getAvailableProviders: jest.fn().mockRejectedValue(new Error('AI down')) },
        { analyzeWithLLM: jest.fn() },
      );
      const input = {
        sourceSystemProfile: { name: 'SF', type: 'crm' },
        targetSystemProfile: { name: 'NS', type: 'erp' },
      } as any;
      const assessment = {
        compatibility: { overallScore: 0.85 },
        complexity: { overallComplexity: 'low' },
        security: { overallRiskLevel: 'low' },
      } as any;
      const patternAnalysis = {
        recommendedPatterns: [
          { name: 'batch', description: 'Batch processing', type: 'batch', complexity: 'low', benefits: ['Simple'] },
        ],
      } as any;
      const selectCallback = jest.fn(() => patternAnalysis.recommendedPatterns[0]);

      const result = await service2.recommendIntegrationApproach(input, assessment, patternAnalysis, [], selectCallback);
      // Inner try-catch logs error and returns null, outer code falls back to heuristic
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('AI integration strategy recommendation failed'),
        expect.any(Object),
      );
      expect(selectCallback).toHaveBeenCalled();
      expect(result.pattern).toBe('batch');
    });
  });

  describe('generateRecommendationReason', () => {
    it('should include pattern name and benefits', () => {
      const pattern = { name: 'api_first', benefits: ['Fast setup'] } as any;
      const input = {
        sourceSystemProfile: { type: 'crm' },
        targetSystemProfile: { type: 'erp' },
      } as any;
      const assessment = { complexity: { overallComplexity: 'medium' } } as any;

      const reason = service.generateRecommendationReason(pattern, input, assessment, []);
      expect(reason).toContain('api_first');
      expect(reason).toContain('fast setup');
      expect(reason).toContain('crm');
    });

    it('should mention risks when present', () => {
      const pattern = { name: 'test', benefits: ['x'] } as any;
      const input = { sourceSystemProfile: { type: 'a' }, targetSystemProfile: { type: 'b' } } as any;
      const assessment = { complexity: { overallComplexity: 'low' } } as any;
      const risks = [{}, {}] as any[];

      const reason = service.generateRecommendationReason(pattern, input, assessment, risks);
      expect(reason).toContain('2 identified');
    });

    it('should not mention risks when empty', () => {
      const pattern = { name: 'test', benefits: ['x'] } as any;
      const input = { sourceSystemProfile: { type: 'a' }, targetSystemProfile: { type: 'b' } } as any;
      const assessment = { complexity: { overallComplexity: 'low' } } as any;

      const reason = service.generateRecommendationReason(pattern, input, assessment, []);
      expect(reason).not.toContain('identified');
    });
  });
});

/* ────────────── MigrationPlanningService ────────────── */

describe('MigrationPlanningService', () => {
  let service: MigrationPlanningService;

  beforeEach(() => {
    service = new MigrationPlanningService();
  });

  const makeApproach = (overrides: Record<string, any> = {}) => ({
    name: 'API First Integration',
    description: 'API-first approach',
    pattern: 'api_first',
    complexity: 'medium',
    ...overrides,
  });

  const makeOption = (overrides: Record<string, any> = {}) => ({
    name: 'API Architecture',
    estimatedCost: 50000,
    implementationTime: 90,
    complexity: 'medium',
    scalability: 'high',
    ...overrides,
  });

  describe('createImplementationPlan', () => {
    it('should create a plan with 4 phases', async () => {
      const plan = await service.createImplementationPlan(makeApproach() as any, makeOption() as any);
      expect(plan.phases.length).toBe(4);
    });

    it('should calculate total duration from phases', async () => {
      const plan = await service.createImplementationPlan(makeApproach() as any, makeOption() as any);
      const sumDurations = plan.phases.reduce((sum, p) => sum + p.duration, 0);
      expect(plan.totalDuration).toBe(sumDurations);
    });

    it('should calculate total cost from phases', async () => {
      const plan = await service.createImplementationPlan(makeApproach() as any, makeOption() as any);
      const sumCosts = plan.phases.reduce((sum, p) => sum + p.cost, 0);
      expect(plan.totalCost).toBe(sumCosts);
    });

    it('should include sequential dependencies', async () => {
      const plan = await service.createImplementationPlan(makeApproach() as any, makeOption() as any);
      expect(plan.dependencies.length).toBe(3); // 4 phases -> 3 sequential deps
    });

    it('should include critical path with all phases', async () => {
      const plan = await service.createImplementationPlan(makeApproach() as any, makeOption() as any);
      expect(plan.criticalPath.length).toBe(4);
    });
  });

  describe('createImplementationPhases', () => {
    it('should create Planning phase first', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      expect(phases[0].name).toBe('Planning and Design');
      expect(phases[0].duration).toBe(30);
      expect(phases[0].cost).toBe(10000); // 50000 * 0.2
    });

    it('should create Development phase second', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      expect(phases[1].name).toBe('Development and Configuration');
      expect(phases[1].duration).toBe(54); // 90 * 0.6
      expect(phases[1].cost).toBe(25000); // 50000 * 0.5
    });

    it('should create Testing phase third', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      expect(phases[2].name).toBe('Testing and Validation');
      expect(phases[2].duration).toBe(22.5); // 90 * 0.25
      expect(phases[2].cost).toBe(10000); // 50000 * 0.2
    });

    it('should create Deployment phase last', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      expect(phases[3].name).toBe('Deployment and Go-Live');
      expect(phases[3].duration).toBe(13.5); // 90 * 0.15
      expect(phases[3].cost).toBe(5000); // 50000 * 0.1
    });

    it('should include deliverables for each phase', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      phases.forEach(phase => {
        expect(phase.deliverables.length).toBeGreaterThan(0);
      });
    });

    it('should include risks for each phase', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      phases.forEach(phase => {
        expect(phase.risks.length).toBeGreaterThan(0);
      });
    });

    it('should include resources for each phase', () => {
      const phases = service.createImplementationPhases(makeApproach() as any, makeOption() as any);
      phases.forEach(phase => {
        expect(phase.resources.length).toBeGreaterThan(0);
        expect(phase.resources[0].type).toBe('human');
      });
    });
  });

  describe('identifyPhaseDependencies', () => {
    it('should create sequential dependencies', () => {
      const phases = [{ name: 'A' }, { name: 'B' }, { name: 'C' }] as any[];
      const deps = service.identifyPhaseDependencies(phases);
      expect(deps.length).toBe(2);
      expect(deps[0].fromPhase).toBe('A');
      expect(deps[0].toPhase).toBe('B');
      expect(deps[0].type).toBe('blocking');
      expect(deps[1].fromPhase).toBe('B');
      expect(deps[1].toPhase).toBe('C');
    });

    it('should return empty for single phase', () => {
      expect(service.identifyPhaseDependencies([{ name: 'A' }] as any[])).toEqual([]);
    });
  });

  describe('calculateCriticalPath', () => {
    it('should return all phase names in order', () => {
      const phases = [{ name: 'A' }, { name: 'B' }, { name: 'C' }] as any[];
      expect(service.calculateCriticalPath(phases, [])).toEqual(['A', 'B', 'C']);
    });
  });
});
