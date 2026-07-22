import type { Request } from 'express';
import { extractIdentityContext, SYSTEM_IDENTITY } from './identityContext';

/**
 * Resolve the authoritative actor for an attributed mutation.
 *
 * - Authenticated (identity is NOT the pre-auth/demo SYSTEM_IDENTITY): the
 *   authenticated `userId` is authoritative and the body-supplied actor is
 *   ignored (anti-spoofing). This holds even when `userId` is the system
 *   sentinel but the tenant is real — a real tenant with no subject must not
 *   be allowed to claim an arbitrary identity via the request body.
 * - Pre-auth/demo (BOTH `tenantId` AND `userId` equal SYSTEM_IDENTITY): the
 *   body actor is trusted IFF it is a non-empty trimmed string. `bodyActor`
 *   is typed `unknown` so this function is the validation boundary against
 *   object/number spoofing.
 *
 * Returns the resolved actor string, or `undefined` when pre-auth and the
 * body actor is missing/invalid. Callers map `undefined` to a 400 for
 * required fields, or `?? '<default>'` for optional/defaulted fields.
 */
export function resolveActor(req: Request, bodyActor: unknown): string | undefined {
  const { tenantId, userId } = extractIdentityContext(req);
  const isPreAuth =
    tenantId === SYSTEM_IDENTITY.tenantId && userId === SYSTEM_IDENTITY.userId;
  if (!isPreAuth) {
    return userId; // authenticated identity is authoritative
  }
  if (typeof bodyActor === 'string') {
    const trimmed = bodyActor.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }
  return undefined;
}
