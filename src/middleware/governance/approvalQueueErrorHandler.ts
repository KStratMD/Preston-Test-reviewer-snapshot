// Shared route-layer error helper for the HITL approval queue (PR 3B).
//
// Centralizes the catch logic so each of the ~46 routes calling a
// BaseProvider-derived or BaseConnector-derived write only has to ADD a
// single line to its existing catch block:
//
//   if (await handleApprovalQueueError(err, req, res, classification)) return;
//
// Returning `true` means the helper fully handled the response (the route
// must not write again); `false` means the route should fall through to its
// existing error handling (typically a 500). The helper NEVER throws —
// enqueue failures fall through to `false` so the route's existing 500 path
// still surfaces something to the client (per the spec §11 risk table — the
// resume worker / enqueue path failing should never crash the request).
//
// Route mapping (per spec §3 typed errors + §4 route catch pattern):
//   PendingApprovalError      → 202 with pendingApprovalId + pollUrl
//   GovernanceBlockedError    → 403 with findings (existing Tier-A path)
//   ApprovalNotFoundError     → 404
//   AlreadyDecidedError       → 409 currentStatus
//   ApprovalExpiredError      → 410
//
// The last three are reserved for PR 3C's operator API which calls
// ApprovalQueueService.approve/reject directly; they're included here so the
// helper is the single source of truth for governance-error → HTTP mapping,
// avoiding drift between PR 3B routes and PR 3C operator endpoints.

import type { Request, Response } from 'express';

import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { Logger } from '../../utils/Logger';
import {
  GovernanceBlockedError,
  PendingApprovalError,
} from '../../services/governance/OutboundGovernanceErrors';
import {
  AlreadyDecidedError,
  ApprovalExpiredError,
  ApprovalNotFoundError,
  UnredactedPayloadError,
} from '../../services/governance/ApprovalQueueErrors';
import type { ApprovalQueueService } from '../../services/governance/ApprovalQueueService';
import type { ApprovalOperationType } from '../../services/governance/ApprovalQueueRepository';
import { extractIdentityContext } from '../../services/governance/identityContext';

export interface ApprovalClassification {
  operationType: ApprovalOperationType;
  resourceType: string;
  /**
   * Caller-supplied target id. Use 'new' for create operations where no id
   * exists yet (matches spec §4 template). For deeply nested operations
   * (e.g. fullPipelineDemo → NetSuiteConnector.create at L739) supply the
   * outermost meaningful id.
   */
  resourceId: string;
}

/**
 * Inspect a caught error; if it is one of the typed governance errors, write
 * the appropriate HTTP response and return `true`. Otherwise return `false`
 * so the caller falls through to its own catch handling.
 *
 * `classification` only affects the `PendingApprovalError` branch — the
 * enqueue requires {operationType, resourceType, resourceId}. The other
 * branches map purely from the error class to an HTTP status.
 *
 * NEVER throws. Enqueue failures (DB unreachable, UnredactedPayloadError,
 * etc.) are logged and the helper returns `false` so the caller's existing
 * 500 path still produces a response — the alternative (helper throws,
 * caller's catch already ran, request hangs) is worse.
 */
export async function handleApprovalQueueError(
  err: unknown,
  req: Request,
  res: Response,
  classification: ApprovalClassification,
): Promise<boolean> {
  // Headers already sent: nothing safe to do; let caller's catch decide.
  if (res.headersSent) return false;

  if (err instanceof PendingApprovalError) {
    return enqueueAndRespond(err, req, res, classification);
  }
  if (err instanceof GovernanceBlockedError) {
    res.status(403).json({
      ok: false,
      code: 'governance_blocked',
      findings: err.decision.findings,
      riskLevel: err.decision.riskLevel,
    });
    return true;
  }
  if (err instanceof ApprovalNotFoundError) {
    res.status(404).json({ ok: false, code: err.code, message: err.message });
    return true;
  }
  if (err instanceof AlreadyDecidedError) {
    res.status(409).json({
      ok: false,
      code: err.code,
      currentStatus: err.currentStatus,
      message: err.message,
    });
    return true;
  }
  if (err instanceof ApprovalExpiredError) {
    res.status(410).json({ ok: false, code: err.code, message: err.message });
    return true;
  }
  return false;
}

async function enqueueAndRespond(
  err: PendingApprovalError,
  req: Request,
  res: Response,
  classification: ApprovalClassification,
): Promise<boolean> {
  let logger: Logger;
  try {
    logger = container.get<Logger>(TYPES.Logger);
  } catch {
    // Container not initialized (e.g. some unit-test fixtures). Fall through.
    return false;
  }

  let approvalQueue: ApprovalQueueService;
  try {
    approvalQueue = await container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
  } catch (resolveErr) {
    logger.error(
      'approvalQueueErrorHandler: failed to resolve ApprovalQueueService',
      resolveErr instanceof Error ? resolveErr : new Error(String(resolveErr)),
      { path: req.path },
    );
    return false;
  }

  // Identity: extractIdentityContext returns a normalized {tenantId, userId}
  // pair where userId is ALWAYS a string (it falls back to
  // SYSTEM_IDENTITY.userId internally when no auth source provides one).
  // The `|| SYSTEM_IDENTITY.userId` belt-and-suspenders from an earlier
  // revision was dead code (Copilot R12). PR 3B explicitly accepts the
  // SYSTEM-IDENTITY-on-write gap for routes not yet behind tenantIsolation
  // — see [[project-pr-3b-route-audit-inventory]] and the PR body's
  // "Known gaps" section. PR 4B + tenantIsolation rollout will close it.
  const { tenantId, userId: requesterUserId } = extractIdentityContext(req);

  try {
    const approvalId = await approvalQueue.enqueue({
      tenantId,
      requesterUserId,
      operationType: classification.operationType,
      resourceType: classification.resourceType,
      resourceId: classification.resourceId,
      decision: err.decision,
    });
    res.status(202).json({
      ok: false,
      code: 'pending_approval',
      pendingApprovalId: approvalId,
      pollUrl: `/api/governance/approvals/${approvalId}`,
    });
    return true;
  } catch (enqueueErr) {
    // Fail-closed shape: if the queue itself refuses (most importantly
    // UnredactedPayloadError, which means upstream produced an invalid
    // OutboundDecision — never persist raw PII), surface a 500 here rather
    // than the caller's generic 500. The caller's 500 would silently lose
    // the governance-side reason.
    if (enqueueErr instanceof UnredactedPayloadError) {
      logger.error(
        'approvalQueueErrorHandler: refused to enqueue unredacted payload (fail-closed)',
        enqueueErr,
        { tenantId, path: req.path, resourceType: classification.resourceType },
      );
      res.status(500).json({
        ok: false,
        code: enqueueErr.code,
        message: 'governance refused to enqueue: upstream decision did not produce a redacted payload',
      });
      return true;
    }
    logger.error(
      'approvalQueueErrorHandler: enqueue failed (request will receive caller default 500)',
      enqueueErr instanceof Error ? enqueueErr : new Error(String(enqueueErr)),
      { tenantId, path: req.path, resourceType: classification.resourceType },
    );
    return false;
  }
}
