import { ModelCatalogService } from '../../../src/services/ai/ModelCatalogService';
import { Logger } from '../../../src/utils/Logger';
import { ProviderRegistry } from '../../../src/services/ai/ProviderRegistry';

/**
 * Verifies dynamic capability cache reuse: second aggregate call within TTL should
 * NOT rebuild capability structures (we infer by object identity + duration heuristic).
 */

describe('ModelCatalogService dynamic capability cache reuse', () => {
  const logger = new Logger('Test');

  test('second dynamic aggregate reuses cached capabilities object', async () => {
    const registry = new ProviderRegistry(logger as any);
    const svc = new ModelCatalogService(logger as any, undefined, undefined, registry as any);

    // Prime model list (so first aggregate isn't spent enumerating providers only)
    await svc.listModels('openai');

    const t1 = Date.now();
    const first = await svc.aggregate(false, true); // dynamic
    const firstCaps = first.providers.openai?.capabilities;
    expect(firstCaps).toBeTruthy();

    const t2 = Date.now();
    const second = await svc.aggregate(false, true); // should hit dynamic cache
    const t3 = Date.now();

    const secondCaps = second.providers.openai?.capabilities;
    expect(secondCaps).toBeTruthy();

    // Expect the same keys and (likely) same object identity for at least one model entry
    const modelKeys = Object.keys(firstCaps || {});
    expect(modelKeys.length).toBeGreaterThan(0);
    const sampleKey = modelKeys[0];
    expect(secondCaps![sampleKey]).toBe(firstCaps![sampleKey]);

    // Duration heuristic: second call should be faster (not a strict requirement but indicative)
    const firstDuration = t2 - t1;
    const secondDuration = t3 - t2;
    // Allow noisy environments; just assert second isn't drastically slower
    expect(secondDuration).toBeLessThanOrEqual(firstDuration * 2);
  });
});
