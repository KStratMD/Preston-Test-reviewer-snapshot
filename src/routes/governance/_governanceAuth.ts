/**
 * Shared embedded-session auth helpers for `/api/governance/*` routers.
 *
 * Extracted from `approvalsRouter.ts` in PR 13b so the `operationsRouter`
 * (read-only ownership-rejections + loop-detections dashboard endpoints) can
 * reuse the exact same role gate without duplicating it.
 *
 * ## What changed, and why it had to
 *
 * These gates used to read `embedded_sessions.user_roles` — a column written
 * verbatim from the host-bootstrap request body. The host was therefore
 * choosing its own authority: a body carrying `["admin","approver"]` returned
 * 200, persisted those roles, and made both predicates answer true (measured
 * 2026-09-03 against the unfixed bootstrap). Any embedded host could approve
 * its own tenant's governance queue.
 *
 * The gates now read VERIFIED roles only. A verified role comes from an
 * `embedded_role_grants` row that a Squire operator issued and that the user
 * proved possession of; the host cannot mint one. Host-asserted roles are
 * still resolved and carried on the principal — they say who is looking, which
 * a UI may legitimately use — but `hasVerifiedRole` never consults them, and
 * nothing here authorizes on them.
 *
 * ## The two scope checks in `resolvePrincipal`
 *
 * A proved grant activates exactly ONE role — its own. Holding a `viewer`
 * grant does not make someone a verified `requester`, and proving any grant
 * does not activate every grant that user holds. The grant is also re-checked
 * against the session it is being used on: `user_id` and `platform_account_id`
 * must match, so a grant proved in one account cannot be replayed against a
 * session in another. Both checks are cheap and both close a real hole, so
 * neither is left to a caller to remember.
 *
 * Exports:
 *   - `APPROVER_ROLES` / `ADMIN_ROLES`: the role sets the gates accept.
 *   - `readEmbeddedSession(res)`: defensive accessor for the session that
 *     `validateGuestContext` populated. Returns `null` if it did not run.
 *   - `parseHostAssertedRoles(session)`: the `user_roles` JSON column, parsed
 *     defensively. Identity, never authority.
 *   - `EmbeddedPrincipal`, `hasVerifiedRole`, `resolvePrincipal`.
 *   - `attachEmbeddedPrincipal`: populates `res.locals.embeddedPrincipal`
 *     without requiring any role.
 *   - `requireApproverRole` / `requireAdminRole`: 403 unless a VERIFIED role
 *     is present.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { EmbeddedSession } from '../../database/types';
import type { EmbeddedRoleGrantRepository } from '../../services/embedded/EmbeddedRoleGrantRepository';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';

/** Roles that may approve/reject approvals OR read governance dashboards. */
export const APPROVER_ROLES: ReadonlySet<string> = new Set(['approver', 'admin']);
/** Roles that may administer failed approval-claim recovery. */
export const ADMIN_ROLES: ReadonlySet<string> = new Set(['admin']);

/**
 * Read the embedded session that `validateGuestContext` populated. Returns
 * `null` if the upstream middleware did not run (defensive — handlers behind
 * this gate should never see a missing session, but the type system can't
 * prove it).
 */
export function readEmbeddedSession(res: Response): EmbeddedSession | null {
  const session = res.locals.embeddedSession;
  if (session === undefined || session === null || typeof session !== 'object') {
    return null;
  }
  return session as EmbeddedSession;
}

/**
 * Parse the `user_roles` JSON column (TEXT-stored `string[]`).
 *
 * Three failure modes collapse to an empty list — column null/empty, JSON
 * parse error, or a parsed value that is not an array. Non-string entries are
 * dropped. These roles are what the HOST claimed about its user: safe to show,
 * never sufficient to authorize.
 */
export function parseHostAssertedRoles(session: EmbeddedSession): string[] {
  const rolesJson = session.user_roles;
  if (rolesJson === null || typeof rolesJson !== 'string' || rolesJson.length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(rolesJson);
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Who the caller is on this embedded session, with the two role sources kept
 * apart on purpose. Collapsing them into one list is exactly the bug this
 * replaces.
 */
export interface EmbeddedPrincipal {
  userId: string;
  platform: string;
  platformAccountId: string;
  /** What the host said. Display only. */
  hostAssertedRoles: string[];
  /** What was proved against a grant. The only input to authorization. */
  verifiedRoles: string[];
}

/** Authorization asks this and only this. */
export function hasVerifiedRole(principal: EmbeddedPrincipal, role: string): boolean {
  return principal.verifiedRoles.includes(role);
}

/**
 * Build the principal for a session.
 *
 * A session earns `verifiedRoles` only when it is marked `squire_verified`,
 * names a grant, that grant is still open and unexpired, and the grant's own
 * user and platform account match the session's. The activated role is the
 * grant's role alone.
 */
export async function resolvePrincipal(
  session: EmbeddedSession,
  grants: EmbeddedRoleGrantRepository,
): Promise<EmbeddedPrincipal> {
  const proved =
    session.user_identity === 'squire_verified' && session.verified_grant_id
      ? await grants.getActiveGrant(session.verified_grant_id)
      : null;

  // All FOUR parts of the grant's key must match the session. Checking only
  // user and account would let a session naming a grant from another tenant or
  // another platform activate that grant's role — the session's own
  // verified_grant_id is the only thing pointing at it, and nothing else
  // re-checks the pair.
  //
  // The SESSION side of the account is normalised: a standalone session carries
  // a NULL platform account while embedded_role_grants.platform_account_id is
  // NOT NULL, so a raw comparison made every standalone grant fail its own
  // scope check — a gate that rejects the legitimate case is as broken as one
  // that admits the illegitimate. The grant side needs no fallback; its column
  // cannot be null, so one there would be unreachable rather than defensive.
  const scopeMatches =
    proved !== null &&
    proved.tenant_id === session.tenant_id &&
    proved.platform === session.platform &&
    proved.user_id === session.user_id &&
    proved.platform_account_id === (session.platform_account_id ?? '');

  return {
    userId: session.user_id,
    platform: session.platform,
    platformAccountId: session.platform_account_id ?? '',
    hostAssertedRoles: parseHostAssertedRoles(session),
    verifiedRoles: scopeMatches ? [proved.role] : [],
  };
}

/**
 * The principal for this request, resolving it once if needed.
 *
 * Returns null when it has already answered the request — the caller must stop
 * rather than continue. Written as a plain async function, not a middleware the
 * gate adapts into a promise: the previous shape responded 500 WITHOUT calling
 * next, so the adapting promise never settled and leaked for the life of the
 * process on every such request.
 */
async function ensurePrincipal(res: Response): Promise<EmbeddedPrincipal | null> {
  const existing = res.locals.embeddedPrincipal as EmbeddedPrincipal | undefined;
  if (existing !== undefined) return existing;

  const session = readEmbeddedSession(res);
  if (session === null) {
    res.status(500).json({
      ok: false,
      code: 'session_not_populated',
      message: 'embedded session middleware did not populate res.locals.embeddedSession',
    });
    return null;
  }

  // getAsync, not get: DatabaseService is bound with toDynamicValue(async ...),
  // so a synchronous construct throws "attempting to construct
  // Symbol(DatabaseService) in a synchronous way" and turns every governance
  // authorization into a 500. The operator CLI hit the identical bug.
  const grants = await container.getAsync<EmbeddedRoleGrantRepository>(
    TYPES.EmbeddedRoleGrantRepository,
  );
  const principal = await resolvePrincipal(session, grants);
  res.locals.embeddedPrincipal = principal;
  return principal;
}

/** Populate `res.locals.embeddedPrincipal`. Requires no role of its own. */
export async function attachEmbeddedPrincipal(
  _req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    // Null means ensurePrincipal already answered; calling next() would run the
    // handler on a request that has been refused.
    if ((await ensurePrincipal(res)) === null) return;
    next();
  } catch (error) {
    // Fail closed. A resolution that cannot complete is not an absent role
    // check — it is an unknown one, and the old RBAC gate taught this codebase
    // what happens when a broken authorization path reports something other
    // than "broken".
    next(error);
  }
}

/**
 * Build a gate that admits only a VERIFIED role from `allowed`.
 *
 * Resolves the principal itself if an earlier middleware has not, so a router
 * cannot accidentally mount the gate without it and admit everyone.
 */
function requireVerifiedRole(allowed: ReadonlySet<string>): RequestHandler {
  const description = [...allowed].join(' or ');
  return (_req: Request, res: Response, next: NextFunction): void => {
    void (async (): Promise<void> => {
      try {
        const principal = await ensurePrincipal(res);
        if (principal === null) return;

        if (![...allowed].some((role) => hasVerifiedRole(principal, role))) {
          res.status(403).json({
            ok: false,
            code: 'insufficient_role',
            message: `${description} grant required`,
          });
          return;
        }
        next();
      } catch (error) {
        next(error);
      }
    })();
  };
}

/** 403 unless the caller holds a verified approver or admin grant. */
export const requireApproverRole: RequestHandler = requireVerifiedRole(APPROVER_ROLES);

/** 403 unless the caller holds a verified admin grant. */
export const requireAdminRole: RequestHandler = requireVerifiedRole(ADMIN_ROLES);
