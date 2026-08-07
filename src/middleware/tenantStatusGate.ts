import type { Request, Response, NextFunction } from 'express';
import { TenantLifecycleService, TenantBlockedError } from '../services/tenants/TenantLifecycleService';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import { verifiedTenantId } from '../services/governance/verifiedIdentity';

type RequestWithAuthTenant = Request & { auth?: { tenantId?: unknown } };

/**
 * Normalize one raw tenant claim: trim it, and reject the empty string and the
 * system sentinel. Returns null rather than a sentinel so the caller has to make
 * an explicit decision (F6 PR4 Stage 2, design §4 D2).
 *
 * Deliberately NOT a canonical-format check: this does not apply
 * `isValidTenantId` (`^[a-zA-Z0-9_-]{1,64}$`) from tenantIsolation, so a claim
 * that tenantIsolation would reject — e.g. 65+ chars, which `authMiddleware`
 * admits under its own 255-char bound — still reaches `requireActive`, which
 * auto-creates the tenant row via `ensureExists`. That gap is PRE-EXISTING and
 * unchanged by Stage 2: the previous `extractIdentityContext`-based gate applied
 * no format validation either (verified by running the same over-length claim
 * through both implementations). Reconciling the 64- vs 255-char bounds is a
 * cross-cutting decision tracked as a follow-up, not Stage 2 scope.
 */
function readTenantClaim(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tenantId = raw.trim();
  if (tenantId.length === 0 || tenantId === SYSTEM_IDENTITY.tenantId) return null;
  return tenantId;
}

/**
 * The gate's own tenant-only resolver, replacing `extractIdentityContext`.
 *
 * Deliberately NOT a straight swap to Stage 1's `verifiedTenantId`: that helper
 * reads `req.user` ONLY, while this gate has always also honored `req.auth`
 * (OAuth2 / API-key, set by `AuthenticationMiddleware`) and the
 * `req.tenantContext` bridge. Narrowing to `req.user` alone would silently
 * downgrade an OAuth-authenticated request from "kill switch enforced" to
 * "403 tenant_id_missing". `AuthenticationMiddleware` is not currently mounted
 * beneath any `makeTenantStatusGate` callsite, but a security boundary should
 * not depend on a mount census staying true.
 *
 * `req.auth` is authoritative when present: a present-but-malformed `req.auth`
 * yields null rather than falling through, so a bridge tenant can never be
 * spliced onto a broken OAuth source. That matches `extractIdentityContext`,
 * which returned SYSTEM_IDENTITY outright for a tenant-less `req.auth`.
 *
 * The `req.user` arm reproduces the old APPLICABILITY test exactly — the old
 * `req.user?.tenantId && req.user.id != null` — so it applies to precisely the
 * same requests. Fall-through to `req.tenantContext` happens only when that test
 * fails (no id, or an absent/empty tenant claim), never as a second chance after
 * the arm has already run. Once the arm applies, its answer is FINAL: a truthy
 * but unusable claim (the system sentinel, or whitespace) refuses here rather
 * than deferring to the bridge.
 *
 * Both halves of that are load-bearing, and each was learned from a defect:
 *   - dropping `id != null` WIDENS the inputs reaching `requireActive`, which
 *     auto-creates tenant rows via `ensureExists` (Codex R2 on #1089);
 *   - letting a rejected-but-truthy claim fall through ADMITS a request the old
 *     extractor refused — sentinel claim plus a valid bridge (Codex R3).
 *
 * Two intentional hardening deviations remain, in
 * `readTenantClaim`/`verifiedTenantId`: trimming, and rejecting the system
 * sentinel. The invariant they preserve is precise, and is NOT "both always
 * 403": trimming a padded-but-otherwise-valid claim still admits the request,
 * under the trimmed tenant (deliberate — `' t1 '` and `'t1'` must not become two
 * tenant identities, and the old code would have auto-created the padded one).
 * The property that actually matters is one-directional:
 *
 *   **no input the old extractor REFUSED is admitted here.**
 *
 * Codex R3 verified this across a 300-case typed matrix of
 * `req.auth` × `req.user`(× id) × `req.tenantContext`, each over
 * valid/blank/absent/sentinel/over-length claims.
 */
function verifiedRequestTenantId(req: Request): string | null {
  const auth = (req as RequestWithAuthTenant).auth;
  // Truthiness, NOT `!== undefined` — `req.auth` is typed optional but nothing
  // stops a middleware or stub assigning null, and `null !== undefined` is true,
  // so reading `.tenantId` off it threw a TypeError and turned this security
  // gate into a 500 (Copilot R5). The old extractor's `if (req.auth)` skipped a
  // falsy req.auth entirely; this matches it, and keeps the test consistent with
  // `hasIdentitySource`, which likewise treats a falsy req.auth as absent.
  if (auth) return readTenantClaim(auth.tenantId);
  // An id-bearing user whose tenant claim is TRUTHY is authoritative — even when
  // that claim then proves unusable. Falling through would let a rejected claim
  // be replaced by the bridge, which ADMITS a request the old extractor refused
  // (Codex R3's 300-case matrix found exactly this for a sentinel claim plus a
  // valid bridge). The truthiness test — not `!= null` — is deliberate: it is
  // precisely the old `req.user?.tenantId &&` condition, so an empty-string
  // claim still defers to the bridge exactly as it always did.
  if (req.user !== undefined && req.user.id != null && req.user.tenantId) {
    return verifiedTenantId(req);
  }
  return readTenantClaim(req.tenantContext?.tenantId);
}

/** True when the request carries ANY identity source, however malformed. */
function hasIdentitySource(req: Request): boolean {
  const auth = (req as RequestWithAuthTenant).auth;
  return Boolean(auth) || Boolean(req.user) || Boolean(req.tenantContext);
}

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
    const tenantId = verifiedRequestTenantId(req);
    if (tenantId === null) {
      // No usable tenant scope. Which of the two outcomes applies depends on
      // whether authentication ran at all:
      //   - an identity source IS present → auth ran but produced no tenant
      //     (missing/blank/sentinel claim). Fail closed, otherwise a JWT
      //     without a tenantId claim would bypass the kill switch even after
      //     an operator disables the tenant. Caller fixes it by either
      //     (a) issuing JWTs with a tenantId claim (preferred), or
      //     (b) populating req.auth with a verified tenantId (OAuth/API-key).
      //   - no identity source at all → anonymous. Defer to the family gate,
      //     which owns the demo/public decision. Stage 4 owns any change here.
      if (hasIdentitySource(req)) {
        res.status(403).json({ error: 'tenant_id_missing',
          reason: 'authenticated request reached the kill-switch gate without a tenant identity; check JWT claims and authMiddleware wiring' });
        return;
      }
      return next();
    }
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
