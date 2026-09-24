/**
 * Regression test for a defect introduced by Prerequisite PR B (2026-07-27
 * NetSuite serialized-asset sync plan): ConnectorManager.initializeConnectorsForConfig
 * started caching/creating connectors under connectorKeyForSystem()'s
 * registry-key projection instead of the raw config spelling, but
 * IntegrationExecutor's three getConnector() call-site pairs (executeSync,
 * syncSingleRecord, testSync) still built their cache key from the raw
 * getSystemType() output via a duplicate local helper. For any mixed-case
 * config spelling (e.g. 'NetSuite', 'Salesforce' — all 8 on-disk
 * integrations/*.json configs at review time), the executor silently
 * retrieved/created a SECOND, never-initialized connector instance instead of
 * the one ConnectorManager had already cached and initialized.
 *
 * The existing IntegrationExecutorExtended.test.ts suite mocks ConnectorManager
 * wholesale (`{ getConnector: jest.fn() }`), so it can never catch a cache-key
 * mismatch — the mock hands back a canned connector regardless of what key
 * it's called with. This suite wires IntegrationExecutor to a REAL
 * ConnectorManager (same registry, same cache Map) so a divergent key
 * surfaces as a real second connector entry / different instance.
 */
import 'reflect-metadata';

jest.mock('../../../../src/utils/uuid', () => ({ uuidv4: () => 'test-uuid-1234' }));
jest.mock('p-limit', () => {
  return () => (fn: () => Promise<any>) => fn();
});

import { IntegrationExecutor } from '../../../../src/services/integration/IntegrationExecutor';
import { ConnectorManager } from '../../../../src/services/integration/ConnectorManager';
import { Logger } from '../../../../src/utils/Logger';
import { AuthService } from '../../../../src/services/AuthService';
import type { OutboundGovernanceService } from '../../../../src/services/governance/OutboundGovernanceService';
import type { ConnectorCredentialResolver } from '../../../../src/services/integration/ConnectorCredentialResolver';
import type { IntegrationConfig } from '../../../../src/types';
import { createMockOwnershipResolver, createMockAuditService } from '../../../governanceTestUtils';

function makeRealConnectorManager(): ConnectorManager {
  const logger = new Logger('IntegrationExecutor.connectorKeyConsistency.test');
  const authService = new AuthService(logger);
  const outboundGovernance = {} as OutboundGovernanceService;
  const credentialResolver: ConnectorCredentialResolver = { resolve: jest.fn().mockResolvedValue(undefined) };
  return new ConnectorManager(logger, authService, outboundGovernance, credentialResolver);
}

function makeExecutor(connectorManager: ConnectorManager): IntegrationExecutor {
  const transformationEngine = { transformRecord: jest.fn().mockResolvedValue({}) } as any;
  const statusManager = {} as any;
  const scopeLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const observability = { createScope: jest.fn().mockReturnValue({ logger: scopeLogger }) } as any;
  return new IntegrationExecutor(
    new Logger('IntegrationExecutor.connectorKeyConsistency.test'),
    transformationEngine,
    connectorManager,
    statusManager,
    observability,
    createMockOwnershipResolver() as any,
    createMockAuditService() as any,
    { enqueue: jest.fn().mockResolvedValue('noop-queue-id') } as any,
  );
}

function mixedCaseConfig(overrides: Partial<IntegrationConfig> = {}): IntegrationConfig {
  return {
    id: 'cfg-mixed',
    tenantId: 'tenant-a',
    name: 'Mixed-case spelling config (matches on-disk integrations/*.json)',
    sourceSystem: 'NetSuite',
    targetSystem: 'Salesforce',
    sourceEntity: 'Account',
    targetEntity: 'Customer',
    syncDirection: 'source_to_target',
    syncMode: 'batch',
    isActive: true,
    fieldMappings: [],
    transformationRules: [],
    ...overrides,
  } as IntegrationConfig;
}

describe('IntegrationExecutor + real ConnectorManager — connector cache-key consistency (regression)', () => {
  it('executeSync reuses the SAME connector instances ConnectorManager.initializeConnectorsForConfig already cached, for a mixed-case config spelling', async () => {
    const connectorManager = makeRealConnectorManager();
    const config = mixedCaseConfig({ id: 'cfg-exec' });

    // Simulate config-load-time initialization (what ConnectorManager does
    // today for every stored config).
    await connectorManager.initializeConnectorsForConfig(config);
    const cachedSource = await connectorManager.getConnector('netsuite', 'netsuite_cfg-exec');
    const cachedTarget = await connectorManager.getConnector('salesforce', 'salesforce_cfg-exec');
    expect(connectorManager.getConnectorStats().totalConnectors).toBe(2);

    jest.spyOn(cachedSource, 'list').mockResolvedValue([]);
    jest.spyOn(cachedTarget, 'list').mockResolvedValue([]);

    const executor = makeExecutor(connectorManager);
    await executor.executeSync(config);

    // No third/divergent-key connector: the executor must have retrieved the
    // SAME two cached instances, not created fresh ones under the raw
    // 'NetSuite'/'Salesforce' spelling.
    const stats = connectorManager.getConnectorStats();
    expect(stats.totalConnectors).toBe(2);
    expect(Object.keys(stats.connectorsByType)).toEqual(
      expect.arrayContaining(['netsuite', 'salesforce']),
    );
    expect(stats.connectorsByType['NetSuite']).toBeUndefined();
    expect(stats.connectorsByType['Salesforce']).toBeUndefined();
    expect(cachedSource.list).toHaveBeenCalled();
  });

  it('syncSingleRecord reuses the SAME cached connector instances for a mixed-case config spelling', async () => {
    const connectorManager = makeRealConnectorManager();
    const config = mixedCaseConfig({ id: 'cfg-single' });

    await connectorManager.initializeConnectorsForConfig(config);
    const cachedSource = await connectorManager.getConnector('netsuite', 'netsuite_cfg-single');
    expect(connectorManager.getConnectorStats().totalConnectors).toBe(2);

    jest.spyOn(cachedSource, 'read').mockResolvedValue(null);

    const executor = makeExecutor(connectorManager);
    await executor.syncSingleRecord(config, 'rec-1');

    const stats = connectorManager.getConnectorStats();
    expect(stats.totalConnectors).toBe(2);
    expect(stats.connectorsByType['NetSuite']).toBeUndefined();
    expect(cachedSource.read).toHaveBeenCalled();
  });

  it('testSync creates its connectors under the registry key (netsuite/salesforce), not the raw config spelling, for a mixed-case config', async () => {
    // testSync intentionally caches under a fixed `${key}_test` suffix
    // (pre-existing design, independent of config.id — it never shared
    // initializeConnectorsForConfig's per-config cache entry, before or
    // after this fix), so this test checks testSync in isolation rather
    // than against a prior init call: the regression is specifically that
    // it used to build that key from the RAW config spelling
    // ('NetSuite_test'/'Salesforce_test') instead of the connector-registry
    // key ('netsuite_test'/'salesforce_test').
    const connectorManager = makeRealConnectorManager();
    const config = mixedCaseConfig({ id: 'cfg-test' });

    const executor = makeExecutor(connectorManager);
    await executor.testSync(config);

    const stats = connectorManager.getConnectorStats();
    expect(stats.totalConnectors).toBe(2);
    expect(Object.keys(stats.connectorsByType)).toEqual(
      expect.arrayContaining(['netsuite', 'salesforce']),
    );
    expect(stats.connectorsByType['NetSuite']).toBeUndefined();
    expect(stats.connectorsByType['Salesforce']).toBeUndefined();
  });
});
