/**
 * AI Services API Routes — DEPRECATED (PR 1B)
 *
 * This module previously aggregated 7 direct-family AI sub-routers.
 * All functionality has been consolidated into the proxy family at
 * /api/ai/proxy (see src/routes/aiProxy.ts).
 *
 * This stub is retained solely for backwards compatibility. The redirect
 * shim in RouteSetup.ts handles routing — this file is no longer mounted
 * but may be imported by stale references.
 *
 * @deprecated Use /api/ai/proxy instead. Will be removed in a future PR.
 */

import { Router } from 'express';

/**
 * @deprecated Consolidated into createAIProxyRouter (PR 1B / ADR-014).
 */
export function createAIRouter(): Router {
  const router = Router();

  router.all('*', (_req, res) => {
    res.status(410).json({
      success: false,
      error: 'This API path has been retired. Use /api/ai/proxy/* instead.',
      migration: {
        canonical: '/api/ai/proxy',
        documentation: 'docs/adr/ADR-014-canonical-ai-router-family.md',
      },
    });
  });

  return router;
}

export default createAIRouter();
