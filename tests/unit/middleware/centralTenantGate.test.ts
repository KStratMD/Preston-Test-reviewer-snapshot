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

  function makeApp(): Application {
    const app = express();
    mountCentralTenantGate(app);
    app.get('/api/ai-demo/test', (req, res) => {
      res.status(200).json({ tenantContextSet: !!req.tenantContext });
    });
    app.get('/api/governance/approvals/test', (req, res) => {
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
    return app;
  }

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

  it('does NOT populate tenantContext from x-tenant-id header (disableHeaderExtraction invariant)', async () => {
    // disableHeaderExtraction: true means the un-verified x-tenant-id header
    // does NOT populate req.tenantContext. This closes the header-impersonation
    // vector against direct consumers like mcpPolicies.ts AND against the
    // extractIdentityContext req.tenantContext bridge added in PR 2C-Auth.
    // The flag is a permanent security invariant — frozen by
    // `audit-status-claims --check-tenant-isolation-invariant`. It does NOT
    // flip in any future PR unless an upstream gateway verifies the header.
    const res = await request(makeApp())
      .get('/api/governance/approvals/test')
      .set('x-tenant-id', 'tenant-A');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
    expect(res.body.tenantId).toBeUndefined();
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

  it('JWT verified against the wrong secret does NOT populate tenantContext', async () => {
    const token = jwt.sign({ sub: 'attacker', tenant_id: 'tenant-x' }, 'wrong-secret');
    const res = await request(makeApp())
      .get('/api/governance/approvals/test')
      .set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
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

  it('does NOT 403 a tenant_required route without tenant context (permissive mode)', async () => {
    const res = await request(makeApp()).get('/api/governance/approvals/test');
    expect(res.status).toBe(200);
    expect(res.body.tenantContextSet).toBe(false);
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
});
