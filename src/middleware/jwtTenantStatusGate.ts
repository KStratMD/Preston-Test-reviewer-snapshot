/**
 * requireActiveJwtTenant — the tenant-lifecycle kill switch for a route that
 * authenticates with a Bearer JWT and is mounted outside the central family
 * gate's per-router wiring.
 *
 * Lifted from `approvalsRouter.ts` (F3) so the Sync Error Assist triage JWT
 * path uses the same gate rather than a copy. Mount AFTER `authMiddleware`:
 * `makeTenantStatusGate` reads the tenant from the verified `req.user` claims
 * and fails closed with 403 `tenant_id_missing` for an authenticated request
 * without one, and with 403 `tenant_blocked` for a suspended tenant.
 *
 * Kept in its own module rather than in `tenantStatusGate.ts` because it
 * resolves `TenantLifecycleService` from the Inversify container, and
 * `tenantStatusGate.ts` is deliberately container-free (RouteSetup passes the
 * service in). `getAsync` is required: the service binds via
 * `toDynamicValue(async)`, and the container caches the singleton.
 */
import type { NextFunction, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type { TenantLifecycleService } from '../services/tenants/TenantLifecycleService';
import { makeTenantStatusGate } from './tenantStatusGate';

export function requireActiveJwtTenant(req: Request, res: Response, next: NextFunction): void {
  container
    .getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService)
    .then((svc) => makeTenantStatusGate(svc)(req, res, next))
    .catch(next);
}
