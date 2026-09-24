/**
 * F5b Task 4: PRODUCTION-wiring evidence for the eight non-tenant-aware
 * *-central families. centralFamiliesPolicyGate.routes.test.ts pins the gate
 * COMPOSITION but cannot detect a production mount swap — this boots the REAL
 * App({ lightweight: true }) and asserts against the express app RouteSetup
 * actually built. Reverting any single mountCentralFamilyRoutes call in
 * setupSuiteCentralRoutes fails its case here.
 *
 * REVERT-PROOF: under the OLD centralAuthMiddleware mount with hermetic
 * REQUIRE_CENTRAL_AUTH=false, optionalAuthMiddleware lets an anonymous request
 * straight through to the router, which answers 200 with demo fixtures. A 401
 * carrying authMiddleware's exact envelope is only reachable through the new
 * gated mount.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

// Hermeticity, BEFORE the App import so src/config/env parses these values:
// - REQUIRE_CENTRAL_AUTH=false pins the OLD central mount's relaxed posture,
//   which the revert-proof envelope assertion below discriminates against.
// - The demo-runtime inputs are forced off so the anonymous demo branch
//   cannot admit the allowlisted /dashboard reads.
// Originals are captured here and restored in afterAll — a Jest worker can
// run several test files in one process.
//
// The ordering is real, not incidental. The project compiles CommonJS
// ("module": "commonjs"; tsconfig.test.json extends it and no jest config sets
// useESM), and TypeScript's CommonJS emit leaves each `require` at the SOURCE
// position of its import rather than hoisting it above preceding statements. So
// these assignments run before src/app — and transitively src/config/env — is
// evaluated. That matters specifically for HOSTED_DEMO, which is in the zod
// schema and is therefore snapshotted into `env` at module evaluation;
// REQUIRE_CENTRAL_AUTH and DEMO_MODE are read live from process.env and are not
// snapshot-sensitive. Under native ESM the imports WOULD be hoisted past this
// block and the App import would have to become a runtime require.
//
// Ordering alone is NOT sufficient for hermeticity — src/config/env.ts also runs
// dotenv.config() — which is why the demo flags below are pinned to falsy values
// rather than deleted. See the note there.
const ORIGINAL_ENV = {
  REQUIRE_CENTRAL_AUTH: process.env.REQUIRE_CENTRAL_AUTH,
  HOSTED_DEMO: process.env.HOSTED_DEMO,
  DEMO_MODE: process.env.DEMO_MODE,
  JWT_SECRET: process.env.JWT_SECRET,
};
process.env.REQUIRE_CENTRAL_AUTH = 'false';
// Pinned to explicit falsy values rather than deleted. src/config/env.ts calls
// dotenv.config() at module evaluation; dotenv does not override a key that is
// already present, but it DOES populate one that is absent — so deleting these
// lets a developer's gitignored .env silently re-enable the demo runtime and
// flip the anonymous /dashboard assertions from 401 to 200. 'false' parses to
// false through parseBooleanEnvFlag (HOSTED_DEMO, snapshotted into `env`), and
// isDemoMode() tests DEMO_MODE === '1' live, so '0' is off.
process.env.HOSTED_DEMO = 'false';
process.env.DEMO_MODE = '0';
process.env.JWT_SECRET =
  process.env.JWT_SECRET || 'dev-demo-secret-123456789012345678901234567890';

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

import { App } from '../../src/app';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';
import { PartialTenantRevocationError } from '../../src/services/tenants/TenantErrors';

const SUSPENDED_TENANT = 'f5b-wiring-suspended';

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

const PHASE_ONE_FAMILIES = [
  '/api/customer-central',
  '/api/quality-central',
  '/api/payout-central',
  '/api/installer-central',
  '/api/service-central',
  '/api/inventory-central',
  '/api/contract-central',
  '/api/portal-central',
];

describe('F5b production wiring — real App({ lightweight: true })', () => {
  let appInstance: App;
  let server: ReturnType<App['getExpressApp']>;

  beforeAll(async () => {
    appInstance = new App({ lightweight: true });
    await appInstance.waitForInitialization();
    server = appInstance.getExpressApp();

    // Materialize a REAL suspended tenant through the live lifecycle service
    // (auto-register active via the gate's own seam, then a durable
    // active→suspended transition) so the behavioral kill-switch case below
    // exercises the production DB path, not a fake.
    const tenantSvc = await container.getAsync<TenantLifecycleService>(
      TYPES.TenantLifecycleService,
    );
    await tenantSvc.requireActive(SUSPENDED_TENANT);
    try {
      await tenantSvc.setStatus({
        tenantId: SUSPENDED_TENANT,
        newStatus: 'suspended',
        actorUserId: 'f5b-wiring-test',
        actorSource: 'integration_test',
        reason: 'F5b Task 14 production-wiring evidence',
      });
    } catch (err) {
      // The status transition commits BEFORE embedded-token revocation, and
      // the test env's SecretManager (environment provider) cannot revoke —
      // the documented partial-failure semantic. The durable status is
      // already 'suspended'; anything else is a real failure.
      if (!(err instanceof PartialTenantRevocationError)) throw err;
    }
    expect(await tenantSvc.getStatus(SUSPENDED_TENANT)).toBe('suspended');
  });

  afterAll(async () => {
    await appInstance.shutdown();
    restoreEnv();
  });

  it.each(PHASE_ONE_FAMILIES)(
    'anonymous GET %s/dashboard is central 403 (test env is not a demo runtime)',
    async (prefix) => {
      const res = await request(server).get(`${prefix}/dashboard`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    },
  );

  it.each(PHASE_ONE_FAMILIES)(
    'anonymous GET %s/health is 200 (public probe survives the gated mount)',
    async (prefix) => {
      const res = await request(server).get(`${prefix}/health`);
      expect(res.status).toBe(200);
    },
  );

  // ==========================================================================
  // F5b Task 14: the four tenant-aware families (Phase 2, PR-F5b-2)
  // ==========================================================================

  it.each([
    ['/api/payment-central', '/invoices/i1/approve'],
    ['/api/supplier-central', '/purchase-orders/p1/acknowledge'],
    ['/api/finance-central', '/approvals/a1/approve'],
  ])('anonymous POST %s%s is central 403 (intentional demo breakage, reads-only rule)', async (prefix, path) => {
    const res = await request(server).post(`${prefix}${path}`).send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  it.each([
    '/api/payment-central',
    '/api/supplier-central',
    '/api/finance-central',
    '/api/workflow-central',
  ])('anonymous GET %s/dashboard is central 403 (test env is not a demo runtime)', async (prefix) => {
    const res = await request(server).get(`${prefix}/dashboard`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  it.each([
    '/api/payment-central',
    '/api/supplier-central',
    '/api/finance-central',
  ])('anonymous GET %s/health is 200 but /health/detail is 401 (exact probe)', async (prefix) => {
    const probe = await request(server).get(`${prefix}/health`);
    expect(probe.status).toBe(200);
    // PLAIN liveness only — the pre-F5b payment and supplier handlers served
    // operational metrics (processor status, 24h transaction success rate,
    // per-tenant onboarding stats) to anonymous callers; the public probe
    // must never carry data beyond liveness (Codex review, PR #1081 R1).
    expect(probe.body).toMatchObject({ status: 'healthy' });
    expect(probe.body).not.toHaveProperty('processors');
    expect(probe.body).not.toHaveProperty('transactions');
    expect(probe.body).not.toHaveProperty('metrics');
    expect((await request(server).get(`${prefix}/health/detail`)).status).toBe(401);
  });

  it('anonymous GET /api/workflow-central/health reaches the router (503 while unhydrated, never 401)', async () => {
    // The public probe is ADMITTED anonymously by the gate — but workflowCentral
    // mounts its hydration-readiness middleware ahead of every route, and the
    // lightweight App never hydrates the engine, so the router answers 503.
    // That is correct monitoring semantics (not-ready ≠ auth-required); a 401
    // here would mean the gated mount stopped declaring the probe public.
    const res = await request(server).get('/api/workflow-central/health');
    expect(res.status).toBe(503);
    expect((await request(server).get('/api/workflow-central/health/detail')).status).toBe(401);
  });

  it('BEHAVIORAL: a suspended tenant JWT on /api/finance-central/dashboard is 403 tenant_blocked', async () => {
    const token = signToken({ sub: 'f5b-user', tenantId: SUSPENDED_TENANT, roles: ['user'] });
    const res = await request(server)
      .get('/api/finance-central/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
  });

  it('BEHAVIORAL: an authenticated TENANT-LESS token is 403 tenant_id_missing (gate, not the helper 401)', async () => {
    const token = signToken({ sub: 'f5b-user', roles: ['user'] });
    const res = await request(server)
      .get('/api/finance-central/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
  });
});
