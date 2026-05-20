import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { SecureCredentialManager } from './SecureCredentialManager';
import type { AuthConfig, IntegrationConfig } from '../types';
import { ConfigurationService } from './ConfigurationService';

export interface SecureSystemConfig {
  systemId: string;
  systemType: string;
  name: string;
  description?: string;
  config: {
    baseUrl?: string;
    apiVersion?: string;
    timeout?: number;
    rateLimit?: {
      requestsPerSecond: number;
      burstLimit: number;
    };
  };
  credentialSource: 'secret_manager' | 'environment' | 'inline';
  credentialMetadata?: {
    rotationPolicy?: {
      enabled: boolean;
      intervalDays: number;
      autoRotate: boolean;
    };
    compliance?: {
      encryptionRequired: boolean;
      auditLogging: boolean;
      accessLogging: boolean;
    };
  };
}

/**
 * Enhanced configuration service with secure credential management
 * Integrates with SecureCredentialManager for enterprise security
 */
@injectable()
export class SecureConfigurationService extends ConfigurationService {
  private readonly credentialManager: SecureCredentialManager;

  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.ConfigDirectory) configDirectory: string,
    @inject(TYPES.SecureCredentialManager) credentialManager: SecureCredentialManager,
  ) {
    super(logger, configDirectory);
    this.credentialManager = credentialManager;
  }

  /**
   * Create a secure integration configuration with credentials stored in secret manager
   */
  async createSecureIntegration(
    integrationConfig: IntegrationConfig,
    sourceSystemConfig: SecureSystemConfig,
    targetSystemConfig: SecureSystemConfig,
    sourceCredentials?: unknown,
    targetCredentials?: unknown,
  ): Promise<void> {
    try {
      // Store credentials securely if provided
      if (sourceCredentials) {
        await this.credentialManager.storeCredentials(
          sourceSystemConfig.systemType,
          sourceSystemConfig.systemId,
          sourceCredentials as any,
        );
      }

      if (targetCredentials) {
        await this.credentialManager.storeCredentials(
          targetSystemConfig.systemType,
          targetSystemConfig.systemId,
          targetCredentials as any,
        );
      }

      // Update integration config to reference secure credentials
      const secureIntegrationConfig = {
        ...integrationConfig,
        sourceSystem: typeof integrationConfig.sourceSystem === 'string'
          ? { type: integrationConfig.sourceSystem, systemId: sourceSystemConfig.systemId, credentialSource: 'secret_manager' as const }
          : { ...integrationConfig.sourceSystem, systemId: sourceSystemConfig.systemId, credentialSource: 'secret_manager' as const },
        targetSystem: typeof integrationConfig.targetSystem === 'string'
          ? { type: integrationConfig.targetSystem, systemId: targetSystemConfig.systemId, credentialSource: 'secret_manager' as const }
          : { ...integrationConfig.targetSystem, systemId: targetSystemConfig.systemId, credentialSource: 'secret_manager' as const },
        security: {
          credentialEncryption: true,
          auditLogging: true,
          credentialRotation: {
            enabled: sourceSystemConfig.credentialMetadata?.rotationPolicy?.enabled || false,
            intervalDays: sourceSystemConfig.credentialMetadata?.rotationPolicy?.intervalDays || 90,
          },
        },
      };

      // Save the secure integration configuration
      await this.saveConfiguration(secureIntegrationConfig);

      this.logger.info('Secure integration created successfully', {
        integrationId: integrationConfig.id,
        sourceSystem: sourceSystemConfig.systemType,
        targetSystem: targetSystemConfig.systemType,
      });
    } catch (error) {
      this.logger.error('Failed to create secure integration', {
        integrationId: integrationConfig.id,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get integration with secure credentials automatically resolved
   */
  async getSecureIntegration(integrationId: string): Promise<IntegrationConfig & { resolvedCredentials: { source?: AuthConfig; target?: AuthConfig } }> {
    const integration = this.getConfiguration(integrationId);
    if (!integration) {
      throw new Error(`Integration ${integrationId} not found`);
    }

    const resolvedCredentials: { source?: AuthConfig; target?: AuthConfig } = {};

    try {
      // Resolve source system credentials
      if (typeof integration.sourceSystem === 'object' && integration.sourceSystem.credentialSource === 'secret_manager') {
        resolvedCredentials.source = await this.credentialManager.getCredentials(
          integration.sourceSystem.type,
          integration.sourceSystem.systemId || 'default',
        );
      }

      // Resolve target system credentials
      if (typeof integration.targetSystem === 'object' && integration.targetSystem.credentialSource === 'secret_manager') {
        resolvedCredentials.target = await this.credentialManager.getCredentials(
          integration.targetSystem.type,
          integration.targetSystem.systemId || 'default',
        );
      }

      return {
        ...integration,
        resolvedCredentials,
      };
    } catch (error) {
      this.logger.error('Failed to resolve secure credentials', {
        integrationId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update credentials for an existing integration
   */
  async updateIntegrationCredentials(
    integrationId: string,
    systemType: 'source' | 'target',
    newCredentials: unknown,
  ): Promise<void> {
    try {
      const integration = this.getConfiguration(integrationId);
      if (!integration) {
        throw new Error(`Integration ${integrationId} not found`);
      }
      const systemConfig = systemType === 'source' ? integration.sourceSystem : integration.targetSystem;

      if (typeof systemConfig === 'object' && systemConfig.credentialSource === 'secret_manager') {
        await this.credentialManager.rotateCredentials(
          systemConfig.type,
          systemConfig.systemId || 'default',
          newCredentials as any,
        );

        this.logger.info('Integration credentials updated successfully', {
          integrationId,
          systemType,
          systemName: systemConfig.type,
        });
      } else {
        throw new Error(`Integration ${integrationId} does not use secret manager for ${systemType} system`);
      }
    } catch (error) {
      this.logger.error('Failed to update integration credentials', {
        integrationId,
        systemType,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get credential health status for all integrations
   */
  async getCredentialHealthStatus(): Promise<{
    totalIntegrations: number;
    credentialsNeedingRotation: number;
    expiredCredentials: number;
    healthyCredentials: number;
    details: {
      integrationId: string;
      systemType: string;
      systemId: string;
      status: 'healthy' | 'needs_rotation' | 'expired';
      daysSinceRotation?: number;
    }[];
  }> {
    const integrations = this.getAllConfigurations();
    const credentialsNeedingRotation = await this.credentialManager.getCredentialsNeedingRotation();

    const details: {
      integrationId: string;
      systemType: string;
      systemId: string;
      status: 'healthy' | 'needs_rotation' | 'expired';
      daysSinceRotation?: number;
    }[] = [];

    let needsRotation = 0;
    let expired = 0;
    let healthy = 0;

    for (const integration of integrations) {
      const systems = [
        { system: integration.sourceSystem, type: 'source' },
        { system: integration.targetSystem, type: 'target' },
      ];

      for (const { system } of systems) {
        if (typeof system === 'object' && system.credentialSource === 'secret_manager') {
          const needsRotationItem = credentialsNeedingRotation.find(
            item => item.systemType === system.type && item.systemId === (system.systemId || 'default'),
          );

          let status: 'healthy' | 'needs_rotation' | 'expired' = 'healthy';
          let daysSinceRotation: number | undefined;

          if (needsRotationItem) {
            daysSinceRotation = needsRotationItem.daysSinceRotation;
            if (daysSinceRotation > 120) { // More than 4 months
              status = 'expired';
              expired++;
            } else {
              status = 'needs_rotation';
              needsRotation++;
            }
          } else {
            healthy++;
          }

          details.push({
            integrationId: integration.id,
            systemType: system.type,
            systemId: system.systemId || 'default',
            status,
            daysSinceRotation,
          });
        }
      }
    }

    return {
      totalIntegrations: integrations.length,
      credentialsNeedingRotation: needsRotation,
      expiredCredentials: expired,
      healthyCredentials: healthy,
      details,
    };
  }

  /**
   * Migrate existing integrations to use secure credential management
   */
  async migrateToSecureCredentials(): Promise<{
    migratedIntegrations: number;
    migratedCredentials: number;
    errors: string[];
  }> {
    const migrationResult = {
      migratedIntegrations: 0,
      migratedCredentials: 0,
      errors: [] as string[],
    };

    try {
      // First migrate credentials from environment variables
      const credentialMigration = await this.credentialManager.migrateFromEnvironment();
      migrationResult.migratedCredentials = credentialMigration.migrated;
      migrationResult.errors.push(...credentialMigration.errors);

      // Then update integration configurations to reference secret manager
      const integrations = this.getAllConfigurations();

      for (const integration of integrations) {
        try {
          let modified = false;
          const updatedIntegration = { ...integration };

          // Update source system to use secret manager if it has inline credentials
          if (integration.authentication?.source) {
            updatedIntegration.sourceSystem = typeof integration.sourceSystem === 'string'
              ? { type: integration.sourceSystem, credentialSource: 'secret_manager' as const }
              : { ...integration.sourceSystem, credentialSource: 'secret_manager' as const };
            if (updatedIntegration.authentication) {
              delete updatedIntegration.authentication.source;
            }
            modified = true;
          }

          // Update target system to use secret manager if it has inline credentials
          if (integration.authentication?.target) {
            updatedIntegration.targetSystem = typeof integration.targetSystem === 'string'
              ? { type: integration.targetSystem, credentialSource: 'secret_manager' as const }
              : { ...integration.targetSystem, credentialSource: 'secret_manager' as const };
            if (updatedIntegration.authentication) {
              delete updatedIntegration.authentication.target;
            }
            modified = true;
          }

          if (modified) {
            await this.saveConfiguration(updatedIntegration);
            migrationResult.migratedIntegrations++;
          }
        } catch (error) {
          const errorMsg = `Failed to migrate integration ${integration.id}: ${error}`;
          migrationResult.errors.push(errorMsg);
          this.logger.error(errorMsg);
        }
      }

      this.logger.info('Secure credential migration completed', {
        migratedIntegrations: migrationResult.migratedIntegrations,
        migratedCredentials: migrationResult.migratedCredentials,
        errors: migrationResult.errors.length,
      });

      return migrationResult;
    } catch (error) {
      this.logger.error('Secure credential migration failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Validate that all integrations have proper credential security
   */
  async validateCredentialSecurity(): Promise<{
    totalIntegrations: number;
    secureIntegrations: number;
    insecureIntegrations: number;
    issues: {
      integrationId: string;
      issue: string;
      severity: 'high' | 'medium' | 'low';
      recommendation: string;
    }[];
  }> {
    const integrations = this.getAllConfigurations();
    const issues: {
      integrationId: string;
      issue: string;
      severity: 'high' | 'medium' | 'low';
      recommendation: string;
    }[] = [];

    let secureIntegrations = 0;
    let insecureIntegrations = 0;

    for (const integration of integrations) {
      let isSecure = true;

      // Check source system credentials
      if (integration.authentication?.source) {
        isSecure = false;
        issues.push({
          integrationId: integration.id,
          issue: 'Source system credentials stored inline in configuration',
          severity: 'high',
          recommendation: 'Migrate credentials to secret manager using migrateToSecureCredentials()',
        });
      }

      // Check target system credentials
      if (integration.authentication?.target) {
        isSecure = false;
        issues.push({
          integrationId: integration.id,
          issue: 'Target system credentials stored inline in configuration',
          severity: 'high',
          recommendation: 'Migrate credentials to secret manager using migrateToSecureCredentials()',
        });
      }

      // Check if using environment variables
      const sourceEnvCheck = typeof integration.sourceSystem === 'object' && integration.sourceSystem.credentialSource === 'environment';
      const targetEnvCheck = typeof integration.targetSystem === 'object' && integration.targetSystem.credentialSource === 'environment';

      if (sourceEnvCheck || targetEnvCheck) {
        isSecure = false;
        issues.push({
          integrationId: integration.id,
          issue: 'System credentials sourced from environment variables',
          severity: 'medium',
          recommendation: 'Switch to secret manager for better security and rotation capabilities',
        });
      }

      // Check for missing security configuration
      if (!integration.security?.credentialEncryption) {
        issues.push({
          integrationId: integration.id,
          issue: 'Credential encryption not enabled',
          severity: 'medium',
          recommendation: 'Enable credential encryption in integration security settings',
        });
      }

      if (!integration.security?.auditLogging) {
        issues.push({
          integrationId: integration.id,
          issue: 'Audit logging not enabled',
          severity: 'low',
          recommendation: 'Enable audit logging for credential access monitoring',
        });
      }

      if (isSecure) {
        secureIntegrations++;
      } else {
        insecureIntegrations++;
      }
    }

    return {
      totalIntegrations: integrations.length,
      secureIntegrations,
      insecureIntegrations,
      issues,
    };
  }
}
