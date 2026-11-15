import type { Request } from 'express';
import { SYSTEM_IDENTITY } from './identityContext';

/**
 * Strict verified-identity narrowing for request handlers.
 *
 * This is the OPPOSITE contract to `extractIdentityContext` in the sibling
 * module src/services/governance/identityContext.ts, which falls back to the
 * retired `__system__` sentinel for an unidentifiable request. These functions
 * return `null` instead, so a handler refuses rather than attributing work to a
 * sentinel. The two live side by side but MUST stay separate modules: the whole
 * point is that they are not interchangeable, and one import site must never be
 * able to reach for the wrong contract by accident.
 *
 * It lives under services/ rather than routes/ despite taking an
 * `express.Request`: service-layer callers (src/services/governance/resolveActor.ts)
 * depend on it, and a services -> routes import edge inverts the layering and
 * invites cycles. src/routes/utils/verifiedIdentity.ts re-exports this module
 * for the route-layer callers.
 *
 * All three reject the sentinel in every claim they read. Each reads only the
 * claim(s) its callers scope by, BY DESIGN — a platform-global surface has no
 * tenant to require, and a tenant-scoped READ has no operator to attribute —
 * so `verifiedUserId` neither accepts nor rejects a sentinel tenant, and
 * `verifiedTenantId` neither accepts nor rejects a sentinel user. Use
 * `verifiedIdentity` wherever the handler needs both.
 *
 * No `String()` coercion: coercing an arbitrary runtime object to
 * "[object Object]" is not an acceptable contract for a security identity.
 *
 * Claims are TRIMMED before they are validated, and the trimmed value is what
 * callers get. Two reasons, both load-bearing (Copilot R1, #1087):
 *   - The sibling module `src/middleware/verifiedAdmin.ts` already trims before
 *     comparing (`readActorId`, `readTenantId`). Without trimming here the two
 *     modules disagree on the SAME token — `' __system__ '` is the sentinel to
 *     verifiedAdmin but a legitimate id to us — and OUR value is the one that
 *     reaches `guardedWrite` and the durable `audit_logs` row.
 *   - A whitespace-only claim would otherwise clear the length check and
 *     attribute a durable write to a blank actor.
 * Returning the trimmed value also stops `'u1'` and `' u1 '` from becoming two
 * audit identities for one operator.
 */
export interface VerifiedIdentity {
  tenantId: string;
  userId: string;
}

/** The verified user id, trimmed, or null. Does NOT read or require a tenant claim. */
export function verifiedUserId(req: Request): string | null {
  const rawId = req.user?.id;
  if (typeof rawId !== 'string') return null;
  const userId = rawId.trim();
  if (userId.length === 0 || userId === SYSTEM_IDENTITY.userId) return null;
  return userId;
}

/** The verified tenant id, trimmed, or null. Does NOT read or require a user id claim. */
export function verifiedTenantId(req: Request): string | null {
  const rawTenantId = req.user?.tenantId;
  if (typeof rawTenantId !== 'string') return null;
  const tenantId = rawTenantId.trim();
  if (tenantId.length === 0 || tenantId === SYSTEM_IDENTITY.tenantId) return null;
  return tenantId;
}

/** Both claims, or null. Use where the handler scopes by tenant AND attributes. */
export function verifiedIdentity(req: Request): VerifiedIdentity | null {
  const userId = verifiedUserId(req);
  if (userId === null) return null;
  const tenantId = verifiedTenantId(req);
  if (tenantId === null) return null;
  return { tenantId, userId };
}
