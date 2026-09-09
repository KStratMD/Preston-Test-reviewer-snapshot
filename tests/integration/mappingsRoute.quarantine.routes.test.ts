/**
 * Task A3 (tranche 2): `/api/mappings` is quarantined as demo-only.
 *
 * The store behind this family is one global flat file with no tenant column,
 * so nothing about it can be tenant-isolated. It now mounts only under
 * `isDemo()` — the same gate as the mock dashboard fallback — and is classified
 * `demo` in ROUTE_MANIFEST (policy `hosted_demo_public`).
 *
 * Measured, not assumed (two boots, identical): outside a demo runtime
 * `/api/mappings` answers 404 to everyone — the `demo` classification exempts
 * it from tenant gating and nothing is mounted. The two `/api/dashboard/...`
 * mirrors sit behind the dashboard family's own auth layer, so an ANONYMOUS
 * caller gets 401 there before mount presence matters; an authenticated caller
 * reaches routing and finds nothing: 404. Every answer is "absent"; none is
 * data. The plan text said 404 only — the 401s are what the dashboard layer
 * really does for the unauthenticated case.
 *
 * Both cases boot the REAL App. DEMO_MODE is pinned explicitly for each: left
 * unset, a persisted `global/demo_mode` row could decide it (see
 * docs/operations/RATCHETS-AND-GATES.md, OpenAPI route coverage gate), and the
 * module-level override is cleared between boots so the first App's state
 * cannot leak into the second.
 */
const ORIGINAL_ENV = {
  DEMO_MODE: process.env.DEMO_MODE,
  HOSTED_DEMO: process.env.HOSTED_DEMO,
  DB_TYPE: process.env.DB_TYPE,
  SQLITE_DB_PATH: process.env.SQLITE_DB_PATH,
};
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = ':memory:';
delete process.env.HOSTED_DEMO;

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { App } from '../../src/app';
import { setDemoModeOverride } from '../../src/config/runtimeFlags';

/** path → status an ANONYMOUS caller gets outside demo mode. */
const ABSENT_ANONYMOUS: Record<string, number> = {
  '/api/mappings': 404,
  '/api/dashboard/api/mappings': 401,
  '/api/dashboard/mappings': 401,
};
const FAMILY = Object.keys(ABSENT_ANONYMOUS);

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m' });
}

async function bootWithDemoMode(demo: boolean): Promise<App> {
  setDemoModeOverride(undefined);
  process.env.DEMO_MODE = demo ? '1' : '0';
  const app = new App({ lightweight: true });
  await app.waitForInitialization();
  return app;
}

describe('/api/mappings quarantine (Task A3)', () => {
  afterAll(() => {
    setDemoModeOverride(undefined);
    restoreEnv();
  });

  it('is ABSENT outside demo mode: no mount answers with data, authenticated or not', async () => {
    const app = await bootWithDemoMode(false);
    const token = signToken({ sub: 'user-1', tenantId: 'tenant-active' });
    try {
      for (const path of FAMILY) {
        const anon = await request(app.getExpressApp()).get(path);
        expect({ path, who: 'anonymous', status: anon.status }).toEqual({ path, who: 'anonymous', status: ABSENT_ANONYMOUS[path] });
        expect(Array.isArray(anon.body)).toBe(false);
        const authed = await request(app.getExpressApp()).get(path).set('Authorization', `Bearer ${token}`);
        expect({ path, who: 'authenticated', status: authed.status }).toEqual({ path, who: 'authenticated', status: 404 });
        expect(Array.isArray(authed.body)).toBe(false);
      }
    } finally {
      await app.shutdown();
    }
  }, 60_000);

  it('mounts in demo mode and answers the (empty) catalogue', async () => {
    const app = await bootWithDemoMode(true);
    try {
      for (const path of FAMILY) {
        const res = await request(app.getExpressApp()).get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 200 });
        expect(Array.isArray(res.body)).toBe(true);
      }
    } finally {
      await app.shutdown();
    }
  }, 60_000);

  it('goes dark the moment demo mode is switched off at RUNTIME, with the router still mounted (Codex on PR #1253)', async () => {
    // The mount gate runs once at startup; adminSettings -> DemoModeService.setDemoMode
    // can turn demo off afterwards. The router decides per request as well.
    const app = await bootWithDemoMode(true);
    try {
      expect((await request(app.getExpressApp()).get('/api/mappings')).status).toBe(200);
      setDemoModeOverride(false);
      process.env.DEMO_MODE = '0';
      for (const path of FAMILY) {
        // The router's own per-request guard answers first on every mount, so
        // this is 404 everywhere — unlike a fresh non-demo boot, where the
        // dashboard auth layer reaches anonymous callers before routing.
        const res = await request(app.getExpressApp()).get(path);
        expect({ path, status: res.status }).toEqual({ path, status: 404 });
        expect(Array.isArray(res.body)).toBe(false);
      }
      setDemoModeOverride(true);
      process.env.DEMO_MODE = '1';
      expect((await request(app.getExpressApp()).get('/api/mappings')).status).toBe(200);
    } finally {
      await app.shutdown();
    }
  }, 60_000);
});
