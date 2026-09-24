/**
 * MCPKnowledgeProvider Unit Tests
 * Phase 3: AI Context Enrichment
 */

import { MCPKnowledgeProvider } from '../../../../../../src/services/ai/mcp/MCPKnowledgeProvider';
import type { NetSuiteMCPSchemaAdapter } from '../../../../../../src/services/netsuite/mcp/NetSuiteMCPSchemaAdapter';
import type { Logger } from '../../../../../../src/utils/Logger';
import type { SystemSchema, FieldDefinition } from '../../../../../../src/services/ai/validation/types';

describe('MCPKnowledgeProvider', () => {
  let provider: MCPKnowledgeProvider;
  let mockMCPAdapter: jest.Mocked<NetSuiteMCPSchemaAdapter>;
  let mockLogger: jest.Mocked<Logger>;

  beforeEach(() => {
    // Mock logger
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    } as any;

    // Mock MCP adapter
    mockMCPAdapter = {
      getSchema: jest.fn(),
      initialize: jest.fn().mockResolvedValue(undefined),
      clearCache: jest.fn(),
      getCacheStats: jest.fn(),
      getHealthStatus: jest.fn()
    } as any;

    provider = new MCPKnowledgeProvider(mockMCPAdapter, mockLogger);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await provider.initialize();

      expect(mockLogger.info).toHaveBeenCalledWith(
        'Initializing MCP knowledge provider',
        expect.objectContaining({
          cacheEnabled: true
        })
      );
    });

    it('should only initialize once', async () => {
      await provider.initialize();
      await provider.initialize();
      await provider.initialize();

      // Second and third calls should log warning
      expect(mockLogger.warn).toHaveBeenCalledWith('MCP knowledge provider already initialized');
      expect(mockLogger.warn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getFieldContext', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it('should fetch field context successfully', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'companyName',
            type: 'string',
            description: 'Company Name',
            required: true,
            maxLength: 83
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'companyName');

      expect(context).toEqual({
        field: 'companyName',
        entity: 'customer',
        description: 'Company Name',
        dataType: 'string',
        constraints: ['required', 'maxLength: 83'],
        commonMappings: expect.arrayContaining(['Name', 'CompanyName', 'AccountName']),
        bestPractices: expect.arrayContaining([
          'This field is required - ensure source data has a value',
          'Truncate if source exceeds 83 characters'
        ]),
        relatedFields: expect.any(Array),
        metadata: {
          required: true,
          maxLength: 83
        }
      });

      expect(mockMCPAdapter.getSchema).toHaveBeenCalledWith('customer');
    });

    it('should handle field not found with default context', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'nonexistent');

      // Should return default context instead of throwing
      expect(context).toEqual({
        field: 'nonexistent',
        entity: 'customer',
        description: 'nonexistent',
        dataType: 'string',
        constraints: [],
        commonMappings: ['nonexistent'],
        bestPractices: [],
        relatedFields: [],
        metadata: {
          required: false
        }
      });

      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Field not found in schema',
        expect.objectContaining({ entity: 'customer', field: 'nonexistent' })
      );
    });

    it('should infer common mappings for email fields', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'email',
            type: 'string',
            description: 'Email Address',
            required: false
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'email');

      expect(context.commonMappings).toEqual(
        expect.arrayContaining(['Email', 'EmailAddress', 'E-mail', 'ContactEmail'])
      );
    });

    it('should infer common mappings for phone fields', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'phone',
            type: 'string',
            description: 'Phone Number',
            required: false
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'phone');

      expect(context.commonMappings).toEqual(
        expect.arrayContaining(['Phone', 'PhoneNumber', 'Telephone', 'ContactPhone'])
      );
    });

    it('should generate best practices for required fields', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'testField',
            type: 'string',
            description: 'Test Field',
            required: true
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'testField');

      expect(context.bestPractices).toContain(
        'This field is required - ensure source data has a value'
      );
    });

    it('should generate best practices for email format', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'email',
            type: 'string',
            description: 'Email',
            required: false,
            format: 'email'
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'email');

      expect(context.bestPractices).toContain(
        'Validate email format before mapping'
      );
    });

    it('should generate best practices for max length', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'testField',
            type: 'string',
            description: 'Test Field',
            required: false,
            maxLength: 50 // Must be < 100 to generate truncate message
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'testField');

      expect(context.bestPractices).toContain(
        'Truncate if source exceeds 50 characters'
      );
    });

    it('should find related fields', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          { name: 'companyName', type: 'string', description: 'Company', required: true } as FieldDefinition,
          { name: 'email', type: 'string', description: 'Email', required: false } as FieldDefinition,
          { name: 'phone', type: 'string', description: 'Phone', required: false } as FieldDefinition,
          { name: 'subsidiary', type: 'string', description: 'Subsidiary', required: false } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const context = await provider.getFieldContext('customer', 'companyName');

      expect(context.relatedFields).toEqual(
        expect.arrayContaining(['email', 'phone', 'subsidiary'])
      );
    });
  });

  describe('enrichAIPrompt', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it('should enrich AI prompt with field context', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'companyName',
            type: 'string',
            description: 'Company Name',
            required: true,
            maxLength: 83
          } as FieldDefinition,
          {
            name: 'email',
            type: 'string',
            description: 'Email',
            required: false
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      const basePrompt = 'Map the following fields:';
      const enrichedPrompt = await provider.enrichAIPrompt(basePrompt, 'customer', 'companyName');

      expect(enrichedPrompt).toContain('Map the following fields:');
      expect(enrichedPrompt).toContain('**NetSuite Field Context** (from MCP):');
      expect(enrichedPrompt).toContain('**Field**: companyName (string)');
      expect(enrichedPrompt).toContain('**Description**: Company Name');
      expect(enrichedPrompt).toContain('**Constraints**: required, maxLength: 83');
      expect(enrichedPrompt).toContain('**Common Source Fields**:');
      expect(enrichedPrompt).toContain('**Best Practices**:');
      // Related fields section included by default (when fields exist)
      if (mockSchema.fields.length > 1) {
        expect(enrichedPrompt).toContain('**Related Fields**:');
      }
    });

    it('should handle MCP fetch errors gracefully with default context', async () => {
      mockMCPAdapter.getSchema.mockRejectedValue(new Error('MCP connection failed'));

      const basePrompt = 'Map the following fields:';
      const enrichedPrompt = await provider.enrichAIPrompt(basePrompt, 'customer', 'companyName');

      // Should return enriched prompt with default context (not base prompt unchanged)
      expect(enrichedPrompt).toContain('Map the following fields:');
      expect(enrichedPrompt).toContain('**NetSuite Field Context** (from MCP):');
      expect(enrichedPrompt).toContain('**Field**: companyName (string)');
      expect(enrichedPrompt).toContain('**Description**: companyName');

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to fetch field context from MCP',
        expect.objectContaining({
          entity: 'customer',
          field: 'companyName'
        })
      );
    });
  });

  describe('caching', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it('should cache field context for 1 hour', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'companyName',
            type: 'string',
            description: 'Company Name',
            required: true
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      // First call - should fetch from MCP
      await provider.getFieldContext('customer', 'companyName');
      expect(mockMCPAdapter.getSchema).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      await provider.getFieldContext('customer', 'companyName');
      expect(mockMCPAdapter.getSchema).toHaveBeenCalledTimes(1); // Still 1, not 2

      // Third call - should still use cache
      await provider.getFieldContext('customer', 'companyName');
      expect(mockMCPAdapter.getSchema).toHaveBeenCalledTimes(1);
    });

    it('should clear cache', async () => {
      const mockSchema: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'companyName',
            type: 'string',
            description: 'Company Name',
            required: true
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      mockMCPAdapter.getSchema.mockResolvedValue(mockSchema);

      // First call - fetch from MCP
      await provider.getFieldContext('customer', 'companyName');
      expect(mockMCPAdapter.getSchema).toHaveBeenCalledTimes(1);

      // Clear cache
      provider.clearCache();

      // Second call - should fetch again
      await provider.getFieldContext('customer', 'companyName');
      expect(mockMCPAdapter.getSchema).toHaveBeenCalledTimes(2);
    });

    it('should provide cache stats', async () => {
      const mockSchema1: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'companyName',
            type: 'string',
            description: 'Company Name',
            required: true
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      const mockSchema2: SystemSchema = {
        systemName: 'NetSuite',
        fields: [
          {
            name: 'email',
            type: 'string',
            description: 'Email',
            required: false
          } as FieldDefinition
        ],
        relationships: [],
        constraints: [],
        customFields: []
      };

      // Mock different responses for each entity:field combo
      mockMCPAdapter.getSchema
        .mockResolvedValueOnce(mockSchema1) // First call: customer:companyName
        .mockResolvedValueOnce(mockSchema2); // Second call: customer:email

      // Add two different entries to cache
      await provider.getFieldContext('customer', 'companyName');
      await provider.getFieldContext('customer', 'email');

      const stats = provider.getCacheStats();

      expect(stats.size).toBeGreaterThanOrEqual(1); // At least one entry cached
      expect(stats.entries.length).toBeGreaterThanOrEqual(1);
      expect(stats.entries.map(e => e.key)).toContain('customer:companyName');
    });
  });

  describe('error handling', () => {
    beforeEach(async () => {
      await provider.initialize();
    });

    it('should throw error when not initialized', async () => {
      const uninitializedProvider = new MCPKnowledgeProvider(mockMCPAdapter, mockLogger);

      await expect(uninitializedProvider.getFieldContext('customer', 'companyName'))
        .rejects.toThrow('MCP knowledge provider not initialized');
    });

    it('should handle MCP adapter errors with default context', async () => {
      mockMCPAdapter.getSchema.mockRejectedValue(new Error('Network timeout'));

      const context = await provider.getFieldContext('customer', 'companyName');

      // Should return default context instead of throwing
      expect(context).toEqual({
        field: 'companyName',
        entity: 'customer',
        description: 'companyName',
        dataType: 'string',
        constraints: [],
        commonMappings: ['companyName'],
        bestPractices: [],
        relatedFields: [],
        metadata: {
          required: false
        }
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to fetch field context from MCP',
        expect.objectContaining({
          entity: 'customer',
          field: 'companyName',
          error: 'Network timeout'
        })
      );
    });
  });
});
