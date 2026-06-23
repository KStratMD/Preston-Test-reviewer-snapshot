/**
 * ConfigurationVersioningService Tests
 * Tests for configuration version control and rollback capabilities
 */

import 'reflect-metadata';
import { ConfigurationVersioningService, ConfigurationVersion } from '../../../src/services/ConfigurationVersioningService';
import type { IntegrationConfig } from '../../../src/types';

describe('ConfigurationVersioningService', () => {
  let service: ConfigurationVersioningService;
  let mockLogger: any;

  beforeEach(() => {
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    service = new ConfigurationVersioningService(mockLogger);
  });

  const createMockConfig = (id: string, overrides?: Partial<IntegrationConfig>): IntegrationConfig => ({
    id,
    name: `Test Config ${id}`,
    sourceConnector: 'salesforce',
    targetConnector: 'netsuite',
    enabled: true,
    schedule: '0 * * * *',
    fieldMappings: [],
    ...overrides,
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      await service.initialize();
      expect(mockLogger.info).toHaveBeenCalledWith('Configuration versioning service initialized');
    });
  });

  describe('createVersion', () => {
    it('should create first version with version number 1', async () => {
      const config = createMockConfig('config-1');

      const version = await service.createVersion(config);

      expect(version.id).toBe('config-1_v1');
      expect(version.configId).toBe('config-1');
      expect(version.version).toBe(1);
      expect(version.isActive).toBe(true);
      expect(version.checksum).toBeDefined();
      expect(version.checksum.length).toBe(16);
    });

    it('should create subsequent versions with incrementing numbers', async () => {
      const config = createMockConfig('config-1');

      const v1 = await service.createVersion(config);
      const v2 = await service.createVersion(config);
      const v3 = await service.createVersion(config);

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
    });

    it('should deactivate previous versions when creating new version', async () => {
      const config = createMockConfig('config-1');

      const v1 = await service.createVersion(config);
      expect(v1.isActive).toBe(true);

      const v2 = await service.createVersion(config);

      const currentV1 = await service.getVersion(v1.id);
      expect(currentV1?.isActive).toBe(false);
      expect(v2.isActive).toBe(true);
    });

    it('should store createdBy metadata', async () => {
      const config = createMockConfig('config-1');

      const version = await service.createVersion(config, 'user-123');

      expect(version.createdBy).toBe('user-123');
    });

    it('should store description metadata', async () => {
      const config = createMockConfig('config-1');

      const version = await service.createVersion(config, 'user-123', 'Initial configuration');

      expect(version.description).toBe('Initial configuration');
    });

    it('should generate different checksums for different configs', async () => {
      const config1 = createMockConfig('config-1', { name: 'Config A' });
      const config2 = createMockConfig('config-2', { name: 'Config B' });

      const v1 = await service.createVersion(config1);
      const v2 = await service.createVersion(config2);

      expect(v1.checksum).not.toBe(v2.checksum);
    });

    it('should generate different checksums when IDs differ', async () => {
      // Configs with different IDs have different checksums (ID is part of the config)
      const config1 = createMockConfig('config-1', { name: 'Config A' });
      const config2 = createMockConfig('config-2', { name: 'Config A' });

      const v1 = await service.createVersion(config1);
      const v2 = await service.createVersion(config2);

      // Different IDs mean different checksums
      expect(v1.checksum).not.toBe(v2.checksum);
    });

    it('should generate same checksums for same config versions', async () => {
      const config = createMockConfig('config-1', { name: 'Config A' });

      const v1 = await service.createVersion(config);
      // Recreate service to test fresh checksum calculation
      const service2 = new ConfigurationVersioningService(mockLogger);
      const v2 = await service2.createVersion(config);

      // Same config content should have same checksum
      expect(v1.checksum).toBe(v2.checksum);
    });

    it('should copy config to prevent mutations', async () => {
      const config = createMockConfig('config-1');

      const version = await service.createVersion(config);
      config.name = 'Modified Name';

      expect(version.config.name).toBe('Test Config config-1');
    });

    it('should log version creation', async () => {
      const config = createMockConfig('config-1');

      await service.createVersion(config);

      expect(mockLogger.info).toHaveBeenCalledWith('Configuration version created', expect.objectContaining({
        configId: 'config-1',
        versionId: 'config-1_v1',
        version: 1,
      }));
    });
  });

  describe('getVersion', () => {
    it('should return version by ID', async () => {
      const config = createMockConfig('config-1');
      const created = await service.createVersion(config);

      const retrieved = await service.getVersion(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
    });

    it('should return null for non-existent version', async () => {
      const result = await service.getVersion('non-existent');
      expect(result).toBeNull();
    });

    it('should log debug message', async () => {
      await service.getVersion('some-version');
      expect(mockLogger.debug).toHaveBeenCalledWith('Getting version', { versionId: 'some-version' });
    });
  });

  describe('getCurrentVersion', () => {
    it('should return the active version', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      await service.createVersion(config);
      const v3 = await service.createVersion(config);

      const current = await service.getCurrentVersion('config-1');

      expect(current?.id).toBe(v3.id);
      expect(current?.version).toBe(3);
      expect(current?.isActive).toBe(true);
    });

    it('should return null for config with no versions', async () => {
      const result = await service.getCurrentVersion('non-existent');
      expect(result).toBeNull();
    });

    it('should log debug message', async () => {
      await service.getCurrentVersion('config-1');
      expect(mockLogger.debug).toHaveBeenCalledWith('Getting current version', { configId: 'config-1' });
    });
  });

  describe('getAllVersions', () => {
    it('should return all versions sorted by version number descending', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      await service.createVersion(config);
      await service.createVersion(config);

      const versions = await service.getAllVersions('config-1');

      expect(versions.length).toBe(3);
      expect(versions[0].version).toBe(3);
      expect(versions[1].version).toBe(2);
      expect(versions[2].version).toBe(1);
    });

    it('should return empty array for config with no versions', async () => {
      const versions = await service.getAllVersions('non-existent');
      expect(versions).toEqual([]);
    });

    it('should log debug message', async () => {
      await service.getAllVersions('config-1');
      expect(mockLogger.debug).toHaveBeenCalledWith('Getting all versions', { configId: 'config-1' });
    });
  });

  describe('rollbackToVersion', () => {
    it('should rollback to specified version', async () => {
      const config = createMockConfig('config-1');
      const v1 = await service.createVersion(config);
      await service.createVersion(config);
      await service.createVersion(config);

      const result = await service.rollbackToVersion('config-1', 1);

      expect(result.success).toBe(true);
      expect(result.previousVersion).toBe(3);
      expect(result.newVersion).toBe(1);
      expect(result.rollbackMessage).toContain('Successfully rolled back to version 1');

      const current = await service.getCurrentVersion('config-1');
      expect(current?.version).toBe(1);
    });

    it('should deactivate current version on rollback', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      const v2 = await service.createVersion(config);

      await service.rollbackToVersion('config-1', 1);

      const v2After = await service.getVersion(v2.id);
      expect(v2After?.isActive).toBe(false);
    });

    it('should handle rollback when target version not found', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);

      const result = await service.rollbackToVersion('config-1', 99);

      expect(result.success).toBe(true);
      expect(result.rollbackMessage).toContain('Version 99 not found');
    });

    it('should handle rollback with no current version', async () => {
      const result = await service.rollbackToVersion('non-existent', 1);

      expect(result.success).toBe(true);
      expect(result.previousVersion).toBe(0);
    });

    it('should log rollback with user info', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      await service.createVersion(config);

      await service.rollbackToVersion('config-1', 1, 'admin-user');

      expect(mockLogger.info).toHaveBeenCalledWith('Configuration rolled back', expect.objectContaining({
        configId: 'config-1',
        targetVersion: 1,
        rollbackBy: 'admin-user',
      }));
    });
  });

  describe('getVersionMetadata', () => {
    it('should return metadata for config with versions', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      await service.createVersion(config);
      await service.createVersion(config);

      const metadata = await service.getVersionMetadata('config-1');

      expect(metadata).toBeDefined();
      expect(metadata?.configId).toBe('config-1');
      expect(metadata?.currentVersion).toBe(3);
      expect(metadata?.totalVersions).toBe(3);
      expect(metadata?.latestVersionId).toBe('config-1_v3');
    });

    it('should return null for config with no versions', async () => {
      const metadata = await service.getVersionMetadata('non-existent');
      expect(metadata).toBeNull();
    });

    it('should track creation and modification dates', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);

      // Small delay
      await new Promise(resolve => setTimeout(resolve, 10));
      await service.createVersion(config);

      const metadata = await service.getVersionMetadata('config-1');

      expect(metadata?.createdAt).toBeDefined();
      expect(metadata?.lastModified).toBeDefined();
      expect(metadata?.lastModified.getTime()).toBeGreaterThanOrEqual(metadata?.createdAt.getTime() || 0);
    });

    it('should handle rollback affecting current version', async () => {
      const config = createMockConfig('config-1');
      await service.createVersion(config);
      await service.createVersion(config);
      await service.rollbackToVersion('config-1', 1);

      const metadata = await service.getVersionMetadata('config-1');

      expect(metadata?.currentVersion).toBe(1);
      expect(metadata?.totalVersions).toBe(2);
    });
  });

  describe('cleanupOldVersions', () => {
    it('should keep only specified number of versions', async () => {
      const config = createMockConfig('config-1');

      // Create 15 versions
      for (let i = 0; i < 15; i++) {
        await service.createVersion(config);
      }

      const deletedCount = await service.cleanupOldVersions('config-1', 10);

      expect(deletedCount).toBe(5);

      const remainingVersions = await service.getAllVersions('config-1');
      expect(remainingVersions.length).toBe(10);
    });

    it('should not delete if under threshold', async () => {
      const config = createMockConfig('config-1');

      for (let i = 0; i < 5; i++) {
        await service.createVersion(config);
      }

      const deletedCount = await service.cleanupOldVersions('config-1', 10);

      expect(deletedCount).toBe(0);
    });

    it('should not delete active versions', async () => {
      const config = createMockConfig('config-1');

      // Create versions and rollback to version 2
      for (let i = 0; i < 15; i++) {
        await service.createVersion(config);
      }
      await service.rollbackToVersion('config-1', 2);

      const deletedCount = await service.cleanupOldVersions('config-1', 5);

      // Version 2 should still exist because it's active
      const v2 = await service.getVersion('config-1_v2');
      expect(v2).toBeDefined();
      expect(v2?.isActive).toBe(true);
    });

    it('should use default keep count of 10', async () => {
      const config = createMockConfig('config-1');

      for (let i = 0; i < 15; i++) {
        await service.createVersion(config);
      }

      const deletedCount = await service.cleanupOldVersions('config-1');

      expect(deletedCount).toBe(5);
    });

    it('should log cleanup results', async () => {
      const config = createMockConfig('config-1');

      for (let i = 0; i < 15; i++) {
        await service.createVersion(config);
      }

      await service.cleanupOldVersions('config-1', 10);

      expect(mockLogger.info).toHaveBeenCalledWith('Cleaned up old versions', expect.objectContaining({
        configId: 'config-1',
        deletedCount: 5,
      }));
    });

    it('should return 0 for non-existent config', async () => {
      const deletedCount = await service.cleanupOldVersions('non-existent');
      expect(deletedCount).toBe(0);
    });
  });

  describe('version isolation between configs', () => {
    it('should maintain separate version sequences per config', async () => {
      const config1 = createMockConfig('config-1');
      const config2 = createMockConfig('config-2');

      const v1_1 = await service.createVersion(config1);
      const v2_1 = await service.createVersion(config2);
      const v1_2 = await service.createVersion(config1);
      const v2_2 = await service.createVersion(config2);

      expect(v1_1.version).toBe(1);
      expect(v1_2.version).toBe(2);
      expect(v2_1.version).toBe(1);
      expect(v2_2.version).toBe(2);
    });

    it('should return only versions for specified config', async () => {
      const config1 = createMockConfig('config-1');
      const config2 = createMockConfig('config-2');

      await service.createVersion(config1);
      await service.createVersion(config1);
      await service.createVersion(config2);

      const config1Versions = await service.getAllVersions('config-1');
      const config2Versions = await service.getAllVersions('config-2');

      expect(config1Versions.length).toBe(2);
      expect(config2Versions.length).toBe(1);
    });

    it('should rollback config independently', async () => {
      const config1 = createMockConfig('config-1');
      const config2 = createMockConfig('config-2');

      await service.createVersion(config1);
      await service.createVersion(config1);
      await service.createVersion(config2);
      await service.createVersion(config2);

      await service.rollbackToVersion('config-1', 1);

      const current1 = await service.getCurrentVersion('config-1');
      const current2 = await service.getCurrentVersion('config-2');

      expect(current1?.version).toBe(1);
      expect(current2?.version).toBe(2);
    });
  });
});
