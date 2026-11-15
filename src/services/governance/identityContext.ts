import type { Request } from 'express';

export interface IdentityContext {
  tenantId: string;
  userId: string;
}

export const SYSTEM_IDENTITY: IdentityContext = Object.freeze({
  tenantId: '__system__',
  userId: '__system__',
});

/** F2: attribution label for persistence-free anonymous demo policy checks. Never use for tenant scope or authorization. */
export const DEMO_ACTOR_ID = '__demo__' as const;

/**
 * Returns true when the identity is absent, OR when EITHER its tenantId or its
 * userId matches the frozen system/anonymous sentinel. This is a deliberate OR,
 * NOT full equality with SYSTEM_IDENTITY: a context carrying a real tenantId but
 * the system userId (e.g. the req.tenantContext bridge in extractIdentityContext)
 * is still treated as system. Do not "simplify" this to an AND / full-equality
 * check — that would silently grant such half-system contexts non-system authz.
 * Compares against SYSTEM_IDENTITY rather than hardcoding the sentinel literal
 * (the literal is blocked outside this file by
 * scripts/check-system-identity-isolation.mjs).
 *
 * Used by the route layer and the help service as a single shared predicate so
 * the route-level authz check, /audiences advertisement, and service-level
 * defense-in-depth all agree on what "real (non-system) identity" means.
 */
export function isSystemIdentity(ctx: IdentityContext | undefined): boolean {
  if (!ctx) {
    return true;
  }
  return ctx.tenantId === SYSTEM_IDENTITY.tenantId || ctx.userId === SYSTEM_IDENTITY.userId;
}

/**
 * Reads identity from one verified request source at a time. Whole-source-first
 * matching prevents splicing tenantId from one auth path with userId from
 * another (e.g., OAuth tenant + JWT userId). Does NOT read X-Tenant-Id /
 * X-User-Id headers directly — un-authenticated header propagation is rejected.
 *
 * Sources, in order:
 *   - req.auth (OAuth2 / API-key, set by AuthenticationMiddleware)
 *   - req.user (JWT, set by authMiddleware / optionalAuthMiddleware —
 *     mounted globally on /api/* by PR 2C-Auth)
 *   - req.tenantContext (set by tenantIsolation middleware; populated only
 *     from verified sources — see the security invariant below)
 *
 * **Security invariant — `req.tenantContext` bridge is verified-source-only.**
 * The third source is safe to read because the production-mount of
 * `tenantIsolation` (via `mountCentralTenantGate` in
 * `src/middleware/setup/RouteSetup.ts`) passes `disableHeaderExtraction:
 * true`, so the un-verified `x-tenant-id` header path cannot populate
 * `req.tenantContext`. In `tenantIsolation`'s own runtime precedence, the
 * sources that CAN populate it are: a configured `resolveTenant` callback
 * (not configured at the production mount, so a no-op there); then the
 * verified `req.user` tenant claim normalized by `authMiddleware` /
 * `optionalAuthMiddleware` (the source that WINS in production, since
 * optional auth is mounted globally on `/api/*` ahead of the central gate
 * and `resolveTenant` is unconfigured there); then a Bearer JWT verified
 * against `JWT_SECRET` by `tenantIsolation`'s own extraction; then the
 * `trustedTenants` fast-path, which matches an UN-authenticated
 * `x-tenant-id` header against an allowlist and is likewise not configured
 * at the production mount. The verified `req.user` claim and the Bearer
 * JWT both terminate in a JWT verified against `JWT_SECRET`; those are the
 * only two sources reachable at the production mount, so `req.tenantContext`
 * there is always verified-source-only. This invariant is frozen by
 * `audit-status-claims --check-tenant-isolation-invariant`. The gate fails
 * CI on any `tenantIsolation(...)` callsite under `src/` that (a) omits or
 * sets `disableHeaderExtraction: false`, (b) is parameterless
 * (`tenantIsolation()` — library defaults read the header), (c) passes a
 * non-inline options literal the scanner can't verify, OR uses a bypass
 * prelude that would make the canonical-call scanner blind: (d) aliased
 * named import, (e) namespace import, (f) `const x = tenantIsolation`
 * reference assignment, or (g) CommonJS `require('.../tenantIsolation')`
 * access. The bridge would be unsafe without that guard:
 * `tenantIsolation`'s library default IS to read the header, so a sibling
 * mount that forgets the option would silently re-open header-based
 * tenant impersonation against any direct `req.tenantContext` consumer
 * (e.g. `src/routes/mcpPolicies.ts`) AND against this bridge.
 *
 * The bridge carries only `tenantId`. `req.tenantContext` does not carry a
 * userId — handlers that need an authenticated user must come through
 * `req.auth` or `req.user`. When `req.tenantContext` is the only source
 * populated, this returns `tenantId` + `SYSTEM_IDENTITY.userId` (the
 * system marker), which is correct for routes that scope by tenant but
 * don't attribute actions to a specific user.
 */
export function extractIdentityContext(req: Request): IdentityContext {
  if (req.auth) {
    if (!req.auth.tenantId) {
      return SYSTEM_IDENTITY;
    }
    const userIdRaw = req.auth.user?.sub ?? req.auth.apiKey?.createdBy;
    return {
      tenantId: req.auth.tenantId,
      userId: userIdRaw == null ? SYSTEM_IDENTITY.userId : String(userIdRaw),
    };
  }

  if (req.user?.tenantId && req.user.id != null) {
    return {
      tenantId: req.user.tenantId,
      userId: String(req.user.id),
    };
  }

  if (req.tenantContext?.tenantId) {
    return {
      tenantId: req.tenantContext.tenantId,
      userId: SYSTEM_IDENTITY.userId,
    };
  }

  return SYSTEM_IDENTITY;
}
