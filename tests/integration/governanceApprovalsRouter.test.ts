/**
 * PR 3C — HITL approval-queue operator API integration tests.
 *
 * Covers the three new endpoints layered atop the PR 3B read-only slice:
 *   - GET  /                  — tenant-scoped pending list
 *   - POST /:id/approve       — CAS to 'approved', fires resume worker
 *   - POST /:id/reject        — CAS to 'rejected' (reason required)
 *
 * All three apply `validateGuestContext` (embedded session + same-origin) +
 * `requireApproverRole` (user_roles JSON array contains 'approver' OR 'admin').
 * Tenant identity comes from the embedded session, NOT the JWT.
 *
 * Five test families:
 *   1. Embedded session gate — missing header, missing Origin, unknown session,
 *      expired session.
 *   2. Role gate — approver allowed, admin allowed, ops/viewer denied, null
 *      user_roles denied, malformed user_roles denied.
 *   3. Tenant isolation — tenant A cannot list, approve, or reject tenant B
 *      rows (cross-tenant collapses to 404 for POSTs).
 *   4. Input validation — list status / limit / offset shapes; POST reason
 *      shapes; whitespace-only :id.
 *   5. Happy-path CAS — approve persists, reject persists with reason,
 *      already-decided 409, TTL expired 410.
 */

import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import type { Test as SupertestTest } from 'supertest';
import { sql } from 'kysely';
import { randomUUID } from 'crypto';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { DatabaseService } from '../../src/database/DatabaseService';
import { approvalsRouter } from '../../src/routes/governance/approvalsRouter';
import { ApprovalQueueService } from '../../src/services/governance/ApprovalQueueService';
import type { OutboundDecision } from '../../src/services/governance/OutboundGovernanceService';
import { setupTestDatabase, teardownTestDatabase, seedEmbeddedSession } from './helpers/syncErrorAssistTestHelpers';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const USER_A = 'user-a';
const USER_B = 'user-b';
const HOST = '127.0.0.1';

function makeHighRiskDecision(): OutboundDecision {
  return {
    approved: false,
    approvalRequired: true,
    redactedPayload: { ssn: '[REDACTED]', customer: 'Acme Co' },
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

async function seedApproval(tenantId: string, opts?: { expiresInMs?: number }): Promise<string> {
  const service = await container.getAsync<ApprovalQueueService>(TYPES.ApprovalQueueService);
  const id = await service.enqueue({
    tenantId,
    requesterUserId: `requester-${tenantId}`,
    operationType: 'connector_write',
    resourceType: 'test.fixture',
    resourceId: `res_${randomUUID()}`,
    decision: makeHighRiskDecision(),
  });
  if (opts?.expiresInMs !== undefined) {
    // Force-expire by writing a past expires_at directly. Used by the 410 test
    // case so we don't have to wait the default 24h TTL.
    const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const past = new Date(Date.now() + opts.expiresInMs).toISOString();
    await db.getDatabase()
      .updateTable('governance_approvals')
      .set({ expires_at: past })
      .where('id', '=', id)
      .execute();
  }
  return id;
}

async function seedExpiredSession(args: { tenantId: string; userId: string; userRoles: string[] }): Promise<string> {
  const sessionId = `es_test_${randomUUID()}`;
  const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
  await db.getDatabase()
    .insertInto('embedded_sessions')
    .values({
      session_id: sessionId,
      tenant_id: args.tenantId,
      user_id: args.userId,
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: `csrf_test_${randomUUID()}`,
      expected_host_origin: `http://${HOST}`,
      // Past expires_at — validateGuestContext should 410 this.
      expires_at: new Date(Date.now() - 60_000).toISOString(),
      last_rotation_at: null,
      erp_record_type: null,
      erp_record_id: null,
      erp_record_url: null,
      user_roles: JSON.stringify(args.userRoles),
    })
    .execute();
  return sessionId;
}

function withEmbeddedHeaders(t: SupertestTest, sessionId: string): SupertestTest {
  // Origin matches the request Host (supertest binds to 127.0.0.1) so
  // `isSameOriginRequest` returns true; without this, validateGuestContext
  // would 403 with cross_origin_rejected.
  return t.set('X-Embedded-Session-Id', sessionId).set('Origin', `http://${HOST}`);
}

describe('PR 3C — HITL approval-queue operator API', () => {
  let app: express.Express;

  beforeAll(async () => {
    container.snapshot();
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/governance/approvals', approvalsRouter);
  });

  afterAll(async () => {
    await teardownTestDatabase();
    container.restore();
  });

  beforeEach(async () => {
    const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    await sql`DELETE FROM governance_approvals`.execute(db.getDatabase());
    await sql`DELETE FROM embedded_sessions WHERE session_id LIKE 'es_test_%'`.execute(db.getDatabase());
  });

  // ────────────────────────────────────────────────────────────────
  // Family 1 — Embedded session gate
  // ────────────────────────────────────────────────────────────────

  describe('embedded session gate (validateGuestContext)', () => {
    it('GET /  returns 403 when Origin header is missing (cross-origin rejected)', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await request(app)
        .get('/api/governance/approvals')
        .set('X-Embedded-Session-Id', sessionId);
      // No Origin header → isSameOriginRequest returns false → 403
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'cross_origin_rejected' });
    });

    it('GET /  returns 400 when X-Embedded-Session-Id is missing', async () => {
      const res = await request(app)
        .get('/api/governance/approvals')
        .set('Origin', `http://${HOST}`);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: 'missing_x_embedded_session_id' });
    });

    it('GET /  returns 404 when session is unknown', async () => {
      const res = await request(app)
        .get('/api/governance/approvals')
        .set('X-Embedded-Session-Id', 'es_test_does_not_exist')
        .set('Origin', `http://${HOST}`);
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ error: 'session_not_found' });
    });

    it('GET /  returns 410 when session has expired', async () => {
      const sessionId = await seedExpiredSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await request(app)
        .get('/api/governance/approvals')
        .set('X-Embedded-Session-Id', sessionId)
        .set('Origin', `http://${HOST}`);
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ error: 'session_expired' });
    });

    it('POST /:id/approve  applies the same gate (cross-origin rejected)', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const approvalId = await seedApproval(TENANT_A);
      const res = await request(app)
        .post(`/api/governance/approvals/${approvalId}/approve`)
        .set('X-Embedded-Session-Id', sessionId)
        .send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'cross_origin_rejected' });
    });

    it('POST /:id/reject  applies the same gate (cross-origin rejected)', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const approvalId = await seedApproval(TENANT_A);
      const res = await request(app)
        .post(`/api/governance/approvals/${approvalId}/reject`)
        .set('X-Embedded-Session-Id', sessionId)
        .send({ reason: 'no' });
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'cross_origin_rejected' });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Family 2 — Role gate (requireApproverRole)
  // ────────────────────────────────────────────────────────────────

  describe('role gate (requireApproverRole)', () => {
    it('approver role can list', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true });
    });

    it('admin role can list (superset)', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['admin'] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(200);
    });

    it('combo role (approver + ops) is allowed', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['ops', 'approver'] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(200);
    });

    it('ops-only role is denied with 403 insufficient_role', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['ops'] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ ok: false, code: 'insufficient_role' });
    });

    it('empty roles array is denied', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: [] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'insufficient_role' });
    });

    it('malformed user_roles JSON is treated as no-role (denied)', async () => {
      const sessionId = `es_test_${randomUUID()}`;
      const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
      await db.getDatabase()
        .insertInto('embedded_sessions')
        .values({
          session_id: sessionId,
          tenant_id: TENANT_A,
          user_id: USER_A,
          platform: 'standalone',
          platform_account_id: null,
          csrf_token: `csrf_test_${randomUUID()}`,
          expected_host_origin: `http://${HOST}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          last_rotation_at: null,
          erp_record_type: null,
          erp_record_id: null,
          erp_record_url: null,
          user_roles: '{ malformed json [',
        })
        .execute();
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'insufficient_role' });
    });

    it('approver role can POST /:id/approve', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, approval: { id: approvalId, status: 'approved' } });
    });

    it('ops role cannot POST /:id/approve', async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['ops'] });
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ code: 'insufficient_role' });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Family 3 — Tenant isolation
  // ────────────────────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it("GET /  only returns the embedded-session tenant's pending rows", async () => {
      await seedApproval(TENANT_A);
      await seedApproval(TENANT_A);
      await seedApproval(TENANT_B);
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await withEmbeddedHeaders(request(app).get('/api/governance/approvals'), sessionId);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(2);
      for (const item of res.body.items) {
        expect(item.tenantId).toBe(TENANT_A);
      }
    });

    it('POST /:id/approve  cross-tenant returns 404 (collapsed, no leak)', async () => {
      const approvalId = await seedApproval(TENANT_B);
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: 'approval_not_found' });
      // Critical: body MUST NOT leak the row's contents.
      expect(JSON.stringify(res.body)).not.toContain('REDACTED');
      expect(JSON.stringify(res.body)).not.toContain('Acme Co');
    });

    it('POST /:id/reject  cross-tenant returns 404 (collapsed)', async () => {
      const approvalId = await seedApproval(TENANT_B);
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/reject`),
        sessionId,
      ).send({ reason: 'no' });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: 'approval_not_found' });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Family 4 — Input validation
  // ────────────────────────────────────────────────────────────────

  describe('input validation', () => {
    let sessionId: string;
    beforeEach(async () => {
      sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
    });

    it('GET /?status=approved  returns 200 (Tier-C history view)', async () => {
      // Tier-C: history-view tabs were enabled — approved + rejected are now
      // valid statuses on top of pending. The status echo in the body lets
      // the operator UI confirm which tab it just rendered.
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'approved' });
    });

    it('GET /?status=rejected  returns 200 (Tier-C history view)', async () => {
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=rejected'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'rejected' });
    });

    it('GET /?status=expired  still rejected (v2 follow-up)', async () => {
      // 'expired' is intentionally NOT in the Tier-C history view since the
      // semantics around expired-but-unswept-pending rows differ from the
      // terminal-status query path. Documented in the merged plan as a
      // future scope item.
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=expired'),
        sessionId,
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ ok: false, code: 'invalid_status' });
    });

    it('GET /?status= (empty)  defaults to pending and returns 200', async () => {
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status='),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'pending' });
    });

    it('GET /  (no status param) defaults to pending and returns 200', async () => {
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: 'pending' });
    });

    it('GET /?status=a&status=b  rejects array-shaped param as 400', async () => {
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=a&status=b'),
        sessionId,
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_status' });
    });

    it.each([
      ['limit=abc', 'invalid_limit'],
      ['limit=1.5', 'invalid_limit'],
      ['limit=', 'invalid_limit'],
      ['limit=0', 'invalid_limit'], // below APPROVAL_LIST_MIN_LIMIT
      ['limit=200', 'invalid_limit'], // above APPROVAL_LIST_MAX_LIMIT
      ['offset=-1', 'invalid_offset'],
      ['offset=xyz', 'invalid_offset'],
      ['offset=2.5', 'invalid_offset'],
    ])('GET /?%s  returns 400 %s', async (qs, code) => {
      const res = await withEmbeddedHeaders(
        request(app).get(`/api/governance/approvals?${qs}`),
        sessionId,
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code });
    });

    it('GET /?limit=5&offset=0  returns 200 with the default cursor', async () => {
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?limit=5&offset=0'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body.limit).toBe(5);
      expect(res.body.offset).toBe(0);
    });

    it('POST /:id/reject  with no reason returns 400 reason_required', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/reject`),
        sessionId,
      ).send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'reason_required' });
    });

    it('POST /:id/reject  with whitespace-only reason returns 400 reason_required', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/reject`),
        sessionId,
      ).send({ reason: '   ' });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'reason_required' });
    });

    it('POST /:id/reject  with array-shaped reason returns 400 invalid_reason', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/reject`),
        sessionId,
      ).send({ reason: ['a', 'b'] });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_reason' });
    });

    it('POST /:id/approve  with array-shaped reason returns 400 invalid_reason', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({ reason: 42 });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_reason' });
    });

    it('POST /:id/approve  with no reason works (reason is optional on approve)', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(res.status).toBe(200);
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Family 5 — Happy-path CAS + error mapping
  // ────────────────────────────────────────────────────────────────

  describe('CAS + error mapping', () => {
    let sessionId: string;
    beforeEach(async () => {
      sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
    });

    it('POST /:id/approve  persists status=approved + decided_by_user_id + decided_at', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({ reason: 'safe — scanned and reviewed' });
      expect(res.status).toBe(200);
      expect(res.body.approval).toMatchObject({
        id: approvalId,
        status: 'approved',
        decidedByUserId: USER_A,
        decisionReason: 'safe — scanned and reviewed',
      });
      expect(res.body.approval.decidedAt).toBeTruthy();
    });

    it('POST /:id/reject  persists status=rejected + reason', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/reject`),
        sessionId,
      ).send({ reason: 'contains real PII' });
      expect(res.status).toBe(200);
      expect(res.body.approval).toMatchObject({
        id: approvalId,
        status: 'rejected',
        decisionReason: 'contains real PII',
      });
    });

    it('POST /:id/approve  twice returns 409 already_decided on the second call', async () => {
      const approvalId = await seedApproval(TENANT_A);
      const first = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(first.status).toBe(200);
      const second = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({
        ok: false,
        code: 'already_decided',
        currentStatus: 'approved',
      });
    });

    it('POST /:id/approve  on an expired pending row returns 410', async () => {
      const approvalId = await seedApproval(TENANT_A, { expiresInMs: -60_000 });
      const res = await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvalId}/approve`),
        sessionId,
      ).send({});
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ ok: false, code: 'approval_expired' });
    });

    it('POST /:id/reject  on unknown id returns 404 approval_not_found', async () => {
      const res = await withEmbeddedHeaders(
        request(app).post('/api/governance/approvals/does-not-exist/reject'),
        sessionId,
      ).send({ reason: 'no' });
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ code: 'approval_not_found' });
    });

    it('POST /:id/approve  with whitespace-only id returns 400 invalid_id', async () => {
      const res = await withEmbeddedHeaders(
        request(app).post('/api/governance/approvals/%20/approve'),
        sessionId,
      ).send({});
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_id' });
    });
  });

  // ────────────────────────────────────────────────────────────────
  // Family 6 — Tier-C history view: ?status=approved / ?status=rejected
  // ────────────────────────────────────────────────────────────────

  describe('Tier-C history view (status=approved | rejected)', () => {
    let sessionId: string;
    beforeEach(async () => {
      sessionId = await seedEmbeddedSession({ tenantId: TENANT_A, userId: USER_A, userRoles: ['approver'] });
    });

    it('GET /?status=approved  returns the tenant\'s approved rows (only)', async () => {
      // Seed: one approved, one rejected, one still pending. The approved
      // tab MUST return exactly the approved row.
      const approvedId = await seedApproval(TENANT_A);
      const rejectedId = await seedApproval(TENANT_A);
      const pendingId = await seedApproval(TENANT_A);
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvedId}/approve`),
        sessionId,
      ).send({ reason: 'approved-note' });
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${rejectedId}/reject`),
        sessionId,
      ).send({ reason: 'rejected-note' });

      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('approved');
      expect(res.body.total).toBe(1);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0]).toMatchObject({
        id: approvedId,
        status: 'approved',
        decisionReason: 'approved-note',
      });
      // Sanity: pendingId not returned here.
      const ids = res.body.items.map((r: { id: string }) => r.id);
      expect(ids).not.toContain(rejectedId);
      expect(ids).not.toContain(pendingId);
    });

    it('GET /?status=rejected  returns the tenant\'s rejected rows (only)', async () => {
      const approvedId = await seedApproval(TENANT_A);
      const rejectedId = await seedApproval(TENANT_A);
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvedId}/approve`),
        sessionId,
      ).send({});
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${rejectedId}/reject`),
        sessionId,
      ).send({ reason: 'why-not' });

      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=rejected'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('rejected');
      expect(res.body.total).toBe(1);
      expect(res.body.items[0]).toMatchObject({
        id: rejectedId,
        status: 'rejected',
        decisionReason: 'why-not',
      });
    });

    it('GET /?status=approved  respects tenant isolation (B cannot see A\'s approved rows)', async () => {
      const approvedA = await seedApproval(TENANT_A);
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvedA}/approve`),
        sessionId,
      ).send({});

      const sessionB = await seedEmbeddedSession({ tenantId: TENANT_B, userId: 'op-b', userRoles: ['approver'] });
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved'),
        sessionB,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    it('GET /?status=approved&limit=2  respects limit', async () => {
      // Seed 3 approved rows for TENANT_A; assert limit=2 returns 2 of them
      // but the total reflects all 3.
      for (let i = 0; i < 3; i++) {
        const id = await seedApproval(TENANT_A);
        await withEmbeddedHeaders(
          request(app).post(`/api/governance/approvals/${id}/approve`),
          sessionId,
        ).send({});
      }

      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved&limit=2'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(3);
      expect(res.body.limit).toBe(2);
    });

    it('GET /?status=approved&counts_only=1  returns total without item rows', async () => {
      // counts_only=1 drives the embedded UI's inactive-tab pill refresh
      // — the route MUST skip the list query so redactedPayload /
      // policyFindings are not downloaded for rows the UI isn't rendering.
      // Copilot R4 on PR #826.
      const approvedA = await seedApproval(TENANT_A);
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvedA}/approve`),
        sessionId,
      ).send({});

      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved&counts_only=1'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        status: 'approved',
        total: 1,
        items: [],
        countsOnly: true,
      });
      // PII sentinels MUST be absent — the row payload was never fetched.
      const bodyStr = JSON.stringify(res.body);
      expect(bodyStr).not.toContain('[REDACTED]');
      expect(bodyStr).not.toContain('Acme Co');
    });

    it('GET /?status=pending&counts_only=1  also bypasses the list query', async () => {
      // Tier-A pending tab uses the same flag to keep the pill live without
      // re-downloading rows on every 10s tick.
      await seedApproval(TENANT_A);
      await seedApproval(TENANT_A);
      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=pending&counts_only=1'),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        status: 'pending',
        total: 2,
        items: [],
        countsOnly: true,
      });
    });

    it.each([
      ['counts_only=true', true],
      ['counts_only=yes', true],
      ['counts_only=TRUE', true],
      ['counts_only=0', false],
      ['counts_only=', false],
      ['counts_only=please', false],
    ])('GET /?%s parses to countsOnly=%s', async (qs, expectedCountsOnly) => {
      const res = await withEmbeddedHeaders(
        request(app).get(`/api/governance/approvals?${qs}&status=pending`),
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(res.body.countsOnly).toBe(expectedCountsOnly);
    });

    it('GET /?status=approved  redactedPayload is the persisted (redacted) form', async () => {
      // PII sentinel must NEVER appear in the response body — the row was
      // enqueued with a pre-redacted payload. Asserts the history surface
      // mirrors the PII guarantee that PR 3C's pending list enforces.
      const approvedId = await seedApproval(TENANT_A);
      await withEmbeddedHeaders(
        request(app).post(`/api/governance/approvals/${approvedId}/approve`),
        sessionId,
      ).send({});

      const res = await withEmbeddedHeaders(
        request(app).get('/api/governance/approvals?status=approved'),
        sessionId,
      );
      expect(res.status).toBe(200);
      const bodyStr = JSON.stringify(res.body);
      // seedApproval (top of file) enqueues a decision whose redactedPayload
      // is `{ssn: '[REDACTED]', customer: 'Acme Co'}` — Acme Co is a sentinel
      // value, never a real PII shape, but its absence on a status=approved
      // GET proves the redacted form is the one persisted + returned.
      expect(bodyStr).toContain('[REDACTED]');
      expect(bodyStr).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    });
  });
});
