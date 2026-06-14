/**
 * FinanceCentral operator routes (PR 6) — integration tests.
 *
 * End-to-end via Express route + real DI container + in-memory SQLite +
 * mocked NetSuiteConnector. Exercises the durable approve state machine
 * (begin → connector write → complete, with revert on every failure mode)
 * and the atomic reject path against the production HTTP surface.
 *
 * Spec: docs/plans/2026-05-13-operator-promotion-spec.md §6.3
 * Pattern source: tests/integration/syncErrorAssistOperator.routes.test.ts
 *
 * Tenant: unauthenticated supertest requests fall through to SYSTEM_IDENTITY
 * via extractIdentityContext (no auth middleware mounted on the test app),
 * so seeded rows must use the same tenant_id the route reads.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { financeCentralRouter } from '../../src/routes/financeCentral';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { ConnectorManager } from '../../src/services/integration/ConnectorManager';
import { FinanceCentralRepository } from '../../src/services/financeCentral/FinanceCentralRepository';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { ApprovalPriority, DocumentType } from '../../src/services/financeCentral/types';

const TENANT_ID = SYSTEM_IDENTITY.tenantId;
const DAY_MS = 86_400_000;

interface SeedOverrides {
  approvalId?: string;
  documentType?: DocumentType;
  amount?: number;
  priority?: ApprovalPriority;
  netSuiteId?: string | undefined;
  submittedAt?: string;
}

describe('finance-central operator routes (PR 6)', () => {
  let app: express.Express;
  let repo: FinanceCentralRepository;
  let mockConnector: { update: jest.Mock };

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/finance-central', financeCentralRouter);
    repo = await container.getAsync<FinanceCentralRepository>(TYPES.FinanceCentralRepository);
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    mockConnector = {
      update: jest.fn().mockResolvedValue({ id: 'ns_updated_42' }),
    };
    jest
      .spyOn(ConnectorManager.prototype, 'getConnector')
      .mockResolvedValue(mockConnector as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await sql`DELETE FROM finance_central_approvals`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'finance_central.%'`.execute(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function seedPending(overrides: SeedOverrides = {}): Promise<string> {
    const approvalId = overrides.approvalId ?? `appr-${Math.random().toString(36).slice(2, 8)}`;
    await repo.insertIfMissing({
      tenantId: TENANT_ID,
      approvalId,
      documentId: `doc-${approvalId}`,
      documentNumber: `INV-${approvalId}`,
      documentType: overrides.documentType ?? 'invoice',
      description: 'integration seed',
      amount: overrides.amount ?? 1000,
      currency: 'USD',
      submittedBy: 'seed@x',
      submittedAt: overrides.submittedAt ?? new Date().toISOString(),
      currentApprover: 'a@x',
      approvalLevel: 1,
      priority: overrides.priority ?? 'medium',
      // `undefined` and absent both flow to `null` in the row; the explicit
      // `undefined` override is how the "no netSuiteId" scenario opts out.
      netSuiteId: 'netSuiteId' in overrides ? overrides.netSuiteId : 'ns_seed_default',
    });
    return approvalId;
  }

  async function fetchAudit(action: string) {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    return db.selectFrom('audit_logs').selectAll().where('action', '=', action).execute();
  }

  // ---------------------------------------------------------------------------
  // GET /api/finance-central/approvals
  // ---------------------------------------------------------------------------

  describe('GET /api/finance-central/approvals', () => {
    it('returns seeded pending rows ordered by priority then daysWaiting', async () => {
      const now = Date.now();
      await seedPending({ approvalId: 'appr-low',       priority: 'low',    submittedAt: new Date(now - 5 * DAY_MS).toISOString() });
      await seedPending({ approvalId: 'appr-urgent',    priority: 'urgent', submittedAt: new Date(now - 1 * DAY_MS).toISOString() });
      await seedPending({ approvalId: 'appr-med-new',   priority: 'medium', submittedAt: new Date(now - 1 * DAY_MS).toISOString() });
      await seedPending({ approvalId: 'appr-med-old',   priority: 'medium', submittedAt: new Date(now - 4 * DAY_MS).toISOString() });

      const res = await request(app).get('/api/finance-central/approvals');

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      const ids = res.body.map((r: { id: string }) => r.id);
      // urgent → medium (older daysWaiting first) → low
      expect(ids).toEqual(['appr-urgent', 'appr-med-old', 'appr-med-new', 'appr-low']);
    });

    it('honors the ?priority filter', async () => {
      await seedPending({ approvalId: 'appr-h1', priority: 'high' });
      await seedPending({ approvalId: 'appr-m1', priority: 'medium' });

      const res = await request(app).get('/api/finance-central/approvals?priority=high');

      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].id).toBe('appr-h1');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/finance-central/approvals/:id/approve
  // ---------------------------------------------------------------------------

  describe('POST /api/finance-central/approvals/:id/approve', () => {
    it('happy path: 200 + row accepted + connector called with fields wrapper + audit success', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-happy', netSuiteId: 'ns_seed_happy' });

      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42', comments: 'lgtm' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, code: 'ok', appliedRecordId: 'ns_updated_42' });
      expect(mockConnector.update).toHaveBeenCalledTimes(1);
      expect(mockConnector.update).toHaveBeenCalledWith(
        'invoice',
        'ns_seed_happy',
        expect.objectContaining({
          fields: expect.objectContaining({
            status: 'approved',
            approved_by: 'op_42',
            approval_comments: 'lgtm',
          }),
        }),
      );

      const row = await repo.getRowByApprovalId(TENANT_ID, approvalId);
      expect(row?.operator_disposition).toBe('accepted');
      expect(row?.applied_record_id).toBe('ns_updated_42');
      expect(row?.operator_disposition_user_id).toBe('op_42');
      expect(row?.approval_comments).toBe('lgtm');

      const audits = await fetchAudit('finance_central.approve');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
      expect(audits[0].user_id).toBe('op_42');
      expect(audits[0].resource_id).toBe(approvalId);
    });

    it('400 when approverId is missing', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-no-approver' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(mockConnector.update).not.toHaveBeenCalled();
      const row = await repo.getRowByApprovalId(TENANT_ID, approvalId);
      expect(row?.operator_disposition).toBe('pending');
    });

    it('400 when approverId is a non-string (PR 6 R7 — type validation)', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-bad-type' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 42 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.message).toMatch(/non-empty string/);
      expect(mockConnector.update).not.toHaveBeenCalled();
    });

    it('400 when approverId is a whitespace-only string', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-whitespace' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: '   ' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('400 when comments is provided as a non-string', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-bad-comments' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42', comments: { malicious: true } });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.message).toMatch(/comments/);
    });

    it('404 on unknown approvalId', async () => {
      const res = await request(app)
        .post('/api/finance-central/approvals/unknown-id/approve')
        .send({ approverId: 'op_42' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
      expect(mockConnector.update).not.toHaveBeenCalled();
    });

    it('409 already_dispositioned on second approve', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-dup', netSuiteId: 'ns_dup' });

      const first = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42' });
      expect(first.status).toBe(200);

      const second = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_99' });
      expect(second.status).toBe(409);
      expect(second.body.code).toBe('already_dispositioned');
      expect(mockConnector.update).toHaveBeenCalledTimes(1); // only the first call
    });

    it('503 connector_unavailable + row reverted to pending when netSuiteId is absent', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-no-ns', netSuiteId: undefined });

      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42' });

      expect(res.status).toBe(503);
      expect(res.body.code).toBe('connector_unavailable');
      expect(mockConnector.update).not.toHaveBeenCalled();

      const row = await repo.getRowByApprovalId(TENANT_ID, approvalId);
      expect(row?.operator_disposition).toBe('pending');

      const audits = await fetchAudit('finance_central.approve');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].error_message).toBe('no_netsuite_id');
    });

    it('502 write_failed + row reverted to pending when connector throws', async () => {
      mockConnector.update.mockRejectedValueOnce(new Error('netsuite_502'));
      const approvalId = await seedPending({ approvalId: 'appr-throw', netSuiteId: 'ns_throw' });

      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42' });

      expect(res.status).toBe(502);
      expect(res.body.code).toBe('write_failed');
      expect(mockConnector.update).toHaveBeenCalledTimes(1);

      const row = await repo.getRowByApprovalId(TENANT_ID, approvalId);
      expect(row?.operator_disposition).toBe('pending');

      const audits = await fetchAudit('finance_central.approve');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].error_message).toBe('netsuite_502');
    });

    it('500 state_drift when connector wrote but DB row no longer holds the lease', async () => {
      // PR 6 R2 (Codex BM-1): manufacture the race by stealing the lease
      // between connector.update and completeAccept. The connector.update mock
      // hijacks the row state (sets disposition back to pending while the
      // operator still holds the in-flight approve), simulating a reaper or
      // another operator's recovery action. The connector write succeeded, so
      // returning ok would let a re-pickup double-write to NetSuite.
      const approvalId = await seedPending({ approvalId: 'appr-drift', netSuiteId: 'ns_drift' });

      mockConnector.update.mockImplementationOnce(async () => {
        // Race: while we await the connector, "another operator" reverts the row.
        await repo.revertToPending({ tenantId: TENANT_ID, approvalId, userId: 'op_42' });
        return { id: 'ns_drift_applied' };
      });

      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42' });

      expect(res.status).toBe(500);
      expect(res.body.code).toBe('state_drift');
      expect(res.body.message).toContain('ns_drift_applied');
      expect(mockConnector.update).toHaveBeenCalledTimes(1);

      const audits = await fetchAudit('finance_central.approve');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].error_message).toMatch(/^state_drift:/);
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/finance-central/approvals/:id/reject
  // ---------------------------------------------------------------------------

  describe('POST /api/finance-central/approvals/:id/reject', () => {
    it('happy path: 200 + row rejected + connector NOT called + audit success', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej', netSuiteId: 'ns_rej' });

      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ rejecterId: 'op_42', reason: 'budget exceeded' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, code: 'ok' });
      expect(mockConnector.update).not.toHaveBeenCalled();

      const row = await repo.getRowByApprovalId(TENANT_ID, approvalId);
      expect(row?.operator_disposition).toBe('rejected');
      expect(row?.rejection_reason).toBe('budget exceeded');
      expect(row?.operator_disposition_user_id).toBe('op_42');

      const audits = await fetchAudit('finance_central.reject');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
    });

    it('400 when rejecterId is missing', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej-no-id' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('400 when reason is missing', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej-no-reason' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ rejecterId: 'op_42' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
    });

    it('400 when rejecterId is a non-string (PR 6 R7 — type validation)', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej-bad-type' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ rejecterId: { hack: true }, reason: 'x' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.message).toMatch(/non-empty string/);
    });

    it('400 when reason is a non-string', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej-bad-reason' });
      const res = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ rejecterId: 'op_42', reason: 99 });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request');
      expect(res.body.message).toMatch(/non-empty string/);
    });

    it('404 on unknown approvalId', async () => {
      const res = await request(app)
        .post('/api/finance-central/approvals/unknown-id/reject')
        .send({ rejecterId: 'op_42', reason: 'x' });
      expect(res.status).toBe(404);
    });

    it('409 already_dispositioned when row already accepted', async () => {
      const approvalId = await seedPending({ approvalId: 'appr-rej-after-accept', netSuiteId: 'ns_aa' });
      const approveRes = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/approve`)
        .send({ approverId: 'op_42' });
      expect(approveRes.status).toBe(200);

      const rejectRes = await request(app)
        .post(`/api/finance-central/approvals/${approvalId}/reject`)
        .send({ rejecterId: 'op_99', reason: 'too late' });

      expect(rejectRes.status).toBe(409);
      expect(rejectRes.body.code).toBe('already_dispositioned');
    });
  });
});
