/**
 * Review round two, IMPORTANT 1 (2026-07-27 NetSuite serialized-asset sync
 * plan): `IntegrationExecutor` is a SEPARATE, parallel execution engine from
 * `IntegrationService` — it never went through that class's
 * `executionProfile` dispatch (Task 8). Without an explicit refusal here,
 * `executeSync`/`syncSingleRecord` would run the generic per-record loop
 * against a `netsuite_serialized_asset` config: a generic `create`/`update`
 * (decision 4 prohibits read-then-create), no decision-7 readiness re-check,
 * and a serial number reaching wherever the generic path logs/writes it.
 *
 * `IntegrationOrchestrator`'s two entry points forward straight into
 * `IntegrationExecutor.executeSync`/`.syncSingleRecord`, so gating here also
 * covers that (currently orphaned/unrouted) path transitively.
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/uuid', () => ({ uuidv4: () => 'test-uuid-1234' }));
jest.mock('p-limit', () => {
  return () => (fn: () => Promise<any>) => fn();
});

import { IntegrationExecutor } from '../../../../src/services/integration/IntegrationExecutor';
import { SerializedAssetExecutionNotSupportedError } from '../../../../src/errors/SerializedAssetExecutionNotSupportedError';
import { createMockOwnershipResolver, createMockAuditService } from '../../../governanceTestUtils';
import type { IntegrationConfig } from '../../../../src/types';
import type { SerializedAssetProfileDraftConfig } from '../../../../src/types/serializedAsset';

function makeExecutor(): IntegrationExecutor {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as any;
  const transformationEngine = { transformRecord: jest.fn().mockResolvedValue({}) } as any;
  const connectorManager = {
    getConnector: jest.fn().mockRejectedValue(new Error('getConnector should never be called for a refused profile')),
  } as any;
  const statusManager = {} as any;
  const observability = {
    createScope: jest.fn().mockReturnValue({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }),
  } as any;
  return new IntegrationExecutor(
    logger,
    transformationEngine,
    connectorManager,
    statusManager,
    observability,
    createMockOwnershipResolver() as any,
    createMockAuditService() as any,
    { enqueue: jest.fn().mockResolvedValue('noop-queue-id') } as any,
  );
}

function makeSpecializedConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  const executionProfileConfig: SerializedAssetProfileDraftConfig = {
    executionProfile: 'netsuite_serialized_asset',
    productExternalIdField: 'NetSuite_Item_Id__c',
    assetExternalIdField: 'NetSuite_Inventory_Number_Id__c',
    serialNumberTargetField: 'SerialNumber',
    productReferenceTargetField: 'Product2Id',
  };
  return {
    id: 'cfg-sa-executor',
    tenantId: 'tenant-sa',
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

describe('IntegrationExecutor refuses the netsuite_serialized_asset profile', () => {
  it('executeSync throws SerializedAssetExecutionNotSupportedError before ever touching a connector', async () => {
    const executor = makeExecutor();
    const config = makeSpecializedConfig();

    await expect(executor.executeSync(config)).rejects.toThrow(SerializedAssetExecutionNotSupportedError);
    await expect(executor.executeSync(config)).rejects.toThrow('does not support batch sync execution');

    const connectorManager = (executor as any).connectorManager;
    expect(connectorManager.getConnector).not.toHaveBeenCalled();
  });

  it('syncSingleRecord throws SerializedAssetExecutionNotSupportedError before ever touching a connector', async () => {
    const executor = makeExecutor();
    const config = makeSpecializedConfig();

    await expect(executor.syncSingleRecord(config, 'unit-1')).rejects.toThrow(
      SerializedAssetExecutionNotSupportedError,
    );
    await expect(executor.syncSingleRecord(config, 'unit-1')).rejects.toThrow(
      'does not support single-record sync',
    );

    const connectorManager = (executor as any).connectorManager;
    expect(connectorManager.getConnector).not.toHaveBeenCalled();
  });

  it('the thrown error is NOT swallowed into a generic failed SyncResult (propagates as a real exception)', async () => {
    const executor = makeExecutor();
    const config = makeSpecializedConfig();

    // A genuine rejection (not a resolved { status: 'failed' } object) proves
    // the guard runs before the method's own try/catch, which would otherwise
    // convert any thrown error into a soft 'failed' SyncResult and hide the
    // typed refusal from callers doing `instanceof` checks.
    let caught: unknown;
    try {
      await executor.executeSync(config);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SerializedAssetExecutionNotSupportedError);
  });
});
