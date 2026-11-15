// src/middleware/embeddedHtmlRoutes.ts
/**
 * Single source of truth for the embedded iframe pages that are served through a
 * CSP-wrapped route handler (embeddedCspMiddleware) rather than express.static.
 *
 * The root express.static(public/) handler is registered (in MiddlewareSetup)
 * BEFORE these route handlers (in RouteSetup), so without intervention a direct
 * `GET /embedded/<page>.html` would be served the raw file WITHOUT the
 * frame-ancestors header. `skipEmbeddedHtml` wraps the static handler so these
 * specific basenames fall through to the later CSP route handlers.
 *
 * `host-reference.html` is deliberately NOT in this set — it is a dev-only
 * reference host (a standalone harness), not an embeddable module page, and has
 * no CSP route handler. It continues to be served as a plain static file.
 *
 * `session-expired.html` IS in the set even though it has no file on disk — it is
 * served from a string constant via `sessionExpiredHandler`. Punting it is
 * harmless (there is nothing for static to shadow) and keeps the allowlist a
 * faithful mirror of the CSP-routed mounts.
 */
import type { RequestHandler } from 'express';

export const CSP_ROUTED_EMBEDDED_HTML_BASENAMES: ReadonlySet<string> = new Set([
  'session-expired.html',
  'sync-error-triage.html',
  'approvals.html',
  'lineage.html',
  'reconciliation.html',
]);

/**
 * True iff `path` is exactly `/embedded/<basename>` for one of the CSP-routed
 * basenames. Anchored + single-segment: a nested `/embedded/foo/bar.html` does
 * NOT match, so arbitrary nested HTML under static is never punted into route
 * handling (which would 404).
 */
export function isEmbeddedHtmlRoutePath(path: string): boolean {
  const match = /^\/embedded\/([^/]+\.html)$/.exec(path);
  if (match === null) return false;
  return CSP_ROUTED_EMBEDDED_HTML_BASENAMES.has(match[1]);
}

/**
 * Wrap a static handler so GET/HEAD requests for a CSP-routed embedded page skip
 * static entirely (call `next()`), letting the later CSP-wrapped route handler
 * serve them. Every other request is delegated to `staticHandler` unchanged.
 */
export function skipEmbeddedHtml(staticHandler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (
      (req.method === 'GET' || req.method === 'HEAD') &&
      isEmbeddedHtmlRoutePath(req.path)
    ) {
      return next();
    }
    return staticHandler(req, res, next);
  };
}
