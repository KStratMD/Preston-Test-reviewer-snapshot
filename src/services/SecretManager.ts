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

// Structural shape of the dynamically imported AWS Secrets Manager module.
// Only the fields we touch are typed; runtime objects are richer.
interface AwsSecretsManagerModule {
  SecretsManagerClient: new (config: { region?: string }) => {
    send: (cmd: unknown) => Promise<unknown>;
  };
  GetSecretValueCommand: new (input: { SecretId: string; VersionStage?: string }) => unknown;
  PutSecretValueCommand: new (input: { SecretId: string; SecretString: string }) => unknown;
  CreateSecretCommand: new (input: { Name: string; SecretString: string; Description?: string }) => unknown;
  ListSecretsCommand: new (input?: unknown) => unknown;
  DeleteSecretCommand: new (input: { SecretId: string; RecoveryWindowInDays?: number; ForceDeleteWithoutRecovery?: boolean }) => unknown;
}

interface GetSecretValueResponse {
  SecretString?: string;
  VersionId?: string;
  CreatedDate?: Date;
  ARN?: string;
  Name?: string;
}

interface SecretListEntry {
  Name?: string;
}

interface ListSecretsResponse {
  SecretList?: SecretListEntry[];
}

// Structural shape of the dynamically imported Azure Key Vault SDK modules.
interface AzureSecretProperties {
  version?: string;
  updatedOn?: Date;
  id?: string;
}

interface AzureSecret {
  value?: string;
  name: string;
  properties: AzureSecretProperties;
}

interface AzureSecretClient {
  getSecret: (name: string) => Promise<AzureSecret>;
  setSecret: (name: string, value: string) => Promise<unknown>;
  listPropertiesOfSecrets: () => AsyncIterable<{ name: string }>;
  beginDeleteSecret: (name: string) => Promise<{ pollUntilDone: () => Promise<unknown> }>;
}

interface AzureKeyVaultSecretsModule {
  SecretClient: new (vaultUrl: string, credential: unknown) => AzureSecretClient;
}

interface AzureIdentityModule {
  DefaultAzureCredential: new () => unknown;
}

// HashiCorp Vault HTTP API response shape (only what we read).
interface HashiCorpSecretResponse {
  data?: {
    data?: { value?: string };
    metadata?: {
      version?: number;
      created_time?: string;
      [key: string]: unknown;
    };
  };
}

interface HashiCorpListResponse {
  data?: {
    keys?: string[];
  };
}

// Runtime allowlist mirroring the zod enum in src/config/env.ts. We
// can't import env directly here because tests mutate
// process.env.SECRET_MANAGER_PROVIDER per-test and construct a fresh
// SecretManager; env's zod parse runs at module-load time so it would
// freeze the provider before tests can set it.
const ALLOWED_SECRET_PROVIDERS = ['aws', 'azure', 'hashicorp', 'env'] as const;
type SecretManagerProvider = (typeof ALLOWED_SECRET_PROVIDERS)[number];

function isSecretManagerProvider(raw: unknown): raw is SecretManagerProvider {
  return typeof raw === 'string'
    && (ALLOWED_SECRET_PROVIDERS as readonly string[]).includes(raw);
}

function resolveProvider(raw: string | undefined): SecretManagerProvider {
  return isSecretManagerProvider(raw) ? raw : 'env';
}

/**
 * Enterprise secret management service supporting multiple providers
 */
@injectable()
export class SecretManager {
  private readonly logger: Logger;
  private readonly config: SecretManagerConfig;
  private readonly secretCache = new Map<string, { value: SecretValue; cachedAt: Date; ttl: number }>();
  // Monotonic cache epoch bumped by EVERY invalidation (clearCache/setSecret/
  // deleteSecret). A getSecret() snapshots it before fetching and refuses to
  // cache its result if the epoch moved meanwhile — so a read that overlaps any
  // rotate/delete/clear can never repopulate a stale value after eviction. A
  // single global counter deliberately over-invalidates (an unrelated key's
  // change also skips caching an in-flight read) in exchange for covering every
  // invalidation path, including the clear-all and setSecret cases; correctness
  // outranks cache efficiency for secret material.
  private cacheEpoch = 0;
  private readonly defaultCacheTtl = 5 * 60 * 1000; // 5 minutes

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
    this.config = {
      provider: resolveProvider(process.env.SECRET_MANAGER_PROVIDER),
      region: process.env.AWS_REGION || 'us-east-1',
      vaultUrl: process.env.VAULT_URL,
      roleName: process.env.VAULT_ROLE_NAME,
      keyVaultName: process.env.AZURE_KEY_VAULT_NAME,
    };

    this.logger.info('SecretManager initialized', {
      provider: this.config.provider,
      cacheEnabled: true,
    });
  }

  /**
   * Retrieve a secret by name with caching and fallback.
   *
   * Options (all opt-in; defaults preserve historical behavior for every
   * existing caller):
   *   - `bypassCache`: neither READ from nor WRITE to the in-memory cache, so
   *      the secret is never persisted in-process. Used by SuiteCentral secret
   *      resolution, whose contract is "secret is never cached".
   *   - `noEnvFallback`: on a provider read failure, PROPAGATE the error instead
   *      of silently falling back to `process.env[secretName]`, so a provider
   *      outage cannot yield an env-var credential (fail closed).
   *   - `ttl`: cache time-to-live override (ignored when `bypassCache`).
   */
  async getSecret(
    secretName: string,
    options?: { bypassCache?: boolean; ttl?: number; noEnvFallback?: boolean },
  ): Promise<SecretValue> {
    const cacheKey = `${this.config.provider}:${secretName}`;
    const now = new Date();
    // Snapshot the cache epoch BEFORE fetching so we can detect a concurrent
    // invalidation (clearCache/setSecret/deleteSecret) that lands mid-fetch.
    const epochAtStart = this.cacheEpoch;

    // Check cache first (unless bypassed)
    if (!options?.bypassCache) {
      const cached = this.secretCache.get(cacheKey);
      if (cached && (now.getTime() - cached.cachedAt.getTime()) < cached.ttl) {
        this.logger.debug('Secret retrieved from cache', { secretName });
        return cached.value;
      }
    }

    try {
      let secretValue: SecretValue;

      switch (this.config.provider) {
      case 'aws':
        secretValue = await this.getAwsSecret(secretName);
        break;
      case 'azure':
        secretValue = await this.getAzureSecret(secretName);
        break;
      case 'hashicorp':
        secretValue = await this.getHashiCorpSecret(secretName);
        break;
      case 'env':
      default:
        secretValue = await this.getEnvironmentSecret(secretName);
        break;
      }

      // Cache the secret only when caching is not bypassed AND it wasn't
      // invalidated (rotated/deleted/cleared) while this fetch was in flight —
      // otherwise we'd repopulate a stale value (or persist a no-cache secret).
      const cached = !options?.bypassCache && this.cacheEpoch === epochAtStart;
      if (cached) {
        this.secretCache.set(cacheKey, {
          value: secretValue,
          cachedAt: now,
          ttl: options?.ttl || this.defaultCacheTtl,
        });
      }

      this.logger.info('Secret retrieved successfully', {
        secretName,
        provider: this.config.provider,
        cached,
      });

      return secretValue;
    } catch (error) {
      this.logger.error('Failed to retrieve secret', {
        secretName,
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error),
      });

      // Fallback to environment variable — unless the caller opted out
      // (`noEnvFallback`), in which case a provider outage must fail closed
      // rather than silently returning a process.env credential.
      if (this.config.provider !== 'env' && !options?.noEnvFallback) {
        this.logger.warn('Falling back to environment variable', { secretName });
        return this.getEnvironmentSecret(secretName);
      }

      throw error;
    }
  }

  /**
   * Store a secret (for supported providers)
   */
  async setSecret(secretName: string, secretValue: string, options?: { description?: string; metadata?: Record<string, unknown> }): Promise<void> {
    try {
      switch (this.config.provider) {
      case 'aws':
        await this.setAwsSecret(secretName, secretValue, options);
        break;
      case 'azure':
        await this.setAzureSecret(secretName, secretValue, options);
        break;
      case 'hashicorp':
        await this.setHashiCorpSecret(secretName, secretValue, options);
        break;
      case 'env':
      default:
        throw new Error('Environment provider does not support secret storage');
      }

      // Invalidate cache. Bump the epoch too (not just delete) so a getSecret()
      // already in flight for this key cannot re-cache the pre-rotation value.
      this.cacheEpoch += 1;
      const cacheKey = `${this.config.provider}:${secretName}`;
      this.secretCache.delete(cacheKey);

      this.logger.info('Secret stored successfully', {
        secretName,
        provider: this.config.provider,
      });
    } catch (error) {
      this.logger.error('Failed to store secret', {
        secretName,
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Rotate a secret (generate new value and update)
   */
  async rotateSecret(secretName: string, generator?: () => string): Promise<SecretValue> {
    const newValue = generator ? generator() : this.generateSecureSecret();

    await this.setSecret(secretName, newValue, {
      description: `Rotated on ${new Date().toISOString()}`,
      metadata: { rotated: true, rotatedAt: new Date().toISOString() },
    });

    return this.getSecret(secretName, { bypassCache: true });
  }

  /**
   * List all secrets (names only for security)
   */
  async listSecrets(): Promise<string[]> {
    try {
      switch (this.config.provider) {
      case 'aws':
        return this.listAwsSecrets();
      case 'azure':
        return this.listAzureSecrets();
      case 'hashicorp':
        return this.listHashiCorpSecrets();
      case 'env':
      default:
        return this.listEnvironmentSecrets();
      }
    } catch (error) {
      this.logger.error('Failed to list secrets', {
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Permanently delete a secret from the backing provider, then evict it from
   * cache. AWS uses a 7-day recovery window (not force-delete); Azure awaits the
   * soft-delete poll; HashiCorp KV v2 deletes the metadata path so ALL versions
   * are removed. The `env` provider does not support deletion and rejects
   * without mutating process.env. Secret values / provider bodies are never
   * logged.
   */
  async deleteSecret(secretName: string): Promise<void> {
    try {
      switch (this.config.provider) {
        case 'aws':
          await this.deleteAwsSecret(secretName);
          break;
        case 'azure':
          await this.deleteAzureSecret(secretName);
          break;
        case 'hashicorp':
          await this.deleteHashiCorpSecret(secretName);
          break;
        case 'env':
          throw new Error('Environment provider does not support secret deletion');
      }
    } catch (error) {
      // Log and rethrow, consistent with getSecret/setSecret. Never log secret
      // values or provider response bodies — only the error message.
      this.logger.error('Failed to delete secret', {
        secretName,
        provider: this.config.provider,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
    this.clearCache(secretName);
    this.logger.info('Secret deletion completed', { secretName, provider: this.config.provider });
  }

  private async deleteAwsSecret(secretName: string): Promise<void> {
    let awsModule: unknown;
    try {
      awsModule = await import('@aws-sdk/client-secrets-manager');
    } catch {
      throw new Error('AWS SDK not available. Install @aws-sdk/client-secrets-manager to use AWS Secrets Manager.');
    }
    const { SecretsManagerClient, DeleteSecretCommand } = awsModule as AwsSecretsManagerModule;
    const client = new SecretsManagerClient({ region: this.config.region });
    // Recovery window (not ForceDeleteWithoutRecovery) so an accidental deletion
    // is recoverable within 7 days.
    await client.send(new DeleteSecretCommand({ SecretId: secretName, RecoveryWindowInDays: 7 }));
  }

  private async deleteAzureSecret(secretName: string): Promise<void> {
    let secretsModule: unknown;
    let identityModule: unknown;
    try {
      secretsModule = await import('@azure/keyvault-secrets');
      identityModule = await import('@azure/identity');
    } catch {
      throw new Error('Azure SDK not available. Install @azure/keyvault-secrets and @azure/identity to use Azure Key Vault.');
    }
    const { SecretClient } = secretsModule as AzureKeyVaultSecretsModule;
    const { DefaultAzureCredential } = identityModule as AzureIdentityModule;
    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${this.config.keyVaultName}.vault.azure.net/`, credential);
    const poller = await client.beginDeleteSecret(secretName);
    await poller.pollUntilDone();
  }

  private async deleteHashiCorpSecret(secretName: string): Promise<void> {
    // KV v2: delete the METADATA path so every version is removed, not just the
    // latest data version. secretName is interpolated raw (not URL-encoded) to
    // match getHashiCorpSecret/setHashiCorpSecret and preserve nested KV paths
    // (encoding `/` as %2F would target the wrong path).
    const response = await fetch(`${this.config.vaultUrl}/v1/secret/metadata/${secretName}`, {
      method: 'DELETE',
      headers: {
        'X-Vault-Token': process.env.VAULT_TOKEN || '',
        'Content-Type': 'application/json',
      },
    });
    if (!response.ok) {
      throw new Error(`Vault API error: ${response.status} ${response.statusText}`);
    }
  }

  /**
   * Clear secret cache
   */
  clearCache(secretName?: string): void {
    // Bump the epoch so any in-flight getSecret() won't re-cache the value it
    // fetched before this eviction (covers single-key and clear-all alike).
    this.cacheEpoch += 1;
    if (secretName) {
      const cacheKey = `${this.config.provider}:${secretName}`;
      this.secretCache.delete(cacheKey);
      this.logger.debug('Secret cache cleared', { secretName });
    } else {
      this.secretCache.clear();
      this.logger.debug('All secret cache cleared');
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.secretCache.size,
      keys: Array.from(this.secretCache.keys()),
    };
  }

  // AWS Secrets Manager implementation
  private async getAwsSecret(secretName: string): Promise<SecretValue> {
    try {
      // Dynamic import to avoid dependency issues when AWS SDK not available
      let awsModule: unknown;
      try {
        awsModule = await import('@aws-sdk/client-secrets-manager');
      } catch {
        throw new Error('AWS SDK not available. Install @aws-sdk/client-secrets-manager to use AWS Secrets Manager.');
      }
      const { SecretsManagerClient, GetSecretValueCommand } = awsModule as AwsSecretsManagerModule;

      const client = new SecretsManagerClient({
        region: this.config.region,
        // Use IAM roles in production, avoid hardcoded credentials
      });

      const command = new GetSecretValueCommand({ SecretId: secretName });
      const response = (await client.send(command)) as GetSecretValueResponse;

      return {
        value: response.SecretString || '',
        version: response.VersionId,
        lastUpdated: response.CreatedDate,
        metadata: {
          arn: response.ARN,
          name: response.Name,
        },
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        throw new Error(`Secret '${secretName}' not found in AWS Secrets Manager`, { cause: error });
      }
      throw error;
    }
  }

  private async setAwsSecret(secretName: string, secretValue: string, options?: { description?: string; metadata?: Record<string, unknown> }): Promise<void> {
    let awsModule: unknown;
    try {
      awsModule = await import('@aws-sdk/client-secrets-manager');
    } catch {
      throw new Error('AWS SDK not available. Install @aws-sdk/client-secrets-manager to use AWS Secrets Manager.');
    }
    const { SecretsManagerClient, PutSecretValueCommand, CreateSecretCommand } = awsModule as AwsSecretsManagerModule;

    const client = new SecretsManagerClient({ region: this.config.region });

    try {
      // Try to update existing secret
      const putCommand = new PutSecretValueCommand({
        SecretId: secretName,
        SecretString: secretValue,
      });
      await client.send(putCommand);
    } catch (error) {
      if (error instanceof Error && error.name === 'ResourceNotFoundException') {
        // Create new secret
        const createCommand = new CreateSecretCommand({
          Name: secretName,
          SecretString: secretValue,
          Description: options?.description,
        });
        await client.send(createCommand);
      } else {
        throw error;
      }
    }
  }

  private async listAwsSecrets(): Promise<string[]> {
    let awsModule: unknown;
    try {
      awsModule = await import('@aws-sdk/client-secrets-manager');
    } catch {
      throw new Error('AWS SDK not available. Install @aws-sdk/client-secrets-manager to use AWS Secrets Manager.');
    }
    const { SecretsManagerClient, ListSecretsCommand } = awsModule as AwsSecretsManagerModule;

    const client = new SecretsManagerClient({ region: this.config.region });
    const command = new ListSecretsCommand({});
    const response = (await client.send(command)) as ListSecretsResponse;

    return response.SecretList?.map((secret) => secret.Name || '') || [];
  }

  // Azure Key Vault implementation
  private async getAzureSecret(secretName: string): Promise<SecretValue> {
    try {
      let secretsModule: unknown;
      let identityModule: unknown;
      try {
        secretsModule = await import('@azure/keyvault-secrets');
        identityModule = await import('@azure/identity');
      } catch {
        throw new Error('Azure SDK not available. Install @azure/keyvault-secrets and @azure/identity to use Azure Key Vault.');
      }
      const { SecretClient } = secretsModule as AzureKeyVaultSecretsModule;
      const { DefaultAzureCredential } = identityModule as AzureIdentityModule;

      const credential = new DefaultAzureCredential();
      const client = new SecretClient(`https://${this.config.keyVaultName}.vault.azure.net/`, credential);

      const secret = await client.getSecret(secretName);

      return {
        value: secret.value || '',
        version: secret.properties.version,
        lastUpdated: secret.properties.updatedOn,
        metadata: {
          id: secret.properties.id,
          name: secret.name,
        },
      };
    } catch (error) {
      throw new Error(`Failed to retrieve secret from Azure Key Vault: ${error}`, { cause: error });
    }
  }

  private async setAzureSecret(secretName: string, secretValue: string, _options?: { description?: string }): Promise<void> {
    let secretsModule: unknown;
    let identityModule: unknown;
    try {
      secretsModule = await import('@azure/keyvault-secrets');
      identityModule = await import('@azure/identity');
    } catch {
      throw new Error('Azure SDK not available. Install @azure/keyvault-secrets and @azure/identity to use Azure Key Vault.');
    }
    const { SecretClient } = secretsModule as AzureKeyVaultSecretsModule;
    const { DefaultAzureCredential } = identityModule as AzureIdentityModule;

    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${this.config.keyVaultName}.vault.azure.net/`, credential);

    await client.setSecret(secretName, secretValue);
  }

  private async listAzureSecrets(): Promise<string[]> {
    let secretsModule: unknown;
    let identityModule: unknown;
    try {
      secretsModule = await import('@azure/keyvault-secrets');
      identityModule = await import('@azure/identity');
    } catch {
      throw new Error('Azure SDK not available. Install @azure/keyvault-secrets and @azure/identity to use Azure Key Vault.');
    }
    const { SecretClient } = secretsModule as AzureKeyVaultSecretsModule;
    const { DefaultAzureCredential } = identityModule as AzureIdentityModule;

    const credential = new DefaultAzureCredential();
    const client = new SecretClient(`https://${this.config.keyVaultName}.vault.azure.net/`, credential);

    const secrets: string[] = [];
    for await (const secretProperties of client.listPropertiesOfSecrets()) {
      secrets.push(secretProperties.name);
    }

    return secrets;
  }

  // HashiCorp Vault implementation
  private async getHashiCorpSecret(secretName: string): Promise<SecretValue> {
    try {
      const response = await fetch(`${this.config.vaultUrl}/v1/secret/data/${secretName}`, {
        headers: {
          'X-Vault-Token': process.env.VAULT_TOKEN || '',
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`Vault API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as HashiCorpSecretResponse;

      return {
        value: data.data?.data?.value || '',
        version: data.data?.metadata?.version?.toString(),
        lastUpdated: data.data?.metadata?.created_time ? new Date(data.data.metadata.created_time) : undefined,
        metadata: data.data?.metadata,
      };
    } catch (error) {
      throw new Error(`Failed to retrieve secret from HashiCorp Vault: ${error}`, { cause: error });
    }
  }

  private async setHashiCorpSecret(secretName: string, secretValue: string, options?: { description?: string; metadata?: Record<string, unknown> }): Promise<void> {
    const response = await fetch(`${this.config.vaultUrl}/v1/secret/data/${secretName}`, {
      method: 'POST',
      headers: {
        'X-Vault-Token': process.env.VAULT_TOKEN || '',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        data: {
          value: secretValue,
          description: options?.description,
          ...options?.metadata,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Vault API error: ${response.status} ${response.statusText}`);
    }
  }

  private async listHashiCorpSecrets(): Promise<string[]> {
    const response = await fetch(`${this.config.vaultUrl}/v1/secret/metadata?list=true`, {
      headers: {
        'X-Vault-Token': process.env.VAULT_TOKEN || '',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Vault API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as HashiCorpListResponse;
    return data.data?.keys || [];
  }

  // Environment variable fallback
  private async getEnvironmentSecret(secretName: string): Promise<SecretValue> {
    const value = process.env[secretName];
    if (!value) {
      throw new Error(`Environment variable '${secretName}' not found`);
    }

    return {
      value,
      metadata: { source: 'environment' },
    };
  }

  private async listEnvironmentSecrets(): Promise<string[]> {
    // Return common secret environment variables
    const secretKeys = Object.keys(process.env).filter(key =>
      key.includes('SECRET') ||
      key.includes('KEY') ||
      key.includes('TOKEN') ||
      key.includes('PASSWORD'),
    );

    return secretKeys;
  }

  /**
   * Generate a cryptographically secure secret
   */
  private generateSecureSecret(length = 64): string {
    const crypto = require('crypto');
    return crypto.randomBytes(length).toString('base64').slice(0, length);
  }
}
