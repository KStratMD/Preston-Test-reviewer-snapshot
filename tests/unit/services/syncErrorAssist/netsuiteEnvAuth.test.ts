import 'reflect-metadata';
import type * as NetsuiteEnvAuthModule from '../../../../src/services/syncErrorAssist/netsuiteEnvAuth';

interface FakeNetsuiteConfig {
  accountId?: string;
  consumerKey?: string;
  consumerSecret?: string;
  tokenId?: string;
  tokenSecret?: string;
  baseUrl?: string;
}

/**
 * `netsuiteEnvAuth.ts` reads `netsuiteConfig` from `src/config/env.ts` at
 * module scope, so exercising both the happy path and every missing-key
 * branch requires a fresh module instance per fixture. `jest.doMock` +
 * `jest.isolateModules` swaps the env module for a plain fixture object
 * before each fresh `require`, avoiding any dependency on real process.env /
 * zod parsing. Mirrors the existing doMock+isolateModules pattern in
 * tests/unit/routes/governance/operationsRouter.test.ts.
 */
function loadModule(netsuiteConfig: FakeNetsuiteConfig): typeof NetsuiteEnvAuthModule {
  let mod!: typeof NetsuiteEnvAuthModule;
  jest.doMock('../../../../src/config/env', () => ({ netsuiteConfig }));
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    mod = require('../../../../src/services/syncErrorAssist/netsuiteEnvAuth') as typeof NetsuiteEnvAuthModule;
  });
  return mod;
}

describe('netsuiteEnvAuth.buildNetSuiteEnvAuthConfig', () => {
  afterEach(() => {
    jest.dontMock('../../../../src/config/env');
    jest.resetModules();
  });

  it('builds an oauth1 AuthConfig from complete env credentials, including baseUrl when set', () => {
    const { buildNetSuiteEnvAuthConfig } = loadModule({
      accountId: '1234567_SB1',
      consumerKey: 'ck',
      consumerSecret: 'cs',
      tokenId: 'tid',
      tokenSecret: 'tsec',
      baseUrl: 'https://1234567-sb1.suitetalk.api.netsuite.com',
    });

    const config = buildNetSuiteEnvAuthConfig();

    expect(config).toEqual({
      type: 'oauth1',
      credentials: {
        accountId: '1234567_SB1',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        tokenId: 'tid',
        tokenSecret: 'tsec',
        baseUrl: 'https://1234567-sb1.suitetalk.api.netsuite.com',
      },
    });
  });

  it('omits baseUrl entirely when not configured (NetSuiteConnector derives it from accountId)', () => {
    const { buildNetSuiteEnvAuthConfig } = loadModule({
      accountId: 'acct', consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tid', tokenSecret: 'tsec',
    });

    const config = buildNetSuiteEnvAuthConfig();

    expect(config.type).toBe('oauth1');
    expect('baseUrl' in config.credentials).toBe(false);
  });

  it('throws NetSuiteEnvCredentialsMissingError naming the single missing key', () => {
    const { buildNetSuiteEnvAuthConfig, NetSuiteEnvCredentialsMissingError } = loadModule({
      accountId: '', consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tid', tokenSecret: 'tsec',
    });

    expect(() => buildNetSuiteEnvAuthConfig()).toThrow(NetSuiteEnvCredentialsMissingError);
    expect(() => buildNetSuiteEnvAuthConfig()).toThrow(/accountId/);
  });

  it('throws NetSuiteEnvCredentialsMissingError naming every missing key when all five are absent', () => {
    const { buildNetSuiteEnvAuthConfig, NetSuiteEnvCredentialsMissingError } = loadModule({});

    let caught: unknown;
    try {
      buildNetSuiteEnvAuthConfig();
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetSuiteEnvCredentialsMissingError);
    const message = (caught as Error).message;
    expect(message).toMatch(/accountId/);
    expect(message).toMatch(/consumerKey/);
    expect(message).toMatch(/consumerSecret/);
    expect(message).toMatch(/tokenId/);
    expect(message).toMatch(/tokenSecret/);
  });
});

describe('netsuiteEnvAuth.buildNetSuiteEnvAuthConfigForTenant', () => {
  afterEach(() => {
    jest.dontMock('../../../../src/config/env');
    jest.resetModules();
  });

  const COMPLETE_ENV: FakeNetsuiteConfig = {
    accountId: '1234567_SB1',
    consumerKey: 'ck', consumerSecret: 'cs', tokenId: 'tid', tokenSecret: 'tsec',
  };

  function makeLookup(storedId: string | null) {
    return {
      getEmbeddedPlatformAccountId: jest.fn().mockResolvedValue(storedId),
    };
  }

  it('throws NetSuiteTenantAccountMismatchError when the tenant\'s stored platform account differs from env', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantAccountMismatchError } = loadModule(COMPLETE_ENV);
    const lookup = makeLookup('9999999');

    await expect(buildNetSuiteEnvAuthConfigForTenant('tenant-b', lookup))
      .rejects.toThrow(NetSuiteTenantAccountMismatchError);
    expect(lookup.getEmbeddedPlatformAccountId).toHaveBeenCalledWith('tenant-b', 'netsuite');
  });

  it('returns the env AuthConfig when the stored account matches exactly', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant } = loadModule(COMPLETE_ENV);

    const config = await buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup('1234567_SB1'));

    expect(config.type).toBe('oauth1');
    expect(config.credentials.accountId).toBe('1234567_SB1');
  });

  it('treats the URL-form sandbox id (lowercase, hyphenated) as a match for the env _SB1 form', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant } = loadModule(COMPLETE_ENV);

    const config = await buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup('1234567-sb1'));

    expect(config.type).toBe('oauth1');
  });

  it('fails closed with NetSuiteTenantUnprovisionedError when the tenant has no stored platform account (Codex R3 P1)', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantUnprovisionedError } = loadModule(COMPLETE_ENV);

    await expect(buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup(null)))
      .rejects.toThrow(NetSuiteTenantUnprovisionedError);
  });

  it('unprovisioned error message names the tenant and points at the provisioning script', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantUnprovisionedError } = loadModule(COMPLETE_ENV);

    let caught: unknown;
    try {
      await buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup(null));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetSuiteTenantUnprovisionedError);
    const message = (caught as Error).message;
    expect(message).toMatch(/tenant-a/);
    expect(message).toMatch(/rotate-embedded-service-token/);
  });

  it('the unprovisioned check runs before the env-credentials check (no-binding + no-env → unprovisioned)', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantUnprovisionedError } = loadModule({});

    await expect(buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup(null)))
      .rejects.toThrow(NetSuiteTenantUnprovisionedError);
  });

  it('still throws NetSuiteEnvCredentialsMissingError (not mismatch) when env credentials are absent', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteEnvCredentialsMissingError } = loadModule({});

    await expect(buildNetSuiteEnvAuthConfigForTenant('tenant-a', makeLookup('1234567')))
      .rejects.toThrow(NetSuiteEnvCredentialsMissingError);
  });

  it('propagates a lookup failure (fail-closed: no DB read, no connector)', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant } = loadModule(COMPLETE_ENV);
    const lookup = {
      getEmbeddedPlatformAccountId: jest.fn().mockRejectedValue(new Error('db down')),
    };

    await expect(buildNetSuiteEnvAuthConfigForTenant('tenant-a', lookup))
      .rejects.toThrow('db down');
  });

  it('mismatch error message names the tenant and both account ids for operator diagnosis', async () => {
    const { buildNetSuiteEnvAuthConfigForTenant, NetSuiteTenantAccountMismatchError } = loadModule(COMPLETE_ENV);

    let caught: unknown;
    try {
      await buildNetSuiteEnvAuthConfigForTenant('tenant-b', makeLookup('9999999'));
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(NetSuiteTenantAccountMismatchError);
    const message = (caught as Error).message;
    expect(message).toMatch(/tenant-b/);
    expect(message).toMatch(/9999999/);
    expect(message).toMatch(/1234567_SB1/);
  });
});
