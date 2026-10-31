import { ModelCatalogService } from '../../../src/services/ai/ModelCatalogService';
import { Logger } from '../../../src/utils/Logger';
import { ProviderRegistry, type AIProvider } from '../../../src/services/ai/ProviderRegistry';

class StubProvider {
  id: string; name='Stub'; version='1.0.0';
  constructor(id: string){ this.id = id; }
  testConnection(){ return Promise.resolve({ ok: true }); }
  generateMappingSuggestions(){ return Promise.resolve([] as any); }
  analyzeDataQuality(){ return Promise.resolve({ overallScore: 0, issues: [], recommendations: [] }); }
  private _model: string | undefined;
  setModel(m: string){ this._model = m; }
  getModel(){ return this._model; }
}

describe('ModelCatalogService.aggregate', () => {
  const logger = new Logger('Test');

  test('returns providers block with capability index and active summary', async () => {
    const registry = new ProviderRegistry(logger as any);
    const svc = new ModelCatalogService(logger as any, undefined, undefined, registry as any);
    // prime cache by listing one provider
    await svc.listModels('openai');
    const agg = await svc.aggregate(false);
    expect(agg.providers).toBeTruthy();
    expect(agg.providers.openai).toBeTruthy();
    expect(agg.providers.openai.capabilities).toBeTruthy();
    // capability object should have at least one known model entry if fallback used
    const caps = agg.providers.openai.capabilities;
    const hasAny = Object.keys(caps).length > 0;
    expect(hasAny).toBe(true);
    expect(agg.active).toBeDefined();
  });

  test('uses provider registry fallback order for active provider summary', async () => {
    const registry = new ProviderRegistry(logger);
    const dynamicProvider = {
      name: 'Gemini Test Provider',
      version: 'test',
      testConnection: jest.fn().mockResolvedValue({ ok: true }),
      generateMappingSuggestions: jest.fn().mockResolvedValue([]),
      analyzeDataQuality: jest.fn().mockResolvedValue({ overallScore: 0, issues: [], recommendations: [] }),
      getModel: jest.fn().mockReturnValue('gemini-1.5-pro'),
    } satisfies AIProvider & { getModel(): string | undefined };

    registry.register('gemini', dynamicProvider);
    registry.setFallbackOrder(['gemini', 'openai']);

    const svc = new ModelCatalogService(logger, undefined, undefined, registry);
    const agg = await svc.aggregate(false);

    expect(agg.active?.provider).toBe('gemini');
    expect(agg.active?.model).toBe('gemini-1.5-pro');
    expect(agg.activeModels.gemini).toBe('gemini-1.5-pro');
    expect(Object.keys(agg.providers)).toEqual(['openai', 'anthropic', 'grok', 'gemini', 'lmstudio', 'openrouter']);
  });
});
