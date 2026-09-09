// src/routes/adminTenantStatus.ts
//
// Admin surface for the tenant kill switch.
// POST /api/admin/tenants/:tenantId/status — flip tenant status (operator action)
// GET  /api/admin/tenants/:tenantId/status — read current status + full audit trail
//
// Both routes require authentication (authMiddleware, mounted in RouteSetup) and
// platform-administrator authorization (requirePlatformAdmin — the caller must
// carry the 'admin' role or the '*' permission in their verified JWT claims).
//
// This surface used to gate on requireAdmin from ../middleware/rbac, which
// resolves a module-global RBAC singleton that nothing in src/ ever
// initializes, so the kill switch could not be operated at all. The throw is
// caught by that middleware and converted to ForbiddenAppError (status 403),
// but the operator saw 500: ../errorHandler is the only error handler the app
// registers and it answers every next(err) with 500, ignoring err.statusCode.
// Measured 2026-09-03. See ../middleware/verifiedAdmin, which exists because
// the singleton gates cannot authorize a real request.

import { Router, type Request, type Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import {
  TenantLifecycleService,
  InvalidTenantStatusTransitionError,
  TenantStatusConcurrencyError,
  PartialTenantRevocationError,
  TenantNotFoundError,
} from '../services/tenants/TenantLifecycleService';
import { requirePlatformAdmin } from '../middleware/verifiedAdmin';
import { asyncHandler } from '../middleware/asyncHandler';
import type { TenantStatus } from '../services/tenants/TenantStatus';

const VALID_STATUSES: ReadonlySet<TenantStatus> = new Set([
  'active',
  'suspended',
  'disabled',
  'trial_expired',
]);

// Cap operator-supplied `reason` strings before they hit the audit table.
// requirePlatformAdmin already gates this surface so the risk is small, but a 10 MB
// reason would still bloat audit rows and every subsequent listAudit response.
const MAX_REASON_LENGTH = 1024;

/**
 * Factory function — wires the admin GET/POST routes against a
 * TenantLifecycleService. The service can be passed in (used by hermetic
 * tests that mock the service surface) or resolved from the DI container
 * (production path, called by RouteSetup).
 *
 * Splitting the DI resolution from the route-wiring means the same router
 * code path is exercised in tests as in production, so any change to the
 * typed-error dispatch, length-cap, or 404 logic is covered by the unit
 * suite without needing to boot Inversify.
 */
export async function createAdminTenantStatusRouter(
  svc?: TenantLifecycleService,
): Promise<Router> {
  const service = svc ?? await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
  const router = Router();

  // GET /api/admin/tenants/:tenantId/status
  // Returns the current status and full audit history for the tenant.
  router.get(
    '/:tenantId/status',
    requirePlatformAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { tenantId } = req.params;
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId required' });
        return;
      }
      // peekStatus is the read-only path: returns null for tenant ids that
      // have NO row, WITHOUT inserting one. GET endpoints must not cause
      // spam-create of tenant rows via attacker-supplied or typo'd ids, and
      // the admin caller needs to distinguish "tenant exists and is active"
      // from "no such tenant" — so the unknown case is a 404, not a 200 with
      // synthetic `status: 'active'`.
      const status = await service.peekStatus(tenantId);
      if (status === null) {
        res.status(404).json({ error: 'tenant_not_found', tenantId });
        return;
      }
      const audit = await service.listAudit(tenantId);
      res.json({ tenantId, status, audit });
    }),
  );

  // POST /api/admin/tenants/:tenantId/status
  // Body: { status: TenantStatus, reason?: string }
  // Validates the requested status, calls setStatus, returns updated state + audit.
  // Returns 400 for invalid input or an invalid state-machine transition.
  router.post(
    '/:tenantId/status',
    requirePlatformAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const { tenantId } = req.params;
      if (!tenantId) {
        res.status(400).json({ error: 'tenantId required' });
        return;
      }

      const body = req.body as { status?: unknown; reason?: unknown };
      const newStatus = body.status;
      if (typeof newStatus !== 'string' || !VALID_STATUSES.has(newStatus as TenantStatus)) {
        res.status(400).json({ error: 'invalid status', allowed: Array.from(VALID_STATUSES) });
        return;
      }

      // Length-cap reason at the route boundary so the audit table can't be
      // bloated by a multi-megabyte operator-supplied string. 1024 chars is
      // generous for an audit-trail justification and still safely fits in
      // any sane TEXT column.
      const rawReason = typeof body.reason === 'string' ? body.reason : undefined;
      if (rawReason !== undefined && rawReason.length > MAX_REASON_LENGTH) {
        res.status(400).json({
          error: 'reason too long',
          maxLength: MAX_REASON_LENGTH,
          actualLength: rawReason.length,
        });
        return;
      }
      const reason = rawReason;
      // requirePlatformAdmin upstream rejects a request whose claims cannot
      // identify a subject, so req.user.id is always populated here. If that
      // ever changes (middleware reordering, a future gate swap), fail
      // loudly instead of writing `'unknown'` into the audit trail — a
      // synthetic actor undermines the SOC 2 audit-trail value.
      // Read the id the same way requirePlatformAdmin's readActorId does:
      // trim strings, accept a number, reject everything else. Without the trim
      // a whitespace-only id would pass this guard and be written into the
      // audit trail as a blank actor.
      const rawId: unknown = req.user?.id;
      const actorId = typeof rawId === 'string' ? rawId.trim() : typeof rawId === 'number' ? String(rawId) : '';
      if (actorId.length === 0) {
        res.status(500).json({ error: 'actor_unidentified',
          detail: 'admin route reached without an authenticated actor; this should be impossible past requirePlatformAdmin' });
        return;
      }
      const actorUserId = actorId;

      try {
        await service.setStatus({
          tenantId,
          newStatus: newStatus as TenantStatus,
          actorUserId,
          actorSource: 'admin_route',
          reason,
        });
      } catch (err) {
        // Typed-narrowing dispatch:
        //   TenantNotFoundError                → 404 (no row for this id)
        //   InvalidTenantStatusTransitionError → 400 (impossible transition)
        //   TenantStatusConcurrencyError       → 409 (race-lost; retry)
        //   PartialTenantRevocationError       → 500 with code (operator must
        //                                        re-attempt revocation)
        // Any other Error propagates to the global 500 handler unchanged.
        if (err instanceof TenantNotFoundError) {
          res.status(404).json({ error: 'tenant_not_found', tenantId: err.tenantId });
          return;
        }
        if (err instanceof InvalidTenantStatusTransitionError) {
          res.status(400).json({
            error: err.message,
            code: 'invalid_transition',
            from: err.fromStatus,
            to: err.toStatus,
          });
          return;
        }
        if (err instanceof TenantStatusConcurrencyError) {
          res.status(409).json({
            error: err.message,
            code: 'concurrent_status_change',
            expectedFrom: err.expectedFrom,
          });
          return;
        }
        if (err instanceof PartialTenantRevocationError) {
          res.status(500).json({
            error: err.message,
            code: 'partial_revocation_failed',
            tenantId: err.tenantId,
            newStatus: err.newStatus,
          });
          return;
        }
        throw err;
      }

      const status = await service.getStatus(tenantId);
      const audit = await service.listAudit(tenantId);
      res.json({ tenantId, status, audit });
    }),
  );

  return router;
}
