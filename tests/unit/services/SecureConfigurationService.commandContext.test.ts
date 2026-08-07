/**
 * Task 8 — trusted command-context threading through
 * SecureConfigurationService's active-write ('secure_save') surface:
 * createSecureIntegration and migrateToSecureCredentials.
 *
 * Both methods can persist an ACTIVE IntegrationConfig through
 * ConfigurationService.saveConfiguration, so both must now REQUIRE a
 * ConfigurationCommandContext (a compile-time signature change) and thread a
 * concrete operation/tenant/actor/correlation id through to that call.
 *
 * `saveConfiguration` is spied directly (rather than exercised end-to-end
 * through the cardinality gate) so this suite proves exactly what Task 8 is
 * responsible for — the CONTEXT OBJECT reaching the write boundary with the
 * right shape — independent of Task 7's gate/audit machinery, which has its
 * own dedicated suite.
 */
import 'reflect-metadata';

jest.mock('fs', () => ({
  promises: {
    access: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    readdir: jest.fn().mockResolvedValue([]),
    writeFile: jest.fn().mockResolvedValue(undefined),
    readFile: jest.fn().mockResolvedValue('{}'),
    unlink: jest.fn().mockResolvedValue(undefined),
  },
}));

import { SecureConfigurationService } from '../../../src/services/SecureConfigurationService';
import { ConfigurationService } from '../../../src/services/ConfigurationService';
import { makeCommandContext } from '../../helpers/cardinalityTestDoubles';
import type { IntegrationConfig } from '../../../src/types';

const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
} as any;

const mockCredentialManager = {
  storeCredentials: jest.fn().mockResolvedValue(undefined),
  getCredentials: jest.fn().mockResolvedValue({ type: 'oauth2', credentials: {} }),
  rotateCredentials: jest.fn().mockResolvedValue(undefined),
  getCredentialsNeedingRotation: jest.fn().mockResolvedValue([]),
  migrateFromEnvironment: jest.fn().mockResolvedValue({ migrated: 0, errors: [] }),
} as any;

function makeSystemConfig(overrides: Record<string, any> = {}) {
  return {
    systemId: 'sys-1',
    systemType: 'salesforce',
    name: 'Salesforce Prod',
    config: { baseUrl: 'https://api.salesforce.com', timeout: 30000 },
    credentialSource: 'secret_manager' as const,
    ...overrides,
  };
}

function makeIntegrationConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'int-ctx-1',
    tenantId: 'tenant-secure',
    name: 'Active Integration',
    sourceSystem: { type: 'Salesforce', systemId: 'sf-prod' },
    targetSystem: { type: 'NetSuite', systemId: 'ns-prod' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [
      { sourceField: 'Name', targetField: 'companyname', transformationType: 'direct', isRequired: true },
    ],
    ...overrides,
  } as IntegrationConfig;
}

describe('SecureConfigurationService trusted command context (Task 8, secure_save)', () => {
  let service: SecureConfigurationService;
  let saveConfigurationSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new SecureConfigurationService(mockLogger, './test-config-ctx', mockCredentialManager);
    saveConfigurationSpy = jest
      .spyOn(ConfigurationService.prototype as any, 'saveConfiguration')
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    saveConfigurationSpy.mockRestore();
  });

  it('createSecureIntegration threads a concrete operation, tenant, actor, and correlation id to saveConfiguration', async () => {
    const context = makeCommandContext({
      tenantId: 'tenant-secure',
      actorUserId: 'actor-secure',
      correlationId: 'corr-secure-1',
      operation: 'secure_save',
    });
    const config = makeIntegrationConfig({ id: 'int-create-ctx' });

    await service.createSecureIntegration(
      config,
      makeSystemConfig({ systemId: 'src-1' }),
      makeSystemConfig({ systemId: 'tgt-1', systemType: 'netsuite' }),
      context,
    );

    expect(saveConfigurationSpy).toHaveBeenCalledTimes(1);
    const [savedConfig, savedContext] = saveConfigurationSpy.mock.calls[0];
    expect(savedConfig.id).toBe('int-create-ctx');
    expect(savedContext).toEqual({
      tenantId: 'tenant-secure',
      actorUserId: 'actor-secure',
      correlationId: 'corr-secure-1',
      operation: 'secure_save',
    });
  });

  it('migrateToSecureCredentials threads a per-member context (own tenant, caller actor/correlation/operation) to every saveConfiguration call', async () => {
    // Seed two ACTIVE integrations under different tenants directly (bypassing
    // createSecureIntegration/the gate) so migrateToSecureCredentials' cross-
    // tenant sweep has real members to iterate. Both carry inline auth so
    // migrateToSecureCredentials treats them as "modified" and saves.
    const tenantAConfig = makeIntegrationConfig({
      id: 'int-tenant-a',
      tenantId: 'tenant-a',
      authentication: { source: { type: 'apiKey', credentials: { key: 'inline-a' } } },
    });
    const tenantBConfig = makeIntegrationConfig({
      id: 'int-tenant-b',
      tenantId: 'tenant-b',
      authentication: { target: { type: 'basic', credentials: { user: 'u', pass: 'p' } } },
    });
    (service as any).configurations.set('tenant-a::int-tenant-a', tenantAConfig);
    (service as any).configurations.set('tenant-b::int-tenant-b', tenantBConfig);

    const baseContext = makeCommandContext({
      tenantId: 'operator-tenant',
      actorUserId: 'operator-1',
      correlationId: 'corr-migrate-1',
      operation: 'secure_save',
    });

    await service.migrateToSecureCredentials(baseContext);

    expect(saveConfigurationSpy).toHaveBeenCalledTimes(2);
    const contextsByConfigId = new Map(
      saveConfigurationSpy.mock.calls.map(([cfg, ctx]) => [cfg.id, ctx]),
    );

    // Every member's context keeps the caller's actor/correlation/operation but
    // is re-scoped to that MEMBER'S OWN tenant — a cross-tenant sweep must never
    // be attributable to one caller-chosen tenant (mirrors importAll's
    // bulk-restore pattern).
    expect(contextsByConfigId.get('int-tenant-a')).toEqual({
      tenantId: 'tenant-a',
      actorUserId: 'operator-1',
      correlationId: 'corr-migrate-1',
      operation: 'secure_save',
    });
    expect(contextsByConfigId.get('int-tenant-b')).toEqual({
      tenantId: 'tenant-b',
      actorUserId: 'operator-1',
      correlationId: 'corr-migrate-1',
      operation: 'secure_save',
    });
  });
});
