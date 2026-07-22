import { ConfigurationService } from '../services/ConfigurationService';
import type { IntegrationConfig } from '../types';
import type { Logger } from '../utils/Logger';
import fs from 'fs';
import path from 'path';

// Mock logger for testing
const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
  setCorrelationId: jest.fn().mockReturnThis(),
} as unknown as Logger;


describe('ConfigurationService', () => {
  const tempDir = path.join(__dirname, 'tmp-config');
  let service: ConfigurationService;

  const validConfig = {
    id: 'test_config',
    tenantId: 'test-tenant',
    name: 'Test Config',
    sourceSystem: 'NetSuite',
    targetSystem: 'Salesforce',
    sourceEntity: 'customer',
    targetEntity: 'account',
    syncDirection: 'bidirectional' as const,
    syncMode: 'realtime' as const,
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    fieldMappings: [
      { sourceField: 'Name', targetField: 'companyname', isRequired: true, transformationType: 'direct' },
    ],
    transformationRules: [],
    sourceAuthentication: {
      type: 'token' as const,
      credentials: {
        accountId: 'test_account_id',
        consumerKey: 'test_consumer_key',
        consumerSecret: 'test_consumer_secret',
        tokenId: 'test_token_id',
        tokenSecret: 'test_token_secret',
      },
      refreshable: false,
    },
    targetAuthentication: {
      type: 'oauth2' as const,
      credentials: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
        tokenUrl: 'https://example.com/oauth/token',
      },
      refreshable: false,
    },
  } satisfies IntegrationConfig;

  beforeEach(async () => {
    await fs.promises.mkdir(tempDir, { recursive: true });
    service = new ConfigurationService(mockLogger, tempDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe('Configuration Validation', () => {
    it('validates valid configuration with new fields', async () => {
      const validation = await service.validateConfiguration(validConfig);
      expect(validation.isValid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('invalidates configuration with missing sourceEntity', async () => {
      const { sourceEntity, ...configWithoutEntity } = validConfig;
      const invalidConfig = configWithoutEntity as unknown as IntegrationConfig;

      const validation = await service.validateConfiguration(invalidConfig);
      expect(validation.isValid).toBe(false);
      expect(validation.errors.some(err => err.startsWith('sourceEntity'))).toBe(true);
    });

    it('invalidates configuration with missing targetAuthentication', async () => {
      const invalidConfig = {
        ...validConfig,
        targetAuthentication: undefined, // Missing targetAuthentication
      } as unknown as IntegrationConfig;

      const validation = await service.validateConfiguration(invalidConfig);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('targetAuthentication: Bidirectional sync requires target authentication configuration');
    });

    it('validates field mappings according to schema', async () => {
      const invalidConfig = {
        ...validConfig,
        fieldMappings: [
          { sourceField: '', targetField: '', isRequired: true, transformationType: 'direct' },
        ],
      } satisfies IntegrationConfig;

      const validation = await service.validateConfiguration(invalidConfig);
      expect(validation.isValid).toBe(false);
      expect(validation.errors).toContain('fieldMappings.0.sourceField: Source field cannot be empty');
      expect(validation.errors).toContain('fieldMappings.0.targetField: Target field cannot be empty');
    });
  });

  describe('Configuration Storage', () => {
    it('stores file and returns via getConfiguration', async () => {
      await service.saveConfiguration(validConfig);
      const loaded = await service.getConfiguration('test_config');
      expect(loaded).toBeDefined();
      expect(loaded?.name).toBe('Test Config');
    });

    it('updates existing configuration', async () => {
      await service.saveConfiguration(validConfig);
      const updated = {
        ...validConfig,
        name: 'Updated Config',
      };
      await service.saveConfiguration(updated);
      const loaded = await service.getConfiguration('test_config');
      expect(loaded?.name).toBe('Updated Config');
    });

    it('deletes configuration', async () => {
      await service.saveConfiguration(validConfig);
      await service.deleteConfiguration('test_config');
      const loaded = await service.getConfiguration('test_config');
      expect(loaded).toBeUndefined();
    });
  });

  describe('Configuration Loading', () => {
    it('loads all configuration files from disk', async () => {
      const configs: IntegrationConfig[] = [
        { ...validConfig, id: 'config1', name: 'Config 1' },
        { ...validConfig, id: 'config2', name: 'Config 2' },
      ];

      for (const cfg of configs) {
        // Flat layout: configs live at ${tempDir}/${id}.json (top-level only).
        const filePath = path.join(tempDir, `${cfg.id}.json`);
        await fs.promises.writeFile(filePath, JSON.stringify(cfg, null, 2), 'utf-8');
      }

      await service.loadConfigurations();

      expect(service.getAllConfigurations()).toHaveLength(2);
      expect(service.getConfiguration('config1')?.name).toBe('Config 1');
      expect(service.getConfiguration('config2')?.name).toBe('Config 2');
    });

    it('throws when a configuration file is invalid', async () => {
      const good = { ...validConfig, id: 'good', name: 'Good' };
      const bad = { name: 'Bad Config', tenantId: validConfig.tenantId }; // missing required fields

      // Flat layout: both files at the top level of ${tempDir}.
      await fs.promises.writeFile(
        path.join(tempDir, `${good.id}.json`),
        JSON.stringify(good, null, 2),
        'utf-8',
      );
      await fs.promises.writeFile(
        path.join(tempDir, 'bad.json'),
        JSON.stringify(bad, null, 2),
        'utf-8',
      );

      await expect(service.loadConfigurations()).rejects.toThrow();
    });
  });
});
