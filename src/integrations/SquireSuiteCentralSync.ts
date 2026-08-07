import { initializeIntegrationSuite } from './SystemInfrastructureOrchestrator';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { SquireConnector } from '../connectors/SquireConnector';
import type { SuiteCentralConnector } from '../connectors/SuiteCentralConnector';
import type { TransformationEngine } from '../services/TransformationEngine';
import type { IntegrationService } from '../services/IntegrationService';
import type { FieldMapping, TransformationRule, DataRecord, SyncResult } from '../types';
import { squireToSuiteCentralCustomerMappings } from '../mappings/customerMappings';
import { guardedWrite } from '../governance/sourceOfTruth/guardedWrite';
import { canonicalEntityFor } from '../governance/sourceOfTruth/canonicalEntity';
import type { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../services/governance/ApprovalQueueService';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

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

  // PR 13b Stage A3: guardedWrite governance trio. OwnershipResolver +
  // ApprovalQueueService are async-bound (transitively depend on the
  // async-bound DatabaseService); AuditService is sync-bound.
  const [ownershipResolver, approvalQueueService] = await Promise.all([
    container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver),
    container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService),
  ]);
  const auditService = container.get<AuditService>(TYPES.AuditService);
  const guardedDeps = { ownershipResolver, auditService, approvalQueueService };

  await squire.initialize({ type: 'api_key', credentials: { apiKey: 'demo' } });
  await suitecentral.initialize({ type: 'api_key', credentials: { apiKey: 'demo' } });

  const startTime = new Date();
  const records = await squire.list('customers');
  const fieldMappings: FieldMapping[] = squireToSuiteCentralCustomerMappings;
  const rules: TransformationRule[] = [];

  // PR 13b Stage A3: this top-level integration runner has no request-scoped
  // identity (it's invoked by demos / orchestrator harnesses). Mirror the
  // IntegrationService pattern and run under SYSTEM_IDENTITY so the
  // governance audit trail attributes the writes to the integration engine.
  const correlationId = `squire-suitecentral-${Date.now()}`;
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
      // PR 13b Stage A3: route the SuiteCentral write through guardedWrite.
      // Copilot R7 on PR #851: callerSystem is the source system (squire)
      // so guardedWrite's detectLoop runs. Previously used the synthetic
      // 'integration_engine' which the isSourceSystem narrowing filtered out.
      // targetSystem 'squire' (canonical SourceSystem for SuiteCentral per
      // SOURCE_SYSTEM_TO_CONNECTOR_KEY); entity 'customers' is the
      // connector-side record name (OwnershipResolver falls back to
      // `no_policy_declared` for non-manifest entity names).
      await guardedWrite(
        {
          context: {
            tenantId: SYSTEM_IDENTITY.tenantId,
            callerSystem: 'squire',
            targetSystem: 'squire',
            // Copilot R10 on PR #851: normalize connector record type to
            // the canonical manifest entity so OwnershipResolver actually
            // evaluates the customer ownership policy (was 'customers' →
            // no_policy_declared bypass).
            entity: canonicalEntityFor('customers'),
            recordId: transformed.externalId,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'create',
          },
          do: () => suitecentral.create('customers', transformed),
        },
        guardedDeps,
      );
      successCount++;
    } catch (error) {
      // Preserves the existing integration-sync error semantics: ownership
      // blocks (WriteBlockedError) surface as per-record errors here rather
      // than aborting the whole sync. The decision audit row was already
      // emitted by guardedWrite before throwing.
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
