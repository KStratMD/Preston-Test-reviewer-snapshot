import express, { Application } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { mountCentralTenantGate } from '../../../src/middleware/setup/RouteSetup';

// tenantIsolation captures `jwtSecret = options.jwtSecret ||
// process.env.JWT_SECRET || ''` ONCE at middleware-factory invocation
// (`tenantIsolation(options)` constructor, not per request). The closure
// then verifies every JWT against that captured secret. So JWT_SECRET must
// be set BEFORE `makeApp()` runs (which calls `mountCentralTenantGate(app)`
// which calls `tenantIsolation({...})`). The fast jest suite doesn't load
// `tests/setup.ts`, so the env var is unset by default — pin it inside
// beforeAll and restore in afterAll so this spec doesn't leak its secret
// into later files in the serial (`maxWorkers: 1`) fast suite.
const JWT_SECRET = 'pr2c-auth-central-gate-spec-secret-min-32-chars';
let previousJwtSecret: string | undefined;

describe('mountCentralTenantGate', () => {
  beforeAll(() => {
    previousJwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = JWT_SECRET;
  });

  afterAll(() => {
    if (previousJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = previousJwtSecret;
    }
  });

  function makeApp(
    options: { strictMode?: boolean; isDemoRuntime?: () => boolean } = {
      strictMode: true,
      isDemoRuntime: () => false,
    },
  ): Application {
    const app = express();
    app.locals.approvalHandlerCalls = 0;
    mountCentralTenantGate(app, options);
    app.get('/api/ai-demo/test', (req, res) => {
      res.status(200).json({ tenantContextSet: !!req.tenantContext });
    });
    app.get('/api/governance/approvals/test', (req, res) => {
      app.locals.approvalHandlerCalls += 1;
      res.status(200).json({
        tenantContextSet: !!req.tenantContext,
        tenantId: req.tenantContext?.tenantId,
      });
    });
    app.get('/health', (req, res) => {
      res.status(200).json({ tenantContextSet: !!req.tenantContext });
    });
    app.get('/api/admin/tenants/test', (req, res) => {
      res.status(200).json({ tenantContextSet: !!req.tenantContext });
    });
    app.get('/api/customer-central/dashboard', (req, res) => {
      res.status(200).json({
        tenantContextSet: !!req.tenantContext,
        tenantId: req.tenantContext?.tenantId,
        source: req.tenantContext?.metadata?.source,
      });
    });
    return app;
  }

  it('strict mode refuses an anonymous hosted-demo path outside demo runtime', async () => {
    const res = await request(makeApp({ strictMode: true, isDemoRuntime: () => false }))
      .get('/api/customer-central/dashboard');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
  });

  it('populate-only deferral preserves verified JWT tenant context for the route owner', async () => {
    const token = jwt.sign({ sub: 'user-a', tenant_id: 'tenant-jwt' }, JWT_SECRET, {
      expiresIn: '1h',
    });
    const res = await request(makeApp({ strictMode: true, isDemoRuntime: () => false }))
      .get('/api/customer-central/dashboard')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      tenantContextSet: true,
      tenantId: 'tenant-jwt',
      source: 'jwt',
    });
  });

  it('does NOT populate tenantContext for demo routes', async () => {
    const res = await request(makeApp()).get('/api/ai-demo/test');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
  });

  it('does NOT populate tenantContext for public routes', async () => {
    const res = await request(makeApp()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
  });

  it('refuses x-tenant-id-only access without reaching the handler', async () => {
    // disableHeaderExtraction: true means the un-verified x-tenant-id header
    // does NOT populate req.tenantContext. This closes the header-impersonation
    // vector against direct consumers like mcpPolicies.ts AND against the
    // extractIdentityContext req.tenantContext bridge added in PR 2C-Auth.
    // The flag is a permanent security invariant — frozen by
    // `audit-status-claims --check-tenant-isolation-invariant`. It does NOT
    // flip in any future PR unless an upstream gateway verifies the header.
    const app = makeApp();
    const res = await request(app)
      .get('/api/governance/approvals/test')
      .set('x-tenant-id', 'tenant-A');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(app.locals.approvalHandlerCalls).toBe(0);
  });

  it('DOES populate tenantContext from a Bearer JWT verified against JWT_SECRET (PR 2C-Auth)', async () => {
    // The other side of the disableHeaderExtraction invariant: verified
    // sources still flow through. tenantIsolation's built-in JWT extraction
    // runs even when disableHeaderExtraction is true. This is what makes
    // the extractIdentityContext req.tenantContext bridge useful — it inherits
    // the verified-source-only guarantee.
    const token = jwt.sign({ sub: 'user-a', tenant_id: 'tenant-jwt' }, JWT_SECRET, {
      expiresIn: '1h',
    });
    const res = await request(makeApp())
      .get('/api/governance/approvals/test')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(true);
    expect(res.body.tenantId).toBe('tenant-jwt');
  });

  it('refuses a JWT verified against the wrong secret without reaching the handler', async () => {
    const app = makeApp();
    const token = jwt.sign({ sub: 'attacker', tenant_id: 'tenant-x' }, 'wrong-secret');
    const res = await request(app)
      .get('/api/governance/approvals/test')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(app.locals.approvalHandlerCalls).toBe(0);
  });

  it('Bearer JWT wins over spoofed x-tenant-id header', async () => {
    const token = jwt.sign({ sub: 'user-a', tenant_id: 'tenant-alpha' }, JWT_SECRET, {
      expiresIn: '1h',
    });
    const res = await request(makeApp())
      .get('/api/governance/approvals/test')
      .set('Authorization', `Bearer ${token}`)
      .set('x-tenant-id', 'tenant-bravo');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(true);
    expect(res.body.tenantId).toBe('tenant-alpha');
  });

  it('refuses a tenant_required route without tenant context before the handler', async () => {
    const app = makeApp();
    const res = await request(app).get('/api/governance/approvals/test');
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
    expect(app.locals.approvalHandlerCalls).toBe(0);
  });

  it('retains an explicit permissive compatibility seam for focused tests', async () => {
    const app = makeApp({ strictMode: false, isDemoRuntime: () => false });
    const res = await request(app).get('/api/governance/approvals/test');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
    expect(app.locals.approvalHandlerCalls).toBe(1);
  });

  it('does NOT populate tenantContext for system routes (auth is enforced separately at the handler level)', async () => {
    const res = await request(makeApp())
      .get('/api/admin/tenants/test')
      .set('x-tenant-id', 'tenant-A');
    expect(res.status).toBe(200);
    // System routes short-circuit to next() identically to public/demo; the
    // central gate does NOT delegate identity to tenantIsolation here, so
    // tenantContext stays unset even when a header is sent. Production
    // system routes rely on authMiddleware downstream.
    expect(res.body.tenantContextSet).toBe(false);
  });

  it('does NOT classify non-/api paths (e.g. /openapi.yaml short-circuits without classification)', async () => {
    const probeApp = express();
    let observedContext: unknown = 'NOT_OBSERVED';
    mountCentralTenantGate(probeApp);
    probeApp.get('/openapi.yaml', (req, res) => {
      observedContext = req.tenantContext;
      res.status(200).json({ ok: true });
    });
    const res = await request(probeApp).get('/openapi.yaml');
    expect(res.status).toBe(200);
    expect(observedContext).toBeUndefined();
  });

  /**
   * SECURITY REGRESSION (B8, found by Copilot on PR #1172).
   *
   * Express routing is case-insensitive by default, so `/API/mappings` reaches
   * the handler mounted at `/api/mappings`. The central gate's scope check was
   * case-SENSITIVE (`req.path.startsWith('/api/')`), so an upper- or mixed-case
   * request short-circuited before classification: `tenant_required` never
   * applied and `tenantIsolation` never ran.
   *
   * Verified against the running application before the fix:
   *   GET /api/mappings -> 403 {"code":"TENANT_REQUIRED"}
   *   GET /API/mappings -> 200 with mapping data
   *
   * These tests pin the whole chain — status, body code, and that the handler
   * is never entered — for every casing, plus a public route so the fix cannot
   * over-gate by classifying paths it should leave alone.
   *
   * The probe route is /api/settings, not /api/mappings: since tranche-2 Task A3
   * the mappings family is classified demo (global flat-file store, demo-only
   * mount), so it no longer exercises tenant_required. The facts above about
   * /api/mappings are historical — what was observed on PR #1172 — and the
   * regression they describe is in the gate's scope check, not in any route.
   */
  describe('path casing cannot bypass classification', () => {
    function makeCaseApp(): Application {
      const app = express();
      app.locals.mappingHandlerCalls = 0;
      app.locals.identityHandlerCalls = 0;
      mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
      // tenant_required per ROUTE_MANIFEST.
      app.get('/api/settings', (req, res) => {
        app.locals.mappingHandlerCalls += 1;
        res.status(200).json({ tenantContextSet: !!req.tenantContext });
      });
      // public per ROUTE_MANIFEST — must stay reachable in any casing.
      app.get('/api/identity', (req, res) => {
        app.locals.identityHandlerCalls += 1;
        res.status(200).json({ tenantContextSet: !!req.tenantContext });
      });
      return app;
    }

    it.each([
      ['lower', '/api/settings'],
      ['UPPER', '/API/settings'],
      ['MiXeD', '/Api/SeTTings'],
    ])('refuses a tenant_required route in %s case without reaching the handler', async (_label, path) => {
      const app = makeCaseApp();
      const res = await request(app).get(path);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.mappingHandlerCalls).toBe(0);
    });

    it.each([
      ['lower', '/api/identity'],
      ['UPPER', '/API/identity'],
      ['MiXeD', '/Api/IdEnTiTy'],
    ])('leaves a public route reachable and ungated in %s case', async (_label, path) => {
      // Guards the opposite failure: normalising for classification must not
      // start gating routes that are declared public.
      const app = makeCaseApp();
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.tenantContextSet).toBe(false);
      expect(app.locals.identityHandlerCalls).toBe(1);
    });

    it('does not mutate req.path — handlers still see the original casing', async () => {
      const app = express();
      let observedPath: string | undefined;
      mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
      app.get('/api/identity', (req, res) => {
        observedPath = req.path;
        res.status(200).json({ ok: true });
      });
      await request(app).get('/API/identity');
      expect(observedPath).toBe('/API/identity');
    });
  });

});
