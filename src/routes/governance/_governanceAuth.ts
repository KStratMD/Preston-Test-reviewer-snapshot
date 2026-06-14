/**
 * Shared embedded-session auth helpers for `/api/governance/*` routers.
 *
 * Extracted from `approvalsRouter.ts` in PR 13b so the new `operationsRouter`
 * (read-only ownership-rejections + loop-detections dashboard endpoints) can
 * reuse the exact same role gate without duplicating it. The single source of
 * truth pattern matches `extractIdentityContext`, `requireApproverRole`, etc.
 *
 * Five exports:
 *   - `APPROVER_ROLES`: the role set that may approve/reject or read
 *     governance operations dashboards.
 *   - `ADMIN_ROLES`: the role set that may administer failed approval-claim
 *     recovery via `POST /api/governance/approvals/:id/reset-claim`.
 *   - `readEmbeddedSession(res)`: defensive accessor for the session that
 *     `validateGuestContext` populated. Returns `null` if the upstream
 *     middleware did not run — routes 500 on null.
 *   - `requireApproverRole`: Express middleware that 403s callers whose
 *     embedded session lacks an approver role.
 *   - `requireAdminRole`: Express middleware that 403s callers whose
 *     embedded session lacks an admin role (PR 13c-3, for the admin-only
 *     apply-claim recovery endpoint).
 *
 * The role check parses `user_roles` (JSON-encoded `string[]`, TEXT column).
 * Three failure modes all collapse to "no roles" → 403:
 *   - column null / empty
 *   - JSON parse error
 *   - parsed value is not an array of strings
 */

import type { NextFunction, Request, Response } from 'express';
import type { EmbeddedSession } from '../../database/types';

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
 * Parse the `user_roles` JSON column (TEXT-stored string[]) and check for an
 * approver role. Returns `true` if any role in `APPROVER_ROLES` is present.
 *
 * Three failure modes collapse to `false` (caller emits 403):
 *   - column null / empty
 *   - JSON parse error
 *   - parsed value is not an array of strings
 *
 * The schema's `user_roles` is `string | null`; null rows are treated as
 * "no roles" → no approval rights. Conservative read; tightening to NOT NULL
 * is out of scope for this PR.
 */
export function hasApproverRole(session: EmbeddedSession): boolean {
  const rolesJson = session.user_roles;
  if (rolesJson === null || typeof rolesJson !== 'string' || rolesJson.length === 0) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rolesJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const role of parsed) {
    if (typeof role === 'string' && APPROVER_ROLES.has(role)) return true;
  }
  return false;
}

/**
 * Parse the `user_roles` JSON column and check for an admin role.
 */
export function hasAdminRole(session: EmbeddedSession): boolean {
  const rolesJson = session.user_roles;
  if (rolesJson === null || typeof rolesJson !== 'string' || rolesJson.length === 0) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rolesJson);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  for (const role of parsed) {
    if (typeof role === 'string' && ADMIN_ROLES.has(role)) return true;
  }
  return false;
}

/**
 * Middleware: rejects with 403 unless the embedded session carries an
 * approver role. Runs AFTER `validateGuestContext` (which sets
 * `res.locals.embeddedSession`). Defensive 500 if the session is missing —
 * indicates a route-mount misconfiguration.
 */
export function requireApproverRole(_req: Request, res: Response, next: NextFunction): void {
  const session = readEmbeddedSession(res);
  if (session === null) {
    res.status(500).json({
      ok: false,
      code: 'session_not_populated',
      message: 'embedded session middleware did not populate res.locals.embeddedSession',
    });
    return;
  }
  if (!hasApproverRole(session)) {
    res.status(403).json({ ok: false, code: 'insufficient_role', message: 'approver or admin role required' });
    return;
  }
  next();
}

/**
 * Middleware: rejects with 403 unless the embedded session carries an admin role.
 */
export function requireAdminRole(_req: Request, res: Response, next: NextFunction): void {
  const session = readEmbeddedSession(res);
  if (session === null) {
    res.status(500).json({
      ok: false,
      code: 'session_not_populated',
      message: 'embedded session middleware did not populate res.locals.embeddedSession',
    });
    return;
  }
  if (!hasAdminRole(session)) {
    res.status(403).json({ ok: false, code: 'insufficient_role', message: 'admin role required' });
    return;
  }
  next();
}
