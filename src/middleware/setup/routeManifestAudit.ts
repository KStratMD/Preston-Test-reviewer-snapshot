/**
 * Boot-time audit of mounted `/api` surfaces that carry no ROUTE_MANIFEST
 * classification.
 *
 * When the registration recorder is installed, literal registrations are an
 * authoritative gate. The Express-stack walk below remains a diagnostic
 * fallback for apps constructed without the recorder.
 *
 * WHY IT EXISTS (B8.1). The request-time "[routeManifest] unclassified route"
 * warning fires for any `/api/...` path matching no route at all, i.e. ordinary
 * 404 traffic, so it is evidence about unmatched REQUEST PATHS and proves
 * nothing either way about mount coverage. Mount coverage was in fact
 * incomplete: this scan found eleven undeclared surfaces on its first run
 * against the real app, all declared inside a router mounted at `/` with no
 * prefix, where no scan of `app.use('/api/...')` call sites could see them.
 *
 * WHY THE FALLBACK IS NOT A GATE. Recovering a mount path from Express's COMPILED layer
 * regexps cannot see every registration shape. The table below is MEASURED
 * against this implementation, not assumed — each 'missed' row was verified
 * reachable while the scan reported nothing. It is representative, not proven
 * exhaustive:
 *
 *   SEEN    prefix-mounted router            app.use('/api/x', router)
 *   SEEN    direct route                     app.get('/api/x', h)
 *   SEEN    prefixless router's own paths    app.use(router) with '/api/..' inside
 *   SEEN    router mounted at bare '/api'    app.use('/api', router)
 *   SEEN    case-variant mount and route     '/API/x'
 *   SEEN    exact '/api' route               app.get('/api', h)
 *   MISSED  middleware mount                 app.use('/api/x', handlerFn)
 *   MISSED  bare '/api' middleware handler   app.use('/api', handlerFn)
 *   MISSED  parameterised mount              app.use('/api/:t/x', router)
 *   MISSED  mounted sub-app                  app.use('/api/x', express())
 *   MISSED  array of mount paths             app.use(['/api/a','/api/b'], r)
 *   MISSED  direct RegExp route              app.get(/^\/api\/x$/, h)
 *
 * A fallback scan that silently misses those must never be described as enforcement:
 * reporting "no gaps" would assert something it cannot know. It therefore
 * reports only gaps it POSITIVELY finds, and never reports success.
 *
 * The enforcement records literal path arguments at REGISTRATION time — where
 * the declaration is still authoritative — across
 * both the app and its routers, and adds exact-vs-prefix matching semantics to
 * the manifests. The recorder is installed by `App` before route setup.
 */

import type { Application } from 'express';
import { findManifestEntry } from './routeManifest';
import { normalizeRoutePath } from './routePathSemantics';
import {
  getRouteRegistrationSnapshot,
  isRouteRegistrationRecorderInstalled,
  type RecordedRouteRegistration,
} from './routeRegistrationRecorder';

export interface MountedApiPathReport {
  /**
   * False when the Express internals could not be walked at all. Callers must
   * treat this as a failure, never as "no routes found" — a silent zero would
   * report a clean scan while inspecting nothing.
   */
  introspectable: boolean;
  paths: string[];
  /** True when registration-time recording proved all relevant shapes. */
  complete?: boolean;
  /** Registration shapes that could not be resolved to a literal path. */
  unresolved?: readonly RecordedRouteRegistration[];
  /** Complete literal registrations, including their exact/prefix shape. */
  registrations?: readonly RecordedRouteRegistration[];
}

export interface MountAuditResult {
  /**
   * True only means "no gap was FOUND". It does not mean none exists — see the
   * blind spots in the module comment.
   */
  noGapsFound: boolean;
  unclassified: string[];
  /** True only when the authoritative recorder proved relevant completeness. */
  complete?: boolean;
  /** Unresolved registration shapes retained for actionable diagnostics. */
  unresolved?: readonly RecordedRouteRegistration[];
  /** Present only when the scan could not be performed at all. */
  reason?: string;
}

export class RouteManifestCoverageError extends Error {
  readonly unclassified: readonly string[];

  constructor(unclassified: readonly string[]) {
    super(`[routeManifest] startup refused: unclassified literal /api registration(s): ${unclassified.join(', ')}`);
    this.name = 'RouteManifestCoverageError';
    this.unclassified = unclassified;
  }
}

/** Startup guard: throw when a literal registration gap is positively proven. */
export function assertRouteManifestCoverage(app: Application): MountAuditResult {
  const result = auditMountedApiRoutes(app);
  // The Express-stack fallback is intentionally diagnostic-only. Never turn
  // its partial view into a startup gate; only an installed recorder is
  // authoritative for this assertion.
  if (isRouteRegistrationRecorderInstalled(app) && result.unclassified.length > 0) {
    throw new RouteManifestCoverageError(result.unclassified);
  }
  return result;
}

/** Express 4 layer shape, narrowed to the parts this scan reads. */
interface ExpressLayer {
  name?: string;
  regexp?: RegExp & { fast_slash?: boolean };
  keys?: { name: string | number }[];
  route?: { path?: string | string[] };
  handle?: { stack?: ExpressLayer[] };
}

/**
 * Recover the literal mount prefix a layer was mounted at, or null when it is
 * not a static literal. Null is a BLIND SPOT, not a safe skip: the surface
 * still exists, this scan just cannot name it.
 */
function literalPrefixOf(layer: ExpressLayer): string | null {
  const re = layer.regexp;
  if (!re) return null;
  if (re.fast_slash) return '';
  if (layer.keys && layer.keys.length > 0) return null;

  const source = re.source;
  const stripped = source
    .replace(/^\^/, '')
    .replace(/\\\/\?\(\?=\\\/\|\$\)$/, '')
    .replace(/\\\/\?\$$/, '')
    .replace(/\$$/, '');
  if (/[()[\]+*?|]/.test(stripped)) return null;
  const prefix = stripped.replace(/\\\//g, '/');
  return prefix.startsWith('/') ? prefix : null;
}

interface Found {
  /** Paths contributed by a leaf route (app.get('/api/x'), router.get(...)). */
  routes: Set<string>;
  /** Paths contributed by mounting a router at a literal prefix. */
  mounts: Set<string>;
}

function collect(stack: ExpressLayer[], base: string, out: Found): void {
  for (const layer of stack) {
    if (layer.route && layer.route.path !== undefined) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const p of paths) {
        if (typeof p === 'string') out.routes.add(joinPath(base, p));
      }
      continue;
    }
    const nested = layer.handle && layer.handle.stack;
    if (Array.isArray(nested)) {
      const prefix = literalPrefixOf(layer);
      const nextBase = prefix === null ? base : joinPath(base, prefix);
      if (prefix !== null && prefix !== '' && nextBase !== base) {
        out.mounts.add(nextBase);
      }
      collect(nested, nextBase, out);
    }
  }
}

/**
 * Concatenate WITHOUT normalising. Express and `classifyRoute` treat '/api//x'
 * and '/api/x' as different paths, so collapsing repeated slashes here made the
 * scan disagree with the dispatcher: '/api//settings' was rewritten to
 * '/api/settings', matched a tenant_required entry and looked covered, while
 * runtime classification returned 'system'. A scan that disagrees with the
 * dispatcher is worse than none.
 */
function joinPath(base: string, segment: string): string {
  // An empty segment leaves the base untouched — a prefixless mount must yield
  // '' so the router's own absolute '/api/...' paths concatenate cleanly, NOT
  // '/', which would produce '//api/...'.
  if (!segment) return base;
  if (segment === '/') return base === '' ? '/' : base;
  return `${base}${segment}`;
}

/**
 * Case-insensitive, because Express routing is: `/API/loud` reaches a handler
 * mounted at `/api/loud`. A case-sensitive check here would leave such a mount
 * unreported — the same mismatch that produced a live tenant-isolation bypass
 * in the central gate (see RouteSetup's policyPath).
 */
function isApiPath(p: string): boolean {
  return p.toLowerCase().startsWith('/api/');
}

/**
 * Literal `/api` paths this scan can see. Incomplete by construction — see the
 * module comment.
 */
export function enumerateMountedApiPaths(app: Application): MountedApiPathReport {
  if (isRouteRegistrationRecorderInstalled(app)) {
    const snapshot = getRouteRegistrationSnapshot(app);
    const paths = new Set<string>();
    for (const registration of snapshot.registrations) {
      // Unresolved dynamic/RegExp/sub-app registrations are carried separately
      // as diagnostics. They are not proven literal gaps and must not make a
      // startup audit claim that it found an actionable manifest mismatch.
      if (registration.completeness !== 'complete') continue;
      if (registration.path === '<unresolved>') continue;
      let canonical: string;
      try {
        canonical = normalizeRoutePath(registration.path);
      } catch {
        continue;
      }
      const isApi = canonical === '/api' || canonical.startsWith('/api/');
      // A bare /api mount is only a namespace. A real exact /api route remains
      // addressable and is retained for manifest coverage.
      if (isApi && (canonical !== '/api' || registration.source === 'route')) paths.add(canonical);
    }
    return {
      introspectable: true,
      paths: [...paths].sort(),
      complete: snapshot.complete,
      unresolved: snapshot.unresolved,
      registrations: snapshot.registrations.filter((registration) => registration.completeness === 'complete'),
    };
  }
  const router = (app as unknown as { _router?: { stack?: ExpressLayer[] } })._router;
  const stack = router && router.stack;
  if (!Array.isArray(stack)) {
    return { introspectable: false, paths: [] };
  }
  const found: Found = { routes: new Set(), mounts: new Set() };
  collect(stack, '', found);

  // Bare '/api' as a MOUNT prefix is a namespace, not a surface: routers and
  // middleware are mounted there so deeper paths resolve, and those deeper
  // paths are reported on their own. It must never be satisfied by a manifest
  // entry, because an entry for '/api' would prefix-match every route in the
  // application and blanket-classify the whole API.
  //
  // Bare '/api' as a ROUTE is a different thing entirely — a real, reachable
  // endpoint — and must be reported. Conflating the two hid it.
  const paths = new Set<string>();
  for (const p of found.routes) {
    if (isApiPath(p) || p.toLowerCase() === '/api') paths.add(p);
  }
  for (const p of found.mounts) {
    if (isApiPath(p)) paths.add(p);
  }
  return { introspectable: true, paths: [...paths].sort() };
}

/**
 * Reports gaps it can find. `noGapsFound: true` is NOT a proof of coverage.
 */
export function auditMountedApiRoutes(app: Application): MountAuditResult {
  const report = enumerateMountedApiPaths(app);
  if (!report.introspectable) {
    return {
      noGapsFound: false,
      unclassified: [],
      reason:
        'could not introspect the Express router stack — this scan inspected nothing, which must not be reported as a clean result',
    };
  }
  const unclassified = isRouteRegistrationRecorderInstalled(app)
    ? [...new Set((report.registrations ?? []).flatMap((registration) => {
        const path = registration.path;
        if (path !== '/api' && !path.startsWith('/api/')) return [];
        if (path === '/api' && registration.source === 'mount') return [];
        const entry = findManifestEntry(path);
        if (!entry) return [path];
        // A prefix mount cannot be covered by an exact manifest leaf because
        // its descendants would otherwise fall through to the safe default.
        // An exact route is safely covered by either an exact entry or a
        // broader prefix entry.
        const manifestMode = entry.matchMode ?? 'prefix';
        return registration.match === 'prefix' && manifestMode === 'exact' ? [path] : [];
      }))]
    : report.paths.filter((p) => findManifestEntry(p.toLowerCase()) === null);
  return {
    noGapsFound: unclassified.length === 0,
    unclassified,
    ...(report.complete === undefined ? {} : { complete: report.complete }),
    ...(report.unresolved === undefined ? {} : { unresolved: report.unresolved }),
  };
}

/**
 * Boot-time diagnostic. Logs ONLY when it positively finds an undeclared
 * surface, and never logs a clean result — it cannot prove one. Deliberately
 * does not throw: with the blind spots above, failing the boot would imply an
 * enforcement guarantee this cannot make.
 */
export function reportUnclassifiedMounts(
  app: Application,
  warn: (message: string) => void
): MountAuditResult {
  const result = auditMountedApiRoutes(app);
  if (result.reason) {
    warn(`[routeManifest] mount scan could not run: ${result.reason}`);
    return result;
  }
  if (result.unresolved && result.unresolved.length > 0) {
    warn(
      `[routeManifest] ${result.unresolved.length} route registration shape(s) could not be resolved to a literal path; ` +
        'coverage is not provable for those registrations. Parameterized, RegExp, and mounted sub-application paths require explicit review.'
    );
  }
  const bareApi = result.unclassified.filter((p) => p.toLowerCase() === '/api');
  const addressable = result.unclassified.filter((p) => p.toLowerCase() !== '/api');
  if (addressable.length > 0) {
    // Report the path AS MOUNTED, but also the canonical lowercase form the
    // manifest is matched against. Emitting only '/API/loud' would invite an
    // operator to paste that casing into ROUTE_MANIFEST, where it would never
    // match — the lookup lowercases, and the dispatcher does too.
    const described = addressable.map((p) => {
      const canonical = p.toLowerCase();
      return canonical === p ? p : `${p} (declare as ${canonical})`;
    });
    warn(
      `[routeManifest] mounted /api surfaces with no ROUTE_MANIFEST entry: ${described.join(', ')} — ` +
        'add entries in src/middleware/setup/routeManifest.ts. This scan is best-effort and cannot prove the absence of other gaps.'
    );
  }
  if (bareApi.length > 0) {
    // Deliberately NOT the generic "add an entry" advice. The manifest matches
    // by prefix, so an entry for '/api' would classify every otherwise-unknown
    // '/api/*' path — the blanket masking this module warns about elsewhere.
    // An exact '/api' route is also outside the central gate's '/api/*' scope
    // check, so it is never classified at runtime either. It cannot be
    // represented until exact-match semantics exist.
    warn(
      '[routeManifest] a route is registered at exactly /api. Its posture cannot be declared in the ' +
        'prefix-matched manifest (an /api entry would blanket-classify the whole API) and it falls outside ' +
        "the central gate's /api/* scope, so it is never classified at runtime. Move it under /api/<name>, " +
        'or add exact-match semantics to the manifest.'
    );
  }
  return result;
}
