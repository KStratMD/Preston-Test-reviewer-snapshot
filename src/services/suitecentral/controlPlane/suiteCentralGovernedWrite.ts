import type { DataRecord } from '../../../types';
import type { OutboundDecision, OutboundGovernanceService } from '../../governance/OutboundGovernanceService';
import type { SuiteCentralConnectorProd } from '../../../connectors/SuiteCentralConnectorProd';
import type { SuiteCentralControlPlaneContext } from './domain';
import { SuiteCentralDestinationRejectedError } from './errors';

/**
 * The governed-write seam for the SuiteCentral connector (PR-A4).
 *
 * These functions — `governedBulkImport` and `governedWrite` — are the ONLY
 * sanctioned write path for SuiteCentral. The PR-A5 SuiteCentral control-plane
 * service MUST route every write (bulk import AND every single-record
 * create/update/delete, plus webhook setup) through this seam. The connector's
 * inherited raw write methods (`create`/`update`/`delete`/`bulkImport`/
 * `setupWebhook`, which reach the pinned transport directly) are INTERNAL
 * plumbing, NOT a public entry point — calling them without first crossing this
 * seam bypasses `OutboundGovernanceService` and is prohibited.
 *
 * Every write MUST cross `OutboundGovernanceService` BEFORE it reaches the
 * pinned transport. The fail-closed contract from the security plan: a write
 * proceeds ONLY when the decision is `approved`, NOT `auditMetadata.blocked`,
 * AND carries a defined `redactedPayload`. A present raw `redactedPayload` is
 * NOT treated as proof of sanitation — the three authoritative signals are
 * checked together (see `OutboundDecision.redactedPayload` docs).
 *
 * The seam is deliberately a set of thin, connector-agnostic functions rather
 * than methods on the connector (which must NOT be coupled to the governance
 * service) or the factory (which only constructs). Kept small and
 * side-effect-free so they are unit-testable without a live connector or
 * governance backend.
 */

/**
 * Enforce the fail-closed governance predicate and return the redacted payload.
 * Throws {@link SuiteCentralDestinationRejectedError} when the decision is not
 * approved, is blocked, or carries no defined `redactedPayload`.
 */
function approvedRedactedPayload<T>(decision: OutboundDecision<T>): T {
  if (!decision.approved || decision.auditMetadata.blocked || decision.redactedPayload === undefined) {
    throw new SuiteCentralDestinationRejectedError(
      'outbound_payload_blocked',
      'Outbound payload blocked by governance.',
    );
  }
  return decision.redactedPayload;
}

export async function governedBulkImport(
  deps: { outboundGovernance: Pick<OutboundGovernanceService, 'validateConnectorWrite'> },
  connector: Pick<SuiteCentralConnectorProd, 'bulkImport'>,
  context: SuiteCentralControlPlaneContext,
  entityType: string,
  records: DataRecord[],
): Promise<string> {
  const decision = await deps.outboundGovernance.validateConnectorWrite(records, {
    tenantId: context.targetTenantId,
    userId: context.actorUserId,
    destination: 'connector_write',
    destinationDetail: `suitecentral.bulk_import.${entityType}`,
    operationType: 'write',
    resourceType: entityType,
  });

  return connector.bulkImport(entityType, approvedRedactedPayload(decision));
}

/**
 * A single-record governed write. `create`/`update`/`delete` all run through
 * `validateConnectorWrite` with the SAME fail-closed predicate as bulk import
 * before the corresponding connector method is invoked on the redacted payload.
 *
 * `delete` has no record body, so the record identifier is scanned as the
 * governance payload (the write is still gated); the connector's `delete(id)`
 * is only reached once the decision is approved.
 */
export type GovernedWriteOp =
  | { operation: 'create'; entityType: string; record: DataRecord }
  | { operation: 'update'; entityType: string; id: string; record: Partial<DataRecord> }
  | { operation: 'delete'; entityType: string; id: string };

export async function governedWrite(
  deps: { outboundGovernance: Pick<OutboundGovernanceService, 'validateConnectorWrite'> },
  connector: Pick<SuiteCentralConnectorProd, 'create' | 'update' | 'delete'>,
  context: SuiteCentralControlPlaneContext,
  op: GovernedWriteOp,
): Promise<DataRecord | boolean> {
  const ctxBase = {
    tenantId: context.targetTenantId,
    userId: context.actorUserId,
    destination: 'connector_write' as const,
    destinationDetail: `suitecentral.${op.operation}.${op.entityType}`,
    operationType: 'write' as const,
    resourceType: op.entityType,
  };

  if (op.operation === 'create') {
    const decision = await deps.outboundGovernance.validateConnectorWrite(op.record, ctxBase);
    return connector.create(op.entityType, approvedRedactedPayload(decision));
  }

  if (op.operation === 'update') {
    const decision = await deps.outboundGovernance.validateConnectorWrite(op.record, {
      ...ctxBase,
      resourceId: op.id,
    });
    return connector.update(op.entityType, op.id, approvedRedactedPayload(decision));
  }

  // delete: gate on the identifier descriptor. Dispatch the identifier that
  // governance approved — and fail closed if governance redacted/changed it
  // rather than silently deleting under the original raw id.
  const decision = await deps.outboundGovernance.validateConnectorWrite(
    { id: op.id },
    { ...ctxBase, resourceId: op.id },
  );
  const approved = approvedRedactedPayload(decision) as { id?: unknown };
  if (typeof approved.id !== 'string' || approved.id !== op.id) {
    throw new SuiteCentralDestinationRejectedError(
      'outbound_payload_blocked',
      'Delete identifier was altered by governance.',
    );
  }
  return connector.delete(op.entityType, approved.id);
}

/**
 * Governed webhook lifecycle. `setupWebhook` posts a subscription (target URL +
 * events) to the ERP and `removeWebhook` deletes one by id — both cross
 * `OutboundGovernanceService` with the same fail-closed predicate before
 * reaching the connector, so the webhook write path is not an ungoverned
 * bypass. As with delete, the removal id must survive governance unchanged.
 */
export async function governedSetupWebhook(
  deps: { outboundGovernance: Pick<OutboundGovernanceService, 'validateConnectorWrite'> },
  connector: Pick<SuiteCentralConnectorProd, 'setupWebhook'>,
  context: SuiteCentralControlPlaneContext,
  subscription: { targetUrl: string; events: string[] },
): Promise<string> {
  const decision = await deps.outboundGovernance.validateConnectorWrite(subscription, {
    tenantId: context.targetTenantId,
    userId: context.actorUserId,
    destination: 'connector_write',
    destinationDetail: 'suitecentral.webhook.setup',
    operationType: 'write',
    resourceType: 'webhook',
  });
  const approved = approvedRedactedPayload(decision);
  // The target URL was validated against the allowlist + live DNS before this
  // call. Governance may legitimately redact a payload, but a REDACTED target is
  // no longer the destination that was validated — dispatching it would hand the
  // ERP an unvalidated (or mangled) callback URL. Same invariant the remove/delete
  // paths enforce on their identifiers: the value must survive governance intact.
  if (approved.targetUrl !== subscription.targetUrl) {
    throw new SuiteCentralDestinationRejectedError(
      'outbound_payload_blocked',
      'Webhook target was altered by governance.',
    );
  }
  return connector.setupWebhook(approved.targetUrl, approved.events);
}

export async function governedRemoveWebhook(
  deps: { outboundGovernance: Pick<OutboundGovernanceService, 'validateConnectorWrite'> },
  connector: Pick<SuiteCentralConnectorProd, 'removeWebhook'>,
  context: SuiteCentralControlPlaneContext,
  webhookId: string,
): Promise<boolean> {
  const decision = await deps.outboundGovernance.validateConnectorWrite(
    { webhookId },
    {
      tenantId: context.targetTenantId,
      userId: context.actorUserId,
      destination: 'connector_write',
      destinationDetail: 'suitecentral.webhook.remove',
      operationType: 'write',
      resourceType: 'webhook',
      resourceId: webhookId,
    },
  );
  const approved = approvedRedactedPayload(decision) as { webhookId?: unknown };
  if (typeof approved.webhookId !== 'string' || approved.webhookId !== webhookId) {
    throw new SuiteCentralDestinationRejectedError(
      'outbound_payload_blocked',
      'Webhook identifier was altered by governance.',
    );
  }
  return connector.removeWebhook(approved.webhookId);
}
