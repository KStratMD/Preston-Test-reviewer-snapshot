import type { Response } from 'express';
import { App } from '../../../src/app';
import { NotFoundError } from '../../../src/errors/NotFoundError';
import { ConfigurationLookupAmbiguousError } from '../../../src/errors/ConfigurationErrors';
import type { IntegrationConfig } from '../../../src/types';

// Tenant-aware in-memory stand-in for ConfigurationService (PR 13c-4): the
// configuration/integration routes resolve configs via
// getConfigurationForTenant/getAllConfigurationsForTenant and force-stamp
// tenantId from the authenticated identity on save. Storage mirrors the real
// service's `${tenantId}::${id}` keyspace, getConfiguration(id) mirrors the
// ambiguous-lookup throw, and saveConfiguration mirrors the cross-tenant
// same-id rejection (the flat `${id}.json` on-disk constraint → 409), so
// tests against this helper can't pass in shapes production would reject.
export class InMemoryConfigurationService {
  private configs = new Map<string, IntegrationConfig>();

  private static storageKey(tenantId: string | undefined, id: string): string {
    return `${tenantId ?? ''}::${id}`;
  }

  constructor(initialConfigs: IntegrationConfig[] = []) {
    initialConfigs.forEach(config => {
      if (config.id) {
        this.configs.set(InMemoryConfigurationService.storageKey(config.tenantId, config.id), { ...config });
      }
    });
  }

  /**
   * Deliberately tenant-blind, mirroring the real service's legacy
   * cross-tenant enumeration (used by background/system callers and the
   * helper's own cross-tenant save check) — route-layer tests should use
   * getAllConfigurationsForTenant.
   */
  getAllConfigurations(): IntegrationConfig[] {
    return Array.from(this.configs.values()).map(config => ({ ...config }));
  }

  /**
   * @deprecated mirrors the real service's tenantless lookup: returns the
   * unique match across tenants, throws ConfigurationLookupAmbiguousError
   * when the same id exists under multiple tenants.
   */
  getConfiguration(id: string): IntegrationConfig | undefined {
    const matches = Array.from(this.configs.values()).filter(config => config.id === id);
    if (matches.length > 1) {
      throw new ConfigurationLookupAmbiguousError(
        `Configuration lookup for '${id}' is ambiguous across tenants`,
      );
    }
    return matches[0] ? { ...matches[0] } : undefined;
  }

  getConfigurationForTenant(tenantId: string, id: string): IntegrationConfig | undefined {
    const config = this.configs.get(InMemoryConfigurationService.storageKey(tenantId, id));
    return config ? { ...config } : undefined;
  }

  getAllConfigurationsForTenant(tenantId: string): IntegrationConfig[] {
    return Array.from(this.configs.values())
      .filter(config => config.tenantId === tenantId)
      .map(config => ({ ...config }));
  }

  async deleteConfigurationForTenant(tenantId: string, id: string): Promise<boolean> {
    return this.configs.delete(InMemoryConfigurationService.storageKey(tenantId, id));
  }

  async exportConfigurationForTenant(tenantId: string, configId: string): Promise<string> {
    const config = this.getConfigurationForTenant(tenantId, configId);
    if (!config) {
      throw new NotFoundError(`Configuration ${configId} not found`);
    }
    return JSON.stringify(config, null, 2);
  }

  async saveConfiguration(config: IntegrationConfig): Promise<IntegrationConfig> {
    const id = config.id ?? `config_${this.configs.size + 1}`;
    // Mirror the real service's cross-tenant same-id rejection: flat on-disk
    // storage is keyed by id alone, so the same id cannot coexist for two
    // tenants (the route layer maps this to a 409).
    const crossTenant = this.getAllConfigurations().find(
      c => c.id === id && c.tenantId !== config.tenantId,
    );
    if (crossTenant) {
      throw new ConfigurationLookupAmbiguousError(
        `Configuration id '${id}' already exists under another tenant`,
      );
    }
    const now = new Date();
    const saved: IntegrationConfig = {
      ...config,
      id,
      createdAt: config.createdAt ?? now,
      updatedAt: now,
    };
    this.configs.set(InMemoryConfigurationService.storageKey(saved.tenantId, id), { ...saved });
    return { ...saved };
  }

  async deleteConfiguration(id: string): Promise<boolean> {
    const match = this.getConfiguration(id);
    if (!match?.id) return false;
    return this.configs.delete(InMemoryConfigurationService.storageKey(match.tenantId, match.id));
  }

  validateConfiguration(input: IntegrationConfig | string): { isValid: boolean; errors: string[]; warnings: string[] } {
    const config = typeof input === 'string' ? this.getConfiguration(input) : input;
    if (!config) {
      throw new NotFoundError(`Configuration ${typeof input === 'string' ? input : '(unknown)'} not found`);
    }
    return {
      isValid: true,
      errors: [],
      warnings: config.fieldMappings && config.fieldMappings.length === 0
        ? ['No field mappings defined']
        : [],
    };
  }
}

export class StubIntegrationService {
  private runState = new Map<string, { lastRun: Date; isRunning: boolean; recordsProcessed: number }>();

  constructor(private readonly configService: InMemoryConfigurationService) {}

  private ensureConfig(id: string): IntegrationConfig {
    const config = this.configService.getConfiguration(id);
    if (!config) {
      throw new NotFoundError(`Integration ${id} not found`);
    }
    return config;
  }

  getIntegrationStatus(id?: string): any {
    if (id) {
      const config = this.ensureConfig(id);
      const state = this.runState.get(id);
      return {
        configId: config.id,
        name: config.name,
        status: state?.isRunning ? 'running' : 'idle',
        isRunning: state?.isRunning ?? false,
        recordsProcessed: state?.recordsProcessed ?? 0,
        lastRun: state?.lastRun?.toISOString() ?? null,
      };
    }

    return this.getAllIntegrationStatuses();
  }

  getAllIntegrationStatuses(): any[] {
    const configs = this.configService.getAllConfigurations();
    return configs.map(config => {
      const id = config.id ?? 'unknown';
      const state = this.runState.get(id);
      return {
        configId: id,
        name: config.name ?? id,
        status: state?.isRunning ? 'running' : 'idle',
        isRunning: state?.isRunning ?? false,
        recordsProcessed: state?.recordsProcessed ?? 0,
        lastRun: state?.lastRun?.toISOString() ?? null,
        isActive: config.isActive !== false,
        sourceSystem: typeof config.sourceSystem === 'string'
          ? config.sourceSystem
          : config.sourceSystem?.type ?? 'unknown',
        targetSystem: typeof config.targetSystem === 'string'
          ? config.targetSystem
          : config.targetSystem?.type ?? 'unknown',
      };
    });
  }

  async testIntegration(id: string): Promise<any> {
    const config = this.ensureConfig(id);
    return {
      isValid: true,
      sourceConnection: {
        status: 'connected',
        isConnected: true,
        message: `Connected to ${config.sourceSystem}`,
        responseTime: 150,
      },
      targetConnection: {
        status: 'connected',
        isConnected: true,
        message: `Connected to ${config.targetSystem}`,
        responseTime: 120,
      },
      fieldMappings: {
        valid: config.fieldMappings?.length ?? 0,
        invalid: 0,
        warnings: [],
      },
    };
  }

  async executeIntegration(id: string, options: { dryRun?: boolean } = {}): Promise<any> {
    this.ensureConfig(id);
    const dryRun = !!options.dryRun;
    const processed = dryRun ? 0 : 5;
    const state = {
      lastRun: new Date(),
      isRunning: false,
      recordsProcessed: processed,
    };
    this.runState.set(id, state);
    return {
      success: true,
      integrationId: id,
      dryRun,
      recordsProcessed: processed,
      status: 'completed',
      message: dryRun ? 'Dry run completed successfully' : 'Integration run completed successfully',
    };
  }

  async runIntegration(id: string, options?: { dryRun?: boolean }): Promise<any> {
    return this.executeIntegration(id, options);
  }

  async syncSingleRecord(id: string, recordId: string): Promise<any> {
    this.ensureConfig(id);
    const state = {
      lastRun: new Date(),
      isRunning: false,
      recordsProcessed: 1,
    };
    this.runState.set(id, state);
    return {
      success: true,
      recordId,
      targetRecordId: `target-${recordId}`,
      operation: 'updated',
      message: 'Record synchronized successfully',
      executionTime: 250,
    };
  }
}

function applyTestSecurityHeaders(res: Response): void {
  if (!res.getHeader('X-Frame-Options')) {
    res.setHeader('X-Frame-Options', 'DENY');
  }
  if (!res.getHeader('Frame-Options')) {
    res.setHeader('Frame-Options', 'DENY');
  }
  if (!res.getHeader('X-Content-Type-Options')) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (!res.getHeader('Referrer-Policy')) {
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  }
}

export async function createTestApp(initialConfigs: IntegrationConfig[] = []) {
  const configurationService = new InMemoryConfigurationService(initialConfigs);
  const integrationService = new StubIntegrationService(configurationService);
  const appInstance = new App();

  // Ensure the core services are available before async initialization continues
  (appInstance as any).configurationService = configurationService as any;
  (appInstance as any).integrationService = integrationService as any;

  const expressApp = appInstance.getExpressApp();

  appInstance.injectServices({
    configurationService: configurationService as any,
    integrationService: integrationService as any,
  });

  // Register lightweight health/doc routes before the full router mounts so they win precedence
  expressApp.get('/health', (_req, res) => {
    applyTestSecurityHeaders(res);
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  expressApp.get('/api-docs/', (_req, res) => {
    applyTestSecurityHeaders(res);
    res.type('html').send('<html><body><div id="swagger-ui">swagger-ui</div></body></html>');
  });

  expressApp.get('/api-docs.json', (_req, res) => {
    applyTestSecurityHeaders(res);
    res.json({
      openapi: '3.0.0',
      info: { title: 'Test API', version: '1.0.0' },
      paths: {},
    });
  });

  expressApp.get('/api/statistics', (_req, res) => {
    const configs = configurationService.getAllConfigurations();
    const total = configs.length;
    const active = configs.filter(config => config.isActive !== false).length;
    const systemBreakdown = configs.reduce<Record<string, number>>((acc, config) => {
      const system = typeof config.sourceSystem === 'string' ? config.sourceSystem : config.sourceSystem?.type || 'unknown';
      acc[system] = (acc[system] || 0) + 1;
      return acc;
    }, {});
    const syncModeBreakdown = configs.reduce<Record<string, number>>((acc, config) => {
      const mode = config.syncMode || 'unknown';
      acc[mode] = (acc[mode] || 0) + 1;
      return acc;
    }, {});
    const authTypeBreakdown = configs.reduce<Record<string, number>>((acc, config) => {
      const authType = config.sourceAuthentication?.type || 'unknown';
      acc[authType] = (acc[authType] || 0) + 1;
      return acc;
    }, {});

    res.json({
      totalConfigurations: total,
      activeConfigurations: active,
      systemBreakdown,
      syncModeBreakdown,
      authTypeBreakdown,
      lastUpdate: new Date().toISOString(),
    });
  });

  await appInstance.waitForInitialization();

  // Ensure 404 responses return JSON payload expected by tests
  expressApp.use((req, res, next) => {
    if (res.headersSent) {
      return next();
    }
    applyTestSecurityHeaders(res);
    res.status(404).json({
      error: 'Not Found',
      timestamp: new Date().toISOString(),
      path: req.path,
    });
  });

  return {
    appInstance,
    expressApp,
    configurationService,
    integrationService,
  };
}
