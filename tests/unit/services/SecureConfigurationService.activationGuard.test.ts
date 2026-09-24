/**
 * Prerequisite PR C fix (review Critical finding #1): SecureConfigurationService's
 * constructor forwarded the optional cardinality gate to `super()` but NOT the
 * optional pre-activation guard, so a later-bound `ConfigurationActivationGuard`
 * would silently never run on SecureConfigurationService's active-save paths
 * (createSecureIntegration, migrateToSecureCredentials, and the inherited
 * activateConfigurationForTenant) even though the base class's own active-save
 * path (and importAll) call it. This suite pins the fix: a guard bound at
 * construction fires during a real (non-mocked-saveConfiguration) active save.
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

jest.mock('../../../src/schemas/configurationSchemas', () => ({
  validateIntegrationConfig: jest.fn(() => ({ isValid: true, errors: [], warnings: [] })),
}));

import { SecureConfigurationService } from '../../../src/services/SecureConfigurationService';
import type { ConfigurationActivationGuard } from '../../../src/services/ConfigurationService';
import { makeCleanPreflight, makeCommandContext, makeGateDouble } from '../../helpers/cardinalityTestDoubles';
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

function makeIntegrationConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'int-guard-1',
    tenantId: 'tenant-secure',
    name: 'Active Integration',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
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

describe('SecureConfigurationService threads the pre-activation guard (Prereq C fix)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("fires a guard bound at construction with source 'direct_save' during createSecureIntegration's active save", async () => {
    const gate = makeGateDouble(makeCleanPreflight());
    const guard: ConfigurationActivationGuard = { assertReady: jest.fn(async () => undefined) };
    const service = new SecureConfigurationService(
      mockLogger,
      './test-config-guard',
      mockCredentialManager,
      gate,
      guard,
    );
    const context = makeCommandContext({ tenantId: 'tenant-secure', operation: 'secure_save' });

    await service.createSecureIntegration(
      makeIntegrationConfig(),
      { systemId: 'src-1', systemType: 'salesforce', name: 'Source', config: {}, credentialSource: 'secret_manager' },
      { systemId: 'tgt-1', systemType: 'netsuite', name: 'Target', config: {}, credentialSource: 'secret_manager' },
      context,
    );

    expect(guard.assertReady).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'int-guard-1' }),
      expect.objectContaining({ tenantId: 'tenant-secure' }),
      'direct_save',
    );
    // The save itself still completed (the guard resolved cleanly) — proves this
    // is genuine wiring, not a rejection short-circuiting before persistence.
    expect(gate.audit.logCardinalityOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'succeeded' }),
    );
  });

  it('a rejecting bound guard aborts createSecureIntegration before any preflight/persistence', async () => {
    const gate = makeGateDouble(makeCleanPreflight());
    const guard: ConfigurationActivationGuard = {
      assertReady: jest.fn(async () => {
        throw new Error('not ready for this source');
      }),
    };
    const service = new SecureConfigurationService(
      mockLogger,
      './test-config-guard',
      mockCredentialManager,
      gate,
      guard,
    );
    const context = makeCommandContext({ tenantId: 'tenant-secure', operation: 'secure_save' });

    await expect(
      service.createSecureIntegration(
        makeIntegrationConfig({ id: 'int-guard-2' }),
        { systemId: 'src-1', systemType: 'salesforce', name: 'Source', config: {}, credentialSource: 'secret_manager' },
        { systemId: 'tgt-1', systemType: 'netsuite', name: 'Target', config: {}, credentialSource: 'secret_manager' },
        context,
      ),
    ).rejects.toThrow('not ready for this source');

    expect(gate.preflight.runForConfig).not.toHaveBeenCalled();
    expect(service.getConfigurationForTenant('tenant-secure', 'int-guard-2')).toBeUndefined();
  });
});
