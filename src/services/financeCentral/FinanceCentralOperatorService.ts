import { inject, injectable } from 'inversify';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import { FinanceCentralRepository } from './FinanceCentralRepository';
import { ConnectorManager } from '../integration/ConnectorManager';
import { AuditLogRepository } from '../../database/repositories/AuditLogRepository';
import type { NewAuditLog } from '../../database/types';
import type {
  ApproveResult,
  DocumentType,
  PendingApprovalView,
  RejectResult,
} from './types';
import { guardedWrite } from '../../governance/sourceOfTruth/guardedWrite';
import type { OwnershipResolver } from '../../governance/sourceOfTruth/OwnershipResolver';
import type { AuditService } from '../ai/orchestrator/AuditService';
import type { ApprovalQueueService } from '../governance/ApprovalQueueService';
import type { CanonicalEntity } from '../../governance/sourceOfTruth/SourceOfTruthManifest';
import { canonicalEntityFor } from '../../governance/sourceOfTruth/canonicalEntity';

/**
 * Operator-promotion service for FinanceCentral approvals.
 *
 * Two-stage state machine for approve (lease isolation):
 *   pending --(beginAccept)--> applying --(completeAccept)--> accepted
 *                                       --(revertToPending)--> pending
 * reject is an atomic single-stage transition with no external write.
 *
 * Pattern source: src/services/syncErrorAssist/SyncErrorAssistOperatorService.ts
 * Spec: docs/plans/2026-05-13-operator-promotion-spec.md
 */
@injectable()
export class FinanceCentralOperatorService {
  constructor(
    @inject(TYPES.Logger) private logger: Logger,
    @inject(TYPES.FinanceCentralRepository) private repo: FinanceCentralRepository,
    @inject(TYPES.ConnectorManager) private connectorManager: ConnectorManager,
    @inject(TYPES.AuditLogRepository) private auditLog: AuditLogRepository,
    @inject(TYPES.OwnershipResolver) private ownershipResolver: OwnershipResolver,
    @inject(TYPES.AuditService) private auditService: AuditService,
    @inject(TYPES.ApprovalQueueService) private approvalQueueService: ApprovalQueueService,
  ) {}

  async listPendingApprovals(args: {
    tenantId: string;
    limit?: number;
    filters?: {
      type?: DocumentType;
      priority?: PendingApprovalView['priority'];
      approver?: string;
    };
  }): Promise<PendingApprovalView[]> {
    return this.repo.listPendingApprovals(args);
  }

  /**
   * Two-stage durable approve: claim lease → connector.update → release lease.
   * On any failure between begin and complete, the lease is reverted so the
   * caller can retry. Returns `connector_unavailable` when `netsuite_id` is
   * absent — silent skip is a correctness violation for a financial approval
   * workflow (spec §2.D3 + F-02).
   */
  async approveItem(args: {
    tenantId: string;
    approvalId: string;
    approverId: string;
    comments?: string;
  }): Promise<ApproveResult> {
    const startedAt = Date.now();

    const leased = await this.repo.beginAccept({
      tenantId: args.tenantId,
      approvalId: args.approvalId,
      userId: args.approverId,
    });
    if (!leased) {
      // PR 6 R9 (Copilot): audit the beginAccept-failure path so all operator
      // outcomes (success + failure) leave an audit trail, matching rejectItem's
      // analogous false-return-path audit and the spec §2.D8 contract.
      const disposition = await this.repo.getDisposition(args.tenantId, args.approvalId);
      const failureCode = disposition ? 'already_dispositioned' : 'not_found';
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: failureCode,
        details: this.baseDetails(args, { stage: 'beginAccept' }),
      });
      return { ok: false, code: failureCode };
    }

    const row = await this.repo.getRowByApprovalId(args.tenantId, args.approvalId);
    if (!row) {
      // Theoretically unreachable: beginAccept succeeded so the row existed
      // at lease-acquire time. Defensive recovery — revert and surface as
      // not_found so callers don't silently miss the inconsistency.
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        approvalId: args.approvalId,
        userId: args.approverId,
      });
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: 'row_vanished_after_lease',
        details: this.baseDetails(args, { stage: 'post_begin_lookup' }),
      });
      return { ok: false, code: 'not_found' };
    }

    if (!row.netsuite_id) {
      // Spec §2.D3 / F-02: cannot approve without an ERP twin. Revert lease so
      // a later linker can populate netsuite_id and the operator can retry.
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        approvalId: args.approvalId,
        userId: args.approverId,
      });
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: 'no_netsuite_id',
        details: this.baseDetails(args, {
          document_id: row.document_id,
          document_type: row.document_type,
          amount: row.amount,
          currency: row.currency,
          connector_error: 'no_netsuite_id',
        }),
      });
      return { ok: false, code: 'connector_unavailable', message: 'no_netsuite_id' };
    }

    // Load connector. Two failure modes: throw (credential/registry error) or
    // null return (defensive — type says non-null but tests pin the contract).
    let connector: Awaited<ReturnType<typeof this.connectorManager.getConnector>> | null;
    try {
      connector = await this.connectorManager.getConnector('netsuite', `netsuite_${args.tenantId}`);
    } catch (err) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        approvalId: args.approvalId,
        userId: args.approverId,
      });
      const message = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: message,
        details: this.baseDetails(args, {
          document_id: row.document_id,
          document_type: row.document_type,
          amount: row.amount,
          currency: row.currency,
          connector_error: 'getConnector_threw',
        }),
      });
      return { ok: false, code: 'connector_unavailable', message };
    }
    if (!connector) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        approvalId: args.approvalId,
        userId: args.approverId,
      });
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: 'connector_unavailable',
        details: this.baseDetails(args, {
          document_id: row.document_id,
          document_type: row.document_type,
          amount: row.amount,
          currency: row.currency,
          connector_error: 'getConnector_null',
        }),
      });
      return { ok: false, code: 'connector_unavailable' };
    }

    // Dispatch the connector write. PR 2C validateOutboundWrite is invoked
    // inside NetSuiteConnector.update — not here. Wrap the payload in
    // `{ fields: ... }` so it reaches NetSuiteConnector.formatDataForNetSuite
    // with the expected shape (mirrors SyncErrorAssistOperatorService:118-130).
    let appliedRecordId: string;
    try {
      const updated = await guardedWrite(
        {
          context: {
            tenantId: args.tenantId,
            callerSystem: 'operator_action',
            targetSystem: 'netsuite',
            // Copilot R18 on PR #851: row.document_type is a DocumentType
            // union that includes non-canonical values (bill, purchase_order,
            // expense_report, journal_entry). The bare cast would let those
            // hit OwnershipResolver as no_policy_declared → operator-override
            // audit path bypassed silently. Normalize first via the same
            // canonicalEntityFor helper used by IntegrationService and
            // SyncErrorAssistOperatorService. Returns canonical form for
            // known spellings, input verbatim otherwise (so non-canonical
            // document types still produce a sensible audit row even
            // when the resolver returns no_policy_declared).
            entity: canonicalEntityFor(row.document_type) as CanonicalEntity,
            recordId: row.netsuite_id,
            correlationId: `fc-approve-${args.approvalId}`,
            requesterUserId: args.approverId,
            operation: 'update',
          },
          // Copilot R6 on PR #851: `document_type='invoice'` is owned by
          // netsuite under reject_with_alert policy, so without an explicit
          // operator override the write would throw OwnershipViolationError
          // and the invoice approval flow would fail at the route layer.
          // FinanceCentral approval IS an operator-initiated override of
          // the "only NetSuite writes to NetSuite" rule — pass the
          // override permit so the 3-row audit pattern (decision → override
          // → outcome) records the operator action correctly.
          override: {
            permitted: true,
            reason: `FinanceCentral operator approval ${args.approvalId}`,
          },
          do: () =>
            connector.update(
              row.document_type,
              row.netsuite_id,
              {
                fields: {
                  status: 'approved',
                  approved_by: args.approverId,
                  approved_at: new Date().toISOString(),
                  approval_comments: args.comments ?? null,
                },
              },
            ),
        },
        { ownershipResolver: this.ownershipResolver, auditService: this.auditService, approvalQueueService: this.approvalQueueService },
      );
      const id = (updated as { id?: string }).id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('Connector update returned no id for approved finance-central item');
      }
      appliedRecordId = id;
    } catch (err) {
      await this.repo.revertToPending({
        tenantId: args.tenantId,
        approvalId: args.approvalId,
        userId: args.approverId,
      });
      const message = err instanceof Error ? err.message : String(err);
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: message,
        details: this.baseDetails(args, {
          document_id: row.document_id,
          document_type: row.document_type,
          amount: row.amount,
          currency: row.currency,
          netsuite_id: row.netsuite_id,
        }),
      });
      return { ok: false, code: 'write_failed', message };
    }

    // Release the lease. If we lose the race (row vanished, reverted to
    // pending, or held by a different user), the connector write DID succeed
    // but the DB no longer reflects an `accepted` row. Surfacing `ok` would
    // let another operator pick the row back up and re-approve → DOUBLE ERP
    // WRITE. Return `state_drift` so callers can flag for manual reconciliation
    // (Codex R1 BLOCKS-MERGE). The audit `details.applied_record_id` records
    // the ERP record id for the operator-tools reconciliation flow.
    const completed = await this.repo.completeAccept({
      tenantId: args.tenantId,
      approvalId: args.approvalId,
      userId: args.approverId,
      appliedRecordId,
      approvalComments: args.comments,
    });
    let completionResult: 'success' | 'state_moved' | 'wrong_holder' | 'missing' = 'success';
    if (!completed) {
      const stateRow = await this.repo.getRowByApprovalId(args.tenantId, args.approvalId);
      if (!stateRow) {
        completionResult = 'missing';
      } else if (
        stateRow.operator_disposition === 'applying' &&
        stateRow.operator_disposition_user_id !== args.approverId
      ) {
        completionResult = 'wrong_holder';
      } else {
        completionResult = 'state_moved';
      }
    }

    if (!completed) {
      await this.safeAudit({
        ...this.baseAudit('approve', args, startedAt),
        result: 'failure',
        error_message: `state_drift:${completionResult}`,
        details: this.baseDetails(args, {
          document_id: row.document_id,
          document_type: row.document_type,
          amount: row.amount,
          currency: row.currency,
          applied_record_id: appliedRecordId,
          completion_result: completionResult,
        }),
      });
      return {
        ok: false,
        code: 'state_drift',
        message: `connector write succeeded with appliedRecordId=${appliedRecordId} but DB row ${completionResult}; manual reconciliation required`,
      };
    }

    await this.safeAudit({
      ...this.baseAudit('approve', args, startedAt),
      result: 'success',
      details: this.baseDetails(args, {
        document_id: row.document_id,
        document_type: row.document_type,
        amount: row.amount,
        currency: row.currency,
        applied_record_id: appliedRecordId,
        completion_result: completionResult,
      }),
    });

    return { ok: true, code: 'ok', appliedRecordId };
  }

  /**
   * Atomic single-stage reject (no external write). Mirrors SyncErrorAssist's
   * `dispositionOnly` codepath at `:213` — single-stage is correct when there
   * is no external write to roll back on failure.
   */
  async rejectItem(args: {
    tenantId: string;
    approvalId: string;
    rejecterId: string;
    reason: string;
  }): Promise<RejectResult> {
    const startedAt = Date.now();
    const dispositioned = await this.repo.markRejected({
      tenantId: args.tenantId,
      approvalId: args.approvalId,
      userId: args.rejecterId,
      rejectionReason: args.reason,
    });
    if (!dispositioned) {
      const disposition = await this.repo.getDisposition(args.tenantId, args.approvalId);
      await this.safeAudit({
        ...this.baseAudit('reject', { ...args, approverId: args.rejecterId }, startedAt),
        result: 'failure',
        error_message: disposition ? 'already_dispositioned' : 'not_found',
        details: this.baseDetails(args, { reason: args.reason }),
      });
      return { ok: false, code: disposition ? 'already_dispositioned' : 'not_found' };
    }
    await this.safeAudit({
      ...this.baseAudit('reject', { ...args, approverId: args.rejecterId }, startedAt),
      result: 'success',
      details: this.baseDetails(args, { reason: args.reason }),
    });
    return { ok: true, code: 'ok' };
  }

  private baseAudit(
    verb: 'approve' | 'reject',
    args: { tenantId: string; approvalId: string; approverId: string },
    startedAt: number,
  ): Omit<NewAuditLog, 'result' | 'details' | 'error_message'> & { error_message: null } {
    return {
      tenant_id: args.tenantId,
      user_id: args.approverId,
      action: `finance_central.${verb}`,
      resource_type: 'finance_central_approval',
      resource_id: args.approvalId,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  }

  private baseDetails(
    args: { approvalId: string },
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return { approval_id: args.approvalId, ...extra };
  }

  private async safeAudit(entry: NewAuditLog): Promise<void> {
    try {
      await this.auditLog.create(entry);
    } catch (err) {
      this.logger.warn('audit log write failed for finance-central operator action', {
        action: entry.action,
        resource_id: entry.resource_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
