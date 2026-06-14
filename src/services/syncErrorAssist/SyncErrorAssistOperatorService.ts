import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import { SyncErrorAssistRepository } from './SyncErrorAssistRepository';
import { ConnectorManager } from '../integration/ConnectorManager';
import { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import type { NewAuditLog } from '../../database/types';
import type { ApplyAction } from './applyAction';
import type { PendingSuggestion } from './types';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../governance/ApprovalQueueService';
import type { CanonicalEntity } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import { canonicalEntityFor } from '../../governance/sourceOfTruth/canonicalEntity';

export type OperatorResultCode =
  | 'ok'
  | 'not_found'
  | 'already_dispositioned'
  | 'write_failed'
  | 'connector_unavailable';

export interface OperatorResult {
  ok: boolean;
  code: OperatorResultCode;
  message?: string;
  appliedRecordId?: string;
}

/**
 * Two-stage state machine for accept (lease isolation):
 *   pending --(beginAccept)--> applying --(completeAccept)--> accepted
 *                                       --(revertToPending)--> pending
 * reject/escalate are atomic single-stage transitions with no external write.
 */
@injectable()
export class SyncErrorAssistOperatorService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.SyncErrorAssistRepository) private repo: SyncErrorAssistRepository,
    @inject(TYPES.ConnectorManager) private connectorManager: ConnectorManager,
    @inject(TYPES.AuditLogRepository) private auditLog: AuditLogRepository,
    @inject(TYPES.OwnershipResolver) private ownershipResolver: OwnershipResolver,
    @inject(TYPES.AuditService) private auditService: AuditService,
    @inject(TYPES.ApprovalQueueService) private approvalQueueService: ApprovalQueueService,
  ) {}

  async list(args: { tenantId: string; limit: number }): Promise<PendingSuggestion[]> {
    return this.repo.listPendingSuggestionsByTenant(args.tenantId, { limit: args.limit });
  }

  async accept(args: {
    tenantId: string;
    errorRecordId: string;
    userId: string;
    applyAction: ApplyAction;
  }): Promise<OperatorResult> {
    const startedAt = Date.now();

    const leased = await this.repo.beginAccept({
      tenantId: args.tenantId,
      errorRecordId: args.errorRecordId,
      userId: args.userId,
    });
    if (!leased) {
      const row = await this.repo.getProcessedRowByErrorRecord(args.tenantId, args.errorRecordId);
      return { ok: false, code: row ? 'already_dispositioned' : 'not_found' };
    }

    // Load connector. Two failure modes: throw (credential/registry error) or
    // null return (defensive — type says non-null but tests pin the contract).
    let connector: Awaited<ReturnType<typeof this.connectorManager.getConnector>> | null;
    try {
      connector = await this.connectorManager.getConnector('netsuite', `netsuite_${args.tenantId}`);
    } catch (err) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        errorRecordId: args.errorRecordId,
        userId: args.userId,
      });
      const message = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ...this.baseAudit('accept', args, startedAt),
        result: 'failure',
        error_message: message,
        details: {
          ...this.baseDetails(args),
          apply_action_type: args.applyAction.type,
          connector_error: 'getConnector_threw',
        },
      });
      return { ok: false, code: 'connector_unavailable', message };
    }
    if (!connector) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        errorRecordId: args.errorRecordId,
        userId: args.userId,
      });
      await this.safeAudit({
        ...this.baseAudit('accept', args, startedAt),
        result: 'failure',
        error_message: 'connector_unavailable',
        details: {
          ...this.baseDetails(args),
          apply_action_type: args.applyAction.type,
          connector_error: 'getConnector_null',
        },
      });
      return { ok: false, code: 'connector_unavailable' };
    }

    // Dispatch the connector write. PR 2C validateOutboundWrite is invoked
    // inside the connector implementations (NetSuiteConnector etc.), not here.
    //
    // Connector contract shape: NetSuiteConnector.formatDataForNetSuite reads
    // `data.fields ?? {}` (src/connectors/NetSuiteConnector.ts:407-409). We
    // wrap the operator-supplied flat payload in `{ fields: payload }` so it
    // reaches mapCommonFields with the expected shape. Without this wrap, the
    // connector silently writes an empty payload and audits success.
    let appliedRecordId: string;
    try {
      if (args.applyAction.type === 'create') {
        const created = await guardedWrite(
          {
            context: {
              tenantId: args.tenantId,
              // Copilot R12 on PR #851: operator-accepted remediation writes
              // are operator-initiated overrides of the "only NetSuite writes
              // to NetSuite" rule for invoice/customer/vendor (all
              // reject_with_alert + owner=netsuite). guardedWrite only honors
              // overrides for callerSystem='operator_action' — using
              // 'sync_error_remediation' would have hit OwnershipViolationError
              // before the write could land. Mirrors the FinanceCentral
              // approval pattern (CI-12) for the same class of operator override.
              callerSystem: 'operator_action',
              targetSystem: 'netsuite',
              // Copilot R15 on PR #851: normalize the connector-side string
              // (e.g. 'Customer', 'customers', 'vendor') to the canonical
              // manifest entity via canonicalEntityFor — otherwise raw
              // connector spellings hit OwnershipResolver as
              // `no_policy_declared` (allowed) and bypass the
              // reject_with_alert + operator-override audit path that this
              // route is specifically engineered to take. Same normalization
              // the integration paths use.
              entity: canonicalEntityFor(args.applyAction.entityType) as CanonicalEntity,
              correlationId: `sea-accept-${args.errorRecordId}`,
              requesterUserId: args.userId,
              operation: 'create',
            },
            do: () =>
              connector.create(
                args.applyAction.entityType,
                { fields: (args.applyAction as Extract<typeof args.applyAction, { type: 'create' }>).payload },
              ),
            override: {
              permitted: true,
              reason: `SyncErrorAssist operator-accepted remediation ${args.errorRecordId}`,
            },
          },
          { ownershipResolver: this.ownershipResolver, auditService: this.auditService, approvalQueueService: this.approvalQueueService },
        );
        const id = (created as { id?: string }).id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('Connector create returned no id for accepted sync-error assist action');
        }
        appliedRecordId = id;
      } else {
        const updateAction = args.applyAction as Extract<typeof args.applyAction, { type: 'update' }>;
        const updated = await guardedWrite(
          {
            context: {
              tenantId: args.tenantId,
              // Copilot R12 on PR #851: see the create-path comment above —
              // operator-accepted remediation update writes use the
              // operator-override pathway for the same reason.
              callerSystem: 'operator_action',
              targetSystem: 'netsuite',
              // Copilot R15 on PR #851: normalize the connector-side string
              // (e.g. 'Customer', 'customers', 'vendor') to the canonical
              // manifest entity via canonicalEntityFor — otherwise raw
              // connector spellings hit OwnershipResolver as
              // `no_policy_declared` (allowed) and bypass the
              // reject_with_alert + operator-override audit path that this
              // route is specifically engineered to take. Same normalization
              // the integration paths use.
              entity: canonicalEntityFor(args.applyAction.entityType) as CanonicalEntity,
              recordId: updateAction.recordId,
              correlationId: `sea-accept-${args.errorRecordId}`,
              requesterUserId: args.userId,
              operation: 'update',
            },
            do: () =>
              connector.update(
                args.applyAction.entityType,
                updateAction.recordId,
                { fields: updateAction.patch },
              ),
            override: {
              permitted: true,
              reason: `SyncErrorAssist operator-accepted remediation ${args.errorRecordId}`,
            },
          },
          { ownershipResolver: this.ownershipResolver, auditService: this.auditService, approvalQueueService: this.approvalQueueService },
        );
        const id = (updated as { id?: string }).id;
        if (typeof id !== 'string' || id.length === 0) {
          throw new Error('Connector update returned no id for accepted sync-error assist action');
        }
        appliedRecordId = id;
      }
    } catch (err) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        errorRecordId: args.errorRecordId,
        userId: args.userId,
      });
      const message = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ...this.baseAudit('accept', args, startedAt),
        result: 'failure',
        error_message: message,
        details: {
          ...this.baseDetails(args),
          apply_action_type: args.applyAction.type,
        },
      });
      return { ok: false, code: 'write_failed', message };
    }

    // Complete the lease. If we lose the race (e.g., reaper reverted to pending),
    // disambiguate via the row state for audit clarity. Surface still returns ok
    // because the connector write DID succeed.
    const completed = await this.repo.completeAccept({
      tenantId: args.tenantId,
      errorRecordId: args.errorRecordId,
      userId: args.userId,
    });
    let completionResult: 'success' | 'state_moved' | 'wrong_holder' | 'missing' = 'success';
    if (!completed) {
      const row = await this.repo.getProcessedRowByErrorRecord(args.tenantId, args.errorRecordId);
      if (!row) {
        completionResult = 'missing';
      } else if (
        row.operator_disposition === 'applying' &&
        row.operator_disposition_user_id !== args.userId
      ) {
        completionResult = 'wrong_holder';
      } else {
        completionResult = 'state_moved';
      }
    }

    await this.safeAudit({
      ...this.baseAudit('accept', args, startedAt),
      result: 'success',
      details: {
        ...this.baseDetails(args),
        applied_record_id: appliedRecordId,
        apply_action_type: args.applyAction.type,
        apply_action_entity_type: args.applyAction.entityType,
        ...(args.applyAction.type === 'update' ? { apply_action_record_id: args.applyAction.recordId } : {}),
        completion_result: completionResult,
      },
    });

    return { ok: true, code: 'ok', appliedRecordId };
  }

  async reject(args: {
    tenantId: string;
    errorRecordId: string;
    userId: string;
    reason: string;
  }): Promise<OperatorResult> {
    return this.dispositionOnly('reject', 'rejected', args, { reason: args.reason });
  }

  async escalate(args: {
    tenantId: string;
    errorRecordId: string;
    userId: string;
    note: string;
  }): Promise<OperatorResult> {
    return this.dispositionOnly('escalate', 'escalated', args, { note: args.note });
  }

  private async dispositionOnly(
    action: 'reject' | 'escalate',
    newDisposition: 'rejected' | 'escalated',
    args: { tenantId: string; errorRecordId: string; userId: string },
    extraDetails: Record<string, unknown>,
  ): Promise<OperatorResult> {
    const startedAt = Date.now();
    const dispositioned = await this.repo.markDisposition({
      tenantId: args.tenantId,
      errorRecordId: args.errorRecordId,
      newDisposition,
      userId: args.userId,
    });
    if (!dispositioned) {
      const row = await this.repo.getProcessedRowByErrorRecord(args.tenantId, args.errorRecordId);
      await this.safeAudit({
        ...this.baseAudit(action, args, startedAt),
        result: 'failure',
        error_message: row ? 'already_dispositioned' : 'not_found',
        details: { ...this.baseDetails(args), ...extraDetails },
      });
      return { ok: false, code: row ? 'already_dispositioned' : 'not_found' };
    }
    await this.safeAudit({
      ...this.baseAudit(action, args, startedAt),
      result: 'success',
      details: { ...this.baseDetails(args), ...extraDetails },
    });
    return { ok: true, code: 'ok' };
  }

  private baseAudit(
    verb: 'accept' | 'reject' | 'escalate',
    args: { tenantId: string; errorRecordId: string; userId: string },
    startedAt: number,
  ): Omit<NewAuditLog, 'result' | 'details' | 'error_message'> & { error_message: null } {
    return {
      tenant_id: args.tenantId,
      user_id: args.userId,
      action: `sync_error_assist.${verb}`,
      resource_type: 'sync_error_record',
      resource_id: args.errorRecordId,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  }

  private baseDetails(args: { errorRecordId: string }): Record<string, unknown> {
    return { error_record_id: args.errorRecordId };
  }

  private async safeAudit(entry: NewAuditLog): Promise<void> {
    try {
      await this.auditLog.create(entry);
    } catch (err) {
      this.logger.warn('audit log write failed for operator action', {
        action: entry.action,
        resource_id: entry.resource_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
