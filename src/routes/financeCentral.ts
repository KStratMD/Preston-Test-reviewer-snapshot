import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { FinanceCentralService } from '../services/FinanceCentralService';
import type { FinanceCentralOperatorService } from '../services/financeCentral/FinanceCentralOperatorService';
import type { ApprovalResultCode } from '../services/financeCentral/types';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { handleApprovalQueueError } from '../middleware/governance/approvalQueueErrorHandler';

const router = express.Router();

/**
 * Get FinanceCentralService from DI container
 */
// PR 6 (operator-promotion T7): FinanceCentralService now injects the
// operator service which transitively depends on async-bound DatabaseService,
// so resolution must go through getAsync. Singleton scope caches the instance,
// so the cost is paid only on the first cold-start request.
async function getService(): Promise<FinanceCentralService> {
  return container.getAsync<FinanceCentralService>(TYPES.FinanceCentralService);
}

async function getOperatorService(): Promise<FinanceCentralOperatorService> {
  return container.getAsync<FinanceCentralOperatorService>(TYPES.FinanceCentralOperatorService);
}

// Spec §2.D7: operator-result-code → HTTP-status mapping.
// `state_drift` (PR 6 R2 / Codex BM-1) maps to 500 — internal-state
// inconsistency requiring manual reconciliation; not a client error and not
// retryable as-is.
const RESULT_CODE_HTTP_STATUS: Record<Exclude<ApprovalResultCode, 'ok'>, number> = {
  not_found: 404,
  already_dispositioned: 409,
  connector_unavailable: 503,
  write_failed: 502,
  state_drift: 500,
};

/**
 * FinanceCentral Dashboard API
 * GET /api/finance-central/dashboard
 * Returns comprehensive financial dashboard with cash position, AR/AP aging, metrics
 */
router.get('/dashboard', asyncHandler(async (req, res) => {
  const service = await getService();
  const { tenantId } = extractIdentityContext(req);
  const dashboard = await service.getDashboard(tenantId);
  res.json(dashboard);
}));

/**
 * Health check endpoint
 * GET /api/finance-central/health
 */
router.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'finance-central' });
});

/**
 * Get current cash position
 * GET /api/finance-central/cash-position
 */
router.get('/cash-position', asyncHandler(async (req, res) => {
  const service = await getService();
  const cashPosition = await service.getCashPosition();
  res.json(cashPosition);
}));

/**
 * Get AR Aging Report
 * GET /api/finance-central/ar-aging
 */
router.get('/ar-aging', asyncHandler(async (req, res) => {
  const service = await getService();
  const arAging = await service.getARAgingReport();
  res.json(arAging);
}));

/**
 * Get AP Aging Report
 * GET /api/finance-central/ap-aging
 */
router.get('/ap-aging', asyncHandler(async (req, res) => {
  const service = await getService();
  const apAging = await service.getAPAgingReport();
  res.json(apAging);
}));

/**
 * Get financial metrics
 * GET /api/finance-central/metrics
 */
router.get('/metrics', asyncHandler(async (req, res) => {
  const service = await getService();
  const metrics = await service.calculateFinancialMetrics();
  res.json(metrics);
}));

/**
 * Get cash flow forecast
 * GET /api/finance-central/cash-flow
 * Query params: weeks (default: 4)
 */
router.get('/cash-flow', asyncHandler(async (req, res) => {
  const service = await getService();
  const weeks = parseInt(req.query.weeks as string) || 4;
  const forecast = await service.getCashFlowForecast(weeks);
  res.json(forecast);
}));

/**
 * Get pending approvals
 * GET /api/finance-central/approvals
 * Query params: type, priority, approver
 */
router.get('/approvals', asyncHandler(async (req, res) => {
  const operator = await getOperatorService();
  const { tenantId } = extractIdentityContext(req);

  const filters: {
    type?: 'invoice' | 'bill' | 'purchase_order' | 'expense_report' | 'journal_entry';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    approver?: string;
  } = {};

  if (req.query.type) {
    filters.type = req.query.type as NonNullable<typeof filters.type>;
  }
  if (req.query.priority) {
    filters.priority = req.query.priority as NonNullable<typeof filters.priority>;
  }
  if (req.query.approver) {
    filters.approver = req.query.approver as string;
  }

  const approvals = await operator.listPendingApprovals({ tenantId, filters });
  res.json(approvals);
}));

/**
 * Approve a pending item
 * POST /api/finance-central/approvals/:id/approve
 * Body: { approverId, comments? }
 */
router.post('/approvals/:id/approve', asyncHandler(async (req, res) => {
  const operator = await getOperatorService();
  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);
  const { approverId: bodyApproverId, comments } = req.body;

  // PR 6 R4 (Copilot — security): prefer the authenticated identity over a
  // client-supplied approverId to prevent audit/lease-isolation spoofing.
  // PR 6 R5 (Copilot edge case): body is trusted ONLY when BOTH fields are
  // SYSTEM_IDENTITY. The mixed state {tenantId: real, userId: SYSTEM} can
  // arise from extractIdentityContext when req.auth has a tenant but no
  // user.sub/apiKey.createdBy — in that case, accepting bodyApproverId
  // would let a client claim any identity under the authed tenant. Honest
  // policy: audit shows ctx.userId (even if SYSTEM) once auth is engaged.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const approverId = isPreAuth ? bodyApproverId : ctxUserId;

  // PR 6 R7 (Copilot): validate body-sourced fields as strings before they
  // reach the operator service / DB / audit log. Pre-auth `bodyApproverId`
  // is untrusted client input and a truthy check alone would let an object
  // or number through into `operator_disposition_user_id` and the audit
  // trail's `user_id` column.
  if (typeof approverId !== 'string' || approverId.trim().length === 0) {
    res.status(400).json({ ok: false, code: 'invalid_request', message: 'approverId is required (must be a non-empty string)' });
    return;
  }
  if (comments !== undefined && typeof comments !== 'string') {
    res.status(400).json({ ok: false, code: 'invalid_request', message: 'comments must be a string when provided' });
    return;
  }

  try {
    const result = await operator.approveItem({
      tenantId,
      approvalId: req.params.id,
      approverId,
      comments,
    });
    if (result.ok === false) {
      res.status(RESULT_CODE_HTTP_STATUS[result.code]).json(result);
      return;
    }
    res.json(result);
  } catch (error) {
    if (await handleApprovalQueueError(error, req, res, {
      operationType: 'connector_write',
      resourceType: 'finance_central.approval.approve',
      resourceId: req.params.id,
    })) return;
    throw error;
  }
}));

/**
 * Reject a pending item
 * POST /api/finance-central/approvals/:id/reject
 * Body: { rejecterId, reason }
 */
router.post('/approvals/:id/reject', asyncHandler(async (req, res) => {
  const operator = await getOperatorService();
  const { tenantId, userId: ctxUserId } = extractIdentityContext(req);
  const { rejecterId: bodyRejecterId, reason } = req.body;

  // PR 6 R4 + R5 (Copilot): mirror the approve-path policy. Body is trusted
  // ONLY when BOTH ctx fields are SYSTEM_IDENTITY (pre-auth demo state).
  // See the /approve route above for the mixed-auth edge case rationale.
  const isPreAuth = tenantId === SYSTEM_IDENTITY.tenantId && ctxUserId === SYSTEM_IDENTITY.userId;
  const rejecterId = isPreAuth ? bodyRejecterId : ctxUserId;

  // PR 6 R7 (Copilot): validate body-sourced fields. Pre-auth `bodyRejecterId`
  // and `reason` are untrusted client input — truthy alone allowed non-strings
  // to flow into `operator_disposition_user_id` and `rejection_reason`.
  if (typeof rejecterId !== 'string' || rejecterId.trim().length === 0) {
    res.status(400).json({ ok: false, code: 'invalid_request', message: 'rejecterId is required (must be a non-empty string)' });
    return;
  }
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    res.status(400).json({ ok: false, code: 'invalid_request', message: 'reason is required (must be a non-empty string)' });
    return;
  }

  const result = await operator.rejectItem({
    tenantId,
    approvalId: req.params.id,
    rejecterId,
    reason,
  });
  if (result.ok === false) {
    res.status(RESULT_CODE_HTTP_STATUS[result.code]).json(result);
    return;
  }
  res.json(result);
}));

/**
 * Get GL accounts
 * GET /api/finance-central/gl-accounts
 * Query params: type, isActive
 */
router.get('/gl-accounts', asyncHandler(async (req, res) => {
  const service = await getService();
  const filters: {
    type?: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
    isActive?: boolean;
  } = {};

  if (req.query.type) {
    filters.type = req.query.type as typeof filters.type;
  }
  if (req.query.isActive !== undefined) {
    filters.isActive = req.query.isActive === 'true';
  }

  const accounts = await service.getGLAccounts(filters);
  res.json(accounts);
}));

/**
 * Get consolidated financial summary
 * GET /api/finance-central/consolidated
 */
router.get('/consolidated', asyncHandler(async (req, res) => {
  const service = await getService();
  const summary = await service.getConsolidatedSummary();
  res.json(summary);
}));

/**
 * Get period close status
 * GET /api/finance-central/period-close
 * Query params: periodId (optional)
 */
router.get('/period-close', asyncHandler(async (req, res) => {
  const service = await getService();
  const periodId = req.query.periodId as string | undefined;
  const status = await service.getPeriodCloseStatus(periodId);
  res.json(status);
}));

/**
 * Get financial documents (invoices/bills)
 * GET /api/finance-central/documents
 * Query params: type, status, entityId, minAmount, maxAmount
 */
router.get('/documents', asyncHandler(async (req, res) => {
  const service = await getService();
  const filters: {
    type?: 'invoice' | 'bill';
    status?: 'open' | 'partial' | 'paid' | 'overdue' | 'voided' | 'disputed';
    entityId?: string;
    minAmount?: number;
    maxAmount?: number;
  } = {};

  if (req.query.type) {
    filters.type = req.query.type as typeof filters.type;
  }
  if (req.query.status) {
    filters.status = req.query.status as typeof filters.status;
  }
  if (req.query.entityId) {
    filters.entityId = req.query.entityId as string;
  }
  if (req.query.minAmount) {
    filters.minAmount = parseFloat(req.query.minAmount as string);
  }
  if (req.query.maxAmount) {
    filters.maxAmount = parseFloat(req.query.maxAmount as string);
  }

  const documents = await service.getFinancialDocuments(filters);
  res.json(documents);
}));

/**
 * Record a payment
 * POST /api/finance-central/documents/:id/payment
 * Body: { amount, paymentDate, paymentMethod, reference? }
 */
router.post('/documents/:id/payment', asyncHandler(async (req, res) => {
  const service = await getService();
  const { amount, paymentDate, paymentMethod, reference } = req.body;

  if (!amount || !paymentDate || !paymentMethod) {
    res.status(400).json({ success: false, message: 'amount, paymentDate, and paymentMethod are required' });
    return;
  }

  const result = await service.recordPayment(
    req.params.id,
    amount,
    new Date(paymentDate).getTime(),
    paymentMethod,
    reference
  );

  res.json(result);
}));

export { router as financeCentralRouter };
