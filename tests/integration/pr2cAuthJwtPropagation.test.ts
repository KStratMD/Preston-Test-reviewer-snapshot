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
import { optionalAuthMiddleware } from '../../src/middleware/auth';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import {
  extractIdentityContext,
  SYSTEM_IDENTITY,
} from '../../src/services/governance/identityContext';

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
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app);
  // The probe is tenant_required (matches /api/governance/approvals manifest
  // entry which is tenant_required — pick that prefix so the central gate
  // dispatcher runs tenantIsolation for the probe path).
  app.get('/api/governance/approvals/_whoami_probe_pr2c', (req, res) => {
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
        source: 'jwt',
      });
    });

    it('JWT with `tenantId` claim name (camelCase) is accepted by optionalAuthMiddleware', async () => {
      // authMiddleware reads tenantId | tid | tenant_id defensively. The
      // tenantIsolation middleware reads `tenant_id` (snake_case OAuth
      // standard) by default. With ONLY the camelCase claim, req.user
      // gets the tenantId but req.tenantContext stays unpopulated —
      // extractIdentityContext falls through to req.user.
      const app = buildApp();
      const token = signJwt({ sub: 'user-a', tenantId: 'tenant-camel' });
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity.tenantId).toBe('tenant-camel');
      expect(res.body.reqUser).toEqual({ id: 'user-a', tenantId: 'tenant-camel' });
      // tenantIsolation didn't populate context because its claim name
      // (`tenant_id`) wasn't present in the JWT.
      expect(res.body.reqTenantContext).toBeNull();
    });
  });

  describe('security regressions', () => {
    it('x-tenant-id header alone (no Bearer) resolves to SYSTEM_IDENTITY', async () => {
      const app = buildApp();
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('x-tenant-id', 'attacker-tenant');
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual(SYSTEM_IDENTITY);
      expect(res.body.reqUser).toBeNull();
      expect(res.body.reqTenantContext).toBeNull();
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

    it('malformed JWT (bad signature) → req.user unset, SYSTEM_IDENTITY at handler', async () => {
      const app = buildApp();
      const token = jwt.sign(
        { sub: 'attacker', tenant_id: 'tenant-x' },
        'wrong-secret',
        { expiresIn: '1h' },
      );
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual(SYSTEM_IDENTITY);
      expect(res.body.reqUser).toBeNull();
      expect(res.body.reqTenantContext).toBeNull();
    });

    it('expired JWT → req.user unset, SYSTEM_IDENTITY at handler', async () => {
      const app = buildApp();
      const token = jwt.sign(
        { sub: 'user-a', tenant_id: 'tenant-alpha', exp: Math.floor(Date.now() / 1000) - 60 },
        JWT_SECRET,
      );
      const res = await request(app)
        .get('/api/governance/approvals/_whoami_probe_pr2c')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual(SYSTEM_IDENTITY);
      expect(res.body.reqUser).toBeNull();
      expect(res.body.reqTenantContext).toBeNull();
    });

    it('no Authorization, no x-tenant-id → SYSTEM_IDENTITY (baseline)', async () => {
      const app = buildApp();
      const res = await request(app).get('/api/governance/approvals/_whoami_probe_pr2c');
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual(SYSTEM_IDENTITY);
      expect(res.body.reqUser).toBeNull();
      expect(res.body.reqTenantContext).toBeNull();
    });
  });
});
