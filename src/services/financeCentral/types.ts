// Types for FinanceCentralOperatorService.
// See docs/plans/2026-05-13-operator-promotion-spec.md for design rationale.

export type ApprovalDisposition = 'pending' | 'applying' | 'accepted' | 'rejected';

export type DocumentType =
  | 'invoice'
  | 'bill'
  | 'purchase_order'
  | 'expense_report'
  | 'journal_entry';

export type ApprovalPriority = 'low' | 'medium' | 'high' | 'urgent';

export type ApprovalResultCode =
  | 'ok'
  | 'not_found'
  | 'already_dispositioned'
  | 'write_failed'
  | 'connector_unavailable'
  | 'state_drift';

// Distinct per-method result types so callers narrow correctly. ApproveResult's
// success branch carries the non-optional `appliedRecordId` (D3a); RejectResult's
// success branch does not. PR 6 R2: replaces the prior union that shared the
// `code: 'ok'` discriminant between approve/reject success and so could not be
// narrowed by consumers — Codex+Copilot R2 both flagged this.
export type ApproveResult =
  | { ok: true; code: 'ok'; appliedRecordId: string }
  | { ok: false; code: Exclude<ApprovalResultCode, 'ok'>; message?: string };

// rejectItem is single-stage with no external write, so it can only race-fail
// on the disposition transition (markRejected). Narrowing the failure-code
// union prevents callers from handling impossible modes like `write_failed`
// or `state_drift` (PR 6 R10 / Copilot).
export type RejectResult =
  | { ok: true; code: 'ok' }
  | { ok: false; code: 'not_found' | 'already_dispositioned'; message?: string };

// Back-compat alias: external callers (NLActionGateService dispatch path) just
// check `result.ok`/`result.code` and don't need the per-method narrow.
export type ApprovalResult = ApproveResult | RejectResult;

// Caller-facing row shape returned by listPendingApprovals — daysWaiting is
// computed at read time from submitted_at (spec §2.D5 F-04).
export interface PendingApprovalView {
  id: string;
  type: DocumentType;
  documentNumber: string;
  description: string;
  entityName?: string;
  employeeName?: string;
  amount: number;
  currency: string;
  submittedBy: string;
  submittedAt: number;       // epoch-ms, derived from row.submitted_at
  daysWaiting: number;       // computed at read time
  currentApprover: string;
  approvalLevel: number;
  priority: ApprovalPriority;
  netSuiteId?: string;
}
