/**
 * Governance-operations dashboard read API (PR 13b — Task 29).
 *
 * Two GET endpoints serve the new `public/governance-operations.html` operator
 * UI by reading `governance_check` audit rows through
 * `AuditService.queryGovernanceChecks`:
 *
 *   GET /ownership-rejections    — rows where checkType='ownership',
 *                                  approved=false (queued / rejected writes)
 *   GET /loop-detections         — rows where checkType='loop_detection'
 *
 * Both gated by `validateGuestContext` + `requireApproverRole` (same posture
 * as `approvalsRouter`'s operator surface). Tenant identity comes from the
 * embedded session's `tenant_id` — NOT a query param (the operator UI runs
 * inside the iframe with a tenant-scoped session, and a query param would
 * be forgeable).
 *
 * Mounted at `/api/governance` so the router-relative paths resolve to:
 *   /api/governance/ownership-rejections
 *   /api/governance/loop-detections
 *
 * Both endpoints accept an optional `?since=<ISO timestamp>` query param.
 * Missing/empty defaults to a 1h lookback window. Invalid shapes 400.
 *
 * View shape (response):
 *   {
 *     ok: true,
 *     items: [{ time, entity, declaredOwner|targetSystem, callerSystem,
 *                policy|breakingCondition, correlationId }, ...]
 *   }
 *
 * The `correlationId` field maps from `log.sessionId` because
 * `AuditService.logGovernanceCheck` writes the caller's correlationId into
 * the AuditLog `sessionId` field (it doubles as the cross-system trace key
 * for the ownership chain).
 */

import express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import type { AuditService, AuditLog as AIAuditLog } from '../../services/ai/orchestrator/AuditService';
import type { DLPService } from '../../services/security/DLPService';
import type { Logger } from '../../utils/Logger';
import { validateGuestContext } from '../../middleware/embeddedAuthMiddleware';
import { readEmbeddedSession, requireApproverRole } from './_governanceAuth';

const DEFAULT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const router = express.Router();

interface ParseResult<T> {
  value: T;
  error: string | null;
}

/**
 * Parse the optional `?since=<ISO>` query param. Missing/empty resolves to
 * `now - 1h`. Array-shaped (`?since=a&since=b`) and non-ISO strings 400.
 *
 * Mirrors the [[feedback-copilot-input-shape-waves]] convention: enumerate
 * all the shapes Express's qs can hand a route (array, undefined, empty
 * string, malformed) UPFRONT so input-validation findings don't arrive in
 * three Copilot rounds.
 */
function parseSince(raw: unknown): ParseResult<Date> {
  if (raw === undefined) {
    return { value: new Date(Date.now() - DEFAULT_WINDOW_MS), error: null };
  }
  if (typeof raw !== 'string') {
    return { value: new Date(), error: 'since must be a single ISO timestamp string' };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { value: new Date(Date.now() - DEFAULT_WINDOW_MS), error: null };
  }
  // Copilot R11 on PR #851: `new Date(...)` accepts implementation-dependent
  // formats (`05/01/2026`, `1730000000`, etc.) which would otherwise be
  // silently coerced into different absolute times. Validate against
  // a strict ISO-8601 / RFC-3339 shape BEFORE constructing the Date so
  // ambiguous inputs surface as `invalid_since` instead of being parsed
  // as whatever the JS engine guesses. Accepted shapes:
  //   YYYY-MM-DDTHH:MM:SS[.sss][Z|±HH:MM]
  // (Date-only `YYYY-MM-DD` is rejected — the operator endpoint requires
  // a time component to distinguish between window boundaries.)
  const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
  if (!ISO_8601.test(trimmed)) {
    return {
      value: new Date(),
      error: `since must be an ISO-8601 timestamp (YYYY-MM-DDTHH:MM:SS[.sss]Z); received '${trimmed}'`,
    };
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) {
    return {
      value: new Date(),
      error: `since must be a valid ISO timestamp; received '${trimmed}'`,
    };
  }
  return { value: d, error: null };
}

async function getAuditService(): Promise<AuditService> {
  return container.getAsync<AuditService>(TYPES.AuditService);
}

async function getDlpService(): Promise<DLPService> {
  return container.getAsync<DLPService>(TYPES.DLPService);
}

function getLogger(): Logger {
  return container.get<Logger>(TYPES.Logger);
}

router.get(
  '/ownership-rejections',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }
    const sinceParsed = parseSince(req.query.since);
    if (sinceParsed.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_since', message: sinceParsed.error });
      return;
    }
    const auditService = await getAuditService();
    const rows = await auditService.queryGovernanceChecks({
      tenantId: session.tenant_id,
      checkType: 'ownership',
      since: sinceParsed.value,
      approved: false,
    });
    res.json({ ok: true, items: rows.map(toOwnershipRejectionView) });
  }),
);

router.get(
  '/loop-detections',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (req, res) => {
    const session = readEmbeddedSession(res);
    if (session === null) {
      res.status(500).json({ ok: false, code: 'session_not_populated' });
      return;
    }
    const sinceParsed = parseSince(req.query.since);
    if (sinceParsed.error !== null) {
      res.status(400).json({ ok: false, code: 'invalid_since', message: sinceParsed.error });
      return;
    }
    const auditService = await getAuditService();
    const rows = await auditService.queryGovernanceChecks({
      tenantId: session.tenant_id,
      checkType: 'loop_detection',
      since: sinceParsed.value,
    });
    res.json({ ok: true, items: rows.map(toLoopDetectionView) });
  }),
);

/**
 * Project an ownership-rejection AuditLog into the compact dashboard shape.
 *
 * The ownership envelope inside `event.details.ownership` carries the full
 * resolver context (entity, declaredOwner, callerSystem, targetSystem,
 * operation, recordIdHash, policy, queueId, loopBreakingCondition,
 * resumeFromQueue, governanceOverride). The dashboard only renders a subset
 * — anything richer is available via the audit-log detail view (out of
 * scope for this PR).
 */
function toOwnershipRejectionView(log: AIAuditLog): Record<string, unknown> {
  const details = log.event.details as Record<string, unknown> | null;
  const ownership = (details?.ownership as Record<string, unknown> | undefined) ?? {};
  return {
    time: log.timestamp.toISOString(),
    entity: ownership.entity,
    declaredOwner: ownership.declaredOwner,
    callerSystem: ownership.callerSystem,
    policy: ownership.policy,
    correlationId: log.sessionId,
  };
}

/**
 * Project a loop-detection AuditLog into the compact dashboard shape. The
 * `breakingCondition` field is the loop-break predicate the detector
 * recorded (e.g. an audit-log action mismatch); operators use it as the
 * "why this didn't actually loop" cue when triaging.
 */
function toLoopDetectionView(log: AIAuditLog): Record<string, unknown> {
  const details = log.event.details as Record<string, unknown> | null;
  const ownership = (details?.ownership as Record<string, unknown> | undefined) ?? {};
  return {
    time: log.timestamp.toISOString(),
    entity: ownership.entity,
    callerSystem: ownership.callerSystem,
    targetSystem: ownership.targetSystem,
    breakingCondition: ownership.loopBreakingCondition,
    correlationId: log.sessionId,
  };
}

/**
 * GET /api/governance/dlp-pattern-metadata
 *
 * Serves DLP pattern metadata to the embedded operator approvals iframe so
 * `FindingsDisplay.mapFindings` can humanize raw policyFindings type keys
 * (e.g. 'ssn' → 'Social Security Number') without requiring a Bearer JWT.
 *
 * Gated by `validateGuestContext` + `requireApproverRole` — same posture as
 * the ownership-rejections and loop-detections endpoints on this router.
 * The pattern registry is tenant-agnostic (process-global); this handler does
 * not read the embedded session beyond what the role gate already checked.
 * The pattern list is metadata-only (no regex sources) so it is safe to
 * expose to operator-role callers.
 *
 * Response shape is IDENTICAL to GET /api/compliance/dlp-patterns so
 * `approvals.js` can consume the same `mapFindings` contract:
 *   { success: true, data: { count: number, patterns: PIIPatternMetadata[] } }
 * Note: the 500 envelope uses `{success:false, error}` (parity with the
 * compliance endpoint) while sibling routes on this router use `{ok:false,
 * code}` — intentional, not normalized.
 *
 * CLAUDE.md invariant: count/list MUST derive from `getRegisteredPatterns()`
 * — never hardcoded.
 */
router.get(
  '/dlp-pattern-metadata',
  validateGuestContext,
  requireApproverRole,
  asyncHandler(async (_req, res) => {
    try {
      const dlpService = await getDlpService();
      const patterns = dlpService.getRegisteredPatterns();
      res.json({
        success: true,
        data: {
          count: patterns.length,
          patterns,
        },
      });
    } catch (err) {
      // Logger.error only attaches its 2nd arg when it is an Error instance —
      // forward the real error (wrapped if needed) so the log carries it.
      getLogger().error(
        'DLP pattern metadata query failed',
        err instanceof Error ? err : new Error(String(err)),
      );
      res.status(500).json({ success: false, error: 'Internal server error' });
    }
  }),
);

export const operationsRouter = router;
