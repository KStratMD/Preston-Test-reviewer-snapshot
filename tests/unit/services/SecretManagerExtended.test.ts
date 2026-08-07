/**
 * Comprehensive unit tests for SecretManager
 * Covers: getSecret (env mode), setSecret, rotateSecret, listSecrets,
 *         clearCache, getCacheStats, caching behavior, error handling
 */
import 'reflect-metadata';
import { SecretManager } from '../../../src/services/SecretManager';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

describe('SecretManager', () => {
  let manager: SecretManager;
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset env to defaults (no special provider configured = 'env' mode)
    process.env = { ...originalEnv };
    delete process.env.SECRET_MANAGER_PROVIDER;
    process.env.TEST_SECRET = 'test-value';
    process.env.MY_API_KEY = 'api-key-123';
    process.env.DB_PASSWORD = 'db-pass';
    process.env.JWT_SECRET = 'jwt-secret';
    manager = new SecretManager(mockLogger);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('constructor', () => {
    it('should initialize with env provider by default', () => {
      expect(manager).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('SecretManager initialized', expect.objectContaining({
        provider: 'env',
      }));
    });

    it('should fall back to env provider when SECRET_MANAGER_PROVIDER is invalid', () => {
      jest.clearAllMocks();
      process.env.SECRET_MANAGER_PROVIDER = 'not-a-real-provider';
      const fresh = new SecretManager(mockLogger);
      expect(fresh).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('SecretManager initialized', expect.objectContaining({
        provider: 'env',
      }));
    });

    it('should fall back to env provider when SECRET_MANAGER_PROVIDER is empty string', () => {
      jest.clearAllMocks();
      process.env.SECRET_MANAGER_PROVIDER = '';
      const fresh = new SecretManager(mockLogger);
      expect(fresh).toBeDefined();
      expect(mockLogger.info).toHaveBeenCalledWith('SecretManager initialized', expect.objectContaining({
        provider: 'env',
      }));
    });
  });

  describe('getSecret (env mode)', () => {
    it('should retrieve a secret from environment', async () => {
      const secret = await manager.getSecret('TEST_SECRET');
      expect(secret.value).toBe('test-value');
      expect(secret.metadata).toEqual({ source: 'environment' });
    });

    it('should throw for non-existent env variable', async () => {
      await expect(manager.getSecret('NONEXISTENT_VAR'))
        .rejects.toThrow("Environment variable 'NONEXISTENT_VAR' not found");
    });

    it('should cache secrets', async () => {
      const first = await manager.getSecret('TEST_SECRET');
      const second = await manager.getSecret('TEST_SECRET');
      expect(first.value).toBe(second.value);
      // Second call should use cache - only one info log about retrieval
      const retrievalCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Secret retrieved successfully'
      );
      expect(retrievalCalls.length).toBe(1);
    });

    it('should bypass cache when requested', async () => {
      await manager.getSecret('TEST_SECRET');
      await manager.getSecret('TEST_SECRET', { bypassCache: true });
      const retrievalCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Secret retrieved successfully'
      );
      expect(retrievalCalls.length).toBe(2);
    });

    it('a bypassCache read neither populates nor reads the cache (Finding 3)', async () => {
      // A pure bypassCache read must not leave the secret in-process.
      await manager.getSecret('TEST_SECRET', { bypassCache: true });
      expect(manager.getCacheStats().keys).not.toContain('env:TEST_SECRET');

      // Even with a value already cached, a bypassCache read fetches fresh
      // rather than returning the cached copy.
      await manager.getSecret('TEST_SECRET');            // populates cache
      expect(manager.getCacheStats().keys).toContain('env:TEST_SECRET');
      jest.clearAllMocks();
      await manager.getSecret('TEST_SECRET', { bypassCache: true });
      const retrievalCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Secret retrieved successfully'
      );
      expect(retrievalCalls.length).toBe(1); // fetched, not served from cache
    });

    it('should use custom TTL', async () => {
      await manager.getSecret('TEST_SECRET', { ttl: 1 }); // 1ms TTL
      // Wait for TTL to expire
      await new Promise(r => setTimeout(r, 10));
      await manager.getSecret('TEST_SECRET');
      const retrievalCalls = mockLogger.info.mock.calls.filter(
        (c: any[]) => c[0] === 'Secret retrieved successfully'
      );
      expect(retrievalCalls.length).toBe(2);
    });
  });

  describe('setSecret (env mode)', () => {
    it('should throw for env provider', async () => {
      await expect(manager.setSecret('NEW_SECRET', 'value'))
        .rejects.toThrow('Environment provider does not support secret storage');
    });
  });

  describe('rotateSecret', () => {
    it('should throw for env provider (cannot set)', async () => {
      await expect(manager.rotateSecret('TEST_SECRET'))
        .rejects.toThrow('Environment provider does not support secret storage');
    });
  });

  describe('listSecrets', () => {
    it('should list environment secrets containing SECRET/KEY/TOKEN/PASSWORD', async () => {
      const secrets = await manager.listSecrets();
      expect(secrets).toContain('TEST_SECRET');
      expect(secrets).toContain('MY_API_KEY');
      expect(secrets).toContain('DB_PASSWORD');
      expect(secrets).toContain('JWT_SECRET');
    });
  });

  describe('clearCache', () => {
    it('should clear specific secret from cache', async () => {
      await manager.getSecret('TEST_SECRET');
      manager.clearCache('TEST_SECRET');
      expect(mockLogger.debug).toHaveBeenCalledWith('Secret cache cleared', { secretName: 'TEST_SECRET' });
    });

    it('should clear all cache', async () => {
      await manager.getSecret('TEST_SECRET');
      await manager.getSecret('MY_API_KEY');
      manager.clearCache();
      expect(mockLogger.debug).toHaveBeenCalledWith('All secret cache cleared');
    });
  });

  describe('getCacheStats', () => {
    it('should return empty stats initially', () => {
      const stats = manager.getCacheStats();
      expect(stats.size).toBe(0);
      expect(stats.keys).toEqual([]);
    });

    it('should return stats after caching', async () => {
      await manager.getSecret('TEST_SECRET');
      await manager.getSecret('MY_API_KEY');
      const stats = manager.getCacheStats();
      expect(stats.size).toBe(2);
      expect(stats.keys.length).toBe(2);
    });

    it('should reflect cache clear', async () => {
      await manager.getSecret('TEST_SECRET');
      manager.clearCache();
      const stats = manager.getCacheStats();
      expect(stats.size).toBe(0);
    });
  });

  describe('AWS provider mode', () => {
    it('should throw when AWS SDK not available', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'aws';
      const awsManager = new SecretManager(mockLogger);
      await expect(awsManager.getSecret('test'))
        .rejects.toThrow();
    });
  });

  describe('Azure provider mode', () => {
    it('should throw when Azure SDK not available', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'azure';
      const azureManager = new SecretManager(mockLogger);
      await expect(azureManager.getSecret('test'))
        .rejects.toThrow();
    });
  });

  describe('HashiCorp provider mode', () => {
    it('should fail without vault URL', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'hashicorp';
      const vaultManager = new SecretManager(mockLogger);
      await expect(vaultManager.getSecret('test'))
        .rejects.toThrow();
    });
  });

  describe('fallback behavior', () => {
    it('should fallback to env when non-env provider fails', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'hashicorp';
      process.env.TEST_FALLBACK = 'fallback-value';
      const vaultManager = new SecretManager(mockLogger);
      const secret = await vaultManager.getSecret('TEST_FALLBACK');
      expect(secret.value).toBe('fallback-value');
      expect(mockLogger.warn).toHaveBeenCalledWith('Falling back to environment variable', { secretName: 'TEST_FALLBACK' });
    });

    it('propagates the provider error instead of falling back when noEnvFallback is set (Finding 4)', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'hashicorp';
      process.env.TEST_FALLBACK = 'fallback-value'; // present, but must NOT be returned
      const vaultManager = new SecretManager(mockLogger);

      // A provider outage with an env var present must fail closed, not leak the
      // env credential.
      await expect(vaultManager.getSecret('TEST_FALLBACK', { noEnvFallback: true })).rejects.toThrow();
      expect(mockLogger.warn).not.toHaveBeenCalledWith(
        'Falling back to environment variable',
        { secretName: 'TEST_FALLBACK' },
      );
    });
  });
});
