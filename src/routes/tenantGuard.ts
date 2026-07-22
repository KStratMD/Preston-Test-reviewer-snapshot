import type { Request, Response } from 'express';

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
