import 'reflect-metadata';
import {
  CrossTenantCredentialError,
  TenantSettingSystemCredentialRegistry,
  managedSystemRegistryKey,
  type TenantSystemSettingReader,
} from '../../../../src/services/integration/TenantSystemCredentialRegistry';
import { ServiceUnavailableAppError } from '../../../../src/errors/AppError';

/**
 * The tenant-ownership registry behind managed (`secret_manager`) credential
 * resolution.
 *
 * `SecureCredentialManager.getCredentials(systemType, systemId)` has NO tenant
 * dimension — its secret key is `credentials_${type}_${id}`. Without an
 * ownership check, any authenticated tenant user could name another tenant's
 * `systemId` in a stored configuration and have the server resolve, and use,
 * that tenant's brokered credentials.
 *
 * This registry is the check. It is FAIL-CLOSED in every direction: no
 * registration, an unparseable registration, a blank tenant, and an untrimmed
 * systemId are all refusals; only a storage FAILURE (which is an inability to
 * decide, not a denial) surfaces as 503.
 */

function makeReader(value: string | null | Error): {
  reader: TenantSystemSettingReader;
  getStringStrict: jest.Mock;
} {
  const getStringStrict = jest.fn(async () => {
    if (value instanceof Error) throw value;
    return value;
  });
  return { reader: { getStringStrict } as TenantSystemSettingReader, getStringStrict };
}

function makeRegistry(value: string | null | Error) {
  const { reader, getStringStrict } = makeReader(value);
  return {
    registry: new TenantSettingSystemCredentialRegistry(async () => reader),
    getString: getStringStrict,
  };
}

describe('TenantSettingSystemCredentialRegistry', () => {
  it('derives the setting key with EXACTLY the normalization getCredentialKey applies (lowercase, no trim)', () => {
    expect(managedSystemRegistryKey('Salesforce')).toBe('integration.managed_systems.salesforce');
    // getCredentialKey lowercases but never TRIMS, so trimming here would make
    // a whitespace-bearing systemType share a registry entry with the clean
    // spelling while resolving a DIFFERENT secret. It must not trim: the
    // whitespace-bearing type simply has no registration and is refused.
    expect(managedSystemRegistryKey('  NetSuite  ')).toBe('integration.managed_systems.  netsuite  ');
  });

  it('admits a systemId registered to the requesting tenant', async () => {
    const { registry, getString } = makeRegistry(JSON.stringify(['sf-prod', 'sf-sandbox']));

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod'),
    ).resolves.toBeUndefined();
    expect(getString).toHaveBeenCalledWith('tenant-a', 'integration.managed_systems.salesforce');
  });

  it('matches using the SAME case normalization SecureCredentialManager applies to the secret key', async () => {
    // getCredentialKey lowercases systemType and systemId, so 'SF-Prod' and
    // 'sf-prod' resolve the SAME secret. A case-sensitive ownership check
    // would therefore be trivially bypassable.
    const { registry } = makeRegistry(JSON.stringify(['sf-prod']));

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'SALESFORCE', 'SF-Prod'),
    ).resolves.toBeUndefined();
  });

  it('REFUSES a systemId registered to a different tenant', async () => {
    const { registry } = makeRegistry(JSON.stringify(['sf-prod']));

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'tenant-b-sf-prod'),
    ).rejects.toBeInstanceOf(CrossTenantCredentialError);
  });

  it('REFUSES when the tenant has no registration at all (default closed)', async () => {
    const { registry } = makeRegistry(null);

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod'),
    ).rejects.toBeInstanceOf(CrossTenantCredentialError);
  });

  it.each([
    ['not JSON', 'sf-prod'],
    ['a JSON object rather than an array', '{"sf-prod": true}'],
    ['an array containing non-strings', '["sf-prod", 42]'],
    ['an empty array', '[]'],
  ])('REFUSES when the registration is %s', async (_label, raw) => {
    const { registry } = makeRegistry(raw);

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod'),
    ).rejects.toBeInstanceOf(CrossTenantCredentialError);
  });

  it.each([['', 'empty'], ['   ', 'whitespace-only']])(
    'REFUSES a %s tenantId without consulting storage (%s)',
    async (tenantId) => {
      const { registry, getString } = makeRegistry(JSON.stringify(['sf-prod']));

      await expect(
        registry.assertSystemOwnedByTenant(tenantId, 'Salesforce', 'sf-prod'),
      ).rejects.toBeInstanceOf(CrossTenantCredentialError);
      expect(getString).not.toHaveBeenCalled();
    },
  );

  it('REFUSES an untrimmed systemId, whose secret key would differ from the registered one', async () => {
    // getCredentialKey does NOT trim, so ' sf-prod' and 'sf-prod' are different
    // secrets. Accepting the untrimmed spelling as "owned" would let ownership
    // and key derivation disagree.
    const { registry } = makeRegistry(JSON.stringify(['sf-prod']));

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', ' sf-prod'),
    ).rejects.toBeInstanceOf(CrossTenantCredentialError);
  });

  it('REFUSES when the REGISTERED entry carries stray whitespace (it names a different secret)', async () => {
    // A registration of ' sf-prod' derives credentials_salesforce_ sf-prod,
    // NOT credentials_salesforce_sf-prod. Trimming the registered entry before
    // comparing would grant the clean spelling access to a secret the operator
    // never registered.
    const { registry } = makeRegistry(JSON.stringify([' sf-prod']));

    await expect(
      registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod'),
    ).rejects.toBeInstanceOf(CrossTenantCredentialError);
  });

  it('reads the registration through the STRICT plaintext path so an outage cannot look like "not registered"', async () => {
    const { registry, getString } = makeRegistry(JSON.stringify(['sf-prod']));

    await registry.assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod');

    expect(getString).toHaveBeenCalledWith('tenant-a', 'integration.managed_systems.salesforce');
  });

  it('surfaces a STORAGE failure as ServiceUnavailableAppError, not as a denial', async () => {
    const { registry } = makeRegistry(new Error('connection terminated unexpectedly'));

    const error = await registry
      .assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'sf-prod')
      .then(() => undefined)
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ServiceUnavailableAppError);
    expect(error).not.toBeInstanceOf(CrossTenantCredentialError);
  });

  it('never echoes the requested systemId or the registered set in the refusal message', async () => {
    const { registry } = makeRegistry(JSON.stringify(['tenant-b-secret-system']));

    const error = await registry
      .assertSystemOwnedByTenant('tenant-a', 'Salesforce', 'probe-for-existence')
      .then(() => undefined)
      .catch((err: unknown) => err);

    const message = (error as Error).message;
    expect(message).not.toContain('tenant-b-secret-system');
    expect(message).not.toContain('probe-for-existence');
  });
});
