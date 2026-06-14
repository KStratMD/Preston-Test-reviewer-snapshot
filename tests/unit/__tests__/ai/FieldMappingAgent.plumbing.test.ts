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
