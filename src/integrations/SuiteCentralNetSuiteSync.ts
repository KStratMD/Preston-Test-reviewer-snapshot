import { initializeIntegrationSuite } from './SystemInfrastructureOrchestrator';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SuiteCentralConnector } from '../connectors/SuiteCentralConnector';
import type { NetSuiteConnector } from '../connectors/NetSuiteConnector';
import { getConnectorRegistration } from '../connectors/connectorRegistry';
import { TransformationEngine } from '../services/TransformationEngine';
import type { IntegrationService } from '../services/IntegrationService';
import type { FieldMapping, TransformationRule, DataRecord, SyncResult } from '../types';
import { suiteCentralToNetSuiteCustomerMappings } from '../mappings/customerMappings';
import { Logger } from '../utils/Logger';
import { AuthService } from '../services/AuthService';
import type { OutboundGovernanceService } from '../services/governance/OutboundGovernanceService';

export interface SuiteCentralNetSuiteOptions {
  /**
   * When true, assumes SuiteCentral is already initialized and skips the
   * connector initialization step. Useful when running as part of a larger
   * orchestrated flow where SuiteCentral has already been populated with
   * transformed records.
   */
  skipSuiteCentralInit?: boolean;
}

/**
 * Demonstrates a SuiteCentral → NetSuite synchronization flow.
 * Seeds mock SuiteCentral data, maps fields to NetSuite formats and
 * performs basic CRUD operations using the NetSuite connector.
 */
export async function runSuiteCentralNetSuiteSync(
  integrationService: IntegrationService,
  options: SuiteCentralNetSuiteOptions = {},
): Promise<SyncResult> {
  let eventBus: { emit: (event: string, payload?: unknown) => void } = { emit: () => {} };
  try {
    const orchestrator = await initializeIntegrationSuite(
      process.env.NODE_ENV === 'test'
        ? { dynamicConfig: { enabled: false } as any, eventBus: { enabled: true } as any, retryStrategies: { enabled: false } as any, integration: { performanceMonitoringEnabled: false, autoRecoveryEnabled: false } as any }
        : undefined,
    );
    eventBus = orchestrator.getEventBus();
  } catch {
    // In test/demo contexts, proceed with a no-op event bus if orchestrator init fails
  }

  eventBus.emit('sync:suitecentral-netsuite:start', { timestamp: new Date() });

  const useDirect = process.env.NODE_ENV === 'test';
  const logger = new Logger('SuiteCentralNetSuiteSync');
  const authService = new AuthService(logger);
  const transformer = useDirect
    ? new TransformationEngine(logger)
    : container.get<TransformationEngine>(TYPES.TransformationEngine);
  const outboundGovernance = container.get<OutboundGovernanceService>(TYPES.OutboundGovernanceService);
  const directDeps = { logger, authService, outboundGovernance };
  const suitecentral = (useDirect
    ? getConnectorRegistration('suitecentral')!.factory!('suitecentral', directDeps)
    : container.get<SuiteCentralConnector>(TYPES.SuiteCentralConnector)) as SuiteCentralConnector;
  const netsuite = (useDirect
    ? getConnectorRegistration('netsuite')!.factory!('netsuite', directDeps)
    : container.get<NetSuiteConnector>(TYPES.NetSuiteConnector)) as NetSuiteConnector;

  if (!options.skipSuiteCentralInit) {
    await suitecentral.initialize({ type: 'api_key', credentials: { apiKey: 'demo' } });
  }
  await netsuite.initialize({
    type: 'oauth1',
    credentials: {
      accountId: 'demo',
      consumerKey: 'demo',
      consumerSecret: 'demo',
      tokenId: 'demo',
      tokenSecret: 'demo',
      baseUrl: 'https://api.netsuite.mock',
    },
  });

  const startTime = new Date();

  const records = await suitecentral.list('customers');

  const fieldMappings: FieldMapping[] = suiteCentralToNetSuiteCustomerMappings;
  const rules: TransformationRule[] = [];

  let successCount = 0;
  const errors: string[] = [];

  for (const record of records) {
    const source: DataRecord = { ...record, fields: (record as any).fields || (record as any) } as DataRecord;
    try {
      const mappedFields = await transformer.transformRecord(source, fieldMappings, rules);
      const transformed: DataRecord = { ...(source as any), fields: mappedFields };

      const created = await netsuite.create('customers', transformed);
      // id is expected after create; assert non-null for type safety
      await netsuite.read('customers', created.id!);
      await netsuite.update('customers', created.id!, {
        ...created,
        fields: { ...(created.fields as any), phone: '+1-555-9999' },
      });
      await netsuite.delete('customers', created.id!);
      successCount++;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const result: SyncResult = {
    integrationId: 'suitecentral-netsuite',
    syncId: `sync_${Date.now()}`,
    status: errors.length === 0 ? 'success' : successCount > 0 ? 'partial' : 'failed',
    success: errors.length === 0,
    recordsProcessed: records.length,
    recordsSuccessful: successCount,
    recordsFailed: errors.length,
    errors,
    startTime,
    endTime: new Date(),
  };

  try {
    const endMs = result.endTime.getTime();
    const ms = Math.max(0, endMs - startTime.getTime());
    result.processingMs = ms;
    result.processingTime = `${(ms / 1000).toFixed(1)}s`;
  } catch {
    /* ignore */
  }

  integrationService.recordSyncResult('suitecentral-netsuite', result);

  eventBus.emit('sync:suitecentral-netsuite:complete', { timestamp: result.endTime, result });
  return result;
}
