/**
 * F5b: tenant resolution for the four tenant-aware *-central families,
 * replacing extractIdentityContext's system-identity fallback.
 *
 * Three outcomes:
 *   - a verified tenant claim is present → that claim;
 *   - the policy gate attested an anonymous demo admission → the dedicated
 *     demo tenant, which is where the boot-time demo fixtures live;
 *   - anything else → 401 identity_required, and the caller returns.
 *
 * PR-F5b-3 closed the F6-prerequisite arm: attested anonymous demo reads
 * resolve to CENTRAL_DEMO_TENANT_ID (src/services/governance/demoTenant.ts),
 * seeded there at boot, so the system-identity fallback is fully retired from
 * this helper. Phase 2's three blockers are gone with it — the workflow
 * instance producer takes its tenant from the caller, the seeds are real
 * conflict-safe upserts, and hosted demo seeds under HOSTED_DEMO=1.
 *
 * PRODUCTION ENVELOPE NOTE: in the real app the 401 branch is largely
 * unreachable for authenticated callers, because makeTenantStatusGate
 * (src/middleware/tenantStatusGate.ts:22) already answers 403
 * tenant_id_missing when an authenticated request carries no tenantId. The
 * 401 here is the defense-in-depth backstop for a handler reached without
 * that gate; do not write integration tests that expect it from a gated
 * mount.
 */
import type { Request, Response } from 'express';
import { isDemoAnonymousAdmitted } from '../../middleware/aiProxyPolicyGate';
import { CENTRAL_DEMO_TENANT_ID } from '../../services/governance/demoTenant';
import type { AuthenticatedRequest } from '../../middleware/auth';

/**
 * The demo tenant is an internal fixture owner, not a registrable tenant: no
 * JWT is ever minted with it, so a request PRESENTING it as a claim is
 * malformed or forged and is refused here rather than trusted.
 *
 * This matters because anonymous demo visitors read that tenant's rows — an
 * accepted demo-tenant claim would let an authenticated caller write content
 * every visitor then renders. Enforcing it at the trust boundary keeps the
 * invariant demoTenant.ts documents from being merely aspirational.
 *
 * Scope note: a claim for the system identity's tenant is NOT rejected here.
 * That is pre-existing behavior which several workflow-central suites rely on
 * for authenticated writes; closing it is F6 work (`strictMode` +
 * `--forbid-system-identity-fallback`), not a drive-by in this PR. (Spelled in
 * prose deliberately — this file is asserted to carry no reference to that
 * symbol.)
 */
function isReservedTenantClaim(tenantId: string): boolean {
  return tenantId === CENTRAL_DEMO_TENANT_ID;
}

export function resolveCentralTenantId(req: Request, res: Response): string | null {
  const tenantId = (req as AuthenticatedRequest).user?.tenantId?.trim();
  if (typeof tenantId === 'string' && tenantId.length > 0) {
    if (isReservedTenantClaim(tenantId)) {
      res.status(403).json({ error: 'reserved_tenant' });
      return null;
    }
    return tenantId;
  }

  if (isDemoAnonymousAdmitted(req)) return CENTRAL_DEMO_TENANT_ID;

  res.status(401).json({ error: 'identity_required' });
  return null;
}

/**
 * Resolve the acting identity for a central-family WRITE.
 *
 * Writes are never on a demo allowlist under F5b, so the gate guarantees an
 * authenticated caller: a gate-attested anonymous request has no actor and is
 * refused here rather than falling back to a body-supplied name. This
 * replaces the pre-F5b `isPreAuth ? bodyActor : ctxUserId` pattern in
 * workflowCentral, whose body branch existed only for the anonymous demo path
 * the strict mount now closes. Body-supplied actor fields are ignored.
 *
 * The id is stringified before trimming as defense-in-depth: this repo's
 * augmentation declares `id: string` (src/types/express.d.ts), but
 * non-conforming test shims and the raw `sub` JWT claim can carry other
 * shapes at runtime (the trap PR-F5 hit in ActionIslandRouter).
 */
export function resolveCentralActor(
  req: Request,
  res: Response,
): { tenantId: string; userId: string } | null {
  const user = (req as AuthenticatedRequest).user;
  const tenantId = user?.tenantId?.trim();
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    res.status(401).json({ error: 'identity_required' });
    return null;
  }
  if (isReservedTenantClaim(tenantId)) {
    res.status(403).json({ error: 'reserved_tenant' });
    return null;
  }

  const rawId = user?.id ?? (user as { sub?: unknown } | undefined)?.sub;
  const userId = rawId == null ? '' : String(rawId).trim();
  if (userId.length === 0) {
    res.status(401).json({ error: 'identity_required' });
    return null;
  }

  return { tenantId, userId };
}
