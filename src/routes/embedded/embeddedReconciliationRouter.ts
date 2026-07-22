/**
 * Embedded operator surface for the Reconciliation Center.
 *
 * Mounted at `/api/embedded/reconciliation` (see `RouteSetup.ts`). Mirrors the
 * Bearer-JWT operator API at `src/routes/reconciliationCenterRoutes.ts` but
 * auths via `validateGuestContext` (embedded session + same-origin) instead.
 * The session's `tenant_id` scopes every lookup and its `user_id` attributes
 * the resolve write — the JWT path is intentionally NOT consulted here, so a
 * missing/invalid Bearer never falls through to SYSTEM_IDENTITY.
 *
 * Companion UI: `public/embedded/reconciliation.{html,js}`.
 *
 * #862 follow-up (c). v1 is intentionally open-only: the backing service
 * exposes `listOpen` + `resolveException`, so the surface lists open exceptions
 * and resolves them. No status filter / history tabs (no service contract yet).
 */
import express from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { validateGuestContext } from '../../middleware/embeddedAuthMiddleware';
import { ReconciliationExceptionNotFoundError } from '../../services/reconciliationCenter/ReconciliationExceptionRepository';
import { SYNTHETIC_EMBEDDED_OPERATOR_USER_IDS } from './embeddedSessionUserId';
import type { ReconciliationCenterService } from '../../services/reconciliationCenter/ReconciliationCenterService';
import type { EmbeddedSession } from '../../database/types';

/**
 * Defensive accessor for the session `validateGuestContext` populated. Returns
 * `null` if the upstream middleware did not run. Mirrors the local helper in
 * `embeddedLineageRouter.ts` (kept local rather than importing the `_`-private
 * governance `readEmbeddedSession` to avoid an embedded→governance coupling;
 * consolidating the three copies is a tracked follow-up).
 */
function readSession(res: express.Response): EmbeddedSession | null {
  const session = res.locals.embeddedSession;
  if (session === undefined || session === null || typeof session !== 'object') {
    return null;
  }
  return session as EmbeddedSession;
}

export function embeddedReconciliationRouter(
  service: ReconciliationCenterService,
): express.Router {
  const router = express.Router();

  router.get(
    '/exceptions',
    validateGuestContext,
    asyncHandler(async (_req, res) => {
      const session = readSession(res);
      if (
        session === null
        || typeof session.tenant_id !== 'string'
        || session.tenant_id.length === 0
      ) {
        return res.status(401).json({ error: 'embedded_session_required' });
      }
      const exceptions = await service.listOpen(session.tenant_id);
      res.json({ exceptions });
    }),
  );

  router.post(
    '/exceptions/:id/resolve',
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
      // Resolve writes resolved_by to the DB row, so the actor must be a real
      // operator identity carried by the embedded session — fail closed rather
      // than persist a blank OR synthetic attribution. hostBootstrapRouter
      // persists any string body.userId verbatim (including the empty string),
      // so we reject empty plus the full set of known placeholders (the embedded
      // host-bootstrap sentinel plus the codebase's '__system__'/'unknown'
      // markers) — full parity with the Bearer route's SYNTHETIC_OPERATOR_USER_IDS.
      if (
        typeof session.user_id !== 'string'
        || session.user_id.length === 0
        || SYNTHETIC_EMBEDDED_OPERATOR_USER_IDS.has(session.user_id)
      ) {
        return res.status(401).json({ error: 'operator_identity_required' });
      }
      try {
        await service.resolveException({
          tenantId: session.tenant_id,
          exceptionId: req.params.id,
          actorUserId: session.user_id,
          note: typeof req.body?.note === 'string' ? req.body.note : '',
        });
      } catch (err) {
        if (err instanceof ReconciliationExceptionNotFoundError) {
          return res.status(404).json({ error: 'exception_not_found' });
        }
        throw err;
      }
      res.status(204).end();
    }),
  );

  return router;
}
