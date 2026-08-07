import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { SYSTEM_IDENTITY } from '../services/governance/identityContext';
import type { LineageQueryService } from '../services/lineage/LineageQueryService';

/**
 * PR 12: Record-Level Lineage operator API.
 *
 * `GET /api/lineage/records/:system/:entityType/:entityId` returns the
 * tenant-scoped lineage chain for a single record. F3: identity comes from
 * `req.user` (populated by `authMiddleware` at the mount —
 * `mountLineageRoutes`, which also runs the tenant-lifecycle kill switch);
 * the extractIdentityContext SYSTEM_IDENTITY fallback is gone from this
 * file. The route 401s with `operator_identity_required` when:
 *   - req.user is missing or carries no non-empty tenantId (type-level
 *     defense — the strict mount rejects these upstream), OR
 *   - the userId is missing or one of the synthetic sentinels the auth
 *     chain historically produced (SYSTEM_IDENTITY.userId, or 'unknown'
 *     from auth.ts when JWT lacks sub/id).
 *
 * The proof card claims this is an operator-level read; allowing requests
 * with a real tenant but synthetic userId through would weaken that claim.
 * Same shape as reconciliation's resolve route — PR #846 R9.
 *
 * Intentional scope cut: the embedded operator UI files under
 * `public/embedded/` for lineage (HTML and JS) are NOT shipped in this PR.
 * See the proof card Known Gaps section.
 */
const SYNTHETIC_OPERATOR_USER_IDS: ReadonlySet<string> = new Set([
  SYSTEM_IDENTITY.userId,
  'unknown',
]);

interface OperatorIdentity { tenantId: string; userId: string | undefined }
function jwtOperatorIdentity(req: express.Request): OperatorIdentity | null {
  const user = req.user;
  if (!user || typeof user.tenantId !== 'string' || user.tenantId.length === 0) return null;
  const userId = typeof user.id === 'string' && user.id.length > 0 ? user.id : undefined;
  return { tenantId: user.tenantId, userId };
}

export function lineageRouter(service: LineageQueryService): express.Router {
  const router = express.Router();

  router.get(
    '/records/:system/:entityType/:entityId',
    asyncHandler(async (req, res) => {
      const identity = jwtOperatorIdentity(req);
      if (
        identity === null
        || !identity.userId
        || SYNTHETIC_OPERATOR_USER_IDS.has(identity.userId)
      ) {
        return res.status(401).json({ error: 'operator_identity_required' });
      }
      const events = await service.chainForRecord({
        tenantId: identity.tenantId,
        system: req.params.system,
        entityType: req.params.entityType,
        entityId: req.params.entityId,
      });
      res.json({ events });
    }),
  );

  return router;
}
