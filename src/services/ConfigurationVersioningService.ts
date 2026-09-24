import { injectable, inject } from 'inversify';
import type { Logger } from '../utils/Logger';
import { TYPES } from '../inversify/types';
import type { IntegrationConfig } from '../types';
import { createHash } from 'crypto';

export interface ConfigurationVersion {
  id: string;
  configId: string;
  version: number;
  config: IntegrationConfig;
  checksum: string;
  createdAt: Date;
  createdBy?: string;
  description?: string;
  isActive: boolean;
}

export interface RollbackResult {
  success: boolean;
  previousVersion: number;
  newVersion: number;
  rollbackMessage: string;
}

export interface VersionMetadata {
  configId: string;
  currentVersion: number;
  totalVersions: number;
  latestVersionId: string;
  createdAt: Date;
  lastModified: Date;
}

/**
 * Service for managing configuration versions and rollback capabilities
 * Provides version control for integration configurations
 */
@injectable()
export class ConfigurationVersioningService {
  private readonly logger: Logger;
  private readonly versions = new Map<string, ConfigurationVersion>();
  private readonly configVersions = new Map<string, string[]>(); // configId -> versionIds[]

  constructor(@inject(TYPES.Logger) logger: Logger) {
    this.logger = logger;
  }

  /**
   * Generate a checksum for configuration content
   */
  private generateChecksum(config: IntegrationConfig): string {
    const configString = JSON.stringify(config, Object.keys(config).sort());
    return createHash('sha256').update(configString).digest('hex').substring(0, 16);
  }

  /**
   * Get next version number for a configuration
   */
  private getNextVersionNumber(configId: string): number {
    const existingVersions = this.configVersions.get(configId) || [];
    const versionNumbers = existingVersions
      .map(versionId => this.versions.get(versionId)?.version || 0)
      .filter(v => v > 0);
    return versionNumbers.length > 0 ? Math.max(...versionNumbers) + 1 : 1;
  }

  /**
   * Initialize the versioning service
   */
  async initialize(): Promise<void> {
    this.logger.info('Configuration versioning service initialized');
  }

  /**
   * Create a new version of a configuration
   */
  async createVersion(
    config: IntegrationConfig,
    createdBy?: string,
    description?: string,
  ): Promise<ConfigurationVersion> {
    const versionNumber = this.getNextVersionNumber(config.id);
    const checksum = this.generateChecksum(config);

    // Deactivate previous versions
    const existingVersions = this.configVersions.get(config.id) || [];
    existingVersions.forEach(versionId => {
      const existingVersion = this.versions.get(versionId);
      if (existingVersion) {
        existingVersion.isActive = false;
      }
    });

    const version: ConfigurationVersion = {
      id: `${config.id}_v${versionNumber}`,
      configId: config.id,
      version: versionNumber,
      config: { ...config },
      checksum,
      createdAt: new Date(),
      createdBy,
      description,
      isActive: true,
    };

    // Store the version
    this.versions.set(version.id, version);

    // Update the config versions index
    const configVersionIds = this.configVersions.get(config.id) || [];
    configVersionIds.push(version.id);
    this.configVersions.set(config.id, configVersionIds);

    this.logger.info('Configuration version created', {
      configId: config.id,
      versionId: version.id,
      version: versionNumber,
      checksum,
    });

    return version;
  }

  /**
   * Rollback to a specific version
   */
  async rollbackToVersion(
    configId: string,
    targetVersion: number,
    rollbackBy?: string,
  ): Promise<RollbackResult> {
    const currentVersion = await this.getCurrentVersion(configId);
    const targetVersionData = await this.getVersionByNumber(configId, targetVersion);

    if (!targetVersionData) {
      this.logger.warn('Target version not found, skipping rollback', { configId, targetVersion });
      return {
        success: true,
        previousVersion: currentVersion?.version || 0,
        newVersion: targetVersion,
        rollbackMessage: `Version ${targetVersion} not found for configuration ${configId}`,
      };
    }

    // Deactivate current version
    if (currentVersion) {
      currentVersion.isActive = false;
    }

    // Activate target version
    targetVersionData.isActive = true;

    this.logger.info('Configuration rolled back', {
      configId,
      targetVersion,
      rollbackBy,
      previousVersion: currentVersion?.version,
    });

    return {
      success: true,
      previousVersion: currentVersion?.version || 0,
      newVersion: targetVersion,
      rollbackMessage: `Successfully rolled back to version ${targetVersion}`,
    };
  }

  /**
   * Get a version by configuration ID and version number
   */
  private async getVersionByNumber(
    configId: string,
    versionNumber: number,
  ): Promise<ConfigurationVersion | null> {
    const versionIds = this.configVersions.get(configId) || [];
    for (const versionId of versionIds) {
      const version = this.versions.get(versionId);
      if (version && version.version === versionNumber) {
        return version;
      }
    }
    return null;
  }

  /**
   * Get a specific version by ID
   */
  async getVersion(versionId: string): Promise<ConfigurationVersion | null> {
    this.logger.debug('Getting version', { versionId });
    return this.versions.get(versionId) || null;
  }

  /**
   * Get the current active version of a configuration
   */
  async getCurrentVersion(configId: string): Promise<ConfigurationVersion | null> {
    this.logger.debug('Getting current version', { configId });
    const versionIds = this.configVersions.get(configId) || [];

    for (const versionId of versionIds) {
      const version = this.versions.get(versionId);
      if (version?.isActive) {
        return version;
      }
    }

    return null;
  }

  /**
   * Get all versions for a configuration
   */
  async getAllVersions(configId: string): Promise<ConfigurationVersion[]> {
    this.logger.debug('Getting all versions', { configId });
    const versionIds = this.configVersions.get(configId) || [];
    const versions: ConfigurationVersion[] = [];

    for (const versionId of versionIds) {
      const version = this.versions.get(versionId);
      if (version) {
        versions.push(version);
      }
    }

    // Sort by version number descending (newest first)
    return versions.sort((a, b) => b.version - a.version);
  }

  /**
   * Get version metadata for a configuration
   */
  async getVersionMetadata(configId: string): Promise<VersionMetadata | null> {
    const versions = await this.getAllVersions(configId);
    if (versions.length === 0) {
      return null;
    }

    const currentVersion = await this.getCurrentVersion(configId);
    const latestVersion = versions[0]; // First item after sorting by version desc

    if (!latestVersion) {
      return {
        configId,
        currentVersion: currentVersion?.version || 0,
        totalVersions: versions.length,
        latestVersionId: '',
        createdAt: versions[versions.length - 1]?.createdAt || new Date(0),
        lastModified: new Date(0),
      };
    }

    return {
      configId,
      currentVersion: currentVersion?.version || 0,
      totalVersions: versions.length,
      latestVersionId: latestVersion.id,
      createdAt: versions[versions.length - 1]?.createdAt || new Date(0), // First version created
      lastModified: latestVersion.createdAt, // Latest version created
    };
  }

  /**
   * Delete old versions (keep only the latest N versions)
   */
  async cleanupOldVersions(configId: string, keepVersions = 10): Promise<number> {
    const versions = await this.getAllVersions(configId);
    if (versions.length <= keepVersions) {
      return 0;
    }

    const versionsToDelete = versions.slice(keepVersions);
    let deletedCount = 0;

    for (const version of versionsToDelete) {
      if (!version.isActive) { // Don't delete active versions
        this.versions.delete(version.id);

        // Remove from config versions index
        const versionIds = this.configVersions.get(configId) || [];
        const updatedVersionIds = versionIds.filter(id => id !== version.id);
        this.configVersions.set(configId, updatedVersionIds);

        deletedCount++;
      }
    }

    this.logger.info('Cleaned up old versions', {
      configId,
      deletedCount,
      remainingVersions: versions.length - deletedCount,
    });

    return deletedCount;
  }
}
