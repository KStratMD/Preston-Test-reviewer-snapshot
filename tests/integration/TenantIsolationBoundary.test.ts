// PR 4B — Cross-tenant isolation boundary test.
//
// Proves end-to-end that PR 4B's central tenantIsolation mount preserves the
// SYSTEM_IDENTITY fail-closed contract (Codex-5.4) for unauthenticated requests
// and enforces cross-tenant denial via stub-authenticated identities.
//
// Authentication model: pre-PR-2C-Auth there is no verified JWT. Tests use an
// inline `injectStubAuth` middleware that populates `req.auth` with a
// test-controlled tenantId — the same pattern used in
// `tests/integration/governanceApprovalQueueRouting.test.ts`.
//
// SECURITY REGRESSION: The `x-tenant-id header WITHOUT req.auth` test
// directly defends against the Copilot R2 finding (header-based impersonation):
// the x-tenant-id header is NOT a trusted authentication signal pre-PR-2C-Auth.
// Even if tenantIsolation populates req.tenantContext from this header, the
// bridge was intentionally reverted in PR 4B R2 so extractIdentityContext
// does NOT read req.tenantContext, SYSTEM_IDENTITY remains, and the
// approvalsRouter 401 gate fires.
//
// Target route: /api/governance/approvals — the only route today with
// (a) per-tenant data filtering at the repository layer, (b) a fail-closed
// 401 gate when identity is SYSTEM_IDENTITY, and (c) handler-level
// extractIdentityContext consumption.

import 'reflect-metadata';
import { randomUUID } from 'crypto';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
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
  mountCentralTenantGate(app);
  app.use('/api/governance/approvals', approvalsRouter);
  return app;
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
  let repo: ApprovalQueueRepository;

  beforeAll(async () => {
    // snapshot()/restore() pattern: prevents singleton leakage across files.
    container.snapshot();
    await setupTestDatabase();
    repo = await container.getAsync<ApprovalQueueRepository>(TYPES.ApprovalQueueRepository);

    appA = makeAppFor('tenant-A');
    appB = makeAppFor('tenant-B');
    unauthApp = makeAppFor(null);
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

      const res = await request(appA).get(`/api/governance/approvals/${seeded.id}`);

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

      const res = await request(appB).get(`/api/governance/approvals/${seeded.id}`);

      expect(res.status).toBe(200);
      expect(res.body.approval).toBeDefined();
      expect(res.body.approval.tenantId).toBe('tenant-B');
    });

    it('unauthenticated request (no req.auth) is rejected with 401', async () => {
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-3',
        resourceId: 'res-b-3',
      }));

      // No auth stub → extractIdentityContext falls back to SYSTEM_IDENTITY
      // → approvalsRouter 401 fail-closed gate fires.
      const res = await request(unauthApp).get(`/api/governance/approvals/${seeded.id}`);

      expect(res.status).toBe(401);
      expect(res.body).not.toHaveProperty('approval');
      expect(JSON.stringify(res.body)).not.toContain('[REDACTED]');
    });

    it('SECURITY REGRESSION: x-tenant-id header WITHOUT req.auth must NOT impersonate', async () => {
      // Defends against the Copilot R2 finding: pre-PR-2C-Auth, the x-tenant-id
      // header is NOT a trusted authentication signal. Even if tenantIsolation
      // populates req.tenantContext from this header, extractIdentityContext
      // (post-bridge-revert) does NOT read req.tenantContext, so SYSTEM_IDENTITY
      // remains and the approvalsRouter 401 gate fires.
      //
      // R4 hardening: tenantIsolation now ALSO rejects this attack vector at
      // the middleware layer via disableHeaderExtraction: true (so even if
      // a future commit re-adds the bridge to extractIdentityContext, the
      // attack still fails because tenantIsolation never populates
      // req.tenantContext from the un-verified header).
      const seeded = await repo.insertPending(makeRow({
        tenantId: 'tenant-B',
        requesterUserId: 'user-B-4',
        resourceId: 'res-b-4',
      }));

      const res = await request(unauthApp)
        .get(`/api/governance/approvals/${seeded.id}`)
        .set('x-tenant-id', 'tenant-B');  // attacker's forged header

      expect(res.status).toBe(401);
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
  });
});
