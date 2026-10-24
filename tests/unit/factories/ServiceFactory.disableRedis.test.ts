/**
 * ServiceFactory cache gate — DISABLE_REDIS normalization (#1102).
 *
 * createCacheService() gated on a raw `process.env.DISABLE_REDIS` read, which
 * is truthy for ANY non-empty string. docker-compose sets DISABLE_REDIS=0 to
 * mean "Redis enabled", so the deployed compose stack silently returned null
 * here — no cache — while the queue subsystem connected to the very same
 * healthy Redis. This pins both directions of the normalized read.
 *
 * env is parsed once at import, so each case resets the module registry and
 * re-imports rather than mutating an already-parsed value.
 */

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */

const loadFactory = (disableRedis: string) => {
  jest.resetModules();
  process.env.DISABLE_REDIS = disableRedis;
  return require('../../../src/factories/ServiceFactory').ServiceFactory;
};

describe('ServiceFactory.createCacheService — DISABLE_REDIS normalization', () => {
  const original = process.env.DISABLE_REDIS;

  afterAll(() => {
    if (original === undefined) {
      delete process.env.DISABLE_REDIS;
    } else {
      process.env.DISABLE_REDIS = original;
    }
    jest.resetModules();
  });

  it.each(['0', 'false'])(
    'loads CacheService when DISABLE_REDIS=%s (Redis is enabled)',
    async (value) => {
      const ServiceFactory = loadFactory(value);
      // The regression: these values used to be truthy and suppress the cache.
      await expect(ServiceFactory.createCacheService()).resolves.not.toBeNull();
    },
  );

  it.each(['1', 'true'])(
    'returns null when DISABLE_REDIS=%s (Redis is disabled)',
    async (value) => {
      const ServiceFactory = loadFactory(value);
      await expect(ServiceFactory.createCacheService()).resolves.toBeNull();
    },
  );
});
