import { AIFieldMappingService } from '../../../../src/services/ai/AIFieldMappingService';
import type {
  SchemaDefinition,
  NetSuiteSchema,
  FieldDefinition,
  AIFieldMappingSuggestion
} from '../../../../src/services/ai/AIFieldMappingService';
import type { FieldMapping, DataRecord } from '../../../../src/types';

const createLogger = () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
});

const buildSchemas = () => {
  const sourceSchema: SchemaDefinition = {
    systemType: 'Salesforce',
    fields: [
      { name: 'EmailAddress', type: 'email' },
      { name: 'Amount', type: 'number' },
      { name: 'IsActive', type: 'boolean' }
    ]
  };

  const targetSchema: NetSuiteSchema = {
    systemType: 'NetSuite',
    recordType: 'customer',
    fields: [
      { name: 'email', type: 'email', required: true },
      { name: 'amountNet', type: 'number' },
      { name: 'isactive', type: 'boolean', required: true }
    ],
    customFields: [
      { id: 'custentity_custom', label: 'Custom Field', type: 'string', recordType: 'customer' }
    ],
    relationships: []
  };

  return { sourceSchema, targetSchema };
};

const buildDetailedSchemas = () => {
  const { sourceSchema, targetSchema } = buildSchemas();

  const extendedSource: SchemaDefinition = {
    ...sourceSchema,
    recordType: 'account',
    fields: [
      ...sourceSchema.fields,
      { name: 'AccountName', type: 'string' },
      { name: 'PrimaryPhone', type: 'phone' },
      { name: 'AnnualRevenue', type: 'string' },
      { name: 'CreatedDate', type: 'date' },
      { name: 'LoyaltyId', type: 'string' }
    ]
  };

  const extendedTarget: NetSuiteSchema = {
    ...targetSchema,
    fields: [
      ...targetSchema.fields,
      { name: 'companyname', type: 'string', required: true },
      { name: 'phone', type: 'phone' },
      { name: 'creditlimit', type: 'currency' },
      { name: 'createddate', type: 'date' }
    ],
    customFields: [
      ...targetSchema.customFields,
      {
        id: 'custentity_loyalty_id',
        label: 'LoyaltyId',
        type: 'string',
        recordType: 'customer',
        helpText: 'Tracks loyalty id'
      }
    ]
  };

  return { sourceSchema: extendedSource, targetSchema: extendedTarget };
};

describe('AIFieldMappingService utility behaviors', () => {
  const logger = createLogger();
  const mockTrainingDataRepo = {
    getTrainingExamples: jest.fn().mockResolvedValue([]),
    saveTrainingExample: jest.fn().mockResolvedValue(undefined),
    storeTrainingExample: jest.fn().mockResolvedValue(undefined),
    getSignalEffectiveness: jest.fn().mockResolvedValue({}),
    getDatasetStatistics: jest.fn().mockResolvedValue({ totalExamples: 0, successRate: 0, averageConfidence: 0, sourceSystemBreakdown: {}, targetSystemBreakdown: {}, transformationTypeBreakdown: {}, feedbackBreakdown: {} }),
  } as any;
  const service = new AIFieldMappingService(logger as any, mockTrainingDataRepo);
  const svc: any = service;

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('combines analysis results and returns null when confidence too low', async () => {
    const sourceField: FieldDefinition = { name: 'EmailAddress', type: 'email' };
    const suggestion = await svc.combineAnalysisResults(
      [{ field: 'email', score: 0.8, explanation: 'semantic' }],
      [{ field: 'email', score: 0.5, explanation: 'pattern' }],
      [],
      sourceField,
      ['user@example.com', 'team@company.org'],
      'default'
    ) as AIFieldMappingSuggestion;

    expect(suggestion.targetField).toBe('email');
    expect(suggestion.confidence).toBeGreaterThan(0.5);
    expect(suggestion.alternatives.length).toBeGreaterThan(0);

    const nullSuggestion = await svc.combineAnalysisResults(
      [{ field: 'email', score: 0.1, explanation: 'weak' }],
      [],
      [],
      sourceField,
      [],
      'default'
    );

    expect(nullSuggestion).toBeNull();
  });

  it('detects data patterns and matches to fields', () => {
    const emailPattern = svc.identifyDataPatterns(['user@example.com', 'team@company.org']);
    expect(emailPattern.type).toBe('email');

    const matchScore = svc.matchPatternsToField(emailPattern, { name: 'email', type: 'email' });
    expect(matchScore).toBeGreaterThan(0.5);

    const noMatchScore = svc.matchPatternsToField(emailPattern, { name: 'amount', type: 'number' });
    expect(noMatchScore).toBe(0);
  });

  it('calculates mapping quality and surfaces recommendations', async () => {
    const { sourceSchema, targetSchema } = buildSchemas();
    const mappings: FieldMapping[] = [
      { sourceField: 'Missing', targetField: 'unknown', transformationType: 'direct', isRequired: false }
    ];

    const report = await service.validateMappingQuality(mappings, sourceSchema, targetSchema);
    expect(report.overallScore).toBeLessThan(1);
    expect(report.potentialIssues.length).toBeGreaterThan(0);
    expect(report.recommendations.length).toBeGreaterThan(0);
  });

  it('determines transformation types based on target field', () => {
    const directType = svc.determineTransformationType({ name: 'Name', type: 'string' }, 'displayname');
    expect(directType).toBe('direct');

    const lookupType = svc.determineTransformationType({ name: 'Owner', type: 'string' }, 'ownerId');
    expect(lookupType).toBe('lookup');
  });

  it('provides transformation suggestions with appropriate ordering', async () => {
    const suggestions = await service.suggestTransformations(
      { name: 'createdDate', type: 'date' },
      { name: 'createdDate', type: 'date' }
    );
    expect(suggestions[0].type).toBe('direct');
    expect(suggestions.some((entry: any) => entry.type === 'format')).toBe(true);

    const stringToNumber = await service.suggestTransformations(
      { name: 'Amount', type: 'string' },
      { name: 'Amount', type: 'number' }
    );
    expect(stringToNumber.some((s: any) => s.type === 'convert')).toBe(true);
  });

  it('suggests validation patterns', async () => {
    const patterns = await service.suggestValidationPatterns('PrimaryEmail', 'string');
    expect(patterns[0].regex).toContain('@');

    const phonePatterns = await service.suggestValidationPatterns('BillingPhone', 'string');
    expect(phonePatterns[0].description).toMatch(/phone/i);
  });

  it('validates transformation logic and flags dangerous patterns', async () => {
    const invalid = await service.validateTransformationLogic('');
    expect(invalid.valid).toBe(false);

    const dangerous = await service.validateTransformationLogic('eval("alert(1)")');
    expect(dangerous.errors.length).toBeGreaterThan(0);
  });

  it('suggests default values based on field name and type', async () => {
    const booleanSuggestions = await service.suggestDefaultValues('IsActive', 'boolean');
    expect(booleanSuggestions[0].value).toBe('true');

    const numberSuggestions = await service.suggestDefaultValues('Quantity', 'number');
    expect(numberSuggestions.some((s: any) => s.value === '0')).toBe(true);
  });

  it('records user feedback and logs training example', async () => {
    const suggestion: AIFieldMappingSuggestion = {
      sourceField: 'EmailAddress',
      targetField: 'email',
      confidence: 0.9,
      transformationType: 'direct',
      explanation: 'Semantic match',
      alternatives: []
    } as any;

    await service.recordUserFeedback(suggestion, true);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Recording user feedback'), expect.any(Object));
    expect(logger.debug).toHaveBeenCalledWith('Training example created', expect.any(Object));
  });

  it('returns NetSuite standard mappings', () => {
    const mappings = svc.getNetSuiteStandardMappings('Salesforce', 'customer');
    expect(mappings['accountname'].targetField).toBe('companyname');
  });

  it('generates combined AI mapping suggestions with NetSuite intelligence', async () => {
    const { sourceSchema, targetSchema } = buildDetailedSchemas();
    const sampleData: DataRecord[] = [
      {
        EmailAddress: 'ops@squire.com',
        Amount: 1250,
        IsActive: true,
        AccountName: 'Acme Holdings',
        PrimaryPhone: '+1 (385) 555-1100',
        AnnualRevenue: '1200.00',
        CreatedDate: '2024-09-21T12:00:00Z',
        LoyaltyId: 'L-100'
      },
      {
        EmailAddress: 'finance@squire.com',
        Amount: 980,
        IsActive: false,
        AccountName: 'Summit Advisors',
        PrimaryPhone: '+1-801-555-2200',
        AnnualRevenue: '3250.50',
        CreatedDate: '2024-10-01T00:00:00Z',
        LoyaltyId: 'L-200'
      },
      {
        EmailAddress: 'integration@squire.com',
        Amount: 1500,
        IsActive: true,
        AccountName: 'Mountain Peak LLC',
        PrimaryPhone: '+1 435 555 3300',
        AnnualRevenue: '8650.75',
        CreatedDate: '2024-10-05T08:00:00Z',
        LoyaltyId: 'L-300'
      }
    ];

    const suggestions = await service.suggestFieldMappings(sourceSchema, targetSchema, sampleData);

    const accountSuggestion = suggestions.find(s => s.sourceField === 'AccountName');
    expect(accountSuggestion?.targetField).toBe('companyname');
    expect(accountSuggestion?.netsuiteSpecific?.recordTypeSpecific).toBe(true);

    const phoneSuggestion = suggestions.find(s => s.sourceField === 'PrimaryPhone');
    expect(phoneSuggestion?.targetField).toBe('phone');
    expect(phoneSuggestion?.confidence).toBeGreaterThan(0.4);

    const loyaltySuggestion = suggestions.find(s => s.sourceField === 'LoyaltyId');
    expect(loyaltySuggestion?.targetField).toBe('custentity_loyalty_id');
    expect(loyaltySuggestion?.alternatives.length).toBeGreaterThan(0);

    const revenueSuggestion = suggestions.find(s => s.sourceField === 'AnnualRevenue');
    expect(revenueSuggestion?.targetField).toBeDefined();
    expect(revenueSuggestion?.alternatives.length).toBeGreaterThan(0);
    expect(suggestions.some(s => s.explanation.includes('NetSuite standard mapping'))).toBe(true);

    expect(suggestions.length).toBeGreaterThanOrEqual(5);
    if (suggestions.length > 1) {
      expect(suggestions[0].confidence).toBeGreaterThanOrEqual(suggestions[1].confidence);
    }
  });
});
