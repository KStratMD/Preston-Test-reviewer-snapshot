// PR 2C-Auth — end-to-end JWT propagation through the central gate.
//
// Proves the full chain:
//   1. Bearer JWT signed against JWT_SECRET hits /api/* routes.
//   2. optionalAuthMiddleware (global mount on /api/*) populates req.user
//      with normalized tenantId/userId.
//   3. mountCentralTenantGate's tenantIsolation dispatcher populates
//      req.tenantContext from the same JWT (via the tenantIsolation
//      middleware's built-in JWT extraction). disableHeaderExtraction: true
//      means the x-tenant-id header path is NOT used.
//   4. extractIdentityContext walks req.auth → req.user → req.tenantContext
//      and returns the JWT tenant.
//
// SECURITY REGRESSIONs cover the PR 4B R2 + R4 findings:
//   - x-tenant-id header alone (no Bearer) → SYSTEM_IDENTITY at handler.
//   - Bearer for tenant-A + spoofed x-tenant-id: tenant-B → JWT wins.
//   - Malformed JWT (wrong secret) → SYSTEM_IDENTITY (optional auth path
//     silently swallows verify failures; req.user not populated).

import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { STRONG_TEST_JWT_SECRET } from './setupEnv';
import { authMiddleware, optionalAuthMiddleware } from '../../src/middleware/auth';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import { extractIdentityContext } from '../../src/services/governance/identityContext';

// jest.slow.config.cjs runs `tests/integration/setupEnv.ts` as a setupFile
// BEFORE this module loads, which sets process.env.JWT_SECRET ←
// STRONG_TEST_JWT_SECRET. src/config/env.ts then captures that value into
// `env.JWT_SECRET` when transitively imported above. tenantIsolation
// captures `jwtSecret = options.jwtSecret || process.env.JWT_SECRET || ''`
// ONCE inside the middleware factory (`tenantIsolation(options)`) at
// middleware-construction time — NOT per request. authMiddleware reads
// env.JWT_SECRET (cached at first resolveServices() call). Both capture the
// secret upstream of any test running below — sign with the same secret
// here to keep verification end-to-end deterministic.
const JWT_SECRET = STRONG_TEST_JWT_SECRET;

function buildApp(): express.Express {
  const app = express();
  app.locals.probeHandlerCalls = 0;
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  // The probe is tenant_required (matches /api/governance/approvals manifest
  // entry which is tenant_required — pick that prefix so the central gate
  // dispatcher runs tenantIsolation for the probe path).
  app.get('/api/governance/approvals/_whoami_probe_pr2c', (req, res) => {
    app.locals.probeHandlerCalls += 1;
    const identity = extractIdentityContext(req);
    res.json({
      identity,
      reqUser: req.user
        ? { id: req.user.id, tenantId: req.user.tenantId }
        : null,
      reqTenantContext: req.tenantContext
        ? { tenantId: req.tenantContext.tenantId, source: req.tenantContext.metadata?.source }
        : null,
      // Reported separately from reqTenantContext so the exact-shape
      // assertions on that object stay exact.
      tenantContextOrganizationId: req.tenantContext?.organizationId ?? null,
    });
  });
  return app;
}

function buildStrictComposedApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.post('/api/testing/mcp-schema', (req, res) => {
    const identity = extractIdentityContext(req);
    res.json({
      identity,
      reqUser: req.user
        ? { id: req.user.id, tenantId: req.user.tenantId }
        : null,
      reqTenantContext: req.tenantContext
        ? { tenantId: req.tenantContext.tenantId, source: req.tenantContext.metadata?.source }
        : null,
      // Reported separately from reqTenantContext so the exact-shape
      // assertions on that object stay exact.
      tenantContextOrganizationId: req.tenantContext?.organizationId ?? null,
    });
  });
  return app;
}

function buildStrictComposedApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.post('/api/testing/mcp-schema', (req, res) => {
    const identity = extractIdentityContext(req);
    res.json({
      identity,
      reqUser: req.user
        ? { id: req.user.id, tenantId: req.user.tenantId }
        : null,
      reqTenantContext: req.tenantContext
        ? { tenantId: req.tenantContext.tenantId, source: req.tenantContext.metadata?.source }
        : null,
    });
  });
  return app;
}

function signJwt(claims: Record<string, unknown>): string {
  return jwt.sign(claims, JWT_SECRET, { expiresIn: '1h' });
}

describe('PR 2C-Auth — end-to-end JWT propagation', () => {
  describe('happy path', () => {
    it('Bearer JWT → req.user + req.tenantContext + extractIdentityContext all carry the JWT tenant', async () => {
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual({
        tenantId: 'tenant-alpha',
        userId: 'user-a',
      });
      expect(res.body.reqUser).toEqual({
        id: 'user-a',
        tenantId: 'tenant-alpha',
      });
      expect(res.body.reqTenantContext).toEqual({
        tenantId: 'tenant-alpha',
        source: 'verified-user',
      });
    });

    it('strict-compatible public refinement preserves verified identity population', async () => {
      const app = buildStrictComposedApp();
      const token = signJwt({ sub: 'user-mcp', tenant_id: 'tenant-mcp' });
      const res = await request(app)
        .post('/api/testing/mcp-schema')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual({ tenantId: 'tenant-mcp', userId: 'user-mcp' });
      expect(res.body.reqUser).toEqual({ id: 'user-mcp', tenantId: 'tenant-mcp' });
      expect(res.body.reqTenantContext).toEqual({
        tenantId: 'tenant-mcp',
        source: 'verified-user',
      });
    });

    it('JWT with `tenantId` claim name (camelCase) is accepted by optionalAuthMiddleware', async () => {
      // authMiddleware reads tenantId | tid | tenant_id defensively and
      // normalizes the winning claim onto req.user. tenantIsolation consumes
      // that normalized value ahead of its own raw-bearer parsing, which
      // recognizes only the snake_case `tenant_id` claim. So req.tenantContext
      // is populated for any of the three claim spellings, and claim-name
      // handling lives in exactly one place.
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenantId: 'tenant-camel' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity.tenantId).toBe('tenant-camel');
      expect(res.body.reqUser).toEqual({ id: 'user-a', tenantId: 'tenant-camel' });
      expect(res.body.reqTenantContext).toEqual({
        tenantId: 'tenant-camel',
        source: 'verified-user',
      });
    });

    it('an org_id claim reaches req.tenantContext.organizationId', async () => {
      // req.tenantContext.organizationId is the only source its consumers
      // have for the organization (MappingRouter stamps it onto cost-tracking
      // rows; MCPRouter falls back to it for a tenant). The verified-user
      // path outranks raw bearer parsing for every authenticated request, so
      // the claim must survive authMiddleware's normalization onto req.user
      // and tenantIsolation's forwarding — not just the bearer path.
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', org_id: 'org-77' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqTenantContext).toEqual({
        tenantId: 'tenant-alpha',
        source: 'verified-user',
      });
      expect(res.body.tenantContextOrganizationId).toBe('org-77');
    });

    it('the organizationId spelling of the organization claim is honored too', async () => {
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', organizationId: 'org-88' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.tenantContextOrganizationId).toBe('org-88');
    });

    it('a blank organization claim yields no organizationId rather than an empty string', async () => {
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', org_id: '   ' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.tenantContextOrganizationId).toBeNull();
    });
  });

  describe('security regressions', () => {
    it('x-tenant-id header alone is refused before the handler', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('x-tenant-id', 'attacker-tenant');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.probeHandlerCalls).toBe(0);
    });

    it('Bearer JWT for tenant-A + spoofed x-tenant-id: tenant-B → JWT wins (header ignored)', async () => {
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`)
        .set('x-tenant-id', 'tenant-bravo');
      expect(res.status).toBe(200);
      expect(res.body.identity.tenantId).toBe('tenant-alpha');
      expect(res.body.reqTenantContext?.tenantId).toBe('tenant-alpha');
    });

    it('malformed JWT (bad signature) is refused before the handler', async () => {
      const app = buildApp();
      const token = jwt.sign(
        { sub: 'attacker', tenant_id: 'tenant-x' },
        'wrong-secret',
        { expiresIn: '1h' },
      );
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.probeHandlerCalls).toBe(0);
    });

    it('signature-valid JWT with no sub/id is rejected before tenant context propagation', async () => {
      const app = buildApp();
      const token = signJwt({ tenant_id: 'tenant-alpha' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ success: false, error: 'Invalid or expired token' });
    });

    it('expired JWT is refused before the handler', async () => {
      const app = buildApp();
      const token = jwt.sign(
        { sub: 'user-a', tenant_id: 'tenant-alpha', exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET,
      );
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.probeHandlerCalls).toBe(0);
    });

    it('no Authorization and no x-tenant-id is refused before the handler', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/governance/approvals/_whoami_probe_pr2c');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.probeHandlerCalls).toBe(0);
    });

    // C5: parallel to the x-tenant-id case above — an unauthenticated
    // caller sending only `x-user-id` must NOT leak that value into the
    // identity flowing through extractIdentityContext. The 7 actor-write
    // call sites that previously read this header directly (AgentRouter,
    // MappingRouter, BusinessIntelligenceRouter, QualityRouter, MCPRouter,
    // ActionIslandRouter, governanceMiddleware) now go through
    // extractIdentityContext; this test pins the contract those sites rely
    // on. Drift gate `npm run audit-identity-header-reads` enforces the
    // structural side: no `req.headers['x-user-id']` access remains under
    // `src/`.
    it('x-user-id header alone is refused before the handler (C5)', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('x-user-id', 'attacker-user');
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(app.locals.probeHandlerCalls).toBe(0);
    });

    it('Bearer JWT for user-a + spoofed x-user-id: attacker → JWT wins (header ignored) (C5)', async () => {
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`)
        .set('x-user-id', 'attacker-user');
      expect(res.status).toBe(200);
      expect(res.body.identity.userId).toBe('user-a');
      expect(res.body.reqUser?.id).toBe('user-a');
    });
  });

  /**
   * Everything above mounts optionalAuthMiddleware. authMiddleware — the
   * REQUIRED-auth path every write family actually runs behind — builds its own
   * `req.user` (src/middleware/auth.ts:188-195) with its own
   * normalizeOrganizationIdClaim call, so the organization plumbing asserted
   * above was proven only for the optional path. These cases exercise the
   * required one directly.
   */
  describe('authMiddleware (required auth) — organization claim plumbing', () => {
    function buildRequiredAuthApp(): express.Express {
      const app = express();
      app.use(express.json());
      app.use('/api', authMiddleware);
      app.get('/api/_whoami_required_pr2c', (req, res) => {
        res.json({
          reqUser: req.user
            ? {
                id: req.user.id,
                tenantId: req.user.tenantId ?? null,
                organizationId: req.user.organizationId ?? null,
              }
            : null,
        });
      });
      return app;
    }

    it('an org_id claim reaches req.user.organizationId', async () => {
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', org_id: 'org-77' });
      const res = await request(buildRequiredAuthApp())
        .get('/api/_whoami_required_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqUser).toEqual({
        id: 'user-a',
        tenantId: 'tenant-alpha',
        organizationId: 'org-77',
      });
    });

    it('the organizationId spelling of the organization claim is honored too', async () => {
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', organizationId: 'org-88' });
      const res = await request(buildRequiredAuthApp())
        .get('/api/_whoami_required_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqUser?.organizationId).toBe('org-88');
    });

    it('a blank organization claim yields no organizationId rather than an empty string', async () => {
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', org_id: '   ' });
      const res = await request(buildRequiredAuthApp())
        .get('/api/_whoami_required_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqUser?.organizationId).toBeNull();
    });

    it('a non-string organization claim is dropped rather than coerced', async () => {
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha', org_id: { spoofed: true } });
      const res = await request(buildRequiredAuthApp())
        .get('/api/_whoami_required_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqUser?.organizationId).toBeNull();
    });

    it('no organization claim at all yields no organizationId', async () => {
      const token = signJwt({ sub: 'user-a', tenant_id: 'tenant-alpha' });
      const res = await request(buildRequiredAuthApp())
        .get('/api/_whoami_required_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.reqUser?.organizationId).toBeNull();
    });

    it('rejects an unauthenticated request outright — the required path has no anonymous branch', async () => {
      const res = await request(buildRequiredAuthApp()).get('/api/_whoami_required_pr2c');
      expect(res.status).toBe(401);
      expect(res.body).toEqual({
        success: false,
        error: 'No valid authorization header found',
      });
    });
  });
});
