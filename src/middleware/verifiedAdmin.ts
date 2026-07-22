import type { RequestHandler } from 'express';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';

/**
 * Administrator authorization boundaries backed by verified JWT claims.
 *
 * Both handlers here share three properties:
 *
 *   - Deliberately independent of the module-global `RBACService` singleton
 *     used by `requireAdmin`/`requirePermission`: production never calls
 *     `setRBACServiceInstance()`, so those gates cannot authorize a real
 *     request.
 *   - They read only the normalized `req.user` claims that `authMiddleware`
 *     installs — never a header, query, or body — so they must be mounted
 *     AFTER `authMiddleware`.
 *   - They respond directly (401/403) rather than delegating to `next(err)`:
 *     the app's final error handler collapses every forwarded error to HTTP
 *     500, so a direct response is the only way to return an accurate status.
 */
interface AdminClaims {
  id?: string | number;
  tenantId?: unknown;
  roles?: unknown;
  permissions?: unknown;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * The verified actor id, or `''` when the claim cannot identify a subject.
 *
 * Fails closed unless the id is a non-blank string or a number; a truthy
 * object must never be treated as an authenticated subject, and neither must a
 * blank one. `authMiddleware` already trims and rejects a whitespace-only
 * subject, so the trim here is defense in depth — but this gate is what asserts
 * an identified actor, and that assertion must not rest on a normalization it
 * does not own. A blank id would authorize the request and then attribute it to
 * nobody in the audit trail.
 */
function readActorId(user: AdminClaims | undefined): string {
  const rawId = user?.id;
  return typeof rawId === 'string' ? rawId.trim() : typeof rawId === 'number' ? String(rawId) : '';
}

/**
 * The verified tenant id, or `''` when the claim cannot scope an operation.
 *
 * Rejects the system sentinel: `SYSTEM_IDENTITY.tenantId` is the fallback
 * attribution for unauthenticated work, not a tenant anyone administers. A
 * token minted with it would otherwise reach the system sandbox through the
 * tenant namespace.
 */
function readTenantId(user: AdminClaims | undefined): string {
  const rawTenantId = user?.tenantId;
  if (typeof rawTenantId !== 'string') return '';
  const tenantId = rawTenantId.trim();
  return tenantId === SYSTEM_IDENTITY.tenantId ? '' : tenantId;
}

/**
 * Platform-administrator authorization.
 *
 * A caller is a platform admin when they carry the `admin` role or the
 * wildcard `*` permission. Not tenant-scoped: platform surfaces are global.
 */
export const requirePlatformAdmin: RequestHandler = (req, res, next) => {
  const user = req.user as AdminClaims | undefined;
  if (readActorId(user).length === 0) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const roles = stringList(user?.roles);
  const permissions = stringList(user?.permissions);
  if (!roles.includes('admin') && !permissions.includes('*')) {
    res.status(403).json({ error: 'Platform administrator access required' });
    return;
  }

  next();
};

/**
 * SuiteCentral tenant-administrator authorization from verified JWT claims.
 *
 * Mount AFTER `authMiddleware`, and only on the tenant namespace
 * (`/api/suitecentral/prod`), where the operated-on tenant is always the
 * caller's own `req.user.tenantId`. Like {@link requirePlatformAdmin} this
 * responds directly rather than delegating to `next(err)`.
 *
 * A missing tenant claim is 401, not 403: tenant identity is the *target* of
 * every operation here, so without it there is no scope to authorize against —
 * the identity is incomplete rather than understood-and-denied.
 *
 * The platform wildcard (`admin` role / `*` permission) is deliberately NOT
 * accepted. It would authorize a platform admin on this namespace, where the
 * target tenant is their own JWT claim and the audit row records access mode
 * `tenant_admin`. Platform actors reach a tenant through
 * `/api/admin/tenants/:tenantId/suitecentral`, so cross-tenant access is
 * audited as exactly that.
 */
export const requireSuiteCentralTenantAdmin: RequestHandler = (req, res, next) => {
  const user = req.user as AdminClaims | undefined;
  if (readActorId(user).length === 0 || readTenantId(user).length === 0) {
    res.status(401).json({ error: 'Verified tenant administrator identity required' });
    return;
  }

  const roles = stringList(user?.roles);
  const permissions = stringList(user?.permissions);
  if (!roles.includes('tenant_admin') && !permissions.includes('suitecentral:admin')) {
    res.status(403).json({ error: 'SuiteCentral tenant administrator access required' });
    return;
  }

  next();
};
