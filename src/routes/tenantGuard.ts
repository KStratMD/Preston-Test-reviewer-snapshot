import type { Request, Response } from 'express';
import { uuidv4 } from '../utils/uuid';
import type { ConfigurationCommandContext, ConfigurationOperationKind } from '../types/cardinality';

/**
 * Fail-closed tenant gate shared across tenant-scoped routers (PR 13c-4).
 *
 * Returns the authenticated caller's tenantId, or sends the canonical
 * `401 { error: 'unauthorized', reason: 'tenant_required' }` response and returns
 * undefined. Callers MUST `return` immediately when this returns undefined.
 *
 * Centralizing the contract here keeps it from drifting between the ~20 handlers
 * that enforce it (Copilot review) — the routers are mounted behind
 * authMiddleware, and this is the handler-layer narrowing that closes the
 * malformed-JWT (tenantId claim missing/empty) bypass.
 */
export function requireTenantId(req: Request, res: Response): string | undefined {
  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    res.status(401).json({ error: 'unauthorized', reason: 'tenant_required' });
    return undefined;
  }
  return tenantId;
}

/**
 * ONE shared route-layer builder for the trusted `ConfigurationCommandContext`
 * every active-write path (create/update/import, secure-save, bulk restore)
 * must carry (cardinality-preflight design, Task 8).
 *
 * Fails closed with:
 *   - `401 { error: 'unauthorized', reason: 'operator_identity_required' }` when
 *     the verified actor id (`req.user.id`) is missing/empty — non-negotiable
 *     #6: `'unknown'` is never an actor.
 *   - `403 { error: 'forbidden', reason: 'tenant_mismatch' }` when the verified
 *     `req.user.tenantId` does not equal the `tenantId` the caller resolved the
 *     write against (defense-in-depth: the context's tenant must always agree
 *     with the JWT that is about to be attributed for it).
 *
 * `correlationId` uses the normalized `req.correlationId` observability
 * middleware populates, falling back to a fresh UUID only when it is absent
 * (e.g. NODE_ENV=test, where that middleware short-circuits).
 *
 * Callers MUST `return` immediately when this returns `undefined` — the
 * response has already been sent.
 */
export function requireConfigurationCommandContext(
  req: Request,
  res: Response,
  operation: ConfigurationOperationKind,
  tenantId: string,
): ConfigurationCommandContext | undefined {
  const actorUserId = req.user?.id;
  if (typeof actorUserId !== 'string' || actorUserId.length === 0) {
    res.status(401).json({ error: 'unauthorized', reason: 'operator_identity_required' });
    return undefined;
  }
  if (req.user?.tenantId !== tenantId) {
    res.status(403).json({ error: 'forbidden', reason: 'tenant_mismatch' });
    return undefined;
  }
  const correlationId = typeof req.correlationId === 'string' && req.correlationId.length > 0
    ? req.correlationId
    : uuidv4();
  return { tenantId, actorUserId, correlationId, operation };
}
