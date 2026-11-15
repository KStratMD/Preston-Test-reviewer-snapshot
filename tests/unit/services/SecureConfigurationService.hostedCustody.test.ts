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
import { SecureConfigurationService } from '../../../src/services/SecureConfigurationService';
import type { SecureCredentialManager } from '../../../src/services/SecureCredentialManager';
import type { ConfigurationCommandContext } from '../../../src/types/cardinality';
import type { IntegrationConfig } from '../../../src/types';

const mockFs = fs as jest.Mocked<typeof fs>;

type TestLogger = { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

function makeDirent(name: string): { name: string; isFile: () => boolean; isDirectory: () => boolean } {
  return { name, isFile: () => true, isDirectory: () => false };
}

function makeLegacyConfig(): IntegrationConfig {
  return {
    id: 'legacy-config',
    tenantId: 'tenant-a',
    name: 'Legacy hosted config',
    sourceSystem: { type: 'Salesforce', systemId: 'sf-prod' },
    targetSystem: { type: 'NetSuite', systemId: 'ns-prod' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    authentication: {
      source: { type: 'api_key', credentials: { apiKey: 'legacy-source-secret' } },
      target: { type: 'api_key', credentials: { apiKey: 'legacy-target-secret' } },
    },
  };
}

function makeIdentifierlessLegacyConfig(): IntegrationConfig {
  return {
    ...makeLegacyConfig(),
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
  };
}

function makePaddedLegacyConfig(): IntegrationConfig {
  return {
    ...makeLegacyConfig(),
    sourceSystem: { type: 'Salesforce', systemId: ' sf-prod ' },
    targetSystem: { type: 'NetSuite', systemId: ' ns-prod ' },
  };
}

function makeLogger(): TestLogger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

const context: ConfigurationCommandContext = {
  tenantId: 'tenant-a',
  actorUserId: 'operator-1',
  correlationId: 'migration-correlation',
  operation: 'secure_save',
};

describe('SecureConfigurationService hosted custody migration', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'production';
    mockFs.access.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.readdir.mockResolvedValue([makeDirent('legacy-config.json')] as never);
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeLegacyConfig()));
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('does not write reference metadata when secret migration reports an error', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: ['secret backend unavailable'] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result.errors).toEqual(['secret backend unavailable']);
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(service.getConfigurationForTenant('tenant-a', 'legacy-config')).toEqual(
      expect.objectContaining({ authentication: expect.objectContaining({ source: expect.any(Object), target: expect.any(Object) }) }),
    );
  });

  it('leaves inline credentials in place when migration cannot derive a unique systemId', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    mockFs.readFile.mockResolvedValue(JSON.stringify(makeIdentifierlessLegacyConfig()));
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result.migratedIntegrations).toBe(0);
    expect(result.migratedCredentials).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('explicit systemId');
    expect(credentialManager.storeCredentials).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
    expect(service.getConfigurationForTenant('tenant-a', 'legacy-config')).toEqual(
      expect.objectContaining({ authentication: expect.objectContaining({ source: expect.any(Object), target: expect.any(Object) }) }),
    );
  });

  it('writes reference-only configurations when both systems have explicit IDs', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result).toEqual({ migratedIntegrations: 1, migratedCredentials: 2, errors: [] });
    expect(credentialManager.storeCredentials).toHaveBeenNthCalledWith(
      1,
      'Salesforce',
      'sf-prod',
      { apiKey: 'legacy-source-secret' },
    );
    expect(credentialManager.storeCredentials).toHaveBeenNthCalledWith(
      2,
      'NetSuite',
      'ns-prod',
      { apiKey: 'legacy-target-secret' },
    );
    const persisted = JSON.parse(String(mockFs.writeFile.mock.calls[0][1]));
    expect(persisted.sourceSystem).toEqual({ type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' });
    expect(persisted.targetSystem).toEqual({ type: 'NetSuite', systemId: 'ns-prod', credentialSource: 'secret_manager' });
    expect(persisted).not.toHaveProperty('authentication');
    expect(JSON.stringify(persisted)).not.toContain('legacy-source-secret');
    expect(JSON.stringify(persisted)).not.toContain('legacy-target-secret');
  });

  it('does not count credentials when a mixed-side migration cannot save the configuration', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      ...makeLegacyConfig(),
      targetSystem: 'NetSuite',
    }));
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result.migratedIntegrations).toBe(0);
    expect(result.migratedCredentials).toBe(0);
    expect(result.errors[0]).toContain('explicit systemId');
    expect(credentialManager.storeCredentials).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('preserves a one-sided migration by marking the explicit no-auth side as environment-backed', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      ...makeLegacyConfig(),
      targetSystem: { type: 'NetSuite', systemId: 'ns-prod' },
      authentication: { source: { type: 'api_key', credentials: { apiKey: 'legacy-source-secret' } } },
    }));
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result).toEqual({ migratedIntegrations: 1, migratedCredentials: 1, errors: [] });
    const persisted = JSON.parse(String(mockFs.writeFile.mock.calls[0][1]));
    expect(persisted.sourceSystem).toEqual({ type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' });
    expect(persisted.targetSystem).toEqual({ type: 'NetSuite', systemId: 'ns-prod', credentialSource: 'environment' });
    expect(persisted).not.toHaveProperty('authentication');
  });

  it('prevalidates a bare-string opposite system before writing one-sided credentials', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    mockFs.readFile.mockResolvedValue(JSON.stringify({
      ...makeLegacyConfig(),
      targetSystem: 'NetSuite',
      authentication: { source: { type: 'api_key', credentials: { apiKey: 'legacy-source-secret' } } },
    }));
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result.migratedIntegrations).toBe(0);
    expect(result.migratedCredentials).toBe(0);
    expect(result.errors[0]).toContain('explicit systemId');
    expect(credentialManager.storeCredentials).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it('leaves inline credentials in place when a systemId is padded', async () => {
    const logger = makeLogger();
    const credentialManager = {
      migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
      storeCredentials: jest.fn().mockResolvedValue(undefined),
    } as unknown as SecureCredentialManager;
    mockFs.readFile.mockResolvedValue(JSON.stringify(makePaddedLegacyConfig()));
    const service = new SecureConfigurationService(logger, './secure-custody-test', credentialManager);
    await service.loadConfigurations();
    mockFs.writeFile.mockClear();

    const result = await service.migrateToSecureCredentials(context);

    expect(result.migratedIntegrations).toBe(0);
    expect(result.errors[0]).toContain('explicit systemId');
    expect(credentialManager.storeCredentials).not.toHaveBeenCalled();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});
