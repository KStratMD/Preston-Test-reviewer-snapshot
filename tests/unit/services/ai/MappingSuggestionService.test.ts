import { MappingSuggestionService } from '../../../../src/services/ai/orchestrator/agents/services/field-mapping/MappingSuggestionService';
import type { MappingContext, MappingPattern } from '../../../../src/services/ai/orchestrator/agents/fieldMappingTypes';
import type { FieldDefinition } from '../../../../src/services/ai/orchestrator/interfaces';

const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
};

describe('MappingSuggestionService heuristics', () => {
  const providerRegistry = {
    getAvailableProvider: jest.fn()
  };

  const semanticEngine = {
    calculateSemanticSimilarity: jest.fn().mockResolvedValue({
      score: 0.8,
      method: 'calibrated_fallback',
      explanation: 'synthetic similarity',
      confidence: 0.9
    })
  };

  const mappingPatterns = new Map<string, MappingPattern>([
    [
      'name-pattern',
      {
        name: 'name-pattern',
        description: 'Account/customer names',
        sourcePattern: '(account|customer).*(name)',
        targetPattern: '(company|customer).*(name)',
        confidence: 0.85,
        usageCount: 100
      }
    ]
  ]);

  const similarityCache = new Map<string, number>();

  const buildFields = (fields: Array<Partial<FieldDefinition> & Pick<FieldDefinition, 'name' | 'type'>>): FieldDefinition[] =>
    fields.map(field => ({
      description: '',
      required: false,
      sampleValues: [],
      ...field
    }));

  const service = new MappingSuggestionService(
    logger as any,
    providerRegistry as any,
    semanticEngine as any,
    mappingPatterns,
    similarityCache
  );

  beforeEach(() => {
    jest.clearAllMocks();
    providerRegistry.getAvailableProvider.mockResolvedValue(null);
    similarityCache.clear();
  });

  const context: MappingContext = {
    sourceSchema: {
      systemName: 'SourceCRM',
      systemType: 'crm',
      fields: buildFields([
        { name: 'Email', type: 'string', required: true },
        { name: 'AccountName', type: 'string' },
        { name: 'Amount', type: 'string' }
      ]),
      relationships: [],
      constraints: [],
      customFields: []
    },
    targetSchema: {
      systemName: 'TargetERP',
      systemType: 'erp',
      fields: buildFields([
        { name: 'email_address', type: 'string' },
        { name: 'companyName', type: 'string' },
        { name: 'amount', type: 'number' }
      ]),
      relationships: [],
      constraints: [],
      customFields: []
    },
    businessRules: [
      {
        id: 'rule-1',
        name: 'Normalize amount',
        description: 'Convert currency string to number',
        sourceFields: ['Amount'],
        targetFields: ['amount'],
        transformation: { type: 'calculation', expression: 'parseCurrency(sourceValue)' },
        priority: 1,
        active: true
      }
    ],
    sampleData: [],
    existingMappings: []
  };

  it('returns heuristic suggestions when no provider is available', async () => {
    const result = await service.generateSuggestions(context);

    expect(providerRegistry.getAvailableProvider).toHaveBeenCalled();
    expect(result.providerUsage).toBeUndefined();

    const suggestions = result.suggestions.map(s => `${s.sourceField}->${s.targetField}`);
    expect(suggestions).toEqual(expect.arrayContaining([
      'Email->email_address',          // semantic/heuristic
      'AccountName->companyName',      // pattern heuristic
      'Amount->amount'                 // type match / business rule
    ]));

    // PERFORMANCE FIX (Nov 9, 2025): Semantic similarity is NO LONGER called for LLM suggestions
    // LLMs already provide intelligent mapping - no need for additional semantic analysis
    // This prevents timeouts and speeds up response time from 30s to ~3s
    expect(semanticEngine.calculateSemanticSimilarity).not.toHaveBeenCalled();
  });

  it('caches semantic similarity results', async () => {
    await service.generateSuggestions(context);
    const initialCalls = semanticEngine.calculateSemanticSimilarity.mock.calls.length;

    // Second invocation should reuse cached similarities.
    await service.generateSuggestions(context);
    expect(semanticEngine.calculateSemanticSimilarity).toHaveBeenCalledTimes(initialCalls);
  });
});

