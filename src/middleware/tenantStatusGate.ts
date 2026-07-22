import type { Request, Response, NextFunction } from 'express';
import { TenantLifecycleService, TenantBlockedError } from '../services/tenants/TenantLifecycleService';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';

export interface TenantStatusGateOptions {
  // Regexes are matched against `req.originalUrl` (the FULL request URL, e.g.
  // `/api/payment-central/orders?foo=1`), NOT the mount-relative `req.path`.
  // When this middleware is composed inside another router that's mounted on
  // `/api/X`, req.path is `/orders`, which makes mount-relative patterns
  // impossible to author safely. originalUrl is stable regardless of how the
  // gate is composed, so author exempt patterns against full request URLs.
  exempt?: RegExp[];
}

export function makeTenantStatusGate(
  service: TenantLifecycleService,
  opts: TenantStatusGateOptions = {},
) {
  return async function tenantStatusGate(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (opts.exempt?.some((r) => r.test(req.originalUrl))) return next();
    const ctx = extractIdentityContext(req);
    if (ctx.tenantId === SYSTEM_IDENTITY.tenantId) {
      // System-identity short-circuit only applies when there is NO
      // authenticated user on the request. If req.user or req.auth IS set
      // and we still got SYSTEM_IDENTITY, that means authentication ran but
      // the identity source did NOT carry a tenantId — fail closed instead
      // of silently letting blocked-tenant traffic flow through. Without
      // this guard, a JWT-authenticated request whose token lacks a
      // tenantId claim would bypass the kill switch even after an operator
      // disables the tenant. Caller can fix by either:
      //   (a) issuing JWTs with a tenantId claim (preferred); or
      //   (b) populating req.auth with a verified tenantId (OAuth/API-key path).
      const authenticated = Boolean(req.user) || Boolean((req as Request & { auth?: unknown }).auth);
      if (authenticated) {
        res.status(403).json({ error: 'tenant_id_missing',
          reason: 'authenticated request reached the kill-switch gate without a tenant identity; check JWT claims and authMiddleware wiring' });
        return;
      }
      return next();
    }
    const tenantId = ctx.tenantId;
    try {
      await service.requireActive(tenantId);
      next();
    } catch (err) {
      if (err instanceof TenantBlockedError) {
        res.status(403).json({ error: 'tenant_blocked', reason: err.reason, status: err.status });
        return;
      }
      next(err);
    }
  };
}
