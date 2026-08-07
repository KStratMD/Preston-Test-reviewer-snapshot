import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { EmbeddedSessionRepository } from '../../services/embedded/EmbeddedSessionRepository';
import { validateHostBootstrap } from '../../middleware/embeddedAuthMiddleware';
import { SESSION_MAX_LIFETIME_MS } from '../../embedded/contract/PostMessageProtocol';
import { EMBEDDED_ANONYMOUS_USER_ID } from './embeddedSessionUserId';
import type { EmbeddedServiceTokenVersion } from '../../database/types';

export const hostBootstrapRouter = express.Router();

function generateSessionId(): string {
  return `es_${randomBytes(16).toString('base64url')}`;
}

function generateCsrfToken(): string {
  return `csrf_${randomBytes(24).toString('base64url')}`;
}

/** Closes Copilot review BLOCKS-MERGE #1.
 *
 *  The expected origin a guest validates postMessage event.origin against
 *  is the ERP PARENT WINDOW's origin (e.g. https://12345.app.netsuite.com),
 *  NOT the SuiteCentral API host. Production adapters (Suitelet, BC AL
 *  Extension) MUST pass this in the host-bootstrap body — only they know
 *  the per-tenant ERP URL.
 *
 *  We validate the supplied origin matches the CSP `frame-ancestors`
 *  allowlist (NetSuite, BC, or the dev EMBEDDED_HOST_ORIGIN env). If
 *  absent + EMBEDDED_HOST_ORIGIN is set, fall back to that (dev/standalone
 *  default). If neither, derive from the request — only safe for the
 *  standalone reference host on a same-origin dev setup.
 */
const NETSUITE_ORIGIN_RE = /^https:\/\/[^/]+\.netsuite\.com$/;
const BC_ORIGIN_RE = /^https:\/\/[^/]+\.dynamics\.com$/;

function resolveExpectedHostOrigin(
  req: Request,
  suppliedOrigin: unknown,
  platform: string,
): string {
  if (typeof suppliedOrigin === 'string' && suppliedOrigin.length > 0) {
    if (
      NETSUITE_ORIGIN_RE.test(suppliedOrigin) ||
      BC_ORIGIN_RE.test(suppliedOrigin) ||
      suppliedOrigin === process.env.EMBEDDED_HOST_ORIGIN
    ) {
      return suppliedOrigin;
    }
    throw new Error(
      `expectedHostOrigin '${suppliedOrigin}' is not in the CSP frame-ancestors allowlist (https://*.netsuite.com, https://*.dynamics.com, or EMBEDDED_HOST_ORIGIN env)`,
    );
  }
  // Closes Copilot review round-2 BLOCKS-MERGE #8: production NetSuite/BC
  // adapters MUST supply expectedHostOrigin — only they know the per-tenant
  // ERP URL. Falling back to req-derived (the SuiteCentral API host) for
  // those platforms creates broken sessions where the guest's postMessage
  // origin check rejects every legitimate parent message. Reject here so
  // the misconfiguration surfaces immediately, not silently downstream.
  if (platform !== 'standalone') {
    throw new Error(
      `expectedHostOrigin is required for platform '${platform}' — production adapters must supply the ERP parent window's origin (NetSuite tenant URL or BC environment URL)`,
    );
  }
  const fromEnv = process.env.EMBEDDED_HOST_ORIGIN;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  const protocol =
    (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim() ??
    req.protocol;
  return `${protocol}://${req.get('host') ?? 'localhost'}`;
}

/**
 * POST /api/embedded/host-bootstrap
 *
 * Called server-side by the platform adapter (NetSuite Suitelet via N/https,
 * BC AL HttpClient). Body: `{ platformAccountId, modulePath?, userId?, userRoles? }`.
 *
 * Standalone dev path: gated by NODE_ENV !== 'production' (closes round-5
 * finding #4 — no `||` env override that could re-enable in production).
 */
hostBootstrapRouter.post('/', validateHostBootstrap, async (req: Request, res: Response) => {
  const tokenRow = res.locals.embeddedToken as EmbeddedServiceTokenVersion | undefined;
  if (tokenRow === undefined) {
    res.status(500).json({ error: 'middleware_invariant_violation' });
    return;
  }

  // Standalone-host dev gate: only allowed outside production.
  if (tokenRow.platform === 'standalone' && process.env.NODE_ENV === 'production') {
    res.status(403).json({ error: 'standalone_host_disabled_in_production' });
    return;
  }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const userId = typeof body.userId === 'string' ? body.userId : EMBEDDED_ANONYMOUS_USER_ID;
  // Closes Copilot review round-3 BLOCKS-MERGE: original `startsWith('/')`
  // accepted network-path references like `//evil.example/app`, which
  // browsers resolve to a third-party origin. embedSrc would leak the
  // freshly minted sessionId off-host AND let the caller swap the embedded
  // module for arbitrary content. Reject `//...`, scheme-relative `/\\`,
  // protocol prefixes, and anything else that isn't a clean local path.
  const modulePathInput = body.modulePath;
  const modulePath =
    typeof modulePathInput === 'string' &&
    modulePathInput.startsWith('/') &&
    !modulePathInput.startsWith('//') &&
    !modulePathInput.startsWith('/\\') &&
    !modulePathInput.includes(':')
      ? modulePathInput
      : '/compliance-dashboard.html';

  // Closes Copilot review round-2 BLOCKS-MERGE #6: the EmbeddedContext
  // contract carries `userRoles` but the original bootstrap never read or
  // persisted them, so contextBootstrapRouter always returned `[]` and
  // role-aware modules saw every user as roleless. Now: validate as
  // string[], JSON-encode for storage, decode on context fetch.
  const userRolesInput = body.userRoles;
  const userRoles =
    Array.isArray(userRolesInput) &&
    userRolesInput.every((r) => typeof r === 'string')
      ? (userRolesInput as string[])
      : [];

  // Optional ERP record handoff (closes Codex review BLOCKS-MERGE #3 +
  // spec scenario 13: launch-from-NetSuite-invoice-record). Persist on
  // the session row so contextBootstrapRouter can echo it back to the
  // guest. Shape-validated; missing/malformed shapes silently drop the
  // field rather than 400 the bootstrap (the ERP record is optional
  // per the EmbeddedContext type).
  const erpRecordInput = body.erpRecord;
  const erpRecord =
    erpRecordInput !== null &&
    typeof erpRecordInput === 'object' &&
    typeof (erpRecordInput as Record<string, unknown>).type === 'string' &&
    typeof (erpRecordInput as Record<string, unknown>).id === 'string'
      ? {
          type: (erpRecordInput as Record<string, unknown>).type as string,
          id: (erpRecordInput as Record<string, unknown>).id as string,
          url:
            typeof (erpRecordInput as Record<string, unknown>).url === 'string'
              ? ((erpRecordInput as Record<string, unknown>).url as string)
              : null,
        }
      : null;

  const sessionId = generateSessionId();
  const csrfToken = generateCsrfToken();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_MAX_LIFETIME_MS);
  let expectedHostOrigin: string;
  try {
    expectedHostOrigin = resolveExpectedHostOrigin(
      req,
      body.expectedHostOrigin,
      tokenRow.platform,
    );
  } catch (err) {
    res.status(400).json({
      error: 'invalid_expected_host_origin',
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const repo = container.get<EmbeddedSessionRepository>(TYPES.EmbeddedSessionRepository);
  await repo.createSession({
    session_id: sessionId,
    tenant_id: tokenRow.tenant_id,
    user_id: userId,
    platform: tokenRow.platform,
    platform_account_id: tokenRow.platform_account_id,
    csrf_token: csrfToken,
    expected_host_origin: expectedHostOrigin,
    expires_at: expiresAt.toISOString(),
    last_rotation_at: null,
    erp_record_type: erpRecord?.type ?? null,
    erp_record_id: erpRecord?.id ?? null,
    erp_record_url: erpRecord?.url ?? null,
    user_roles: userRoles.length > 0 ? JSON.stringify(userRoles) : null,
  });

  // The csrfToken is returned to the SERVER-SIDE adapter for logging/audit
  // only; the browser-side guest learns it later via POST /api/embedded/context.
  res.status(200).json({
    sessionId,
    csrfToken,
    embedSrc: `${modulePath}?embeddedContextId=${encodeURIComponent(sessionId)}`,
    sessionExpiresAt: expiresAt.toISOString(),
  });
});
