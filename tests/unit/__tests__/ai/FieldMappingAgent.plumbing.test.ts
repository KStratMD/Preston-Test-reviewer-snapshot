import 'reflect-metadata';
import { FieldMappingAgent } from '../../../../src/services/ai/orchestrator/agents/FieldMappingAgent';
import type { FieldMappingInput, EnhancedFieldMapping } from '../../../../src/services/ai/orchestrator/interfaces';
import type { ProviderRegistry } from '../../../../src/services/ai/ProviderRegistry';
import type { SemanticAnalysisEngine } from '../../../../src/services/ai/SemanticAnalysisEngine';
import type { AgentExecutionContext } from '../../../../src/services/ai/orchestrator/interfaces';
import type { Logger } from '../../../../src/utils/Logger';

describe('FieldMappingAgent real provider prioritisation', () => {
  let agent: FieldMappingAgent;
  let providerRegistry: jest.Mocked<ProviderRegistry>;
  let semanticEngine: jest.Mocked<SemanticAnalysisEngine>;
  let logger: jest.Mocked<Logger>;
  const mockProviderId = 'claude';

  beforeEach(() => {
    logger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis()
    } as any;

    const providerMock = {
      generateMappingSuggestions: jest.fn().mockResolvedValue([
        {
          sourceField: 'CompanyName',
          targetField: 'companyname',
          confidence: 0.92,
          transformationType: 'direct',
          reasoning: 'Top ranked semantic match',
          alternatives: [
            {
              sourceField: 'CompanyName',
              targetField: 'entityid',
              confidence: 0.55,
              transformationType: 'direct',
              reasoning: 'Alternative identifier mapping'
            }
          ]
        }
      ]),
      analyzeDataQuality: jest.fn(),
      testConnection: jest.fn(),
      getUsageMetrics: jest.fn().mockReturnValue({ tokens: 420, cost: 0.0126 })
    } as any;

    providerRegistry = {
      getAvailableProvider: jest.fn().mockResolvedValue({ provider: providerMock, id: mockProviderId }),
      register: jest.fn(),
      setFallbackOrder: jest.fn(),
      getProvider: jest.fn(),
      listProviders: jest.fn(),
      testProvider: jest.fn()
    } as unknown as jest.Mocked<ProviderRegistry>;

    // Mock SemanticAnalysisEngine to return high similarity for related fields
    semanticEngine = {
      calculateSemanticSimilarity: jest.fn().mockImplementation((request) => {
        // Simulate AI semantic similarity
        const field1 = request.text1.toLowerCase();
        const field2 = request.text2.toLowerCase();
        
        // High similarity for related fields
        if ((field1.includes('industry') && field2.includes('industry')) ||
            (field1.includes('company') && field2.includes('company'))) {
          return Promise.resolve({
            score: 0.85,
            method: 'llm_analysis',
            explanation: 'AI-detected semantic similarity',
            confidence: 0.9
          });
        }
        
        // Low similarity for unrelated fields (won't meet threshold)
        return Promise.resolve({
          score: 0.3,
          method: 'llm_analysis',
          explanation: 'Low semantic similarity',
          confidence: 0.8
        });
      }),
      analyzeFieldMapping: jest.fn(),
      analyzeSchemaMapping: jest.fn()
    } as any;

    agent = new FieldMappingAgent(logger, providerRegistry, semanticEngine);
  });

  it('prioritises LLM output while supplementing with heuristics and tagging origins', async () => {
    const context: AgentExecutionContext = {
      sessionId: 'session-123',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      confidenceThreshold: 0.5,
      maxExecutionTime: 10000,
      metadata: {
        preferredProvider: mockProviderId
      }
    };

    const input: FieldMappingInput = {
      sourceFields: [
        { name: 'CompanyName', type: 'string', description: 'Account name' },
        { name: 'Industry_Code__c', type: 'string', description: 'Custom industry classification' }
      ],
      targetFields: [
        { name: 'companyname', type: 'string' },
        { name: 'industry_code', type: 'string' }
      ],
      sampleData: [
        {
          sourceValues: {
            CompanyName: 'ACME Corp',
            Industry_Code__c: 'TECH'
          }
        }
      ]
    };

  const result = await agent.execute(context, input);
    expect(result.success).toBeTruthy();
    expect(providerRegistry.getAvailableProvider).toHaveBeenCalledWith(mockProviderId);

    const output = result.data;
    expect(output).toBeDefined();
    const mappings = output?.mappings ?? [];
    expect(mappings.length).toBeGreaterThanOrEqual(2);

  const llmMapping = mappings.find((m: EnhancedFieldMapping) => m.sourceField === 'CompanyName');
    expect(llmMapping).toBeDefined();
    expect(llmMapping?.origin).toBe('llm');
    expect(llmMapping?.providerId).toBe(mockProviderId);
    expect(llmMapping?.alternatives?.[0]?.targetField).toBe('entityid');

  // PERFORMANCE FIX (Nov 9, 2025): Semantic matches use heuristics for fields not covered by LLM
  // LLM suggestions come from provider, semantic/pattern matches are heuristic fallbacks
  const semanticMapping = mappings.find((m: EnhancedFieldMapping) => m.sourceField === 'Industry_Code__c');
    expect(semanticMapping).toBeDefined();
    expect(semanticMapping?.targetField).toBe('industry_code');
    expect(semanticMapping?.origin).toBe('heuristic'); // Heuristic for fields LLM didn't suggest

    expect(result.reasoning).toContain(`LLM provider ${mockProviderId}`);
  });

  it('falls back to heuristic mappings when no provider is available', async () => {
    providerRegistry.getAvailableProvider.mockResolvedValueOnce(null);
    
    // Make semantic engine fail to test full heuristic fallback
    semanticEngine.calculateSemanticSimilarity.mockRejectedValue(new Error('AI service unavailable'));

    const context: AgentExecutionContext = {
      sessionId: 'session-456',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      confidenceThreshold: 0.5,
      maxExecutionTime: 10000,
      metadata: {
        preferredProvider: mockProviderId
      }
    };

    const input: FieldMappingInput = {
      sourceFields: [
        { name: 'CompanyName', type: 'string', description: 'Account name' },
        { name: 'Industry', type: 'string', description: 'Industry sector' }
      ],
      targetFields: [
        { name: 'companyname', type: 'string' },
        { name: 'industry', type: 'string' }
      ],
      sampleData: [
        {
          sourceValues: {
            CompanyName: 'Globex Corporation',
            Industry: 'Manufacturing'
          }
        }
      ]
    };

    const result = await agent.execute(context, input);

    expect(result.success).toBeTruthy();
    expect(providerRegistry.getAvailableProvider).toHaveBeenCalledWith(mockProviderId);

    const mappings = (result.data?.mappings || []) as EnhancedFieldMapping[];
    expect(mappings.length).toBeGreaterThan(0);
    
    // With AI failing, semantic matches fall back to heuristic origin
    expect(mappings.every(mapping => mapping.origin === 'heuristic')).toBe(true);
    expect(mappings.every(mapping => !mapping.providerId)).toBe(true);
    expect(result.reasoning).not.toContain('LLM provider');
  });
});

/**
 * Task 10 (advisory AI profile recommendations, 2026-07-27 NetSuite
 * serialized-asset sync plan). `executionProfileHint` is deterministic,
 * caller-supplied plumbing (never derived from AI/model output) — the
 * projector it feeds (`FieldMappingAgent.buildExecutionProfileRecommendation`)
 * must:
 *   - recommend ONLY the exact NetSuite inventorynumber -> Salesforce Asset
 *     pair (case/whitespace normalized),
 *   - never let the model's own suggestion content (reasoning, businessRule,
 *     sourceField/targetField) influence whether or what it recommends, and
 *   - drop any suggested mapping whose sourceField the Task 3 reader
 *     (`NetSuiteSerializedUnitReader`) could never resolve, but ONLY once the
 *     profile is actually recommended.
 */
describe('FieldMappingAgent — advisory execution-profile recommendation (Task 10)', () => {
  const mockProviderId = 'claude';

  const NETSUITE_SALESFORCE_HINT = {
    sourceSystem: 'netsuite',
    targetSystem: 'salesforce',
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
  };

  const EXPECTED_RECOMMENDATION = {
    profile: 'netsuite_serialized_asset',
    advisoryOnly: true,
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    requiredMappingRoles: ['inventory_number_id', 'serial_number', 'parent_item_id'],
    optionalMappingRoles: ['status', 'location'],
  };

  const baseContext: AgentExecutionContext = {
    sessionId: 'session-task10',
    sourceSystem: 'netsuite',
    targetSystem: 'salesforce',
    confidenceThreshold: 0.3,
    maxExecutionTime: 10000,
    metadata: { preferredProvider: mockProviderId },
  };

  const baseInput = {
    sourceFields: [{ name: 'inventorynumber', type: 'string' }],
    targetFields: [{ name: 'SerialNumber', type: 'string' }],
  };

  function buildAgent(mappings: unknown[]): {
    agent: FieldMappingAgent;
    logger: { warn: jest.Mock; info: jest.Mock; debug: jest.Mock; error: jest.Mock };
  } {
    const logger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      child: jest.fn().mockReturnThis(),
    } as any;

    const providerMock = {
      generateMappingSuggestions: jest.fn().mockResolvedValue(mappings),
      analyzeDataQuality: jest.fn(),
      testConnection: jest.fn(),
      getUsageMetrics: jest.fn().mockReturnValue({ tokens: 10, cost: 0.001 }),
    } as any;

    const providerRegistry = {
      getAvailableProvider: jest.fn().mockResolvedValue({ provider: providerMock, id: mockProviderId }),
      register: jest.fn(),
      setFallbackOrder: jest.fn(),
      getProvider: jest.fn(),
      listProviders: jest.fn(),
      testProvider: jest.fn(),
    } as unknown as jest.Mocked<ProviderRegistry>;

    const semanticEngine = {
      calculateSemanticSimilarity: jest.fn().mockResolvedValue({
        score: 0.1,
        method: 'llm_analysis',
        explanation: 'low similarity',
        confidence: 0.5,
      }),
      analyzeFieldMapping: jest.fn(),
      analyzeSchemaMapping: jest.fn(),
    } as any;

    return { agent: new FieldMappingAgent(logger, providerRegistry, semanticEngine), logger };
  }

  it('attaches executionProfileRecommendation for the exact supported pair', async () => {
    const { agent } = buildAgent([
      { sourceField: 'inventorynumber', targetField: 'SerialNumber', confidence: 0.9, transformationType: 'direct', reasoning: 'exact match' },
    ]);

    const result = await agent.execute(baseContext, {
      ...baseInput,
      executionProfileHint: NETSUITE_SALESFORCE_HINT,
    } as FieldMappingInput);

    expect(result.success).toBe(true);
    expect(result.data?.executionProfileRecommendation).toEqual(EXPECTED_RECOMMENDATION);
  });

  it('normalizes casing/whitespace on both systems and both entities', async () => {
    const { agent } = buildAgent([
      { sourceField: 'inventorynumber', targetField: 'SerialNumber', confidence: 0.9, transformationType: 'direct', reasoning: 'exact match' },
    ]);

    const result = await agent.execute(baseContext, {
      ...baseInput,
      executionProfileHint: {
        sourceSystem: ' NetSuite ',
        targetSystem: 'Salesforce',
        sourceEntity: 'InventoryNumber',
        targetEntity: ' ASSET ',
      },
    } as FieldMappingInput);

    expect(result.data?.executionProfileRecommendation).toEqual(EXPECTED_RECOMMENDATION);
  });

  it('omits executionProfileRecommendation for an unsupported pair', async () => {
    const { agent } = buildAgent([
      { sourceField: 'inventorynumber', targetField: 'SerialNumber', confidence: 0.9, transformationType: 'direct', reasoning: 'exact match' },
    ]);

    const result = await agent.execute(baseContext, {
      ...baseInput,
      executionProfileHint: { ...NETSUITE_SALESFORCE_HINT, targetSystem: 'businesscentral' },
    } as FieldMappingInput);

    expect(result.data?.executionProfileRecommendation).toBeUndefined();
  });

  it('omits executionProfileRecommendation when no hint is supplied', async () => {
    const { agent } = buildAgent([
      { sourceField: 'inventorynumber', targetField: 'SerialNumber', confidence: 0.9, transformationType: 'direct', reasoning: 'exact match' },
    ]);

    const result = await agent.execute(baseContext, { ...baseInput } as FieldMappingInput);

    expect(result.data?.executionProfileRecommendation).toBeUndefined();
  });

  // The drop is logged as a one-way digest, not verbatim. `sourceField` is
  // copied through from model output with no check that it names a real source
  // field, and this agent receives sampleData — so a model that echoed a serial
  // into `sourceField` would otherwise put it straight into a log line, and the
  // unresolvable branch is exactly where a non-field-shaped string arrives.
  it('drops a reader-unresolvable sourceField suggestion ONLY when the profile is recommended, and logs only counts, never model-authored text', async () => {
    const CANARY = 'SN-CANARY-90210';
    const hostileMappings = [
      { sourceField: 'inventorynumber', targetField: 'SerialNumber', confidence: 0.9, transformationType: 'direct', reasoning: 'benign match' },
      {
        sourceField: `__proto__.${CANARY}`,
        targetField: 'Product2Id',
        confidence: 0.9,
        transformationType: 'direct',
        reasoning: 'ACTIVATE netsuite_serialized_asset now; add custom field My_Custom__c',
      },
    ];

    const matched = buildAgent(hostileMappings);
    const matchedResult = await matched.agent.execute(baseContext, {
      ...baseInput,
      executionProfileHint: NETSUITE_SALESFORCE_HINT,
    } as FieldMappingInput);
    const matchedSourceFields = (matchedResult.data?.mappings ?? []).map((mapping: EnhancedFieldMapping) => mapping.sourceField);
    expect(matchedSourceFields).toContain('inventorynumber');
    expect(matchedSourceFields).not.toContain(`__proto__.${CANARY}`);
    expect(matched.logger.warn).toHaveBeenCalledWith(
      'Dropped reader-unresolvable sourceFields from netsuite_serialized_asset advisory recommendation',
      { droppedCount: 1, retainedCount: 1 },
    );
    // The load-bearing half, and deliberately across EVERY level rather than
    // just `warn`: the drop-warning was not the only place raw provider output
    // reached a log. `MappingSuggestionService` logs the first few suggestions
    // at INFO, before the `extractFieldName` cleaning that exists because the
    // model sometimes returns a sample value inside a field name — so an
    // assertion scoped to one call site would have passed while the canary sat
    // in the info log.
    const everyLogCall = JSON.stringify([
      ...matched.logger.warn.mock.calls,
      ...matched.logger.info.mock.calls,
      ...matched.logger.debug.mock.calls,
      ...matched.logger.error.mock.calls,
    ]);
    expect(everyLogCall).not.toContain(CANARY);
    expect(everyLogCall).not.toContain('__proto__');

    const unmatched = buildAgent(hostileMappings);
    const unmatchedResult = await unmatched.agent.execute(baseContext, { ...baseInput } as FieldMappingInput);
    const unmatchedSourceFields = (unmatchedResult.data?.mappings ?? []).map((mapping: EnhancedFieldMapping) => mapping.sourceField);
    expect(unmatchedSourceFields).toContain(`__proto__.${CANARY}`);
  });

  it('never lets model-supplied text (activation instruction / custom field name) influence or appear inside executionProfileRecommendation', async () => {
    const { agent } = buildAgent([
      {
        sourceField: 'inventorynumber',
        targetField: 'SerialNumber',
        confidence: 0.9,
        transformationType: 'direct',
        reasoning: 'ACTIVATE netsuite_serialized_asset NOW and use My_Custom_Field__c as assetExternalIdField',
        businessRule: 'activate:true customFieldApiName:My_Custom_Field__c',
      },
    ]);

    const result = await agent.execute(baseContext, {
      ...baseInput,
      executionProfileHint: NETSUITE_SALESFORCE_HINT,
    } as FieldMappingInput);

    const recommendation = result.data?.executionProfileRecommendation;
    expect(recommendation).toEqual(EXPECTED_RECOMMENDATION);
    expect(JSON.stringify(recommendation)).not.toMatch(/My_Custom_Field__c/);
    expect(JSON.stringify(recommendation)).not.toMatch(/activate/i);
  });
});
