import { SecureCredentialManager } from '../services/SecureCredentialManager';
import type { CredentialMetadata } from '../types';
import type { ICredentialMetadataStore } from '../interfaces/ICredentialMetadataStore';
import type { SecretValue } from '../services/SecretManager';
import type { Logger } from '../utils/Logger';

// Mock logger for testing
const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis(),
} as unknown as Logger;

class MockMetadataStore implements ICredentialMetadataStore {
  public data = new Map<string, CredentialMetadata>();
  loadAll = jest.fn(async () => Array.from(this.data.values()));
  save = jest.fn(async (key: string, metadata: CredentialMetadata) => {
    this.data.set(key, metadata);
  });
  delete = jest.fn(async (key: string) => {
    this.data.delete(key);
  });
}

class MockSecretManager {
  private store = new Map<string, string>();
  async getSecret(key: string): Promise<SecretValue> {
    const value = this.store.get(key);
    if (value === undefined) {
      throw new Error('not found');
    }
    return { value };
  }
  async setSecret(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
  clearCache(): void {}
}

describe('SecureCredentialManager metadata persistence', () => {
  it('loads metadata from external store on initialization', async () => {
    const metadataStore = new MockMetadataStore();
    metadataStore.data.set('credentials_test_default', {
      systemType: 'test',
      systemId: 'default',
      credentialType: 'basic',
      rotationRequired: false,
      accessCount: 0,
    });

    const manager = new SecureCredentialManager(
      mockLogger,
      new MockSecretManager() as any,
      metadataStore,
    );

    const list = await manager.listCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]!).toBeDefined();
    expect(list[0]!.systemType).toBe('test');
  });

  it('persists metadata changes when credentials are stored and accessed', async () => {
    const metadataStore = new MockMetadataStore();
    const secretManager = new MockSecretManager();
    const manager = new SecureCredentialManager(
      mockLogger,
      secretManager as any,
      metadataStore,
    );

    await manager.storeCredentials('Test', '1', { username: 'u', password: 'p' });
    expect(metadataStore.save).toHaveBeenCalled();

    await manager.getCredentials('Test', '1');
    const key = 'credentials_test_1';
    const metadata = metadataStore.data.get(key)!;
    expect(metadata.accessCount).toBe(1);
    expect(metadataStore.save).toHaveBeenCalledTimes(2);
  });
});
