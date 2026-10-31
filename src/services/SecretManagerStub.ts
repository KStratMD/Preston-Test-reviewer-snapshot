import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';

export interface SecretManagerConfig {
  provider: 'aws' | 'azure' | 'hashicorp' | 'env';
  region?: string;
  vaultUrl?: string;
  roleName?: string;
  keyVaultName?: string;
}

export interface SecretValue {
  value: string;
  version?: string;
  lastUpdated?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Stub implementation of SecretManager for basic environment variable support
 */
@injectable()
export class SecretManager {
  private readonly logger: Logger;
  private readonly config: SecretManagerConfig;

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    this.config = {
      provider: 'env',
    };

    this.logger.info('SecretManager initialized with environment variable support only');
  }

  async getSecret(secretName: string): Promise<SecretValue> {
    const value = process.env[secretName];
    if (!value) {
      throw new Error(`Environment variable '${secretName}' not found`);
    }

    return {
      value,
      metadata: { source: 'environment' },
    };
  }

  async setSecret(_secretName: string, _secretValue: string): Promise<void> {
    throw new Error('Environment provider does not support secret storage');
  }

  async rotateSecret(_secretName: string): Promise<SecretValue> {
    throw new Error('Environment provider does not support secret rotation');
  }

  async listSecrets(): Promise<string[]> {
    return Object.keys(process.env).filter(key =>
      key.includes('SECRET') ||
      key.includes('KEY') ||
      key.includes('TOKEN') ||
      key.includes('PASSWORD'),
    );
  }

  clearCache(): void {
    // No cache in stub implementation
  }

  getCacheStats(): { size: number; keys: string[] } {
    return { size: 0, keys: [] };
  }
}
