/**
 * WorkflowCentral render-route integration tests (Phase 1 T17 — ADR-019).
 *
 * End-to-end HTTP coverage for GET /api/workflow-central/tasks/:id/render.
 * Exercises:
 *   - The discriminated TaskRenderModel happy paths (resolved / ephemeral / legacy)
 *   - Partial-success contract (per-ref resolver failures stay INSIDE 200)
 *   - Task-id shape validator (400)
 *   - Cross-tenant 404 (no existence leak)
 *   - Ephemeral opt-in gate (403 EphemeralPayloadNotAllowedError)
 *   - Ephemeral expiry (410 EphemeralPayloadExpiredError)
 *   - Readiness gate (503 before hydration)
 *   - Audit-row redaction invariant — task.payload.data NEVER reaches audit_logs
 *
 * Pattern source: tests/integration/workflowCentral-completeTask.test.ts
 * + tests/integration/syncErrorAssistOperator.routes.test.ts.
 *
 * Boots a fresh Express app + the workflowCentral router on an in-memory
 * SQLite DatabaseService rebound on the Inversify container. WorkflowPayload
 * resolution is intercepted via jest.spyOn on
 * `WorkflowPayloadResolver.prototype.resolve` — the operator service holds the
 * DI-resolved instance, so prototype-level mocking covers it.
 */
import 'reflect-metadata';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { workflowCentralRouter } from '../../src/routes/workflowCentral';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
import { WorkflowPayloadResolver, type ResolutionOutcome } from '../../src/services/workflowCentral/payload/WorkflowPayloadResolver';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { WorkflowPayload } from '../../src/services/workflowCentral/payload/WorkflowPayload';

const SYSTEM_TENANT = SYSTEM_IDENTITY.tenantId; // '__system__'
const OTHER_TENANT = 'tenant-other';
const FLAG = 'WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD';

describe('workflow-central render route integration (T17)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;
  let originalFlag: string | undefined;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    // Tiny auth shim — populates req.user when X-Test-Tenant-Id is supplied
    // so we can drive the cross-tenant 404 path. The real route only reads
    // req.user.tenantId / req.user.id; nothing else is required for identity
    // extraction. Absence falls through to SYSTEM_IDENTITY.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const t = req.headers['x-test-tenant-id'];
      if (typeof t === 'string' && t.length > 0) {
        (req as Request & { user?: { tenantId: string; id: string } }).user = {
          tenantId: t,
          id: 'test-user',
        };
      }
      next();
    });
    app.use('/api/workflow-central', workflowCentralRouter);

    // T10 readiness gate is mounted on the router; flip the engine flag
    // so requests aren't 503'd before server.start() boots the engine.
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    engine.hydrationReady = true;

    originalFlag = process.env[FLAG];
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    delete process.env[FLAG];
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Seed a workflow_central_tasks row with optional payload + data. */
  async function seedTask(args: {
    id: string;
    tenantId?: string;
    payload?: WorkflowPayload | null;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const tenantId = args.tenantId ?? SYSTEM_TENANT;
    const now = new Date().toISOString();
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: args.id,
        tenant_id: tenantId,
        instance_id: `INST-${args.id}`,
        workflow_id: `WF-${args.id}`,
        workflow_name: 'Render WF',
        step_id: 'STEP-A',
        step_name: 'Step A',
        task_type: 'task',
        status: 'pending',
        priority: 'medium',
        assignee_id: 'alice',
        assignee_name: 'Alice',
        description: 'render test',
        due_at: null,
        data: JSON.stringify(args.data ?? {}),
        actions: JSON.stringify([
          { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
        ]),
        created_at: now,
        updated_at: now,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
        payload: args.payload ? JSON.stringify(args.payload) : null,
      })
      .execute();
  }

  async function fetchRenderAudits(): Promise<Array<{ result: string; error_message: string | null; details: string | null }>> {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const rows = await db
      .selectFrom('audit_logs')
      .select(['result', 'error_message', 'details'])
      .where('action', '=', 'workflow_central.render_task')
      .execute();
    return rows.map((r) => ({
      result: r.result as string,
      error_message: (r.error_message as string | null) ?? null,
      details: (r.details as string | null) ?? null,
    }));
  }

  const refsFixture = [
    {
      system: 'netsuite' as const,
      recordType: 'salesOrder',
      recordId: 'SO-1001',
      fieldsOfInterest: ['amount', 'customerName'],
    },
  ];

  // ===========================================================================
  // 200 — discriminated TaskRenderModel happy paths
  // ===========================================================================

  describe('200 happy paths', () => {
    it('external_reference → kind=resolved, resolver invoked with tenantId', async () => {
      const resolution: ResolutionOutcome[] = [
        {
          ref: refsFixture[0],
          status: 'resolved',
          fields: { amount: 9000, customerName: 'Acme' },
          resolvedAt: new Date().toISOString(),
        },
      ];
      const spy = jest
        .spyOn(WorkflowPayloadResolver.prototype, 'resolve')
        .mockResolvedValue(resolution);

      await seedTask({
        id: 'TASK-render-ref-1',
        payload: { mode: 'external_reference', references: refsFixture },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-ref-1/render');

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('resolved');
      expect(res.body.task.id).toBe('TASK-render-ref-1');
      expect(res.body.resolution).toHaveLength(1);
      expect(res.body.resolution[0].status).toBe('resolved');
      expect(res.body.resolution[0].fields).toEqual({ amount: 9000, customerName: 'Acme' });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(refsFixture, SYSTEM_TENANT);
    });

    it.each([
      ['PAYLOAD_REF_CONNECTOR_UNAVAILABLE', 503, 'salesforce'],
      ['PAYLOAD_REF_AUTH_EXPIRED', 401, 'netsuite'],
    ])(
      'external_reference connector failure → STILL 200; resolution[i].error.code=%s',
      async (code, statusCode, system) => {
        const failingRef = { system: system as 'netsuite' | 'salesforce', recordType: 'Foo', recordId: 'FOO-1' };
        const resolution: ResolutionOutcome[] = [
          {
            ref: failingRef,
            status: 'failed',
            error: { code, statusCode, message: `${code} (mock)` },
          },
        ];
        jest.spyOn(WorkflowPayloadResolver.prototype, 'resolve').mockResolvedValue(resolution);

        const taskId = `TASK-render-fail-${code.toLowerCase().replace(/_/g, '-')}`;
        await seedTask({
          id: taskId,
          payload: { mode: 'external_reference', references: [failingRef] },
        });

        const res = await request(app).get(`/api/workflow-central/tasks/${taskId}/render`);

        expect(res.status).toBe(200);
        expect(res.body.kind).toBe('resolved');
        expect(res.body.resolution[0].status).toBe('failed');
        expect(res.body.resolution[0].error.code).toBe(code);
        expect(res.body.resolution[0].error.statusCode).toBe(statusCode);
      },
    );

    it('external_reference partial-success → STILL 200; failed ref carried inside resolution[i]', async () => {
      const resolution: ResolutionOutcome[] = [
        {
          ref: refsFixture[0],
          status: 'resolved',
          fields: { amount: 9000 },
          resolvedAt: new Date().toISOString(),
        },
        {
          ref: { system: 'salesforce', recordType: 'Opportunity', recordId: 'OPP-99' },
          status: 'failed',
          error: {
            code: 'PAYLOAD_REF_RECORD_NOT_FOUND',
            statusCode: 404,
            message: 'salesforce Opportunity OPP-99 not found',
          },
        },
      ];
      jest.spyOn(WorkflowPayloadResolver.prototype, 'resolve').mockResolvedValue(resolution);

      await seedTask({
        id: 'TASK-render-partial-1',
        payload: {
          mode: 'external_reference',
          references: [
            refsFixture[0],
            { system: 'salesforce', recordType: 'Opportunity', recordId: 'OPP-99' },
          ],
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-partial-1/render');

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('resolved');
      expect(res.body.resolution).toHaveLength(2);
      expect(res.body.resolution[1].status).toBe('failed');
      expect(res.body.resolution[1].error.code).toBe('PAYLOAD_REF_RECORD_NOT_FOUND');
      expect(res.body.resolution[1].error.statusCode).toBe(404);
    });

    it('ephemeral_hosted + flag enabled + unexpired → kind=ephemeral, data flows through', async () => {
      process.env[FLAG] = 'true';
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await seedTask({
        id: 'TASK-render-eph-1',
        payload: {
          mode: 'ephemeral_hosted',
          expiresAt,
          reason: 'demo workflow',
          data: { poNumber: 'PO-77', amount: 12345 },
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-eph-1/render');

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('ephemeral');
      expect(res.body.ephemeral.reason).toBe('demo workflow');
      expect(res.body.ephemeral.expiresAt).toBe(expiresAt);
      expect(res.body.ephemeral.data).toEqual({ poNumber: 'PO-77', amount: 12345 });
    });

    it('legacy (no payload, data populated) → kind=legacy, legacyResolution.fields = task.data', async () => {
      await seedTask({
        id: 'TASK-render-legacy-1',
        payload: null,
        data: { poNumber: 'PO-LEGACY', amount: 500 },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-legacy-1/render');

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('legacy');
      expect(res.body.legacyResolution.source).toBe('legacy-row');
      expect(res.body.legacyResolution.fields).toEqual({ poNumber: 'PO-LEGACY', amount: 500 });
    });
  });

  // ===========================================================================
  // 400 — task-id shape validator
  // ===========================================================================

  describe('400 invalid_task_id shape', () => {
    it.each([
      ['underscore', 'TASK_1'],
      ['dot', 'TASK.1'],
      ['plus', 'TASK+1'],
      ['too-long (129 chars)', 'a'.repeat(129)],
    ])('rejects id with %s', async (_label, badId) => {
      const res = await request(app).get(`/api/workflow-central/tasks/${encodeURIComponent(badId)}/render`);
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_task_id');
    });
  });

  // ===========================================================================
  // 404 — not found / cross-tenant isolation
  // ===========================================================================

  describe('404 not found', () => {
    it('returns 404 when task does not exist in tenant', async () => {
      const res = await request(app).get('/api/workflow-central/tasks/TASK-missing-9/render');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('returns 404 for cross-tenant access — does NOT leak existence', async () => {
      await seedTask({ id: 'TASK-cross-tenant-1', tenantId: OTHER_TENANT });
      const res = await request(app)
        .get('/api/workflow-central/tasks/TASK-cross-tenant-1/render')
        .set('X-Test-Tenant-Id', SYSTEM_TENANT);
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('not_found');
    });

    it('cross-tenant: same id returns 200 when requester IS the owning tenant', async () => {
      await seedTask({
        id: 'TASK-cross-tenant-2',
        tenantId: OTHER_TENANT,
        payload: null,
        data: { x: 1 },
      });
      const res = await request(app)
        .get('/api/workflow-central/tasks/TASK-cross-tenant-2/render')
        .set('X-Test-Tenant-Id', OTHER_TENANT);
      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('legacy');
    });
  });

  // ===========================================================================
  // 403 — ephemeral opt-in gate
  // ===========================================================================

  describe('403 ephemeral_payload_not_allowed (env flag unset)', () => {
    it('rejects unexpired ephemeral payload when flag is not set', async () => {
      delete process.env[FLAG];
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      await seedTask({
        id: 'TASK-render-eph-gated-1',
        payload: {
          mode: 'ephemeral_hosted',
          expiresAt,
          reason: 'should be gated',
          data: { sensitive: 'leaked-if-bug' },
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-eph-gated-1/render');

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('EPHEMERAL_PAYLOAD_NOT_ALLOWED');
      // Body must not echo back the ephemeral.data
      expect(JSON.stringify(res.body)).not.toContain('leaked-if-bug');
    });
  });

  // ===========================================================================
  // 410 — ephemeral payload expired
  // ===========================================================================

  describe('410 ephemeral_payload_expired', () => {
    it('rejects ephemeral payload whose expiresAt is in the past', async () => {
      process.env[FLAG] = 'true';
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      await seedTask({
        id: 'TASK-render-eph-expired-1',
        payload: {
          mode: 'ephemeral_hosted',
          expiresAt,
          reason: 'demo',
          data: { x: 1 },
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-eph-expired-1/render');

      expect(res.status).toBe(410);
      expect(res.body.code).toBe('EPHEMERAL_PAYLOAD_EXPIRED');
    });
  });

  // ===========================================================================
  // Readiness gate
  // ===========================================================================

  describe('readiness gate', () => {
    it('returns 503 when engine.hydrationReady is false', async () => {
      engine.hydrationReady = false;
      try {
        const res = await request(app).get('/api/workflow-central/tasks/TASK-anything/render');
        expect(res.status).toBe(503);
      } finally {
        engine.hydrationReady = true;
      }
    });
  });

  // ===========================================================================
  // Audit redaction invariant — task.payload.data NEVER reaches audit_logs
  // ===========================================================================

  describe('audit redaction invariant', () => {
    it('ephemeral render: audit row omits ephemeral.data values', async () => {
      process.env[FLAG] = 'true';
      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const sentinel = 'redaction-sentinel-must-not-leak';
      await seedTask({
        id: 'TASK-render-audit-eph-1',
        payload: {
          mode: 'ephemeral_hosted',
          expiresAt,
          reason: 'audit-redaction-test',
          data: { secret: sentinel },
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-audit-eph-1/render');
      expect(res.status).toBe(200);

      const audits = await fetchRenderAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
      const detailsBlob = audits[0].details ?? '';
      expect(detailsBlob).not.toContain(sentinel);
      const parsed = JSON.parse(detailsBlob);
      expect(parsed.payload.mode).toBe('ephemeral_hosted');
      expect(parsed.payload.expiresAt).toBe(expiresAt);
      expect(parsed.payload.reason).toBe('audit-redaction-test');
      expect(parsed.payload).not.toHaveProperty('data');
    });

    it('external_reference render: audit row contains refs but NOT resolved field values', async () => {
      const resolvedSentinel = 'resolved-sentinel-must-not-leak';
      jest.spyOn(WorkflowPayloadResolver.prototype, 'resolve').mockResolvedValue([
        {
          ref: refsFixture[0],
          status: 'resolved',
          fields: { amount: 9000, secret: resolvedSentinel },
          resolvedAt: new Date().toISOString(),
        },
      ]);
      await seedTask({
        id: 'TASK-render-audit-ref-1',
        payload: { mode: 'external_reference', references: refsFixture },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-audit-ref-1/render');
      expect(res.status).toBe(200);

      const audits = await fetchRenderAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('success');
      const detailsBlob = audits[0].details ?? '';
      expect(detailsBlob).not.toContain(resolvedSentinel);
      const parsed = JSON.parse(detailsBlob);
      expect(parsed.payload.references).toEqual(refsFixture);
      expect(parsed.ref_count).toBe(1);
      expect(parsed.resolution_failures).toBe(0);
    });

    it('ephemeral expired: audit row records failure + omits data', async () => {
      process.env[FLAG] = 'true';
      const expiresAt = new Date(Date.now() - 60_000).toISOString();
      const sentinel = 'expired-data-sentinel';
      await seedTask({
        id: 'TASK-render-audit-eph-expired-1',
        payload: {
          mode: 'ephemeral_hosted',
          expiresAt,
          reason: 'expired-audit',
          data: { secret: sentinel },
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-audit-eph-expired-1/render');
      expect(res.status).toBe(410);

      const audits = await fetchRenderAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].error_message).toBe('ephemeral_payload_expired');
      expect(audits[0].details ?? '').not.toContain(sentinel);
    });

    it('not_found path: no audit row emitted (the operator path throws before audit)', async () => {
      const res = await request(app).get('/api/workflow-central/tasks/TASK-render-audit-missing-1/render');
      expect(res.status).toBe(404);
      const audits = await fetchRenderAudits();
      expect(audits).toHaveLength(0);
    });
  });
});
