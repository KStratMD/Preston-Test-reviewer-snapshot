import { CacheService } from '../../src/performance/CacheService';
import { Logger } from '../../src/utils/Logger';
import Redis from 'ioredis';

jest.mock('ioredis', () => {
  const MockRedis = jest.fn().mockImplementation(() => {
    const store = new Map<string, { value: string; expires?: number }>();
    return {
      on: jest.fn(),
      get: jest.fn(async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (entry.expires && Date.now() > entry.expires) {
          store.delete(key);
          return null;
        }
        return entry.value;
      }),
      setex: jest.fn(async (key: string, ttl: number, value: string) => {
        store.set(key, { value, expires: Date.now() + ttl * 1000 });
        return 'OK';
      }),
      del: jest.fn(async (key: string) => {
        return store.delete(key) ? 1 : 0;
      }),
    };
  });
  return { __esModule: true, default: MockRedis };
});

describe('CacheService', () => {
  let cache: CacheService;
  let redis: any;

  beforeEach(() => {
    const logger = new Logger('test');
    cache = new CacheService(logger);
    redis = new (Redis as any)();
    (cache as any).redis = redis;
    (cache as any).memoryCache.clear();
  });

  it('stores and retrieves values from L1 cache without hitting Redis', async () => {
    await cache.set('foo', 'bar');
    expect(redis.setex).toHaveBeenCalled();

    redis.get.mockClear();
    const value = await cache.get<string>('foo');
    expect(value).toBe('bar');
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('falls back to Redis when L1 cache misses and then caches in L1', async () => {
    await cache.set('foo', 'bar');
    (cache as any).memoryCache.clear();

    const first = await cache.get<string>('foo');
    expect(first).toBe('bar');
    expect(redis.get).toHaveBeenCalledTimes(1);

    const second = await cache.get<string>('foo');
    expect(second).toBe('bar');
    expect(redis.get).toHaveBeenCalledTimes(1); // L1 hit
  });

  it('deletes values from both caches', async () => {
    await cache.set('foo', 'bar');
    await cache.delete('foo');

    expect((cache as any).memoryCache.has('default:foo')).toBe(false);
    expect(redis.del).toHaveBeenCalledWith('default:foo');
    const value = await cache.get<string>('foo');
    expect(value).toBeNull();
  });

  it('expires values after TTL', async () => {
    jest.useFakeTimers();
    await cache.set('temp', 'val', { ttl: 1 });
    jest.advanceTimersByTime(1100);
    const value = await cache.get<string>('temp');
    expect(value).toBeNull();
    jest.useRealTimers();
  });

  it('handles compression option path', async () => {
    await cache.set('comp', 'data', { compress: true });
    const value = await cache.get<string>('comp', { compress: true });
    expect(value).toBe('data');
    expect(redis.setex).toHaveBeenCalled();
  });
});
