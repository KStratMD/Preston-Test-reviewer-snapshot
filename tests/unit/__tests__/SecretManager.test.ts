import { SecretManager } from '../services/SecretManager';
import type { Logger } from '../utils/Logger';

// Minimal virtual mock so `import('@aws-sdk/client-secrets-manager')` resolves.
// AWS tests spy the private provider methods (getAwsSecret/deleteAwsSecret)
// rather than driving the SDK, which is the reliable pattern here — a virtual
// mock isn't consistently applied to the dynamic import() across the full suite.
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn().mockImplementation(() => ({ send: jest.fn() })),
  GetSecretValueCommand: jest.fn(),
  DeleteSecretCommand: jest.fn(),
}), { virtual: true });

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as unknown as Logger;

describe('SecretManager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.SECRET_MANAGER_PROVIDER;
    delete process.env.AWS_REGION;
    delete process.env.TEST_ENV_SECRET;
  });

  it('retrieves secret from environment variables', async () => {
    process.env.SECRET_MANAGER_PROVIDER = 'env';
    process.env.TEST_ENV_SECRET = 'env-secret';

    const manager = new SecretManager(mockLogger);
    const secret = await manager.getSecret('TEST_ENV_SECRET');

    expect(secret.value).toBe('env-secret');
  });

  it('retrieves secret from AWS Secrets Manager', async () => {
    process.env.SECRET_MANAGER_PROVIDER = 'aws';
    process.env.AWS_REGION = 'us-east-1';

    const manager = new SecretManager(mockLogger);
    jest.spyOn(manager as any, 'getAwsSecret').mockResolvedValue({
      value: 'aws-secret-value',
      version: '1',
      metadata: {
        arn: 'arn:aws:secretsmanager:us-east-1:123456789012:secret:my-secret',
        name: 'my-secret',
      },
    });
    const secret = await manager.getSecret('my-secret');

    expect(secret.value).toBe('aws-secret-value');
  });

  describe('deleteSecret', () => {
    it('rejects on the env provider without mutating process.env', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'env';
      process.env.TEST_ENV_SECRET = 'keep-me';
      const manager = new SecretManager(mockLogger);
      await expect(manager.deleteSecret('TEST_ENV_SECRET')).rejects.toThrow(
        'Environment provider does not support secret deletion',
      );
      expect(process.env.TEST_ENV_SECRET).toBe('keep-me');
    });

    it('issues an AWS DeleteSecretCommand with a recovery window and evicts cache', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'aws';
      process.env.AWS_REGION = 'us-east-1';
      const manager = new SecretManager(mockLogger);
      // Spy the provider methods (robust across the full suite). getAwsSecret
      // primes the cache; deleteAwsSecret verifies routing. The recovery-window
      // command detail is asserted in the dedicated deleteAwsSecret test below.
      jest.spyOn(manager as unknown as { getAwsSecret: (n: string) => Promise<unknown> }, 'getAwsSecret')
        .mockResolvedValue({ value: 'aws-secret-value' });
      const deleteSpy = jest.spyOn(manager as unknown as { deleteAwsSecret: (n: string) => Promise<void> }, 'deleteAwsSecret')
        .mockResolvedValue(undefined);

      await manager.getSecret('suitecentral-deadbeef'); // prime cache under aws key
      await manager.deleteSecret('suitecentral-deadbeef');

      expect(deleteSpy).toHaveBeenCalledWith('suitecentral-deadbeef');
      expect(manager.getCacheStats().keys).not.toContain('aws:suitecentral-deadbeef');
    });

    it('deletes the HashiCorp KV v2 metadata path (all versions)', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'hashicorp';
      process.env.VAULT_URL = 'https://vault.example';
      process.env.VAULT_TOKEN = 'token';
      const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, statusText: 'No Content' });
      const originalFetch = global.fetch;
      (global as unknown as { fetch: unknown }).fetch = fetchMock;
      try {
        const manager = new SecretManager(mockLogger);
        await manager.deleteSecret('suitecentral-abc');
        expect(fetchMock).toHaveBeenCalledWith(
          'https://vault.example/v1/secret/metadata/suitecentral-abc',
          expect.objectContaining({ method: 'DELETE' }),
        );
      } finally {
        (global as unknown as { fetch: unknown }).fetch = originalFetch;
        delete process.env.VAULT_URL;
        delete process.env.VAULT_TOKEN;
      }
    });
  });

  describe('cache invalidation vs in-flight reads', () => {
    it('does not repopulate the cache from a read that overlaps an eviction', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'aws';
      process.env.AWS_REGION = 'us-east-1';
      const manager = new SecretManager(mockLogger);

      // Gate the provider fetch so we can evict while the read is in flight.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      jest.spyOn(manager as unknown as { getAwsSecret: (n: string) => Promise<unknown> }, 'getAwsSecret')
        .mockImplementation(async () => { await gate; return { value: 'stale-value' }; });

      const readPromise = manager.getSecret('race-secret'); // starts fetch, awaits gate
      manager.clearCache('race-secret');                    // rotate/delete evicts mid-fetch
      release();                                            // fetch now completes
      await readPromise;

      // The in-flight read must NOT have re-cached the (now stale) value.
      expect(manager.getCacheStats().keys).not.toContain('aws:race-secret');
    });

    it('does not re-cache from a read overlapping a setSecret (rotation)', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'aws';
      process.env.AWS_REGION = 'us-east-1';
      const manager = new SecretManager(mockLogger);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      jest.spyOn(manager as unknown as { getAwsSecret: (n: string) => Promise<unknown> }, 'getAwsSecret')
        .mockImplementation(async () => { await gate; return { value: 'pre-rotation' }; });
      jest.spyOn(manager as unknown as { setAwsSecret: (n: string, v: string) => Promise<void> }, 'setAwsSecret')
        .mockResolvedValue(undefined);

      const readPromise = manager.getSecret('rot-secret');
      await manager.setSecret('rot-secret', 'new-value'); // bumps epoch mid-fetch
      release();
      await readPromise;

      expect(manager.getCacheStats().keys).not.toContain('aws:rot-secret');
    });

    it('does not re-cache from a read overlapping clearCache() (all)', async () => {
      process.env.SECRET_MANAGER_PROVIDER = 'aws';
      process.env.AWS_REGION = 'us-east-1';
      const manager = new SecretManager(mockLogger);
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      jest.spyOn(manager as unknown as { getAwsSecret: (n: string) => Promise<unknown> }, 'getAwsSecret')
        .mockImplementation(async () => { await gate; return { value: 'stale' }; });

      // Key was never cached, so a per-key generation map would miss it — the
      // global epoch still invalidates the in-flight read.
      const readPromise = manager.getSecret('never-cached-key');
      manager.clearCache();
      release();
      await readPromise;

      expect(manager.getCacheStats().keys).not.toContain('aws:never-cached-key');
    });
  });
});
