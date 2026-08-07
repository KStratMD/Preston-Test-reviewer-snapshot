import { injectable, inject, optional } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { SecureCredentialManager } from './SecureCredentialManager';
import type { AuthConfig, ApiKeyCredentials, BasicCredentials, IntegrationConfig, OAuth1Credentials, OAuth2Credentials } from '../types';
import type { ConfigurationCommandContext } from '../types/cardinality';
import {
  ConfigurationService,
  type CardinalityActivationGate,
  type ConfigurationActivationGuard,
} from './ConfigurationService';

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
    @optional() @inject(TYPES.CardinalityActivationGate) cardinality?: CardinalityActivationGate,
    @optional() @inject(TYPES.ConfigurationActivationGuard) activationGuard?: ConfigurationActivationGuard,
  ) {
    // Threads the SAME optional activation gate AND pre-activation guard
    // ConfigurationService takes, so secure saves (createSecureIntegration /
    // migrateToSecureCredentials, plus the inherited activateConfigurationForTenant,
    // all routed through the inherited saveConfiguration) are authorized through
    // the identical gate/guard as plain saves rather than always hitting the
    // inherited fail-closed path (no gate bound -> ServiceUnavailableAppError on
    // ACTIVE) or silently never running a later-bound guard.
    super(logger, configDirectory, cardinality, activationGuard);
    this.credentialManager = credentialManager;
  }

  /**
   * Create a secure integration configuration with credentials stored in secret manager.
   *
   * `context` is REQUIRED (Task 8, design 'secure_save' operation kind): this
   * method can persist an active configuration through `saveConfiguration`, so
   * it must always carry trusted command context — unlike `ConfigurationService`
   * itself, which stays optional so drafts remain gate-free at the type level.
   * Placed before the still-optional credential params (TS requires required
   * params ahead of optional ones).
   */
  async createSecureIntegration(
    integrationConfig: IntegrationConfig,
    sourceSystemConfig: SecureSystemConfig,
    targetSystemConfig: SecureSystemConfig,
    context: ConfigurationCommandContext,
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
      await this.saveConfiguration(secureIntegrationConfig, context);

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
   * Get integration with secure credentials automatically resolved.
   * Tenant-scoped: only resolves a config owned by `tenantId` (PR-1 — was the
   * deprecated tenant-agnostic getConfiguration(id) lookup).
   */
  async getSecureIntegration(tenantId: string, integrationId: string): Promise<IntegrationConfig & { resolvedCredentials: { source?: AuthConfig; target?: AuthConfig } }> {
    const integration = this.getConfigurationForTenant(tenantId, integrationId);
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
   * Update credentials for an existing integration.
   * Tenant-scoped: only resolves a config owned by `tenantId` (PR-1).
   */
  async updateIntegrationCredentials(
    tenantId: string,
    integrationId: string,
    systemType: 'source' | 'target',
    newCredentials: unknown,
  ): Promise<void> {
    try {
      const integration = this.getConfigurationForTenant(tenantId, integrationId);
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
   * Migrate existing integrations to use secure credential management.
   *
   * `context` is REQUIRED (Task 8, 'secure_save' operation kind) — this is a
   * cross-tenant admin sweep over EVERY stored integration, so the tenantId on
   * the passed-in base context is not itself used for the gate check; each
   * active member's save is authorized with a per-iteration context whose
   * `tenantId` is overridden to that member's own tenant (mirrors
   * `ConfigurationService.importAll`'s bulk-restore pattern) — a cross-tenant
   * sweep must never be attributable to one caller-chosen tenant.
   */
  async migrateToSecureCredentials(context: ConfigurationCommandContext): Promise<{
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

      // Credential references must never be persisted unless the underlying
      // secret migration completed cleanly. Leaving legacy inline credentials
      // in place is safer than writing metadata that points at missing secrets.
      if (credentialMigration.errors.length > 0) {
        return migrationResult;
      }

      // Then update integration configurations to reference secret manager
      const integrations = this.getAllConfigurations();

      for (const integration of integrations) {
        try {
          let modified = false;
          const updatedIntegration: IntegrationConfig = {
            ...integration,
            authentication: integration.authentication
              ? { ...integration.authentication }
              : integration.authentication,
          };
          const sourceAuth = integration.sourceAuthentication ?? integration.authentication?.source;
          const targetAuth = integration.targetAuthentication ?? integration.authentication?.target;
          let migratedCredentialsForIntegration = 0;

          if (sourceAuth || targetAuth) {
            this.assertMigratableSystem(integration.sourceSystem);
            this.assertMigratableSystem(integration.targetSystem);
          }

          if (sourceAuth) {
            updatedIntegration.sourceSystem = await this.storeMigratedCredentials(integration.sourceSystem, sourceAuth);
            delete updatedIntegration.sourceAuthentication;
            if (updatedIntegration.authentication) {
              updatedIntegration.authentication = { ...updatedIntegration.authentication };
              delete updatedIntegration.authentication.source;
            }
            migratedCredentialsForIntegration++;
            modified = true;
          }

          if (targetAuth) {
            updatedIntegration.targetSystem = await this.storeMigratedCredentials(integration.targetSystem, targetAuth);
            delete updatedIntegration.targetAuthentication;
            if (updatedIntegration.authentication) {
              updatedIntegration.authentication = { ...updatedIntegration.authentication };
              delete updatedIntegration.authentication.target;
            }
            migratedCredentialsForIntegration++;
            modified = true;
          }

          if (modified && updatedIntegration.authentication && Object.keys(updatedIntegration.authentication).length === 0) {
            delete updatedIntegration.authentication;
          }

          if (modified) {
            if (!sourceAuth) updatedIntegration.sourceSystem = this.toEnvironmentReference(updatedIntegration.sourceSystem);
            if (!targetAuth) updatedIntegration.targetSystem = this.toEnvironmentReference(updatedIntegration.targetSystem);
            const iterationContext: ConfigurationCommandContext = { ...context, tenantId: integration.tenantId };
            await this.saveConfiguration(updatedIntegration, iterationContext);
            migrationResult.migratedIntegrations++;
            migrationResult.migratedCredentials += migratedCredentialsForIntegration;
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

  private async storeMigratedCredentials(
    system: IntegrationConfig['sourceSystem'],
    auth: AuthConfig,
  ): Promise<IntegrationConfig['sourceSystem']> {
    this.assertMigratableSystem(system);
    const systemType = system.type;
    const systemId = system.systemId.trim();
    type CredentialPayload = OAuth1Credentials | OAuth2Credentials | BasicCredentials | ApiKeyCredentials;
    await this.credentialManager.storeCredentials(
      systemType,
      systemId,
      auth.credentials as unknown as CredentialPayload,
    );
    return { type: systemType, systemId, credentialSource: 'secret_manager' };
  }

  private assertMigratableSystem(
    system: IntegrationConfig['sourceSystem'],
  ): asserts system is Exclude<IntegrationConfig['sourceSystem'], string> & { systemId: string } {
    if (
      typeof system === 'string'
      || !system.systemId?.trim()
      || system.systemId !== system.systemId.trim()
    ) {
      throw new Error('Managed credential migration requires an explicit systemId');
    }
  }

  private toEnvironmentReference(system: IntegrationConfig['sourceSystem']): IntegrationConfig['sourceSystem'] {
    this.assertMigratableSystem(system);
    if (system.credentialSource) return system;
    return { type: system.type, systemId: system.systemId.trim(), credentialSource: 'environment' };
  }

  /**
   * Validate that all integrations have proper credential security.
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
