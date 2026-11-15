/**
 * Authorization for the Sync Error Assist triage routes
 * (`GET /api/sync-error-assist/suggestions` and
 * `POST /api/sync-error-assist/suggestions/:errorRecordId/{accept,reject,escalate}`).
 *
 * ## Why this exists
 *
 * Triage used to authorize on `embedded_sessions.user_roles` containing
 * `ops`, `admin` or `finance`. Since #1238 host-bootstrap stores only
 * `viewer`/`requester` from the host body, so no session minted in production
 * could carry those roles: every real caller got 403 `forbidden_role`, and the
 * suites passed only because they seeded the column directly. Worse, the rule
 * was an authorization decision on host-asserted data.
 *
 * ## The two supported callers
 *
 *   1. Embedded (no Bearer header): `validateGuestContext` (session header +
 *      hostname origin check) → tenant kill switch → a VERIFIED `approver` or
 *      `admin` grant (`requireApproverRole`, the governance gate). Host-asserted
 *      roles never authorize.
 *   2. Direct API (canonical `Authorization: Bearer <jwt>`): `authMiddleware`
 *      (re-verifies, so an invalid token is 401 rather than silently ignored as
 *      `optionalAuthMiddleware` does) → `tenant_admin` role with a real tenant
 *      claim → tenant kill switch. The platform wildcard (`admin` role, `*`
 *      permission) does not authorize, and a token carrying `service` is
 *      refused so its rate-limiter exemption can never apply here.
 *
 * A canonical Bearer together with `X-Embedded-Session-Id` is refused with 400
 * `ambiguous_credentials` before either is verified. A header that looks like
 * Bearer but is not the exact canonical spelling every other auth path in the
 * app parses (`Bearer <token>`, case-sensitive, one space) is refused with 401
 * `invalid_authorization_scheme`, so it can neither dodge the ambiguity check
 * nor fall through to the embedded path.
 *
 * ## Composition
 *
 * Each path is an Express router. Express composes it natively: a gate that
 * answers without calling `next` ends the stack, and `next(err)` reaches the
 * error handler. Express 4 does not forward a rejected promise from an async
 * middleware, so every gate is wrapped in `forwardRejections`.
 */
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { validateGuestContext, EMBEDDED_SESSION_ID_HEADER } from '../../middleware/embeddedAuthMiddleware';
import { requireActiveEmbeddedTenant } from '../../middleware/embeddedTenantStatusGate';
import { requireActiveJwtTenant } from '../../middleware/jwtTenantStatusGate';
import { authMiddleware } from '../../middleware/auth';
import { isPlatformAdminActor } from '../../middleware/verifiedAdmin';
import { readEmbeddedSession, requireApproverRole, type EmbeddedPrincipal } from '../governance/_governanceAuth';
import { SYSTEM_IDENTITY } from '../../services/governance/identityContext';
import type { TriageAuthSource } from '../../services/syncErrorAssist/SyncErrorAssistOperatorService';

export type { TriageAuthSource };

/** Who is acting on a triage request, and on which tenant. */
export interface TriageActor {
  tenantId: string;
  userId: string;
  source: TriageAuthSource;
}

const TRIAGE_ACTOR_LOCAL = 'triageActor';

/** The only role a JWT caller may present for triage. */
export const TRIAGE_JWT_ROLE = 'tenant_admin';

/**
 * Express 4 ignores the promise an async middleware returns, so a rejection
 * (a failed session or grant lookup) would become an unhandled rejection and a
 * hung request. Route it to `next` instead.
 */
export function forwardRejections(fn: RequestHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export type AuthorizationClass = 'canonical' | 'malformed_bearer' | 'other';

/**
 * Classify an `Authorization` header against the canonical Bearer spelling
 * that `authMiddleware` (and the other five app parsers) accept: exactly
 * `Bearer ` followed by one whitespace-free token.
 */
export function classifyAuthorization(header: unknown): AuthorizationClass {
  if (typeof header !== 'string') return 'other';
  const trimmed = header.trim();
  if (/^Bearer [^\s]+$/.test(trimmed)) return 'canonical';
  if (/^bearer\b/i.test(trimmed)) return 'malformed_bearer';
  return 'other';
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A verified subject id, or '' when the claim cannot identify one. */
function readJwtActorId(id: unknown): string {
  if (typeof id === 'string') return id.trim();
  if (typeof id === 'number' && Number.isFinite(id)) return String(id);
  return '';
}

/** A usable tenant claim, or '' (absent, blank, or the system sentinel). */
function readJwtTenantId(tenantId: unknown): string {
  if (typeof tenantId !== 'string') return '';
  const trimmed = tenantId.trim();
  return trimmed === SYSTEM_IDENTITY.tenantId ? '' : trimmed;
}

/**
 * The JWT claim check. Mount after `authMiddleware`.
 *
 * A missing subject or tenant is 401: tenant identity is the scope of every
 * triage operation, so without it there is nothing to authorize against
 * (same rule as `requireIntegrationTenantAdmin`).
 */
export function requireTriageJwtClaims(req: Request, res: Response, next: NextFunction): void {
  const user = req.user;
  if (readJwtActorId(user?.id).length === 0 || readJwtTenantId(user?.tenantId).length === 0) {
    res.status(401).json({
      ok: false,
      code: 'tenant_identity_required',
      message: 'a JWT with a subject and a tenantId claim is required',
    });
    return;
  }
  const roles = stringList(user?.roles);
  if (roles.includes('service')) {
    res.status(403).json({
      ok: false,
      code: 'service_role_refused',
      message: 'service tokens cannot triage sync-error suggestions',
    });
    return;
  }
  // A platform actor must not reach a tenant's queue through its own claim,
  // even when the token also carries tenant_admin. Same predicate as
  // requirePlatformAdmin, so the two can never disagree.
  if (isPlatformAdminActor(user)) {
    res.status(403).json({
      ok: false,
      code: 'insufficient_role',
      message: 'platform admin tokens cannot triage; use a tenant_admin token without platform privileges',
    });
    return;
  }
  if (!roles.includes(TRIAGE_JWT_ROLE)) {
    res.status(403).json({
      ok: false,
      code: 'insufficient_role',
      message: `${TRIAGE_JWT_ROLE} role required`,
    });
    return;
  }
  next();
}

function actorNotPopulated(res: Response): void {
  res.status(500).json({
    ok: false,
    code: 'actor_not_populated',
    message: 'triage authorization did not establish an actor',
  });
}

/** Record the embedded actor from the session and the principal the role gate resolved. */
export function setEmbeddedActor(_req: Request, res: Response, next: NextFunction): void {
  const session = readEmbeddedSession(res);
  const principal = res.locals.embeddedPrincipal as EmbeddedPrincipal | undefined;
  if (session === null || principal === undefined) {
    actorNotPopulated(res);
    return;
  }
  const actor: TriageActor = { tenantId: session.tenant_id, userId: principal.userId, source: 'embedded_grant' };
  res.locals[TRIAGE_ACTOR_LOCAL] = actor;
  next();
}

/** Record the JWT actor from the verified claims. */
export function setJwtActor(req: Request, res: Response, next: NextFunction): void {
  const userId = readJwtActorId(req.user?.id);
  const tenantId = readJwtTenantId(req.user?.tenantId);
  if (userId.length === 0 || tenantId.length === 0) {
    actorNotPopulated(res);
    return;
  }
  const actor: TriageActor = { tenantId, userId, source: 'api_jwt' };
  res.locals[TRIAGE_ACTOR_LOCAL] = actor;
  next();
}

export const embeddedTriageStack = express.Router();
embeddedTriageStack.use(
  forwardRejections(validateGuestContext),
  forwardRejections(requireActiveEmbeddedTenant),
  forwardRejections(requireApproverRole),
  forwardRejections(setEmbeddedActor),
);

export const jwtTriageStack = express.Router();
jwtTriageStack.use(
  forwardRejections(authMiddleware),
  forwardRejections(requireTriageJwtClaims),
  forwardRejections(requireActiveJwtTenant),
  forwardRejections(setJwtActor),
);

/** Choose the credential path for a triage request. */
export function authorizeTriageCaller(req: Request, res: Response, next: NextFunction): void {
  const kind = classifyAuthorization(req.headers.authorization);
  if (kind === 'malformed_bearer') {
    res.status(401).json({
      ok: false,
      code: 'invalid_authorization_scheme',
      message: 'use exactly "Authorization: Bearer <token>"',
    });
    return;
  }
  if (kind === 'canonical') {
    if (req.headers[EMBEDDED_SESSION_ID_HEADER] !== undefined) {
      res.status(400).json({
        ok: false,
        code: 'ambiguous_credentials',
        message: 'send either a Bearer token or an embedded session, not both',
      });
      return;
    }
    jwtTriageStack(req, res, next);
    return;
  }
  embeddedTriageStack(req, res, next);
}

/**
 * The actor `authorizeTriageCaller` established. Fails closed: when absent it
 * answers 500 `actor_not_populated` and returns null, and the caller must stop.
 */
export function getTriageActor(res: Response): TriageActor | null {
  const actor = res.locals[TRIAGE_ACTOR_LOCAL] as TriageActor | undefined;
  if (actor === undefined) {
    actorNotPopulated(res);
    return null;
  }
  return actor;
}
