/**
 * Comprehensive unit tests for SecureAIService
 * Covers: initialize, generateMappingSuggestions, analyzeDataQuality,
 *         testProviders, getAvailableProviders, callProvider, supportsEmbeddings,
 *         loadConfiguration, validateRequest
 */
import 'reflect-metadata';
import { SecureAIService } from '../../../../src/services/ai/SecureAIService';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockProvider = {
  generateMappingSuggestions: jest.fn().mockResolvedValue([
    { sourceField: 'name', targetField: 'Name', confidence: 0.9, reasoning: 'direct match' },
  ]),
  analyzeDataQuality: jest.fn().mockResolvedValue({
    overallScore: 0.85,
    issues: [],
    recommendations: [],
  }),
  testConnection: jest.fn().mockResolvedValue({ ok: true }),
};

const mockProviderMap = new Map([['mock-provider', mockProvider]]);

const mockRegistry = {
  getAvailableProvider: jest.fn().mockResolvedValue({ provider: mockProvider, id: 'mock-provider' }),
  listProviders: jest.fn().mockReturnValue([
    { id: 'mock-provider', name: 'Mock Provider', version: '1.0' },
  ]),
  register: jest.fn(),
  setFallbackOrder: jest.fn(),
  providers: mockProviderMap,
} as any;

const mockOutboundGovernance = {
  validateAIProviderRequest: jest.fn(),
} as any;

// Clear env vars that affect config loading
const originalEnv = { ...process.env };

describe('SecureAIService', () => {
  let service: SecureAIService;

  beforeEach(() => {
    jest.clearAllMocks();
    // Ensure no real API keys are loaded
    delete process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.LMSTUDIO_BASE_URL;
    service = new SecureAIService(mockLogger, mockRegistry, mockOutboundGovernance);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith(
        'SecureAIService initialized successfully',
        expect.objectContaining({ providersConfigured: expect.any(Number) })
      );
    });

    it('should be idempotent', async () => {
      await service.initialize();
      await service.initialize();
      // Second call should skip setup
      const initCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'SecureAIService initialized successfully'
      );
      expect(initCalls.length).toBe(1);
    });
  });

  describe('generateMappingSuggestions', () => {
    it('should generate suggestions successfully', async () => {
      const response = await service.generateMappingSuggestions({
        operation: 'mapping',
        context: {
          sourceSystem: 'salesforce',
          targetSystem: 'netsuite',
          sourceFields: [{ name: 'Name', type: 'string' }],
          targetFields: [{ name: 'companyname', type: 'string' }],
        },
      });
      expect(response.success).toBe(true);
      expect(response.providerId).toBe('mock-provider');
      expect(response.data).toBeDefined();
      expect(response.metadata.responseTime).toBeGreaterThanOrEqual(0);
      expect(response.metadata.requestId).toMatch(/^ai_/);
    });

    it('should reject invalid operation', async () => {
      const response = await service.generateMappingSuggestions({
        operation: 'quality' as any,
        context: { sourceSystem: 'a', targetSystem: 'b', sourceFields: [], targetFields: [] },
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid operation');
    });

    it('should reject missing context', async () => {
      const response = await service.generateMappingSuggestions({
        operation: 'mapping',
        context: undefined as any,
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('context is required');
    });

    it('should handle no available provider', async () => {
      mockRegistry.getAvailableProvider.mockResolvedValueOnce(null);
      const response = await service.generateMappingSuggestions({
        operation: 'mapping',
        context: { sourceSystem: 'a', targetSystem: 'b', sourceFields: [], targetFields: [] },
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('No AI providers available');
    });

    it('should use specific provider when requested', async () => {
      await service.generateMappingSuggestions({
        operation: 'mapping',
        providerId: 'claude',
        context: { sourceSystem: 'a', targetSystem: 'b', sourceFields: [], targetFields: [] },
      });
      expect(mockRegistry.getAvailableProvider).toHaveBeenCalledWith('claude');
    });

    it('should audit successful usage', async () => {
      await service.generateMappingSuggestions({
        operation: 'mapping',
        userId: 'user-123',
        context: { sourceSystem: 'a', targetSystem: 'b', sourceFields: [], targetFields: [] },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI usage audit',
        expect.objectContaining({
          userId: 'user-123',
          operation: 'mapping',
          success: true,
        })
      );
    });

    it('should audit failed usage', async () => {
      mockRegistry.getAvailableProvider.mockResolvedValueOnce(null);
      await service.generateMappingSuggestions({
        operation: 'mapping',
        context: { sourceSystem: 'a', targetSystem: 'b', sourceFields: [], targetFields: [] },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI usage audit',
        expect.objectContaining({ success: false })
      );
    });
  });

  describe('analyzeDataQuality', () => {
    it('should analyze data quality successfully', async () => {
      const response = await service.analyzeDataQuality({
        operation: 'quality',
        context: { sourceSystem: 'a', targetSystem: 'b' } as any,
        data: [{ name: 'test' }],
      });
      expect(response.success).toBe(true);
      expect(response.data).toBeDefined();
    });

    it('should reject when data array is empty', async () => {
      const response = await service.analyzeDataQuality({
        operation: 'quality',
        context: { sourceSystem: 'a' } as any,
        data: [],
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('Data array is required');
    });

    it('should reject invalid operation', async () => {
      const response = await service.analyzeDataQuality({
        operation: 'mapping' as any,
        context: { sourceSystem: 'a' } as any,
        data: [{ name: 'test' }],
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('Invalid operation');
    });

    it('should handle provider failure gracefully', async () => {
      mockProvider.analyzeDataQuality.mockRejectedValueOnce(new Error('Provider down'));
      const response = await service.analyzeDataQuality({
        operation: 'quality',
        context: { sourceSystem: 'a' } as any,
        data: [{ name: 'test' }],
      });
      expect(response.success).toBe(false);
      expect(response.error).toContain('Provider down');
    });
  });

  describe('testProviders', () => {
    it('should return test results for all providers', async () => {
      const results = await service.testProviders();
      expect(results['mock-provider']).toEqual({ ok: true });
    });

    it('should handle provider test failure', async () => {
      mockProvider.testConnection.mockRejectedValueOnce(new Error('Connection refused'));
      const results = await service.testProviders();
      expect(results['mock-provider'].ok).toBe(false);
      expect(results['mock-provider'].message).toContain('Connection refused');
    });
  });

  describe('getAvailableProviders', () => {
    it('should return provider list', () => {
      const providers = service.getAvailableProviders();
      expect(providers).toEqual([
        { id: 'mock-provider', name: 'Mock Provider', version: '1.0' },
      ]);
    });
  });

  describe('callProvider', () => {
    it('should handle provider with generateCompletion', async () => {
      const completionProvider = {
        ...mockProvider,
        generateCompletion: jest.fn().mockResolvedValue({
          content: 'Generated response',
          tokensUsed: { prompt: 10, completion: 20, total: 30 },
          cost: 0.001,
        }),
      };
      mockRegistry.getAvailableProvider.mockResolvedValueOnce({
        provider: completionProvider, id: 'completion-provider',
      });

      const result = await service.callProvider({
        messages: [
          { role: 'system', content: 'You are helpful' },
          { role: 'user', content: 'Hello' },
        ],
        temperature: 0.7,
        maxTokens: 100,
      });

      expect(result.content).toBe('Generated response');
      expect(result.provider).toBe('completion-provider');
      expect(result.tokensUsed?.total).toBe(30);
    });

    it('should fallback to mapping method for basic providers', async () => {
      // Provider has no generateCompletion and no callLMStudio
      const basicProvider = {
        generateMappingSuggestions: jest.fn().mockResolvedValue([{ field: 'test' }]),
        analyzeDataQuality: jest.fn(),
        testConnection: jest.fn(),
      };
      mockRegistry.getAvailableProvider.mockResolvedValueOnce({
        provider: basicProvider, id: 'basic-provider',
      });

      const result = await service.callProvider({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.5,
        maxTokens: 100,
      });

      expect(result.content).toBeDefined();
      expect(result.provider).toBe('basic-provider');
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Provider does not support direct completion, using fallback method',
        expect.any(Object)
      );
    });

    it('should throw when no provider available', async () => {
      mockRegistry.getAvailableProvider.mockResolvedValueOnce(null);
      await expect(service.callProvider({
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.5,
        maxTokens: 100,
      })).rejects.toThrow('AI provider call failed');
    });

    it('should handle LMStudio provider', async () => {
      const lmProvider = {
        callLMStudio: jest.fn().mockResolvedValue({
          choices: [{ message: { content: 'LM response' } }],
          usage: { prompt_tokens: 5, completion_tokens: 10, total_tokens: 15 },
        }),
        generateMappingSuggestions: jest.fn(),
        analyzeDataQuality: jest.fn(),
        testConnection: jest.fn(),
      };
      mockRegistry.getAvailableProvider.mockResolvedValueOnce({
        provider: lmProvider, id: 'lmstudio',
      });

      const result = await service.callProvider({
        messages: [
          { role: 'system', content: 'System prompt' },
          { role: 'assistant', content: 'Previous response' },
          { role: 'user', content: 'Follow up' },
        ],
        temperature: 0.3,
        maxTokens: 200,
      });

      expect(result.content).toBe('LM response');
      expect(result.provider).toBe('lmstudio');
      expect(result.cost).toBe(0);
      expect(result.tokensUsed?.total).toBe(15);
    });

    it('should audit usage on success', async () => {
      const completionProvider = {
        ...mockProvider,
        generateCompletion: jest.fn().mockResolvedValue({ content: 'ok' }),
      };
      mockRegistry.getAvailableProvider.mockResolvedValueOnce({
        provider: completionProvider, id: 'audit-provider',
      });

      await service.callProvider({
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.5,
        maxTokens: 100,
      });

      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI usage audit',
        expect.objectContaining({
          operation: 'raw_completion',
          success: true,
        })
      );
    });

    it('should resolve claude runtime id back to anthropic config for model lookup', async () => {
      process.env.ANTHROPIC_API_KEY = 'test-key';
      process.env.ANTHROPIC_MODEL = 'claude-3-5-sonnet-20241022';
      const svcWithClaude = new SecureAIService(mockLogger, mockRegistry, mockOutboundGovernance);
      const completionProvider = {
        ...mockProvider,
        generateCompletion: jest.fn().mockResolvedValue({ content: 'ok' }),
      };
      mockRegistry.getAvailableProvider.mockResolvedValueOnce({
        provider: completionProvider, id: 'claude',
      });

      const result = await svcWithClaude.callProvider({
        messages: [{ role: 'user', content: 'Test' }],
        temperature: 0.5,
        maxTokens: 100,
      });

      expect(result.provider).toBe('claude');
      expect(result.model).toBe('claude-3-5-sonnet-20241022');
    });
  });

  describe('supportsEmbeddings', () => {
    it('should return false when no embedding-capable providers', () => {
      mockRegistry.listProviders.mockReturnValueOnce([
        { id: 'claude', name: 'Claude', version: '1.0' },
      ]);
      expect(service.supportsEmbeddings()).toBe(false);
    });

    it('should return true when openai is enabled', () => {
      // Need to recreate service with OPENAI_API_KEY set
      process.env.OPENAI_API_KEY = 'test-key';
      const svcWithOpenAI = new SecureAIService(mockLogger, mockRegistry, mockOutboundGovernance);
      mockRegistry.listProviders.mockReturnValueOnce([
        { id: 'openai', name: 'OpenAI', version: '1.0' },
      ]);
      expect(svcWithOpenAI.supportsEmbeddings()).toBe(true);
    });

    it('should return false for lmstudio without embedding support', () => {
      mockRegistry.listProviders.mockReturnValueOnce([
        { id: 'lmstudio', name: 'LMStudio', version: '1.0' },
      ]);
      expect(service.supportsEmbeddings()).toBe(false);
    });
  });
});
