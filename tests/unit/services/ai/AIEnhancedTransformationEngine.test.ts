import { AIEnhancedTransformationEngine, type SmartMappingRequest } from '../../../../src/services/ai/AIEnhancedTransformationEngine';
import type { AIFieldMappingSuggestion, MappingQualityReport } from '../../../../src/services/ai/AIFieldMappingService';
import type { TransformationContext, TransformationResult } from '../../../../src/services/TransformationEngine';

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

const createEngine = () => {
  const logger = createLogger();
  const aiFieldMappingService = {
    suggestFieldMappings: jest.fn(),
    validateMappingQuality: jest.fn()
  };
  const semanticAnalyzer = {};
  const netsuiteIntelligence = {};
  const patternRecognizer = {};
  const trainingRepository = {};

  const engine = new AIEnhancedTransformationEngine(
    logger as any,
    aiFieldMappingService as any,
    semanticAnalyzer as any,
    netsuiteIntelligence as any,
    patternRecognizer as any,
    trainingRepository as any
  );

  return { engine, logger, aiFieldMappingService };
};

describe('AIEnhancedTransformationEngine', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates smart mappings and combines AI signals', async () => {
    const { engine, aiFieldMappingService, logger } = createEngine();

    const suggestions: AIFieldMappingSuggestion[] = [
      {
        sourceField: 'AccountName',
        targetField: 'companyname',
        confidence: 0.95,
        transformationType: 'direct',
        explanation: 'High semantic similarity',
        alternatives: [],
        netsuiteSpecific: { recordTypeSpecific: true }
      },
      {
        sourceField: 'LoyaltyId',
        targetField: 'custentity_loyalty',
        confidence: 0.85,
        transformationType: 'lookup',
        explanation: 'Custom field match',
        alternatives: [],
        netsuiteSpecific: { customFieldId: 'custentity_loyalty' }
      }
    ];

    const qualityReport: MappingQualityReport = {
      overallScore: 0.7,
      fieldMappings: [],
      potentialIssues: [],
      recommendations: []
    };

    aiFieldMappingService.suggestFieldMappings.mockResolvedValue(suggestions);
    aiFieldMappingService.validateMappingQuality.mockResolvedValue(qualityReport);

    const request: SmartMappingRequest = {
      sourceData: [],
      sourceSchema: {
        systemType: 'Salesforce',
        fields: [{ name: 'AccountName', type: 'string' }]
      },
      targetSchema: {
        systemType: 'NetSuite',
        recordType: 'customer',
        fields: [{ name: 'companyname', type: 'string', required: true }],
        customFields: [],
        relationships: []
      },
      existingMappings: [
        {
          sourceField: 'BillingEmail',
          targetField: 'email',
          transformationType: 'direct',
          isRequired: false
        }
      ],
      options: { confidenceThreshold: 0.8 }
    };

    const response = await engine.generateSmartMappings(request);

    expect(response.suggestedMappings).toHaveLength(3);
    expect(response.suggestedMappings.some(m => m.sourceField === 'AccountName')).toBe(true);
    expect(response.suggestedMappings.some(m => m.sourceField === 'BillingEmail')).toBe(true);
    expect(response.aiSuggestions).toEqual(suggestions);
    expect(response.qualityReport).toBe(qualityReport);
    expect(response.confidence).toBeCloseTo(0.8);
    expect(response.recommendations).toEqual(
      expect.arrayContaining([
        expect.stringContaining('high-confidence'),
        expect.stringContaining('Consider reviewing field mappings'),
        expect.stringContaining('custom field mappings'),
        expect.stringContaining('pattern recognition')
      ])
    );
    expect(logger.info).toHaveBeenCalledWith(
      'Smart mappings generated',
      expect.objectContaining({ overallConfidence: expect.any(Number) })
    );
  });

  it('fails closed when the re-transformation with auto-applied mappings fails (Codex on PR #1253)', async () => {
    // An auto-generated mapping that duplicates an existing target is a
    // structural error in the engine; the AI layer must not merge its fields
    // or report success.
    const { engine, aiFieldMappingService } = createEngine();
    aiFieldMappingService.suggestFieldMappings.mockResolvedValue([
      { sourceField: 'company', targetField: 'companyname', confidence: 0.95, transformationType: 'direct', explanation: 'x', alternatives: [] },
    ] as any);
    aiFieldMappingService.validateMappingQuality.mockResolvedValue({ overallScore: 0.9, issues: [], suggestions: [] } as any);
    const baseResult: TransformationResult = {
      success: true,
      transformedData: { id: '1', externalId: '1', fields: { companyname: 'Acme' } } as any,
      errors: [],
      warnings: [],
    };
    const failedRetransform: TransformationResult = {
      success: false,
      transformedData: { id: '1', externalId: '1', fields: { companyname: 'Acme', company: 'RawCo' } } as any,
      errors: [{ field: 'general', message: 'mapping set invalid: duplicate targetField: companyname', severity: 'error' }],
      warnings: [],
    };
    jest.spyOn(engine, 'transform').mockResolvedValueOnce(baseResult).mockResolvedValueOnce(failedRetransform);

    const result = await engine.transformWithAI(
      { sourceData: { id: '1', externalId: '1', fields: { name: 'Acme', company: 'RawCo' } } as any, mappings: [{ sourceField: 'name', targetField: 'companyname', transformationType: 'direct', isRequired: false }], rules: [] },
      { enableAutoMapping: true, autoAcceptHighConfidence: true, confidenceThreshold: 0.6 },
    );

    expect(engine.transform).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ message: expect.stringMatching(/duplicate targetField/) })]);
    expect(result.transformedData.fields).not.toHaveProperty('company');
    expect(result.learningInsights.some((m) => /rejected by the transformation engine/.test(m))).toBe(true);
  });
  it('applies AI-assisted transformation with auto-accepted suggestions', async () => {
    const { engine, aiFieldMappingService } = createEngine();

    const baseResult: TransformationResult = {
      success: true,
      transformedData: {
        id: '1',
        fields: { companyname: 'Acme Corp' }
      } as any,
      errors: [],
      warnings: []
    };

    const updatedResult: TransformationResult = {
      success: true,
      transformedData: {
        id: '1',
        fields: { email: 'ops@acme.com' }
      } as any,
      errors: [],
      warnings: ['auto-applied']
    };

    jest
      .spyOn(engine, 'transform')
      .mockResolvedValueOnce(baseResult)
      .mockResolvedValueOnce(updatedResult);

    aiFieldMappingService.validateMappingQuality.mockResolvedValue({
      overallScore: 0.9,
      fieldMappings: [],
      potentialIssues: [],
      recommendations: []
    });

    const context: TransformationContext = {
      sourceData: {
        id: '1',
        fields: { name: 'Acme', email: 'ops@acme.com', phone: '555-1000' }
      } as any,
      mappings: [
        {
          sourceField: 'name',
          targetField: 'companyname',
          transformationType: 'direct',
          isRequired: false
        }
      ],
      rules: []
    };

    const result = await engine.transformWithAI(context, {
      autoAcceptHighConfidence: true,
      confidenceThreshold: 0.6
    });

    expect(engine.transform).toHaveBeenCalledTimes(2);
    expect(result.aiSuggestions.length).toBe(2);
    expect(result.autoMappingsApplied).toBe(2);
    expect(result.learningInsights[0]).toMatch(/Transformation completed successfully/);
    expect(result.learningInsights.some(msg => msg.includes('coverage'))).toBe(true);
    expect(result.confidence).toBeCloseTo(0.825, 2);
    expect(result.mappingQuality?.overallScore).toBe(0.9);
  });
});
