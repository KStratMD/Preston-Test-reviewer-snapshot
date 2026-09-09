// src/middleware/staticHtmlPolicy.ts
/**
 * Deny-by-default policy for statically served HTML.
 *
 * Before this module the `htmlFiles` list in RouteSetup only attached no-cache
 * headers: `express.static` was mounted first, so every `.html` file under
 * `public/` was reachable whether or not it appeared in that list, and a second
 * list (`EXEMPT`, in scripts/check-html-whitelist-sync.mjs) existed purely to
 * stop the sync gate complaining about the gap. A page could therefore be
 * published to anyone by dropping a file into `public/`, which is how a
 * card-collecting payment portal stayed publicly served.
 *
 * The rule now is: an HTML path is served only if it is named in the whitelist,
 * or it sits under a directory that is allowlisted here with a reason.
 *
 * Matching is on the FULL path relative to `public/`, not just the basename,
 * because the whitelist already enumerates 66 nested pages (the executive
 * package, the media demo, the sidebar components, both portals). A
 * directory-only rule would have denied every one of them.
 */
import type { RequestHandler } from 'express';
import { isEmbeddedHtmlRoutePath } from './embeddedHtmlRoutes';

/**
 * Directories whose HTML is served in bulk. Keep this map as small as possible:
 * an entry here means "every .html under this directory is public", which is a
 * far weaker statement than naming the page in the whitelist. Each value is the
 * reason the directory cannot simply be enumerated.
 */
export const STATIC_HTML_DIRECTORY_ALLOWLIST: ReadonlyMap<string, string> = new Map([
  [
    'wiki',
    'Brain1 wiki static export: 424 generated pages, rebuilt wholesale by the hosted wiki build, so enumerating them in the whitelist would be churn with no signal',
  ],
]);

const HTML_RE = /\.html?$/i;

/**
 * Resolve a request path to the file path `express.static` would look for.
 *
 * Express does not decode `req.path`, but `express.static` decodes before it
 * resolves a file on disk. Judging the raw path therefore reads
 * `/metrics-viewer.%68tml` as a non-HTML asset and lets it through, and
 * serve-static then decodes it to `metrics-viewer.html` and serves the page — a
 * complete bypass of this policy. Decoding exactly once here, which is what
 * serve-static does, keeps the two in agreement about what a path means.
 *
 * Returns null for a malformed escape sequence so callers can fail closed.
 */
function resolveRequestedFile(rawPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  // Backslashes and repeated slashes resolve to the same file on disk.
  const normalised = decoded.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  const trimmed = normalised.replace(/\/+$/, '');
  const lastSegment = trimmed.split('/').pop() ?? '';
  // A directory request carries no extension, so it would slip past the
  // extension test; judge it as the index page it would resolve to.
  const looksLikeDirectory = normalised.endsWith('/') || (lastSegment !== '' && !lastSegment.includes('.'));
  return looksLikeDirectory ? `${trimmed}/index.html` : normalised;
}

/**
 * True when `express.static` may serve this path from the `public/` root.
 *
 * Non-HTML paths are always allowed: this policy governs pages, not assets.
 */
export function isAllowedStaticHtmlPath(rawPath: string, whitelist: ReadonlySet<string>): boolean {
  const reqPath = resolveRequestedFile(rawPath);
  if (reqPath === null) return false;

  if (!HTML_RE.test(reqPath)) return true;
  if (reqPath.includes('..')) return false;

  // CSP-routed embedded pages must fall through to their route handler, which
  // attaches frame-ancestors. Serving them statically would drop that header.
  if (isEmbeddedHtmlRoutePath(reqPath)) return false;

  const rel = reqPath.replace(/^\/+/, '');
  if (rel === '') return false;

  const relLower = rel.toLowerCase();
  for (const entry of whitelist) {
    if (entry.toLowerCase() === relLower) return true;
  }

  const [firstSegment] = rel.split('/');
  return rel.includes('/') && STATIC_HTML_DIRECTORY_ALLOWLIST.has(firstSegment);
}

/**
 * Wraps a static handler so denied HTML falls through to the next handler
 * (ultimately a 404) instead of being served. Non-GET/HEAD requests are passed
 * straight through: serve-static refuses them itself.
 */
export function denyUnlistedHtml(staticHandler: RequestHandler, whitelist: ReadonlySet<string>): RequestHandler {
  return (req, res, next) => {
    if ((req.method === 'GET' || req.method === 'HEAD') && !isAllowedStaticHtmlPath(req.path, whitelist)) {
      return next();
    }
    return staticHandler(req, res, next);
  };
}

/**
 * Guard for alias mounts that serve a subdirectory of `public/` — `/vendor` and
 * `/webfonts` — and are registered BEFORE the guarded root mount.
 *
 * Those mounts strip their own prefix, so the path they see (`/x.html`) does not
 * match the whitelist keys, which are relative to `public/` (`vendor/x.html`).
 * Running the normal whitelist check against them would compare the wrong key,
 * so they deny HTML outright: an asset directory has no business serving pages.
 *
 * Denying here is not the same as 404ing. The request falls through to the root
 * mount, where the whitelist applies to the full `vendor/...` path — so a page
 * that genuinely must ship from there is whitelisted the ordinary way rather
 * than special-cased.
 */
export function denyStaticHtmlOnAliasMount(staticHandler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return staticHandler(req, res, next);
    const reqPath = resolveRequestedFile(req.path);
    if (reqPath === null || HTML_RE.test(reqPath)) return next();
    return staticHandler(req, res, next);
  };
}
