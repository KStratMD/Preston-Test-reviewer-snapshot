import express from 'express';
import request from 'supertest';

describe('GET /api/metrics scrape auth', () => {
  // Shallow copy, not a reference — in-place mutations of process.env by
  // code under test must not leak into the restored snapshot.
  const OLD_ENV = { ...process.env };
  afterEach(() => { process.env = { ...OLD_ENV }; jest.resetModules(); });

  function makeApp(): express.Express {
    // Re-require after env mutation so module-level reads see the test env.
    const { createMetricsRouter } = jest.requireActual('../../../src/routes/metrics');
    const app = express();
    app.use('/api/metrics', createMetricsRouter());
    return app;
  }

  it('serves openly when no token configured outside production', async () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'test', METRICS_SCRAPE_TOKEN: '' };
    await request(makeApp()).get('/api/metrics').expect(200);
  });

  it('403s without token in production when none configured', async () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'production', HOSTED_DEMO: '', METRICS_SCRAPE_TOKEN: '' };
    await request(makeApp()).get('/api/metrics').expect(403);
  });

  it('enforces the bearer token when configured', async () => {
    process.env = { ...OLD_ENV, NODE_ENV: 'test', METRICS_SCRAPE_TOKEN: 'sekrit' };
    const app = makeApp();
    await request(app).get('/api/metrics').expect(403);
    await request(app).get('/api/metrics').set('Authorization', 'Bearer sekrit').expect(200);
  });

  function makeAuthedApp(mountPath: string): express.Express {
    const { createMetricsRouter } = jest.requireActual('../../../src/routes/metrics');
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 1, username: 'ops', tenantId: 't1', roles: [], permissions: [] };
      next();
    });
    app.use(mountPath, createMetricsRouter());
    return app;
  }

  it('passes a JWT-authenticated caller on the top-level /metrics mount', async () => {
    // The top-level /metrics mount runs REQUIRED authMiddleware BEFORE this
    // router; simulate its effect by populating req.user upstream.
    process.env = { ...OLD_ENV, NODE_ENV: 'production', HOSTED_DEMO: '', METRICS_SCRAPE_TOKEN: '' };
    await request(makeAuthedApp('/metrics')).get('/metrics').expect(200);
  });

  it('does NOT let a tenant JWT bypass the scrape gate on /api/metrics', async () => {
    // The global /api optionalAuthMiddleware populates req.user for ANY
    // valid tenant JWT — that must not grant cross-tenant metric access.
    process.env = { ...OLD_ENV, NODE_ENV: 'production', HOSTED_DEMO: '', METRICS_SCRAPE_TOKEN: '' };
    await request(makeAuthedApp('/api/metrics')).get('/api/metrics').expect(403);
  });
});
