import { SecureCredentialManager } from '../../services/SecureCredentialManager';
import type { SecretManager, SecretValue } from '../../services/SecretManager';
import type { ICredentialMetadataStore } from '../../interfaces/ICredentialMetadataStore';
import type { Logger } from '../../utils/Logger';

class MockLogger {
  constructor(public context: string) {}
  info = jest.fn();
  error = jest.fn();
  warn = jest.fn();
  debug = jest.fn();
  child = jest.fn().mockReturnThis();
  setCorrelationId = jest.fn().mockReturnThis();
}

class MockSecretManager implements Partial<SecretManager> {
  private store = new Map<string, string>();
  async getSecret(secretName: string): Promise<SecretValue> {
    const value = this.store.get(secretName);
    if (value == null) throw new Error('secret not found');
    return { value };
  }
  async setSecret(secretName: string, secretValue: string): Promise<void> {
    this.store.set(secretName, secretValue);
  }
  clearCache(): void {}
}

class MockMetadataStore implements ICredentialMetadataStore {
  private map = new Map<string, any>();
  async loadAll(): Promise<any[]> { return Array.from(this.map.values()); }
  async save(key: string, value: any): Promise<void> { this.map.set(key, value); }
  async delete(key: string): Promise<void> { this.map.delete(key); }
}

describe('SecureCredentialManager', () => {
  const baseEnv = process.env;
  let logger: Logger;
  let secretManager: SecretManager;
  let metadataStore: ICredentialMetadataStore;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...baseEnv };
    logger = new MockLogger('test') as unknown as Logger;
    secretManager = new MockSecretManager() as unknown as SecretManager;
    metadataStore = new MockMetadataStore();
  });

  afterAll(() => {
    process.env = baseEnv;
  });

  it('encrypts on store and decrypts on retrieve when enabled', async () => {
    process.env.ENABLE_CREDENTIAL_ENCRYPTION = 'true';
    process.env.CREDENTIAL_ENCRYPTION_KEY = 'unit-test-key';
    const mgr = new SecureCredentialManager(logger, secretManager, metadataStore);

    const credentials = { clientId: 'abc', clientSecret: 's3cr3t', resourceUrl: 'https://example.com' };
    await mgr.storeCredentials('Salesforce', 'default', credentials as any);

    const authConfig = await mgr.getCredentials('Salesforce', 'default');
    expect(authConfig.type).toBe('oauth2');
    // decrypted secrets should match originals
    expect((authConfig as any).credentials.clientSecret).toBe('s3cr3t');
    expect((authConfig as any).credentials.clientId).toBe('abc');
  });

  it('throws if encryption is enabled without key', async () => {
    process.env.ENABLE_CREDENTIAL_ENCRYPTION = 'true';
    delete process.env.CREDENTIAL_ENCRYPTION_KEY;
    const mgr = new SecureCredentialManager(logger, secretManager, metadataStore);

    await expect(
      mgr.storeCredentials('Salesforce', 'default', { clientId: 'a', clientSecret: 'b' } as any),
    ).rejects.toThrow(/Encryption key not configured/);
  });

  it('rejects on retrieval for unsupported credential type', async () => {
    const mgr = new SecureCredentialManager(logger, secretManager, metadataStore);
    // Store without validation (storeCredentials does not validate shape)
    await mgr.storeCredentials('Unknown', 'x', {} as any);
    await expect(
      mgr.getCredentials('Unknown', 'x'),
    ).rejects.toThrow(/Unsupported credential type|Invalid credentials/);
  });
});
