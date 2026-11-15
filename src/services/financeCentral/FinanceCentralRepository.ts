import { randomUUID } from 'crypto';
import { inject, injectable } from 'inversify';
import { sql } from 'kysely';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type {
  ApprovalDisposition,
  ApprovalPriority,
  DocumentType,
  PendingApprovalView,
} from './types';

@injectable()
export class FinanceCentralRepository {
  constructor(@inject(TYPES.DatabaseService) private db: DatabaseService) {}

  // ------- Read path -----------------------------------------------------

  async getRowByApprovalId(tenantId: string, approvalId: string) {
    const row = await this.db.getDatabase()
      .selectFrom('finance_central_approvals')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('approval_id', '=', approvalId)
      .executeTakeFirst();
    return row ?? null;
  }

  /**
   * List pending approvals for a tenant, sorted by priority then submitted_at.
   *
   * Sort + limit are pushed to SQL so the DB can use the
   * `(tenant_id, operator_disposition)` index plan and avoid pulling every
   * pending row into the application. Priority ordering matches the
   * enum semantics (urgent > high > medium > low); within a priority, the
   * oldest submission comes first (equivalent to the prior JS sort of
   * `daysWaiting DESC` since `daysWaiting` is monotone in `submitted_at`).
   *
   * `daysWaiting` is still computed at read time per spec §2.D5 F-04 (storing
   * it would create staleness drift). The CASE expression is portable across
   * SQLite and Postgres.
   */
  async listPendingApprovals(args: {
    tenantId: string;
    limit?: number;
    filters?: {
      type?: DocumentType;
      priority?: ApprovalPriority;
      approver?: string;
    };
  }): Promise<PendingApprovalView[]> {
    let q = this.db.getDatabase()
      .selectFrom('finance_central_approvals')
      .selectAll()
      .where('tenant_id', '=', args.tenantId)
      .where('operator_disposition', '=', 'pending');

    if (args.filters?.type) {
      q = q.where('document_type', '=', args.filters.type);
    }
    if (args.filters?.priority) {
      q = q.where('priority', '=', args.filters.priority);
    }
    if (args.filters?.approver) {
      q = q.where('current_approver', '=', args.filters.approver);
    }

    q = q
      .orderBy(
        sql<number>`CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
        'asc',
      )
      .orderBy('submitted_at', 'asc');

    if (args.limit !== undefined) {
      q = q.limit(args.limit);
    }

    const rows = await q.execute();
    const now = Date.now();

    return rows.map((r) => {
      const submittedAtEpoch = Date.parse(r.submitted_at);
      const daysWaiting = Number.isFinite(submittedAtEpoch)
        ? Math.max(0, Math.floor((now - submittedAtEpoch) / 86_400_000))
        : 0;
      return {
        id: r.approval_id,
        type: r.document_type as DocumentType,
        documentNumber: r.document_number,
        description: r.description,
        entityName: r.entity_name ?? undefined,
        employeeName: r.employee_name ?? undefined,
        // Postgres `DECIMAL(15,2)` is returned by pg as a string; SQLite REAL
        // is returned as a number. The Kysely type pins `number` but only
        // SQLite honors it at runtime. Coerce here so the view shape is
        // consistent across both backends (Codex R1 SHOULD-CHANGE).
        amount: Number(r.amount),
        currency: r.currency,
        submittedBy: r.submitted_by,
        submittedAt: Number.isFinite(submittedAtEpoch) ? submittedAtEpoch : 0,
        daysWaiting,
        currentApprover: r.current_approver,
        approvalLevel: r.approval_level,
        priority: r.priority as ApprovalPriority,
        netSuiteId: r.netsuite_id ?? undefined,
      };
    });
  }

  // ------- Insert (used by demoSeed + future submission paths) -----------

  /**
   * Idempotent insert: rows that already exist (matched by tenant_id +
   * approval_id) are left untouched. Returns true if a new row was inserted.
   */
  async insertIfMissing(row: {
    tenantId: string;
    approvalId: string;
    documentId: string;
    documentNumber: string;
    documentType: DocumentType;
    description: string;
    entityName?: string;
    employeeName?: string;
    amount: number;
    currency: string;
    submittedBy: string;
    submittedAt: string; // ISO8601
    currentApprover: string;
    approvalLevel: number;
    priority: ApprovalPriority;
    netSuiteId?: string;
  }): Promise<boolean> {
    const id = randomUUID();
    const now = new Date().toISOString();
    const result = await this.db.getDatabase()
      .insertInto('finance_central_approvals')
      .values({
        id,
        tenant_id: row.tenantId,
        approval_id: row.approvalId,
        document_id: row.documentId,
        document_number: row.documentNumber,
        document_type: row.documentType,
        description: row.description,
        entity_name: row.entityName ?? null,
        employee_name: row.employeeName ?? null,
        amount: row.amount,
        currency: row.currency,
        submitted_by: row.submittedBy,
        submitted_at: row.submittedAt,
        current_approver: row.currentApprover,
        approval_level: row.approvalLevel,
        priority: row.priority,
        netsuite_id: row.netSuiteId ?? null,
        operator_disposition: 'pending',
        operator_disposition_at: null,
        operator_disposition_user_id: null,
        applied_record_id: null,
        rejection_reason: null,
        approval_comments: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict((oc) => oc.columns(['tenant_id', 'approval_id']).doNothing())
      .execute();
    const inserted = result.reduce((sum, r) => sum + Number(r.numInsertedOrUpdatedRows ?? 0), 0);
    return inserted > 0;
  }

  // ------- Operator-disposition state machine ----------------------------

  /**
   * Acquire the accept-lease: atomic transition pending → applying.
   * Returns true iff THIS caller won the race. The caller must follow with
   * EITHER completeAccept (success) OR revertToPending (failure) so the lease
   * does not leak. Stamping userId + timestamp here gives the audit trail an
   * accurate "who started the accept" marker independent of completion.
   *
   * FC variant has NO `status='succeeded'` precondition (unlike SyncErrorAssist):
   * FC approvals are inserted directly as `pending`, no upstream pipeline.
   */
  async beginAccept(args: {
    tenantId: string;
    approvalId: string;
    userId: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.getDatabase()
      .updateTable('finance_central_approvals')
      .set({
        operator_disposition: 'applying',
        operator_disposition_at: now,
        operator_disposition_user_id: args.userId,
        updated_at: now,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('approval_id', '=', args.approvalId)
      .where('operator_disposition', '=', 'pending')
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Release the accept-lease as success: applying → accepted, with
   * `applied_record_id` + `approval_comments` set.
   *
   * Lease isolation: the WHERE clause requires `operator_disposition_user_id`
   * to match the caller's userId. Only the user who acquired the lease via
   * beginAccept can complete it.
   */
  async completeAccept(args: {
    tenantId: string;
    approvalId: string;
    userId: string;
    appliedRecordId: string;
    approvalComments?: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.getDatabase()
      .updateTable('finance_central_approvals')
      .set({
        operator_disposition: 'accepted',
        operator_disposition_at: now,
        applied_record_id: args.appliedRecordId,
        approval_comments: args.approvalComments ?? null,
        updated_at: now,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('approval_id', '=', args.approvalId)
      .where('operator_disposition', '=', 'applying')
      .where('operator_disposition_user_id', '=', args.userId)
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Release the accept-lease as failure: applying → pending (caller may retry).
   *
   * Lease isolation (mirrors completeAccept): only the user who acquired the
   * lease can revert it. A wrong-holder revert returns false; the row stays
   * in 'applying' state for the actual lease holder to resolve.
   *
   * Lease metadata (`operator_disposition_user_id`, `operator_disposition_at`)
   * is cleared on revert so a re-attempting operator does not see stale
   * holder/timestamp data on a row that is once again `pending` (Copilot R2).
   */
  async revertToPending(args: {
    tenantId: string;
    approvalId: string;
    userId: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.getDatabase()
      .updateTable('finance_central_approvals')
      .set({
        operator_disposition: 'pending',
        operator_disposition_user_id: null,
        operator_disposition_at: null,
        updated_at: now,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('approval_id', '=', args.approvalId)
      .where('operator_disposition', '=', 'applying')
      .where('operator_disposition_user_id', '=', args.userId)
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Atomic single-stage transition pending → rejected.
   *
   * Only `rejected` is supported in v1 (FC has no `escalated` equivalent of
   * the SyncErrorAssist surface). Pattern mirrors `markDisposition` in
   * `SyncErrorAssistRepository.ts:470` for narrow contract: callers must
   * already have validated the disposition value.
   */
  async markRejected(args: {
    tenantId: string;
    approvalId: string;
    userId: string;
    rejectionReason: string;
  }): Promise<boolean> {
    const now = new Date().toISOString();
    const result = await this.db.getDatabase()
      .updateTable('finance_central_approvals')
      .set({
        operator_disposition: 'rejected',
        operator_disposition_at: now,
        operator_disposition_user_id: args.userId,
        rejection_reason: args.rejectionReason,
        updated_at: now,
      })
      .where('tenant_id', '=', args.tenantId)
      .where('approval_id', '=', args.approvalId)
      .where('operator_disposition', '=', 'pending')
      .execute();
    const updated = result.reduce((sum, r) => sum + Number(r.numUpdatedRows ?? 0), 0);
    return updated > 0;
  }

  /**
   * Resolve a `disposition` from a row for failure-mode disambiguation.
   * Used by the service layer when beginAccept/markRejected returns false —
   * the row either doesn't exist (`not_found`) or is past `pending`
   * (`already_dispositioned`).
   */
  async getDisposition(tenantId: string, approvalId: string): Promise<ApprovalDisposition | null> {
    const row = await this.db.getDatabase()
      .selectFrom('finance_central_approvals')
      .select('operator_disposition')
      .where('tenant_id', '=', tenantId)
      .where('approval_id', '=', approvalId)
      .executeTakeFirst();
    if (!row) return null;
    return row.operator_disposition as ApprovalDisposition;
  }
}
