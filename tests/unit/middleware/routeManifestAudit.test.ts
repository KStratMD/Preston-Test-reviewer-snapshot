import 'reflect-metadata';
import express from 'express';
import {
  enumerateMountedApiPaths,
  auditMountedApiRoutes,
  reportUnclassifiedMounts,
  assertRouteManifestCoverage,
  RouteManifestCoverageError,
} from '../../../src/middleware/setup/routeManifestAudit';
import { installRouteRegistrationRecorder, resetRouteRegistrationRecorderForTests } from '../../../src/middleware/setup/routeRegistrationRecorder';

/**
 * B8.1 established that the request-time warning fires on 404s to /api/*, so it
 * is evidence about unmatched request paths and proves nothing either way about
 * mount coverage. Mount coverage WAS incomplete — this scan found eleven
 * undeclared surfaces on its first run against the real app, all inside a
 * prefixless router that no scan of `app.use('/api/...')` call sites could see.
 *
 * Apps without the recorder still use a DIAGNOSTIC fallback: it recovers mount
 * paths from Express's compiled regexps and therefore cannot see several
 * registration shapes. Recorder-installed coverage is tested separately above;
 * the fallback limitations remain pinned so a clean fallback is never mistaken
 * for enforcement.
 */
describe('routeManifestAudit', () => {
  afterEach(() => resetRouteRegistrationRecorderForTests());

  describe('registration-time enforcement', () => {
    it('proves literal gaps and completeness from the recorder', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/undeclared-registration', express.Router());

      const result = auditMountedApiRoutes(app);
      expect(result.complete).toBe(true);
      expect(result.noGapsFound).toBe(false);
      expect(result.unclassified).toContain('/api/undeclared-registration');
    });

    it('rejects a prefix mount covered only by an exact manifest leaf', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/health/demo', express.Router());

      const result = auditMountedApiRoutes(app);
      expect(result.unclassified).toContain('/api/health/demo');
    });

    it('accepts an exact route covered by a broader prefix manifest entry', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.get('/api/identity/whoami/extra', (_req, res) => res.end());

      expect(auditMountedApiRoutes(app).unclassified).not.toContain('/api/identity/whoami/extra');
    });

    it('keeps dynamic registrations diagnostic without claiming completeness', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/:tenant/registration', (_req, _res, next) => next());

      const result = auditMountedApiRoutes(app);
      expect(result.complete).toBe(false);
      expect(result.unresolved?.some((entry) => entry.reason === 'parameterized_path')).toBe(true);
      expect(result.noGapsFound).toBe(true);
    });

    it('throws only for a proven literal gap', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/undeclared-startup-surface', express.Router());

      try {
        assertRouteManifestCoverage(app);
        throw new Error('expected coverage guard to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(RouteManifestCoverageError);
      }
    });

    it('still throws for a proven literal gap when another dynamic shape is unresolved', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/:tenant/unresolved-surface', (_req, _res, next) => next());
      app.use('/api/definitely-unclassified-literal', express.Router());

      expect(() => assertRouteManifestCoverage(app)).toThrow(/definitely-unclassified-literal/);
    });

    it('allows startup when only unresolved dynamic registrations remain', () => {
      const app = express();
      installRouteRegistrationRecorder(app);
      app.use('/api/:tenant/startup-surface', (_req, _res, next) => next());

      expect(() => assertRouteManifestCoverage(app)).not.toThrow();
    });

    it('never gates an app that lacks the recorder and uses the fallback scan', () => {
      const app = express();
      app.use('/api/untrusted-fallback-gap', express.Router());

      expect(() => assertRouteManifestCoverage(app)).not.toThrow();
    });
  });

  describe('enumerateMountedApiPaths', () => {
    it('finds a prefix-mounted router', () => {
      const app = express();
      const r = express.Router();
      r.get('/inner', (_req, res) => res.end());
      app.use('/api/widgets', r);

      expect(enumerateMountedApiPaths(app).paths).toContain('/api/widgets');
    });

    it('finds a directly registered app.get path', () => {
      const app = express();
      app.get('/api/direct-thing', (_req, res) => res.end());

      expect(enumerateMountedApiPaths(app).paths).toContain('/api/direct-thing');
    });

    it('finds routes inside a PREFIXLESS router by their internal paths', () => {
      const app = express();
      const r = express.Router();
      r.get('/api/prefixless-thing/health', (_req, res) => res.end());
      app.use(r);

      expect(enumerateMountedApiPaths(app).paths).toContain('/api/prefixless-thing/health');
    });

    it('reports an exact /api ROUTE, which is a real reachable endpoint', () => {
      // Distinct from the '/api' namespace mount below. Conflating the two hid
      // a live endpoint from the scan entirely.
      const app = express();
      app.get('/api', (_req, res) => res.end());

      expect(enumerateMountedApiPaths(app).paths).toContain('/api');
    });

    it('does not treat the bare /api namespace MOUNT as a surface', () => {
      // An entry for '/api' would prefix-match EVERY route in the app, which
      // would blanket-classify the whole API and permanently hide undeclared
      // surfaces behind it.
      const app = express();
      const r = express.Router();
      r.get('/widgets', (_req, res) => res.end());
      app.use('/api', r);

      const paths = enumerateMountedApiPaths(app).paths;
      expect(paths).not.toContain('/api');
      expect(paths).toContain('/api/widgets');
    });

    it('does NOT normalise repeated slashes, because the dispatcher does not', () => {
      // Collapsing '//' made the scan disagree with classifyRoute: '/api//x'
      // was rewritten to '/api/x', matched that entry and looked covered, while
      // runtime classification of the real path returned the default. A scan
      // that disagrees with the dispatcher is worse than no scan.
      const app = express();
      const r = express.Router();
      r.get('/inner', (_req, res) => res.end());
      app.use('/api//settings', r);

      const paths = enumerateMountedApiPaths(app).paths;
      expect(paths).toContain('/api//settings');
      expect(paths).not.toContain('/api/settings');
    });

    it('sees a case-variant /API mount, because Express routing is case-insensitive', () => {
      // Previously a blind spot. It stopped being merely undetected once the
      // central gate began normalising case: a scan that could not see /API
      // mounts would under-report exactly the surfaces that bypassed gating.
      const app = express();
      const r = express.Router();
      r.get('/z', (_req, res) => res.end());
      app.use('/API/loud', r);

      expect(enumerateMountedApiPaths(app).paths).toContain('/API/loud');
      expect(auditMountedApiRoutes(app).noGapsFound).toBe(false);
    });

    it('ignores non-/api paths', () => {
      const app = express();
      app.get('/not-api', (_req, res) => res.end());

      expect(enumerateMountedApiPaths(app).paths).toEqual([]);
    });

    it('flags introspection failure rather than silently reporting no routes', () => {
      const broken = { _router: undefined } as unknown as express.Express;
      const report = enumerateMountedApiPaths(broken);

      expect(report.introspectable).toBe(false);
      expect(report.paths).toEqual([]);
    });
  });

  describe('auditMountedApiRoutes', () => {
    it('finds no gap when every visible /api route resolves to a manifest entry', () => {
      const app = express();
      app.use('/api/identity', express.Router());

      const result = auditMountedApiRoutes(app);
      expect(result.noGapsFound).toBe(true);
      expect(result.unclassified).toEqual([]);
    });

    it('reports a mounted route with no manifest entry', () => {
      const app = express();
      app.use('/api/totally-unregistered-surface', express.Router());

      const result = auditMountedApiRoutes(app);
      expect(result.noGapsFound).toBe(false);
      expect(result.unclassified).toContain('/api/totally-unregistered-surface');
    });

    it('treats broken introspection as a failure, not a clean result', () => {
      const broken = { _router: undefined } as unknown as express.Express;
      const result = auditMountedApiRoutes(broken);

      expect(result.noGapsFound).toBe(false);
      expect(result.reason).toMatch(/introspect/i);
    });

    it('accepts a subpath covered by a shorter manifest prefix', () => {
      const app = express();
      app.get('/api/identity/whoami/extra', (_req, res) => res.end());

      expect(auditMountedApiRoutes(app).noGapsFound).toBe(true);
    });

    it('does not let a near-miss prefix satisfy a different surface', () => {
      const app = express();
      app.use('/api/ai-nonexistent-surface', express.Router());

      const result = auditMountedApiRoutes(app);
      expect(result.noGapsFound).toBe(false);
      expect(result.unclassified).toContain('/api/ai-nonexistent-surface');
    });
  });

  describe('reportUnclassifiedMounts', () => {
    it('logs the undeclared surfaces it finds', () => {
      const app = express();
      app.use('/api/undeclared-surface', express.Router());
      const lines: string[] = [];

      reportUnclassifiedMounts(app, (m) => lines.push(m));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('/api/undeclared-surface');
    });

    it('stays SILENT when it finds nothing, rather than claiming coverage', () => {
      // It cannot prove absence of gaps, so it must never say "all clear" —
      // that would be a claim beyond its evidence.
      const app = express();
      app.use('/api/identity', express.Router());
      const lines: string[] = [];

      reportUnclassifiedMounts(app, (m) => lines.push(m));

      expect(lines).toEqual([]);
    });

    it('logs when the scan itself could not run', () => {
      const broken = { _router: undefined } as unknown as express.Express;
      const lines: string[] = [];

      reportUnclassifiedMounts(broken, (m) => lines.push(m));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/could not run/i);
    });

    it('does not throw — it is a diagnostic, not a gate', () => {
      const app = express();
      app.use('/api/undeclared-surface', express.Router());

      expect(() => reportUnclassifiedMounts(app, () => undefined)).not.toThrow();
    });
  });

  /**
   * FALLBACK SCANNER LIMITATIONS, measured against this implementation rather
   * than assumed. These cases intentionally omit recorder installation so the
   * diagnostic fallback's limits remain explicit and cannot be confused with
   * the authoritative path above.
   *
   * If enforcement later lands, these assertions flip and fail loudly — which
   * is the intent: they are a checklist for that lane, not a blessing.
   */
  describe('fallback scanner limitations (without recorder)', () => {
    const blind: [string, (app: express.Express) => void][] = [
      ['middleware mount with no inner stack', (a) => a.use('/api/mw', (_q, s) => s.json({}))],
      ['bare /api middleware handler', (a) => a.use('/api', (_q, s) => s.json({}))],
      ['parameterised mount', (a) => { const r = express.Router(); r.get('/x', (_q, s) => s.end()); a.use('/api/:tenant/thing', r); }],
      ['mounted sub-app', (a) => { const sub = express(); sub.get('/inner', (_q, s) => s.end()); a.use('/api/subapp', sub); }],
      ['array of mount paths', (a) => { const r = express.Router(); r.get('/y', (_q, s) => s.end()); a.use(['/api/arr-one', '/api/arr-two'], r); }],
      ['direct RegExp route', (a) => a.get(/^\/api\/regex-route$/, (_q, s) => s.end())],
    ];

    it.each(blind)('MISSES: %s', (_label, build) => {
      const app = express();
      build(app);
      expect(auditMountedApiRoutes(app).noGapsFound).toBe(true);
      expect(enumerateMountedApiPaths(app).paths).toEqual([]);
    });

    it.each([
      ['prefixless router', (a: express.Express) => { const r = express.Router(); r.get('/api/seen-prefixless', (_q, s) => s.end()); a.use(r); }],
      ['router at bare /api', (a: express.Express) => { const r = express.Router(); r.get('/seen-bare', (_q, s) => s.end()); a.use('/api', r); }],
    ])('DETECTS: %s (previously mis-described as a blind spot)', (_label, build) => {
      const app = express();
      build(app);
      expect(enumerateMountedApiPaths(app).paths.length).toBeGreaterThan(0);
    });
  });

  describe('remediation advice is actionable', () => {
    it('gives the canonical lowercase form for a case-variant mount', () => {
      // The manifest lookup lowercases, so reporting only '/API/loud' would
      // invite an operator to declare a path that can never match.
      const app = express();
      const r = express.Router();
      r.get('/z', (_req, res) => res.end());
      app.use('/API/loud', r);
      const lines: string[] = [];

      reportUnclassifiedMounts(app, (m) => lines.push(m));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('/API/loud');
      expect(lines[0]).toContain('declare as /api/loud');
    });

    it('does not add a redundant canonical hint when the path is already lowercase', () => {
      const app = express();
      app.use('/api/plain-surface', express.Router());
      const lines: string[] = [];

      reportUnclassifiedMounts(app, (m) => lines.push(m));

      expect(lines[0]).toContain('/api/plain-surface');
      expect(lines[0]).not.toContain('declare as');
    });
  });

  describe('exact /api route guidance', () => {
    it('does not tell the operator to add a manifest entry for bare /api', () => {
      // A manifest entry for '/api' would prefix-match the entire API. The
      // generic remediation would therefore be actively harmful advice.
      const app = express();
      app.get('/api', (_req, res) => res.end());
      const lines: string[] = [];

      reportUnclassifiedMounts(app, (m) => lines.push(m));

      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('registered at exactly /api');
      expect(lines[0]).not.toContain('add entries in');
      expect(lines[0]).toMatch(/blanket-classify|exact-match semantics/);
    });
  });
});
