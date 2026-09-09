import { ModelCatalogService } from '../../../src/services/ai/ModelCatalogService';
import { Logger } from '../../../src/utils/Logger';
import { ProviderRegistry, type AIProvider } from '../../../src/services/ai/ProviderRegistry';

// Lightweight test verifying dynamic capability introspection enriches models
// and caches results (cache hit path should not throw and should return same structure).

describe('ModelCatalogService.dynamicCapabilities', () => {
  const logger = new Logger('Test');

  test('aggregate with dynamic=true returns capability supports blocks', async () => {
    const registry = new ProviderRegistry(logger);
    const svc = new ModelCatalogService(logger, undefined, undefined, registry);
    // prime: list openai to populate cache & baseline
    await svc.listModels('openai');
    const agg = await svc.aggregate(false, true);
    expect(agg.providers.openai.capabilities).toBeTruthy();
    const caps = agg.providers.openai.capabilities;
    const firstKey = Object.keys(caps)[0];
    expect(firstKey).toBeTruthy();
    expect(caps[firstKey].supports).toBeTruthy();
    // second call should reuse cached dynamic capabilities for at least one model
    const agg2 = await svc.aggregate(false, true);
    expect(Object.keys(agg2.providers.openai.capabilities).length).toBeGreaterThan(0);
  });

  test('falls back to static capabilities when dynamic provider shape is malformed', async () => {
    const registry = new ProviderRegistry(logger);
    const malformedProvider = {
      name: 'Malformed Test Provider',
      version: 'test',
      testConnection: jest.fn().mockResolvedValue({ ok: true }),
      generateMappingSuggestions: jest.fn().mockResolvedValue([]),
      analyzeDataQuality: jest.fn().mockResolvedValue({ overallScore: 0, issues: [], recommendations: [] }),
      introspectCapabilities: jest.fn().mockResolvedValue({
        supports: 'not-a-support-map',
        contextWindow: 'wide',
      }),
    } satisfies AIProvider & { introspectCapabilities(modelId: string): Promise<unknown> };
    registry.register('grok', malformedProvider);

    const svc = new ModelCatalogService(logger, undefined, undefined, registry);
    const agg = await svc.aggregate(false, true);
    const caps = agg.providers.grok.capabilities['grok-beta'];

    expect(caps.supports).toEqual(expect.objectContaining({ toolUse: true }));
    expect(caps.contextWindow).toBe(128000);
  });

  test('uses valid dynamic provider capabilities over static metadata', async () => {
    const registry = new ProviderRegistry(logger);
    const dynamicProvider = {
      name: 'Dynamic Test Provider',
      version: 'test',
      testConnection: jest.fn().mockResolvedValue({ ok: true }),
      generateMappingSuggestions: jest.fn().mockResolvedValue([]),
      analyzeDataQuality: jest.fn().mockResolvedValue({ overallScore: 0, issues: [], recommendations: [] }),
      introspectCapabilities: jest.fn().mockResolvedValue({
        contextWindow: 42,
        supports: {
          vision: true,
          jsonMode: true,
          toolUse: false,
          streaming: false,
          reasoning: true,
        },
      }),
    } satisfies AIProvider & { introspectCapabilities(modelId: string): Promise<unknown> };
    registry.register('grok', dynamicProvider);

    const svc = new ModelCatalogService(logger, undefined, undefined, registry);
    const agg = await svc.aggregate(false, true);
    const caps = agg.providers.grok.capabilities['grok-beta'];
    const model = agg.providers.grok.models.find(entry => entry.id === 'grok-beta');

    expect(caps.contextWindow).toBe(42);
    expect(caps.supports).toEqual({
      vision: true,
      jsonMode: true,
      toolUse: false,
      streaming: false,
      reasoning: true,
    });
    expect(model?.supports).toEqual(['vision', 'jsonMode', 'reasoning']);
    expect(model?.contextWindow).toBe(42);
  });
});
