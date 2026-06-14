import express from 'express';
import { asyncHandler } from '../middleware/asyncHandler';
import { extractIdentityContext, SYSTEM_IDENTITY } from '../services/governance/identityContext';
import type { LineageQueryService } from '../services/lineage/LineageQueryService';

/**
 * PR 12: Record-Level Lineage operator API.
 *
 * `GET /api/lineage/records/:system/:entityType/:entityId` returns the
 * tenant-scoped lineage chain for a single record. Identity is resolved via
 * `extractIdentityContext` (whole-source-first; JWT / OAuth / verified tenant
 * bridge). The route 401s with `operator_identity_required` when:
 *   - the resolved tenant is the system marker (SYSTEM_IDENTITY.tenantId), OR
 *   - the resolved userId is missing or one of the synthetic sentinels the
 *     auth chain can produce (SYSTEM_IDENTITY.userId, or 'unknown' from
 *     auth.ts when JWT lacks sub/id).
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

export function lineageRouter(service: LineageQueryService): express.Router {
  const router = express.Router();

  router.get(
    '/records/:system/:entityType/:entityId',
    asyncHandler(async (req, res) => {
      const identity = extractIdentityContext(req);
      // extractIdentityContext always returns a non-empty tenantId — it falls
      // back to SYSTEM_IDENTITY when no real identity is present. Reject:
      //   - SYSTEM_IDENTITY.tenantId fallthrough (no tenant)
      //   - missing or synthetic userId (tenant valid but not an operator)
      if (
        identity.tenantId === SYSTEM_IDENTITY.tenantId
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
