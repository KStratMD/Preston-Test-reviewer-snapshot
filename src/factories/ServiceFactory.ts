import type { IObservabilityService } from '../observability';
import { isOtelEnabled } from '../utils/features';
import { logger } from '../utils/Logger';
import type { CacheOptions, CacheStats } from '../performance/CacheService';

type CacheServiceConstructor = typeof import('../performance/CacheService').CacheService;
type CacheServiceContract = {
  initialize(): Promise<void>;
  get<T>(key: string, options?: CacheOptions): Promise<T | null>;
  set<T>(key: string, value: T, options?: CacheOptions): Promise<void>;
  delete(key: string, options?: CacheOptions): Promise<void>;
  getOrSet<T>(key: string, factory: () => Promise<T>, options?: CacheOptions): Promise<T>;
  increment(key: string, by?: number, options?: CacheOptions): Promise<number>;
  getMultiple<T>(keys: string[], options?: CacheOptions): Promise<Map<string, T | null>>;
  setMultiple<T>(entries: { key: string; value: T }[], options?: CacheOptions): Promise<void>;
  clearByPattern(pattern: string, namespace?: string): Promise<number>;
  getStats(): Promise<CacheStats>;
  flush(): Promise<void>;
};

/**
 * Factory for creating services with conditional loading and proper error handling
 */
export class ServiceFactory {
  /**
   * Creates an ObservabilityService instance if OTEL is enabled, otherwise returns null
   */
  static async createObservabilityService(): Promise<IObservabilityService | null> {
    if (!isOtelEnabled()) {
      return null;
    }

    try {
      const [{ ObservabilityService }, { observabilityConfig }] = await Promise.all([
        import('../observability'),
        import('../config/observability')
      ]);
      
  const service = new ObservabilityService(observabilityConfig);
      await service.initialize();
  return service;
    } catch (error) {
      logger.warn('Failed to load ObservabilityService:', error);
      return null;
    }
  }

  /**
   * Creates a demo observability adapter for lightweight/demo mode
   */
  static async createDemoObservabilityAdapter(): Promise<IObservabilityService> {
    try {
      const { DemoObservabilityAdapter } = await import('../observability/demoObservabilityAdapter');
      const adapter = new DemoObservabilityAdapter();
      await adapter.initialize();
      return adapter;
    } catch (error) {
      // Fallback to minimal shim if adapter fails to load
      const noOpLogger = {
        info: (..._args: unknown[]) => {},
        warn: (..._args: unknown[]) => {},
        error: (..._args: unknown[]) => {},
        debug: (..._args: unknown[]) => {},
        child: (_ctx: unknown) => noOpLogger,
        getLogger: () => noOpLogger,
        createChildLogger: (_context: unknown) => noOpLogger,
        flush: async () => {},
        shutdown: async () => {},
      };
      
      const noOpMetrics = {
        recordIntegrationRun: () => {},
        recordAuthenticationAttempt: () => {},
        recordTransformation: () => {},
        recordConnectorOperation: () => {},
        recordWebhookEvent: () => {},
        setActiveIntegrations: () => {},
        incrementActiveIntegrations: () => {},
        decrementActiveIntegrations: () => {},
        setQueueDepth: () => {},
        updateConnectionPoolSize: () => {},
        updateMemoryUsage: () => {},
        createTimer: () => ({ end: () => 0 }),
        recordCustomMetric: () => {},
        getSystemMetrics: () => ({ memoryUsage: process.memoryUsage(), uptime: process.uptime(), cpuUsage: process.cpuUsage() }),
      };
      
      const noOpTracing = {
        initialize: async () => {},
        shutdown: async () => {},
        createSpan: () => ({ end: () => {} }),
        traceOperation: async (_name: string, op: () => Promise<unknown>) => op(),
        addSpanAttributes: () => {},
        recordSpanEvent: () => {},
        getCurrentTraceId: (): string | undefined => undefined,
        getCurrentSpanId: (): string | undefined => undefined,
      };
      
      return {
        initialize: async () => {},
        shutdown: async () => {},
        logging: noOpLogger,
        metrics: noOpMetrics,
        tracing: noOpTracing,
        createScope: () => ({
          logger: noOpLogger,
          metrics: noOpMetrics,
          tracing: noOpTracing,
        })
      } as unknown as IObservabilityService;
    }
  }

  /**
   * Creates a SecretManager instance or returns a mock for demo mode
   */
  static async createSecretManager(): Promise<any> {
    try {
      const { SecretManager } = await import('../services/SecretManager');
      return SecretManager;
    } catch (error) {
      // Return mock SecretManager for demo mode
      return class MockSecretManager {
        async getSecret(): Promise<never> { 
          throw new Error('SecretManager not available in demo mode'); 
        }
        async setSecret(): Promise<never> { 
          throw new Error('SecretManager not available in demo mode'); 
        }
        async rotateSecret(): Promise<never> { 
          throw new Error('SecretManager not available in demo mode'); 
        }
        async listSecrets(): Promise<string[]> { 
          return []; 
        }
        clearCache(): void { 
          /* no-op */ 
        }
        getCacheStats(): { size: number; keys: string[] } { 
          return { size: 0, keys: [] }; 
        }
      };
    }
  }

  /**
   * Creates a CacheService instance if Redis is not disabled, otherwise returns null
   */
  static async createCacheService(): Promise<CacheServiceConstructor | null> {
    if (process.env.DISABLE_REDIS) {
      return null;
    }

    try {
      const { CacheService } = await import('../performance/CacheService');
      return CacheService;
    } catch (error) {
      logger.warn('Failed to load CacheService:', error);
      return null;
    }
  }

  /**
   * Creates a no-op cache service for demo environments
   */
  static createNoOpCacheService(): CacheServiceContract {
    return {
      async initialize(): Promise<void> { return; },
      async get<T>(_key: string, _options: CacheOptions = {}): Promise<T | null> { return null; },
      async set<T>(_key: string, _value: T, _options: CacheOptions = {}): Promise<void> { return; },
      async delete(_key: string, _options: CacheOptions = {}): Promise<void> { return; },
      async getOrSet<T>(_key: string, factory: () => Promise<T>, _options: CacheOptions = {}): Promise<T> {
        return factory();
      },
      async increment(_key: string, _by = 1, _options: CacheOptions = {}): Promise<number> { return 0; },
      async getMultiple<T>(keys: string[], _options: CacheOptions = {}): Promise<Map<string, T | null>> {
        return new Map(keys.map(key => [key, null] as [string, T | null]));
      },
      async setMultiple<T>(_entries: { key: string; value: T }[], _options: CacheOptions = {}): Promise<void> { return; },
      async clearByPattern(_pattern: string, _namespace?: string): Promise<number> { return 0; },
      async getStats(): Promise<CacheStats> {
        return {
          hits: 0,
          misses: 0,
          hitRate: 0,
          totalOperations: 0,
          memoryUsage: 0,
          keyCount: 0,
        };
      },
      async flush(): Promise<void> { return; },
    };
  }
}