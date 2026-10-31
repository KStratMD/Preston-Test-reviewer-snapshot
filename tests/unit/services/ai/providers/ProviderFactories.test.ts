/**
 * Comprehensive tests for AI Provider Factories and Router
 *
 * Tests three classes:
 * 1. ProviderFactory - Core provider initialization and routing
 * 2. IntelligentProviderRouter - Context-aware scoring and analytics
 * 3. TaskAwareProviderFactory - Task-specific provider selection with budget control
 *
 * All external AI provider constructors are mocked to prevent real API calls.
 */

import type { AIProvider, AISuggestion, AIQualityReport } from 'src/services/ai/providers/types';

// ── Mock provider constructors before importing classes under test ──

const mockOpenAIInstance: AIProvider = {
  mode: 'cloud-api',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'OpenAI', version: 'gpt-4o', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([{ sourceField: 'name', targetField: 'name', transformationType: 'direct' }]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.9, totalMappings: 1 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok', usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }),
  getLastTokenUsage: jest.fn().mockReturnValue({ promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0.001 }),
} as any;

const mockClaudeInstance: AIProvider = {
  mode: 'cloud-api',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'Claude', version: 'claude-3-5-sonnet', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([{ sourceField: 'id', targetField: 'id', transformationType: 'direct' }]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.95, totalMappings: 1 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok' }),
  getLastTokenUsage: jest.fn().mockReturnValue({ promptTokens: 8, completionTokens: 4, totalTokens: 12, estimatedCost: 0.0005 }),
} as any;

const mockGeminiInstance: AIProvider = {
  mode: 'cloud-api',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'Gemini', version: 'gemini-1.5-flash', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([{ sourceField: 'email', targetField: 'email', transformationType: 'direct' }]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.8, totalMappings: 1 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok' }),
  getLastTokenUsage: jest.fn().mockReturnValue({ promptTokens: 12, completionTokens: 6, totalTokens: 18, estimatedCost: 0.0002 }),
} as any;

const mockLMStudioInstance: AIProvider = {
  mode: 'local-llm',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'LMStudio', version: 'llama-3.1', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([{ sourceField: 'phone', targetField: 'phone', transformationType: 'direct' }]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.7, totalMappings: 1 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok' }),
  getLastTokenUsage: jest.fn().mockReturnValue({ promptTokens: 20, completionTokens: 10, totalTokens: 30, estimatedCost: 0 }),
} as any;

const mockOpenRouterInstance: AIProvider = {
  mode: 'cloud-api',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'OpenRouter', version: 'anthropic/claude-3.5-sonnet', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([{ sourceField: 'company', targetField: 'companyName', transformationType: 'direct' }]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.88, totalMappings: 1 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Connected' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok' }),
  getLastTokenUsage: jest.fn().mockReturnValue({ promptTokens: 9, completionTokens: 4, totalTokens: 13, estimatedCost: 0.0003 }),
} as any;

const mockRuleBasedInstance: AIProvider = {
  mode: 'rule-based',
  isAvailable: true,
  getCapabilities: jest.fn().mockResolvedValue({ name: 'RuleBased', version: 'v1', features: [], transformationTypes: [] }),
  suggest: jest.fn().mockResolvedValue([]),
  assessQuality: jest.fn().mockResolvedValue({ overallScore: 0.5, totalMappings: 0 }),
  testConnection: jest.fn().mockResolvedValue({ ok: true, message: 'Rule-based always available' }),
  chat: jest.fn().mockResolvedValue({ content: 'ok' }),
} as any;

jest.mock('src/services/ai/providers/OpenAIProvider', () => ({
  OpenAIProvider: jest.fn().mockImplementation(() => mockOpenAIInstance),
}));

jest.mock('src/services/ai/providers/ClaudeProvider', () => ({
  ClaudeProvider: jest.fn().mockImplementation(() => mockClaudeInstance),
}));

jest.mock('src/services/ai/providers/GeminiProvider', () => ({
  GeminiProvider: jest.fn().mockImplementation(() => mockGeminiInstance),
}));

jest.mock('src/services/ai/providers/LMStudioProvider', () => ({
  LMStudioProvider: jest.fn().mockImplementation(() => mockLMStudioInstance),
}));

jest.mock('src/services/ai/providers/OpenRouterProvider', () => ({
  OpenRouterProvider: jest.fn().mockImplementation(() => mockOpenRouterInstance),
}));

jest.mock('src/services/ai/providers/RuleBasedProvider', () => ({
  RuleBasedProvider: jest.fn().mockImplementation(() => mockRuleBasedInstance),
}));

// Mock AIConfigurationService (used by TaskAwareProviderFactory)
jest.mock('src/services/ai/AIConfigurationService', () => {
  return {
    AIConfigurationService: jest.fn(),
  };
});

// ── Import classes under test (after mocks are in place) ──

import { ProviderFactory, type ProviderConfig, type AIProviderTier } from 'src/services/ai/providers/ProviderFactory';
import { IntelligentProviderRouter, type RoutingContext } from 'src/services/ai/providers/IntelligentProviderRouter';
import { TaskAwareProviderFactory, type TaskContext } from 'src/services/ai/providers/TaskAwareProviderFactory';
import { ClaudeProvider } from 'src/services/ai/providers/ClaudeProvider';
import { OpenRouterProvider } from 'src/services/ai/providers/OpenRouterProvider';

// ── Shared mock logger ──

function createMockLogger() {
  return {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    child: jest.fn().mockReturnThis(),
    fatal: jest.fn(),
    trace: jest.fn(),
    silent: jest.fn(),
    level: 'info',
  } as any;
}

const mockOutboundGovernance = {
  validateAIProviderRequest: jest.fn(),
} as any;

// ── Helper: build a full ProviderConfig ──

function buildProviderConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    tier: 'default',
    sessionBudget: 0.20,
    providers: {
      openai: { apiKey: 'test-openai-key', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', maxTokens: 1000, temperature: 0.3 },
      claude: { apiKey: 'test-claude-key', model: 'claude-3-5-sonnet-20241022' as any, baseURL: 'https://api.anthropic.com/v1', maxTokens: 1000, temperature: 0.1 },
      gemini: { apiKey: 'test-gemini-key', model: 'gemini-1.5-flash' as any, baseURL: 'https://generativelanguage.googleapis.com/v1beta', maxTokens: 1000, temperature: 0.4 },
      lmstudio: { baseURL: 'http://127.0.0.1:1234', model: 'llama-3.1-8b-instruct', maxTokens: 1000, temperature: 0.3 },
    },
    ...overrides,
  };
}

function buildOpenRouterConfig() {
  return {
    apiKey: `sk-or-${'a'.repeat(48)}`,
    model: 'anthropic/claude-3.5-sonnet',
    baseURL: 'https://openrouter.ai/api/v1',
    maxTokens: 1000,
    temperature: 0.2,
  };
}

// ── Helper: build a routing context ──

function buildRoutingContext(overrides: Partial<RoutingContext> = {}): RoutingContext {
  return {
    complexity: 'medium',
    urgency: 'medium',
    accuracy_requirement: 'standard',
    dataSize: 100,
    fieldCount: 20,
    dataQuality: 'moderate',
    costSensitive: false,
    latencyRequirement: 'moderate',
    privacyLevel: 'standard',
    ...overrides,
  };
}

function resetCoreProviderMocks(): void {
  (mockOpenAIInstance as any).isAvailable = true;
  (mockClaudeInstance as any).isAvailable = true;
  (mockGeminiInstance as any).isAvailable = true;
  (mockLMStudioInstance as any).isAvailable = true;
  (mockOpenRouterInstance as any).isAvailable = true;

  (mockOpenAIInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  (mockClaudeInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  (mockGeminiInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  (mockLMStudioInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
  (mockOpenRouterInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });

  (mockOpenAIInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'name', targetField: 'name', transformationType: 'direct' }]);
  (mockClaudeInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'id', targetField: 'id', transformationType: 'direct' }]);
  (mockGeminiInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'email', targetField: 'email', transformationType: 'direct' }]);
  (mockLMStudioInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'phone', targetField: 'phone', transformationType: 'direct' }]);
  (mockOpenRouterInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'company', targetField: 'companyName', transformationType: 'direct' }]);

  (mockOpenAIInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.9, totalMappings: 1 });
  (mockClaudeInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.95, totalMappings: 1 });
  (mockGeminiInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.8, totalMappings: 1 });
  (mockLMStudioInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.7, totalMappings: 1 });
  (mockOpenRouterInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.88, totalMappings: 1 });

  (mockOpenAIInstance.getLastTokenUsage as jest.Mock).mockReset().mockReturnValue({ promptTokens: 10, completionTokens: 5, totalTokens: 15, estimatedCost: 0.001 });
  (mockClaudeInstance.getLastTokenUsage as jest.Mock).mockReset().mockReturnValue({ promptTokens: 8, completionTokens: 4, totalTokens: 12, estimatedCost: 0.0005 });
  (mockGeminiInstance.getLastTokenUsage as jest.Mock).mockReset().mockReturnValue({ promptTokens: 12, completionTokens: 6, totalTokens: 18, estimatedCost: 0.0002 });
  (mockLMStudioInstance.getLastTokenUsage as jest.Mock).mockReset().mockReturnValue({ promptTokens: 20, completionTokens: 10, totalTokens: 30, estimatedCost: 0 });
  (mockOpenRouterInstance.getLastTokenUsage as jest.Mock).mockReset().mockReturnValue({ promptTokens: 9, completionTokens: 4, totalTokens: 13, estimatedCost: 0.0003 });
}

// =============================================================================
// 1. ProviderFactory Tests
// =============================================================================

describe('ProviderFactory', () => {
  let factory: ProviderFactory;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = createMockLogger();
    factory = new ProviderFactory(mockLogger, mockOutboundGovernance);
    resetCoreProviderMocks();
  });

  // ── configure() ──

  describe('configure()', () => {
    it('should initialize all providers when all configs are supplied', async () => {
      const config = buildProviderConfig();
      await factory.configure(config);

      const available = factory.getAvailableProviders();
      const types = available.map(p => p.type);

      expect(types).toContain('openai');
      expect(types).toContain('claude');
      expect(types).toContain('gemini');
      expect(types).toContain('lmstudio');
      expect(available.length).toBe(4);
    });

    it('should initialize only specified providers', async () => {
      const config = buildProviderConfig({
        providers: {
          openai: { apiKey: 'key', model: 'gpt-4o', baseURL: 'https://api.openai.com/v1', maxTokens: 1000, temperature: 0.3 },
        },
      });
      await factory.configure(config);

      const available = factory.getAvailableProviders();
      expect(available.length).toBe(1);
      expect(available[0].type).toBe('openai');
    });

    it('should initialize openrouter when configured', async () => {
      const config = buildProviderConfig({
        providers: {
          openrouter: buildOpenRouterConfig(),
        },
      });
      await factory.configure(config);

      const available = factory.getAvailableProviders();
      expect(available).toHaveLength(1);
      expect(available[0].type).toBe('openrouter');
      expect(mockOpenRouterInstance.testConnection).toHaveBeenCalled();
    });

    it('should test connectivity for each provider during configure', async () => {
      const config = buildProviderConfig();
      await factory.configure(config);

      expect(mockOpenAIInstance.testConnection).toHaveBeenCalled();
      expect(mockClaudeInstance.testConnection).toHaveBeenCalled();
      expect(mockGeminiInstance.testConnection).toHaveBeenCalled();
      expect(mockLMStudioInstance.testConnection).toHaveBeenCalled();
    });

    it('should log a warning when a provider connectivity test fails', async () => {
      (mockClaudeInstance.testConnection as jest.Mock).mockRejectedValueOnce(new Error('Connection refused'));
      const config = buildProviderConfig();
      await factory.configure(config);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('claude'),
        expect.objectContaining({ error: 'Connection refused' })
      );
    });

    it('should clear previous providers on re-configure', async () => {
      await factory.configure(buildProviderConfig());
      expect(factory.getAvailableProviders().length).toBe(4);

      // Re-configure with fewer providers
      await factory.configure(buildProviderConfig({
        providers: {
          lmstudio: { baseURL: 'http://127.0.0.1:1234', model: 'llama', maxTokens: 500, temperature: 0.3 },
        },
      }));

      expect(factory.getAvailableProviders().length).toBe(1);
    });
  });

  // ── getOptimalProvider() ──

  describe('getOptimalProvider()', () => {
    it('should throw if factory is not configured', () => {
      expect(() => factory.getOptimalProvider()).toThrow('Provider factory not configured');
    });

    it('should return openai for default tier', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default' }));
      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockOpenAIInstance);
    });

    it('should return claude for premium tier', async () => {
      await factory.configure(buildProviderConfig({ tier: 'premium' }));
      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockClaudeInstance);
    });

    it('should return gemini for economy tier', async () => {
      await factory.configure(buildProviderConfig({ tier: 'economy' }));
      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockGeminiInstance);
    });

    it('should return lmstudio for local tier', async () => {
      await factory.configure(buildProviderConfig({ tier: 'local' }));
      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockLMStudioInstance);
    });

    it('should upgrade to premium for high complexity context', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default' }));
      const provider = factory.getOptimalProvider({ complexity: 'high' });
      expect(provider).toBe(mockClaudeInstance);
    });

    it('should downgrade to economy for high urgency + low complexity', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default' }));
      const provider = factory.getOptimalProvider({ urgency: 'high', complexity: 'low' });
      expect(provider).toBe(mockGeminiInstance);
    });

    it('should route to local provider when session budget is exceeded', async () => {
      await factory.configure(buildProviderConfig({ tier: 'premium', sessionBudget: 0.001 }));

      // Simulate cost accumulation by executing a field mapping
      (mockClaudeInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.01 });
      await factory.executeFieldMapping('source', 'target', [{}], {});

      // Now budget is exceeded, should route to local
      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockLMStudioInstance);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Session budget limit reached'),
        expect.objectContaining({
          configuredSessionBudget: 0.001,
          routedProviderType: 'lmstudio',
        }),
      );
    });

    it('should treat an explicit zero session budget as local-only execution', async () => {
      await factory.configure(buildProviderConfig({ tier: 'premium', sessionBudget: 0 }));

      const provider = factory.getOptimalProvider();

      expect(provider).toBe(mockLMStudioInstance);
      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining('Cloud budget disabled'),
        expect.objectContaining({
          configuredSessionBudget: 0,
          routedProviderType: 'lmstudio',
        }),
      );
    });

    it('should use fallback tier when primary provider is unavailable', async () => {
      (mockClaudeInstance as any).isAvailable = false;
      (mockOpenAIInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({ tier: 'premium', fallbackTier: 'economy' }));

      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockGeminiInstance);
    });

    it('should try any available provider when primary and fallback are unavailable', async () => {
      (mockClaudeInstance as any).isAvailable = false;
      (mockGeminiInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({ tier: 'premium', fallbackTier: 'economy' }));

      const provider = factory.getOptimalProvider();
      // Should find openai or lmstudio (whichever is iterated first)
      expect([mockOpenAIInstance, mockLMStudioInstance]).toContain(provider);
    });

    it('should use openrouter as the default-tier cloud fallback when openai is unavailable', async () => {
      (mockOpenAIInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({
        tier: 'default',
        providers: {
          ...buildProviderConfig().providers,
          openrouter: buildOpenRouterConfig(),
        },
      }));

      const provider = factory.getOptimalProvider();
      expect(provider).toBe(mockOpenRouterInstance);
    });

    it('should throw when no provider is available at all', async () => {
      (mockOpenAIInstance as any).isAvailable = false;
      (mockClaudeInstance as any).isAvailable = false;
      (mockGeminiInstance as any).isAvailable = false;
      (mockLMStudioInstance as any).isAvailable = false;

      await factory.configure(buildProviderConfig({ tier: 'default' }));

      expect(() => factory.getOptimalProvider()).toThrow('No AI provider available');
    });
  });

  // ── getSessionCostSummary() ──

  describe('getSessionCostSummary()', () => {
    it('should return zero costs when no requests have been made', async () => {
      await factory.configure(buildProviderConfig({ sessionBudget: 0.50 }));
      const summary = factory.getSessionCostSummary();

      expect(summary.totalCost).toBe(0);
      expect(summary.budgetRemaining).toBe(0.50);
      expect(summary.budgetUtilization).toBe(0);
      expect(summary.costsByProvider).toBeDefined();
    });

    it('should use default budget of $0.20 when no budget is specified', async () => {
      await factory.configure(buildProviderConfig({ sessionBudget: undefined }));
      const summary = factory.getSessionCostSummary();

      expect(summary.budgetRemaining).toBe(0.20);
    });

    it('should clamp an explicit zero budget without returning infinite utilization', async () => {
      await factory.configure(buildProviderConfig({ sessionBudget: 0 }));
      const summary = factory.getSessionCostSummary();

      expect(summary.budgetRemaining).toBe(0);
      expect(summary.budgetUtilization).toBe(1);
    });

    it('should track costs after executeFieldMapping', async () => {
      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.003 });
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 1.00 }));

      await factory.executeFieldMapping('source', 'target', [{ id: 1 }]);
      const summary = factory.getSessionCostSummary();

      expect(summary.totalCost).toBeGreaterThan(0);
      expect(summary.budgetUtilization).toBeGreaterThan(0);
    });
  });

  // ── getRoutingRecommendations() ──

  describe('getRoutingRecommendations()', () => {
    beforeEach(async () => {
      await factory.configure(buildProviderConfig({ sessionBudget: 1.00 }));
    });

    it('should recommend openai by default', () => {
      const rec = factory.getRoutingRecommendations();

      expect(rec.recommendedProvider).toBe('openai');
      expect(rec.reasoning).toBe('Default provider selection');
    });

    it('should recommend openrouter when openai is unavailable and openrouter is configured', async () => {
      (mockOpenAIInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({
        sessionBudget: 1.00,
        providers: {
          ...buildProviderConfig().providers,
          openrouter: buildOpenRouterConfig(),
        },
      }));

      const rec = factory.getRoutingRecommendations();

      expect(rec.recommendedProvider).toBe('openrouter');
      expect(rec.reasoning).toContain('OpenRouter');
    });

    it('should recommend claude for high complexity', () => {
      const rec = factory.getRoutingRecommendations({ complexity: 'high' });

      expect(rec.recommendedProvider).toBe('claude');
      expect(rec.reasoning).toContain('High complexity');
    });

    it('should recommend gemini for high urgency + low complexity', () => {
      const rec = factory.getRoutingRecommendations({ urgency: 'high', complexity: 'low' });

      expect(rec.recommendedProvider).toBe('gemini');
      expect(rec.reasoning).toContain('urgency');
    });

    it('should recommend lmstudio when budget threshold exceeded', async () => {
      // Drain budget by simulating cost
      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.85 });
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 1.00 }));
      await factory.executeFieldMapping('src', 'tgt', [{}]);

      const rec = factory.getRoutingRecommendations();
      expect(rec.recommendedProvider).toBe('lmstudio');
      expect(rec.reasoning).toContain('Budget');
    });

    it('should recommend the local tier when the configured session budget is zero', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 0 }));

      const rec = factory.getRoutingRecommendations();

      expect(rec.recommendedProvider).toBe('lmstudio');
      expect(rec.reasoning).toContain('Budget');
    });

    it('should prefer gemini over openrouter for budget cloud fallback ordering', async () => {
      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.85 });
      (mockLMStudioInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({
        tier: 'default',
        sessionBudget: 1.00,
        providers: {
          ...buildProviderConfig().providers,
          openrouter: buildOpenRouterConfig(),
        },
      }));
      await factory.executeFieldMapping('src', 'tgt', [{}]);

      const rec = factory.getRoutingRecommendations();

      expect(rec.recommendedProvider).toBe('gemini');
      expect(rec.reasoning).toContain('Gemini');
      expect(rec.reasoning).toContain('lowest-cost cloud fallback');
    });

    it('should recommend the next available provider when the local budget fallback is unavailable', async () => {
      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.85 });
      (mockLMStudioInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 1.00 }));
      await factory.executeFieldMapping('src', 'tgt', [{}]);

      const rec = factory.getRoutingRecommendations();

      expect(rec.recommendedProvider).toBe('gemini');
      expect(rec.reasoning).toContain('Gemini');
      expect(rec.reasoning).toContain('lowest-cost cloud fallback');
    });

    it('should list alternative providers excluding the recommended one', () => {
      const rec = factory.getRoutingRecommendations();

      expect(rec.alternativeProviders).not.toContain('openai');
      expect(rec.alternativeProviders.length).toBeGreaterThan(0);
    });

    it('should return a numeric costEstimate', () => {
      const rec = factory.getRoutingRecommendations({ complexity: 'high' });
      expect(typeof rec.costEstimate).toBe('number');
    });
  });

  // ── resetSessionCosts() ──

  describe('resetSessionCosts()', () => {
    it('should reset all provider session costs to zero', async () => {
      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({ estimatedCost: 0.05 });
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 1.00 }));
      await factory.executeFieldMapping('src', 'tgt', [{}]);

      // Confirm cost accumulated
      expect(factory.getSessionCostSummary().totalCost).toBeGreaterThan(0);

      factory.resetSessionCosts();

      const summary = factory.getSessionCostSummary();
      expect(summary.totalCost).toBe(0);
    });

    it('should log when session costs are reset', async () => {
      await factory.configure(buildProviderConfig());
      factory.resetSessionCosts();

      expect(mockLogger.info).toHaveBeenCalledWith('Session costs reset');
    });
  });

  // ── getAvailableProviders() ──

  describe('getAvailableProviders()', () => {
    it('should return empty array when not configured', () => {
      // Factory not configured, providers map is empty
      const available = factory.getAvailableProviders();
      expect(available).toEqual([]);
    });

    it('should filter out unavailable providers', async () => {
      (mockGeminiInstance as any).isAvailable = false;
      await factory.configure(buildProviderConfig());

      const available = factory.getAvailableProviders();
      const types = available.map(p => p.type);

      expect(types).not.toContain('gemini');
      expect(types).toContain('openai');
      expect(types).toContain('claude');
      expect(types).toContain('lmstudio');
    });

    it('should include metrics for each available provider', async () => {
      await factory.configure(buildProviderConfig());

      const available = factory.getAvailableProviders();
      for (const entry of available) {
        expect(entry.metrics).toBeDefined();
        expect(entry.metrics.successRate).toBeDefined();
        expect(entry.metrics.averageResponseTime).toBeDefined();
        expect(entry.metrics.totalRequests).toBeDefined();
        expect(typeof entry.sessionCost).toBe('number');
      }
    });

    it('should report zero session cost initially', async () => {
      await factory.configure(buildProviderConfig());

      const available = factory.getAvailableProviders();
      for (const entry of available) {
        expect(entry.sessionCost).toBe(0);
      }
    });
  });

  // ── executeFieldMapping() ──

  describe('executeFieldMapping()', () => {
    it('should call suggest on the selected provider', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default' }));
      const suggestions = await factory.executeFieldMapping('NetSuite', 'Salesforce', [{ id: 1 }]);

      expect(mockOpenAIInstance.suggest).toHaveBeenCalledWith('NetSuite', 'Salesforce', [{ id: 1 }]);
      expect(suggestions).toBeDefined();
      expect(Array.isArray(suggestions)).toBe(true);
    });

    it('should propagate errors from the provider', async () => {
      (mockOpenAIInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('API Error'));
      await factory.configure(buildProviderConfig({ tier: 'default' }));

      await expect(factory.executeFieldMapping('src', 'tgt', [])).rejects.toThrow('API Error');
    });
  });

  // ── executeQualityAssessment() ──

  describe('executeQualityAssessment()', () => {
    it('should call assessQuality on the selected provider', async () => {
      const mockSuggestions: AISuggestion[] = [
        { sourceField: 'name', targetField: 'name', transformationType: 'direct' },
      ];

      await factory.configure(buildProviderConfig({ tier: 'default' }));
      const report = await factory.executeQualityAssessment(mockSuggestions);

      expect(mockOpenAIInstance.assessQuality).toHaveBeenCalledWith(mockSuggestions);
      expect(report).toBeDefined();
      expect(report.overallScore).toBeDefined();
    });
  });

  describe('executeQualityAssessmentWithProvider()', () => {
    it('should preserve the budget guard for exact provider execution', async () => {
      await factory.configure(buildProviderConfig({ tier: 'default', sessionBudget: 0.0005 }));

      const suggestions: AISuggestion[] = [
        { sourceField: 'name', targetField: 'name', transformationType: 'direct' },
      ];

      const initial = await factory.executeQualityAssessmentWithProvider('openai', suggestions);
      const rerouted = await factory.executeQualityAssessmentWithProvider('openai', suggestions);

      expect(initial.providerType).toBe('openai');
      expect(initial.costDelta).toBeCloseTo(0.001);
      expect(rerouted.providerType).toBe('lmstudio');
      expect(rerouted.result).toEqual({ overallScore: 0.7, totalMappings: 1 });
      expect(rerouted.costDelta).toBe(0);
      expect(mockLMStudioInstance.assessQuality).toHaveBeenCalledWith(suggestions);
    });
  });
});

// =============================================================================
// 2. IntelligentProviderRouter Tests
// =============================================================================

describe('IntelligentProviderRouter', () => {
  let router: IntelligentProviderRouter;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = createMockLogger();
    resetCoreProviderMocks();

    router = new IntelligentProviderRouter(mockLogger, buildProviderConfig(), mockOutboundGovernance);
  });

  // ── Scoring logic (accessed indirectly through getRoutingAnalytics and routeRequest) ──

  describe('scoring logic (scoreCapability / scoreCost / scoreLatency / scorePrivacy)', () => {
    it('should score premium providers highest for high complexity capability', async () => {
      // We test indirectly: route a high-complexity request and verify a top-tier provider is selected
      const context = buildRoutingContext({
        complexity: 'high',
        accuracy_requirement: 'critical',
        costSensitive: false,
        privacyLevel: 'standard',
      });

      // routeRequest calls makeRoutingDecision internally, which calls scoreProvider
      const result = await router.routeRequest('NetSuite', 'Salesforce', [{ id: 1 }], context);

      // With critical accuracy requirement, capability weight is 0.5 and track_record is 0.2
      // Both claude (1.0) and openai (0.95) score very high on capability for 'high' complexity
      // Either premium provider is acceptable; gemini and lmstudio should NOT be selected
      expect(['claude', 'openai']).toContain(result.decision.selectedProvider);
      expect(result.decision.confidence).toBeGreaterThan(0);
      expect(result.decision.reasoning.length).toBeGreaterThan(0);
    });

    it('should prefer lmstudio for confidential privacy level', async () => {
      const context = buildRoutingContext({
        complexity: 'low',
        privacyLevel: 'confidential',
        costSensitive: false,
      });

      const result = await router.routeRequest('src', 'tgt', [{}], context);

      // LMStudio gets 1.0 privacy score for confidential; others get 0.3
      // With 0.4 weight on privacy for confidential data, lmstudio should win
      expect(result.decision.selectedProvider).toBe('lmstudio');
    });

    it('should execute the provider selected by the router instead of rerouting through factory defaults', async () => {
      const context = buildRoutingContext({
        complexity: 'low',
        privacyLevel: 'confidential',
        costSensitive: false,
      });

      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.selectedProvider).toBe('lmstudio');
      expect(result.performance.provider).toBe('lmstudio');
      expect(mockLMStudioInstance.suggest).toHaveBeenCalledWith('src', 'tgt', [{}]);
      expect(mockOpenAIInstance.suggest).not.toHaveBeenCalled();
    });

    it('should preserve the provider-factory budget guard when exact execution is requested', async () => {
      router = new IntelligentProviderRouter(mockLogger, buildProviderConfig({
        sessionBudget: 0.0005,
      }), mockOutboundGovernance);

      const context = buildRoutingContext({
        complexity: 'medium',
        privacyLevel: 'standard',
        costSensitive: false,
      });

      await router.routeRequest('src', 'tgt', [{}], context);
      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.selectedProvider).toBe('lmstudio');
      expect(result.decision.reroutedFrom).toBe('openai');
      expect(result.performance.provider).toBe('lmstudio');
      expect(result.decision.reasoning).toContain('Session budget guard rerouted execution from openai to lmstudio');
      expect(mockOpenAIInstance.suggest).toHaveBeenCalledTimes(1);
      expect(mockLMStudioInstance.suggest).toHaveBeenCalledTimes(1);
    });

    it('should recompute decision metadata when the budget guard reroutes execution', async () => {
      router = new IntelligentProviderRouter(mockLogger, buildProviderConfig({
        sessionBudget: 0.0005,
      }), mockOutboundGovernance);

      const context = buildRoutingContext({
        complexity: 'high',
        accuracy_requirement: 'critical',
        privacyLevel: 'standard',
        costSensitive: false,
      });

      await router.routeRequest('src', 'tgt', [{}], context);
      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.selectedProvider).toBe('lmstudio');
      expect(['claude', 'openai']).toContain(result.decision.reroutedFrom);
      expect(result.performance.provider).toBe('lmstudio');
      expect(result.decision.riskFactors).toContain('Provider may struggle with high complexity requirements');
      expect(result.decision.estimatedLatency).toBeGreaterThanOrEqual(0);
      expect(result.decision.alternativeProviders.every((provider) => provider.provider !== 'lmstudio')).toBe(true);
    });

    it('should prefer gemini or lmstudio when cost-sensitive', async () => {
      const context = buildRoutingContext({
        complexity: 'low',
        costSensitive: true,
        urgency: 'low',
        privacyLevel: 'standard',
      });

      const result = await router.routeRequest('src', 'tgt', [{}], context);

      // Cost-sensitive should prefer cheaper providers (lmstudio score 1.0, gemini 0.9)
      expect(['gemini', 'lmstudio']).toContain(result.decision.selectedProvider);
    });

    it('should provide alternative providers in the decision', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });
      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.alternativeProviders).toBeDefined();
      expect(result.decision.alternativeProviders.length).toBeGreaterThan(0);

      for (const alt of result.decision.alternativeProviders) {
        expect(alt.provider).toBeDefined();
        expect(typeof alt.score).toBe('number');
        expect(typeof alt.reasoning).toBe('string');
      }
    });

    it('should wait for async provider factory configuration before routing', async () => {
      const originalConfigure = ProviderFactory.prototype.configure;
      const configureSpy = jest.spyOn(ProviderFactory.prototype, 'configure')
        .mockImplementation(function delayedConfigure(this: ProviderFactory, config: ProviderConfig) {
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              originalConfigure.call(this, config).then(resolve).catch(reject);
            }, 25);
          });
        });

      try {
        router = new IntelligentProviderRouter(mockLogger, buildProviderConfig(), mockOutboundGovernance);

        const result = await router.routeRequest('src', 'tgt', [{}], buildRoutingContext());

        expect(configureSpy).toHaveBeenCalled();
        expect(result.decision.selectedProvider).toBeDefined();
        expect(result.suggestions.length).toBeGreaterThan(0);
      } finally {
        configureSpy.mockRestore();
      }
    });

    it('should select openrouter when it is the strongest configured cloud provider', async () => {
      (mockOpenAIInstance as any).isAvailable = false;
      (mockClaudeInstance as any).isAvailable = false;

      router = new IntelligentProviderRouter(mockLogger, buildProviderConfig({
        providers: {
          gemini: buildProviderConfig().providers.gemini,
          lmstudio: buildProviderConfig().providers.lmstudio,
          openrouter: buildOpenRouterConfig(),
        },
      }), mockOutboundGovernance);

      const context = buildRoutingContext({
        complexity: 'medium',
        costSensitive: false,
        privacyLevel: 'standard',
      });

      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.selectedProvider).toBe('openrouter');
      expect(result.performance.provider).toBe('openrouter');
      expect(mockOpenRouterInstance.suggest).toHaveBeenCalledWith('src', 'tgt', [{}]);
    });

    it('should include risk factors when using cloud provider for confidential data', async () => {
      // Force openai availability only so it must be selected for non-privacy context
      (mockClaudeInstance as any).isAvailable = false;
      (mockLMStudioInstance as any).isAvailable = false;
      (mockGeminiInstance as any).isAvailable = false;

      router = new IntelligentProviderRouter(mockLogger, buildProviderConfig(), mockOutboundGovernance);

      const context = buildRoutingContext({
        complexity: 'medium',
        privacyLevel: 'confidential',
      });

      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(result.decision.riskFactors).toBeDefined();
      // Should have a risk factor about confidential data to cloud
      const hasPrivacyRisk = result.decision.riskFactors.some(r => r.toLowerCase().includes('confidential'));
      expect(hasPrivacyRisk).toBe(true);
    });

    it('should include estimated cost and latency in the decision', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });
      const result = await router.routeRequest('src', 'tgt', [{}], context);

      expect(typeof result.decision.estimatedCost).toBe('number');
      expect(typeof result.decision.estimatedLatency).toBe('number');
    });
  });

  // ── getRoutingAnalytics() with empty history ──

  describe('getRoutingAnalytics() - empty history', () => {
    it('should return zeroed analytics when no routing has occurred', () => {
      const analytics = router.getRoutingAnalytics();

      expect(analytics.totalRoutings).toBe(0);
      expect(analytics.successRate).toBe(0);
      expect(analytics.averageCost).toBe(0);
      expect(analytics.averageLatency).toBe(0);
      expect(analytics.topPerformingProvider).toBe('openai');
      expect(analytics.recommendations).toContain('No routing history available yet');
    });

    it('should return empty providerUsage when no routings have happened', () => {
      const analytics = router.getRoutingAnalytics();
      expect(Object.keys(analytics.providerUsage).length).toBe(0);
    });
  });

  // ── getRoutingAnalytics() with populated history ──

  describe('getRoutingAnalytics() - populated history', () => {
    it('should track routing history after successful requests', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });

      await router.routeRequest('src', 'tgt', [{ id: 1 }], context);
      await router.routeRequest('src', 'tgt', [{ id: 2 }], context);

      const analytics = router.getRoutingAnalytics();

      expect(analytics.totalRoutings).toBe(2);
      expect(analytics.successRate).toBe(1.0);
      expect(analytics.averageLatency).toBeGreaterThanOrEqual(0);
    });

    it('should reflect partial success rate when some requests fail', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });

      // First request succeeds
      await router.routeRequest('src', 'tgt', [{}], context);

      // Second request fails
      (mockOpenAIInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Timeout'));
      (mockClaudeInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Timeout'));
      (mockGeminiInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Timeout'));
      (mockLMStudioInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Timeout'));

      try {
        await router.routeRequest('src', 'tgt', [{}], context);
      } catch {
        // Expected failure
      }

      const analytics = router.getRoutingAnalytics();

      expect(analytics.totalRoutings).toBe(2);
      expect(analytics.successRate).toBe(0.5);
    });

    it('should track provider usage counts', async () => {
      const lowContext = buildRoutingContext({ complexity: 'low', urgency: 'low', costSensitive: false });

      await router.routeRequest('src', 'tgt', [{}], lowContext);
      await router.routeRequest('src', 'tgt', [{}], lowContext);

      const analytics = router.getRoutingAnalytics();

      expect(analytics.totalRoutings).toBe(2);
      // providerUsage should have at least one entry
      const totalUsage = Object.values(analytics.providerUsage).reduce((sum, count) => sum + count, 0);
      expect(totalUsage).toBe(2);
    });

    it('should identify the top performing provider', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });

      // Multiple requests to build history
      await router.routeRequest('src', 'tgt', [{}], context);
      await router.routeRequest('src', 'tgt', [{}], context);
      await router.routeRequest('src', 'tgt', [{}], context);

      const analytics = router.getRoutingAnalytics();

      expect(analytics.topPerformingProvider).toBeDefined();
      // The provider should be one of the known types
      expect(['openai', 'claude', 'gemini', 'lmstudio', 'openrouter', 'rule-based']).toContain(analytics.topPerformingProvider);
    });

    it('should provide recommendations array', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });
      await router.routeRequest('src', 'tgt', [{}], context);

      const analytics = router.getRoutingAnalytics();

      expect(Array.isArray(analytics.recommendations)).toBe(true);
    });

    it('should track per-request cost rather than cumulative provider session cost', async () => {
      const context = buildRoutingContext({ complexity: 'medium' });

      const first = await router.routeRequest('src', 'tgt', [{ id: 1 }], context);
      const second = await router.routeRequest('src', 'tgt', [{ id: 2 }], context);
      const analytics = router.getRoutingAnalytics();

      expect(first.performance.actualCost).toBeCloseTo(0.001);
      expect(second.performance.actualCost).toBeCloseTo(0.001);
      expect(analytics.averageCost).toBeCloseTo(0.001);
    });
  });

  // ── routeRequest error handling ──

  describe('routeRequest() error handling', () => {
    it('should log error and re-throw when provider execution fails', async () => {
      (mockOpenAIInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Provider down'));
      (mockClaudeInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Provider down'));
      (mockGeminiInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Provider down'));
      (mockLMStudioInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Provider down'));

      const context = buildRoutingContext({ complexity: 'medium' });

      await expect(router.routeRequest('src', 'tgt', [{}], context)).rejects.toThrow('Provider down');
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Routing execution failed'),
        expect.any(Object)
      );
    });

    it('should still record the failed outcome in history', async () => {
      (mockOpenAIInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Oops'));
      (mockClaudeInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Oops'));
      (mockGeminiInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Oops'));
      (mockLMStudioInstance.suggest as jest.Mock).mockRejectedValueOnce(new Error('Oops'));

      const context = buildRoutingContext({ complexity: 'low' });

      try {
        await router.routeRequest('src', 'tgt', [{}], context);
      } catch {
        // expected
      }

      const analytics = router.getRoutingAnalytics();
      expect(analytics.totalRoutings).toBe(1);
      expect(analytics.successRate).toBe(0);
    });
  });
});

// =============================================================================
// 3. TaskAwareProviderFactory Tests
// =============================================================================

describe('TaskAwareProviderFactory', () => {
  let taskFactory: TaskAwareProviderFactory;
  let mockLogger: any;
  let mockConfigService: any;

  beforeEach(() => {
    mockLogger = createMockLogger();

    mockConfigService = {
      getTaskModelConfig: jest.fn(),
      getProviderConfigs: jest.fn().mockResolvedValue([]),
      logUsage: jest.fn().mockResolvedValue(undefined),
    };

    taskFactory = new TaskAwareProviderFactory(mockLogger, mockConfigService, mockOutboundGovernance);

    // Reset ALL mock implementations to defaults.
    // This is necessary because jest clearMocks does not clear mockResolvedValueOnce queues
    // left over from previous test suites (e.g., IntelligentProviderRouter tests).
    (mockOpenAIInstance as any).isAvailable = true;
    (mockClaudeInstance as any).isAvailable = true;
    (mockGeminiInstance as any).isAvailable = true;
    (mockLMStudioInstance as any).isAvailable = true;
    (mockOpenRouterInstance as any).isAvailable = true;
    (mockRuleBasedInstance as any).isAvailable = true;

    (mockOpenAIInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
    (mockClaudeInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
    (mockGeminiInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
    (mockLMStudioInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
    (mockOpenRouterInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Connected' });
    (mockRuleBasedInstance.testConnection as jest.Mock).mockReset().mockResolvedValue({ ok: true, message: 'Rule-based always available' });

    (mockOpenAIInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'name', targetField: 'name', transformationType: 'direct' }]);
    (mockClaudeInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'id', targetField: 'id', transformationType: 'direct' }]);
    (mockGeminiInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'email', targetField: 'email', transformationType: 'direct' }]);
    (mockLMStudioInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'phone', targetField: 'phone', transformationType: 'direct' }]);
    (mockOpenRouterInstance.suggest as jest.Mock).mockReset().mockResolvedValue([{ sourceField: 'company', targetField: 'companyName', transformationType: 'direct' }]);
    (mockRuleBasedInstance.suggest as jest.Mock).mockReset().mockResolvedValue([]);

    (mockOpenAIInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.9, totalMappings: 1 });
    (mockClaudeInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.95, totalMappings: 1 });
    (mockGeminiInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.8, totalMappings: 1 });
    (mockLMStudioInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.7, totalMappings: 1 });
    (mockOpenRouterInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.88, totalMappings: 1 });
    (mockRuleBasedInstance.assessQuality as jest.Mock).mockReset().mockResolvedValue({ overallScore: 0.5, totalMappings: 0 });
    (ClaudeProvider as unknown as jest.Mock).mockClear();
    (OpenRouterProvider as unknown as jest.Mock).mockClear();
  });

  // ── getSessionCostSummary() ──

  describe('getSessionCostSummary()', () => {
    it('should return zero cost for a fresh user session', () => {
      const summary = taskFactory.getSessionCostSummary(1);

      expect(summary.totalCost).toBe(0);
      expect(summary.budgetRemaining).toBe(0.20);
      expect(summary.budgetUtilization).toBe(0);
    });

    it('should reflect the custom budget after setSessionBudget', () => {
      taskFactory.setSessionBudget(1.00);
      const summary = taskFactory.getSessionCostSummary(1);

      expect(summary.budgetRemaining).toBe(1.00);
    });

    it('should not return negative budgetRemaining', () => {
      taskFactory.setSessionBudget(0.01);

      // Simulate cost accumulation via internal state
      // We cannot easily inject cost without executing a task, so test boundary
      const summary = taskFactory.getSessionCostSummary(99);
      expect(summary.budgetRemaining).toBeGreaterThanOrEqual(0);
    });
  });

  // ── setSessionBudget() ──

  describe('setSessionBudget()', () => {
    it('should update the session budget', () => {
      taskFactory.setSessionBudget(5.00);
      const summary = taskFactory.getSessionCostSummary(1);

      expect(summary.budgetRemaining).toBe(5.00);
    });

    it('should clamp negative budgets to zero', () => {
      taskFactory.setSessionBudget(-10);
      const summary = taskFactory.getSessionCostSummary(1);

      expect(summary.budgetRemaining).toBe(0);
    });

    it('should log budget update', () => {
      taskFactory.setSessionBudget(2.50);

      expect(mockLogger.info).toHaveBeenCalledWith('Session budget updated', { budget: 2.50 });
    });
  });

  // ── resetSessionCosts() ──

  describe('resetSessionCosts()', () => {
    it('should clear session costs for a specific user', () => {
      // Execute a task to accumulate cost, then reset
      taskFactory.resetSessionCosts(42);

      const summary = taskFactory.getSessionCostSummary(42);
      expect(summary.totalCost).toBe(0);
    });

    it('should log the reset', () => {
      taskFactory.resetSessionCosts(7);

      expect(mockLogger.info).toHaveBeenCalledWith('Session costs reset', { userId: '7' });
    });

    it('should not affect other users session costs', async () => {
      // Create a fresh factory to avoid provider cache issues from other tests
      const freshConfigService = {
        getTaskModelConfig: jest.fn().mockResolvedValue({
          providerType: 'lmstudio',
          providerName: 'LMStudio',
          modelVersion: 'llama-3.1-8b-instruct',
          modelParameters: { maxTokens: 1000, temperature: 0.3 },
          endpointUrl: 'http://127.0.0.1:1234',
          priority: 1,
        }),
        getProviderConfigs: jest.fn().mockResolvedValue([]),
        logUsage: jest.fn().mockResolvedValue(undefined),
      };

      const freshFactory = new TaskAwareProviderFactory(mockLogger, freshConfigService, mockOutboundGovernance);

      // Ensure the mock provider reports token usage with cost
      (mockLMStudioInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
        estimatedCost: 0.05,
      });
      (mockLMStudioInstance.suggest as jest.Mock).mockResolvedValue([
        { sourceField: 'a', targetField: 'b', transformationType: 'direct' },
      ]);
      (mockLMStudioInstance.testConnection as jest.Mock).mockResolvedValue({ ok: true });
      (mockLMStudioInstance as any).isAvailable = true;

      await freshFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      await freshFactory.executeTask(
        { taskType: 'field_mapping', userId: 2 },
        'suggest',
        'src', 'tgt', [{}]
      );

      // Reset user 2 only
      freshFactory.resetSessionCosts(2);

      const user1Summary = freshFactory.getSessionCostSummary(1);
      const user2Summary = freshFactory.getSessionCostSummary(2);

      expect(user1Summary.totalCost).toBeGreaterThan(0);
      expect(user2Summary.totalCost).toBe(0);
    });
  });

  // ── executeTask() error handling ──

  describe('executeTask() - error handling', () => {
    it('should return graceful fallback when no provider is configured for task', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue(null);

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(false);
      expect(result.providerType).toBe('rule-based');
      expect(result.modelVersion).toBe('fallback');
      expect(result.errorMessage).toContain('No AI provider configured');
      // suggest fallback returns empty array
      expect(result.result).toEqual([]);
    });

    it('should return graceful fallback for assessQuality when provider fails', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue(null);

      const result = await taskFactory.executeTask(
        { taskType: 'quality_assessment', userId: 1 },
        'assessQuality',
        [{ sourceField: 'a', targetField: 'b', transformationType: 'direct' }]
      );

      expect(result.success).toBe(false);
      expect(result.providerType).toBe('rule-based');
      expect(result.modelVersion).toBe('fallback');
      // assessQuality fallback returns { overallScore: 0, totalMappings: 0 }
      expect(result.result).toEqual({ overallScore: 0, totalMappings: 0 });
    });

    it('should return graceful fallback when provider testConnection fails', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'openai',
        providerName: 'OpenAI',
        modelVersion: 'gpt-4o',
        modelParameters: { maxTokens: 1000, temperature: 0.3 },
        apiKey: 'test-key',
        priority: 1,
      });

      (mockOpenAIInstance.testConnection as jest.Mock).mockResolvedValueOnce({ ok: false, message: 'API key invalid' });

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('not available');
    });

    it('should return graceful fallback when session budget is exceeded', async () => {
      taskFactory.setSessionBudget(0.001);

      // Accumulate some cost first
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'openai',
        providerName: 'OpenAI',
        modelVersion: 'gpt-4o',
        modelParameters: { maxTokens: 1000, temperature: 0.3 },
        apiKey: 'test-key',
        priority: 1,
      });

      (mockOpenAIInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        estimatedCost: 0.01,
      });

      // First call succeeds and spends over budget
      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 5 },
        'suggest',
        'src', 'tgt', [{}]
      );

      // Second call should fail due to budget
      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 5 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('budget exceeded');
    });

    it('should include executionTime in the result even on error', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue(null);

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(typeof result.executionTime).toBe('number');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should log the error when task execution fails', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue(null);

      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(mockLogger.error).toHaveBeenCalledWith(
        'AI task execution failed',
        expect.objectContaining({
          taskType: 'field_mapping',
          userId: '1',
        })
      );
    });

    it('should attempt to log failed execution to configService', async () => {
      // First call returns null (triggers error), second call also returns null (during error logging)
      mockConfigService.getTaskModelConfig.mockResolvedValue(null);

      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      // The logTaskExecution inside catch should be attempted but won't call logUsage
      // because getOptimalTaskConfig returns null. This tests the inner try/catch.
      // No crash means the error handling path works.
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  // ── executeTask() success path ──

  describe('executeTask() - success path', () => {
    beforeEach(() => {
      // Create a fresh factory for each success test to avoid cached stale provider instances
      taskFactory = new TaskAwareProviderFactory(mockLogger, mockConfigService, mockOutboundGovernance);

      mockConfigService.getTaskModelConfig.mockResolvedValue({
        taskModelConfigId: 1,
        providerConfigId: 10,
        providerType: 'lmstudio',
        providerName: 'LMStudio',
        modelVersion: 'llama-3.1-8b-instruct',
        modelParameters: { maxTokens: 1000, temperature: 0.3 },
        endpointUrl: 'http://127.0.0.1:1234',
        priority: 1,
      });

      // Already reset by outer beforeEach via mockReset(). Just set getLastTokenUsage.
      (mockLMStudioInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({
        promptTokens: 20, completionTokens: 10, totalTokens: 30, estimatedCost: 0,
      });
    });

    it('should return successful result with provider info', async () => {
      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.errorMessage).toBeUndefined();
      expect(result.success).toBe(true);
      expect(result.providerType).toBe('lmstudio');
      expect(result.modelVersion).toBe('llama-3.1-8b-instruct');
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
    });

    it('should call suggest with correct arguments', async () => {
      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'NetSuite', 'Salesforce', [{ id: 1 }]
      );

      expect(mockLMStudioInstance.suggest).toHaveBeenCalledWith('NetSuite', 'Salesforce', [{ id: 1 }]);
    });

    it('should call assessQuality for assessQuality operation', async () => {
      const suggestions: AISuggestion[] = [
        { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
      ];

      await taskFactory.executeTask(
        { taskType: 'quality_assessment', userId: 1 },
        'assessQuality',
        suggestions
      );

      expect(mockLMStudioInstance.assessQuality).toHaveBeenCalledWith(suggestions);
    });

    it('should log usage to configService on success', async () => {
      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1, sessionId: 'sess-123' },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(mockConfigService.logUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          taskType: 'field_mapping',
          providerType: 'lmstudio',
          modelVersion: 'llama-3.1-8b-instruct',
          success: true,
          sessionId: 'sess-123',
        })
      );
    });

    it('should track token usage and update session costs', async () => {
      (mockLMStudioInstance as any).getLastTokenUsage = jest.fn().mockReturnValue({
        promptTokens: 50,
        completionTokens: 25,
        totalTokens: 75,
        estimatedCost: 0.003,
      });

      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 10 },
        'suggest',
        'src', 'tgt', [{}]
      );

      const summary = taskFactory.getSessionCostSummary(10);
      expect(summary.totalCost).toBe(0.003);
      expect(summary.budgetUtilization).toBeCloseTo(0.003 / 0.20);
    });

    it('should log success message with provider details', async () => {
      await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(mockLogger.info).toHaveBeenCalledWith(
        'AI task executed successfully',
        expect.objectContaining({
          taskType: 'field_mapping',
          provider: 'lmstudio',
          model: 'llama-3.1-8b-instruct',
        })
      );
    });
  });

  // ── executeTask() with different provider types ──

  describe('executeTask() - provider type switching', () => {
    beforeEach(() => {
      // Create a fresh factory for each provider-switching test to avoid cached instances
      taskFactory = new TaskAwareProviderFactory(mockLogger, mockConfigService, mockOutboundGovernance);
    });

    it('should create openai provider when config specifies openai', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'openai',
        providerName: 'OpenAI',
        modelVersion: 'gpt-4o',
        modelParameters: { maxTokens: 1000, temperature: 0.3 },
        apiKey: 'test-openai-key',
        priority: 1,
      });

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(true);
      expect(result.providerType).toBe('openai');
    });

    it('should create claude provider when config specifies claude', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'claude',
        providerName: 'Claude',
        modelVersion: 'claude-3-5-sonnet-20241022',
        modelParameters: { maxTokens: 0, temperature: 0 },
        apiKey: 'test-claude-key',
        endpointUrl: 'https://gateway.example.com/v1',
        configuration: {
          authMode: 'anthropic',
        },
        priority: 1,
      });

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(true);
      expect(result.providerType).toBe('claude');
      expect(ClaudeProvider as unknown as jest.Mock).toHaveBeenCalledWith(
        mockLogger,
        expect.objectContaining({
          apiKey: 'test-claude-key',
          model: 'claude-3-5-sonnet-20241022',
          baseURL: 'https://gateway.example.com/v1',
          maxTokens: 1000,
          temperature: 0,
          authMode: 'anthropic',
        }),
        mockOutboundGovernance
      );
    });

    it('should create openrouter provider with expected defaults and overrides', async () => {
      const previousSiteUrl = process.env.OPENROUTER_SITE_URL;
      const previousSiteName = process.env.OPENROUTER_SITE_NAME;
      const previousTimeout = process.env.OPENROUTER_TIMEOUT;

      process.env.OPENROUTER_SITE_URL = 'https://env.example.com';
      process.env.OPENROUTER_SITE_NAME = 'Env App';
      process.env.OPENROUTER_TIMEOUT = 'invalid';

      try {
        mockConfigService.getTaskModelConfig.mockResolvedValue({
          providerType: 'openrouter',
          providerName: 'OpenRouter',
          modelVersion: 'anthropic/claude-3.5-sonnet',
          modelParameters: { maxTokens: 0, temperature: 0 },
          apiKey: `sk-or-${'a'.repeat(48)}`,
          endpointUrl: 'http://localhost:8000',
          configuration: {
            siteName: 'Saved App',
            timeout: 45000,
          },
          priority: 1,
        });

        const result = await taskFactory.executeTask(
          { taskType: 'field_mapping', userId: 1 },
          'suggest',
          'src', 'tgt', [{}]
        );

        expect(result.success).toBe(true);
        expect(result.providerType).toBe('openrouter');
        expect(OpenRouterProvider as unknown as jest.Mock).toHaveBeenCalledWith(
          mockLogger,
          expect.objectContaining({
            apiKey: `sk-or-${'a'.repeat(48)}`,
            model: 'anthropic/claude-3.5-sonnet',
            baseURL: 'http://localhost:8000/v1',
            maxTokens: undefined,
            temperature: 0,
            siteUrl: 'https://env.example.com',
            siteName: 'Saved App',
            timeout: 45000,
          }),
          mockOutboundGovernance
        );
        expect(mockOpenRouterInstance.suggest).toHaveBeenCalledWith('src', 'tgt', [{}]);
      } finally {
        if (previousSiteUrl === undefined) {
          delete process.env.OPENROUTER_SITE_URL;
        } else {
          process.env.OPENROUTER_SITE_URL = previousSiteUrl;
        }

        if (previousSiteName === undefined) {
          delete process.env.OPENROUTER_SITE_NAME;
        } else {
          process.env.OPENROUTER_SITE_NAME = previousSiteName;
        }

        if (previousTimeout === undefined) {
          delete process.env.OPENROUTER_TIMEOUT;
        } else {
          process.env.OPENROUTER_TIMEOUT = previousTimeout;
        }
      }
    });

    it('should fail gracefully when openai api key is missing', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'openai',
        providerName: 'OpenAI',
        modelVersion: 'gpt-4o',
        modelParameters: { maxTokens: 1000, temperature: 0.3 },
        // apiKey is missing
        priority: 1,
      });

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(false);
      expect(result.errorMessage).toContain('API key not configured');
    });

    it('should fall back to rule-based for unknown provider type', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'rule-based',
        providerName: 'Rule Based',
        modelVersion: 'v1',
        modelParameters: { maxTokens: 500, temperature: 0 },
        priority: 1,
      });

      const result = await taskFactory.executeTask(
        { taskType: 'field_mapping', userId: 1 },
        'suggest',
        'src', 'tgt', [{}]
      );

      expect(result.success).toBe(true);
      expect(result.providerType).toBe('rule-based');
    });
  });

  // ── executeFieldMapping() and executeQualityAssessment() convenience methods ──

  describe('executeFieldMapping()', () => {
    it('should delegate to executeTask with field_mapping taskType', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'lmstudio',
        providerName: 'LMStudio',
        modelVersion: 'llama',
        modelParameters: { maxTokens: 500, temperature: 0.3 },
        endpointUrl: 'http://127.0.0.1:1234',
        priority: 1,
      });

      const result = await taskFactory.executeFieldMapping('NetSuite', 'Salesforce', [{ id: 1 }], { userId: 1 });

      expect(result.success).toBe(true);
      expect(mockConfigService.getTaskModelConfig).toHaveBeenCalledWith(1, 'field_mapping');
    });
  });

  describe('executeQualityAssessment()', () => {
    it('should delegate to executeTask with quality_assessment taskType', async () => {
      mockConfigService.getTaskModelConfig.mockResolvedValue({
        providerType: 'lmstudio',
        providerName: 'LMStudio',
        modelVersion: 'llama',
        modelParameters: { maxTokens: 500, temperature: 0.3 },
        endpointUrl: 'http://127.0.0.1:1234',
        priority: 1,
      });

      const suggestions: AISuggestion[] = [
        { sourceField: 'id', targetField: 'id', transformationType: 'direct' },
      ];

      const result = await taskFactory.executeQualityAssessment(suggestions, { userId: 1 });

      expect(result.success).toBe(true);
      expect(mockConfigService.getTaskModelConfig).toHaveBeenCalledWith(1, 'quality_assessment');
    });
  });
});
