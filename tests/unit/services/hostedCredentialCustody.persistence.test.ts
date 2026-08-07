import 'reflect-metadata';

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

jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn(() => ({ isValid: true, errors: [], warnings: [] })),
}));

import { promises as fs } from 'fs';
import { ConfigurationService } from '../../../src/services/ConfigurationService';
import type { IntegrationConfig } from '../../../src/types';

const mockFs = fs as jest.Mocked<typeof fs>;

type TestLogger = { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

function makeConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'hosted-custody-config',
    tenantId: 'tenant-a',
    name: 'Hosted custody test',
    sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
    targetSystem: { type: 'NetSuite', systemId: 'ns-prod', credentialSource: 'environment' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  };
}

function makeLogger(): TestLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

describe('hosted credential custody at persistence boundaries', () => {
  const originalNodeEnv = process.env.NODE_ENV;
  let logger: TestLogger;
  let service: ConfigurationService;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    mockFs.access.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([]);
    logger = makeLogger();
    service = new ConfigurationService(logger, './hosted-custody-test');
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('rejects hosted inline credentials before save mutates memory or disk', async () => {
    const sentinel = 'hosted-save-secret-sentinel';
    const config = makeConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'inline' },
      sourceAuthentication: { type: 'api_key', credentials: { apiKey: sentinel } },
    });

    await expect(service.saveConfiguration(config)).rejects.toMatchObject({
      statusCode: 400,
      validationErrors: expect.arrayContaining([
        expect.stringContaining('sourceSystem'),
        expect.stringContaining('sourceAuthentication'),
      ]),
    });

    expect(service.getAllConfigurations()).toEqual([]);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.flat().join(' ')).not.toContain(sentinel);
  });

  it('rejects every invalid member of a hosted import before clearing or writing state', async () => {
    const sentinel = 'hosted-import-secret-sentinel';
    const safe = makeConfig({ id: 'safe-config' });
    const invalid = makeConfig({
      id: 'invalid-config',
      sourceSystem: 'Salesforce',
      sourceAuthentication: { type: 'api_key', credentials: { apiKey: sentinel } },
    });

    await expect(service.importAll({ configurations: [safe, invalid] })).rejects.toMatchObject({ statusCode: 400 });

    expect(service.getAllConfigurations()).toEqual([]);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(logger.error.mock.calls.flat().join(' ')).not.toContain(sentinel);
  });
});