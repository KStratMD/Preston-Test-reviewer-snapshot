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
import { guardedWrite } from '../governance/sourceOfTruth/guardedWrite';
import { canonicalEntityFor } from '../governance/sourceOfTruth/canonicalEntity';
import type { OwnershipResolver } from '../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../services/ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../services/governance/ApprovalQueueService';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { ownershipDemoTenantId } from '../config/runtimeFlags';

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
 *
 * Ownership gating: every NetSuite mutation below routes through
 * guardedWrite, and the canonical SourceOfTruthManifest declares `customer`
 * owned-by-netsuite with `reject_with_alert` — so by DEFAULT a real run of
 * this demo flow rejects every record with OwnershipViolation (surfaced
 * per-record in SyncResult.errors, status 'failed'). That was the
 * KNOWN-BLOCKED state since PR 13b (#851).
 *
 * Unblocking (demo-tenant override, decided 2026-06-11): set
 * OWNERSHIP_DEMO_TENANT_ID to a non-system DEMO tenant id (never a real
 * production tenant — the override is tenant-scoped, not flow-scoped; under
 * NODE_ENV=production it additionally requires
 * OWNERSHIP_DEMO_OVERRIDE_ALLOW_PRODUCTION=1, fail-closed). The flow then
 * runs its guarded writes under that tenant, and OwnershipResolver allows
 * the non-owner writes with the 'demo_tenant_override' decision reason —
 * decision audit row at HIGH risk, 'ownership_demo_tenant_override' flag on
 * both the decision and outcome rows (see src/config/runtimeFlags.ts:
 * ownershipDemoTenantStatus). With the env var unset the flow stays
 * blocked, fail-closed.
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

  // PR 13b Stage A3: governance trio for guardedWrite. OwnershipResolver +
  // ApprovalQueueService are async-bound; AuditService is sync-bound.
  // Resolved through `container` regardless of useDirect because the
  // connector-bypass only swaps the IConnector implementation — the
  // governance services are still wired via Inversify.
  const [ownershipResolver, approvalQueueService] = await Promise.all([
    container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver),
    container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService),
  ]);
  const auditService = container.get<AuditService>(TYPES.AuditService);
  const guardedDeps = { ownershipResolver, auditService, approvalQueueService };

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

  // PR 13b Stage A3: this top-level integration runner has no request-scoped
  // identity; run under SYSTEM_IDENTITY so the governance audit trail
  // attributes the writes to the integration engine. When the operator has
  // designated a demo tenant (OWNERSHIP_DEMO_TENANT_ID), the guarded writes
  // run under THAT tenant instead, which is what lets OwnershipResolver's
  // demo-tenant override unblock the reject_with_alert policy on `customer`
  // (see the flow docstring above). requesterUserId stays SYSTEM_IDENTITY —
  // the override is tenant-scoped, not a user impersonation.
  const governanceTenantId = ownershipDemoTenantId() ?? SYSTEM_IDENTITY.tenantId;
  const correlationId = `suitecentral-netsuite-${Date.now()}`;
  let successCount = 0;
  const errors: string[] = [];

  for (const record of records) {
    const source: DataRecord = { ...record, fields: (record as any).fields || (record as any) } as DataRecord;
    try {
      const mappedFields = await transformer.transformRecord(source, fieldMappings, rules);
      const transformed: DataRecord = { ...(source as any), fields: mappedFields };

      // PR 13b Stage A3: route each NetSuite mutation through guardedWrite.
      // callerSystem 'squire' (the canonical SourceSystem for SuiteCentral —
      // see Copilot R7 note below); targetSystem 'netsuite'. Using a real
      // SourceSystem rather than the synthetic 'integration_engine' lets
      // guardedWrite's detectLoop gate run, since lineage events are keyed
      // by SourceSystem. Copilot R19 on PR #851: comment updated to match
      // the actual `callerSystem: 'squire'` literal below — prior version
      // claimed 'integration_engine' which was wrong post-R7.
      const created = await guardedWrite(
        {
          context: {
            tenantId: governanceTenantId,
            // Copilot R7 on PR #851: source system is squire (SuiteCentral
            // maps to canonical 'squire' per SOURCE_SYSTEM_TO_CONNECTOR_KEY).
            // Using the real source system as callerSystem lets
            // guardedWrite's detectLoop catch reciprocal-write hazards.
            callerSystem: 'squire',
            targetSystem: 'netsuite',
            // Copilot R10 on PR #851: normalize 'customers' → 'customer'
            // so OwnershipResolver evaluates the canonical policy.
            entity: canonicalEntityFor('customers'),
            recordId: source.id ?? source.externalId,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'create',
          },
          do: () => netsuite.create('customers', transformed),
        },
        guardedDeps,
      );
      // id is expected after create; assert non-null for type safety
      await netsuite.read('customers', created.id!);
      await guardedWrite(
        {
          context: {
            tenantId: governanceTenantId,
            // Copilot R7 on PR #851: source system is squire (SuiteCentral
            // maps to canonical 'squire' per SOURCE_SYSTEM_TO_CONNECTOR_KEY).
            // Using the real source system as callerSystem lets
            // guardedWrite's detectLoop catch reciprocal-write hazards.
            callerSystem: 'squire',
            targetSystem: 'netsuite',
            // Copilot R10 on PR #851: normalize 'customers' → 'customer'
            // so OwnershipResolver evaluates the canonical policy.
            entity: canonicalEntityFor('customers'),
            recordId: created.id!,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'update',
          },
          do: () => netsuite.update('customers', created.id!, {
            ...created,
            fields: { ...(created.fields as any), phone: '+1-555-9999' },
          }),
        },
        guardedDeps,
      );
      await guardedWrite(
        {
          context: {
            tenantId: governanceTenantId,
            // Copilot R7 on PR #851: source system is squire (SuiteCentral
            // maps to canonical 'squire' per SOURCE_SYSTEM_TO_CONNECTOR_KEY).
            // Using the real source system as callerSystem lets
            // guardedWrite's detectLoop catch reciprocal-write hazards.
            callerSystem: 'squire',
            targetSystem: 'netsuite',
            // Copilot R10 on PR #851: normalize 'customers' → 'customer'
            // so OwnershipResolver evaluates the canonical policy.
            entity: canonicalEntityFor('customers'),
            recordId: created.id!,
            correlationId,
            requesterUserId: SYSTEM_IDENTITY.userId,
            operation: 'delete',
          },
          do: () => netsuite.delete('customers', created.id!),
        },
        guardedDeps,
      );
      successCount++;
    } catch (error) {
      // Preserves the existing integration-sync error semantics: ownership
      // blocks (WriteBlockedError) surface as per-record errors here rather
      // than aborting the whole sync. Decision audit rows were already
      // emitted by guardedWrite before any throw.
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
