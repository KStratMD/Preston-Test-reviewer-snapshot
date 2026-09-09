import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { EmbeddedSessionRepository } from '../../services/embedded/EmbeddedSessionRepository';
import { validateGuestContext } from '../../middleware/embeddedAuthMiddleware';
import {
  MIN_ROTATION_INTERVAL_MS,
  SESSION_MAX_LIFETIME_MS,
} from '../../embedded/contract/PostMessageProtocol';
import type { EmbeddedContext } from '../../embedded/contract/EmbeddedSurfaceContract';
import type { EmbeddedSession } from '../../database/types';

export const contextBootstrapRouter = express.Router();

function generateCsrfToken(): string {
  return `csrf_${randomBytes(24).toString('base64url')}`;
}

function asEmbeddedContext(row: EmbeddedSession): EmbeddedContext {
  // platform is stored as string but contract narrows to a union; a row with
  // an unrecognised value would have failed earlier validation. Default
  // mapping for safety.
  const platform: EmbeddedContext['platform'] =
    row.platform === 'netsuite' || row.platform === 'business_central'
      ? row.platform
      : 'standalone';
  // Reconstruct the optional erpRecord (closes Codex review BLOCKS-MERGE #3 +
  // spec scenario 13). Only emit if both required fields (type, id) are
  // present; the optional `url` is tagged when present.
  const erpRecord =
    row.erp_record_type !== null && row.erp_record_id !== null
      ? {
          type: row.erp_record_type,
          id: row.erp_record_id,
          ...(row.erp_record_url !== null ? { url: row.erp_record_url } : {}),
        }
      : undefined;
  // Decode userRoles (closes Copilot review round-2 BLOCKS-MERGE #6).
  // Stored as JSON-encoded string[]; defensively parse + validate shape so
  // a malformed row (e.g. stale data from before this PR) still returns
  // an empty array rather than throwing.
  let userRoles: string[] = [];
  if (typeof row.user_roles === 'string' && row.user_roles.length > 0) {
    try {
      const parsed: unknown = JSON.parse(row.user_roles);
      if (Array.isArray(parsed) && parsed.every((r) => typeof r === 'string')) {
        userRoles = parsed as string[];
      }
    } catch {
      /* malformed JSON — fall through to empty array */
    }
  }
  return {
    tenantId: row.tenant_id,
    userId: row.user_id,
    userRoles,
    platform,
    platformAccountId: row.platform_account_id ?? undefined,
    erpRecord,
    sessionId: row.session_id,
    sessionExpiresAt: new Date(row.expires_at as string).toISOString(),
    expectedHostOrigin: row.expected_host_origin,
    csrfToken: row.csrf_token,
  };
}

/**
 * POST /api/embedded/context
 *
 * Called by the guest iframe after load. Body either empty (initial fetch)
 * or `{ refresh: true }` (context.refresh from request.context.refresh).
 *
 * Refresh path (closes round-5 finding #7): server enforces
 * MIN_ROTATION_INTERVAL_MS floor between consecutive issuances for the same
 * sessionId — returns 429 with Retry-After otherwise.
 */
contextBootstrapRouter.post('/', validateGuestContext, async (req: Request, res: Response) => {
  const session = res.locals.embeddedSession as EmbeddedSession | undefined;
  if (session === undefined) {
    res.status(500).json({ error: 'middleware_invariant_violation' });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const isRefresh = body.refresh === true;
  if (!isRefresh) {
    res.status(200).json(asEmbeddedContext(session));
    return;
  }

  // Throttle context.refresh: previous rotation must be older than
  // MIN_ROTATION_INTERVAL_MS. Returns 429 + Retry-After: <seconds>.
  // Pre-flight check is informational — the AUTHORITATIVE atomic guard
  // is the WHERE clause on rotateSession() below (closes Copilot review
  // round-3 race condition). The pre-flight gives us a clean 429 with
  // an accurate Retry-After header in the common case; the atomic UPDATE
  // closes the race in the (rare) concurrent-call case.
  const lastRotationMs =
    session.last_rotation_at === null
      ? null
      : new Date(session.last_rotation_at as string).getTime();
  const nowMs = Date.now();
  if (lastRotationMs !== null && nowMs - lastRotationMs < MIN_ROTATION_INTERVAL_MS) {
    const retryAfterSeconds = Math.ceil(
      (MIN_ROTATION_INTERVAL_MS - (nowMs - lastRotationMs)) / 1000,
    );
    res.setHeader('Retry-After', String(Math.max(retryAfterSeconds, 1)));
    res.status(429).json({ error: 'rotation_throttled', retryAfterSeconds });
    return;
  }

  // Rotate. Closes Copilot review round-1 BLOCKS-MERGE #2 (sliding window)
  // + round-3 race (atomic UPDATE guarded on last_rotation_at). The
  // throttle floor passed to rotateSession ensures only ONE of two
  // concurrent rotators wins the UPDATE; the loser sees 0 rows affected
  // and we return 429 to the client (correct behavior for "another
  // request just rotated; back off").
  const newCsrfToken = generateCsrfToken();
  const newExpiresAt = new Date(nowMs + SESSION_MAX_LIFETIME_MS);
  const throttleCutoff = new Date(nowMs - MIN_ROTATION_INTERVAL_MS);
  const repo = container.get<EmbeddedSessionRepository>(TYPES.EmbeddedSessionRepository);
  const ok = await repo.rotateSession(
    session.session_id,
    newCsrfToken,
    newExpiresAt,
    throttleCutoff,
  );
  if (!ok) {
    // Either the session vanished (unlikely — we just fetched it) OR a
    // concurrent rotator won the race. Treat as throttled to give the
    // caller a clear retry hint rather than a misleading 404.
    const retryAfterSeconds = Math.ceil(MIN_ROTATION_INTERVAL_MS / 1000);
    res.setHeader('Retry-After', String(retryAfterSeconds));
    res.status(429).json({ error: 'rotation_throttled', retryAfterSeconds });
    return;
  }
  const refreshed: EmbeddedContext = {
    ...asEmbeddedContext(session),
    csrfToken: newCsrfToken,
    sessionExpiresAt: newExpiresAt.toISOString(),
  };
  res.status(200).json(refreshed);
});
