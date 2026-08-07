import { IntegrationService } from '../../../src/services/IntegrationService';
import type { IntegrationConfig, SyncResult } from '../../../src/types';
import type { IConnector } from '../../../src/interfaces/IConnector';
import type { ConnectorManager } from '../../../src/services/integration/ConnectorManager';
import { DefaultConnectorCredentialResolver } from '../../../src/services/integration/ConnectorCredentialResolver';
import {
  CrossTenantCredentialError,
  TenantSettingSystemCredentialRegistry,
  managedSystemRegistryKey,
} from '../../../src/services/integration/TenantSystemCredentialRegistry';
import { AppError, ServiceUnavailableAppError } from '../../../src/errors/AppError';
import {
  createMockOutboundGovernanceService,
  createMockOwnershipResolver,
  createMockAuditService,
  createMockConnectorManager,
  createMockSerializedAssetSyncService,
  createStandardPathConnectorManager,
} from '../../governanceTestUtils';

const createLogger = () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
});

/**
 * `runIntegration*` builds an observability scope unconditionally, so any test
 * that drives the standard RUN path needs one. Kept here (rather than passing
 * `undefined`, which lands on the `{} as ObservabilityService` stub) so scope
 * logging is CAPTURED — the A2 leak-safety assertions read it.
 */
const createRecordingObservability = () => {
  const scopeLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  const metrics = {
    incrementActiveIntegrations: jest.fn(),
    decrementActiveIntegrations: jest.fn(),
    recordIntegrationRun: jest.fn(),
  };
  return {
    observability: { createScope: jest.fn().mockReturnValue({ logger: scopeLogger, metrics }) },
    scopeLogger,
    metrics,
  };
};

const createIntegrationService = (
  overrides: { connectorManager?: ConnectorManager; observability?: unknown } = {},
) => {
  const logger = createLogger();
  const transformationEngine = { transform: jest.fn() };
  const configService = {
    loadConfigurations: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
  };
  const authService = { authenticate: jest.fn() };

  const service = new IntegrationService(
    logger as any,
    transformationEngine as any,
    configService as any,
    authService as any,
    overrides.observability as any,
    createMockOutboundGovernanceService() as any,
    createMockOwnershipResolver() as any,
    createMockAuditService() as any,
    { enqueue: jest.fn().mockResolvedValue('noop-queue-id') } as any,
    (overrides.connectorManager ?? createMockConnectorManager()) as any,
    createMockSerializedAssetSyncService() as any,
  );

  (service as any).maxConcurrentIntegrations = 3;

  return { service, logger, configService, transformationEngine };
};

describe('IntegrationService core behaviors', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('initializes integration status lazily', () => {
    const { service } = createIntegrationService();

    const status = service.getIntegrationStatus('config-1');
    expect(status).toEqual({
      configId: 'config-1',
      isRunning: false,
      errorCount: 0,
      successCount: 0
    });

    const secondCall = service.getIntegrationStatus('config-1');
    expect(secondCall).toBe(status);
  });

  it('records sync results and updates counters', () => {
    const { service } = createIntegrationService();

    const result: SyncResult = {
      integrationId: 'config-1',
      syncId: 'sync-123',
      status: 'success',
      success: true,
      recordsProcessed: 5,
      recordsSuccessful: 5,
      recordsFailed: 0,
      errors: [],
      startTime: new Date('2024-01-01T00:00:00Z'),
      endTime: new Date('2024-01-01T00:01:00Z')
    };

    service.recordSyncResult('config-1', result);

    const status = service.getIntegrationStatus('config-1');
    expect(status.lastSync).toEqual(result.endTime);
    expect(status.lastSyncResult).toEqual(result);
    expect(status.successCount).toBe(1);
    expect(status.errorCount).toBe(0);
    expect(status.isRunning).toBe(false);
  });

  it('stops integrations and updates running set', async () => {
    const { service } = createIntegrationService();
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-2');
    (service as any).updateIntegrationStatus('config-2', { isRunning: true });

    const stopped = await service.stopIntegration('config-2');
    expect(stopped).toBe(true);
    expect(running.has('config-2')).toBe(false);
    expect(service.getIntegrationStatus('config-2').isRunning).toBe(false);

    const noOp = await service.stopIntegration('config-3');
    expect(noOp).toBe(false);
  });

  it('calculates rate limit availability', () => {
    const { service } = createIntegrationService();
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-a');
    running.add('config-b');

    const status = service.getRateLimitStatus();
    expect(status).toEqual({
      currentRunning: 2,
      maxConcurrent: 3,
      available: 1,
      isAtLimit: false
    });
  });

  it('exports and imports integration state snapshots', async () => {
    const { service } = createIntegrationService();
    const statusMap = (service as any).integrationStatus as Map<string, any>;
    statusMap.set('config-9', {
      configId: 'config-9',
      isRunning: true,
      errorCount: 2,
      successCount: 3
    });
    const running = (service as any).runningIntegrations as Set<string>;
    running.add('config-9');

    const exported = await service.exportStates();
    expect(exported.integrationStates).toHaveLength(1);
    expect(exported.runningIntegrations).toContain('config-9');
    expect(exported.connectorCount).toBe(0);

    const { service: restored } = createIntegrationService();
    await restored.importStates(exported);

    const restoredStatus = restored.getIntegrationStatus('config-9');
    expect(restoredStatus.isRunning).toBe(true);
    expect(restoredStatus.errorCount).toBe(2);
    expect(restoredStatus.successCount).toBe(3);
    const restoredRunning = (restored as any).runningIntegrations as Set<string>;
    expect(restoredRunning.has('config-9')).toBe(true);
  });

  it('derives platform health status from system health snapshot', async () => {
    const { service } = createIntegrationService();

    const healthSpy = jest
      .spyOn(service, 'getSystemHealth')
      .mockResolvedValue({
        totalConfigurations: 4,
        activeConfigurations: 3,
        runningIntegrations: 1,
        rateLimitStatus: {
          currentRunning: 1,
          maxConcurrent: 3,
          available: 2,
          isAtLimit: false
        },
        systemStatus: {
          NetSuite: true,
          Salesforce: true,
          Dynamics365: false,
          SAP: false
        }
      });

    const health = await service.getHealthStatus();

    expect(health.status).toBe('degraded');
    expect(health.message).toContain('2/4');
    expect(health.metrics).toEqual(
      expect.objectContaining({
        healthySystemsCount: 2,
        totalSystemsCount: 4,
        runningIntegrations: 1
      })
    );
    healthSpy.mockRestore();
  });

  describe('tenant-scoped configuration resolution', () => {
    it('request-path variant (ForTenant) resolves via getConfigurationForTenant, never the deprecated lookup', async () => {
      const { service } = createIntegrationService();
      const cfgSvc = (service as any).configService;
      cfgSvc.getConfigurationForTenant.mockReturnValue(undefined);

      // config not found → method throws; we only assert the lookup path here.
      await expect(service.testIntegrationForTenant('tenant-x', 'config-1')).rejects.toThrow();

      expect(cfgSvc.getConfigurationForTenant).toHaveBeenCalledWith('tenant-x', 'config-1');
      expect(cfgSvc.getConfiguration).not.toHaveBeenCalled();
    });

    it('background variant (no tenant) uses the deliberate tenant-agnostic escape hatch', async () => {
      const { service } = createIntegrationService();
      const cfgSvc = (service as any).configService;
      cfgSvc.getConfiguration.mockReturnValue(undefined);

      await expect(service.testIntegration('config-1')).rejects.toThrow();

      expect(cfgSvc.getConfiguration).toHaveBeenCalledWith('config-1');
      expect(cfgSvc.getConfigurationForTenant).not.toHaveBeenCalled();
    });
  });
});



/**
 * PR A2 (deployment-readiness Tranche A) — managed credential references are
 * now EXECUTABLE on the four standard paths (run, test, single-record,
 * initialize) instead of refused.
 *
 * Before A2 these paths used `IntegrationService`'s own connector map and read
 * `config.sourceAuthentication` / `.targetAuthentication` inline. They could
 * not resolve a brokered (`secret_manager`) secret and could not enforce
 * `TenantSystemCredentialRegistry`'s tenant-ownership check, so
 * `assertNoManagedCredentialReference` refused a managed config outright —
 * skipping `initialize()` would have been WORSE, because the per-process
 * connector cache would have served the run with stale inline credentials and
 * no ownership assertion. A2 removes the refusal by removing its cause: all
 * four paths now go through `ConnectorManager`, the single funnel that
 * resolves through `ConnectorCredentialResolver` and asserts ownership first.
 *
 * These tests are deliberately built on a REAL `ConnectorManager` and a REAL
 * `DefaultConnectorCredentialResolver`. Only the two leaves are faked — the
 * secret store and the ownership registry — so the ORDERING that makes this
 * safe (ownership before secret fetch, resolution before `initialize()`) is
 * proven rather than mocked away.
 */
describe('IntegrationService executes managed credential references through ConnectorManager', () => {
  const SOURCE_SECRET_SENTINEL = 'ns-brokered-secret-do-not-leak';
  const TARGET_SECRET_SENTINEL = 'sf-brokered-secret-do-not-leak';

  const managedConfig = (overrides: Record<string, unknown> = {}): IntegrationConfig => ({
    id: 'cfg-managed',
    tenantId: 'tenant-a',
    name: 'Managed',
    sourceSystem: { type: 'netsuite', systemId: 'ns-1', credentialSource: 'secret_manager' },
    targetSystem: { type: 'salesforce', systemId: 'sf-1', credentialSource: 'secret_manager' },
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  } as unknown as IntegrationConfig);

  const makeFakeConnector = (systemType: string): IConnector => ({
    systemType,
    systemId: `${systemType}-id`,
    initialize: jest.fn().mockResolvedValue(undefined),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
    getSystemInfo: jest.fn(),
    authenticate: jest.fn(),
    create: jest.fn(),
    read: jest.fn().mockResolvedValue(null),
    update: jest.fn(),
    delete: jest.fn(),
    list: jest.fn().mockResolvedValue([]),
    search: jest.fn(),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
  } as unknown as IConnector);

  /**
   * `registrations` is keyed by system TYPE and holds the `systemId`s that
   * `tenant-a` has registered — the operator-authored shape, exactly as it is
   * stored: one tenant-settings row per type under
   * `integration.managed_systems.${type.toLowerCase()}`, holding a JSON array.
   *
   * The ownership check is the REAL `TenantSettingSystemCredentialRegistry`
   * wired to a fake settings reader, not a hand-written predicate. That
   * distinction is the whole point of the padded-spelling case below: a fake
   * `assertSystemOwnedByTenant` built on `owned.includes(...)` decides the
   * answer by construction and can only ever confirm what its author already
   * believed. Only the real registry can tell us which of its several refusal
   * branches a padded system type actually lands on — and it turned out to be
   * the settings-key miss, not the explicit untrimmed-`systemId` refusal.
   */
  const createManagedHarness = (
    options: {
      config?: IntegrationConfig;
      registrations?: Record<string, string[]>;
      getCredentialsImpl?: (systemType: string, systemId: string) => Promise<unknown>;
    } = {},
  ) => {
    const config = options.config ?? managedConfig();
    const registrations = options.registrations ?? { netsuite: ['ns-1'], salesforce: ['sf-1'] };

    // One row per registered type, stored under the SAME key derivation the
    // registry reads with, so the fake is a storage double and not a second
    // implementation of the lookup rule.
    const settingRows = new Map<string, string>(
      Object.entries(registrations).map(([systemType, systemIds]) => [
        managedSystemRegistryKey(systemType),
        JSON.stringify(systemIds),
      ]),
    );
    const getStringStrict = jest.fn(async (tenantId: string, settingKey: string) =>
      tenantId === 'tenant-a' ? (settingRows.get(settingKey) ?? null) : null,
    );

    const ownershipRegistry = new TenantSettingSystemCredentialRegistry(async () => ({
      getStringStrict,
    }));
    const assertSystemOwnedByTenant = jest.spyOn(ownershipRegistry, 'assertSystemOwnedByTenant');

    const getCredentials = jest.fn(
      options.getCredentialsImpl ??
        (async (systemType: string) => ({
          type: 'oauth2',
          credentials: {
            clientSecret: systemType === 'netsuite' ? SOURCE_SECRET_SENTINEL : TARGET_SECRET_SENTINEL,
          },
        })),
    );

    const resolver = new DefaultConnectorCredentialResolver(
      (async () => ({ getCredentials })) as any,
      ownershipRegistry,
    );

    const { manager } = createStandardPathConnectorManager({
      resolve: (cfg, side) => resolver.resolve(cfg, side),
    });

    const connectors = new Map<string, IConnector>();
    const createConnectorSpy = jest
      .spyOn(manager as any, 'createConnector')
      .mockImplementation((...args: unknown[]) => {
        const systemType = args[0] as string;
        const connector = makeFakeConnector(systemType);
        connectors.set(systemType, connector);
        return connector;
      });

    const { observability, scopeLogger } = createRecordingObservability();
    const { service, logger, configService, transformationEngine } = createIntegrationService({
      connectorManager: manager,
      observability,
    });

    (configService.getConfiguration as jest.Mock).mockReturnValue(config);
    (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(config);
    (configService.getAllConfigurations as jest.Mock).mockReturnValue([config]);
    (configService as any).validateConfiguration = jest
      .fn()
      .mockResolvedValue({ isValid: true, errors: [], warnings: [] });

    // The legacy inline-only factory. A2's contract is that NO standard path
    // reaches it any more, so every test below asserts against this spy.
    const legacyGetConnector = jest.spyOn(service as any, 'getConnector');

    return {
      config,
      service,
      logger,
      scopeLogger,
      configService,
      transformationEngine,
      manager,
      assertSystemOwnedByTenant,
      getStringStrict,
      getCredentials,
      createConnectorSpy,
      legacyGetConnector,
      connectors,
      sourceConnector: () => connectors.get('netsuite')!,
      targetConnector: () => connectors.get('salesforce')!,
    };
  };

  const expectResolvedPair = (h: ReturnType<typeof createManagedHarness>): void => {
    // Ownership asserted for BOTH sides, each before its own secret fetch.
    expect(h.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'netsuite', 'ns-1');
    expect(h.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'salesforce', 'sf-1');
    expect(h.getCredentials).toHaveBeenCalledWith('netsuite', 'ns-1');
    expect(h.getCredentials).toHaveBeenCalledWith('salesforce', 'sf-1');

    // The brokered secret reached `initialize()` — the whole point of A2.
    expect(h.sourceConnector().initialize).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { clientSecret: SOURCE_SECRET_SENTINEL } }),
    );
    expect(h.targetConnector().initialize).toHaveBeenCalledWith(
      expect.objectContaining({ credentials: { clientSecret: TARGET_SECRET_SENTINEL } }),
    );

    // ...and it did NOT come from the legacy inline-only path.
    expect(h.legacyGetConnector).not.toHaveBeenCalled();
  };

  /**
   * The refusal contract, asserted the same way on every path.
   *
   * `createConnectorSpy` is the load-bearing one and it is deliberately
   * stronger than "no secret was fetched". `ConnectorManager.getConnector()`
   * creates AND caches through the registry factory, and its cache is
   * per-process and keyed `${connectorKey}_${config.id}` — the exact key the
   * ~twenty downstream retrieval sites reconstruct. So a refusal that arrives
   * after the factory still leaves an instance behind for a configuration the
   * tenant was just refused, and the next caller hits it instead of creating
   * one. Asserting only `initialize()` was skipped would not catch that; A2.1's
   * plan text is explicit that the connector factory must not be reached.
   */
  const expectRefusedBeforeAnyConnectorExists = (
    h: ReturnType<typeof createManagedHarness>,
  ): void => {
    expect(h.getCredentials).not.toHaveBeenCalled();
    expect(h.legacyGetConnector).not.toHaveBeenCalled();
    expect(h.createConnectorSpy).not.toHaveBeenCalled();
    expect(h.manager.getConnectorStats().totalConnectors).toBe(0);
    expect(h.connectors.size).toBe(0);
  };

  describe('standard run path (executeStandardSync)', () => {
    it('asks ConnectorManager for the pair and runs against the brokered credentials', async () => {
      const h = createManagedHarness();

      const result = await h.service.runIntegrationForTenant('tenant-a', 'cfg-managed');

      expect(result.status).toBe('success');
      expectResolvedPair(h);
      // The connector the manager returned is the one actually read from.
      expect(h.sourceConnector().list).toHaveBeenCalledWith('Account', expect.anything());
    });

    it('refuses cross-tenant ownership before any secret is fetched, and never touches the legacy factory', async () => {
      const h = createManagedHarness({ registrations: { netsuite: ['someone-elses'] } });

      await expect(h.service.runIntegrationForTenant('tenant-a', 'cfg-managed')).rejects.toBeInstanceOf(
        CrossTenantCredentialError,
      );

      expect(h.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', 'netsuite', 'ns-1');
      expectRefusedBeforeAnyConnectorExists(h);
    });
  });

  describe('test path (testIntegration)', () => {
    it('asks ConnectorManager for the pair and tests the brokered-credential connectors', async () => {
      const h = createManagedHarness();

      const result = await h.service.testIntegrationForTenant('tenant-a', 'cfg-managed');

      expect(result.sourceConnection.isConnected).toBe(true);
      expect(result.targetConnection.isConnected).toBe(true);
      expectResolvedPair(h);
    });

    it('reports a cross-tenant refusal without fetching a secret or using the legacy factory', async () => {
      const h = createManagedHarness({ registrations: {} });

      const result = await h.service.testIntegrationForTenant('tenant-a', 'cfg-managed');

      expect(result.isValid).toBe(false);
      expectRefusedBeforeAnyConnectorExists(h);
    });
  });

  describe('single-record path (syncSingleRecord)', () => {
    it('asks ConnectorManager for the pair instead of refusing the managed reference', async () => {
      const h = createManagedHarness();

      // `read()` resolves null, so the sync reports a miss — irrelevant here.
      // What matters is that the path REACHED a manager-resolved connector.
      await h.service.syncSingleRecordForTenant('tenant-a', 'cfg-managed', 'rec-1');

      expectResolvedPair(h);
      expect(h.sourceConnector().read).toHaveBeenCalledWith('Account', 'rec-1');
    });

    it('refuses cross-tenant ownership before any secret is fetched', async () => {
      const h = createManagedHarness({ registrations: {} });

      await expect(
        h.service.syncSingleRecordForTenant('tenant-a', 'cfg-managed', 'rec-1'),
      ).rejects.toBeInstanceOf(CrossTenantCredentialError);

      expectRefusedBeforeAnyConnectorExists(h);
    });
  });

  describe('initialize path (initializeConnectorsForConfig)', () => {
    it('initializes an active managed configuration through ConnectorManager at boot', async () => {
      const h = createManagedHarness();

      await h.service.initialize();

      expectResolvedPair(h);
    });

    it('swallows a cross-tenant refusal into a log, as it always has, without fetching a secret', async () => {
      const h = createManagedHarness({ registrations: {} });

      await expect(h.service.initialize()).resolves.toBeUndefined();

      expectRefusedBeforeAnyConnectorExists(h);
    });
  });

  /**
   * The resolver reaches a real secret store, so its failures can carry secret
   * material in the message. Nothing in the client contract, the logs, the
   * scope logs, or a serialized result may echo it.
   */
  describe('a resolution failure never leaks secret material', () => {
    const LEAK_SENTINEL = 'super-secret-value-that-must-not-appear';
    const leakingCredentials = async (): Promise<never> => {
      throw new Error(`secret store rejected lookup for ${LEAK_SENTINEL}`);
    };

    const collectLogText = (h: ReturnType<typeof createManagedHarness>): string =>
      [
        ...(h.logger.error as jest.Mock).mock.calls,
        ...(h.logger.warn as jest.Mock).mock.calls,
        ...(h.logger.info as jest.Mock).mock.calls,
        ...(h.scopeLogger.error as jest.Mock).mock.calls,
        ...(h.scopeLogger.info as jest.Mock).mock.calls,
      ]
        .flat()
        .map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack ?? ''}` : JSON.stringify(arg)))
        .join(' | ');

    it('maps an unclassified resolver failure to a bounded error on the run path', async () => {
      const h = createManagedHarness({ getCredentialsImpl: leakingCredentials });

      const error = await h.service
        .runIntegrationForTenant('tenant-a', 'cfg-managed')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ServiceUnavailableAppError);
      expect(String((error as Error).message)).not.toContain(LEAK_SENTINEL);
      expect(JSON.stringify((error as AppError).toJSON?.() ?? {})).not.toContain(LEAK_SENTINEL);
      expect(collectLogText(h)).not.toContain(LEAK_SENTINEL);
    });

    /**
     * The masked error is deliberately value-free, so the log's `errorClass` is
     * the only diagnostic an operator gets. It must name the CAUSE — every
     * failure that reaches the boundary is a `ConnectorCredentialResolutionError`
     * by construction, so logging the wrapper's own name would be a constant
     * string carrying no information.
     */
    it('logs the CAUSE class, not the wrapper class, and still no value', async () => {
      class SecretStoreUnreachableError extends Error {
        constructor() {
          super(`secret store rejected lookup for ${LEAK_SENTINEL}`);
          this.name = 'SecretStoreUnreachableError';
        }
      }
      const h = createManagedHarness({
        getCredentialsImpl: async () => {
          throw new SecretStoreUnreachableError();
        },
      });

      await expect(h.service.runIntegrationForTenant('tenant-a', 'cfg-managed')).rejects.toBeInstanceOf(
        ServiceUnavailableAppError,
      );

      const loggedClasses = (h.logger.error as jest.Mock).mock.calls
        .flat()
        .map((arg) => (arg as { errorClass?: string })?.errorClass)
        .filter(Boolean);
      expect(loggedClasses).toContain('SecretStoreUnreachableError');
      expect(loggedClasses).not.toContain('ConnectorCredentialResolutionError');
      expect(collectLogText(h)).not.toContain(LEAK_SENTINEL);
    });

    it('keeps the sentinel out of the reported test-path result and its logs', async () => {
      const h = createManagedHarness({ getCredentialsImpl: leakingCredentials });

      const result = await h.service.testIntegrationForTenant('tenant-a', 'cfg-managed');

      expect(result.isValid).toBe(false);
      expect(JSON.stringify(result)).not.toContain(LEAK_SENTINEL);
      expect(collectLogText(h)).not.toContain(LEAK_SENTINEL);
    });

    it('keeps the sentinel out of the boot-path log, which swallows the failure', async () => {
      const h = createManagedHarness({ getCredentialsImpl: leakingCredentials });

      await h.service.initialize();

      expect(collectLogText(h)).not.toContain(LEAK_SENTINEL);
    });

    it('passes an already-bounded AppError through unchanged rather than re-wrapping it', async () => {
      // A cross-tenant refusal is a deliberate, value-free 403. Mapping it to a
      // generic 503 would turn an actionable authorization answer into an
      // "upstream is down" lie.
      const h = createManagedHarness({ registrations: {} });

      const error = await h.service
        .runIntegrationForTenant('tenant-a', 'cfg-managed')
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CrossTenantCredentialError);
      expect((error as AppError).statusCode).toBe(403);
    });
  });

  /**
   * Post-A2 replacement for the two padded-`Salesforce` pins this file used to
   * carry. Those asserted `Unsupported system type`, which came from
   * `IntegrationService`'s exact-match PascalCase `registryKeyMap` — a map the
   * standard paths no longer consult.
   *
   * The schema's `noSurroundingWhitespace` refusal
   * (`src/schemas/configurationSchemas.ts`) cited that runtime failure as its
   * justification, so the justification has to be restated, not deleted. The
   * new mechanism: `connectorKeyForSystem()` (the manager's projection) trims
   * and lowercases, so a padded type resolves a CONNECTOR fine — but
   * `ConnectorCredentialResolver` hands the UNTRIMMED `getSystemType(system)`
   * to the ownership registry and the secret store, and the registry
   * deliberately does not trim (`managedSystemRegistryKey`). The two keys
   * therefore disagree, and a padded managed reference can never execute a
   * sync with resolved credentials.
   *
   * Because the runtime failure is now a REFUSAL rather than a resolution
   * error, the schema rule is the PRIMARY guard and this is defense in depth,
   * not the UX. These pin the BEHAVIOR — no sync executes, no secret is
   * fetched — with the key disagreement as the explanation, so they survive a
   * refactor of either projection.
   *
   * WHICH refusal, specifically: the real
   * `TenantSettingSystemCredentialRegistry` is wired here (against a fake
   * settings reader holding only the clean registration) rather than a
   * hand-written ownership predicate, because the answer was not predictable
   * from reading the code. The registry carries an EXPLICIT untrimmed refusal,
   * but it guards `systemId`, and the padding here is on the system TYPE — a
   * padded `systemId` would hit that branch instead. What a padded TYPE
   * actually does is derive a settings key of
   * `integration.managed_systems. netsuite ` and miss the row stored under
   * `integration.managed_systems.netsuite`, so it lands on the generic
   * not-registered refusal. Same class, same status, different branch — and
   * only running it against the real registry could establish that.
   */
  describe('a padded managed system reference cannot execute a sync', () => {
    const paddedConfig = (): IntegrationConfig =>
      managedConfig({
        id: 'cfg-padded',
        sourceSystem: { type: ' netsuite ', systemId: 'ns-1', credentialSource: 'secret_manager' },
      });

    it('refuses to execute, and fetches no secret, though the tenant owns the clean spelling', async () => {
      // The registration is the CLEAN one — the only difference is the padding.
      const h = createManagedHarness({
        config: paddedConfig(),
        registrations: { netsuite: ['ns-1'], salesforce: ['sf-1'] },
      });

      const error = await h.service
        .runIntegrationForTenant('tenant-a', 'cfg-padded')
        .catch((e: unknown) => e);

      // Bounded and typed: a 403 refusal, not an unclassified 500.
      expect(error).toBeInstanceOf(CrossTenantCredentialError);
      expect((error as AppError).statusCode).toBe(403);
      // Nothing executed: no secret fetched under EITHER spelling, and no
      // connector was ever created for the padded configuration.
      expectRefusedBeforeAnyConnectorExists(h);
    });

    it('lands on the settings-key miss: the padded type looks up a key the clean registration cannot occupy', async () => {
      const h = createManagedHarness({
        config: paddedConfig(),
        registrations: { netsuite: ['ns-1'], salesforce: ['sf-1'] },
      });

      await expect(
        h.service.runIntegrationForTenant('tenant-a', 'cfg-padded'),
      ).rejects.toBeInstanceOf(CrossTenantCredentialError);

      // The resolver handed the ownership check the UNTRIMMED spelling...
      expect(h.assertSystemOwnedByTenant).toHaveBeenCalledWith('tenant-a', ' netsuite ', 'ns-1');
      // ...which the registry projected to a DIFFERENT settings key than the
      // one the clean registration lives under. That is the disagreement.
      expect(h.getStringStrict).toHaveBeenCalledWith('tenant-a', managedSystemRegistryKey(' netsuite '));
      expect(managedSystemRegistryKey(' netsuite ')).not.toBe(managedSystemRegistryKey('netsuite'));
      expect(h.getStringStrict).not.toHaveBeenCalledWith('tenant-a', managedSystemRegistryKey('netsuite'));
    });

    it('executes the SAME reference once the padding is gone, so padding is the cause', async () => {
      const h = createManagedHarness({ registrations: { netsuite: ['ns-1'], salesforce: ['sf-1'] } });

      const result = await h.service.runIntegrationForTenant('tenant-a', 'cfg-managed');

      expect(result.status).toBe('success');
      expect(h.getCredentials).toHaveBeenCalledWith('netsuite', 'ns-1');
      expect(h.getStringStrict).toHaveBeenCalledWith('tenant-a', managedSystemRegistryKey('netsuite'));
    });
  });

  /**
   * A2.2 keeps the ORDINARY inline configuration working unchanged — the
   * chokepoint is not a managed-only path, and the resolver's `inline` /
   * omitted / legacy-string rules are what preserve it.
   */
  describe('ordinary inline configurations are unaffected', () => {
    it('still initializes from the stored inline authentication', async () => {
      const inlineAuth = { type: 'api_key', credentials: { apiKey: 'inline-key' } };
      const { manager } = createStandardPathConnectorManager();
      const connectors = new Map<string, IConnector>();
      jest.spyOn(manager as any, 'createConnector').mockImplementation((...args: unknown[]) => {
        const systemType = args[0] as string;
        const connector = makeFakeConnector(systemType);
        connectors.set(systemType, connector);
        return connector;
      });

      const { observability } = createRecordingObservability();
      const { service, configService } = createIntegrationService({
        connectorManager: manager,
        observability,
      });
      const config = managedConfig({
        id: 'cfg-inline',
        sourceSystem: 'netsuite',
        targetSystem: 'salesforce',
        sourceAuthentication: inlineAuth,
        targetAuthentication: inlineAuth,
      });
      (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(config);

      const result = await service.runIntegrationForTenant('tenant-a', 'cfg-inline');

      expect(result.status).toBe('success');
      expect(connectors.get('netsuite')!.initialize).toHaveBeenCalledWith(inlineAuth);
      expect(connectors.get('salesforce')!.initialize).toHaveBeenCalledWith(inlineAuth);
    });
  });
  /**
   * A2.3 — cache identity under concurrency.
   *
   * `ConnectorManager`'s cache is per-process and, in production, so is the
   * manager: ONE instance serves every tenant. Its key is
   * `${connectorKey}_${config.id}`, so what keeps two tenants apart is the
   * configuration id, not any tenant dimension in the key itself. That is a
   * real invariant resting on an indirect property, and A2 is what made it
   * load-bearing: before A2 the standard paths never resolved a brokered
   * secret at all, so a shared connector could only ever have carried inline
   * credentials already present in the config. Now a cached connector can hold
   * a tenant's resolved secret, and handing it to another tenant would be a
   * cross-tenant credential disclosure.
   *
   * Driven CONCURRENTLY on purpose. `initializeConnectorsForConfig()` is async
   * at four separate points, so a sequential test would not exercise the
   * interleaving where one tenant's resolve completes while the other's
   * initialize is in flight.
   *
   * Deliberately a single shared manager, not one per service: a per-service
   * manager would make the test pass by construction and prove nothing.
   */
  describe('two tenants sharing one ConnectorManager (A2.3)', () => {
    const tenantConfig = (tenantId: string, configId: string): IntegrationConfig =>
      managedConfig({
        id: configId,
        tenantId,
        sourceSystem: { type: 'netsuite', systemId: `ns-${tenantId}`, credentialSource: 'secret_manager' },
        targetSystem: { type: 'salesforce', systemId: `sf-${tenantId}`, credentialSource: 'secret_manager' },
      });

    const secretFor = (tenantId: string, side: 'source' | 'target') => `${tenantId}-${side}-brokered-secret`;

    it('never hands one tenant a connector initialized with credentials belonging to the other', async () => {
      const createdConnectors: IConnector[] = [];
      const { manager } = createStandardPathConnectorManager({
        // Each tenant resolves its OWN distinct secret for each side.
        resolve: async (config, side) => ({
          type: 'oauth2',
          credentials: { clientSecret: secretFor(config.tenantId as string, side) },
        }),
        connectorFor: (connectorKey) => {
          // A FRESH instance per creation — the manager's cache, not this
          // factory, is what must decide when an instance is reused.
          const connector = makeFakeConnector(connectorKey);
          createdConnectors.push(connector);
          return connector;
        },
      });

      const buildTenant = (tenantId: string, configId: string) => {
        const config = tenantConfig(tenantId, configId);
        const { observability } = createRecordingObservability();
        const { service, configService } = createIntegrationService({
          connectorManager: manager,
          observability,
        });
        (configService.getConfigurationForTenant as jest.Mock).mockReturnValue(config);
        return () => service.runIntegrationForTenant(tenantId, configId);
      };

      const runA = buildTenant('tenant-a', 'cfg-a');
      const runB = buildTenant('tenant-b', 'cfg-b');

      const [resultA, resultB] = await Promise.all([runA(), runB()]);
      expect(resultA.status).toBe('success');
      expect(resultB.status).toBe('success');

      // Four distinct connectors: two sides x two configuration ids. A shared
      // instance across tenants would show up here as 2 or 3.
      expect(manager.getConnectorStats().totalConnectors).toBe(4);
      expect(new Set(createdConnectors).size).toBe(4);

      // No connector was initialized twice, and none ever saw a secret
      // belonging to the other tenant.
      for (const connector of createdConnectors) {
        const calls = (connector.initialize as jest.Mock).mock.calls;
        expect(calls).toHaveLength(1);
        const secret = calls[0][0].credentials.clientSecret as string;
        const owningTenant = secret.startsWith('tenant-a') ? 'tenant-a' : 'tenant-b';
        const foreign = owningTenant === 'tenant-a' ? 'tenant-b' : 'tenant-a';
        expect(JSON.stringify(calls)).not.toContain(foreign);
      }

      // And every expected secret was delivered exactly once — no side was
      // silently skipped, which would make the assertions above vacuous.
      const deliveredSecrets = createdConnectors
        .map((connector) => (connector.initialize as jest.Mock).mock.calls[0][0].credentials.clientSecret)
        .sort();
      expect(deliveredSecrets).toEqual(
        [
          secretFor('tenant-a', 'source'),
          secretFor('tenant-a', 'target'),
          secretFor('tenant-b', 'source'),
          secretFor('tenant-b', 'target'),
        ].sort(),
      );
    });
  });
});
