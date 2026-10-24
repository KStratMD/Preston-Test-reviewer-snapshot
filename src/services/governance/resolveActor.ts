import type { Request } from 'express';
import { verifiedUserId } from './verifiedIdentity';

/**
 * Resolve the only acceptable HTTP actor: the verified req.user id.
 * Body-supplied actor fields and the system-sentinel fallback are not part
 * of an HTTP write contract; callers must return identity_required when
 * this is undefined.
 *
 * Scope: req.user ONLY. A req.auth identity (OAuth2 / API key) does not
 * satisfy this helper and resolves to undefined. That is inert for the
 * central-family callers, which pair this with resolveCentralTenantId —
 * itself req.user-only — so both halves of the identity refuse the same
 * requests. A caller on a req.auth-bearing mount needs a different resolver.
 */
export function resolveActor(req: Request): string | undefined {
  const userId = verifiedUserId(req);
  return userId === null ? undefined : userId;
}
