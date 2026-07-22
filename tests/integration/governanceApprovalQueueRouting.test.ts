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

// Tiny test-only auth stub: populates `req.auth` so extractIdentityContext
// returns a real (non-SYSTEM) identity. PR 3B's read surface fail-closes on
// SYSTEM_IDENTITY (Codex 5.4 HIGH), so the happy-path GET tests require this
// stub. Production callers will use the real auth middleware (PR 2C-Auth).
const STUB_TENANT_ID = 'tenant-a';
const STUB_USER_ID = 'user-a';
function injectStubAuth(req: express.Request, _res: express.Response, next: express.NextFunction): void {
  (req as unknown as { auth: { tenantId: string; user: { sub: string } } }).auth = {
    tenantId: STUB_TENANT_ID,
    user: { sub: STUB_USER_ID },
  };
  next();
}

describe('PR 3B — HITL approval-queue routing', () => {
  let db: DatabaseService;
  let app: express.Express;
  let unauthApp: express.Express;

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
    app.post('/api/test-route', async (req, res) => {
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
    app.use('/api/governance/approvals', approvalsRouter);

    // Unauthenticated app — NO auth stub. Used to assert the fail-closed
    // 401 posture from Codex 5.4 HIGH: SYSTEM_IDENTITY callers must NOT be
    // able to read approval queue entries via the operator GET.
    unauthApp = express();
    unauthApp.use(express.json());
    unauthApp.use('/api/governance/approvals', approvalsRouter);
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

    it('the enqueued row is fetchable via GET when caller is authenticated (pollUrl is functional)', async () => {
      // Create + fetch both go through `app`, which has injectStubAuth
      // populating req.auth with a non-SYSTEM tenant identity. The fail-
      // closed Codex 5.4 fix only rejects SYSTEM_IDENTITY reads — authed
      // callers see the full row.
      const create = await request(app).post('/api/test-route').send({});
      expect(create.status).toBe(202);
      const approvalId = create.body.pendingApprovalId;
      const fetch = await request(app).get(create.body.pollUrl);
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
      const res = await request(app).get('/api/governance/approvals/does-not-exist');
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
      const res = await request(app).get('/api/governance/approvals/%20').send();
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: 'invalid_id' });
    });

    it('returns 401 when caller has SYSTEM_IDENTITY (fail-closed; Codex 5.4 HIGH)', async () => {
      // Enqueue under the authenticated tenant — request lands as a real row.
      const create = await request(app).post('/api/test-route').send({});
      expect(create.status).toBe(202);
      const approvalId = create.body.pendingApprovalId;
      // Hit the GET via the UNAUTH app (no injectStubAuth) — the route
      // must reject SYSTEM_IDENTITY identity before any repository lookup,
      // otherwise an attacker with the pendingApprovalId could read the
      // full row including redactedPayload + policyFindings.
      const res = await request(unauthApp).get(`/api/governance/approvals/${approvalId}`);
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({ ok: false, code: 'unauthenticated' });
      // Critical: the body MUST NOT leak anything about the row itself.
      expect(res.body.approval).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('REDACTED');
      expect(JSON.stringify(res.body)).not.toContain('ssn');
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
