import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { SecretManager } from './SecretManager';
import type {
  AuthConfig,
  OAuth1Credentials,
  OAuth2Credentials,
  BasicCredentials,
  ApiKeyCredentials,
  CredentialMetadata,
} from '../types';
import type { ICredentialMetadataStore } from '../interfaces/ICredentialMetadataStore';
import { z } from 'zod';

const OAuth1CredentialsSchema = z.object({
  consumerKey: z.string(),
  consumerSecret: z.string(),
  tokenId: z.string(),
  tokenSecret: z.string(),
  accountId: z.string(),
  baseUrl: z.string().optional(),
  base_url: z.string().optional(),
});

const OAuth2CredentialsSchema = z.object({
  clientId: z.string(),
  clientSecret: z.string(),
  tenantId: z.string().optional(),
  tenant_id: z.string().optional(),
  resourceUrl: z.string().optional(),
  resource_url: z.string().optional(),
  baseUrl: z.string().optional(),
  base_url: z.string().optional(),
});

const BasicCredentialsSchema = z.object({
  username: z.string(),
  password: z.string(),
});

const ApiKeyCredentialsSchema = z.object({
  apiKey: z.string(),
  keyName: z.string().optional(),
  keyLocation: z.enum(['header', 'query', 'body']).optional(),
});

export interface SecureCredentialConfig {
  secretManager: {
    provider: 'aws' | 'azure' | 'hashicorp' | 'env';
    region?: string;
    vaultUrl?: string;
    keyVaultName?: string;
    encryptionKey?: string;
  };
  encryptionEnabled: boolean;
  credentialRotationDays?: number;
  auditLogging: boolean;
}

/**
 * Enterprise-grade secure credential management service
 * Handles encrypted storage, rotation, and auditing of system credentials
 */
@injectable()
export class SecureCredentialManager {
  private readonly logger: Logger;
  private readonly secretManager: SecretManager;
  private readonly metadataStore: ICredentialMetadataStore;
  private readonly config: SecureCredentialConfig;
  private readonly credentialMetadata = new Map<string, CredentialMetadata>();
  private readonly metadataLoaded: Promise<void>;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.SecretManager) secretManager: SecretManager,
    @inject(TYPES.CredentialMetadataStore) metadataStore: ICredentialMetadataStore,
  ) {
    this.logger = logger;
    this.secretManager = secretManager;
    this.metadataStore = metadataStore;
    this.config = {
      secretManager: {
        provider: (process.env.SECRET_MANAGER_PROVIDER as any) || 'env',
        region: process.env.AWS_REGION,
        vaultUrl: process.env.VAULT_URL,
        keyVaultName: process.env.AZURE_KEY_VAULT_NAME,
        encryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY,
      },
      encryptionEnabled: process.env.ENABLE_CREDENTIAL_ENCRYPTION === 'true',
      credentialRotationDays: parseInt(process.env.CREDENTIAL_ROTATION_DAYS || '90'),
      auditLogging: process.env.ENABLE_CREDENTIAL_AUDIT_LOGGING !== 'false',
    };

    this.logger.info('SecureCredentialManager initialized', {
      provider: this.config.secretManager.provider,
      encryptionEnabled: this.config.encryptionEnabled,
      auditLogging: this.config.auditLogging,
    });

    this.metadataLoaded = this.loadMetadata();
  }

  private async loadMetadata(): Promise<void> {
    try {
      const stored = await this.metadataStore.loadAll();
      for (const metadata of stored) {
        const key = this.getCredentialKey(metadata.systemType, metadata.systemId);
        this.credentialMetadata.set(key, metadata);
      }
      this.logger.debug('Loaded credential metadata', {
        count: this.credentialMetadata.size,
      });
    } catch (error) {
      this.logger.error('Failed to load credential metadata', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Store system credentials securely
   */
  async storeCredentials(
    systemType: string,
    systemId: string,
    credentials: OAuth1Credentials | OAuth2Credentials | BasicCredentials | ApiKeyCredentials,
  ): Promise<void> {
    await this.metadataLoaded;
    const credentialKey = this.getCredentialKey(systemType, systemId);

    try {
      // Encrypt sensitive data if enabled
      const processedCredentials = this.config.encryptionEnabled
        ? await this.encryptCredentials(credentials)
        : credentials;

      // Store credentials in secret manager
      await this.secretManager.setSecret(
        credentialKey,
        JSON.stringify(processedCredentials),
      );

      // Update metadata
      const metadata: CredentialMetadata = {
        systemType,
        systemId,
        credentialType: this.getCredentialType(credentials),
        lastRotated: new Date(),
        rotationRequired: false,
        accessCount: 0,
      };

      this.credentialMetadata.set(credentialKey, metadata);
      await this.metadataStore.save(credentialKey, metadata);

      if (this.config.auditLogging) {
        this.logger.info('Credentials stored successfully', {
          systemType,
          systemId,
          credentialType: metadata.credentialType,
          encrypted: this.config.encryptionEnabled,
          operation: 'store',
        });
      }
    } catch (error) {
      this.logger.error('Failed to store credentials', {
        systemType,
        systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to store credentials for ${systemType}:${systemId}: ${error}`, { cause: error });
    }
  }

  /**
   * Retrieve system credentials securely
   */
  async getCredentials(systemType: string, systemId: string): Promise<AuthConfig> {
    await this.metadataLoaded;
    const credentialKey = this.getCredentialKey(systemType, systemId);

    try {
      const secretValue = await this.secretManager.getSecret(credentialKey);
      const rawCredentials = JSON.parse(secretValue.value);

      // Decrypt if encryption is enabled
      const credentials = this.config.encryptionEnabled
        ? await this.decryptCredentials(rawCredentials)
        : rawCredentials;

      const validatedCredentials = this.validateCredentials(
        credentials,
        systemType,
        systemId,
      );

      // Update access metadata
      const metadata = this.credentialMetadata.get(credentialKey);
      if (metadata) {
        metadata.lastAccessed = new Date();
        metadata.accessCount++;
        this.credentialMetadata.set(credentialKey, metadata);
        await this.metadataStore.save(credentialKey, metadata);
      }

      if (this.config.auditLogging) {
        this.logger.debug('Credentials retrieved successfully', {
          systemType,
          systemId,
          operation: 'retrieve',
        });
      }

      // Return as AuthConfig format
      return {
        type: this.mapCredentialType(validatedCredentials),
        credentials: validatedCredentials,
      } as AuthConfig;
    } catch (error) {
      this.logger.error('Failed to retrieve credentials', {
        systemType,
        systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(`Failed to retrieve credentials for ${systemType}:${systemId}: ${error}`, { cause: error });
    }
  }

  /**
   * Rotate credentials for a system
   */
  async rotateCredentials(systemType: string, systemId: string, newCredentials: OAuth1Credentials | OAuth2Credentials | BasicCredentials | ApiKeyCredentials): Promise<void> {
    await this.metadataLoaded;
    const credentialKey = this.getCredentialKey(systemType, systemId);

    try {
      // Backup existing credentials
      const backupKey = `${credentialKey}_backup_${Date.now()}`;
      const existingSecret = await this.secretManager.getSecret(credentialKey);
      await this.secretManager.setSecret(backupKey, existingSecret.value);

      // Store new credentials
      await this.storeCredentials(systemType, systemId, newCredentials);

      // Update metadata
      const metadata = this.credentialMetadata.get(credentialKey);
      if (metadata) {
        metadata.lastRotated = new Date();
        metadata.rotationRequired = false;
        this.credentialMetadata.set(credentialKey, metadata);
        await this.metadataStore.save(credentialKey, metadata);
      }

      if (this.config.auditLogging) {
        this.logger.info('Credentials rotated successfully', {
          systemType,
          systemId,
          operation: 'rotate',
          backupKey,
        });
      }
    } catch (error) {
      this.logger.error('Failed to rotate credentials', {
        systemType,
        systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Check which credentials need rotation
   */
  async getCredentialsNeedingRotation(): Promise<{ systemType: string; systemId: string; daysSinceRotation: number }[]> {
    await this.metadataLoaded;
    const needingRotation: { systemType: string; systemId: string; daysSinceRotation: number }[] = [];
    const now = new Date();
    // const rotationThresholdMs = (this.config.credentialRotationDays || 90) * 24 * 60 * 60 * 1000;

    for (const [/*key*/, metadata] of this.credentialMetadata.entries()) {
      if (metadata.lastRotated) {
        const daysSinceRotation = Math.floor((now.getTime() - metadata.lastRotated.getTime()) / (24 * 60 * 60 * 1000));

        if (daysSinceRotation >= (this.config.credentialRotationDays || 90)) {
          needingRotation.push({
            systemType: metadata.systemType,
            systemId: metadata.systemId,
            daysSinceRotation,
          });
        }
      }
    }

    return needingRotation;
  }

  /**
   * Delete credentials for a system
   */
  async deleteCredentials(systemType: string, systemId: string): Promise<void> {
    await this.metadataLoaded;
    const credentialKey = this.getCredentialKey(systemType, systemId);

    try {
      // Note: SecretManager doesn't have delete method, so we clear from cache and metadata
      this.secretManager.clearCache();
      this.credentialMetadata.delete(credentialKey);
      await this.metadataStore.delete(credentialKey);

      if (this.config.auditLogging) {
        this.logger.info('Credentials deleted successfully', {
          systemType,
          systemId,
          operation: 'delete',
        });
      }
    } catch (error) {
      this.logger.error('Failed to delete credentials', {
        systemType,
        systemId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * List all stored credentials (metadata only, no sensitive data)
   */
  async listCredentials(): Promise<CredentialMetadata[]> {
    await this.metadataLoaded;
    return Array.from(this.credentialMetadata.values());
  }

  /**
   * Get credential metadata for a specific system
   */
  async getCredentialMetadata(systemType: string, systemId: string): Promise<CredentialMetadata | undefined> {
    await this.metadataLoaded;
    const credentialKey = this.getCredentialKey(systemType, systemId);
    return this.credentialMetadata.get(credentialKey);
  }

  /**
   * Migrate credentials from environment variables to secret manager
   */
  async migrateFromEnvironment(): Promise<{ migrated: number; errors: string[] }> {
    const migrated: string[] = [];
    const errors: string[] = [];

    // Define mappings from environment variables to system credentials
    const environmentMappings = [
      {
        systemType: 'NetSuite',
        systemId: 'default',
        envVars: {
          accountId: 'NETSUITE_ACCOUNT_ID',
          consumerKey: 'NETSUITE_CONSUMER_KEY',
          consumerSecret: 'NETSUITE_CONSUMER_SECRET',
          tokenId: 'NETSUITE_TOKEN_ID',
          tokenSecret: 'NETSUITE_TOKEN_SECRET',
          baseUrl: 'NETSUITE_BASE_URL',
        },
        credentialType: 'oauth1',
      },
      {
        systemType: 'Dynamics365',
        systemId: 'default',
        envVars: {
          tenantId: 'DYNAMICS_TENANT_ID',
          clientId: 'DYNAMICS_CLIENT_ID',
          clientSecret: 'DYNAMICS_CLIENT_SECRET',
          resourceUrl: 'DYNAMICS_RESOURCE_URL',
        },
        credentialType: 'oauth2',
      },
      {
        systemType: 'Salesforce',
        systemId: 'default',
        envVars: {
          clientId: 'SALESFORCE_CLIENT_ID',
          clientSecret: 'SALESFORCE_CLIENT_SECRET',
          username: 'SALESFORCE_USERNAME',
          password: 'SALESFORCE_PASSWORD',
          securityToken: 'SALESFORCE_SECURITY_TOKEN',
          loginUrl: 'SALESFORCE_LOGIN_URL',
        },
        credentialType: 'oauth2',
      },
    ];

    for (const mapping of environmentMappings) {
      try {
        const credentials: Record<string, string> = {};
        let hasRequiredFields = false;

        // Check if environment variables exist and build credential object
        for (const [credField, envVar] of Object.entries(mapping.envVars)) {
          const value = process.env[envVar];
          if (value) {
            credentials[credField] = value;
            hasRequiredFields = true;
          }
        }

        if (hasRequiredFields) {
          await this.storeCredentials(mapping.systemType, mapping.systemId, credentials as any);
          migrated.push(`${mapping.systemType}:${mapping.systemId}`);

          this.logger.info('Migrated credentials from environment', {
            systemType: mapping.systemType,
            systemId: mapping.systemId,
            fields: Object.keys(credentials),
          });
        }
      } catch (error) {
        const errorMsg = `Failed to migrate ${mapping.systemType}:${mapping.systemId}: ${error}`;
        errors.push(errorMsg);
        this.logger.error(errorMsg);
      }
    }

    return { migrated: migrated.length, errors };
  }

  private getCredentialKey(systemType: string, systemId: string): string {
    return `credentials_${systemType.toLowerCase()}_${systemId.toLowerCase()}`;
  }

  private getCredentialType(credentials: unknown): string {
    if ('consumerKey' in (credentials as object) && 'tokenId' in (credentials as object)) return 'oauth1';
    if ('clientId' in (credentials as object) && 'clientSecret' in (credentials as object)) return 'oauth2';
    if ('username' in (credentials as object) && 'password' in (credentials as object)) return 'basic';
    if ('apiKey' in (credentials as object)) return 'api_key';
    return 'unknown';
  }

  private mapCredentialType(credentials: unknown): 'oauth1' | 'oauth2' | 'basic' | 'api_key' | 'token' | 'certificate' {
    const type = this.getCredentialType(credentials);
    return type as 'oauth1' | 'oauth2' | 'basic' | 'api_key' | 'token' | 'certificate';
  }

  private validateCredentials(
    credentials: unknown,
    systemType: string,
    systemId: string,
  ): OAuth1Credentials | OAuth2Credentials | BasicCredentials | ApiKeyCredentials {
    const credentialType = this.getCredentialType(credentials);
    try {
      switch (credentialType) {
      case 'oauth1':
        return OAuth1CredentialsSchema.parse(credentials);
      case 'oauth2':
        return OAuth2CredentialsSchema.parse(credentials);
      case 'basic':
        return BasicCredentialsSchema.parse(credentials);
      case 'api_key':
        return ApiKeyCredentialsSchema.parse(credentials);
      default:
        throw new Error(`Unsupported credential type: ${credentialType}`);
      }
    } catch (error) {
      if (error instanceof z.ZodError) {
        const messages = error.issues.map(e => e.message).join(', ');
        if (this.config.auditLogging) {
          this.logger.error('Credential validation failed', {
            systemType,
            systemId,
            credentialType,
            errors: error.issues,
            operation: 'validation',
          });
        }
        throw new Error(`Invalid credentials for ${systemType}:${systemId} - ${messages}`, { cause: error });
      }
      throw error;
    }
  }

  private async encryptCredentials(credentials: unknown): Promise<unknown> {
    if (!this.config.secretManager.encryptionKey) {
      throw new Error('Encryption key not configured');
    }

    const crypto = await import('crypto');
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.config.secretManager.encryptionKey, 'salt', 32);

    const encrypted: unknown = {};

    for (const [field, value] of Object.entries(credentials as any)) {
      if (typeof value === 'string' && this.isSensitiveField(field)) {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv(algorithm, key, iv);
        let encryptedValue = cipher.update(value, 'utf8', 'hex');
        encryptedValue += cipher.final('hex');
        const authTag = cipher.getAuthTag();

        (encrypted as any)[field] = {
          encrypted: true,
          value: encryptedValue,
          iv: iv.toString('hex'),
          authTag: authTag.toString('hex'),
        };
      } else {
        (encrypted as any)[field] = value;
      }
    }

    return encrypted;
  }

  private async decryptCredentials(encryptedCredentials: unknown): Promise<unknown> {
    if (!this.config.secretManager.encryptionKey) {
      throw new Error('Encryption key not configured');
    }

    const crypto = await import('crypto');
    const algorithm = 'aes-256-gcm';
    const key = crypto.scryptSync(this.config.secretManager.encryptionKey, 'salt', 32);

    const decrypted: Record<string, unknown> = {};

    for (const [field, value] of Object.entries(encryptedCredentials as Record<string, unknown>)) {
      if (typeof value === 'object' && value && (value as any).encrypted) {
        const encryptedData = value as any;
        const iv = Buffer.from(encryptedData.iv, 'hex');
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        if (encryptedData.authTag) {
          decipher.setAuthTag(Buffer.from(encryptedData.authTag, 'hex'));
        }
        let decryptedValue = decipher.update(encryptedData.value, 'hex', 'utf8');
        decryptedValue += decipher.final('utf8');
        decrypted[field] = decryptedValue;
      } else {
        decrypted[field] = value;
      }
    }

    return decrypted;
  }

  private isSensitiveField(fieldName: string): boolean {
    const sensitiveFields = [
      'password',
      'secret',
      'token',
      'key',
      'clientsecret',
      'consumersecret',
      'tokensecret',
      'securitytoken',
      'privatekey',
      'certificate',
    ];

    return sensitiveFields.some(sensitive =>
      fieldName.toLowerCase().includes(sensitive.toLowerCase()),
    );
  }
}
