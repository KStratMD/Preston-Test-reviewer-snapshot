import express, { type Request, type Response } from 'express';
import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { EmbeddedSessionRepository } from '../../services/embedded/EmbeddedSessionRepository';
import { validateSessionTeardown } from '../../middleware/embeddedAuthMiddleware';

export const sessionTeardownRouter = express.Router();

/**
 * DELETE /api/embedded/sessions/:id
 *
 * Idempotent at the SQL level (DELETE returns 0 rows for already-deleted),
 * but middleware enforces sessionId existence so a forged ID 404s rather
 * than 200s with a no-op (round-7 finding #5 — prevents unauthenticated
 * session-spoofing DoS).
 *
 * Called via `fetch(..., { method: 'DELETE', keepalive: true })` from
 * guest-bootstrap.js on `pagehide`. (Native `sendBeacon` is POST-only and
 * can't set `X-Embedded-Session-Id`, so it can't satisfy this route's auth
 * gate.) Missed teardowns (browser crash, network drop) fall through to
 * EmbeddedRetentionJob.
 */
sessionTeardownRouter.delete(
  '/:id',
  validateSessionTeardown,
  async (req: Request, res: Response) => {
    const sessionId = req.params.id;
    const repo = container.get<EmbeddedSessionRepository>(TYPES.EmbeddedSessionRepository);
    const deleted = await repo.deleteSession(sessionId);
    res.status(204).json(deleted > 0 ? { deleted } : { deleted: 0 });
  },
);
