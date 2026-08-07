import type { Request, Response, NextFunction } from 'express';
import { container } from '../inversify/inversify.config';
import { TYPES } from '../inversify/types';
import type {
  EmbeddedSession,
  EmbeddedServiceTokenVersion,
} from '../database/types';
import { EmbeddedServiceTokenRepository } from '../services/embedded/EmbeddedServiceTokenRepository';
import { EmbeddedSessionRepository } from '../services/embedded/EmbeddedSessionRepository';
import type { Logger } from '../utils/Logger';

/**
 * Embedded ERP Surface — auth middleware.
 *
 * Three NAMED exports (closes round-6 finding #6 + round-7 finding #5):
 *   - validateHostBootstrap → POST /api/embedded/host-bootstrap
 *   - validateGuestContext  → POST /api/embedded/context
 *   - validateSessionTeardown → DELETE /api/embedded/sessions/:id
 *
 * Each route mounts ONE of these — NOT a single conditional middleware that
 * dispatches by route. Conditional dispatch was rejected in the round-6/7
 * loop because it lets a route silently inherit the wrong validator if the
 * route key is renamed.
 */

export const EMBEDDED_PLATFORM_HEADER = 'x-embedded-platform';
export const EMBEDDED_SESSION_ID_HEADER = 'x-embedded-session-id';

function getLogger(): Logger {
  return container.get<Logger>(TYPES.Logger);
}

function getTokenRepo(): EmbeddedServiceTokenRepository {
  return container.get<EmbeddedServiceTokenRepository>(
    TYPES.EmbeddedServiceTokenRepository,
  );
}

function getSessionRepo(): EmbeddedSessionRepository {
  return container.get<EmbeddedSessionRepository>(
    TYPES.EmbeddedSessionRepository,
  );
}

/**
 * Extract the bearer token from an `Authorization: Bearer <token>` header.
 * Returns undefined for any malformed shape (no `as` casts; never trust the
 * raw header to be present + well-formed).
 */
function extractBearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return undefined;
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2) return undefined;
  if (parts[0].toLowerCase() !== 'bearer') return undefined;
  return parts[1];
}

/**
 * Single-source-of-truth check for "is this a same-origin browser request"
 * applied to guest-context + session-teardown. Server-to-server calls
 * (NetSuite Suitelet via N/https, BC AL HttpClient) typically omit Origin —
 * we accept undefined Origin BUT only on the host-bootstrap route, which
 * gates on the service-token bearer instead.
 *
 * Origin-present path (POST, DELETE, GET alike):
 *   Parse the Origin header and hostname-match it against req.host (the
 *   existing logic, unchanged). A present-but-mismatched Origin always fails;
 *   Sec-Fetch-Site cannot rescue a bad Origin.
 *
 * Origin-absent path, GET/HEAD only:
 *   Per the WHATWG Fetch spec, browsers do NOT send an Origin header on
 *   same-origin safe (GET/HEAD) fetches — only on cross-origin requests and
 *   on mutating methods (POST, PUT, DELETE, PATCH). The embedded pages are
 *   served from the same API origin, so all their same-origin GETs arrive
 *   without Origin. These requests were incorrectly rejected with 403
 *   cross_origin_rejected (live-verified 2026-06-10).
 *
 *   For GET/HEAD without Origin we accept the request iff
 *   `Sec-Fetch-Site: same-origin` is present. `Sec-Fetch-Site` is a
 *   forbidden request header that browsers always attach and JS cannot forge
 *   — it carries the same threat model as the Origin header (non-browser
 *   callers can forge either; this gate is browser-context defence-in-depth
 *   on top of the session-id secret). We check for the strict string
 *   `same-origin` only; `same-site` is NOT equivalent and is rejected.
 *
 *   Old browsers that do not support Fetch metadata (Sec-Fetch-Site) fail
 *   closed — that is acceptable.
 *
 * Origin-absent path, mutating methods (POST/PUT/DELETE/PATCH etc.):
 *   Modern browsers always emit Origin on mutating requests; absence still
 *   means the request is not from a browser in the expected context.
 *   Rejected regardless of Sec-Fetch-Site (unchanged from original behaviour).
 */
function isSameOriginRequest(req: Request): boolean {
  const origin = req.headers.origin;

  if (typeof origin === 'string') {
    // Origin is present — validate it by hostname matching.
    // Hostname-match (port-agnostic) matches the SameSite cookie semantics
    // browsers actually enforce, and tolerates legitimate same-host setups
    // where the API and host page differ in port (dev, port-forwarded
    // staging, supertest-bound ephemeral ports). The strong auth boundary
    // is still the deferred SHOULD-FIX #7 same-origin cookie binding.
    let originHostname: string;
    try {
      originHostname = new URL(origin).hostname;
    } catch {
      return false;
    }
    // Parse the Host header with URL semantics too (not a naive split(':'))
    // so IPv6 literals like '[::1]:3000' yield '[::1]' — matching what
    // new URL(origin).hostname produces — and casing normalizes identically.
    let requestHostname: string;
    try {
      requestHostname = new URL(`http://${req.get('host') ?? ''}`).hostname;
    } catch {
      return false;
    }
    return originHostname === requestHostname && requestHostname.length > 0;
  }

  // Origin is absent.
  const method = req.method.toUpperCase();
  if (method === 'GET' || method === 'HEAD') {
    // Safe method: browsers omit Origin on same-origin GETs/HEADs.
    // Accept iff Sec-Fetch-Site is exactly 'same-origin'.
    return req.headers['sec-fetch-site'] === 'same-origin';
  }

  // Mutating method with no Origin: was always rejected; keep that behaviour.
  // Closes Copilot review round-2: missing Origin on mutating methods must
  // not be treated as same-origin — any non-browser caller that knows a
  // sessionId would otherwise bypass the cross-site check.
  return false;
}

// -----------------------------------------------------------------------------
// validateHostBootstrap — service-token bearer, server-to-server.
// -----------------------------------------------------------------------------

export async function validateHostBootstrap(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const logger = getLogger();
  const rawToken = extractBearerToken(req);
  if (rawToken === undefined) {
    logger.warn('[embedded] host-bootstrap missing/malformed Authorization');
    res.status(401).json({ error: 'missing_or_invalid_authorization' });
    return;
  }
  const platformHeader = req.headers[EMBEDDED_PLATFORM_HEADER];
  if (typeof platformHeader !== 'string' || platformHeader.length === 0) {
    res.status(400).json({ error: 'missing_x_embedded_platform' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const platformAccountId = body.platformAccountId;
  if (typeof platformAccountId !== 'string' || platformAccountId.length === 0) {
    res.status(400).json({ error: 'missing_platform_account_id' });
    return;
  }
  let row: EmbeddedServiceTokenVersion | null;
  try {
    row = await getTokenRepo().validateToken({
      rawToken,
      expectedPlatform: platformHeader,
      expectedPlatformAccountId: platformAccountId,
    });
  } catch (err) {
    logger.error('[embedded] host-bootstrap validation crashed', {
      error: err instanceof Error ? err.message : String(err),
    });
    res.status(500).json({ error: 'token_validation_failed' });
    return;
  }
  if (row === null) {
    // Don't leak which dimension failed (token vs platform vs account) —
    // collapsed 401/403 protects against probing.
    logger.warn('[embedded] host-bootstrap rejected', {
      platform: platformHeader,
      // Never log the raw token; even hash leakage is undesirable here.
      platformAccountId,
    });
    res.status(401).json({ error: 'invalid_service_token' });
    return;
  }
  res.locals.embeddedToken = row;
  next();
}

// -----------------------------------------------------------------------------
// validateGuestContext — sessionId header + same-origin, browser-side.
// -----------------------------------------------------------------------------

export async function validateGuestContext(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'cross_origin_rejected' });
    return;
  }
  const sessionIdHeader = req.headers[EMBEDDED_SESSION_ID_HEADER];
  if (typeof sessionIdHeader !== 'string' || sessionIdHeader.length === 0) {
    res.status(400).json({ error: 'missing_x_embedded_session_id' });
    return;
  }
  const session = await getSessionRepo().findSession(sessionIdHeader);
  if (session === undefined) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  const expiresAtMs = new Date(session.expires_at as string).getTime();
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) {
    res.status(410).json({ error: 'session_expired' });
    return;
  }
  res.locals.embeddedSession = session;
  next();
}

// -----------------------------------------------------------------------------
// validateSessionTeardown — DELETE /api/embedded/sessions/:id
// -----------------------------------------------------------------------------

export async function validateSessionTeardown(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  if (!isSameOriginRequest(req)) {
    res.status(403).json({ error: 'cross_origin_rejected' });
    return;
  }
  const sessionIdHeader = req.headers[EMBEDDED_SESSION_ID_HEADER];
  if (typeof sessionIdHeader !== 'string' || sessionIdHeader.length === 0) {
    res.status(400).json({ error: 'missing_x_embedded_session_id' });
    return;
  }
  const pathId = req.params.id;
  if (typeof pathId !== 'string' || pathId.length === 0 || pathId !== sessionIdHeader) {
    res.status(400).json({ error: 'session_id_mismatch' });
    return;
  }
  const session = await getSessionRepo().findSession(sessionIdHeader);
  if (session === undefined) {
    // Per round-7 finding #5: forged sessionId 404s rather than 200s with
    // a no-op DELETE — prevents an unauthenticated attacker from confirming
    // the existence of arbitrary sessionIds via timing.
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  res.locals.embeddedSession = session as EmbeddedSession;
  next();
}
