import { ModelCatalogService } from '../../../src/services/ai/ModelCatalogService';
import { Logger } from '../../../src/utils/Logger';
import { ProviderRegistry } from '../../../src/services/ai/ProviderRegistry';

class StubDynamicProvider {
  id = 'grok';
  private _model: string | undefined;
  setModel(m: string) { this._model = m; }
  getModel() { return this._model; }
  getCapabilities() { return { dynamicModelSwitching: true }; }
}

describe('ModelCatalogService (multi-provider extension)', () => {
  const logger = new Logger('Test');

  function createService(overrides: Partial<NodeJS.ProcessEnv> = {}) {
    const original = { ...process.env };
    Object.assign(process.env, overrides);
    const svc = new ModelCatalogService(logger as any, undefined, undefined, undefined as any);
    return { svc, restore: () => { process.env = original; } };
  }

  test('fallback lists: grok, gemini, lmstudio, openrouter', async () => {
    const { svc, restore } = createService();
    try {
      const grok = await svc.listModels('grok');
      const gemini = await svc.listModels('gemini');
      const lm = await svc.listModels('lmstudio');
      const openrouter = await svc.listModels('openrouter');
      expect(grok.find(m => m.id.startsWith('grok'))).toBeTruthy();
      expect(gemini.find(m => m.id.includes('gemini-1.5-flash'))).toBeTruthy();
      expect(lm.length).toBeGreaterThan(0);
      expect(openrouter.find(m => m.id === 'openrouter/free')).toBeTruthy();
    } finally { restore(); }
  });

  test('setActiveModel returns error for uninitialized provider', async () => {
    const { svc, restore } = createService();
    try {
    const result = await svc.setActiveModel('grok', 'grok-beta');
    expect(result.ok).toBe(false);
    // Implementation may return different phrasing; accept either
    expect(result.message).toMatch(/not (registered|initialized)/i);
    } finally { restore(); }
  });

  test('listModels caches results (cache hit path)', async () => {
    const { svc, restore } = createService();
    try {
      const first = await svc.listModels('gemini');
      const second = await svc.listModels('gemini');
      expect(first).toBe(second); // same reference due to cache hit
    } finally { restore(); }
  });

  test('setActiveModel succeeds when provider supports dynamic switching via registry', async () => {
    const logger = new Logger('Test');
    const registry = new ProviderRegistry(logger as any);
    const stub = new StubDynamicProvider();
    (registry as any).providers.set('grok', stub);
    const svc = new ModelCatalogService(logger as any, undefined, undefined, registry as any);
    const result = await svc.setActiveModel('grok', 'grok-beta');
    expect(result.ok).toBe(true);
    expect(stub.getModel()).toBe('grok-beta');
  });

  test('setActiveModel succeeds for openrouter when provider supports dynamic switching via registry', async () => {
    const logger = new Logger('Test');
    const registry = new ProviderRegistry(logger as any);
    const stub = new StubDynamicProvider();
    (registry as any).providers.set('openrouter', stub);
    const svc = new ModelCatalogService(logger as any, undefined, undefined, registry as any);
    const result = await svc.setActiveModel('openrouter', 'anthropic/claude-3.5-sonnet');
    expect(result.ok).toBe(true);
    expect(stub.getModel()).toBe('anthropic/claude-3.5-sonnet');
  });
});
