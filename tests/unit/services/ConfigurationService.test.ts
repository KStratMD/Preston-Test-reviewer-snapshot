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

describe('ConfigurationService', () => {
  let service: ConfigurationService;
  let mockLogger: { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };
  let validateIntegrationConfig: jest.Mock;

  const validConfig: IntegrationConfig = {
    id: 'config-123',
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
      mockFs.readdir.mockResolvedValue(['config1.json', 'config2.json', 'readme.txt']);
      mockFs.readFile.mockImplementation((filePath: string) => {
        if (filePath.includes('config1')) {
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
      mockFs.readdir.mockResolvedValue(['config.json', 'readme.md', 'notes.txt']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));

      await service.loadConfigurations();

      expect(mockFs.readFile).toHaveBeenCalledTimes(1);
    });

    it('should throw ConfigurationLoadError when file has invalid JSON', async () => {
      mockFs.readdir.mockResolvedValue(['invalid.json']);
      mockFs.readFile.mockResolvedValue('not valid json');

      await expect(service.loadConfigurations()).rejects.toThrow();
    });

    it('should throw when configuration is missing required fields', async () => {
      mockFs.readdir.mockResolvedValue(['incomplete.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify({ id: 'test' }));

      await expect(service.loadConfigurations()).rejects.toThrow();
    });

    it('should log loaded configurations count', async () => {
      mockFs.readdir.mockResolvedValue(['config.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));

      await service.loadConfigurations();

      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('Loading'));
    });

    it('should handle empty directory', async () => {
      mockFs.readdir.mockResolvedValue([]);

      await service.loadConfigurations();

      expect(service.getAllConfigurations().length).toBe(0);
    });
  });

  describe('getConfiguration()', () => {
    beforeEach(async () => {
      mockFs.readdir.mockResolvedValue(['config.json']);
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
  });

  describe('getAllConfigurations()', () => {
    it('should return empty array when no configurations', () => {
      const configs = service.getAllConfigurations();
      expect(configs).toEqual([]);
    });

    it('should return all loaded configurations', async () => {
      mockFs.readdir.mockResolvedValue(['config1.json', 'config2.json']);
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
  });

  describe('deleteConfiguration()', () => {
    beforeEach(async () => {
      mockFs.readdir.mockResolvedValue(['config-123.json']);
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

    it('should handle file deletion errors gracefully', async () => {
      mockFs.unlink.mockRejectedValue(new Error('File not found'));

      const result = await service.deleteConfiguration('config-123');

      expect(result).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalled();
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
      const sample = service.createSampleConfiguration();

      expect(sample.id).toBeDefined();
      expect(sample.name).toBe('Sample Salesforce to NetSuite Customer Sync');
      expect(sample.sourceSystem).toBe('Salesforce');
      expect(sample.targetSystem).toBe('NetSuite');
      expect(sample.fieldMappings.length).toBeGreaterThan(0);
    });

    it('should include transformation rules', () => {
      const sample = service.createSampleConfiguration();

      expect(sample.transformationRules).toBeDefined();
      expect(sample.transformationRules!.length).toBeGreaterThan(0);
    });

    it('should include authentication configurations', () => {
      const sample = service.createSampleConfiguration();

      expect(sample.sourceAuthentication).toBeDefined();
      expect(sample.targetAuthentication).toBeDefined();
    });

    it('should include timestamps', () => {
      const sample = service.createSampleConfiguration();

      expect(sample.createdAt).toBeInstanceOf(Date);
      expect(sample.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe('exportConfiguration()', () => {
    beforeEach(async () => {
      mockFs.readdir.mockResolvedValue(['config-123.json']);
      mockFs.readFile.mockResolvedValue(JSON.stringify(validConfig));
      await service.loadConfigurations();
    });

    it('should export configuration as JSON string', async () => {
      const exported = await service.exportConfiguration('config-123');

      expect(typeof exported).toBe('string');
      const parsed = JSON.parse(exported);
      expect(parsed.id).toBe('config-123');
    });

    it('should throw for non-existent configuration', async () => {
      await expect(service.exportConfiguration('non-existent')).rejects.toThrow('not found');
    });

    it('should format JSON with indentation', async () => {
      const exported = await service.exportConfiguration('config-123');

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
      mockFs.readdir.mockResolvedValue(['c1.json', 'c2.json', 'c3.json']);
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
      mockFs.readdir.mockResolvedValue(['c1.json', 'c2.json']);
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
      mockFs.readdir.mockResolvedValue(['existing.json']);
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

    it('should handle file write errors during import', async () => {
      mockFs.writeFile.mockRejectedValue(new Error('Write failed'));

      const backup = {
        configurations: [{ ...validConfig, id: 'config' }],
      };

      await service.importAll(backup);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to save imported configuration'),
        expect.any(Error)
      );
    });
  });
});
