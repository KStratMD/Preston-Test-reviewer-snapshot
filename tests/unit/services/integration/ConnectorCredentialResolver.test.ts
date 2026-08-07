import 'reflect-metadata';
import {
  DefaultConnectorCredentialResolver,
  type SecureCredentialManagerProvider,
} from '../../../../src/services/integration/ConnectorCredentialResolver';
import {
  CrossTenantCredentialError,
  type TenantSystemCredentialRegistry,
} from '../../../../src/services/integration/TenantSystemCredentialRegistry';
import { ConflictAppError, ServiceUnavailableAppError } from '../../../../src/errors/AppError';
import type { SecureCredentialManager } from '../../../../src/services/SecureCredentialManager';
import type { IntegrationConfig } from '../../../../src/types';

/**
 * Prerequisite PR B (2026-07-27 NetSuite serialized-asset sync plan):
 * ConnectorCredentialResolver is the runtime counterpart of the schema-level
 * managed credential reference — it resolves the AuthConfig ConnectorManager
 * hands to IConnector.initialize() for one side of an IntegrationConfig.
 *
 * The constructor takes a lazy SecureCredentialManagerProvider (not a
 * concrete SecureCredentialManager instance) — see the DI-wiring comment in
 * inversify.config.ts: SecureCredentialManager transitively injects the
 * async-bound SecretManager, so a sync-bound consumer (ConnectorManager) must
 * receive a deferred accessor rather than an eagerly-resolved instance.
 */

function makeSecureCredentialManager(): jest.Mocked<Pick<SecureCredentialManager, 'getCredentials'>> {
  return {
    getCredentials: jest.fn(),
  };
}

function makeProvider(
  scm: jest.Mocked<Pick<SecureCredentialManager, 'getCredentials'>>,
): SecureCredentialManagerProvider {
  return async () => scm as unknown as SecureCredentialManager;
}

/**
 * Ownership registry double. Admits everything by default so the pre-existing
 * resolution-rule tests below keep asserting exactly what they were written to
 * assert; the cross-tenant block at the bottom drives the refusal paths.
 */
function makeRegistry(
  assertSystemOwnedByTenant: jest.Mock = jest.fn(async () => undefined),
): { registry: TenantSystemCredentialRegistry; assertSystemOwnedByTenant: jest.Mock } {
  return {
    registry: { assertSystemOwnedByTenant } as TenantSystemCredentialRegistry,
    assertSystemOwnedByTenant,
  };
}

function baseConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Test Config',
    sourceSystem: 'Salesforce',
    targetSystem: 'NetSuite',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: false,
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  } as IntegrationConfig;
}

describe('DefaultConnectorCredentialResolver', () => {
  it('resolves credentials from SecureCredentialManager when credentialSource is secret_manager', async () => {
    const scm = makeSecureCredentialManager();
    const resolved = { type: 'oauth2', credentials: { clientId: 'x' } } as any;
    scm.getCredentials.mockResolvedValue(resolved);
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);

    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
    });

    const result = await resolver.resolve(config, 'source');

    expect(scm.getCredentials).toHaveBeenCalledWith('Salesforce', 'sf-1');
    expect(result).toBe(resolved);
  });

  it('falls back to sourceAuthentication for a legacy string system reference', async () => {
    const scm = makeSecureCredentialManager();
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const auth = { type: 'api_key' as const, credentials: { apiKey: 'k' } };
    const config = baseConfig({ sourceSystem: 'Salesforce', sourceAuthentication: auth });

    const result = await resolver.resolve(config, 'source');

    expect(result).toBe(auth);
    expect(scm.getCredentials).not.toHaveBeenCalled();
  });

  it('falls back to authentication.source when sourceAuthentication is absent (legacy fallback shape)', async () => {
    const scm = makeSecureCredentialManager();
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const auth = { type: 'basic' as const, credentials: { username: 'u', password: 'p' } };
    const config = baseConfig({ sourceSystem: 'Salesforce', authentication: { source: auth } });

    const result = await resolver.resolve(config, 'source');

    expect(result).toBe(auth);
  });

  it('falls back to inline auth when credentialSource is explicitly "inline"', async () => {
    const scm = makeSecureCredentialManager();
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const auth = { type: 'oauth1' as const, credentials: { consumerKey: 'k' } };
    const config = baseConfig({
      targetSystem: { type: 'NetSuite', credentialSource: 'inline' },
      targetAuthentication: auth,
    });

    const result = await resolver.resolve(config, 'target');

    expect(result).toBe(auth);
    expect(scm.getCredentials).not.toHaveBeenCalled();
  });

  it('returns undefined for credentialSource "environment" without invoking SecureCredentialManager (environment compatibility)', async () => {
    const scm = makeSecureCredentialManager();
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const config = baseConfig({
      targetSystem: { type: 'NetSuite', credentialSource: 'environment' },
    });

    const result = await resolver.resolve(config, 'target');

    expect(result).toBeUndefined();
    expect(scm.getCredentials).not.toHaveBeenCalled();
  });

  it('resolves source and target independently (source secret_manager, target legacy inline)', async () => {
    const scm = makeSecureCredentialManager();
    const sourceResolved = { type: 'oauth2', credentials: { clientId: 'src' } } as any;
    scm.getCredentials.mockResolvedValue(sourceResolved);
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const targetAuth = { type: 'oauth1' as const, credentials: { consumerKey: 'tgt' } };

    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
      targetSystem: 'NetSuite',
      targetAuthentication: targetAuth,
    });

    const source = await resolver.resolve(config, 'source');
    const target = await resolver.resolve(config, 'target');

    expect(source).toBe(sourceResolved);
    expect(target).toBe(targetAuth);
    expect(scm.getCredentials).toHaveBeenCalledTimes(1);
  });

  it('propagates a secret-manager lookup failure (lookup-failure propagation)', async () => {
    const scm = makeSecureCredentialManager();
    scm.getCredentials.mockRejectedValue(new Error('secret not found'));
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
    });

    await expect(resolver.resolve(config, 'source')).rejects.toThrow('secret not found');
  });

  it('throws (without calling SecureCredentialManager) when credentialSource is secret_manager but systemId is missing', async () => {
    const scm = makeSecureCredentialManager();
    const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), makeRegistry().registry);
    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', credentialSource: 'secret_manager' },
    });

    await expect(resolver.resolve(config, 'source')).rejects.toThrow(/systemId/);
    expect(scm.getCredentials).not.toHaveBeenCalled();
  });

  // Copilot R4: a plain Error reaches the global error boundary unclassified
  // and is reported as HTTP 500, i.e. "the server broke", when in fact this is a
  // deterministic refusal that will recur identically on every retry. Asserting
  // the TYPE and statusCode rather than the message means a revert to
  // `new Error(...)` fails even if the wording survives.
  it('refuses a missing secret_manager systemId with a typed 409, not an unclassified error', async () => {
    const resolver = new DefaultConnectorCredentialResolver(
      makeProvider(makeSecureCredentialManager()),
      makeRegistry().registry,
    );
    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', credentialSource: 'secret_manager' },
    });

    const err = await resolver.resolve(config, 'source').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictAppError);
    expect((err as ConflictAppError).statusCode).toBe(409);
  });

  it('refuses an unrecognized stored credentialSource with a typed 409', async () => {
    const resolver = new DefaultConnectorCredentialResolver(
      makeProvider(makeSecureCredentialManager()),
      makeRegistry().registry,
    );
    // Only reachable when a record bypassed `validateIntegrationConfig` — the
    // canonical schema's z.enum rejects this literal — so the cast is the point
    // of the test, not a shortcut.
    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'vault' as never },
    });

    const err = await resolver.resolve(config, 'source').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ConflictAppError);
    expect((err as ConflictAppError).statusCode).toBe(409);
  });

  it('propagates a rejection from the SecureCredentialManagerProvider itself (e.g. async DI resolution failure)', async () => {
    const provider: SecureCredentialManagerProvider = async () => {
      throw new Error('provider resolution failed');
    };
    const resolver = new DefaultConnectorCredentialResolver(provider, makeRegistry().registry);
    const config = baseConfig({
      sourceSystem: { type: 'Salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
    });

    await expect(resolver.resolve(config, 'source')).rejects.toThrow('provider resolution failed');
  });

  /**
   * SECURITY - cross-tenant credential USE.
   *
   * SecureCredentialManager.getCredentials(systemType, systemId) takes no
   * tenantId and keys its secret as credentials_<type>_<id>. A stored
   * configuration's systemId is operator-authored free text (1-200 chars), so
   * without an ownership check a tenant-A user could save a draft naming
   * tenant B's systemId and have the server resolve tenant B's brokered
   * credentials and connect to tenant B's org.
   *
   * The resolver is the single funnel for managed credentials - readiness,
   * activation, and sync all reach getCredentials through it - so the check
   * belongs here.
   */
  describe('tenant ownership of managed system references', () => {
    it('verifies ownership against the OWNING tenant of the stored config (config tenantId, never caller input)', async () => {
      const scm = makeSecureCredentialManager();
      scm.getCredentials.mockResolvedValue({ type: 'oauth2', credentials: {} } as any);
      const { registry, assertSystemOwnedByTenant } = makeRegistry();
      const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), registry);
      const config = baseConfig({
        tenantId: 'tenant-a',
        targetSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
      });

      await resolver.resolve(config, 'target');

      expect(assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'Salesforce', 'sf-prod');
    });

    it('checks ownership BEFORE any secret-manager lookup', async () => {
      const order: string[] = [];
      const scm = makeSecureCredentialManager();
      scm.getCredentials.mockImplementation(async () => {
        order.push('getCredentials');
        return { type: 'oauth2', credentials: {} } as any;
      });
      const { registry } = makeRegistry(
        jest.fn(async () => {
          order.push('ownership');
        }),
      );
      const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), registry);

      await resolver.resolve(
        baseConfig({
          targetSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
        }),
        'target',
      );

      expect(order).toEqual(['ownership', 'getCredentials']);
    });

    it('FAILS CLOSED - a tenant-A config naming a tenant-B systemId never reaches SecureCredentialManager', async () => {
      const scm = makeSecureCredentialManager();
      const { registry } = makeRegistry(
        jest.fn(async () => {
          throw new CrossTenantCredentialError('not registered to this tenant');
        }),
      );
      const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), registry);
      const config = baseConfig({
        tenantId: 'tenant-a',
        targetSystem: { type: 'Salesforce', systemId: 'tenant-b-sf-prod', credentialSource: 'secret_manager' },
      });

      await expect(resolver.resolve(config, 'target')).rejects.toBeInstanceOf(CrossTenantCredentialError);
      expect(scm.getCredentials).not.toHaveBeenCalled();
    });

    it('propagates an undeterminable ownership check as 503 rather than resolving credentials', async () => {
      const scm = makeSecureCredentialManager();
      const { registry } = makeRegistry(
        jest.fn(async () => {
          throw new ServiceUnavailableAppError('registry unavailable');
        }),
      );
      const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), registry);

      await expect(
        resolver.resolve(
          baseConfig({
            targetSystem: { type: 'Salesforce', systemId: 'sf-prod', credentialSource: 'secret_manager' },
          }),
          'target',
        ),
      ).rejects.toBeInstanceOf(ServiceUnavailableAppError);
      expect(scm.getCredentials).not.toHaveBeenCalled();
    });

    it('does NOT consult the registry for inline / legacy / environment references (no behavior change)', async () => {
      const scm = makeSecureCredentialManager();
      const { registry, assertSystemOwnedByTenant } = makeRegistry();
      const resolver = new DefaultConnectorCredentialResolver(makeProvider(scm), registry);

      await resolver.resolve(
        baseConfig({
          sourceSystem: 'Salesforce',
          sourceAuthentication: { type: 'api_key', credentials: { apiKey: 'k' } },
        }),
        'source',
      );
      await resolver.resolve(
        baseConfig({
          targetSystem: { type: 'NetSuite', credentialSource: 'inline' },
          targetAuthentication: { type: 'oauth1', credentials: { consumerKey: 'k' } } as any,
        }),
        'target',
      );
      await resolver.resolve(
        baseConfig({ targetSystem: { type: 'NetSuite', credentialSource: 'environment' } }),
        'target',
      );

      expect(assertSystemOwnedByTenant).not.toHaveBeenCalled();
    });
  });
});
