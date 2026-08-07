/**
 * requireActiveEmbeddedTenant — tenant-lifecycle kill switch for
 * embedded-session surfaces (PR-F3; design §D5-F3 + resolved question 2:
 * suspended tenants are blocked on EVERY authenticated tenant-scoped read
 * and write).
 *
 * The JWT-path kill switch (`makeTenantStatusGate`) resolves tenant identity
 * via `extractIdentityContext`, which embedded-session requests never
 * populate — their tenant lives in `res.locals.embeddedSession.tenant_id`
 * (set by `validateGuestContext`). Blocked-state transitions already revoke
 * embedded credentials (`TenantLifecycleService.setStatus`), but revocation
 * can partially fail (`PartialTenantRevocationError`), so surviving sessions
 * must still be refused at request time. Mount AFTER `validateGuestContext`
 * (or `validateSessionTeardown`) and BEFORE role gates, so a blocked tenant
 * reads as `tenant_blocked` regardless of the caller's role.
 *
 * TenantLifecycleService is resolved lazily per request (same posture as
 * `getSessionRepo()` in embeddedAuthMiddleware.ts — the container caches the
 * singleton; `getAsync` is required because the service binds via
 * `toDynamicValue(async)`).
 */
import type { NextFunction, Request, Response } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import { TenantBlockedError } from '../services/tenants/TenantLifecycleService';
import type { TenantLifecycleService } from '../services/tenants/TenantLifecycleService';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { normalizeTenantIdClaim } from './auth';

export function requireActiveEmbeddedTenant(_req: Request, res: Response, next: NextFunction): void {
  const session: unknown = res.locals.embeddedSession;
  const tenantId =
    session !== null && typeof session === 'object' && 'tenant_id' in session
      ? (session as { tenant_id?: unknown }).tenant_id
      : undefined;
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    res.status(500).json({
      ok: false,
      code: 'session_not_populated',
      message: 'res.locals.embeddedSession is missing or lacks a non-empty tenant_id — validateGuestContext must run before this gate',
    });
    return;
  }
  // Fail closed BEFORE the lifecycle lookup on the system identity marker
  // (mirrors makeTenantStatusGate's authenticated-without-tenant branch).
  // requireActive auto-registers unknown tenants as active, so letting the
  // sentinel through would both mint a '__system__' tenant row AND admit
  // the request to an operator handler.
  if (tenantId === SYSTEM_IDENTITY.tenantId) {
    res.status(403).json({
      error: 'tenant_id_missing',
      reason: 'embedded session carries the system identity marker instead of a real tenant; refusing operator access',
    });
    return;
  }
  // Fail closed on NON-CANONICAL tenant ids (Codex R3). The session store
  // persists tenant_id verbatim at provisioning, and requireActive requires
  // callers to validate before its auto-registering lookup — a padded /
  // overlong / shape-illegal id ('tenant-a ' vs canonical 'tenant-a') would
  // otherwise mint an active shadow tenant and dodge the canonical row's
  // suspension. Reject rather than normalize-and-proceed: the handler scopes
  // data with the RAW session value, so a normalized lookup would check one
  // tenant's status and serve another's key.
  if (normalizeTenantIdClaim(tenantId) !== tenantId) {
    res.status(403).json({
      error: 'tenant_id_missing',
      reason: 'embedded session tenant id is not in canonical form; refusing operator access',
    });
    return;
  }
  container
    .getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService)
    .then((svc) => svc.requireActive(tenantId))
    .then(() => next())
    .catch((err: unknown) => {
      if (err instanceof TenantBlockedError) {
        res.status(403).json({ error: 'tenant_blocked', reason: err.reason, status: err.status });
        return;
      }
      next(err);
    });
}
