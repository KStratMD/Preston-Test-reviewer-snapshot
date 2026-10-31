import { EventEmitter } from "events";
import { Logger } from "./Logger";
import { promises as fs } from "fs";
import * as path from "path";

const logger = new Logger("DynamicConfiguration");

type ConfigPrimitive = string | number | boolean | null | undefined;
export interface ConfigMap {
  [key: string]: ConfigValue;
}
type ConfigValue = ConfigPrimitive | ConfigValue[] | ConfigMap;
type ConfigDiff = Record<string, ConfigValue | undefined>;

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
);

const cloneConfigMap = (source: ConfigMap): ConfigMap => {
  const result: ConfigMap = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = cloneConfigValue(value);
  }
  return result;
};
const cloneConfigValue = (value: ConfigValue): ConfigValue => {
  if (Array.isArray(value)) {
    return value.map(item => cloneConfigValue(item as ConfigValue)) as ConfigValue;
  }
  if (isRecord(value)) {
    const result: ConfigMap = {};
    for (const [key, nested] of Object.entries(value)) {
      result[key] = cloneConfigValue(nested as ConfigValue);
    }
    return result;
  }
  return value;
};

const normalizeConfigValue = (input: unknown): ConfigValue => {
  if (Array.isArray(input)) {
    return input.map(element => normalizeConfigValue(element)) as ConfigValue;
  }
  if (isRecord(input)) {
    const result: ConfigMap = {};
    for (const [key, value] of Object.entries(input)) {
      result[key] = normalizeConfigValue(value);
    }
    return result;
  }
  if (
    typeof input === "string"
    || typeof input === "number"
    || typeof input === "boolean"
    || input === null
    || input === undefined
  ) {
    return input as ConfigPrimitive;
  }
  return String(input);
};

const toConfigMap = (value: unknown, context: string): ConfigMap => {
  if (!isRecord(value)) {
    throw new Error(`Configuration source '${context}' did not return an object`);
  }

  const result: ConfigMap = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = normalizeConfigValue(nested);
  }
  return result;
};

export interface ConfigurationSource {
  name: string;
  priority: number;
  load(): Promise<ConfigMap>;
  watch?(callback: (changes: ConfigMap) => void): () => void;
}

export type ConfigurationSchema = Record<string, {
    type: "string" | "number" | "boolean" | "array" | "object";
    required?: boolean;
    default?: unknown;
    validation?: (value: unknown) => boolean | string;
    description?: string;
    sensitive?: boolean; // For masking in logs
    hotReloadable?: boolean; // Can be changed without restart
  }>;

export interface ConfigurationMetrics {
  totalReloads: number;
  lastReloadTime?: Date;
  lastReloadDuration?: number;
  validationErrors: number;
  hotReloads: number;
  sourceStatus: Record<string, { healthy: boolean; lastUpdate: Date; errors: number }>;
  configSize: number;
  watchersActive: number;
}

export interface ConfigurationValidationResult {
  valid: boolean;
  errors: {
    path: string;
    message: string;
    value: unknown;
  }[];
}

export class DynamicConfiguration extends EventEmitter {
  private static instance: DynamicConfiguration;
  private config: ConfigMap = {};
  private readonly sources: ConfigurationSource[] = [];
  private schema: ConfigurationSchema = {};
  private watchers: (() => void)[] = [];
  private readonly metrics: ConfigurationMetrics;
  private reloadInProgress = false;
  private configHistory: { timestamp: Date; config: ConfigMap; source: string }[] = [];

  private constructor() {
    super();
    // Increase max listeners to prevent memory leak warnings
    this.setMaxListeners(25);
    this.metrics = {
      totalReloads: 0,
      validationErrors: 0,
      hotReloads: 0,
      sourceStatus: {},
      configSize: 0,
      watchersActive: 0,
    };
  }

  public static getInstance(): DynamicConfiguration {
    if (!DynamicConfiguration.instance) {
      DynamicConfiguration.instance = new DynamicConfiguration();
    }
    return DynamicConfiguration.instance;
  }

  public addSource(source: ConfigurationSource): void {
    // Insert in priority order (higher priority first)
    const insertIndex = this.sources.findIndex(s => s.priority <= source.priority);
    if (insertIndex === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(insertIndex, 0, source);
    }

    this.metrics.sourceStatus[source.name] = {
      healthy: true,
      lastUpdate: new Date(),
      errors: 0,
    };

    logger.info("Configuration source added", {
      name: source.name,
      priority: source.priority,
      totalSources: this.sources.length,
    });

    // Set up watching if supported
    if (source.watch) {
      const unwatch = source.watch((changes) => {
        this.handleSourceUpdate(source.name, changes);
      });
      this.watchers.push(unwatch);
      this.metrics.watchersActive++;
    }
  }

  public setSchema(schema: ConfigurationSchema): void {
    this.schema = schema;
    logger.info("Configuration schema set", {
      properties: Object.keys(schema).length,
    });

    // Apply defaults from schema
    this.applyDefaults();

    // Validate current configuration
    const validation = this.validateConfiguration();
    if (!validation.valid) {
      logger.warn("Current configuration invalid against new schema", {
        errors: validation.errors,
      });
    }
  }

  public async load(): Promise<void> {
    if (this.reloadInProgress) {
      logger.warn("Configuration reload already in progress");
      return;
    }

    this.reloadInProgress = true;
    const startTime = Date.now();

    try {
      logger.info("Loading configuration from sources", {
        sources: this.sources.map(s => ({ name: s.name, priority: s.priority })),
      });

      const newConfig: ConfigMap = {};

      // Load from sources in reverse priority order (lower priority first, so higher priority overrides)
      for (const source of [...this.sources].reverse()) {
        try {
          const sourceConfig = await source.load();
          this.mergeConfig(newConfig, sourceConfig);

          this.metrics.sourceStatus[source.name] = {
            healthy: true,
            lastUpdate: new Date(),
            errors: this.metrics.sourceStatus[source.name]?.errors || 0,
          };

          logger.debug("Configuration loaded from source", {
            source: source.name,
            keys: Object.keys(sourceConfig).length,
          });

        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);

          this.metrics.sourceStatus[source.name] = {
            healthy: false,
            lastUpdate: new Date(),
            errors: (this.metrics.sourceStatus[source.name]?.errors || 0) + 1,
          };

          logger.error("Failed to load configuration from source", {
            source: source.name,
            error: errorMessage,
          });

          this.emit("sourceError", source.name, error);
        }
      }

      // Apply schema defaults
      this.applyDefaultsToConfig(newConfig);

      // Validate configuration
      const validation = this.validateConfiguration(newConfig);
      if (!validation.valid) {
        this.metrics.validationErrors++;
        logger.error("Configuration validation failed", {
          errors: validation.errors,
        });
        throw new Error(`Configuration validation failed: ${validation.errors.map(e => e.message).join(", ")}`);
      }

      // Detect changes
      const changes = this.detectChanges(this.config, newConfig);
      const hasChanges = Object.keys(changes).length > 0;

      if (hasChanges) {
        // Store previous config in history
        this.configHistory.push({
          timestamp: new Date(),
          config: cloneConfigMap(this.config),
          source: "reload",
        });

        // Keep only last 10 configs in history
        if (this.configHistory.length > 10) {
          this.configHistory = this.configHistory.slice(-10);
        }

        // Update configuration
        const previousConfig = cloneConfigMap(this.config);
        this.config = newConfig;
        this.metrics.configSize = JSON.stringify(this.config).length;

        logger.info("Configuration updated", {
          changes: this.maskSensitiveValues(changes),
          changeCount: Object.keys(changes).length,
        });

        this.emit("configurationChanged", changes, previousConfig, this.config);

        // Handle hot-reloadable changes
        const hotReloadableChanges = this.getHotReloadableChanges(changes);
        if (Object.keys(hotReloadableChanges).length > 0) {
          this.metrics.hotReloads++;
          this.emit("hotReload", hotReloadableChanges);

          logger.info("Hot-reloadable configuration changes applied", {
            changes: this.maskSensitiveValues(hotReloadableChanges),
          });
        }
      }

      const duration = Date.now() - startTime;
      this.metrics.totalReloads++;
      this.metrics.lastReloadTime = new Date();
      this.metrics.lastReloadDuration = duration;

      logger.info("Configuration load completed", {
        duration,
        hasChanges,
        changeCount: hasChanges ? Object.keys(changes).length : 0,
        configSize: this.metrics.configSize,
      });

      this.emit("configurationLoaded", this.config, hasChanges);

    } catch (error) {
      logger.error("Configuration load failed", { error });
      this.emit("loadError", error);
      throw error;
    } finally {
      this.reloadInProgress = false;
    }
  }

  public get<T = ConfigValue>(path: string, defaultValue?: T): T {
    const value = this.getValueByPath(this.config, path);
    return value !== undefined ? value as T : defaultValue as T;
  }

  public set<T>(path: string, value: T): void {
    const normalizedValue = normalizeConfigValue(value as unknown);
    const oldValue = this.get(path);
    this.setValueByPath(this.config, path, normalizedValue);

    // Validate the change if schema is defined
    const schemaEntry = this.schema[path];
    if (schemaEntry) {
      const validationResult = this.validateValue(path, normalizedValue, schemaEntry);
      if (validationResult !== true) {
        // Revert the change
        if (oldValue === undefined) {
          this.deleteValueByPath(this.config, path);
        } else {
          this.setValueByPath(this.config, path, oldValue as unknown as ConfigValue);
        }
        throw new Error(`Configuration validation failed for ${path}: ${validationResult}`);
      }

      // Check if this is hot-reloadable
      if (schemaEntry.hotReloadable) {
        this.metrics.hotReloads++;
        this.emit("hotReload", { [path]: normalizedValue });

        logger.info("Hot-reloadable configuration changed", {
          path,
          newValue: schemaEntry.sensitive ? "***" : normalizedValue,
          oldValue: schemaEntry.sensitive ? "***" : oldValue,
        });
      }
    }

    this.emit("configurationChanged", { [path]: normalizedValue }, { [path]: oldValue }, this.config);

    logger.info("Configuration value updated", {
      path,
      changed: value !== oldValue,
    });
  }

  public has(path: string): boolean {
    return this.getValueByPath(this.config, path) !== undefined;
  }

  public getAll(): ConfigMap {
    return cloneConfigMap(this.config);
  }

  public getAllMasked(): Record<string, unknown> {
    return this.maskSensitiveValues(this.config);
  }

  private handleSourceUpdate(sourceName: string, changes: ConfigMap): void {
    logger.info("Configuration source updated", {
      source: sourceName,
      changes: this.maskSensitiveValues(changes),
    });

    // Trigger a reload to incorporate changes
    this.load().catch(error => {
      logger.error("Failed to reload configuration after source update", {
        source: sourceName,
        error,
      });
    });
  }

  private mergeConfig(target: ConfigMap, source: ConfigMap): void {
    for (const [key, value] of Object.entries(source)) {
      if (isRecord(value)) {
        const existing = target[key];
        const nestedTarget = isRecord(existing) ? existing : {};
        if (!isRecord(existing)) {
          target[key] = nestedTarget as ConfigValue;
        }
        this.mergeConfig(
          nestedTarget as ConfigMap,
          value as ConfigMap,
        );
      } else {
        target[key] = cloneConfigValue(value);
      }
    }
  }

  private detectChanges(
    oldConfig: ConfigMap,
    newConfig: ConfigMap,
  ): ConfigDiff {
    const changes: ConfigDiff = {};

    // Check for new or changed values
    this.detectChangesRecursive(oldConfig, newConfig, changes, "");

    // Check for removed values
    this.detectRemovedValues(oldConfig, newConfig, changes, "");

    return changes;
  }

  private detectChangesRecursive(
    oldObj: unknown,
    newObj: unknown,
    changes: ConfigDiff,
    prefix: string,
  ): void {
    if (!isRecord(newObj)) {
      return;
    }

    const oldRecord = isRecord(oldObj) ? oldObj : {};

    for (const [key, newValue] of Object.entries(newObj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const oldValue = oldRecord[key];

      if (isRecord(newValue)) {
        if (!isRecord(oldValue)) {
          changes[path] = newValue as ConfigValue;
        } else {
          this.detectChangesRecursive(oldValue, newValue, changes, path);
        }
      } else if (Array.isArray(newValue)) {
        if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
          changes[path] = newValue as ConfigValue;
        }
      } else if (oldValue !== newValue) {
        changes[path] = newValue as ConfigValue;
      }
    }
  }

  private detectRemovedValues(
    oldObj: unknown,
    newObj: unknown,
    changes: ConfigDiff,
    prefix: string,
  ): void {
    if (!isRecord(oldObj)) return;

    const newRecord = isRecord(newObj) ? newObj : {};

    for (const [key, oldValue] of Object.entries(oldObj)) {
      const path = prefix ? `${prefix}.${key}` : key;

      if (!(key in newRecord)) {
        changes[path] = undefined;
      } else if (isRecord(oldValue)) {
        this.detectRemovedValues(oldValue, newRecord[key], changes, path);
      }
    }
  }

  private getHotReloadableChanges(changes: ConfigDiff): ConfigDiff {
    const hotReloadable: ConfigDiff = {};

    for (const [path, value] of Object.entries(changes)) {
      const schemaEntry = this.schema[path];
      if (schemaEntry?.hotReloadable) {
        hotReloadable[path] = value;
      }
    }

    return hotReloadable;
  }

  private applyDefaults(): void {
    this.applyDefaultsToConfig(this.config);
  }

  private applyDefaultsToConfig(config: ConfigMap): void {
    for (const [path, schemaEntry] of Object.entries(this.schema)) {
      if (schemaEntry.default !== undefined && this.getValueByPath(config, path) === undefined) {
        this.setValueByPath(config, path, normalizeConfigValue(schemaEntry.default));
      }
    }
  }

  private validateConfiguration(config: ConfigMap = this.config): ConfigurationValidationResult {
    const errors: { path: string; message: string; value: unknown }[] = [];

    for (const [path, schemaEntry] of Object.entries(this.schema)) {
      const value = this.getValueByPath(config, path);

      // Check required fields
      if (schemaEntry.required && (value === undefined || value === null)) {
        errors.push({
          path,
          message: `Required field '${path}' is missing`,
          value,
        });
        continue;
      }

      // Skip validation if value is undefined and not required
      if (value === undefined && !schemaEntry.required) {
        continue;
      }

      const validationResult = this.validateValue(path, value, schemaEntry);
      if (validationResult !== true) {
        errors.push({
          path,
          message: validationResult,
          value,
        });
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  private validateValue(path: string, value: unknown, schemaEntry: ConfigurationSchema[string]): true | string {
    // Type validation
    const expectedType = schemaEntry.type;
    const actualType = Array.isArray(value) ? "array" : typeof value;

    if (actualType !== expectedType) {
      return `Expected type '${expectedType}' but got '${actualType}' for '${path}'`;
    }

    // Custom validation
    if (schemaEntry.validation) {
      const customResult = schemaEntry.validation(value);
      if (customResult !== true) {
        return typeof customResult === "string" ? customResult : `Custom validation failed for '${path}'`;
      }
    }

    return true;
  }

  private getValueByPath(obj: unknown, path: string): unknown {
    return path.split(".").reduce<unknown>((current, key) => {
      if (!isRecord(current)) {
        return undefined;
      }
      return current[key];
    }, obj);
  }

  private setValueByPath(obj: Record<string, unknown>, path: string, value: unknown): void {
    const keys = path.split(".");
    const lastKey = keys.pop();
    if (!lastKey) {
      return;
    }

    let current: Record<string, unknown> = obj;
    for (const key of keys) {
      const next = current[key];
      if (!isRecord(next)) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[lastKey] = value as ConfigValue;
  }

  private deleteValueByPath(obj: Record<string, unknown>, path: string): void {
    const keys = path.split(".");
    const lastKey = keys.pop();
    if (!lastKey) {
      return;
    }

    let current: Record<string, unknown> | undefined = obj;
    for (const key of keys) {
      const next = current[key];
      if (!isRecord(next)) {
        return;
      }
      current = next;
    }

    if (isRecord(current)) {
      delete current[lastKey];
    }
  }

  private maskSensitiveValues(obj: Record<string, unknown>): Record<string, unknown> {
    const masked: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const schemaEntry = this.schema[key];
      if (schemaEntry?.sensitive) {
        masked[key] = "***";
      } else if (isRecord(value)) {
        masked[key] = this.maskSensitiveValues(value);
      } else if (Array.isArray(value)) {
        masked[key] = value.map(item => (
          isRecord(item)
            ? this.maskSensitiveValues(item)
            : item
        ));
      } else {
        masked[key] = value;
      }
    }

    return masked;
  }

  public getMetrics(): ConfigurationMetrics {
    return { ...this.metrics };
  }

  public getSourceStatus(): Record<string, { healthy: boolean; lastUpdate: Date; errors: number }> {
    return { ...this.metrics.sourceStatus };
  }

  public getHistory(): { timestamp: Date; config: ConfigMap; source: string }[] {
    return this.configHistory.map(entry => ({
      timestamp: entry.timestamp,
      source: entry.source,
      config: cloneConfigMap(entry.config),
    }));
  }

  public async reload(): Promise<void> {
    logger.info("Manual configuration reload requested");
    await this.load();
  }

  public async shutdown(): Promise<void> {
    logger.info("Shutting down configuration management");

    // Stop all watchers
    for (const unwatch of this.watchers) {
      try {
        unwatch();
      } catch (error) {
        logger.warn("Error stopping configuration watcher", { error });
      }
    }

    this.watchers = [];
    this.metrics.watchersActive = 0;

    logger.info("Configuration management shutdown completed");
  }
}

// File-based configuration source
export class FileConfigurationSource implements ConfigurationSource {
  private watchHandle?: () => void;

  constructor(
    public name: string,
    public priority: number,
    private readonly filePath: string,
  ) {}

  async load(): Promise<ConfigMap> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const extension = path.extname(this.filePath).toLowerCase();

      let rawConfig: unknown;
      if (extension === ".json") {
        rawConfig = JSON.parse(content);
      } else if (extension === ".js" || extension === ".ts") {
        // Dynamic import for JS/TS files
        delete require.cache[require.resolve(this.filePath)];
        const module = require(this.filePath);
        rawConfig = module.default || module;
      } else {
        throw new Error(`Unsupported file extension: ${extension}`);
      }

      return toConfigMap(rawConfig, this.filePath);
    } catch (error) {
      throw new Error(`Failed to load configuration from ${this.filePath}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  watch(callback: (changes: ConfigMap) => void): () => void {
    if (this.watchHandle) {
      this.watchHandle();
    }

    const watchFile = async () => {
      try {
        const newConfig = await this.load();
        callback(newConfig);
      } catch (error) {
        logger.error("Error reloading configuration file", {
          file: this.filePath,
          error: (error as Error).message,
        });
      }
    };

    // Use fs.watch for file system monitoring
    const watcher = require("fs").watch(this.filePath, { persistent: false }, watchFile);

    this.watchHandle = () => {
      watcher.close();
    };

    return this.watchHandle;
  }
}

// Environment-based configuration source
export class EnvironmentConfigurationSource implements ConfigurationSource {
  constructor(
    public name: string,
    public priority: number,
    private readonly prefix = "",
  ) {}

  async load(): Promise<ConfigMap> {
    const config: ConfigMap = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (!this.prefix || key.startsWith(this.prefix)) {
        const configKey = this.prefix ? key.substring(this.prefix.length) : key;
        const configPath = configKey.toLowerCase().replace(/_/g, ".");

        // Try to parse as JSON, fallback to string
        let parsedValue: unknown = value ?? "";
        try {
          parsedValue = JSON.parse(parsedValue as string);
        } catch {
          // Keep as string
        }

        this.setValueByPath(config, configPath, normalizeConfigValue(parsedValue));
      }
    }

    return config;
  }

  private setValueByPath(obj: ConfigMap, path: string, value: ConfigValue): void {
    const keys = path.split(".");
    const lastKey = keys.pop();
    if (!lastKey) {
      return;
    }

    let current: Record<string, unknown> = obj;
    for (const key of keys) {
      const next = current[key];
      if (!isRecord(next)) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[lastKey] = value;
  }
}

// Convenience functions
export function getConfiguration(): DynamicConfiguration {
  return DynamicConfiguration.getInstance();
}

export function addFileSource(name: string, filePath: string, priority = 100): void {
  const source = new FileConfigurationSource(name, priority, filePath);
  getConfiguration().addSource(source);
}

export function addEnvironmentSource(name: string, prefix = "", priority = 200): void {
  const source = new EnvironmentConfigurationSource(name, priority, prefix);
  getConfiguration().addSource(source);
}

export function configValue<T = ConfigValue>(path: string, defaultValue?: T): T {
  return getConfiguration().get(path, defaultValue);
}

export function setConfigValue<T>(path: string, value: T): void {
  getConfiguration().set(path, value);
}
