import 'reflect-metadata';
import { IntegrationService } from '../../../src/services/IntegrationService';
import {
  createMockOutboundGovernanceService,
  createMockOwnershipResolver,
  createMockAuditService,
  createMockApprovalQueueService,
} from '../../governanceTestUtils';
import type { ConnectorManager } from '../../../src/services/integration/ConnectorManager';
import type { SerializedAssetSyncService } from '../../../src/services/serializedAsset/SerializedAssetSyncService';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';
import { SerializedAssetExecutionNotSupportedError } from '../../../src/errors/SerializedAssetExecutionNotSupportedError';
import type { IntegrationConfig } from '../../../src/types';
import type { SerializedAssetProfileDraftConfig } from '../../../src/types/serializedAsset';

/**
 * Task 8 (2026-07-27 NetSuite serialized-asset sync plan): dispatch of the
 * `netsuite_serialized_asset` execution profile out of `executeSync`, without
 * changing standard (non-specialized) execution.
 *
 * Everything shared (config resolution, tenant isolation, active/running-state
 * checks, status tracking, observability) is exercised through the public
 * `runIntegration`/`runIntegrationForTenant` entry points so these tests prove
 * the REAL dispatch path, not a hand-invoked private method.
 */

const TENANT = 'tenant-sa';
const OTHER_TENANT = 'tenant-other';
const CONFIG_ID = 'cfg-sa-1';

const ASSET_EXTERNAL_ID_FIELD = 'NetSuite_Inventory_Number_Id__c';
const PRODUCT_EXTERNAL_ID_FIELD = 'NetSuite_Item_Id__c';

function makeSpecializedConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  const executionProfileConfig: SerializedAssetProfileDraftConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: PRODUCT_EXTERNAL_ID_FIELD,
    assetExternalIdField: ASSET_EXTERNAL_ID_FIELD,
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
  };
  return {
    id: CONFIG_ID,
    tenantId: TENANT,
    name: 'NetSuite Serialized Asset Sync',
    sourceSystem: 'netsuite',
    targetSystem: 'Salesforce',
    sourceEntity: 'inventorynumber',
    targetEntity: 'Asset',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [],
    transformationRules: [],
    executionProfile: 'netsuite_serialized_asset',
    executionProfileConfig,
    ...overrides,
  } as IntegrationConfig;
}

function makeStandardConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-std-1',
    tenantId: TENANT,
    name: 'Standard Customer Sync',
    sourceSystem: 'NetSuite',
    targetSystem: 'Salesforce',
    sourceEntity: 'customer',
    targetEntity: 'account',
    syncDirection: 'source_to_target',
    syncMode: 'manual',
    isActive: true,
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  } as IntegrationConfig;
}

function makeCapableSalesforceConnector(overrides: Record<string, unknown> = {}) {
  return {
    systemType: 'salesforce',
    systemId: 'salesforce-test',
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
    getSystemInfo: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'created' }),
    read: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'updated' }),
    delete: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
    upsert: jest.fn().mockResolvedValue({ id: 'upserted' }),
    describeSObject: jest.fn().mockResolvedValue({
      name: 'Asset',
      createable: true,
      updateable: true,
      queryable: true,
      fields: [],
    }),
    findProduct2ByExternalId: jest.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeIncapableConnector(overrides: Record<string, unknown> = {}) {
  return {
    systemType: 'salesforce',
    systemId: 'salesforce-test',
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
    getSystemInfo: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'created' }),
    read: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'updated' }),
    delete: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
    // Deliberately no describeSObject / findProduct2ByExternalId.
    ...overrides,
  };
}

function makeNetSuiteConnector(overrides: Record<string, unknown> = {}) {
  return {
    systemType: 'netsuite',
    systemId: 'netsuite-test',
    initialize: jest.fn().mockResolvedValue(undefined),
    authenticate: jest.fn().mockResolvedValue(true),
    testConnection: jest.fn().mockResolvedValue({ isConnected: true }),
    getSystemInfo: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({ id: 'created' }),
    read: jest.fn().mockResolvedValue(null),
    update: jest.fn().mockResolvedValue({ id: 'updated' }),
    delete: jest.fn().mockResolvedValue(true),
    list: jest.fn().mockResolvedValue([]),
    search: jest.fn().mockResolvedValue([]),
    bulkCreate: jest.fn(),
    bulkUpdate: jest.fn(),
    bulkDelete: jest.fn(),
    ...overrides,
  };
}

interface Harness {
  service: IntegrationService;
  configService: {
    getConfiguration: jest.Mock;
    getConfigurationForTenant: jest.Mock;
    getAllConfigurations: jest.Mock;
    loadConfigurations: jest.Mock;
    validateConfiguration: jest.Mock;
  };
  transformationEngine: { transform: jest.Mock };
  connectorManager: Pick<ConnectorManager, 'getConnector' | 'initializeConnectorsForConfig'> & {
    getConnector: jest.Mock;
    initializeConnectorsForConfig: jest.Mock;
  };
  serializedAssetSyncService: Pick<SerializedAssetSyncService, 'run'> & { run: jest.Mock };
  logger: { info: jest.Mock; error: jest.Mock; warn: jest.Mock; debug: jest.Mock };
}

function makeHarness(): Harness {
  const logger = {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  };

  const transformationEngine = {
    transform: jest.fn().mockResolvedValue({
      success: true,
      transformedData: { id: '1', fields: {} },
      errors: [],
      warnings: [],
    }),
  };

  const configService = {
    getConfiguration: jest.fn(),
    getConfigurationForTenant: jest.fn(),
    getAllConfigurations: jest.fn().mockReturnValue([]),
    loadConfigurations: jest.fn().mockResolvedValue(undefined),
    validateConfiguration: jest.fn(),
  };

  const authService = { authenticate: jest.fn() };

  const observabilityService = {
    createScope: jest.fn().mockReturnValue({
      logger,
      metrics: {
        incrementActiveIntegrations: jest.fn(),
        decrementActiveIntegrations: jest.fn(),
        recordIntegrationRun: jest.fn(),
      },
    }),
  };

  const connectorManager = {
    getConnector: jest.fn(),
    initializeConnectorsForConfig: jest.fn().mockResolvedValue(undefined),
  };

  const serializedAssetSyncService = {
    run: jest.fn(),
  };

  const service = new IntegrationService(
    logger as any,
    transformationEngine as any,
    configService as any,
    authService as any,
    observabilityService as any,
    createMockOutboundGovernanceService() as any,
    createMockOwnershipResolver() as any,
    createMockAuditService() as any,
    createMockApprovalQueueService() as any,
    connectorManager as any,
    serializedAssetSyncService as any,
  );

  return {
    service,
    configService: configService as any,
    transformationEngine,
    connectorManager: connectorManager as any,
    serializedAssetSyncService: serializedAssetSyncService as any,
    logger,
  };
}

function executedResult(overrides: Record<string, unknown> = {}) {
  return {
    mode: 'executed' as const,
    unitsRead: 3,
    upserted: 2,
    deferred: 1,
    quarantined: 0,
    failed: 0,
    deferredRecovered: 0,
    retriesAttempted: 0,
    governanceRejections: 0,
    duplicatesCollapsed: 0,
    truncated: false,
    failures: [],
    ...overrides,
  };
}

describe('IntegrationService serialized-asset dispatch', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------
  // Constructor fail-closed checks
  // ---------------------------------------------------------------------

  describe('constructor dependency requirements', () => {
    it('throws when SerializedAssetSyncService is not provided', () => {
      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
      expect(() => new IntegrationService(
        logger as any,
        { transform: jest.fn() } as any,
        { getAllConfigurations: jest.fn().mockReturnValue([]) } as any,
        { authenticate: jest.fn() } as any,
        undefined,
        createMockOutboundGovernanceService() as any,
        createMockOwnershipResolver() as any,
        createMockAuditService() as any,
        createMockApprovalQueueService() as any,
        { getConnector: jest.fn(), initializeConnectorsForConfig: jest.fn() } as any,
        undefined,
      )).toThrow('SerializedAssetSyncService is required for IntegrationService specialized-profile dispatch');
    });

    it('throws when ConnectorManager is not provided', () => {
      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
      expect(() => new IntegrationService(
        logger as any,
        { transform: jest.fn() } as any,
        { getAllConfigurations: jest.fn().mockReturnValue([]) } as any,
        { authenticate: jest.fn() } as any,
        undefined,
        createMockOutboundGovernanceService() as any,
        createMockOwnershipResolver() as any,
        createMockAuditService() as any,
        createMockApprovalQueueService() as any,
        undefined,
        { run: jest.fn() } as any,
      )).toThrow('ConnectorManager is required for IntegrationService specialized-profile dispatch');
    });
  });

  // ---------------------------------------------------------------------
  // Standard-path regression: byte-identical behavior
  // ---------------------------------------------------------------------

  describe('standard execution (unaffected)', () => {
    it('runs the generic per-record loop for an undefined executionProfile: transform + connector.create called, specialized service never touched', async () => {
      const { service, configService, transformationEngine, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeStandardConfig();
      configService.getConfiguration.mockReturnValue(config);

      const sourceConnector = makeNetSuiteConnector({
        list: jest.fn().mockResolvedValue([{ id: '1', fields: { name: 'Acme' }, metadata: {} }]),
      });
      const targetConnector = makeCapableSalesforceConnector();

      // A2 routes the standard paths through ConnectorManager, so the pair is
      // served by the manager double (keyed by the projected connector key)
      // rather than by overriding the service's private getConnector. That
      // private path is what must now go UNUSED, so it is spied on bare.
      connectorManager.getConnector.mockImplementation(async (connectorKey: string) => {
        if (connectorKey === 'netsuite') return sourceConnector;
        if (connectorKey === 'salesforce') return targetConnector;
        throw new Error(`unexpected connectorKey ${connectorKey}`);
      });
      const legacyGetConnector = jest.spyOn(service as any, 'getConnector');

      const result = await service.runIntegration(config.id);

      expect(result.status).toBe('success');
      expect(transformationEngine.transform).toHaveBeenCalledTimes(1);
      expect(targetConnector.create).toHaveBeenCalledTimes(1);
      // Inverted by A2: the standard path is now the manager's caller too, and
      // the legacy inline-only factory is what must stay untouched.
      expect(connectorManager.initializeConnectorsForConfig).toHaveBeenCalledWith(config);
      expect(legacyGetConnector).not.toHaveBeenCalled();
      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();

    });

    it("runs the generic per-record loop for an explicit 'standard' executionProfile", async () => {
      const { service, configService, transformationEngine, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeStandardConfig({ executionProfile: 'standard' });
      configService.getConfiguration.mockReturnValue(config);

      const sourceConnector = makeNetSuiteConnector({
        list: jest.fn().mockResolvedValue([{ id: '1', fields: { name: 'Acme' }, metadata: {} }]),
      });
      const targetConnector = makeCapableSalesforceConnector();

      // A2 routes the standard paths through ConnectorManager, so the pair is
      // served by the manager double (keyed by the projected connector key)
      // rather than by overriding the service's private getConnector. That
      // private path is what must now go UNUSED, so it is spied on bare.
      connectorManager.getConnector.mockImplementation(async (connectorKey: string) => {
        if (connectorKey === 'netsuite') return sourceConnector;
        if (connectorKey === 'salesforce') return targetConnector;
        throw new Error(`unexpected connectorKey ${connectorKey}`);
      });
      const legacyGetConnector = jest.spyOn(service as any, 'getConnector');

      const result = await service.runIntegration(config.id);

      expect(result.status).toBe('success');
      expect(transformationEngine.transform).toHaveBeenCalledTimes(1);
      expect(targetConnector.create).toHaveBeenCalledTimes(1);
      // Same inversion as the undefined-profile case above: an explicit
      // 'standard' profile is the manager's caller too, and the legacy
      // inline-only factory must stay untouched.
      expect(connectorManager.initializeConnectorsForConfig).toHaveBeenCalledWith(config);
      expect(legacyGetConnector).not.toHaveBeenCalled();
      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();

    });
  });

  // ---------------------------------------------------------------------
  // Specialized dispatch
  // ---------------------------------------------------------------------

  describe('netsuite_serialized_asset dispatch', () => {
    it('dispatches to SerializedAssetSyncService.run via ConnectorManager-resolved connectors, and never touches transformation or the standard connector path', async () => {
      const { service, configService, transformationEngine, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);

      const sourceConnector = makeNetSuiteConnector();
      const targetConnector = makeCapableSalesforceConnector();
      connectorManager.getConnector.mockImplementation(async (systemType: string) => {
        if (systemType === 'netsuite') return sourceConnector;
        if (systemType === 'salesforce') return targetConnector;
        throw new Error(`unexpected systemType ${systemType}`);
      });
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      const getConnectorSpy = jest.spyOn(service as any, 'getConnector');

      const result = await service.runIntegrationForTenant(TENANT, config.id, {});

      expect(serializedAssetSyncService.run).toHaveBeenCalledTimes(1);
      const callArgs = serializedAssetSyncService.run.mock.calls[0][0];
      expect(callArgs.config).toBe(config);
      expect(callArgs.sourceConnector).toBe(sourceConnector);
      expect(callArgs.targetConnector).toBe(targetConnector);
      expect(callArgs.actor.tenantId).toBe(TENANT);
      expect(callArgs.actor.userId).toBe('__system__');
      expect(typeof callArgs.actor.correlationId).toBe('string');

      expect(connectorManager.getConnector).toHaveBeenCalledWith('netsuite', `netsuite_${config.id}`);
      expect(connectorManager.getConnector).toHaveBeenCalledWith('salesforce', `salesforce_${config.id}`);

      // Never falls through to the standard per-record path.
      expect(transformationEngine.transform).not.toHaveBeenCalled();
      expect(targetConnector.create).not.toHaveBeenCalled();
      expect(getConnectorSpy).not.toHaveBeenCalled();

      expect(result.recordsProcessed).toBe(3);
      expect(result.recordsSuccessful).toBe(2);
      expect(result.status).toBe('success');
      expect(result.metadata?.serializedAssetResult).toEqual(executedResult());

    });

    it('never lets a caller-supplied actorUserId/correlationId reach guardedWrite via SerializedAssetSyncService.run (review round two, IMPORTANT 2)', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      await service.runIntegrationForTenant(TENANT, config.id, {
        actorUserId: 'attacker',
        correlationId: 'evil',
      });

      const callArgs = serializedAssetSyncService.run.mock.calls[0][0];
      expect(callArgs.actor.userId).toBe(SYSTEM_IDENTITY.userId);
      expect(callArgs.actor.userId).not.toBe('attacker');
      expect(callArgs.actor.correlationId).not.toBe('evil');
      expect(typeof callArgs.actor.correlationId).toBe('string');
      // tenantId is the one caller-adjacent value that IS trusted, because it
      // comes from the already tenant-scope-resolved config, never from options.
      expect(callArgs.actor.tenantId).toBe(TENANT);
    });

    it.each([
      ['plain string', 'attacker'],
      ['empty string', ''],
      ['__proto__ key', '__proto__'],
      ['constructor key', 'constructor'],
      ['object-shaped value', { toString: () => 'attacker' }],
      ['numeric-looking string', '0'],
    ])('ignores a body-shaped actorUserId variant: %s', async (_label, maliciousValue) => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      await service.runIntegrationForTenant(TENANT, config.id, {
        actorUserId: maliciousValue as unknown as string,
      });

      const callArgs = serializedAssetSyncService.run.mock.calls[0][0];
      expect(callArgs.actor.userId).toBe(SYSTEM_IDENTITY.userId);
    });

    it('always forces forceDeferredRetry to false regardless of caller-supplied options (decision 11 trust boundary)', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      await service.runIntegrationForTenant(TENANT, config.id, {
        forceDeferredRetry: true,
      } as any);

      const callArgs = serializedAssetSyncService.run.mock.calls[0][0];
      expect(callArgs.options.forceDeferredRetry).toBe(false);
    });

    it('rejects (before calling run) when the resolved target connector lacks Salesforce serialized-asset read capabilities', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeIncapableConnector(),
      );

      await expect(service.runIntegrationForTenant(TENANT, config.id, {})).rejects.toThrow(
        'does not provide the Salesforce serialized-asset read capabilities',
      );

      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });

    it('maps a previewed (dryRun) specialized result into a SyncResult-shaped envelope', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue({
        mode: 'previewed',
        unitsRead: 5,
        wouldUpsert: 4,
        wouldDefer: 1,
        quarantined: 0,
        failed: 0,
        wouldRecoverDeferred: 0,
        retriesPreviewed: 0,
        duplicatesCollapsed: 0,
        truncated: false,
        failures: [],
      });

      const result = await service.runIntegrationForTenant(TENANT, config.id, { dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.recordsSuccessful).toBe(4);
      expect(result.recordsProcessed).toBe(5);
      expect(result.status).toBe('success');
    });

    // Minor review finding (round two): M8/M10 mutation survival — 'status'
    // was previously never exercised as anything but 'success', and 'errors'
    // was never asserted at all. Both feed updateIntegrationStatus's
    // successCount/errorCount and the recordIntegrationRun metric label, so a
    // partially-failed or fully-failed run would have been silently reported
    // as clean.
    it("maps a partially-failed executed result to status 'partial' with populated error categories", async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult({
        unitsRead: 3,
        upserted: 1,
        failed: 2,
        failures: [
          { unitRef: 'ref-1', category: 'write_failed' },
          { unitRef: 'ref-2', category: 'governance_rejected' },
        ],
      }));

      const result = await service.runIntegrationForTenant(TENANT, config.id, {});

      expect(result.status).toBe('partial');
      expect(result.success).toBe(false);
      expect(result.recordsSuccessful).toBe(1);
      expect(result.recordsFailed).toBe(2);
      expect(result.errors).toEqual(['write_failed', 'governance_rejected']);
    });

    it("maps a fully-failed executed result (zero upserts) to status 'failed'", async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult({
        unitsRead: 2,
        upserted: 0,
        failed: 2,
        failures: [
          { unitRef: 'ref-1', category: 'write_failed' },
          { unitRef: 'ref-2', category: 'write_failed' },
        ],
      }));

      const result = await service.runIntegrationForTenant(TENANT, config.id, {});

      expect(result.status).toBe('failed');
      expect(result.success).toBe(false);
      expect(result.recordsSuccessful).toBe(0);
      expect(result.recordsFailed).toBe(2);
      expect(result.errors).toEqual(['write_failed', 'write_failed']);
    });

    it('does not dispatch to the specialized service for a cross-tenant config (tenant isolation runs before dispatch)', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      // Tenant-scoped lookup: a different tenant's request must not resolve
      // this configuration at all.
      configService.getConfigurationForTenant.mockReturnValue(undefined);

      await expect(service.runIntegrationForTenant(OTHER_TENANT, config.id, {})).rejects.toThrow(
        `Configuration ${config.id} not found`,
      );

      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });

    it('does not dispatch to the specialized service for an inactive config', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig({ isActive: false });
      configService.getConfigurationForTenant.mockReturnValue(config);

      await expect(service.runIntegrationForTenant(TENANT, config.id, {})).rejects.toThrow(
        `Configuration ${config.id} is not active`,
      );

      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------
  // Review round two, IMPORTANT 1: the second, undispatched execution
  // surface reachable from `POST /api/integrations/:id/sync-record` via
  // `syncSingleRecordForTenant`/`syncSingleRecord`.
  // ---------------------------------------------------------------------

  describe('single-record sync refuses the netsuite_serialized_asset profile', () => {
    it('throws SerializedAssetExecutionNotSupportedError and never touches the standard connector/transform path for a specialized config', async () => {
      const { service, configService, transformationEngine } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);

      const getConnectorSpy = jest.spyOn(service as any, 'getConnector');

      await expect(
        service.syncSingleRecordForTenant(TENANT, config.id, 'unit-1'),
      ).rejects.toThrow(SerializedAssetExecutionNotSupportedError);
      await expect(
        service.syncSingleRecordForTenant(TENANT, config.id, 'unit-1'),
      ).rejects.toThrow('does not support single-record sync');

      // Never reads config.sourceAuthentication/.targetAuthentication inline,
      // never transforms, never reaches a connector write.
      expect(getConnectorSpy).not.toHaveBeenCalled();
      expect(transformationEngine.transform).not.toHaveBeenCalled();

    });

    it('still runs the generic single-record path for a standard (non-specialized) config', async () => {
      const { service, configService, transformationEngine, connectorManager } = makeHarness();
      const config = makeStandardConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);

      const sourceConnector = makeNetSuiteConnector({
        read: jest.fn().mockResolvedValue({ id: 'unit-1', fields: { name: 'Acme' }, metadata: {} }),
      });
      const targetConnector = makeCapableSalesforceConnector({ read: jest.fn().mockResolvedValue(null) });
      // A2 routes the standard paths through ConnectorManager, so the pair is
      // served by the manager double (keyed by the projected connector key)
      // rather than by overriding the service's private getConnector. That
      // private path is what must now go UNUSED, so it is spied on bare.
      connectorManager.getConnector.mockImplementation(async (connectorKey: string) => {
        if (connectorKey === 'netsuite') return sourceConnector;
        if (connectorKey === 'salesforce') return targetConnector;
        throw new Error(`unexpected connectorKey ${connectorKey}`);
      });
      const legacyGetConnector = jest.spyOn(service as any, 'getConnector');

      const result = await service.syncSingleRecordForTenant(TENANT, config.id, 'unit-1');

      expect(result.status).toBe('success');
      expect(transformationEngine.transform).toHaveBeenCalledTimes(1);
      expect(targetConnector.create).toHaveBeenCalledTimes(1);
      // The single-record path shares `resolveStandardConnectorPair`, so the
      // same inversion holds here: initialization runs through the manager and
      // the legacy inline-only factory stays untouched.
      expect(connectorManager.initializeConnectorsForConfig).toHaveBeenCalledWith(config);
      expect(legacyGetConnector).not.toHaveBeenCalled();

    });
  });

  // ---------------------------------------------------------------------
  // Task 9 (2026-07-27 NetSuite serialized-asset sync plan): the ONLY
  // production path allowed to set `forceDeferredRetry: true`. Proven at
  // this layer (not just the route layer) because the trust boundary the
  // review flagged is exactly here — `normalizeSerializedAssetOptions`
  // unconditionally forces the flag to `false` for the ordinary run
  // dispatch, so this method must be a genuinely SEPARATE caller of
  // `SerializedAssetSyncService.run()`, never routed through
  // `runIntegrationForTenant`'s options bag.
  // ---------------------------------------------------------------------

  describe('retryDeferredSerializedAssetsForTenant (Task 9 forced retry)', () => {
    it('sets forceDeferredRetry: true and forwards the verified actor, never the SYSTEM_IDENTITY default', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      const result = await service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, {
        userId: 'verified-admin-1',
        correlationId: 'corr-1',
      });

      expect(serializedAssetSyncService.run).toHaveBeenCalledTimes(1);
      const callArgs = serializedAssetSyncService.run.mock.calls[0][0];
      expect(callArgs.options.forceDeferredRetry).toBe(true);
      expect(callArgs.actor.userId).toBe('verified-admin-1');
      expect(callArgs.actor.userId).not.toBe(SYSTEM_IDENTITY.userId);
      expect(callArgs.actor.correlationId).toBe('corr-1');
      expect(callArgs.actor.tenantId).toBe(TENANT);
      expect(result.status).toBe('success');
    });

    it('never forces forceDeferredRetry back to false the way the ordinary run dispatch does (decision 11 trust boundary honored, not defeated)', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      serializedAssetSyncService.run.mockResolvedValue(executedResult());

      await service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, {
        userId: 'verified-admin-1',
        correlationId: 'corr-1',
      });
      // The ordinary path, called separately, must still force false — proves
      // the two paths are genuinely independent, not one silently mutated.
      await service.runIntegrationForTenant(TENANT, config.id, { forceDeferredRetry: true } as any);

      expect(serializedAssetSyncService.run.mock.calls[0][0].options.forceDeferredRetry).toBe(true);
      expect(serializedAssetSyncService.run.mock.calls[1][0].options.forceDeferredRetry).toBe(false);
    });

    it('rejects a config that does not use the netsuite_serialized_asset profile', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeStandardConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);

      await expect(
        service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, { userId: 'u1', correlationId: 'c1' }),
      ).rejects.toThrow('does not use the netsuite_serialized_asset execution profile');

      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });

    it('rejects (404) a cross-tenant configuration id without dispatching', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(undefined);
      // Review IMPORTANT 2: without this, a mutation that drops the tenantId
      // argument from `resolveConfiguration(configId, tenantId)` (falling
      // through to the tenantless `getConfiguration` escape hatch) is
      // INVISIBLE here, because the default (unconfigured) mock also returns
      // undefined — the mutated code coincidentally produces the same
      // NotFoundError for the wrong reason. Configuring the tenantless
      // fallback to return the config makes the two code paths diverge
      // observably, and the explicit call assertions below pin exactly which
      // one ran regardless of what either mock returns.
      configService.getConfiguration.mockReturnValue(config);

      await expect(
        service.retryDeferredSerializedAssetsForTenant(OTHER_TENANT, config.id, { userId: 'u1', correlationId: 'c1' }),
      ).rejects.toThrow(`Configuration ${config.id} not found`);

      expect(configService.getConfigurationForTenant).toHaveBeenCalledWith(OTHER_TENANT, config.id);
      expect(configService.getConfiguration).not.toHaveBeenCalled();
      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });

    // Review IMPORTANT 2, explicit cross-tenant proof: a realistic
    // deployment-global store where the tenantless `getConfiguration` escape
    // hatch is NOT tenant-scoped and would WRONGLY return tenant-a's config
    // for any caller if it were ever consulted here. Simulates exactly the
    // scenario the reviewer's mutation probe demonstrated (dropping the
    // tenantId argument makes `resolveConfiguration` fall through to this
    // escape hatch, returning tenant-a's config to a tenant-b admin).
    it('proves tenant scoping under mutation: a tenant-b admin never dispatches tenant-a\'s configuration, even when the tenantless fallback would wrongly resolve it', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig(); // owned by TENANT ('tenant-sa')
      configService.getConfigurationForTenant.mockImplementation(
        (queriedTenantId: string) => (queriedTenantId === TENANT ? config : undefined),
      );
      configService.getConfiguration.mockReturnValue(config);

      await expect(
        service.retryDeferredSerializedAssetsForTenant(OTHER_TENANT, config.id, { userId: 'u1', correlationId: 'c1' }),
      ).rejects.toThrow(`Configuration ${config.id} not found`);

      expect(configService.getConfigurationForTenant).toHaveBeenCalledWith(OTHER_TENANT, config.id);
      expect(configService.getConfiguration).not.toHaveBeenCalled();
      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });

    it('rejects a second concurrent call for the same configuration with a conflict', async () => {
      const { service, configService, connectorManager, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig();
      configService.getConfigurationForTenant.mockReturnValue(config);
      connectorManager.getConnector.mockImplementation(async (systemType: string) =>
        systemType === 'netsuite' ? makeNetSuiteConnector() : makeCapableSalesforceConnector(),
      );
      let resolveRun!: (value: unknown) => void;
      serializedAssetSyncService.run.mockReturnValue(new Promise(resolve => { resolveRun = resolve; }));

      const first = service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, { userId: 'u1', correlationId: 'c1' });
      await expect(
        service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, { userId: 'u2', correlationId: 'c2' }),
      ).rejects.toThrow('already running');

      resolveRun(executedResult());
      await first;
    });

    it('rejects an inactive configuration', async () => {
      const { service, configService, serializedAssetSyncService } = makeHarness();
      const config = makeSpecializedConfig({ isActive: false });
      configService.getConfigurationForTenant.mockReturnValue(config);

      await expect(
        service.retryDeferredSerializedAssetsForTenant(TENANT, config.id, { userId: 'u1', correlationId: 'c1' }),
      ).rejects.toThrow(`Configuration ${config.id} is not active`);

      expect(serializedAssetSyncService.run).not.toHaveBeenCalled();
    });
  });
});
