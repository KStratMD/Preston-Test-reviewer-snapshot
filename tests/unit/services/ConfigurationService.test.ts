/**
 * ConfigurationService Unit Tests
 * Tests for integration configuration management
 */

import 'reflect-metadata';

// Mock fs promises - must be before imports due to hoisting
jest.mock('fs', () => ({
  promises: {
    readdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    unlink: jest.fn(),
    access: jest.fn(),
    mkdir: jest.fn(),
  },
}));

import { promises as fs } from 'fs';
import { ConfigurationService } from '../../../src/services/ConfigurationService';
import { ValidationError } from '../../../src/errors/ConfigurationErrors';
import type { IntegrationConfig } from '../../../src/types';

const mockFs = fs as jest.Mocked<typeof fs>;

// Mock the in-tree uuid wrapper (the npm `uuid` package was removed; src/utils/uuid.ts
// now wraps node:crypto.randomUUID — see PR #714).
jest.mock('../../../src/utils/uuid', () => ({
  uuidv4: jest.fn(() => 'test-uuid-1234'),
}));

// Mock validateIntegrationConfig
jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn((config: any) => ({
    isValid: true,
    errors: [],
    warnings: [],
  })),
}));

// loadConfigurations reads the top-level config dir with { withFileTypes: true }
// and loads only top-level *.json files (subdirs hold connector artifacts and are
// ignored). This helper stages readdir to return the supplied names as flat-file
// Dirents so existing tests don't need rewriting.
function makeDirent(name: string, isDir: boolean): any {
  return { name, isDirectory: () => isDir, isFile: () => !isDir };
}

/** Stages readdir(configDir, { withFileTypes: true }) to return the supplied file
 * names as flat-file Dirents (isFile() === true). */
function stageTenantReaddir(mockFn: jest.Mock, files: string[]) {
  mockFn.mockResolvedValue(files.map(name => makeDirent(name, false)));
}

describe('ConfigurationService', () => {
  let service: ConfigurationService;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let validateIntegrationConfig: jest.Mock;

  const validConfig: IntegrationConfig = {
    id: 'config-123',
    tenantId: 'tenant-a',
    name: 'Test Config',
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
    ],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };
    mockFs.access.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);

    validateIntegrationConfig = require('../../../src/schemas/configurationSchemas').validateIntegrationConfig;
    validateIntegrationConfig.mockReturnValue({
      isValid: true,
      errors: [],
      warnings: [],
    });

    service = new ConfigurationService(mockLogger as any, './test-config');
  });

  describe('constructor', () => {
    it('should initialize with default config directory', () => {
      const svc = new ConfigurationService(mockLogger as any);
      expect(svc).toBeDefined();
    });

    it('should initialize with custom config directory', () => {
      const svc = new ConfigurationService(mockLogger as any, '/custom/path');
      expect(svc).toBeDefined();
    });

    it('should create config directory if it does not exist', async () => {
      mockFs.access.mockRejectedValueOnce(new Error('ENOENT'));

      new ConfigurationService(mockLogger as any, '/new/path');

      // Constructor calls ensureConfigDirectory synchronously
      await new Promise(resolve => setTimeout(resolve, 10));
    });
  });

  describe('loadConfigurations()', () => {
    it('should load all JSON files from config directory', async () => {
      // Filenames must be canonical ${id}.json (loader fails closed otherwise).
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-1.json', 'config-2.json', 'readme.txt']);
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('config-1')) {
          return Promise.resolve(JSON.stringify({ ...validConfig, id: 'config-1', name: 'Config 1' }));
        }
        return Promise.resolve(JSON.stringify({ ...validConfig, id: 'config-2', name: 'Config 2' }));
      });

      await service.loadConfigurations();

      expect(mockFs.readdir).toHaveBeenCalled();
      expect(mockFs.readFile).toHaveBeenCalledTimes(2);
      expect(service.getAllConfigurations().length).toBe(2);
    });

    it('should skip non-JSON files', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json', 'readme.md', 'notes.txt']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));

      await service.loadConfigurations();

      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should throw ConfigurationLoadError when file has invalid JSON', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['invalid.json']);
      mockFs.readFile.mockResolvedValue('not valid json');

      await expect(service.loadConfigurations()).rejects.toThrow();
    });

    it('should throw when configuration is missing required fields', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['incomplete.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify({ id: 'test' }));

      await expect(service.loadConfigurations()).rejects.toThrow();
    });

    it('should log loaded configurations count', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));

      await service.loadConfigurations();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Successfully loaded'));
    });

    it('should handle empty directory', async () => {
      // No tenant subdirectories at the root.
      (mockFs.readdir as unknown as jest.Mock).mockResolvedValue([]);

      await service.loadConfigurations();

      expect(service.getAllConfigurations().length).toBe(0);
    });
  });

  describe('getConfiguration()', () => {
    beforeEach(async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
    });

    it('should return configuration by ID', () => {
      const config = service.getConfiguration('config-123');
      expect(config).toBeDefined();
      expect(config?.id).toBe('config-123');
    });

    it('should return undefined for non-existent ID', () => {
      const config = service.getConfiguration('non-existent');
      expect(config).toBeUndefined();
    });

    it('getConfigurationForTenant returns config only when tenant matches', () => {
      expect(service.getConfigurationForTenant('tenant-a', 'config-123')?.id).toBe('config-123');
      expect(service.getConfigurationForTenant('tenant-b', 'config-123')).toBeUndefined();
    });
  });

  describe('getAllConfigurations()', () => {
    it('should return empty array when no configurations', () => {
      const configs = service.getAllConfigurations();
      expect(configs).toEqual([]);
    });

    it('should return all loaded configurations', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['c1.json', 'c2.json']);
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c1' }))
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c2' }));

      await service.loadConfigurations();

      const configs = service.getAllConfigurations();
      expect(configs.length).toBe(2);
    });
  });

  describe('saveConfiguration()', () => {
    it('should save valid configuration to memory and file', async () => {
      await service.saveConfiguration(validConfig);

      expect(mockFs.writeFile).toHaveBeenCalled();
      expect(service.getConfiguration('config-123')).toBeDefined();
    });

    it('should generate ID if not provided', async () => {
      const configWithoutId = { ...validConfig, id: undefined as any };

      await service.saveConfiguration(configWithoutId);

      expect(mockFs.writeFile).toHaveBeenCalled();
    });

    it('should add timestamps', async () => {
      const configWithoutDates = { ...validConfig, createdAt: undefined, updatedAt: undefined };

      await service.saveConfiguration(configWithoutDates as any);

      const saved = service.getConfiguration(validConfig.id);
      expect(saved?.createdAt).toBeDefined();
      expect(saved?.updatedAt).toBeDefined();
    });

    it('should throw ValidationError for invalid configuration', async () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: false,
        errors: ['Missing required field'],
        warnings: [],
      });

      await expect(service.saveConfiguration(validConfig)).rejects.toThrow();
    });

    it('should log successful save', async () => {
      await service.saveConfiguration(validConfig);

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Configuration saved'));
    });

    it('rejects a concurrent cross-tenant save of the same id (race-safe)', async () => {
      // Copilot review: the cross-tenant guard must hold under concurrency. The
      // first save sets memory then awaits a (here, deliberately pending) write;
      // a second save of the same id under a different tenant must see that
      // in-memory entry and 409 rather than racing to overwrite ${id}.json.
      let resolveWrite!: () => void;
      (mockFs.writeFile as jest.Mock).mockImplementationOnce(
        () => new Promise<void>(resolve => { resolveWrite = resolve; }),
      );

      const first = service.saveConfiguration({ ...validConfig, id: 'shared', tenantId: 'tenant-a' });

      await expect(
        service.saveConfiguration({ ...validConfig, id: 'shared', tenantId: 'tenant-b' }),
      ).rejects.toThrow(/already in use/);

      resolveWrite();
      await first;
      expect(service.getConfigurationForTenant('tenant-a', 'shared')).toBeDefined();
      expect(service.getConfigurationForTenant('tenant-b', 'shared')).toBeUndefined();
    });

    it('should restore the previous in-memory value when an update write fails', async () => {
      // Rollback must restore the prior version, not delete it, when overwriting
      // an existing config and the write fails.
      await service.saveConfiguration({ ...validConfig, id: 'cfg', name: 'Original' });
      mockFs.writeFile.mockRejectedValueOnce(new Error('disk full'));

      await expect(
        service.saveConfiguration({ ...validConfig, id: 'cfg', name: 'Updated' }),
      ).rejects.toThrow(/disk full/);

      expect(service.getConfigurationForTenant('tenant-a', 'cfg')?.name).toBe('Original');
    });

    it('should not leave the config in memory when the disk write fails', async () => {
      // Codex review: disk is the source of truth on restart, so a writeFile
      // failure must propagate and NOT leave the config readable from memory
      // (ghost state that would also block later writes via the id guard).
      mockFs.writeFile.mockRejectedValueOnce(new Error('disk full'));

      await expect(service.saveConfiguration(validConfig)).rejects.toThrow(/disk full/);
      expect(service.getConfiguration('config-123')).toBeUndefined();
    });
  });

  describe('deleteConfiguration()', () => {
    beforeEach(async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
    });

    it('should delete configuration from memory and file', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      const result = await service.deleteConfiguration('config-123');

      expect(result).toBe(true);
      expect(mockFs.unlink).toHaveBeenCalled();
      expect(service.getConfiguration('config-123')).toBeUndefined();
    });

    it('should return false for non-existent configuration', async () => {
      const result = await service.deleteConfiguration('non-existent');

      expect(result).toBe(false);
      expect(mockFs.unlink).not.toHaveBeenCalled();
    });

    it('should treat ENOENT (file already gone) as a successful delete', async () => {
      const enoent = Object.assign(new Error('not found'), { code: 'ENOENT' });
      mockFs.unlink.mockRejectedValueOnce(enoent);

      const result = await service.deleteConfiguration('config-123');

      expect(result).toBe(true);
      expect(service.getConfiguration('config-123')).toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should surface a real unlink failure and keep the in-memory entry (no false durability)', async () => {
      // Codex review: a non-ENOENT unlink failure means the file persists and
      // would resurface on reload — the delete must throw and NOT drop memory.
      const eacces = Object.assign(new Error('permission denied'), { code: 'EACCES' });
      mockFs.unlink.mockRejectedValueOnce(eacces);

      await expect(service.deleteConfiguration('config-123')).rejects.toThrow(/permission denied/);
      expect(service.getConfiguration('config-123')).toBeDefined();
    });

    it('should log successful deletion', async () => {
      mockFs.unlink.mockResolvedValue(undefined);

      await service.deleteConfiguration('config-123');

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('deleted'));
    });
  });

  describe('validateConfiguration()', () => {
    it('should return valid result for valid configuration', () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const result = service.validateConfiguration(validConfig);

      expect(result.isValid).toBe(true);
      expect(result.errors.length).toBe(0);
    });

    it('should add warning for empty field mappings', () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const configNoMappings = { ...validConfig, fieldMappings: [] };
      const result = service.validateConfiguration(configNoMappings);

      expect(result.warnings).toContain('No field mappings defined - data may not sync properly');
    });

    it('should add warning for large batch size', () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const configLargeBatch = { ...validConfig, batchSize: 2000 };
      const result = service.validateConfiguration(configLargeBatch);

      expect(result.warnings).toContain('Large batch sizes may impact performance');
    });

    it('should add warning for realtime sync without target auth', () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: true,
        errors: [],
        warnings: [],
      });

      const configRealtime = { ...validConfig, syncMode: 'realtime' as const, targetAuthentication: undefined };
      const result = service.validateConfiguration(configRealtime);

      expect(result.warnings).toContain('Real-time sync without target authentication may cause issues');
    });

    it('should handle validation exceptions', () => {
      validateIntegrationConfig.mockImplementation(() => {
        throw new Error('Validation failed');
      });

      const result = service.validateConfiguration(validConfig);

      expect(result.isValid).toBe(false);
      expect(result.errors[0]).toContain('Validation error');
    });
  });

  describe('createSampleConfiguration()', () => {
    it('should create a valid sample configuration', () => {
      const sample = service.createSampleConfiguration('tenant-a');

      expect(sample.id).toBeDefined();
      expect(sample.name).toBe('Sample Salesforce to NetSuite Customer Sync');
      expect(sample.sourceSystem).toBe('Salesforce');
      expect(sample.targetSystem).toBe('NetSuite');
      expect(sample.fieldMappings.length).toBeGreaterThan(0);
    });

    it('should include transformation rules', () => {
      const sample = service.createSampleConfiguration('tenant-a');

      expect(sample.transformationRules).toBeDefined();
      expect(sample.transformationRules!.length).toBeGreaterThan(0);
    });

    it('should include authentication configurations', () => {
      const sample = service.createSampleConfiguration('tenant-a');

      expect(sample.sourceAuthentication).toBeDefined();
      expect(sample.targetAuthentication).toBeDefined();
    });

    it('should include timestamps', () => {
      const sample = service.createSampleConfiguration('tenant-a');

      expect(sample.createdAt).toBeInstanceOf(Date);
      expect(sample.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('exportConfiguration()', () => {
    beforeEach(async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
    });

    it('should export configuration as JSON string', async () => {
      const exported = await service.exportConfigurationForTenant('tenant-a', 'config-123');

      expect(typeof exported).toBe('string');
      const parsed = JSON.parse(exported);
      expect(parsed.id).toBe('config-123');
    });

    it('should throw for non-existent configuration', async () => {
      await expect(service.exportConfigurationForTenant('tenant-a', 'non-existent')).rejects.toThrow('not found');
    });

    it('should format JSON with indentation', async () => {
      const exported = await service.exportConfigurationForTenant('tenant-a', 'config-123');

      expect(exported).toContain('\n');
    });
  });

  describe('importConfiguration()', () => {
    it('should import valid JSON configuration', async () => {
      const configJson = JSON.stringify(validConfig);

      const imported = await service.importConfiguration(configJson);

      expect(imported.id).toBe('config-123');
      expect(service.getConfiguration('config-123')).toBeDefined();
    });

    it('should throw for invalid JSON', async () => {
      await expect(service.importConfiguration('not json')).rejects.toThrow('Invalid JSON');
    });

    it('should throw for empty string', async () => {
      await expect(service.importConfiguration('')).rejects.toThrow('non-empty string');
    });

    it('should throw for non-string input', async () => {
      await expect(service.importConfiguration(null as any)).rejects.toThrow('non-empty string');
    });

    it('should validate imported configuration', async () => {
      validateIntegrationConfig.mockReturnValue({
        isValid: false,
        errors: ['Invalid field'],
        warnings: [],
      });

      await expect(service.importConfiguration(JSON.stringify(validConfig))).rejects.toThrow('Invalid configuration');
    });
  });

  describe('getConfigurationStatistics()', () => {
    beforeEach(async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['c1.json', 'c2.json', 'c3.json']);
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c1', isActive: true, syncMode: 'batch' }))
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c2', isActive: false, syncMode: 'realtime' }))
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c3', isActive: true, syncMode: 'batch' }));
      await service.loadConfigurations();
    });

    it('should return total configuration count', () => {
      const stats = service.getConfigurationStatistics();

      expect(stats.total).toBe(3);
    });

    it('should return active configuration count', () => {
      const stats = service.getConfigurationStatistics();

      expect(stats.active).toBe(2);
    });

    it('should group by source system', () => {
      const stats = service.getConfigurationStatistics();

      expect((stats.bySystem as any)['Salesforce']).toBe(3);
    });

    it('should group by sync mode', () => {
      const stats = service.getConfigurationStatistics();

      expect((stats.bySyncMode as any)['batch']).toBe(2);
      expect((stats.bySyncMode as any)['realtime']).toBe(1);
    });

    it('should handle empty configurations', () => {
      const emptyService = new ConfigurationService(mockLogger as any, './empty');
      const stats = emptyService.getConfigurationStatistics();

      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
    });
  });

  describe('exportAll()', () => {
    beforeEach(async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['c1.json', 'c2.json']);
      mockFs.readFile
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c1' }))
        .mockResolvedValueOnce(JSON.stringify({ ...validConfig, id: 'c2' }));
      await service.loadConfigurations();
    });

    it('should export all configurations', async () => {
      const exported = await service.exportAll();

      expect(exported.configurations.length).toBe(2);
      expect(exported.totalConfigurations).toBe(2);
    });

    it('should include config directory', async () => {
      const exported = await service.exportAll();

      expect(exported.configDirectory).toBe('./test-config');
    });

    it('should include timestamp', async () => {
      const exported = await service.exportAll();

      expect(exported.timestamp).toBeDefined();
    });
  });

  describe('importAll()', () => {
    it('should import all configurations from backup', async () => {
      const backup = {
        configurations: [
          { ...validConfig, id: 'imported-1' },
          { ...validConfig, id: 'imported-2' },
        ],
      };

      await service.importAll(backup);

      expect(service.getAllConfigurations().length).toBe(2);
      expect(mockFs.writeFile).toHaveBeenCalledTimes(2);
    });

    it('should clear existing configurations before import', async () => {
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();

      const backup = {
        configurations: [{ ...validConfig, id: 'new-config' }],
      };

      await service.importAll(backup);

      expect(service.getAllConfigurations().length).toBe(1);
      expect(service.getConfiguration('new-config')).toBeDefined();
    });

    it('should skip invalid configurations', async () => {
      validateIntegrationConfig
        .mockReturnValueOnce({ isValid: true, errors: [], warnings: [] })
        .mockReturnValueOnce({ isValid: false, errors: ['Invalid'], warnings: [] });

      const backup = {
        configurations: [
          { ...validConfig, id: 'valid' },
          { ...validConfig, id: 'invalid' },
        ],
      };

      await service.importAll(backup);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid'),
        expect.any(Object)
      );
    });

    it('should handle missing configurations in import data', async () => {
      await service.importAll({});

      expect(mockLogger.warn).toHaveBeenCalledWith('No configurations found in import data');
    });

    it('should delete stale on-disk config files not present in the imported set', async () => {
      // Codex/Copilot: a restore must be durable on restart — top-level
      // ${id}.json files absent from the backup are removed so loadConfigurations()
      // doesn't resurface them. Subdirectories (ERP artifacts) are left alone.
      (mockFs.readdir as unknown as jest.Mock).mockResolvedValue([
        makeDirent('imported-1.json', false),
        makeDirent('stale.json', false),
        makeDirent('business_central', true),
      ]);
      mockFs.unlink.mockResolvedValue(undefined);

      await service.importAll({ configurations: [{ ...validConfig, id: 'imported-1' }] });

      const unlinked = (mockFs.unlink as jest.Mock).mock.calls.map(c => String(c[0]));
      expect(unlinked.some(p => p.endsWith('stale.json'))).toBe(true);
      expect(unlinked.some(p => p.endsWith('imported-1.json'))).toBe(false);
      expect(unlinked.some(p => p.includes('business_central'))).toBe(false);
    });

    it('should keep the prior in-memory version when a backup config write fails (memory matches preserved disk)', async () => {
      // Copilot review: removeStaleConfigFiles preserves the prior ${id}.json for a
      // failed-write config, so memory must retain the prior version too — otherwise
      // the config looks deleted in-process but reappears from disk on restart.
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['cfg.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify({ ...validConfig, id: 'cfg', name: 'V1' }));
      await service.loadConfigurations();
      expect(service.getConfigurationForTenant('tenant-a', 'cfg')?.name).toBe('V1');
      jest.clearAllMocks();

      mockFs.unlink.mockResolvedValue(undefined);
      mockFs.writeFile.mockRejectedValueOnce(new Error('disk full')); // V2 write fails

      await service.importAll({ configurations: [{ ...validConfig, id: 'cfg', name: 'V2' }] });

      // Memory retains V1 (the version still on disk), not dropped.
      expect(service.getConfigurationForTenant('tenant-a', 'cfg')?.name).toBe('V1');
    });

    it('should NOT delete the prior on-disk file of a backup config whose write fails (no data loss)', async () => {
      // Copilot review: a config present in the backup but whose write fails must
      // keep its prior on-disk file (it's "attempted", not stale). Only ids absent
      // from the backup are removed.
      (mockFs.readdir as unknown as jest.Mock).mockResolvedValue([
        makeDirent('kept.json', false),
        makeDirent('truly-stale.json', false),
      ]);
      mockFs.writeFile.mockRejectedValueOnce(new Error('disk full')); // 'kept' write fails
      mockFs.unlink.mockResolvedValue(undefined);

      await service.importAll({ configurations: [{ ...validConfig, id: 'kept' }] });

      const unlinked = (mockFs.unlink as jest.Mock).mock.calls.map(c => String(c[0]));
      expect(unlinked.some(p => p.endsWith('kept.json'))).toBe(false);          // preserved
      expect(unlinked.some(p => p.endsWith('truly-stale.json'))).toBe(true);    // removed
    });

    it('should continue removing stale files when one unlink fails (best-effort)', async () => {
      // Copilot review: a single unlink failure must not abort cleanup of the
      // remaining stale files.
      (mockFs.readdir as unknown as jest.Mock).mockResolvedValue([
        makeDirent('stale-1.json', false),
        makeDirent('stale-2.json', false),
      ]);
      mockFs.unlink
        .mockRejectedValueOnce(Object.assign(new Error('permission denied'), { code: 'EACCES' }))
        .mockResolvedValueOnce(undefined);

      await service.importAll({ configurations: [{ ...validConfig, id: 'kept' }] });

      const unlinked = (mockFs.unlink as jest.Mock).mock.calls.map(c => String(c[0]));
      expect(unlinked.some(p => p.endsWith('stale-1.json'))).toBe(true);
      expect(unlinked.some(p => p.endsWith('stale-2.json'))).toBe(true);
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('should reject a truthy non-array configurations value with ValidationError (400)', async () => {
      // { configurations: {} } is malformed restore input — a 400 ValidationError,
      // not a TypeError-from-for-of that would surface as a generic 500.
      await expect(service.importAll({ configurations: {} })).rejects.toBeInstanceOf(ValidationError);
      await expect(service.importAll({ configurations: {} })).rejects.toThrow(/must be an array/);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should clear existing state when importing an empty configurations array', async () => {
      // An empty array is truthy, so `if (!incoming)` does NOT short-circuit:
      // importing `configurations: []` swaps in an empty Map (clears state),
      // distinct from an absent `configurations` key which returns early.
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
      expect(service.getAllConfigurations().length).toBe(1);
      jest.clearAllMocks();

      await service.importAll({ configurations: [] });

      expect(service.getAllConfigurations().length).toBe(0);
      expect(mockLogger.warn).not.toHaveBeenCalledWith('No configurations found in import data');
    });

    it('should handle file write errors during import and not leave the config in memory', async () => {
      // Codex review: a config whose disk write fails is logged and skipped, but
      // must NOT enter the live Map — memory stays consistent with disk.
      // mockRejectedValueOnce (not ...Value) so the persistent rejection doesn't
      // leak into later tests — jest.clearAllMocks() doesn't reset implementations.
      mockFs.writeFile.mockRejectedValueOnce(new Error('Write failed'));

      const backup = {
        configurations: [{ ...validConfig, id: 'config' }],
      };

      await service.importAll(backup);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save imported configuration'),
        expect.any(Error)
      );
      expect(service.getConfigurationForTenant('tenant-a', 'config')).toBeUndefined();
      expect(service.getAllConfigurations().length).toBe(0);
    });

    it('should reject a backup with the same id under two tenants without mutating state', async () => {
      // Flat ${id}.json storage cannot durably hold the same id for two tenants —
      // the second writer would clobber the first on disk, silently losing one
      // tenant's restored config after restart. Fail closed before any mutation.
      stageTenantReaddir(mockFs.readdir as unknown as jest.Mock, ['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
      jest.clearAllMocks();

      const backup = {
        configurations: [
          { ...validConfig, id: 'shared', tenantId: 'tenant-a' },
          { ...validConfig, id: 'shared', tenantId: 'tenant-b' },
        ],
      };

      await expect(service.importAll(backup)).rejects.toThrow(
        "Configuration id 'shared' is present under multiple tenants"
      );
      // Message must NOT leak the conflicting tenant id to the caller.
      await expect(service.importAll(backup)).rejects.not.toThrow(/tenant-a|tenant-b/);
      // Pre-existing live config is untouched and nothing was written to disk.
      expect(service.getConfigurationForTenant('tenant-a', 'config-123')).toBeDefined();
      expect(service.getConfigurationForTenant('tenant-a', 'shared')).toBeUndefined();
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should reject a backup containing a duplicate (tenantId, id)', async () => {
      const backup = {
        configurations: [
          { ...validConfig, id: 'dup', tenantId: 'tenant-a' },
          { ...validConfig, id: 'dup', tenantId: 'tenant-a' },
        ],
      };

      // ValidationError (→ 400) rather than ConfigurationLoadError (→ 500): a
      // duplicate key in the backup is malformed restore input, not a server fault.
      await expect(service.importAll(backup)).rejects.toThrow(/Duplicate configuration/);
      await expect(service.importAll(backup)).rejects.toBeInstanceOf(ValidationError);
      expect(mockFs.writeFile).not.toHaveBeenCalled();
    });

    it('should import the same id for different tenants only when distinct ids keep disk safe', async () => {
      // Distinct ids per tenant import cleanly (no flat-file collision).
      const backup = {
        configurations: [
          { ...validConfig, id: 'cfg-a', tenantId: 'tenant-a' },
          { ...validConfig, id: 'cfg-b', tenantId: 'tenant-b' },
        ],
      };

      await service.importAll(backup);

      expect(service.getConfigurationForTenant('tenant-a', 'cfg-a')).toBeDefined();
      expect(service.getConfigurationForTenant('tenant-b', 'cfg-b')).toBeDefined();
      expect(mockFs.writeFile).toHaveBeenCalledTimes(2);
    });
  });
});
