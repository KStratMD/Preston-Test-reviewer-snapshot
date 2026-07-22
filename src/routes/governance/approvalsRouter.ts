// HITL approval-queue operator API.
//
// PR 3B shipped the read-only slice (`GET /:id`) so the `pollUrl` returned
// in 202 bodies is functional immediately. PR 3C adds the operator surface:
//
//   GET  /                    — tenant-scoped pending list
//   POST /:id/approve         — CAS to 'approved', fires resume worker
//   POST /:id/reject          — CAS to 'rejected' (reason required)
//
// The new endpoints are gated by `validateGuestContext` (embedded session +
// same-origin) AND `requireApproverRole` (user_roles JSON array contains
// 'approver' OR 'admin'). Tenant identity comes from the embedded session
// (`res.locals.embeddedSession.tenant_id`), NOT from the JWT — the operator
// UI runs inside the iframe with a tenant-scoped session.
//
// The existing `GET /:id` keeps its pre-3C auth posture (any authenticated
// caller can poll their own tenant's pendingApprovalId). It's the polling
// endpoint for server-to-server callers that received a 202; the operator
// UI gets full row data from the list endpoint and doesn't need single-row
// reads.

import express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { ApprovalQueueService } from '../../services/governance/ApprovalQueueService';
import {
  APPROVAL_LIST_DEFAULT_LIMIT,
  APPROVAL_LIST_MAX_LIMIT,
  APPROVAL_LIST_MIN_LIMIT,
  InvalidLimitError,
  InvalidOffsetError,
  type PersistedApproval,
} from '../../services/governance/ApprovalQueueRepository';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../../services/governance/identityContext';
import { handleApprovalQueueError } from '../../middleware/governance/approvalQueueErrorHandler';
import { validateGuestContext } from '../../middleware/embeddedAuthMiddleware';
import { InvalidDecisionError } from '../../services/governance/ApprovalQueueErrors';
// Shared embedded-session auth helpers — extracted in PR 13b so the new
// operationsRouter (read-only governance dashboards) can reuse the exact same
// role gate. See `_governanceAuth.ts` header for the failure-mode contract.
import { readEmbeddedSession, requireAdminRole, requireApproverRole } from './_governanceAuth';

const router = express.Router();

async function getApprovalQueueService(): Promise<ApprovalQueueService> {
  return container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
}

// ────────────────────────────────────────────────────────────────────
// Input-shape helpers
//
// Returns are designed for `strict: false` narrowing: a single object with
// `value` and `error` both present (one null), so consumer code does
// `if (result.error !== null)` to detect failure, then trusts `result.value`.
// Per [[feedback-copilot-input-shape-waves]], enumerate query-param shapes
// UPFRONT: array, undefined, empty, whitespace, non-numeric, decimal,
// out-of-range.
// ────────────────────────────────────────────────────────────────────

interface ParseResult<T> {
  value: T;
  error: string | null;
}

/**
 * Pick a single string from `req.query`. Express parses `?status=a&status=b`
 * as `['a','b']` and complex shapes as `ParsedQs`; both fail here. Returns
 * `undefined` for missing — caller decides whether undefined is allowed.
 */
function singleQueryString(raw: unknown): ParseResult<string | undefined> {
  if (raw === undefined) return { value: undefined, error: null };
  if (typeof raw === 'string') return { value: raw, error: null };
  return { value: undefined, error: 'must be a single string value' };
}

function parseLimit(raw: unknown): ParseResult<number | undefined> {
  const single = singleQueryString(raw);
  if (single.error !== null) return { value: undefined, error: `limit ${single.error}` };
  if (single.value === undefined) return { value: undefined, error: null };
  const trimmed = single.value.trim();
  if (trimmed.length === 0) {
    return {
      value: undefined,
      error: `limit must be an integer in [${APPROVAL_LIST_MIN_LIMIT}, ${APPROVAL_LIST_MAX_LIMIT}]; received empty string`,
    };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return {
      value: undefined,
      error: `limit must be an integer in [${APPROVAL_LIST_MIN_LIMIT}, ${APPROVAL_LIST_MAX_LIMIT}]; received ${trimmed}`,
    };
  }
  if (!Number.isInteger(n)) {
    return {
      value: undefined,
      error: `limit must be an integer in [${APPROVAL_LIST_MIN_LIMIT}, ${APPROVAL_LIST_MAX_LIMIT}]; received non-integer ${trimmed}`,
    };
  }
  // Copilot R1.1 — enforce the documented [MIN, MAX] range at the route
  // boundary so out-of-range inputs 400 here instead of falling through to
  // ApprovalQueueRepository.validateLimit() after DI resolution. The
  // repo-level catch in the handler below is retained as defense in depth.
  if (n < APPROVAL_LIST_MIN_LIMIT || n > APPROVAL_LIST_MAX_LIMIT) {
    return {
      value: undefined,
      error: `limit must be an integer in [${APPROVAL_LIST_MIN_LIMIT}, ${APPROVAL_LIST_MAX_LIMIT}]; received ${n}`,
    };
  }
  return { value: n, error: null };
}

function parseOffset(raw: unknown): ParseResult<number | undefined> {
  const single = singleQueryString(raw);
  if (single.error !== null) return { value: undefined, error: `offset ${single.error}` };
  if (single.value === undefined) return { value: undefined, error: null };
  const trimmed = single.value.trim();
  if (trimmed.length === 0) {
    return { value: undefined, error: 'offset must be a non-negative integer; received empty string' };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return { value: undefined, error: `offset must be a non-negative integer; received ${trimmed}` };
  }
  if (!Number.isInteger(n)) {
    return { value: undefined, error: `offset must be a non-negative integer; received non-integer ${trimmed}` };
  }
  // Copilot R1.2 — enforce the documented non-negative constraint at the
  // route boundary so a `?offset=-1` request 400s here instead of falling
  // through to ApprovalQueueRepository.validateOffset() after DI resolution.
  // The repo-level catch in the handler below is retained as defense in depth.
  if (n < 0) {
    return { value: undefined, error: `offset must be a non-negative integer; received ${n}` };
  }
  return { value: n, error: null };
}

type ListStatus = 'pending' | 'approved' | 'rejected';
const LIST_STATUSES: ReadonlySet<string> = new Set(['pending', 'approved', 'rejected']);

type ListReason = 'ownership';
const LIST_REASONS: ReadonlySet<string> = new Set(['ownership']);

/**
 * Validate the optional `?reason=` query param (PR 13b C-30). Only one value
 * is currently accepted — `'ownership'` — which narrows the list to rows
 * whose `operationType === 'ownership_write'` (the operator dashboard's
 * "Pending Ownership Approvals" panel consumes this).
 *
 * Missing OR empty/whitespace both resolve to `undefined` (no filter), so
 * existing clients that omit the param keep working unchanged.
 */
function parseReason(raw: unknown): ParseResult<ListReason | undefined> {
  const single = singleQueryString(raw);
  if (single.error !== null) return { value: undefined, error: `reason ${single.error}` };
  if (single.value === undefined) return { value: undefined, error: null };
  const trimmed = single.value.trim();
  if (trimmed.length === 0) return { value: undefined, error: null };
  if (LIST_REASONS.has(trimmed)) {
    return { value: trimmed as ListReason, error: null };
  }
  return {
    value: undefined,
    error: `reason must be one of: ownership; received '${trimmed}'`,
  };
}

function parseRequiredBodyReason(rawBody: unknown): ParseResult<string> {
  if (!rawBody || typeof rawBody !== 'object' || !('reason' in rawBody)) {
    return { value: '', error: 'reason is required' };
  }
  const rawReason = (rawBody as { reason?: unknown }).reason;
  if (typeof rawReason !== 'string') {
    return { value: '', error: 'reason must be a string' };
  }
  const reason = rawReason.trim();
  if (reason.length === 0) {
    return { value: '', error: 'reason is required' };
  }
  return { value: reason, error: null };
}

/**
 * Validate the optional `?status=` query param. Accepts 'pending' (default),
 * 'approved', or 'rejected' — the three statuses the embedded approvals UI
 * exposes as tabs. 'expired' + 'all' are deferred follow-ups (the UI surfaces
 * the three operator-actionable states today; expired rows are an audit-trail
 * detail not yet wired into the tab strip).
 *
 * Missing OR empty/whitespace both default to 'pending' so clients that build
 * URLs with empty params don't 400.
 */
function parseStatus(raw: unknown): ParseResult<ListStatus> {
  const single = singleQueryString(raw);
  if (single.error !== null) return { value: 'pending', error: `status ${single.error}` };
  if (single.value === undefined) return { value: 'pending', error: null };
  const trimmed = single.value.trim();
  if (trimmed.length === 0) return { value: 'pending', error: null };
  if (LIST_STATUSES.has(trimmed)) {
    return { value: trimmed as ListStatus, error: null };
  }
  return {
    value: 'pending',
    error: `status must be one of: pending, approved, rejected; received '${trimmed}'`,
  };
}

interface BodyFieldResult {
  kind: 'present' | 'empty' | 'missing' | 'bad_shape';
  value: string;
}

/**
 * Pluck a string field from a JSON body. Four shapes the route distinguishes:
 *   - 'present' + trimmed value when the field is a non-empty string
 *   - 'empty' when present but empty/whitespace
 *   - 'missing' when the field is absent or undefined
 *   - 'bad_shape' when the field is array / object / non-string
 *
 * Routes use 'missing'/'empty' to drive `reason_required` and 'bad_shape' to
 * drive `invalid_reason` — different codes for different operator mistakes.
 */
function pluckStringBodyField(body: unknown, key: string): BodyFieldResult {
  if (body === null || body === undefined || typeof body !== 'object') {
    return { kind: 'missing', value: '' };
  }
  const record = body as Record<string, unknown>;
  if (!(key in record)) return { kind: 'missing', value: '' };
  const raw = record[key];
  if (raw === undefined) return { kind: 'missing', value: '' };
  if (typeof raw !== 'string') return { kind: 'bad_shape', value: '' };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { kind: 'empty', value: '' };
  return { kind: 'present', value: trimmed };
}

/**
 * Parse the optional `?counts_only=` query param. Truthy values
 * (`'1' | 'true' | 'yes'`, case-insensitive) make the route SKIP the
 * list query — it still echoes the normal response envelope
 * (`{ok, status, items, total, limit, offset, countsOnly}`) but with
 * `items: []` and only the count populated, so client-side response
 * handling stays uniform. Missing, empty, or any other value resolves
 * to `false`. Bad-shape (array of strings, object, etc.) ALSO resolves
 * to `false` silently — this flag is a UI optimisation, not a request
 * shape the operator builds by hand; rejecting bad shapes with 400
 * would be worse UX than ignoring them.
 */
function parseCountsOnly(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().toLowerCase();
  return trimmed === '1' || trimmed === 'true' || trimmed === 'yes';
}

/**
 * Validate the :id path param. Whitespace-only ids previously fell through to
 * the repository lookup and returned 404 "approval_not_found" — masking the
 * validation failure inside a downstream miss. Reject up front with 400.
 */
function validatePathId(id: unknown): ParseResult<string> {
  if (typeof id !== 'string' || id.trim().length === 0) {
    return { value: '', error: 'id path param required (non-empty, non-whitespace)' };
  }
  return { value: id, error: null };
}

// ────────────────────────────────────────────────────────────────────
// GET /  — tenant-scoped pending list (PR 3C)
// ────────────────────────────────────────────────────────────────────

router.get(
  '/',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }

    const statusResult = parseStatus(req.query.status);
    if (statusResult.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_status', message: statusResult.error });
      return;
    }
    const limitResult = parseLimit(req.query.limit);
    if (limitResult.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_limit', message: limitResult.error });
      return;
    }
    const offsetResult = parseOffset(req.query.offset);
    if (offsetResult.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_offset', message: offsetResult.error });
      return;
    }
    // PR 13b C-30: ?reason=ownership narrows the list to ownership_write rows.
    // Missing / empty → no filter (existing behaviour preserved).
    const reasonResult = parseReason(req.query.reason);
    if (reasonResult.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_reason', message: reasonResult.error });
      return;
    }

    // counts_only: when present and truthy, the route SKIPS the list
    // query and echoes the standard response envelope with `items: []`
    // (the count fields are still populated). Drives the embedded UI's
    // inactive-tab pill refreshes so they don't download `redactedPayload`
    // / `policyFindings` for rows they're not rendering. Copilot R4 on
    // PR #826 caught the prior `limit=1` fallback which still pulled a
    // full row. Accepted shapes: any single string that trims to a
    // recognised truthy value ('1', 'true', 'yes'); everything else is
    // treated as false (default).
    const countsOnly = parseCountsOnly(req.query.counts_only);

    const service = await getApprovalQueueService();
    const status = statusResult.value;
    const reason = reasonResult.value;
    try {
      const opts = { limit: limitResult.value, offset: offsetResult.value };
      // Dispatch on the validated status. Pending honours the expires_at TTL
      // gate via the service's listPending/countPending path; terminal
      // statuses (approved/rejected) go through the dedicated history methods.
      // Explicit types so `noImplicitAny` doesn't infer `any` for the
      // branch-assigned bindings (Copilot R3 on PR #826).
      let items: PersistedApproval[];
      let total: number;
      if (reason === 'ownership') {
        // Copilot R3 on PR #851 — push the operationType filter into the
        // SQL where clause instead of post-filtering in memory. The prior
        // implementation widened to APPROVAL_LIST_MAX_LIMIT (100) and
        // sliced after filtering, which silently undercounted
        // ownership_write rows whenever the tenant had >100 matching-status
        // approvals (the first 100 rows might all be ai_call / connector_write,
        // leaving the actual ownership_write rows in the unread tail).
        // Now the count and the list both filter on operation_type SQL-side,
        // so pagination and totals stay consistent at any page depth.
        const filterOpts = { ...opts, operationType: 'ownership_write' as const };
        if (countsOnly) {
          items = [];
        } else {
          items = status === 'pending'
            ? await service.listPending(session.tenant_id, filterOpts)
            : await service.listByTerminalStatus(session.tenant_id, status, filterOpts);
        }
        total = status === 'pending'
          ? await service.countPending(session.tenant_id, { operationType: 'ownership_write' })
          : await service.countByTerminalStatus(session.tenant_id, status, { operationType: 'ownership_write' });
      } else if (countsOnly) {
        // Skip the list query entirely. The empty `items: []` echoes the
        // contract shape so client-side response handling stays uniform.
        items = [];
        total = status === 'pending'
          ? await service.countPending(session.tenant_id)
          : await service.countByTerminalStatus(session.tenant_id, status);
      } else if (status === 'pending') {
        items = await service.listPending(session.tenant_id, opts);
        total = await service.countPending(session.tenant_id);
      } else {
        items = await service.listByTerminalStatus(session.tenant_id, status, opts);
        total = await service.countByTerminalStatus(session.tenant_id, status);
      }
      res.json({
        ok: true,
        status,
        items,
        total,
        limit: limitResult.value === undefined ? APPROVAL_LIST_DEFAULT_LIMIT : limitResult.value,
        offset: offsetResult.value === undefined ? 0 : offsetResult.value,
        countsOnly,
      });
    } catch (err) {
      if (err instanceof InvalidLimitError) {
        res.status(400).json({ ok: false, code: err.code, message: err.message });
        return;
      }
      if (err instanceof InvalidOffsetError) {
        res.status(400).json({ ok: false, code: err.code, message: err.message });
        return;
      }
      throw err;
    }
  }),
);

// ────────────────────────────────────────────────────────────────────
// GET /:id  — single-row poll (PR 3B; unchanged in 3C)
// ────────────────────────────────────────────────────────────────────

router.get('/:id', asyncHandler(async (req, res) => {
  const { tenantId } = extractIdentityContext(req);
  const idValidation = validatePathId(req.params.id);

  if (idValidation.error !== null) {
    res.status(400).json({ ok: false, code: 'invalid_id', message: idValidation.error });
    return;
  }

  // Fail-closed: refuse reads from unauthenticated callers (Codex 5.4 HIGH).
  // Without this gate, any caller who knows or guesses a pendingApprovalId
  // could read the full approval row. PR 4B mounted the central tenant gate
  // and PR 2C-Auth mounted optional JWT auth — real callers will pass the
  // gate when they bring a JWT.
  if (tenantId === SYSTEM_IDENTITY.tenantId) {
    res.status(401).json({
      ok: false,
      code: 'unauthenticated',
      message: 'authenticated identity required to read approval queue entries',
    });
    return;
  }

  const service = await getApprovalQueueService();

  try {
    const row = await service.getById(tenantId, idValidation.value);
    if (!row) {
      res.status(404).json({
        ok: false,
        code: 'approval_not_found',
        message: `approval not found: ${idValidation.value}`,
      });
      return;
    }
    res.json({ ok: true, approval: row });
  } catch (err) {
    if (
      await handleApprovalQueueError(err, req, res, {
        operationType: 'audit_log',
        resourceType: 'governance.approval.read',
        resourceId: idValidation.value,
      })
    ) {
      return;
    }
    throw err;
  }
}));

// ────────────────────────────────────────────────────────────────────
// POST /:id/approve  — operator approval (PR 3C)
// ────────────────────────────────────────────────────────────────────

router.post(
  '/:id/approve',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }
    const idValidation = validatePathId(req.params.id);
    if (idValidation.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_id', message: idValidation.error });
      return;
    }

    const reasonField = pluckStringBodyField(req.body, 'reason');
    if (reasonField.kind === 'bad_shape') {
      res.status(400).json({ ok: false, code: 'invalid_reason', message: 'reason must be a string when present' });
      return;
    }
    // `empty` and `missing` both treated as "no reason" on approve (it's optional).
    const reason = reasonField.kind === 'present' ? reasonField.value : undefined;

    const service = await getApprovalQueueService();
    try {
      const updated = await service.approve({
        tenantId: session.tenant_id,
        id: idValidation.value,
        approverUserId: session.user_id,
        reason,
      });
      res.json({ ok: true, approval: updated });
    } catch (err) {
      if (
        await handleApprovalQueueError(err, req, res, {
          operationType: 'audit_log',
          resourceType: 'governance.approval.approve',
          resourceId: idValidation.value,
        })
      ) {
        return;
      }
      throw err;
    }
  }),
);

// ────────────────────────────────────────────────────────────────────
// POST /:id/reject  — operator rejection (PR 3C)
// ────────────────────────────────────────────────────────────────────

router.post(
  '/:id/reject',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }
    const idValidation = validatePathId(req.params.id);
    if (idValidation.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_id', message: idValidation.error });
      return;
    }
    const reasonField = pluckStringBodyField(req.body, 'reason');
    if (reasonField.kind === 'bad_shape') {
      res.status(400).json({ ok: false, code: 'invalid_reason', message: 'reason must be a string' });
      return;
    }
    if (reasonField.kind !== 'present') {
      res.status(400).json({
        ok: false,
        code: 'reason_required',
        message: 'reject requires a non-empty reason',
      });
      return;
    }

    const service = await getApprovalQueueService();
    try {
      const updated = await service.reject({
        tenantId: session.tenant_id,
        id: idValidation.value,
        approverUserId: session.user_id,
        reason: reasonField.value,
      });
      res.json({ ok: true, approval: updated });
    } catch (err) {
      if (err instanceof InvalidDecisionError) {
        res.status(400).json({ ok: false, code: 'reason_required', message: err.message });
        return;
      }
      if (
        await handleApprovalQueueError(err, req, res, {
          operationType: 'audit_log',
          resourceType: 'governance.approval.reject',
          resourceId: idValidation.value,
        })
      ) {
        return;
      }
      throw err;
    }
  }),
);

// ────────────────────────────────────────────────────────────────────
// POST /:id/reset-claim  — admin recovery for failed apply attempts
// ────────────────────────────────────────────────────────────────────

router.post(
  '/:id/reset-claim',
  validateGuestContext,
  requireAdminRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }

    const idValidation = validatePathId(req.params.id);
    if (idValidation.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_id', message: idValidation.error });
      return;
    }

    const reasonValidation = parseRequiredBodyReason(req.body);
    if (reasonValidation.error !== null) {
      res.status(400).json({ ok: false, code: 'reason_required', message: reasonValidation.error });
      return;
    }

    const service = await getApprovalQueueService();
    try {
      const outcome = await service.resetFailedApplyClaim({
        tenantId: session.tenant_id,
        id: idValidation.value,
        adminUserId: session.user_id,
        reason: reasonValidation.value,
      });

      if (outcome.outcome === 'not_found') {
        // Collapsed message (no id echo) — matches the cross-tenant 404 leak
        // discipline used by approve/reject (Copilot R14/R15). The R14
        // integration test asserts `res.body.message.not.toContain(approvalId)`.
        res.status(404).json({ ok: false, code: 'approval_not_found', message: 'approval not found' });
        return;
      }
      if (outcome.outcome === 'not_failed') {
        res.status(409).json({
          ok: false,
          code: 'approval_not_failed',
          message: `approval ${idValidation.value} is not in a failed apply state`,
          approval: outcome.row,
        });
        return;
      }

      res.json({ ok: true, approval: outcome.row });
    } catch (err) {
      if (
        await handleApprovalQueueError(err, req, res, {
          operationType: 'audit_log',
          resourceType: 'governance.approval.reset_claim',
          resourceId: idValidation.value,
        })
      ) {
        return;
      }
      throw err;
    }
  }),
);

export const approvalsRouter = router;
