import express from 'express';
import {
  installRouteRegistrationRecorder,
  getRouteRegistrationSnapshot,
  resetRouteRegistrationRecorderForTests,
} from '../../../src/middleware/setup/routeRegistrationRecorder';

describe('route registration recorder', () => {
  afterEach(() => resetRouteRegistrationRecorderForTests());

  it('records literal mounts and direct HTTP routes', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    app.use('/api//settings/', (_req, _res, next) => next());
    app.get('/api/health', (_req, res) => res.sendStatus(200));

    const snapshot = getRouteRegistrationSnapshot(app);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/settings', match: 'prefix', source: 'mount' }),
      expect.objectContaining({ path: '/api/health', match: 'exact', source: 'route' }),
    ]));
  });

  it('records arrays, bare mounts, and prefixless router routes', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const router = express.Router();
    router.get('/api/absolute', (_req, res) => res.sendStatus(200));
    app.use(['/api/a', '/API/b/'], router);
    app.use(router);
    app.use('/api', (_req, _res, next) => next());

    const paths = getRouteRegistrationSnapshot(app).registrations.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/a', '/api/b', '/api/absolute', '/api']));
  });

  it('composes nested router mount prefixes and records late registrations', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const outer = express.Router();
    const inner = express.Router();
    app.use('/api/v1', outer);
    outer.use('/nested', inner);
    inner.post('/items', (_req, res) => res.sendStatus(201));

    expect(getRouteRegistrationSnapshot(app).registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/v1/nested/items', match: 'exact', source: 'route' }),
    ]));
  });

  it('captures nested mounts declared before the outer router is attached', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const outer = express.Router();
    const inner = express.Router();
    outer.use('/nested', inner);
    inner.get('/items', (_req, res) => res.sendStatus(200));
    app.use('/api/v2', outer);

    expect(getRouteRegistrationSnapshot(app).registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/api/v2/nested/items', match: 'exact', source: 'route' }),
    ]));
  });

  it('keeps distinct router identities separate and records uncommon HTTP verbs', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const first = express.Router();
    const second = express.Router();
    first.get('/one', (_req, res) => res.end());
    second.get('/two', (_req, res) => res.end());
    app.use(first);
    app.use(second);
    app.connect('/api/connect', (_req, res) => res.end());
    app.trace('/api/trace', (_req, res) => res.end());
    app['m-search']('/api/m-search', (_req, res) => res.end());

    const snapshot = getRouteRegistrationSnapshot(app);
    expect(snapshot.registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/one', source: 'route' }),
      expect.objectContaining({ path: '/two', source: 'route' }),
      expect.objectContaining({ path: '/api/connect', source: 'route' }),
      expect.objectContaining({ path: '/api/trace', source: 'route' }),
      expect.objectContaining({ path: '/api/m-search', source: 'route' }),
    ]));
  });

  it('attaches every router in handler arrays and multiple handler arguments', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const first = express.Router();
    const second = express.Router();
    first.get('/array-one', (_req, res) => res.end());
    second.get('/array-two', (_req, res) => res.end());
    app.use('/api', [first, [second]]);

    const paths = getRouteRegistrationSnapshot(app).registrations.map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['/api/array-one', '/api/array-two']));
  });

  it('preserves unresolved parameter, regexp, and sub-app registrations', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    app.use('/api/:tenant', (_req, _res, next) => next());
    app.get(/^\/api\/regexp$/, (_req, res) => res.sendStatus(200));
    app.use('/api/sub-app', express());

    const snapshot = getRouteRegistrationSnapshot(app);
    expect(snapshot.complete).toBe(false);
    expect(snapshot.unresolved.map((entry) => entry.reason)).toEqual(expect.arrayContaining([
      'parameterized_path', 'regexp_path', 'mounted_sub_application',
    ]));
  });

  it('keeps nested routes unresolved when their mount prefix is dynamic', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    const child = express.Router();
    child.get('/health', (_req, res) => res.sendStatus(200));
    app.use('/api/:tenant', child);

    const snapshot = getRouteRegistrationSnapshot(app);
    expect(snapshot.registrations).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '<unresolved>', completeness: 'incomplete', reason: 'unresolved_mount_prefix' }),
    ]));
    expect(snapshot.registrations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ path: '/<unresolved>/api/health' }),
    ]));
    expect(snapshot.complete).toBe(false);
  });

  it('does not make global pathless middleware prevent API completeness', () => {
    const app = express();
    installRouteRegistrationRecorder(app);
    app.use(express.json());
    app.get('/api/health', (_req, res) => res.sendStatus(200));

    const snapshot = getRouteRegistrationSnapshot(app);
    expect(snapshot.complete).toBe(true);
    expect(snapshot.unresolved).toEqual([]);
  });
});
