/**
 * Embedded operator surface for record lineage.
 *
 * Mounted at `/api/embedded/lineage` (see `RouteSetup.ts`). Mirrors the
 * Bearer-JWT operator API at `src/routes/lineageRoutes.ts` but auths via
 * `validateGuestContext` (embedded session + same-origin) instead. The
 * session's `tenant_id` scopes the lookup — the JWT path is intentionally
 * NOT consulted here so a missing/invalid Bearer never falls through to
 * SYSTEM_IDENTITY.
 *
 * Companion UI at `public/embedded/lineage.{html,js}` consumes this route.
 *
 * Defense-in-depth tenant guard: even though `validateGuestContext` is
 * supposed to refuse sessions without a `tenant_id`, the handler re-checks
 * the value before calling the query service. `res.locals` is typed as
 * `any` so the type system can't prove the upstream invariant; the guard
 * fails closed (401 `embedded_session_required`) if a future middleware
 * regression ever passes through an underspecified session.
 */
import express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { validateGuestContext } from '../../middleware/embeddedAuthMiddleware';
import type { LineageQueryService } from '../../services/lineage/LineageQueryService';
import type { EmbeddedSession } from '../../database/types';

function readSession(res: express.Response): EmbeddedSession | null {
  const session = res.locals.embeddedSession;
  if (session === undefined || session === null || typeof session !== 'object') {
    return null;
  }
  return session as EmbeddedSession;
}

export function embeddedLineageRouter(service: LineageQueryService): express.Router {
  const router = express.Router();

  router.get(
    '/records/:system/:entityType/:entityId',
    validateGuestContext,
    asyncHandler(async (req, res) => {
      const session = readSession(res);
      if (
        session === null
        || typeof session.tenant_id !== 'string'
        || session.tenant_id.length === 0
      ) {
        return res.status(401).json({ error: 'embedded_session_required' });
      }
      const events = await service.chainForRecord({
        tenantId: session.tenant_id,
        system: req.params.system,
        entityType: req.params.entityType,
        entityId: req.params.entityId,
      });
      res.json({ events });
    }),
  );

  return router;
}
