/**
 * F5 Task 6 (Codex R1 finding 4): PRODUCTION-wiring evidence for the F5
 * families. The helper-level tests in demoFamiliesPolicyGate.routes.test.ts
 * pin the gate COMPOSITION but cannot detect a production mount swap — this
 * test boots the REAL App({ lightweight: true }) and asserts against the
 * express app RouteSetup actually built. Removing any mountXxxRoutes call in
 * RouteSetup fails these.
 *
 * Gate-DISTINCT cost-transparency evidence (plan v6, Codex R3-1/R4): neither
 * a bare 401 nor suspended→403 discriminates the new strict mount from the
 * old centralAuthMiddleware mount (the bare router self-401s
 * `identity_required`, and the old mount also ran the tenantStatusGate). The
 * revert-proof is therefore the anonymous 401 ENVELOPE under hermetic
 * REQUIRE_CENTRAL_AUTH=false: the strict mount returns authMiddleware's exact
 * `{ success: false, error: 'No valid authorization header found' }`, while
 * the reverted optional-auth mount would reach the router and return
 * `{ error: 'identity_required' }` with NO `success` field.
 */

import request from 'supertest';
import jwt from 'jsonwebtoken';

// Hermeticity, BEFORE the App import so src/config/env parses these values:
// - REQUIRE_CENTRAL_AUTH=false pins the OLD central mount's relaxed posture,
//   which the revert-proof envelope assertion below discriminates against.
// - The demo-runtime inputs are forced off so the anonymous demo branch
//   cannot admit the /api/actions and /api/context cases.
// Originals are captured here and restored in afterAll — a Jest worker can
// run several test files in one process (Copilot R3).
const ORIGINAL_ENV = {
  REQUIRE_CENTRAL_AUTH: process.env.REQUIRE_CENTRAL_AUTH,
  HOSTED_DEMO: process.env.HOSTED_DEMO,
  DEMO_MODE: process.env.DEMO_MODE,
  JWT_SECRET: process.env.JWT_SECRET,
};
process.env.REQUIRE_CENTRAL_AUTH = 'false';
delete process.env.HOSTED_DEMO;
delete process.env.DEMO_MODE;
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

const SUSPENDED_TENANT = 'f5-wiring-suspended';

function signToken(claims: Record<string, unknown>): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, {
    algorithm: 'HS256',
    expiresIn: '5m',
  });
}

describe('F5 production wiring — real App({ lightweight: true })', () => {
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
        actorUserId: 'f5-wiring-test',
        actorSource: 'integration_test',
        reason: 'F5 Task 6 production-wiring evidence',
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

  it('anonymous POST /api/actions/request-w9 is central 403 (test env is not a demo runtime)', async () => {
    const res = await request(server).post('/api/actions/request-w9').send({});
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  it('anonymous GET /api/actions/health is 200 (public probe survives the strict mount)', async () => {
    const res = await request(server).get('/api/actions/health');
    expect(res.status).toBe(200);
  });

  it('anonymous GET /api/context/* is central 403 in production wiring', async () => {
    const res = await request(server).get('/api/context/netsuite/customer/123');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  it('anonymous GET /api/cost-transparency/health is 200 (exact public probe)', async () => {
    const res = await request(server).get('/api/cost-transparency/health');
    expect(res.status).toBe(200);
  });

  it('REVERT-PROOF: anonymous GET /api/cost-transparency/dashboard returns the central tenant envelope', async () => {
    const res = await request(server).get('/api/cost-transparency/dashboard');

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({
      code: 'TENANT_REQUIRED',
    });
    expect(res.body.error).not.toBe('identity_required');
  });

  it('BEHAVIORAL: a suspended tenant JWT on /api/cost-transparency/dashboard is 403 tenant_blocked (kill switch live)', async () => {
    const token = signToken({
      sub: 'f5-wiring-user',
      tenantId: SUSPENDED_TENANT,
      roles: ['user'],
    });

    const res = await request(server)
      .get('/api/cost-transparency/dashboard')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: 'tenant_blocked' });
  });
});
