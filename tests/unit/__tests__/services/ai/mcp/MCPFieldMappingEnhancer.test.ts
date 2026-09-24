/**
 * MCPFieldMappingEnhancer Unit Tests
 * Phase 3: AI Enhancement Wrapper
 */

import { MCPFieldMappingEnhancer } from '../../../../../../src/services/ai/mcp/MCPFieldMappingEnhancer';
import type { MCPKnowledgeProvider, FieldContext } from '../../../../../../src/services/ai/mcp/MCPKnowledgeProvider';
import type { Logger } from '../../../../../../src/utils/Logger';
import type { MappingSuggestion } from '../../../../../../src/services/ai/orchestrator/agents/fieldMappingTypes';

// Mock runtime flags
jest.mock('../../../../../../src/config/runtimeFlags', () => ({
  isNetSuiteMCPAIContextEnabled: jest.fn()
}));

import { isNetSuiteMCPAIContextEnabled } from '../../../../../../src/config/runtimeFlags';

describe('MCPFieldMappingEnhancer', () => {
  let enhancer: MCPFieldMappingEnhancer;
  let mockMCPKnowledge: jest.Mocked<MCPKnowledgeProvider>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    } as any;

    // Mock MCP knowledge provider
    mockMCPKnowledge = {
      getFieldContext: jest.fn(),
      enrichAIPrompt: jest.fn(),
      initialize: jest.fn().mockResolvedValue(undefined),
      clearCache: jest.fn(),
      getCacheStats: jest.fn()
    } as any;

    enhancer = new MCPFieldMappingEnhancer(mockMCPKnowledge, mockLogger);

    // Default: feature flag enabled
    (isNetSuiteMCPAIContextEnabled as jest.Mock).mockReturnValue(true);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await enhancer.initialize();

      expect(mockMCPKnowledge.initialize).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith('MCP field mapping enhancer initialized');
    });

    it('should only initialize once', async () => {
      await enhancer.initialize();
      await enhancer.initialize();
      await enhancer.initialize();

      expect(mockMCPKnowledge.initialize).toHaveBeenCalledTimes(1);
    });
  });

  describe('enhanceSuggestions', () => {
    beforeEach(async () => {
      await enhancer.initialize();
    });

    describe('feature flag disabled', () => {
      beforeEach(() => {
        (isNetSuiteMCPAIContextEnabled as jest.Mock).mockReturnValue(false);
      });

      it('should return original suggestions when feature flag disabled', async () => {
        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'companyName',
            confidence: 0.8,
            reasoning: ['Name match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'heuristic'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        expect(result).toEqual({
          enhancedSuggestions: suggestions,
          accuracyImprovement: 0,
          contextUsed: false,
          source: 'none'
        });

        expect(mockMCPKnowledge.getFieldContext).not.toHaveBeenCalled();
      });
    });

    describe('non-NetSuite target system', () => {
      it('should skip enhancement for non-NetSuite systems', async () => {
        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'accountName',
            confidence: 0.8,
            reasoning: ['Name match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'heuristic'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'Salesforce'
        });

        expect(result).toEqual({
          enhancedSuggestions: suggestions,
          accuracyImprovement: 0,
          contextUsed: false,
          source: 'none'
        });

        expect(mockMCPKnowledge.getFieldContext).not.toHaveBeenCalled();
      });
    });

    describe('NetSuite enhancement', () => {
      it('should enhance suggestions with +5% boost for common mapping match', async () => {
        const mockContext: FieldContext = {
          field: 'companyName',
          entity: 'customer',
          description: 'Company Name',
          dataType: 'string',
          constraints: ['required', 'maxLength: 83'],
          commonMappings: ['Name', 'CompanyName', 'AccountName'],
          bestPractices: ['Use legal name'],
          relatedFields: ['email', 'phone'],
          metadata: { required: true, maxLength: 83 }
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name', // Exact match with common mappings
            targetField: 'companyName',
            confidence: 0.8,
            reasoning: ['Field name match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        expect(result.enhancedSuggestions[0].confidence).toBeCloseTo(0.9, 1); // 0.8 + 0.05 (common) + 0.02 (required) + 0.03 (direct)
        expect(result.enhancedSuggestions[0].reasoning).toContain('MCP Context: Company Name (required, maxLength: 83)');
        expect(result.accuracyImprovement).toBeGreaterThan(0);
        expect(result.contextUsed).toBe(true);
        expect(result.source).toBe('mcp');
      });

      it('should enhance suggestions with +2% boost for required field match', async () => {
        const mockContext: FieldContext = {
          field: 'email',
          entity: 'customer',
          description: 'Email Address',
          dataType: 'string',
          constraints: ['required'],
          commonMappings: ['Email', 'EmailAddress'],
          bestPractices: ['Validate format'],
          relatedFields: [],
          metadata: { required: true }
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'ContactEmail',
            targetField: 'email',
            confidence: 0.75, // > 0.7 threshold
            reasoning: ['Semantic match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.75, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'email' }]
        });

        expect(result.enhancedSuggestions[0].confidence).toBeCloseTo(0.77, 1); // 0.75 + 0.02 (with tolerance)
      });

      it('should enhance suggestions with +3% boost for direct type match', async () => {
        const mockContext: FieldContext = {
          field: 'phone',
          entity: 'customer',
          description: 'Phone Number',
          dataType: 'string',
          constraints: [],
          commonMappings: ['Phone', 'PhoneNumber'],
          bestPractices: [],
          relatedFields: [],
          metadata: {}
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'PhoneNumber',
            targetField: 'phone',
            confidence: 0.7,
            reasoning: ['Type compatible'],
            transformation: { type: 'direct', rules: [] }, // Direct transformation
            alternatives: [],
            qualityMetrics: { score: 0.7, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'phone' }]
        });

        expect(result.enhancedSuggestions[0].confidence).toBeCloseTo(0.73, 1); // 0.7 + 0.03 (with tolerance)
      });

      it('should apply cumulative boosts (+10% max)', async () => {
        const mockContext: FieldContext = {
          field: 'companyName',
          entity: 'customer',
          description: 'Company Name',
          dataType: 'string',
          constraints: ['required', 'maxLength: 83'],
          commonMappings: ['Name', 'CompanyName', 'AccountName'],
          bestPractices: ['Use legal name'],
          relatedFields: ['email'],
          metadata: { required: true, maxLength: 83 }
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name', // +5% (common mapping match)
            targetField: 'companyName',
            confidence: 0.75, // +2% (required field, confidence > 0.7)
            reasoning: ['Perfect match'],
            transformation: { type: 'direct', rules: [] }, // +3% (direct type match)
            alternatives: [],
            qualityMetrics: { score: 0.75, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        // All three boosts applied: 0.75 + 0.05 + 0.02 + 0.03 = 0.85
        expect(result.enhancedSuggestions[0].confidence).toBeCloseTo(0.85, 1);
        expect(result.accuracyImprovement).toBeCloseTo(10, 1); // ~10% improvement
      });

      it('should cap confidence at 0.99', async () => {
        const mockContext: FieldContext = {
          field: 'companyName',
          entity: 'customer',
          description: 'Company Name',
          dataType: 'string',
          constraints: ['required'],
          commonMappings: ['Name', 'CompanyName'],
          bestPractices: [],
          relatedFields: [],
          metadata: { required: true }
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'companyName',
            confidence: 0.96, // Would go to 1.03 with boosts
            reasoning: ['Near perfect'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.96, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        expect(result.enhancedSuggestions[0].confidence).toBe(0.99); // Capped at 0.99
      });

      it('should add MCP context to reasoning array', async () => {
        const mockContext: FieldContext = {
          field: 'companyName',
          entity: 'customer',
          description: 'Company Name',
          dataType: 'string',
          constraints: ['required', 'maxLength: 83'],
          commonMappings: ['Name'],
          bestPractices: [],
          relatedFields: [],
          metadata: { required: true, maxLength: 83 }
        };

        mockMCPKnowledge.getFieldContext.mockResolvedValue(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'companyName',
            confidence: 0.8,
            reasoning: ['Original reason 1', 'Original reason 2'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        const reasoning = result.enhancedSuggestions[0].reasoning;
        expect(reasoning).toHaveLength(3); // Original 2 + 1 MCP context
        expect(reasoning[0]).toBe('Original reason 1');
        expect(reasoning[1]).toBe('Original reason 2');
        expect(reasoning[2]).toContain('MCP Context: Company Name');
        expect(reasoning[2]).toContain('required, maxLength: 83');
      });

      it('should handle multiple suggestions', async () => {
        const mockContext1: FieldContext = {
          field: 'companyName',
          entity: 'customer',
          description: 'Company Name',
          dataType: 'string',
          constraints: ['required'],
          commonMappings: ['Name', 'CompanyName'],
          bestPractices: [],
          relatedFields: [],
          metadata: { required: true }
        };

        const mockContext2: FieldContext = {
          field: 'email',
          entity: 'customer',
          description: 'Email',
          dataType: 'string',
          constraints: [],
          commonMappings: ['Email', 'EmailAddress'],
          bestPractices: [],
          relatedFields: [],
          metadata: {}
        };

        mockMCPKnowledge.getFieldContext
          .mockResolvedValueOnce(mockContext1)
          .mockResolvedValueOnce(mockContext2);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'companyName',
            confidence: 0.8,
            reasoning: ['Match 1'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'llm'
          },
          {
            sourceField: 'Email',
            targetField: 'email',
            confidence: 0.75,
            reasoning: ['Match 2'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.75, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }, { name: 'email' }]
        });

        expect(result.enhancedSuggestions).toHaveLength(2);
        expect(result.enhancedSuggestions[0].confidence).toBeGreaterThan(0.8);
        expect(result.enhancedSuggestions[1].confidence).toBeGreaterThan(0.75);
        expect(result.contextUsed).toBe(true);
      });
    });

    describe('error handling', () => {
      it('should fallback to original suggestions on MCP error', async () => {
        mockMCPKnowledge.getFieldContext.mockRejectedValue(new Error('MCP connection failed'));

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Name',
            targetField: 'companyName',
            confidence: 0.8,
            reasoning: ['Match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'companyName' }]
        });

        expect(result).toEqual({
          enhancedSuggestions: suggestions,
          accuracyImprovement: 0,
          contextUsed: false,
          source: 'fallback'
        });

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'All MCP enhancement attempts failed, falling back to original suggestions'
        );
      });

      it('should handle individual suggestion failures gracefully', async () => {
        const mockContext: FieldContext = {
          field: 'email',
          entity: 'customer',
          description: 'Email',
          dataType: 'string',
          constraints: [],
          commonMappings: ['Email'],
          bestPractices: [],
          relatedFields: [],
          metadata: {}
        };

        // First call fails, second succeeds
        mockMCPKnowledge.getFieldContext
          .mockRejectedValueOnce(new Error('Field not found'))
          .mockResolvedValueOnce(mockContext);

        const suggestions: MappingSuggestion[] = [
          {
            sourceField: 'Unknown',
            targetField: 'unknownField',
            confidence: 0.5,
            reasoning: ['Low confidence'],
            transformation: { type: 'custom', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.5, issues: [] },
            origin: 'heuristic'
          },
          {
            sourceField: 'Email',
            targetField: 'email',
            confidence: 0.8,
            reasoning: ['Good match'],
            transformation: { type: 'direct', rules: [] },
            alternatives: [],
            qualityMetrics: { score: 0.8, issues: [] },
            origin: 'llm'
          }
        ];

        const result = await enhancer.enhanceSuggestions(suggestions, {
          targetSystem: 'NetSuite',
          targetFields: [{ name: 'unknownField' }, { name: 'email' }]
        });

        // First suggestion unchanged, second enhanced
        expect(result.enhancedSuggestions[0].confidence).toBe(0.5); // Unchanged
        expect(result.enhancedSuggestions[1].confidence).toBeGreaterThan(0.8); // Enhanced

        expect(mockLogger.warn).toHaveBeenCalledWith(
          'Failed to enhance suggestion with MCP context',
          expect.objectContaining({
            sourceField: 'Unknown',
            targetField: 'unknownField'
          })
        );
      });
    });
  });
});
