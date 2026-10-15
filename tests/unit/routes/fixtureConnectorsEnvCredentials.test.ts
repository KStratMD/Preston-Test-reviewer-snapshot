/**
 * Regression: the fixture-connector router must never serve environment
 * secrets.
 *
 * `GET /api/fixtures/netsuite/env-credentials` returned NETSUITE_CONSUMER_KEY,
 * NETSUITE_CONSUMER_SECRET, NETSUITE_TOKEN_ID, and NETSUITE_TOKEN_SECRET
 * straight from `process.env`. At the time, the router was mounted BARE in
 * `RouteSetup.ts` — no authMiddleware, no feature flag — and the central gate
 * was permissive when tenant context was absent. So the endpoint was reachable
 * by an unauthenticated request, and `docker-compose.prod.yml` passes those
 * variables through.
 *
 * The endpoint is DELETED rather than gated: this repo's secret posture
 * (SuiteCentral control plane, PRs #1006-#1013) is that secrets are
 * write-only and are returned only as redacted references. Shipping raw
 * consumer/token secrets to a browser is the anti-pattern regardless of who
 * is asking, so the fix removes the capability instead of narrowing it.
 *
 * This suite mounts the router bare DELIBERATELY, to test the router in
 * isolation: it fails if the route is reintroduced behind any middleware at
 * all. Production no longer mounts it bare — F6 sub-project B put the family
 * behind authMiddleware + the tenant kill switch (mountFixtureConnectorRoutes).
 */
import request from 'supertest';
import express from 'express';

jest.mock('../../../src/inversify/inversify.config', () => ({
  container: {
    get: jest.fn(() => ({})),
    getAsync: jest.fn(async () => ({})),
  },
}));

import fixtureRouter from '../../../src/routes/fixtureConnectors';

function makeApp(): express.Application {
  const app = express();
  app.use(express.json());
  app.use('/api/fixtures', fixtureRouter);
  return app;
}

/**
 * Everything the client actually received.
 *
 * Deliberately NOT just `res.body`: a handler using `res.send(secret)` or any
 * non-JSON content type leaves `res.body` empty, so a body-only assertion
 * would pass while the secret went over the wire in `res.text`
 * (Copilot review, PR #1084). Concatenating both makes the assertion
 * independent of content-type.
 */
function wirePayload(res: { body?: unknown; text?: string }): string {
  return `${JSON.stringify(res.body ?? {})}${res.text ?? ''}`;
}

const SECRET_ENV = {
  NETSUITE_ACCOUNT_ID: 'TSTDRV_TEST',
  NETSUITE_CONSUMER_KEY: 'ck-should-never-be-served',
  NETSUITE_CONSUMER_SECRET: 'cs-should-never-be-served',
  NETSUITE_TOKEN_ID: 'ti-should-never-be-served',
  NETSUITE_TOKEN_SECRET: 'ts-should-never-be-served',
};

describe('fixture connectors — environment credentials are never served', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Populate the vars so a surviving handler would return a 200 payload
    // rather than its "credentials not found" 404 — otherwise this suite
    // would pass for the wrong reason.
    for (const [key, value] of Object.entries(SECRET_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });

  afterEach(() => {
    for (const key of Object.keys(SECRET_ENV)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('GET /netsuite/env-credentials is not a route at all', async () => {
    const res = await request(makeApp()).get('/api/fixtures/netsuite/env-credentials');
    expect(res.status).toBe(404);
  });

  it('no configured secret value appears in the response body', async () => {
    const res = await request(makeApp()).get('/api/fixtures/netsuite/env-credentials');
    const body = wirePayload(res);
    for (const value of Object.values(SECRET_ENV)) {
      expect(body).not.toContain(value);
    }
  });

  // Belt and braces: a future handler could serve the same secrets under a
  // different path on this router. Enumerate the router's OWN registered GET
  // routes rather than a hand-written path list — a hard-coded list silently
  // stops covering routes added later, which is precisely how the original
  // endpoint would come back unnoticed (Codex review, PR #1084).
  //
  // Scope is deliberately this router only. Credentials reachable through
  // OTHER route families are out of scope here and tracked separately.
  it('no GET route registered on the fixture router serves a configured secret', async () => {
    const app = makeApp();

    interface RouteLayer {
      route?: { path?: unknown; methods?: Record<string, boolean> };
    }
    const layers = (fixtureRouter as unknown as { stack: RouteLayer[] }).stack;
    const getPaths = layers
      .filter((l) => l.route?.methods?.get && typeof l.route.path === 'string')
      .map((l) => l.route!.path as string);

    // The router must actually expose routes, or this test proves nothing.
    expect(getPaths.length).toBeGreaterThan(5);

    for (const routePath of getPaths) {
      const concrete = routePath
        .replace(/:systemId/g, 'netsuite')
        .replace(/:id/g, '1');
      const res = await request(app).get(`/api/fixtures${concrete}`);
      const body = wirePayload(res);
      for (const value of Object.values(SECRET_ENV)) {
        expect(body).not.toContain(value);
      }
    }
  });
});
