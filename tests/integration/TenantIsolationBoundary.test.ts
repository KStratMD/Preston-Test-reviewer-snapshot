// PR 4B — Cross-tenant isolation boundary test.
//
// Proves end-to-end that the approvals poll route enforces cross-tenant
// denial and rejects unauthenticated/forged-header callers.
//
// Authentication model (F3): the poll route mounts the REAL authMiddleware +
// tenant-lifecycle kill switch, so authenticated cases sign real HS256 JWTs
// against the setupEnv JWT_SECRET. The legacy `injectStubAuth` req.auth stub
// is retained for exactly ONE pinned case: req.auth alone must NO LONGER
// authenticate the poll route (it did pre-F3 via extractIdentityContext).
//
// SECURITY REGRESSION: The `x-tenant-id header WITHOUT credentials` test
// directly defends against the Copilot R2 finding (header-based impersonation):
// the x-tenant-id header is NOT a trusted authentication signal. Since F3,
// authMiddleware rejects the credential-less request outright; the R4
// tenantIsolation `disableHeaderExtraction: true` hardening remains as
// defense-in-depth behind it.
//
// Target route: /api/governance/approvals — per-tenant data filtering at the
// repository layer + the strict F3 middleware chain on GET /:id.

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import { optionalAuthMiddleware } from '../../src/middleware/auth';
import { extractIdentityContext } from '../../src/services/governance/identityContext';
import { approvalsRouter } from '../../src/routes/governance/approvalsRouter';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import type { ApprovalQueueRepository, NewPendingApprovalRow } from '../../src/services/governance/ApprovalQueueRepository';

/** Inject a verified tenant identity into req.auth for test isolation. */
function injectStubAuth(tenantId: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { auth?: unknown }).auth = {
      type: 'oauth',
      tenantId,
      user: {
        iss: 'test',
        sub: `user-${tenantId}`,
        aud: 'test',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
      },
    };
    next();
  };
}

/** Build a minimal Express app with the central gate + approvals router. */
function makeAppFor(tenantId: string | null): express.Application {
  const app = express();
  app.use(express.json());
  if (tenantId !== null) {
    app.use(injectStubAuth(tenantId));
  }
  // Match production ordering so camelCase tenantId claims are normalized
  // onto req.user before strict central isolation runs.
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.use('/api/governance/approvals', approvalsRouter);
  return app;
}

/** Separate harness: the poll fixtures above intentionally inject auth in different ways. */
function makeStrictPopulationProbeApp(): express.Application {
  const app = express();
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.post('/api/testing/mcp-schema', (req, res) => {
    res.json({
      identity: extractIdentityContext(req),
      reqUser: req.user ? { id: req.user.id, tenantId: req.user.tenantId } : null,
      reqTenantContext: req.tenantContext
        ? { tenantId: req.tenantContext.tenantId, source: req.tenantContext.metadata?.source }
        : null,
    });
  });
  return app;
}

/** Real HS256 Bearer for the F3-strict poll route (setupEnv sets JWT_SECRET). */
function bearerFor(tenantId: string): string {
  const token = jwt.sign(
    { sub: `user-${tenantId}`, tenantId },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  return `Bearer ${token}`;
}

/** Build a minimal NewPendingApprovalRow with sensible defaults. */
function makeRow(overrides: Partial<NewPendingApprovalRow> & { tenantId: string }): NewPendingApprovalRow {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour TTL
  return {
    id: randomUUID(),
    tenantId: overrides.tenantId,
    requesterUserId: overrides.requesterUserId ?? 'user-test',
    operationType: overrides.operationType ?? 'connector_write',
    resourceType: overrides.resourceType ?? 'netsuite_customer',
    resourceId: overrides.resourceId ?? 'resource-test',
    riskLevel: overrides.riskLevel ?? 'high',
    redactedPayload: overrides.redactedPayload ?? JSON.stringify({ name: '[REDACTED]' }),
    policyFindings: overrides.policyFindings ?? JSON.stringify([]),
    createdAt: overrides.createdAt ?? now.toISOString(),
    expiresAt: overrides.expiresAt ?? expiresAt.toISOString(),
  };
}

describe('PR 4B — Tenant Isolation Boundary', () => {
  let appA: express.Application;
  let appB: express.Application;
  let unauthApp: express.Application;
  let reqAuthOnlyApp: express.Application;
  let repo: ApprovalQueueRepository;

  beforeAll(async () => {
    // snapshot()/restore() pattern: prevents singleton leakage across files.
    container.snapshot();
    await setupTestDatabase();
    repo = await container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);

    // F3: the poll route authenticates via Bearer JWT — appA/appB no longer
    // carry the req.auth stub; per-request Authorization headers identify
    // the tenant. The stub app exists ONLY for the req.auth-alone regression.
    appA = makeAppFor(null);
    appB = makeAppFor(null);
    unauthApp = makeAppFor(null);
    reqAuthOnlyApp = makeAppFor('tenant-B');
  });

  afterAll(async () => {
    await teardownTestDatabase();
    container.restore();
  });

  describe('cross-tenant denial against /api/governance/approvals', () => {
    it('tenant A cannot read tenant B approval row (404, no body leakage)', async () => {
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-1',
        resourceId: 'res-b-1',
        redactedPayload: JSON.stringify({ name: '[REDACTED]' }),
        policyFindings: JSON.stringify([]),
      }));

      const res = await request(appA)
        .get(`/api/governance/approvals/${seeded.id}`)
        .set('Authorization', bearerFor('tenant-A'));

      expect(res.status).toBe(404);
      // Per Codex-5.4 fail-closed precedent: no leakage of payload or findings.
      expect(res.body).not.toHaveProperty('approval');
      expect(JSON.stringify(res.body)).not.toContain('[REDACTED]');
      expect(JSON.stringify(res.body)).not.toContain('policyFindings');
    });

    it('tenant B CAN read its own approval row', async () => {
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-2',
        resourceId: 'res-b-2',
      }));

      const res = await request(appB)
        .get(`/api/governance/approvals/${seeded.id}`)
        .set('Authorization', bearerFor('tenant-B'));

      expect(res.status).toBe(200);
      expect(res.body.approval).toBeDefined();
      expect(res.body.approval.tenantId).toBe('tenant-B');
    });

    it('unauthenticated request is rejected by the central tenant boundary with 403', async () => {
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-3',
        resourceId: 'res-b-3',
      }));

      const res = await request(unauthApp).get(`/api/governance/approvals/${seeded.id}`);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(res.body).not.toHaveProperty('approval');
      expect(JSON.stringify(res.body)).not.toContain('[REDACTED]');
    });

    it('F3: req.auth alone (no Bearer token) must NOT authenticate the poll route', async () => {
      // Pre-F3 the OAuth-shaped req.auth was honored via extractIdentityContext;
      // the poll route is JWT-only now. Other extractIdentityContext consumers
      // still honor req.auth — this pins the poll route specifically.
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-5',
        resourceId: 'res-b-5',
      }));

      const res = await request(reqAuthOnlyApp).get(`/api/governance/approvals/${seeded.id}`);

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(res.body).not.toHaveProperty('approval');
      expect(JSON.stringify(res.body)).not.toContain('[REDACTED]');
    });

    it('SECURITY REGRESSION: x-tenant-id header WITHOUT credentials must NOT impersonate', async () => {
      // Defends against the Copilot R2 finding: the x-tenant-id header is NOT
      // a trusted authentication signal. Since F3, authMiddleware rejects the
      // credential-less request at the central tenant boundary before identity resolution.
      //
      // R4 hardening remains as defense-in-depth behind it: tenantIsolation
      // rejects this vector at the middleware layer via
      // disableHeaderExtraction: true, so even if a future commit weakens the
      // route's auth, the forged header still never populates
      // req.tenantContext.
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-4',
        resourceId: 'res-b-4',
      }));

      const res = await request(unauthApp)
        .get(`/api/governance/approvals/${seeded.id}`)
        .set('x-tenant-id', 'tenant-B');  // attacker's forged header

      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'TENANT_REQUIRED' });
      expect(res.body).not.toHaveProperty('approval');
      expect(JSON.stringify(res.body)).not.toContain('[REDACTED]');
    });
  });

  describe('public + demo route bypass (Codex review broadening)', () => {
    it('demo route does NOT populate tenantContext even when x-tenant-id sent', async () => {
      // Isolated probe app: mount the central gate + a single probe route that
      // sits under /api/ai-demo/ (classified 'demo' in the route manifest).
      // We don't touch the shared apps to avoid Express routing-graph
      // pollution across tests.
      //
      // Explicit dependency: this test assumes `/api/ai-demo` remains classified
      // as 'demo' in src/middleware/setup/routeManifest.ts. If that classification
      // is changed (e.g. to 'tenant_required'), this test will start failing
      // or passing for the wrong reason — re-evaluate the assertion.
      const probeApp = express();
      let observedContext: unknown = 'NOT_OBSERVED';
      mountCentralTenantGate(probeApp);
      probeApp.get('/api/ai-demo/probe', (req, res) => {
        observedContext = req.tenantContext;
        res.status(200).json({ ok: true });
      });

      const res = await request(probeApp)
        .get('/api/ai-demo/probe')
        .set('x-tenant-id', 'tenant-X');

      expect(res.status).toBe(200);
      // The central gate classifies /api/ai-demo/* as 'demo', so isolation()
      // is never called — req.tenantContext stays undefined even with the header.
      expect(observedContext).toBeUndefined();
    });

    it('populate-only deferral preserves verified identity in its own strict probe harness', async () => {
      const probeApp = makeStrictPopulationProbeApp();
      const res = await request(probeApp)
        .post('/api/testing/mcp-schema')
        .set('Authorization', bearerFor('tenant-probe'));
      expect(res.status).toBe(200);
      expect(res.body.identity).toEqual({ tenantId: 'tenant-probe', userId: 'user-tenant-probe' });
      expect(res.body.reqUser).toEqual({ id: 'user-tenant-probe', tenantId: 'tenant-probe' });
      expect(res.body.reqTenantContext).toEqual({
        tenantId: 'tenant-probe',
        source: 'verified-user',
      });
    });
  });
});
