// HITL approval-queue routing — PR 3B integration tests.
//
// Three scenarios in a single suite (shared SQLite + container setup):
//
//   1. End-to-end enqueue: a route catches PendingApprovalError, the helper
//      enqueues via ApprovalQueueService, and returns 202 with
//      pendingApprovalId + pollUrl.
//   2. Read-only operator GET: the new /api/governance/approvals/:id
//      endpoint returns the persisted row scoped to the caller's tenant;
//      cross-tenant reads collapse to 404 (no leak).
//   3. Startup guard: assertApprovalQueueReachableIfNeeded refuses to
//      proceed when approvalMode='queue' and the table is dropped, but
//      proceeds silently when approvalMode='block' OR the table exists.
//
// The test app mounts a minimal route that throws PendingApprovalError via
// a fake OutboundGovernanceService — we don't need a real DLP scan to
// exercise the route catch + helper + queue surface. The end-to-end resume-
// worker path is covered by the unit suite (ApprovalResumeWorker.test.ts).

import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { sql } from 'kysely';
import { Logger } from '../../src/utils/Logger';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { DatabaseService } from '../../src/database/DatabaseService';
import { handleApprovalQueueError } from '../../src/middleware/governance/approvalQueueErrorHandler';
import { PendingApprovalError } from '../../src/services/governance/OutboundGovernanceErrors';
import type { OutboundDecision } from '../../src/services/governance/OutboundGovernanceService';
import { approvalsRouter } from '../../src/routes/governance/approvalsRouter';
import {
  assertApprovalQueueReachableIfNeeded,
  ApprovalQueueUnreachableError,
} from '../../src/services/governance/approvalModeStartupGuard';
import type { TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';
import { PartialTenantRevocationError } from '../../src/services/tenants/TenantErrors';

/**
 * Suspend a tenant, tolerating PartialTenantRevocationError: the status flip
 * commits BEFORE the embedded-credential revocation pass, and the test env's
 * SecretManager (environment provider) cannot store revocation tombstones.
 * This is exactly the partial-failure scenario the F3 request-time gate
 * defends against — a suspended tenant whose credentials survived revocation
 * must still be blocked per request.
 */
async function suspendTenant(lifecycle: TenantLifecycleService, tenantId: string): Promise<void> {
  await lifecycle.requireActive(tenantId); // auto-register active
  try {
    await lifecycle.setStatus({
      tenantId,
      newStatus: 'suspended',
      actorUserId: 'test-admin',
      actorSource: 'integration-test',
      reason: 'f3-gate-test',
    });
  } catch (err) {
    if (!(err instanceof PartialTenantRevocationError)) throw err;
  }
}
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';

function makeHighRiskDecision(): OutboundDecision {
  return {
    approved: false,
    approvalRequired: true,
    redactedPayload: { ssn: '[REDACTED]' },
    findings: ['ssn'],
    riskLevel: 'high',
    auditMetadata: {
      scanDurationMs: 1,
      findingsCount: 1,
      redacted: true,
      blocked: false,
    },
  };
}

// Tiny test-only auth stub for the ENQUEUE fixture route.
//
// Populates BOTH sources deliberately:
//   - `req.user` is what the enqueue path now requires. F6 PR4 Stage 2 replaced
//     extractIdentityContext in handleApprovalQueueError with Stage 1's strict
//     `verifiedIdentity`, which reads the normalized verified `req.user` ONLY.
//     Without it the fixture would hit the new fail-closed refusal.
//   - `req.auth` is retained so this fixture still mirrors the pre-Stage-2
//     request shape. It is NOT what proves the F3 req.auth-alone regression —
//     that needs a source-isolated app, which is why `authOnlyApp` exists.
// Neither authenticates the poll route: F3 mounted the real authMiddleware
// there, and it rejects a missing Bearer header before ever reading req.user,
// so the GET tests below send real JWTs signed against the setupEnv JWT_SECRET.
const STUB_TENANT_ID = 'tenant-a';
const STUB_USER_ID = 'user-a';
function injectStubAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as unknown as { auth: { tenantId: string; user: { sub: string } } }).auth = {
    tenantId: STUB_TENANT_ID,
    user: { sub: STUB_USER_ID },
  };
  req.user = {
    id: STUB_USER_ID,
    username: STUB_USER_ID,
    tenantId: STUB_TENANT_ID,
    roles: ['user'],
    permissions: [],
  } as express.Request['user'];
  next();
}

/** The PendingApprovalError fixture route, mounted on both test apps. */
function registerPendingApprovalFixture(target: express.Express): void {
  target.post('/api/test-route', async (req, res) => {
    try {
      throw new PendingApprovalError(makeHighRiskDecision());
    } catch (err) {
      if (await handleApprovalQueueError(err, req, res, {
        operationType: 'connector_write',
        resourceType: 'test.fixture',
        resourceId: 'fixture-1',
      })) return;
      res.status(500).json({ ok: false, error: 'fell through' });
    }
  });
}

function bearerFor(tenantId: string, userId = STUB_USER_ID): string {
  const token = jwt.sign(
    { sub: userId, tenantId },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', expiresIn: '5m' },
  );
  return `Bearer ${token}`;
}

describe('PR 3B — HITL approval-queue routing', () => {
  let db: DatabaseService;
  let app: express.Express;
  let unauthApp: express.Express;
  let authOnlyApp: express.Express;

  beforeAll(async () => {
    // PR 3B R5 (Copilot): wrap the entire test fixture in
    // container.snapshot() / container.restore() so the DatabaseService
    // rebind from setupTestDatabase() + the resolved singletons
    // (ApprovalQueueService / Repository / ResumeWorker, all
    // `inSingletonScope()`) don't leak into subsequent integration files.
    // Without this, after teardownTestDatabase() shuts the DB down, the
    // cached singletons hold dead handles and break any later file that
    // resolves the approval-queue stack without first refreshing it.
    container.snapshot();
    db = await setupTestDatabase();
    // Authed app — mounts the test fixture behind a stub identity, so the
    // happy-path POST+GET round-trip exercises the route with a real
    // (non-SYSTEM) tenant.
    app = express();
    app.use(express.json());
    app.use(injectStubAuth);
    registerPendingApprovalFixture(app);
    app.use('/api/governance/approvals', approvalsRouter);

    // Unauthenticated app — NO auth stub. Used to assert the fail-closed
    // 401 posture from Codex 5.4 HIGH: SYSTEM_IDENTITY callers must NOT be
    // able to read approval queue entries via the operator GET. Since F6 PR4
    // Stage 2 it also carries the enqueue fixture, so the WRITE path's
    // fail-closed refusal is provable on the same unattributable request.
    unauthApp = express();
    unauthApp.use(express.json());
    registerPendingApprovalFixture(unauthApp);
    unauthApp.use('/api/governance/approvals', approvalsRouter);

    // req.auth ONLY — no req.user, no Bearer. Exists so the F3 regression below
    // still ISOLATES req.auth as an authentication source. `app`'s stub sets
    // both sources (the enqueue path needs req.user since Stage 2), which would
    // otherwise leave that test unable to prove what its name claims.
    authOnlyApp = express();
    authOnlyApp.use(express.json());
    authOnlyApp.use((req, _res, next) => {
      (req as unknown as { auth: { tenantId: string; user: { sub: string } } }).auth = {
        tenantId: STUB_TENANT_ID,
        user: { sub: STUB_USER_ID },
      };
      next();
    });
    authOnlyApp.use('/api/governance/approvals', approvalsRouter);
  });

  afterAll(async () => {
    await teardownTestDatabase();
    // Restore the container so the resolved-singleton cache (with its now-
    // shutdown DB handle) is dropped before the next integration file
    // starts (Copilot R5).
    container.restore();
  });

  describe('end-to-end enqueue', () => {
    it('catches PendingApprovalError → 202 with pendingApprovalId + pollUrl', async () => {
      const res = await request(app).post('/api/test-route').send({});
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        ok: false,
        code: 'pending_approval',
      });
      expect(typeof res.body.pendingApprovalId).toBe('string');
      expect(res.body.pendingApprovalId.length).toBeGreaterThan(0);
      expect(res.body.pollUrl).toBe(`/api/governance/approvals/${res.body.pendingApprovalId}`);
    });

    it('F6 PR4 Stage 2: refuses to enqueue without a verified tenant and user', async () => {
      // The durable governance_approvals row used to be attributed to the
      // retired __system__ sentinel whenever the request carried no verified
      // identity. It must now refuse outright — and, critically, write nothing.
      const kysely = db.getDatabase();
      const before = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM governance_approvals
      `.execute(kysely);
      const beforeCount = Number(before.rows[0]?.count ?? 0);

      const res = await request(unauthApp).post('/api/test-route').send({});

      const after = await sql<{ count: number }>`
        SELECT COUNT(*) AS count FROM governance_approvals
      `.execute(kysely);
      const afterCount = Number(after.rows[0]?.count ?? 0);

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        ok: false,
        code: 'approval_identity_required',
        message: 'governance refused to enqueue: verified tenant and user identity are required',
      });
      // The refusal is the point: no durable row may exist for an
      // unattributable write, and the response must not be the caller's
      // generic 500 (which would have hidden the governance-side reason).
      expect(afterCount).toBe(beforeCount);
    });

    it('the enqueued row is fetchable via GET when caller is authenticated (pollUrl is functional)', async () => {
      // Create goes through `app` (injectStubAuth attributes the enqueue);
      // the fetch sends a REAL Bearer JWT — F3 mounted authMiddleware + the
      // tenant-lifecycle kill switch on the poll route, and req.auth alone
      // no longer authenticates it.
      const create = await request(app).post('/api/test-route').send({});
      expect(create.status).toBe(202);
      const approvalId = create.body.pendingApprovalId;
      const fetch = await request(app)
        .get(create.body.pollUrl)
        .set('Authorization', bearerFor(STUB_TENANT_ID));
      expect(fetch.status).toBe(200);
      expect(fetch.body).toMatchObject({
        ok: true,
        approval: {
          id: approvalId,
          status: 'pending',
          operationType: 'connector_write',
          resourceType: 'test.fixture',
          resourceId: 'fixture-1',
          riskLevel: 'high',
        },
      });
      // Schema invariant: redacted_payload comes from decision.redactedPayload,
      // never raw — proves the queue persisted the DLP-scanned form.
      expect(fetch.body.approval.redactedPayload).toBe(JSON.stringify({ ssn: '[REDACTED]' }));
    });
  });

  describe('read-only operator GET /api/governance/approvals/:id', () => {
    it('returns 404 for unknown id', async () => {
      const res = await request(app)
        .get('/api/governance/approvals/does-not-exist')
        .set('Authorization', bearerFor(STUB_TENANT_ID));
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: 'approval_not_found' });
    });

    it('returns 400 with invalid_id code when id path param is whitespace-only', async () => {
      // URL-encoded single space — Express path matching accepts at least 1
      // char; the handler's trim-length guard catches whitespace-only ids
      // and rejects them BEFORE the repository lookup. Asserting the exact
      // status + code (Copilot R4) prevents a future regression that would
      // silently 500 or fall through to a 404 lookup-miss masking the
      // validation failure.
      const res = await request(app)
        .get('/api/governance/approvals/%20')
        .set('Authorization', bearerFor(STUB_TENANT_ID))
        .send();
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: 'invalid_id' });
    });

    it('returns 401 for anonymous callers (fail-closed; authMiddleware since F3)', async () => {
      // Enqueue under the authenticated tenant — request lands as a real row.
      const create = await request(app).post('/api/test-route').send({});
      expect(create.status).toBe(202);
      const approvalId = create.body.pendingApprovalId;
      // Hit the GET via the UNAUTH app with no Bearer token — authMiddleware
      // must reject before any repository lookup, otherwise an attacker with
      // the pendingApprovalId could read the full row including
      // redactedPayload + policyFindings. (Body shape is authMiddleware's
      // generic 401 envelope since F3 — assert the leak discipline, not the
      // exact wording.)
      const res = await request(unauthApp).get(`/api/governance/approvals/${approvalId}`);
      expect(res.status).toBe(401);
      // Critical: the body MUST NOT leak anything about the row itself.
      expect(res.body.approval).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('REDACTED');
      expect(JSON.stringify(res.body)).not.toContain('ssn');
    });

    it('F3: req.auth alone (no Bearer token) is refused by the poll route', async () => {
      // Create through `app` (its dual-source stub satisfies the Stage 2 enqueue
      // identity check), then read through authOnlyApp, which carries req.auth
      // and NOTHING else — before F3 that was enough to read a row. Reading via
      // `app` would not isolate req.auth, since its stub also sets req.user.
      //
      // SCOPE (Codex R2 on #1089): this proves the ROUTE refuses, not WHICH
      // layer refuses. authMiddleware (approvalsRouter.ts) returns 401 before
      // the tenant gate is reached, and the handler's own req.user check would
      // refuse after it, so a gate-only regression would not turn this green.
      // The gate's own req.auth handling is covered directly in
      // tests/unit/middleware/tenantStatusGate.test.ts.
      const create = await request(app).post('/api/test-route').send({});
      expect(create.status).toBe(202);
      const res = await request(authOnlyApp).get(create.body.pollUrl);
      expect(res.status).toBe(401);
      expect(JSON.stringify(res.body)).not.toContain('REDACTED');
    });

    // The two gate cases below use unauthApp: `app` mounts injectStubAuth,
    // and the kill switch resolves identity via extractIdentityContext whose
    // canonical whole-source order reads req.auth BEFORE req.user — the stub
    // would mask the JWT under test. (Production mounts nothing that
    // populates req.auth on this route.)
    it('F3: 403s tenant_id_missing for a JWT without a tenantId claim', async () => {
      const token = jwt.sign({ sub: 'user-x' }, process.env.JWT_SECRET as string, {
        algorithm: 'HS256',
        expiresIn: '5m',
      });
      const res = await request(unauthApp)
        .get('/api/governance/approvals/any-id')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
    });

    it('F3: 403s tenant_blocked for a suspended tenant on the poll route', async () => {
      const lifecycle = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
      await suspendTenant(lifecycle, 'tenant-f3-suspended');
      const res = await request(unauthApp)
        .get('/api/governance/approvals/any-id')
        .set('Authorization', bearerFor('tenant-f3-suspended'));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    });
  });

  describe('startup guard', () => {
    it('proceeds silently when approvalMode is block (table existence irrelevant)', async () => {
      const logger = container.get<Logger>(TYPES.Logger);
      await expect(
        assertApprovalQueueReachableIfNeeded({ approvalMode: 'block' }, db, logger),
      ).resolves.toBeUndefined();
    });

    it('proceeds silently when approvalMode is queue AND table exists', async () => {
      const logger = container.get<Logger>(TYPES.Logger);
      await expect(
        assertApprovalQueueReachableIfNeeded({ approvalMode: 'queue' }, db, logger),
      ).resolves.toBeUndefined();
    });

    it('throws ApprovalQueueUnreachableError when approvalMode is queue AND table missing', async () => {
      const logger = container.get<Logger>(TYPES.Logger);
      // Drop the table to simulate a misconfigured deploy: queue-mode default
      // is in effect but migration 045 didn't run.
      const kysely = db.getDatabase();
      await sql`DROP TABLE IF EXISTS governance_approvals`.execute(kysely);

      await expect(
        assertApprovalQueueReachableIfNeeded({ approvalMode: 'queue' }, db, logger),
      ).rejects.toBeInstanceOf(ApprovalQueueUnreachableError);
    });
  });
});
