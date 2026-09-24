import 'reflect-metadata';
import { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';
import { Logger } from '../../../../src/utils/Logger';
import { AuthService } from '../../../../src/services/AuthService';
import type { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { ConnectorCredentialResolver } from '../../../../src/services/integration/ConnectorCredentialResolver';
import type { IntegrationConfig } from '../../../../src/types';
import { ConflictAppError } from '../../../../src/errors/AppError';

/**
 * Prerequisite PR B (2026-07-27 NetSuite serialized-asset sync plan):
 * ConnectorManager.initializeConnectorsForConfig() delegates credential
 * resolution to an injected ConnectorCredentialResolver, and derives its
 * connector cache/creation key via connectorKeyForSystem() rather than the
 * raw config spelling — closing the known gap where a manifest-spelled
 * system (e.g. 'business_central', registry key 'businesscentral') would
 * throw "Unsupported system type" or diverge from a caller's own retrieval
 * key (see OwnershipResumeHandler.test.ts for the caller-side proof).
 */

function makeResolver(
  overrides: Partial<jest.Mocked<ConnectorCredentialResolver>> = {},
): jest.Mocked<ConnectorCredentialResolver> {
  return {
    resolve: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  } as jest.Mocked<ConnectorCredentialResolver>;
}

function build(resolver: ConnectorCredentialResolver): ConnectorManager {
  const logger = new Logger('ConnectorManager.credentials.test');
  const authService = new AuthService(logger);
  const outboundGovernance = {} as OutboundGovernanceService;
  return new ConnectorManager(logger, authService, outboundGovernance, resolver);
}

function baseConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-1',
    tenantId: 'tenant-a',
    name: 'Test Config',
    sourceSystem: 'netsuite',
    targetSystem: 'salesforce',
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

describe('ConnectorManager.initializeConnectorsForConfig (managed credential resolution)', () => {
  it('initializes source and target connectors with the resolver-provided AuthConfig for each side', async () => {
    const sourceAuth = { type: 'oauth1', credentials: { consumerKey: 'x' } } as any;
    const targetAuth = { type: 'oauth2', credentials: { clientId: 'y' } } as any;
    const resolver = makeResolver({
      resolve: jest.fn(async (_config, side) => (side === 'source' ? sourceAuth : targetAuth)),
    });
    const manager = build(resolver);
    const config = baseConfig();

    const source = await manager.getConnector('netsuite', 'netsuite_cfg-1');
    const target = await manager.getConnector('salesforce', 'salesforce_cfg-1');
    const sourceInitSpy = jest.spyOn(source, 'initialize').mockResolvedValue(undefined);
    const targetInitSpy = jest.spyOn(target, 'initialize').mockResolvedValue(undefined);

    await manager.initializeConnectorsForConfig(config);

    expect(sourceInitSpy).toHaveBeenCalledWith(sourceAuth);
    expect(targetInitSpy).toHaveBeenCalledWith(targetAuth);
    expect(resolver.resolve).toHaveBeenCalledWith(config, 'source');
    expect(resolver.resolve).toHaveBeenCalledWith(config, 'target');
  });

  it('does not call initialize on either connector when the resolver resolves undefined for both sides (environment compatibility)', async () => {
    const resolver = makeResolver(); // default: resolves undefined
    const manager = build(resolver);
    const config = baseConfig();

    const source = await manager.getConnector('netsuite', 'netsuite_cfg-1');
    const target = await manager.getConnector('salesforce', 'salesforce_cfg-1');
    const sourceInitSpy = jest.spyOn(source, 'initialize').mockResolvedValue(undefined);
    const targetInitSpy = jest.spyOn(target, 'initialize').mockResolvedValue(undefined);

    await manager.initializeConnectorsForConfig(config);

    expect(sourceInitSpy).not.toHaveBeenCalled();
    expect(targetInitSpy).not.toHaveBeenCalled();
  });

  it('resolves source and target independently — a source-only resolved auth does not affect the target side', async () => {
    const sourceAuth = { type: 'oauth1', credentials: { consumerKey: 'x' } } as any;
    const resolver = makeResolver({
      resolve: jest.fn(async (_config, side) => (side === 'source' ? sourceAuth : undefined)),
    });
    const manager = build(resolver);
    const config = baseConfig();

    const source = await manager.getConnector('netsuite', 'netsuite_cfg-1');
    const target = await manager.getConnector('salesforce', 'salesforce_cfg-1');
    const sourceInitSpy = jest.spyOn(source, 'initialize').mockResolvedValue(undefined);
    const targetInitSpy = jest.spyOn(target, 'initialize').mockResolvedValue(undefined);

    await manager.initializeConnectorsForConfig(config);

    expect(sourceInitSpy).toHaveBeenCalledWith(sourceAuth);
    expect(targetInitSpy).not.toHaveBeenCalled();
  });

  it('propagates a secret-manager lookup failure and calls initialize on NEITHER connector (no initialization before resolution succeeds)', async () => {
    const resolver = makeResolver({
      resolve: jest.fn().mockRejectedValue(new Error('secret lookup failed')),
    });
    const manager = build(resolver);
    const config = baseConfig();

    const source = await manager.getConnector('netsuite', 'netsuite_cfg-1');
    const target = await manager.getConnector('salesforce', 'salesforce_cfg-1');
    const sourceInitSpy = jest.spyOn(source, 'initialize').mockResolvedValue(undefined);
    const targetInitSpy = jest.spyOn(target, 'initialize').mockResolvedValue(undefined);

    await expect(manager.initializeConnectorsForConfig(config)).rejects.toThrow('secret lookup failed');

    expect(sourceInitSpy).not.toHaveBeenCalled();
    expect(targetInitSpy).not.toHaveBeenCalled();
  });

  /**
   * PR A2 (deployment-readiness Tranche A) tightened the ORDER, not just the
   * outcome. `resolve()` for BOTH sides now completes before EITHER connector
   * is created.
   *
   * The two tests above pre-create their connectors and then assert
   * `initialize()` was not called, which is why they stayed green while
   * creation still ran first. That left a real gap: a refused configuration —
   * a cross-tenant `systemId`, a secret-manager outage — still reached the
   * registry factory and still left an uninitialized instance in the
   * per-process cache under the very key every downstream retriever
   * reconstructs. A later caller doing `getConnector('salesforce',
   * 'salesforce_cfg-1')` would hit that cached instance instead of creating
   * one, and would get a connector for a configuration the tenant was just
   * refused. A2 routes `IntegrationService`'s standard paths here, so the
   * refusal has to land before the factory, not merely before `initialize()`.
   */
  describe('resolution completes before any connector is created', () => {
    it('creates NO connector and leaves the cache empty when the SOURCE side is refused', async () => {
      const resolver = makeResolver({
        resolve: jest.fn().mockRejectedValue(new Error('managed reference refused')),
      });
      const manager = build(resolver);
      const createConnectorSpy = jest.spyOn(manager as any, 'createConnector');

      await expect(manager.initializeConnectorsForConfig(baseConfig())).rejects.toThrow(
        'managed reference refused',
      );

      expect(createConnectorSpy).not.toHaveBeenCalled();
      expect(manager.getConnectorStats().totalConnectors).toBe(0);
    });

    it('creates NO connector when only the TARGET side is refused, so a half-initialized pair is impossible', async () => {
      const sourceAuth = { type: 'oauth1', credentials: { consumerKey: 'x' } } as any;
      const resolver = makeResolver({
        resolve: jest.fn(async (_config, side) => {
          if (side === 'source') return sourceAuth;
          throw new Error('target managed reference refused');
        }),
      });
      const manager = build(resolver);
      const createConnectorSpy = jest.spyOn(manager as any, 'createConnector');

      await expect(manager.initializeConnectorsForConfig(baseConfig())).rejects.toThrow(
        'target managed reference refused',
      );

      expect(createConnectorSpy).not.toHaveBeenCalled();
      expect(manager.getConnectorStats().totalConnectors).toBe(0);
    });
  });

  it('resolves a manifest-spelled target system (business_central) to the businesscentral registry key end-to-end without throwing', async () => {
    // Regression pin for the Prereq A/B known gap: before this PR,
    // createConnector('business_central'.toLowerCase()) misses the
    // 'businesscentral' registry entry and throws "Unsupported system type".
    const resolver = makeResolver();
    const manager = build(resolver);
    const config = baseConfig({ targetSystem: 'business_central', id: 'cfg-bc' });

    await expect(manager.initializeConnectorsForConfig(config)).resolves.toBeUndefined();

    const stats = manager.getConnectorStats();
    // source (netsuite) + target (businesscentral) — exactly two, proving the
    // target connector was created under the PROJECTED registry key.
    expect(stats.totalConnectors).toBe(2);
    expect(Object.keys(stats.connectorsByType)).toEqual(
      expect.arrayContaining(['netsuite', 'businesscentral']),
    );
  });

  it('caches the manifest-spelled target connector under the SAME projected key a caller (e.g. OwnershipResumeHandler) would retrieve by', async () => {
    const resolver = makeResolver();
    const manager = build(resolver);
    const config = baseConfig({ targetSystem: 'business_central', id: 'cfg-bc' });

    await manager.initializeConnectorsForConfig(config);
    const before = manager.getConnectorStats().totalConnectors;

    // A caller retrieving with the connector-registry key ('businesscentral')
    // must hit the SAME cached instance — no new connector created.
    const retrieved = await manager.getConnector('businesscentral', 'businesscentral_cfg-bc');
    const after = manager.getConnectorStats().totalConnectors;

    expect(retrieved).toBeDefined();
    expect(after).toBe(before);
  });

  describe('same-connector-key sides with distinct managed system references', () => {
    // The cache id is `${connectorKey}_${config.id}` for BOTH sides, so two
    // same-typed sides collapse to ONE instance. Managed references made it
    // possible to express two DIFFERENT brokered credentials on those sides
    // (e.g. two Salesforce orgs); without a guard the target's initialize()
    // would silently overwrite the source's credentials and service its reads.
    it('refuses a config whose sides share a connector key but name different systemIds', async () => {
      const resolver = makeResolver({
        resolve: jest.fn(async (_config, side) => ({
          type: 'oauth2',
          credentials: { clientId: side },
        }) as any),
      });
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-two-orgs',
        sourceSystem: { type: 'salesforce', systemId: 'sf-org-a', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: 'sf-org-b', credentialSource: 'secret_manager' },
      } as Partial<IntegrationConfig>);

      await expect(manager.initializeConnectorsForConfig(config)).rejects.toThrow(
        /same connector .* but different credential identities/,
      );
      // Fails BEFORE any credential is resolved or any connector initialized.
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    // Copilot R4: the refusal above is deterministic and retry-invariant, but a
    // plain Error reaches the global error boundary unclassified and surfaces as
    // HTTP 500 — telling an operator the server broke. Asserting the TYPE and
    // statusCode rather than the message means a revert to `new Error(...)`
    // fails even if the wording survives.
    it('refuses with a typed 409, not an unclassified error', async () => {
      const resolver = makeResolver();
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-two-orgs-typed',
        sourceSystem: { type: 'salesforce', systemId: 'sf-org-a', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: 'sf-org-b', credentialSource: 'secret_manager' },
      } as Partial<IntegrationConfig>);

      const err = await manager.initializeConnectorsForConfig(config).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ConflictAppError);
      expect((err as ConflictAppError).statusCode).toBe(409);
    });

    // Codex round 2 reproduced this against the id-only version of the guard:
    // matching systemIds do NOT imply matching credentials. One side resolves a
    // brokered secret, the other the config's inline auth object — two
    // different credentials on one cached connector. Note the system types
    // differ only by case, so both still project to the same connector key.
    it('refuses same-id sides whose credentialSource differs (brokered vs inline)', async () => {
      const resolver = makeResolver({
        resolve: jest.fn(async (_config, side) => ({
          type: 'oauth2',
          credentials: { clientId: side },
        }) as any),
      });
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-mixed-source',
        sourceSystem: { type: 'Salesforce', systemId: 'same', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: 'same', credentialSource: 'inline' },
      } as Partial<IntegrationConfig>);

      await expect(manager.initializeConnectorsForConfig(config)).rejects.toThrow(
        /different credential identities/,
      );
      expect(resolver.resolve).not.toHaveBeenCalled();
    });

    it('treats an omitted credentialSource as inline, so legacy same-id sides still pass', async () => {
      const resolver = makeResolver();
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-omitted-source',
        sourceSystem: { type: 'salesforce', systemId: 'sf-a' },
        targetSystem: { type: 'salesforce', systemId: 'sf-a', credentialSource: 'inline' },
      } as Partial<IntegrationConfig>);

      await expect(manager.initializeConnectorsForConfig(config)).resolves.toBeUndefined();
    });

    it('allows both sides to share one connector when they name the SAME systemId', async () => {
      const resolver = makeResolver();
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-one-org',
        sourceSystem: { type: 'salesforce', systemId: 'sf-org-a', credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: 'sf-org-a', credentialSource: 'secret_manager' },
      } as Partial<IntegrationConfig>);

      await expect(manager.initializeConnectorsForConfig(config)).resolves.toBeUndefined();
    });

    it('leaves the pre-existing legacy shape untouched — neither side declares a systemId', async () => {
      const resolver = makeResolver();
      const manager = build(resolver);
      const config = baseConfig({
        id: 'cfg-legacy',
        sourceSystem: 'salesforce',
        targetSystem: 'salesforce',
      });

      await expect(manager.initializeConnectorsForConfig(config)).resolves.toBeUndefined();
    });
  });
});
