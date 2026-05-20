import { initializeIntegrationSuite } from './SystemInfrastructureOrchestrator';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SquireConnector } from '../connectors/SquireConnector';
import type { SuiteCentralConnector } from '../connectors/SuiteCentralConnector';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { IntegrationService } from '../services/IntegrationService';
import type { FieldMapping, TransformationRule, DataRecord, SyncResult } from '../types';
import { squireToSuiteCentralCustomerMappings } from '../mappings/customerMappings';

/**
 * Demonstrates a Squire ↔ SuiteCentral synchronization flow.
 * Emits start and completion events on the EventBus.
 */
export async function runSquireSuiteCentralSync(
  integrationService: IntegrationService,
): Promise<SyncResult> {
  const orchestrator = await initializeIntegrationSuite();
  const eventBus = orchestrator.getEventBus();

  eventBus.emit('sync:squire-suitecentral:start', { timestamp: new Date() });

  const squire = container.get<SquireConnector>(TYPES.SquireConnector);
  const suitecentral = container.get<SuiteCentralConnector>(TYPES.SuiteCentralConnector);
  const transformer = container.get<TransformationEngine>(TYPES.TransformationEngine);

  await squire.initialize({ type: 'api_key', credentials: { apiKey: 'demo' } });
  await suitecentral.initialize({ type: 'api_key', credentials: { apiKey: 'demo' } });

  const startTime = new Date();
  const records = await squire.list('customers');
  const fieldMappings: FieldMapping[] = squireToSuiteCentralCustomerMappings;
  const rules: TransformationRule[] = [];

  let successCount = 0;
  const errors: string[] = [];

  for (const record of records) {
    const baseSource: DataRecord = { ...record, fields: (record as any).fields || record } as DataRecord;
    const source: DataRecord = {
      ...baseSource,
      fields: {
        ...(baseSource.fields as any),
        externalId: (baseSource.fields as any)?.externalId ?? baseSource.externalId ?? baseSource.id,
      },
    };
    try {
      const transformedFields = await transformer.transformRecord(source, fieldMappings, rules);
      const { externalId, ...rest } = transformedFields;
      const transformed: DataRecord = { externalId: externalId as string, fields: rest };
      await suitecentral.create('customers', transformed);
      successCount++;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  const result: SyncResult = {
    integrationId: 'squire-suitecentral',
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

  // Compute processing duration fields (ms and human-friendly string)
  try {
    const endMs = (result.endTime instanceof Date) ? result.endTime.getTime() : new Date(result.endTime).getTime();
    const startMs = startTime.getTime();
    const ms = Math.max(0, endMs - startMs);
    result.processingMs = ms;
    result.processingTime = `${(ms / 1000).toFixed(1)}s`;
  } catch (_err) {
    // ignore
  }

  integrationService.recordSyncResult('squire-suitecentral', result);
  // processingTime and processingMs are computed above; return the result
  eventBus.emit('sync:squire-suitecentral:complete', { timestamp: result.endTime, result });
  return result;
}
