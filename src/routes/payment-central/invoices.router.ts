import * as express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { PaymentCentralService } from '../../services/PaymentCentralService';
import type { CreditMemo, InvoiceDispute, InvoiceMatchStatus, InvoicePaymentStatus } from '../../types/invoice';
import { resolveActor } from '../../services/governance/resolveActor';
import { extractIdentityContext } from '../../services/governance/identityContext';

const router = express.Router();

function getPaymentService(): PaymentCentralService {
  return container.get<PaymentCentralService>(TYPES.PaymentCentralService);
}

// ==================== Filter validation helpers ====================
//
// Query strings arrive untyped. The previous implementation forwarded
// `parseInt`/`parseFloat` results into the service contract without a
// `Number.isFinite` check (so `?dateFrom=junk` propagated `NaN` into
// downstream storage queries) and built status arrays via a plain
// `as InvoiceMatchStatus[]` cast (so `?matchStatus=ANYTHING` reached
// the service unchanged). This module guards both vectors.
//
// Pattern follows `routes/aiMapping.ts`'s `InvalidSchemaResult` sentinel:
// each helper returns either a validated individual value (number, typed
// status array), `undefined` when the param is absent, or an
// `InvalidQueryResult` instance. Callers narrow with `instanceof`
// because the project's `strict: false` tsconfig does not reliably
// narrow discriminated unions.
//
// Numeric helpers use strict regex parsing (NOT parseInt/parseFloat) so
// values like `?limit=10foo`, `?dateFrom=123abc`, `?limit=1e2`, and
// `?offset=12.7` are rejected with 400 instead of being coerced into
// surprising integers (parseInt('123abc', 10) === 123).

class InvalidQueryResult {
  constructor(public readonly message: string) {}
}

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;
const STRICT_INT_RE = /^\d+$/;
const STRICT_FLOAT_RE = /^\d+(?:\.\d+)?$/;

const INVOICE_MATCH_STATUSES: readonly InvoiceMatchStatus[] = [
  'pending', 'matched', 'partial', 'disputed', 'approved', 'rejected',
];
const INVOICE_PAYMENT_STATUSES: readonly InvoicePaymentStatus[] = [
  'unpaid', 'scheduled', 'processing', 'paid', 'held', 'cancelled',
];
const INVOICE_DISPUTE_STATUSES: readonly InvoiceDispute['status'][] = [
  'open', 'investigating', 'pending_vendor', 'resolved', 'closed',
];
const CREDIT_MEMO_STATUSES: readonly CreditMemo['status'][] = [
  'draft', 'pending_approval', 'approved', 'applied', 'cancelled',
];

/**
 * Parse a non-negative integer query param. Strict: rejects partial
 * matches like `?dateFrom=123abc` (parseInt would return 123) or
 * scientific notation like `?dateFrom=1e2`. Returns InvalidQueryResult
 * on bad input — never silently defaults, because that would let
 * `?dateFrom=junk` reach the service with `NaN`.
 */
function parseNonNegativeInt(
  raw: unknown,
  paramName: string,
): number | undefined | InvalidQueryResult {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !STRICT_INT_RE.test(raw)) {
    return new InvalidQueryResult(`${paramName} must be a non-negative integer`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return new InvalidQueryResult(`${paramName} must be a finite non-negative integer`);
  }
  return parsed;
}

/**
 * Parse a non-negative decimal/float query param. Strict: rejects
 * `?amountMin=1.2xyz`, `?amountMin=1e2`, or trailing/leading garbage.
 */
function parseNonNegativeFloat(
  raw: unknown,
  paramName: string,
): number | undefined | InvalidQueryResult {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string' || !STRICT_FLOAT_RE.test(raw)) {
    return new InvalidQueryResult(`${paramName} must be a non-negative number`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return new InvalidQueryResult(`${paramName} must be a finite non-negative number`);
  }
  return parsed;
}

/**
 * Parse limit with cap and default. limit must be a strict integer in
 * [1, MAX_LIMIT]; if missing, default to DEFAULT_LIMIT.
 */
function parsePaginationLimit(raw: unknown): number | InvalidQueryResult {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  if (typeof raw !== 'string' || !STRICT_INT_RE.test(raw)) {
    return new InvalidQueryResult(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_LIMIT) {
    return new InvalidQueryResult(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return parsed;
}

/**
 * Parse offset as a strict non-negative integer; default to 0.
 */
function parsePaginationOffset(raw: unknown): number | InvalidQueryResult {
  if (raw === undefined || raw === null || raw === '') return 0;
  if (typeof raw !== 'string' || !STRICT_INT_RE.test(raw)) {
    return new InvalidQueryResult('offset must be a non-negative integer');
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    return new InvalidQueryResult('offset must be a finite non-negative integer');
  }
  return parsed;
}

/**
 * Validate a comma-separated enum array. Returns the typed array or an
 * InvalidQueryResult naming the first bad value. We reject (not silently
 * filter) so callers learn about typos.
 */
function parseEnumArray<T extends string>(
  raw: unknown,
  paramName: string,
  allowed: readonly T[],
): T[] | undefined | InvalidQueryResult {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    return new InvalidQueryResult(`${paramName} must be a comma-separated string`);
  }
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (parts.length === 0) {
    return new InvalidQueryResult(
      `${paramName} must contain at least one value; allowed values: ${allowed.join(', ')}`,
    );
  }
  const allowedSet = new Set<string>(allowed);
  for (const part of parts) {
    if (!allowedSet.has(part)) {
      return new InvalidQueryResult(
        `${paramName} contains invalid value "${part}"; allowed values: ${allowed.join(', ')}`,
      );
    }
  }
  return parts as T[];
}

router.get('/invoices', asyncHandler(async (req, res, next) => {
  const { vendorId, matchStatus, paymentStatus, dateFrom, dateTo, amountMin, amountMax, hasDispute, search, limit, offset } = req.query;

  const matchStatusResult = parseEnumArray(matchStatus, 'matchStatus', INVOICE_MATCH_STATUSES);
  if (matchStatusResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: matchStatusResult.message });
    return;
  }
  const paymentStatusResult = parseEnumArray(paymentStatus, 'paymentStatus', INVOICE_PAYMENT_STATUSES);
  if (paymentStatusResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: paymentStatusResult.message });
    return;
  }
  const dateFromResult = parseNonNegativeInt(dateFrom, 'dateFrom');
  if (dateFromResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: dateFromResult.message });
    return;
  }
  const dateToResult = parseNonNegativeInt(dateTo, 'dateTo');
  if (dateToResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: dateToResult.message });
    return;
  }
  const amountMinResult = parseNonNegativeFloat(amountMin, 'amountMin');
  if (amountMinResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: amountMinResult.message });
    return;
  }
  const amountMaxResult = parseNonNegativeFloat(amountMax, 'amountMax');
  if (amountMaxResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: amountMaxResult.message });
    return;
  }
  const limitResult = parsePaginationLimit(limit);
  if (limitResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: limitResult.message });
    return;
  }
  const offsetResult = parsePaginationOffset(offset);
  if (offsetResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: offsetResult.message });
    return;
  }

  const filters = {
    vendorId: vendorId as string | undefined,
    matchStatus: matchStatusResult,
    paymentStatus: paymentStatusResult,
    dateFrom: dateFromResult,
    dateTo: dateToResult,
    amountMin: amountMinResult,
    amountMax: amountMaxResult,
    hasDispute: hasDispute === 'true' ? true : hasDispute === 'false' ? false : undefined,
    search: search as string | undefined,
    limit: limitResult,
    offset: offsetResult,
  };

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().getInvoices(tenantId, filters);
  res.json(result);
}));

router.post('/invoices', asyncHandler(async (req, res, next) => {
  const body = req.body ?? {};
  const { vendorId, invoiceNumber, invoiceDate, dueDate, amount, taxAmount, currency, lineItems, notes, source } = body;

  if (!vendorId || !invoiceNumber || !amount || !lineItems) {
    res.status(400).json({ error: 'vendorId, invoiceNumber, amount, and lineItems are required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const invoice = await getPaymentService().createInvoice(tenantId, vendorId, {
    invoiceNumber,
    invoiceDate: invoiceDate || Date.now(),
    dueDate: dueDate || Date.now() + 30 * 24 * 60 * 60 * 1000,
    amount,
    taxAmount,
    currency,
    lineItems,
    notes,
    source,
  }, resolveActor(req, body.createdBy) ?? 'api');

  res.status(201).json(invoice);
}));

router.get('/invoices/statistics', asyncHandler(async (req, res, next) => {
  const { tenantId } = extractIdentityContext(req);
  const statistics = await getPaymentService().getInvoiceStatistics(tenantId);
  res.json(statistics);
}));

router.get('/invoices/:invoiceId', asyncHandler(async (req, res, next) => {
  const { invoiceId } = req.params;
  const { tenantId } = extractIdentityContext(req);

  const invoice = await getPaymentService().getInvoice(tenantId, invoiceId);
  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }

  res.json(invoice);
}));

router.post('/invoices/:invoiceId/match', asyncHandler(async (req, res, next) => {
  const { invoiceId } = req.params;
  const body = req.body ?? {};
  const { poId } = body;

  if (!poId) {
    res.status(400).json({ error: 'poId is required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().matchInvoiceToPO(tenantId, invoiceId, poId, resolveActor(req, body.matchedBy) ?? 'api');
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json(result);
}));

router.post('/invoices/:invoiceId/auto-match', asyncHandler(async (req, res, next) => {
  const { invoiceId } = req.params;
  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().autoMatchInvoice(tenantId, invoiceId);
  res.json(result);
}));

router.post('/invoices/:invoiceId/approve', asyncHandler(async (req, res, next) => {
  const { invoiceId } = req.params;
  const body = req.body ?? {};
  const approvedBy = resolveActor(req, body.approvedBy);
  if (!approvedBy) {
    res.status(400).json({ error: 'approvedBy is required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().approveInvoice(tenantId, invoiceId, approvedBy);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({ success: true, invoiceId });
}));

router.post('/invoices/:invoiceId/dispute', asyncHandler(async (req, res, next) => {
  const { invoiceId } = req.params;
  const body = req.body ?? {};
  const { reason, description } = body;
  const createdBy = resolveActor(req, body.createdBy);
  if (!reason || !description || !createdBy) {
    res.status(400).json({ error: 'reason, description, and createdBy are required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().createInvoiceDispute(tenantId, invoiceId, reason, description, createdBy);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.status(201).json(result.dispute);
}));

router.get('/disputes', asyncHandler(async (req, res, next) => {
  const { status, vendorId, limit, offset } = req.query;

  const statusResult = parseEnumArray(status, 'status', INVOICE_DISPUTE_STATUSES);
  if (statusResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: statusResult.message });
    return;
  }
  const limitResult = parsePaginationLimit(limit);
  if (limitResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: limitResult.message });
    return;
  }
  const offsetResult = parsePaginationOffset(offset);
  if (offsetResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: offsetResult.message });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().getDisputes(tenantId, {
    status: statusResult,
    vendorId: vendorId as string | undefined,
    limit: limitResult,
    offset: offsetResult,
  });

  res.json(result);
}));

router.post('/disputes/:disputeId/resolve', asyncHandler(async (req, res, next) => {
  const { disputeId } = req.params;
  const body = req.body ?? {};
  const { type, description, adjustedAmount } = body;
  const resolvedBy = resolveActor(req, body.resolvedBy);

  if (!type || !description || !resolvedBy) {
    res.status(400).json({ error: 'type, description, and resolvedBy are required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().resolveDispute(tenantId, disputeId, { type, description, adjustedAmount }, resolvedBy);
  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({ success: true, creditMemo: result.creditMemo });
}));

router.get('/credit-memos', asyncHandler(async (req, res, next) => {
  const { vendorId, status, limit, offset } = req.query;

  const statusResult = parseEnumArray(status, 'status', CREDIT_MEMO_STATUSES);
  if (statusResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: statusResult.message });
    return;
  }
  const limitResult = parsePaginationLimit(limit);
  if (limitResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: limitResult.message });
    return;
  }
  const offsetResult = parsePaginationOffset(offset);
  if (offsetResult instanceof InvalidQueryResult) {
    res.status(400).json({ error: offsetResult.message });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const result = await getPaymentService().getCreditMemos(tenantId, {
    vendorId: vendorId as string | undefined,
    status: statusResult,
    limit: limitResult,
    offset: offsetResult,
  });

  res.json(result);
}));

router.post('/credit-memos', asyncHandler(async (req, res, next) => {
  const body = req.body ?? {};
  const { invoiceId, amount, reason } = body;
  const createdBy = resolveActor(req, body.createdBy);
  if (!invoiceId || !amount || !reason || !createdBy) {
    res.status(400).json({ error: 'invoiceId, amount, reason, and createdBy are required' });
    return;
  }

  const { tenantId } = extractIdentityContext(req);
  const creditMemo = await getPaymentService().createCreditMemo(tenantId, invoiceId, amount, reason, createdBy);
  res.status(201).json(creditMemo);
}));

export { router as paymentCentralInvoicesRouter };
