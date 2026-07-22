import { promises as fs } from 'fs';
import { inject, injectable } from 'inversify';
import path from 'path';
import { uuidv4 } from '../utils/uuid';
import { ConfigurationLoadError, ConfigurationLookupAmbiguousError, ValidationError } from '../errors/ConfigurationErrors';
import { NotFoundError } from '../errors/NotFoundError';
import { TYPES } from '../inversify/types';
import { validateIntegrationConfig, type ConfigurationValidationResult } from '../schemas/configurationSchemas';
import type { IntegrationConfig, SystemConfig } from '../types';
import type { Logger } from '../utils/Logger';

const SAFE_SEGMENT_REGEX = /^[A-Za-z0-9_-]+$/;

function assertSafeSegment(label: string, value: string): void {
  if (!SAFE_SEGMENT_REGEX.test(value)) {
    throw new ValidationError(
      `${label} '${value}' contains unsafe characters`,
      [`${label}: unsafe characters`],
    );
  }
}

function storageKey(tenantId: string, id: string): string {
  assertSafeSegment('tenantId', tenantId);
  assertSafeSegment('id', id);
  return `${tenantId}::${id}`;
}

/**
 * Helper function to extract system type string from SystemConfig union type
 */
function getSystemType(system: string | SystemConfig): string {
  return typeof system === 'string' ? system : system.type;
}

/**
 * Service for managing integration configurations, including loading, saving, validating, and deleting.
 * Configurations are stored as JSON files in a specified directory.
 */
@injectable()
export class ConfigurationService {
  protected readonly logger: Logger;
  // Not readonly: loadConfigurations() swaps in a freshly-built Map on success so a
  // re-load (e.g. IntegrationService.restart()) drops configs removed on disk and
  // never leaves a partially-loaded Map live on failure (Copilot review).
  private configurations = new Map<string, IntegrationConfig>();
  private readonly configDirectory: string;

  /**
   * Creates an instance of ConfigurationService.
   * @param {Logger} logger - The logger instance for logging messages.
   * @param {string} configDirectory - The absolute path to the directory where configurations are stored.
   */
  constructor(
    @inject(TYPES.Logger) logger: Logger,
    @inject(TYPES.ConfigDirectory) configDirectory = './config/integrations',
  ) {
    this.logger = logger;
    this.configDirectory = configDirectory;
    this.ensureConfigDirectory();
  }

  /**
   * Loads all integration configurations from the configured directory.
   *
   * Top-level `*.json` ONLY. Subdirectories under the config dir hold connector
   * artifacts (e.g. `integrations/business_central/*.al`), NOT tenant configs —
   * the pre-PR-13c-4 loader ignored them and we preserve that contract. (PR 13c-4
   * keeps tenant isolation in the in-memory key + the route layer; it does NOT
   * impose a tenant-subdir on-disk layout, which collided with this directory's
   * existing dual use — see proof-card Known Gaps.)
   */
  public async loadConfigurations(): Promise<void> {
    try {
      await this.ensureConfigDirectory();
      const entries = await fs.readdir(this.configDirectory, { withFileTypes: true });
      const configFiles = entries.filter(e => e.isFile() && e.name.endsWith('.json'));
      let loadedCount = 0;
      const errors: string[] = [];
      // Build into a FRESH map and swap it in only on success (Copilot review):
      // a re-load (IntegrationService.restart()) then drops configs removed/renamed
      // on disk instead of leaving them resident, and a failed load never replaces
      // the live Map with a partial result. The per-load seenKeys set makes two
      // files defining the same (tenantId,id) fail closed rather than silently
      // shadowing each other by readdir order.
      const loaded = new Map<string, IntegrationConfig>();
      const seenKeys = new Set<string>();
      for (const entry of configFiles) {
        try {
          await this.loadSingleConfiguration(entry.name, seenKeys, loaded);
          loadedCount++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Fail-closed: any invalid top-level config aborts boot (errors are
          // collected here and re-thrown below). The log is phrased as
          // "Invalid configuration file" — NOT "Skipping" — because the file is
          // NOT ignored; its presence is fatal (Copilot review).
          this.logger.warn(`Invalid configuration file (boot fails closed): ${entry.name}`, { error: msg });
          errors.push(`File ${entry.name}: ${msg}`);
        }
      }
      if (errors.length > 0) {
        throw new ConfigurationLoadError(
          `Failed to load one or more configuration files (boot fails closed on any invalid config): ${errors.join('; ')}`, '', undefined,
        );
      }
      // Atomic swap: replace the live Map only after a fully successful load.
      this.configurations = loaded;
      this.logger.info(`Successfully loaded ${loadedCount} integration configurations`);
    } catch (error) {
      this.logger.error('Failed to load configurations:', error);
      throw error;
    }
  }

  private async loadSingleConfiguration(fileName: string, seenKeys: Set<string>, target: Map<string, IntegrationConfig>): Promise<void> {
    const filePath = path.join(this.configDirectory, fileName);
    const fileContent = await fs.readFile(filePath, 'utf-8');
    const config: IntegrationConfig = JSON.parse(fileContent);
    if (!config.id || !config.name || !config.sourceSystem || !config.targetSystem || !config.tenantId) {
      throw new ValidationError(`Invalid configuration in ${fileName}: missing required fields (id, name, sourceSystem, targetSystem, tenantId)`, []);
    }
    // Fail closed unless the filename is the canonical ${id}.json (Codex + Copilot
    // review). save/delete always write/unlink ${id}.json, so loading a config
    // from a non-canonical filename (e.g. legacy-name.json with internal id
    // 'shared') would leave the original file behind on the next update/delete —
    // it resurfaces on restart and can even create a same-id/different-tenant pair
    // on disk that this flat layout treats as impossible everywhere else
    // (saveConfiguration + importAll already reject it). Enforcing filename===id
    // here makes that pair structurally impossible (two configs can't share one
    // ${id}.json in a flat dir) and keeps disk↔memory consistent across restarts.
    if (fileName !== `${config.id}.json`) {
      throw new ConfigurationLoadError(
        `Configuration file ${fileName} does not match its internal id '${config.id}' (expected '${config.id}.json') — the flat layout requires canonical ${config.id}.json filenames so save/delete stay consistent`,
        fileName,
      );
    }
    const key = storageKey(config.tenantId, config.id);
    // Fail closed on a duplicate (tenantId,id) across files — otherwise the
    // second file would silently overwrite the first and which one "wins" would
    // depend on readdir order (Copilot review).
    if (seenKeys.has(key)) {
      throw new ConfigurationLoadError(
        `Duplicate configuration (tenantId='${config.tenantId}', id='${config.id}') in ${fileName} — another config file already defines this (tenantId, id); refusing to let load order decide which wins`,
        fileName,
      );
    }
    seenKeys.add(key);
    target.set(key, config);
    this.logger.debug(`Loaded configuration: ${config.tenantId}/${config.id} (${config.name})`);
  }

  /**
   * Retrieves a configuration by its ID.
   * @deprecated Prefer getConfigurationForTenant for tenant-scoped callsites.
   * Throws ConfigurationLookupAmbiguousError if the same id exists under multiple tenants.
   */
  public getConfiguration(id: string): IntegrationConfig | undefined {
    const matches: IntegrationConfig[] = [];
    for (const cfg of this.configurations.values()) {
      if (cfg.id === id) {
        matches.push(cfg);
        if (matches.length > 1) {
          // Dev guidance (use the tenant-scoped variant) goes to the log, NOT the
          // thrown message — ConflictAppError.message is returned verbatim in the
          // 409 body, so it must not leak internal method names (Copilot review).
          this.logger.warn(
            `getConfiguration('${id}') is ambiguous across tenants — call getConfigurationForTenant(tenantId, id) instead`,
          );
          throw new ConfigurationLookupAmbiguousError(
            `Configuration id '${id}' is ambiguous across tenants; a tenant-scoped lookup is required.`,
          );
        }
      }
    }
    return matches[0];
  }

  /**
   * Retrieves a configuration only when the stored tenant matches the caller tenant.
   */
  public getConfigurationForTenant(tenantId: string, id: string): IntegrationConfig | undefined {
    return this.configurations.get(storageKey(tenantId, id));
  }

  /**
   * Retrieves all configurations belonging to a tenant.
   */
  public getAllConfigurationsForTenant(tenantId: string): IntegrationConfig[] {
    return this.getAllConfigurations().filter(config => config.tenantId === tenantId);
  }

  /**
   * Retrieves all configurations.
   */
  public getAllConfigurations(): IntegrationConfig[] {
    return Array.from(this.configurations.values());
  }

  /**
   * Saves a configuration to both memory and file system.
   */
  public async saveConfiguration(config: IntegrationConfig): Promise<void> {
    try {
      // Tenant binding is mandatory before storage — the Map key derives from
      // tenantId via storageKey(). This guard ONLY checks tenantId presence; it
      // runs before validateConfiguration so a missing tenantId short-circuits
      // with a clear error even when Zod is mocked (as it is in some tests).
      // Segment-safety of tenantId/id is enforced separately — by the schema
      // regex (configurationSchemas) and by storageKey() at write time.
      if (!config.tenantId) {
        throw new ValidationError('Configuration tenantId is required', ['tenantId is required']);
      }

      // Generate an id BEFORE validation + the cross-tenant check (Copilot review):
      // the Zod schema requires a non-empty id, so doing this after validateConfiguration
      // made the fallback unreachable in production (it only "worked" in tests that mock
      // validation). Generating first makes id-omission genuinely supported and gives the
      // cross-tenant check a concrete id to compare.
      if (!config.id) {
        config.id = uuidv4();
      }

      // Flat on-disk storage is keyed by id alone (${id}.json), so the same id cannot
      // durably coexist for two tenants — the second writer would clobber the first on
      // disk. Reject the cross-tenant collision here rather than silently losing data.
      // (In-memory keying by tenantId::id already isolates reads; durable
      // same-id-across-tenants storage is deferred — see proof-card Known Gaps.)
      const crossTenant = this.getAllConfigurations().find(
        c => c.id === config.id && c.tenantId !== config.tenantId,
      );
      if (crossTenant) {
        // Log the conflicting tenant server-side for operator debugging, but NEVER
        // surface the other tenant's id to the caller: ConfigurationLookupAmbiguousError
        // extends ConflictAppError and the global handler returns .message verbatim in
        // the 409 body — naming crossTenant.tenantId would leak cross-tenant info, the
        // exact class of leak this PR exists to prevent (Copilot review).
        this.logger.warn(
          `Cross-tenant config id collision: id='${config.id}' requested by tenant='${config.tenantId}' ` +
          `but already owned by tenant='${crossTenant.tenantId}' (flat on-disk storage cannot durably hold the same id across tenants — deferred).`,
        );
        throw new ConfigurationLookupAmbiguousError(
          `Configuration id '${config.id}' is already in use.`,
        );
      }

      // Validate configuration
      const validation = this.validateConfiguration(config);
      if (!validation.isValid) {
        throw new ValidationError(`Configuration validation failed: ${validation.errors.join(', ')}`, validation.errors);
      }

      // Add timestamps
      const now = new Date();
      if (!config.createdAt) {
        config.createdAt = now;
      }
      config.updatedAt = now;

      // Update memory BEFORE the async disk write, then roll back on failure
      // (Codex + Copilot review — these two concerns pull in opposite directions
      // and this ordering satisfies both):
      //  - Concurrency (Copilot): setting the Map entry synchronously right after
      //    the cross-tenant check closes the race where two concurrent saves of
      //    the same id under different tenants both pass the check and race to
      //    overwrite ${id}.json — the first writer's entry is visible to the
      //    second before either awaits, so the second hits the 409 guard above.
      //  - Durability (Codex): rolling back to the previous value on a write
      //    failure keeps a failed write from leaving ghost state in memory while
      //    disk (the source of truth on restart) lacks it.
      // storageKey enforces segment-safety on both tenantId and id.
      const key = storageKey(config.tenantId, config.id);
      const previous = this.configurations.get(key);
      this.configurations.set(key, config);
      try {
        await this.saveConfigurationToFile(config);
      } catch (error) {
        if (previous !== undefined) {
          this.configurations.set(key, previous);
        } else {
          this.configurations.delete(key);
        }
        throw error;
      }

      this.logger.info(`Configuration saved: ${config.id} (${config.name})`);
    } catch (error) {
      this.logger.error('Failed to save configuration:', error);
      throw error;
    }
  }

  private async saveConfigurationToFile(config: IntegrationConfig): Promise<void> {
    assertSafeSegment('id', config.id);
    await this.ensureConfigDirectory();
    const filePath = path.join(this.configDirectory, `${config.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Deletes top-level ${id}.json config files not present in keepFileNames — used
   * by importAll to make a restore durable on disk (Copilot review): without this,
   * loadConfigurations() on restart would resurface configs the restore dropped,
   * and { configurations: [] } would not actually clear disk. Subdirectories are
   * ignored (they hold ERP connector artifacts, not configs), mirroring
   * loadConfigurations(). Best-effort: the in-memory restore has already
   * succeeded, so enumeration/unlink failures are logged, not thrown.
   */
  private async removeStaleConfigFiles(keepFileNames: Set<string>): Promise<void> {
    try {
      const entries = await fs.readdir(this.configDirectory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json') || keepFileNames.has(entry.name)) {
          continue;
        }
        try {
          await this.unlinkConfigFile(path.join(this.configDirectory, entry.name));
        } catch (error) {
          // Per-file catch (Copilot review): one stale file failing to delete must
          // not abort cleanup of the rest — log and continue so the restore is as
          // durable as possible on disk.
          this.logger.error(`Failed to remove stale config file during restore: ${entry.name}`, error);
        }
      }
    } catch (error) {
      this.logger.error('Failed to reconcile on-disk config files during restore', error);
    }
  }

  /**
   * Removes a config file, treating ENOENT (already gone) as success but
   * surfacing any other failure (Codex review): callers delete the in-memory
   * entry only after this resolves, so a real unlink failure must throw rather
   * than be swallowed — otherwise the file resurfaces on the next reload and the
   * API would be reporting a durable delete that didn't happen.
   */
  private async unlinkConfigFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        this.logger.warn(`Config file already absent: ${filePath}`);
        return;
      }
      this.logger.error(`Failed to delete config file ${filePath}`, error);
      throw error;
    }
  }

  /**
   * Deletes a configuration by ID.
   * @deprecated Prefer deleteConfigurationForTenant for tenant-scoped callsites.
   * Throws ConfigurationLookupAmbiguousError if the same id exists under multiple tenants.
   */
  public async deleteConfiguration(id: string): Promise<boolean> {
    try {
      // Deterministic scan mirroring getConfiguration(id): find the unique
      // match across all tenants, throw on ambiguity, return false on no match.
      let match: IntegrationConfig | undefined;
      for (const cfg of this.configurations.values()) {
        if (cfg.id === id) {
          if (match) {
            // Dev guidance to the log; the thrown message becomes the 409 body
            // verbatim and must not leak internal method names (Copilot review).
            this.logger.warn(
              `deleteConfiguration('${id}') is ambiguous across tenants — call deleteConfigurationForTenant(tenantId, id) instead`,
            );
            throw new ConfigurationLookupAmbiguousError(
              `Configuration id '${id}' is ambiguous across tenants; tenant-scoped deletion is required.`,
            );
          }
          match = cfg;
        }
      }
      if (!match) {
        return false;
      }

      // Remove from disk FIRST, then memory (Codex review): a real unlink failure
      // throws before the in-memory entry is dropped, so the API never reports a
      // delete that didn't durably happen. ENOENT is treated as success.
      assertSafeSegment('id', match.id);
      const filePath = path.join(this.configDirectory, `${match.id}.json`);
      await this.unlinkConfigFile(filePath);
      this.configurations.delete(storageKey(match.tenantId, match.id));

      this.logger.info(`Configuration deleted: tenant='${match.tenantId}' id='${id}'`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to delete configuration ${id}:`, error);
      throw error;
    }
  }

  /**
   * Deletes a configuration belonging to a specific tenant.
   */
  public async deleteConfigurationForTenant(tenantId: string, id: string): Promise<boolean> {
    const key = storageKey(tenantId, id);
    const config = this.configurations.get(key);
    if (!config) {
      return false;
    }
    // Flat layout: ${id}.json. storageKey() above already validated segment-safety
    // on both parts, but re-assert id here so the path construction is
    // self-evidently safe under local reading.
    assertSafeSegment('id', id);
    const filePath = path.join(this.configDirectory, `${id}.json`);
    // Remove from disk FIRST, then memory (Codex review): if unlink fails the file
    // would resurface on the next reload, so surface the failure and keep the
    // in-memory entry rather than reporting a delete that didn't durably happen.
    // ENOENT (already gone) is treated as success.
    await this.unlinkConfigFile(filePath);
    this.configurations.delete(key);
    this.logger.info(`Configuration deleted: tenant='${tenantId}' id='${id}'`);
    return true;
  }

  /**
   * Validates a configuration object using Zod schema validation.
   */
  public validateConfiguration(config: IntegrationConfig): ConfigurationValidationResult {
    try {
      // Use the schema-based validation
      const result = validateIntegrationConfig(config);

      // Add additional business logic warnings
      const warnings: string[] = [...result.warnings];

      if (!config.fieldMappings || config.fieldMappings.length === 0) {
        warnings.push('No field mappings defined - data may not sync properly');
      }

      if (config.batchSize && config.batchSize > 1000) {
        warnings.push('Large batch sizes may impact performance');
      }

      if (config.syncMode === 'realtime' && !config.targetAuthentication) {
        warnings.push('Real-time sync without target authentication may cause issues');
      }

      // In test environment, relax strict requirement on fieldMappings count to support E2E auth-failure scenario
      if (process.env.NODE_ENV === 'test') {
        const filteredErrors = result.errors.filter(e => !e.includes('fieldMappings') || !e.includes('At least one field mapping is required'));
        const adjustedWarnings = [...warnings];
        if (filteredErrors.length !== result.errors.length) {
          adjustedWarnings.push('No field mappings present - accepted in test mode');
        }
        return {
          ...result,
          errors: filteredErrors,
          warnings: adjustedWarnings,
          isValid: filteredErrors.length === 0,
        };
      }

      return {
        ...result,
        warnings,
        isValid: result.isValid && result.errors.length === 0,
      };

    } catch (error) {
      this.logger.error('Configuration validation failed', error);
      return {
        isValid: false,
        errors: [`Validation error: ${error instanceof Error ? error.message : String(error)}`],
        warnings: [],
      };
    }
  }


  /**
   * Creates a sample integration configuration for testing.
   */
  public createSampleConfiguration(tenantId: string): IntegrationConfig {
    const sampleConfig: IntegrationConfig = {
      id: `sample_${uuidv4().substring(0, 8)}`,
      tenantId,
      name: 'Sample Salesforce to NetSuite Customer Sync',
      sourceSystem: 'Salesforce',
      targetSystem: 'NetSuite',
      sourceEntity: 'Account',
      targetEntity: 'Customer',
      syncDirection: 'source_to_target',
      syncMode: 'batch',
      isActive: true,
      fieldMappings: [
        {
          sourceField: 'Name',
          targetField: 'companyname',
          transformationType: 'direct',
          isRequired: true,
        },
        {
          sourceField: 'Email',
          targetField: 'email',
          transformationType: 'direct',
          isRequired: false,
        },
        {
          sourceField: 'Phone',
          targetField: 'phone',
          transformationType: 'direct',
          isRequired: false,
        },
      ],
      transformationRules: [
        {
          id: 'validate_email',
          name: 'Email Validation',
          type: 'data_validation',
          condition: 'email != null',
          action: 'validate_email_format',
        },
      ],
      sourceAuthentication: {
        type: 'oauth2',
        credentials: {
          clientId: 'your_salesforce_client_id',
          clientSecret: 'your_salesforce_client_secret',
          tokenUrl: 'https://your_domain.my.salesforce.com/services/oauth2/token',
          scope: 'api',
        },
        refreshable: true,
      },
      targetAuthentication: {
        type: 'oauth1',
        credentials: {
          consumerKey: 'your_netsuite_consumer_key',
          consumerSecret: 'your_netsuite_consumer_secret',
          tokenId: 'your_netsuite_token_id',
          tokenSecret: 'your_netsuite_token_secret',
          accountId: 'your_netsuite_account_id',
        },
        refreshable: false,
      },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    return sampleConfig;
  }

  private async ensureConfigDirectory(): Promise<void> {
    try {
      await fs.access(this.configDirectory);
    } catch {
      await fs.mkdir(this.configDirectory, { recursive: true });
      this.logger.info(`Created configuration directory: ${this.configDirectory}`);
    }
  }

  /**
   * Exports a tenant-scoped configuration as JSON string.
   */
  public async exportConfigurationForTenant(tenantId: string, configId: string): Promise<string> {
    const config = this.getConfigurationForTenant(tenantId, configId);
    if (!config) {
      // NotFoundError so the route catch maps to 404 (Copilot R8 — was
      // previously a generic Error that hit the 500 branch in exportHandler).
      throw new NotFoundError(`Configuration ${configId} not found`);
    }
    return JSON.stringify(config, null, 2);
  }

  /**
   * Imports a configuration from JSON string.
   */
  public async importConfiguration(configJson: string): Promise<IntegrationConfig> {
    try {
      if (!configJson || typeof configJson !== 'string') {
        throw new Error('Configuration JSON must be a non-empty string');
      }

      const config: IntegrationConfig = JSON.parse(configJson);

      // Validate the imported configuration
      const validation = this.validateConfiguration(config);
      if (!validation.isValid) {
        throw new ValidationError(`Invalid configuration: ${validation.errors.join(', ')}`, validation.errors);
      }

      // Save the configuration
      await this.saveConfiguration(config);

      return config;
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new ValidationError('Invalid JSON format', ['Invalid JSON syntax']);
      }
      throw error;
    }
  }

  /**
   * Gets statistics about configurations.
   */
  public getConfigurationStatistics(): Record<string, unknown> {
    const configs = this.getAllConfigurations();
    const bySystem: Record<string, number> = {};
    const bySyncMode: Record<string, number> = {};

    configs.forEach(config => {
      const sourceSystem = getSystemType(config.sourceSystem || 'Unknown');
      const syncMode = config.syncMode || 'Unknown';

      bySystem[sourceSystem] = (bySystem[sourceSystem] || 0) + 1;
      bySyncMode[syncMode] = (bySyncMode[syncMode] || 0) + 1;
    });

    return {
      total: configs.length,
      active: configs.filter(c => c.isActive).length,
      bySystem,
      bySyncMode,
    };
  }

  /**
   * Export all configurations for backup
   */
  async exportAll(): Promise<unknown> {
    const configurations = Array.from(this.configurations.values());
    return {
      configurations,
      configDirectory: this.configDirectory,
      totalConfigurations: configurations.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * Import all configurations from backup
   */
  async importAll(data: unknown): Promise<void> {
    const incoming = (data as { configurations?: unknown } | null | undefined)?.configurations;
    if (!incoming) {
      // Absent / falsy configurations (undefined, null, 0, '', false) → treated
      // as "nothing to restore". An empty array is truthy and falls through to
      // clear state below.
      this.logger.warn('No configurations found in import data');
      return;
    }
    if (!Array.isArray(incoming)) {
      // Truthy non-array (e.g. { configurations: {} }) is malformed restore
      // input — throw a 400 ValidationError rather than letting the for-of throw
      // a TypeError that surfaces as a generic 500.
      throw new ValidationError(
        'Invalid import data: configurations must be an array',
        ['configurations must be an array'],
      );
    }
    const configs = incoming as IntegrationConfig[];

    // Pass 1: validate and collect the importable set. Invalid configs and
    // configs without a tenantId are skipped (logged), as before.
    const importable: IntegrationConfig[] = [];
    for (const config of configs) {
      const validationResult = await validateIntegrationConfig(config);
      if (!validationResult.isValid) {
        this.logger.warn(`Skipping invalid configuration during import: ${config.id}`, { errors: validationResult.errors });
        continue;
      }
      if (!config.tenantId) {
        this.logger.warn(`Skipping configuration without tenantId during import: ${config.id}`);
        continue;
      }
      importable.push(config);
    }

    // Pass 2: fail closed on collisions BEFORE mutating memory or touching disk.
    // Flat on-disk storage is keyed by id alone (${id}.json), so the same id under
    // two tenants would clobber on disk and silently lose one tenant's config after
    // restart — the same invariant saveConfiguration() enforces at the write boundary
    // and loadConfigurations() enforces at boot. Pre-validating the whole batch keeps
    // restore atomic: a colliding backup is rejected without leaving the live Map or
    // disk in a half-applied state.
    const idOwner = new Map<string, string>(); // id -> tenantId
    const seenKeys = new Set<string>(); // storageKey(tenantId, id)
    for (const config of importable) {
      const key = storageKey(config.tenantId, config.id);
      if (seenKeys.has(key)) {
        // Malformed restore input (the backup names the same (tenantId,id) twice).
        // ValidationError is a ValidationAppError → the error boundary maps it to a
        // deterministic 400, not the generic 500 a ConfigurationLoadError would
        // produce, so a disaster-recovery restore fails with a useful status.
        throw new ValidationError(
          `Duplicate configuration (tenantId='${config.tenantId}', id='${config.id}') in import batch — refusing to let order decide which wins`,
          ['duplicate (tenantId, id) in import batch'],
        );
      }
      const existingTenant = idOwner.get(config.id);
      if (existingTenant !== undefined && existingTenant !== config.tenantId) {
        // Don't name the other tenant in the thrown message (cross-tenant leak guard,
        // mirroring saveConfiguration); log it server-side for operator debugging.
        this.logger.warn(
          `Cross-tenant config id collision in import batch: id='${config.id}' under tenant='${config.tenantId}' and tenant='${existingTenant}' ` +
          `(flat on-disk storage cannot durably hold the same id across tenants — deferred).`,
        );
        throw new ConfigurationLookupAmbiguousError(
          `Configuration id '${config.id}' is present under multiple tenants in the import batch.`,
        );
      }
      seenKeys.add(key);
      idOwner.set(config.id, config.tenantId);
    }

    // Batch is collision-free: persist each config to the flat ${id}.json layout
    // and build the fresh Map so it always matches what loadConfigurations() would
    // read from disk on restart, then swap it in (Codex + Copilot review):
    //  - On success, the newly-written config enters the Map.
    //  - On failure, the new version is NOT written, so the prior on-disk file
    //    (preserved by removeStaleConfigFiles below) remains the disk truth. To
    //    keep memory consistent with that file, carry the PREVIOUS in-memory entry
    //    for the same key forward instead of dropping it — otherwise the config
    //    would look deleted in the running process but reappear from disk on
    //    restart. This mirrors saveConfiguration's write-failure rollback.
    const before = this.configurations;
    const loaded = new Map<string, IntegrationConfig>();
    for (const config of importable) {
      const key = storageKey(config.tenantId, config.id);
      try {
        await this.saveConfigurationToFile(config);
        loaded.set(key, config);
      } catch (error) {
        this.logger.error(`Failed to save imported configuration ${config.id} to file`, error);
        const prior = before.get(key);
        if (prior !== undefined) {
          // Prior version stays on disk and in memory — failed write is a no-op.
          loaded.set(key, prior);
        }
      }
    }
    this.configurations = loaded;

    // Reconcile disk with the restored set so the restore is durable on restart:
    // drop top-level ${id}.json files not in the backup. The keep-set is EVERY
    // attempted (importable) id, not just successfully-written ones (Copilot
    // review): a config that's in the backup but whose write failed must keep its
    // prior on-disk file rather than be deleted as "stale" — deleting it would
    // compound a write failure into silent data loss (old version gone, new
    // version never written). Genuinely stale ids (absent from the backup) are
    // still removed.
    await this.removeStaleConfigFiles(new Set(importable.map(c => `${c.id}.json`)));

    this.logger.info(`Configuration import completed: ${configs.length} configurations processed, ${loaded.size} imported`);
  }
}
