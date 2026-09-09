/**
 * The recorder must capture HTTP methods, or the coverage gate cannot say what
 * it is comparing.
 *
 * `enumerateMountedApiPaths` answers "which paths are mounted"; the OpenAPI
 * spec is keyed by *operation* — `GET /api/things` and `DELETE /api/things` are
 * two documentable things at one path. Without methods on the registration a
 * gate can only ever compare paths, so a route that is mounted for DELETE but
 * documented only for GET reads as covered.
 *
 * Methods arrive by two different routes and both are exercised here:
 *   - the `patchNode` wrapper sees `app.get(...)` and knows the verb directly;
 *   - `app.route(path).post().put()` reaches the wrapper as a bare `route` call
 *     with no verb, so the methods can only be recovered at snapshot time from
 *     `layer.route.methods`.
 * A test that covered only the first would pass against an implementation that
 * silently drops every chained route.
 */
import express from 'express';

import {
  getRouteRegistrationSnapshot,
  installRouteRegistrationRecorder,
  resetRouteRegistrationRecorderForTests,
} from '../../../src/middleware/setup/routeRegistrationRecorder';

describe('routeRegistrationRecorder captures HTTP methods', () => {
  afterEach(() => {
    resetRouteRegistrationRecorderForTests();
  });

  it('records methods for wrapper and chained registrations, and none for mounts', () => {
    const app = express();
    installRouteRegistrationRecorder(app);

    app.get('/api/things', (_q, r) => r.end());
    app.delete('/api/things', (_q, r) => r.end());
    app
      .route('/api/chained')
      .post((_q, r) => r.end())
      .put((_q, r) => r.end());
    const child = express.Router();
    child.post('/', (_q, r) => r.end());
    app.use('/api/child', child);

    const regs = getRouteRegistrationSnapshot(app).registrations;

    expect(
      regs
        .filter((r) => r.path === '/api/things' && r.source === 'route')
        .flatMap((r) => r.methods ?? [])
        .sort(),
    ).toEqual(['DELETE', 'GET']);

    // Chained: the verb never reaches the wrapper, only `layer.route.methods`.
    expect(
      regs
        .filter((r) => r.path === '/api/chained' && r.source === 'route')
        .flatMap((r) => r.methods ?? [])
        .sort(),
    ).toEqual(['POST', 'PUT']);

    // A mount is a prefix, not an operation — it must carry no methods at all,
    // or the gate would invent operations that no handler serves.
    expect(regs.find((r) => r.path === '/api/child' && r.source === 'mount')?.methods).toBeUndefined();
    expect(regs.find((r) => r.path === '/api/child' && r.source === 'route')?.methods).toEqual(['POST']);
  });

  it('keeps same-path different-method registrations distinct', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    app.get('/api/x', (_q, r) => r.end());
    app.post('/api/x', (_q, r) => r.end());

    // The dedupe key must include methods; without that these collapse into one
    // registration and the gate silently stops asking about the second verb.
    expect(getRouteRegistrationSnapshot(app).registrations.filter((r) => r.path === '/api/x').length).toBe(2);
  });

  it('records a stable rawPattern for a RegExp path instead of dropping it', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    app.get(/^\/api\/rx\/.*/, (_q, r) => r.end());

    const reg = getRouteRegistrationSnapshot(app).registrations.find((r) => r.reason === 'regexp_path');
    // A RegExp registration records path '' and so can never be proven non-API.
    // It must remain nameable, or the coverage gate has to either drop it
    // (unsound) or fail permanently with nothing to baseline against.
    expect(reg).toBeDefined();
    expect(reg?.completeness).toBe('incomplete');
    expect(reg?.rawPattern).toBe(String(/^\/api\/rx\/.*/));
  });
});
