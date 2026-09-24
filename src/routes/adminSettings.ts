// src/routes/adminSettings.ts
//
// Platform-admin surface for process-global runtime settings.
// POST /api/admin/settings/demo-mode — audited demo-mode mutation.
//
// Mounted behind authMiddleware in RouteSetup so req.user is populated before
// requirePlatformAdmin authorizes the caller. Actor, tenant, and audit metadata
// come only from verified claims — never from the request body.

import { Router, type Request, type Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { requirePlatformAdmin } from '../middleware/verifiedAdmin';
import { asyncHandler } from '../middleware/asyncHandler';
import { uuidv4 } from '../utils/uuid';
import type { AdminDemoModeService } from '../services/settings/AdminDemoModeService';

/**
 * Factory — wires the admin settings routes against an AdminDemoModeService.
 * The service can be injected (hermetic tests) or resolved from the DI
 * container (production, called by RouteSetup).
 */
export async function createAdminSettingsRouter(
  svc?: AdminDemoModeService,
): Promise<Router> {
  const adminService = svc ?? await container.getAsync<AdminDemoModeService>(TYPES.AdminDemoModeService);
  const router = Router();

  router.post(
    '/demo-mode',
    requirePlatformAdmin,
    asyncHandler(async (req: Request, res: Response) => {
      const rawActor = req.user?.id;
      // Accept only a non-empty string or a number; a truthy object must not be
      // stringified into an audit attribution like "[object Object]".
      const actorId =
        typeof rawActor === 'string' ? rawActor : typeof rawActor === 'number' ? String(rawActor) : '';
      if (actorId.length === 0) {
        // requirePlatformAdmin already proved authentication, so a missing
        // actor here is a wiring defect, not an anonymous caller — fail closed.
        res.status(500).json({ error: 'actor_unidentified' });
        return;
      }

      const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        res.status(400).json({
          success: false,
          error: 'invalid_request',
          message: 'enabled must be a boolean.',
        });
        return;
      }

      // Prefer the correlation id the observability middleware already resolved
      // (from x-correlation-id or a generated uuid) so the audit row lines up
      // with the request's correlation id; fall back for non-instrumented paths.
      const correlationId =
        (req as Request & { correlationId?: string }).correlationId
        || req.get('x-correlation-id')
        || uuidv4();

      const result = await adminService.setDemoMode({
        enabled,
        actorUserId: actorId,
        correlationId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
      });

      res.json({ success: true, enabled: result.enabled });
    }),
  );

  return router;
}
