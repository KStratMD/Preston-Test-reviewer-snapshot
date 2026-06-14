/**
 * WorkflowCentral cancelInstance integration tests (T12).
 *
 * End-to-end via POST /api/workflow-central/instances/:id/cancel.
 * Uses in-memory SQLite + real DI container.
 *
 * Covers:
 *   - F-05 cascade fix: 3 pending tasks all cancelled, engine shows cancelled
 *   - F-09 audit shape: required details keys present
 *   - Regression: cancelled tasks cannot be completed
 *
 * Pattern source: tests/integration/financeCentral-approveItem.test.ts
 * Spec: docs/plans/2026-05-14-workflow-central-operator-promotion-plan.md T12
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { workflowCentralRouter } from '../../src/routes/workflowCentral';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
import { WorkflowCentralRepository } from '../../src/services/workflowCentral/WorkflowCentralRepository';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { TaskAction } from '../../src/services/WorkflowCentralService';
import type { NewInstanceRow } from '../../src/services/workflowCentral/types';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

describe('workflow-central cancelInstance integration (T12)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    // T10: readiness gate is now mounted on the router; set hydrationReady=true
    // so integration tests aren't blocked with 503 before server.start().
    engine.hydrationReady = true;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM workflow_central_instances`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let seq = 0;

  /**
   * Seed a running instance row directly into the DB via repo.insertInstance.
   *
   * Post-PR-OP-3 T5, `engine.createInstance` is purely ephemeral — the DB row
   * is now the source of truth, written by `WorkflowCentralService.startInstance`
   * inside a TX. The cancel route reads via `repo.selectInstanceForUpdate`, so
   * a test that seeds only via the engine cache 404s. Mirrors the seed helper
   * in tests/integration/workflowCentral-pauseResume.test.ts.
   */
  async function seedInstanceRow(): Promise<string> {
    seq++;
    const id = `INST-cancel-${seq}-${Date.now()}`;
    const now = new Date().toISOString();
    const row: NewInstanceRow = {
      id,
      tenantId: TENANT_ID,
      workflowId: `WF-cancel-${seq}`,
      workflowName: `Cancel WF ${seq}`,
      workflowVersion: 1,
      status: 'running',
      currentStepId: 'STEP-1',
      currentStepName: 'Step 1',
      variables: {},
      stepHistory: [],
      startedBy: 'test-seed',
      startedAt: now,
      completedAt: null,
      dueAt: null,
      error: null,
      pausedFromStatus: null,
    };
    const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const repo = await container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
    await dbService.transaction(async (tx) => {
      await repo.insertInstance(tx, row);
    });
    return id;
  }

  /** Insert a pending task row directly for an instance. */
  async function seedPendingTask(instanceId: string, taskId: string): Promise<void> {
    const now = new Date().toISOString();
    const actions: TaskAction[] = [
      { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
    ];
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: taskId,
        tenant_id: TENANT_ID,
        instance_id: instanceId,
        workflow_id: 'WF-cancel-test',
        workflow_name: 'Cancel WF',
        step_id: 'STEP-1',
        step_name: 'Step 1',
        task_type: 'task',
        status: 'pending',
        priority: 'medium',
        assignee_id: 'alice',
        assignee_name: 'Alice',
        description: 'Cancel test task',
        due_at: null,
        data: '{}',
        actions: JSON.stringify(actions),
        created_at: now,
        updated_at: now,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
      })
      .execute();
  }

  async function fetchAudit(action: string) {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    return db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', action)
      .orderBy('created_at', 'desc')
      .execute();
  }

  // ---------------------------------------------------------------------------
  // F-05 cascade fix: all 3 tasks cancelled, engine status applied
  // ---------------------------------------------------------------------------

  it('F-05: cancels all 3 pending tasks and marks engine instance as cancelled', async () => {
    const instanceId = await seedInstanceRow();
    await seedPendingTask(instanceId, `TASK-c1-${seq}`);
    await seedPendingTask(instanceId, `TASK-c2-${seq}`);
    await seedPendingTask(instanceId, `TASK-c3-${seq}`);

    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_42', reason: 'test cancellation' });

    // seedInstanceRow() persisted the instance to workflow_central_instances above;
    // cancelInstance must return 200 with the instance JSON (status='cancelled'). 404
    // would mean repo.selectInstanceForUpdate couldn't see the row — a real regression
    // worth surfacing, not papering over. The engine cache is populated post-TX by
    // refreshCacheFromCommit, exercised by the engine.getInstance assertion below.
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: instanceId, status: 'cancelled' });

    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const tasks = await db
      .selectFrom('workflow_central_tasks')
      .select(['id', 'status'])
      .where('instance_id', '=', instanceId)
      .execute();

    expect(tasks).toHaveLength(3);
    for (const t of tasks) {
      expect(t.status).toBe('cancelled');
    }

    // Engine instance should be cancelled — Copilot R10 SHOULD-FIX: assertion
    // must be unconditional so a regression that removes the engine instance
    // (or leaves it in a non-cancelled status) fails the test loudly.
    const inst = engine.getInstance(TENANT_ID, instanceId);
    expect(inst).not.toBeNull();
    expect(inst!.status).toBe('cancelled');

    const audits = await fetchAudit('workflow_central.cancel_instance');
    expect(audits).toHaveLength(1);
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.cancelled_task_count).toBe(3);
    expect(Array.isArray(details.cancelled_task_ids)).toBe(true);
    expect(details.cancelled_task_ids).toHaveLength(3);
    // Post-PR-OP-3 D9+D11: the old engine.setInstanceStatusForTenant mutation that
    // could succeed/fail independently from the DB UPDATE is gone — cancel is now
    // a single atomic TX. Engine cache refresh is best-effort post-commit, so an
    // `engine_status_applied` audit flag no longer represents anything meaningful.
  });

  // ---------------------------------------------------------------------------
  // F-09 audit shape
  // ---------------------------------------------------------------------------

  it('F-09: audit details contains all required keys', async () => {
    const instanceId = await seedInstanceRow();
    await seedPendingTask(instanceId, `TASK-audit-${seq}`);

    await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_review', reason: 'audit shape test' });

    const audits = await fetchAudit('workflow_central.cancel_instance');
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(audits[0].details as unknown as string);

    // Required audit shape keys per spec R4 F-09 (post Codex IMPORTANT-2:
    // cancellation_reason is intentionally OMITTED from audit details to
    // match the complete-task pattern that strips user-supplied free text).
    // Post-PR-OP-3 D9+D11: engine_status_applied is gone (no separate engine
    // mutation can fail independently). Copilot R2 added the reason_supplied
    // + reason_was_redacted observability flags.
    expect(details).toHaveProperty('tenant_id');
    expect(details).toHaveProperty('instance_id');
    expect(details).toHaveProperty('workflow_id');
    expect(details).toHaveProperty('cancelled_task_ids');
    expect(details).toHaveProperty('cancelled_task_count');
    expect(details).toHaveProperty('cancelled_by');
    expect(details).toHaveProperty('reason_supplied');
    expect(details).toHaveProperty('reason_was_redacted');
    // Negative assertion: free-text reason MUST NOT be persisted to audit.
    expect(details).not.toHaveProperty('cancellation_reason');
    expect(details).not.toHaveProperty('engine_status_applied');

    expect(details.tenant_id).toBe(TENANT_ID);
    expect(details.instance_id).toBe(instanceId);
    expect(details.cancelled_by).toBe('op_review');
  });

  // ---------------------------------------------------------------------------
  // Regression: cancelled tasks can't be completed
  // ---------------------------------------------------------------------------

  it('regression: cancelled task returns 409 already_dispositioned on complete', async () => {
    const instanceId = await seedInstanceRow();
    const taskId = `TASK-regression-${seq}`;
    await seedPendingTask(instanceId, taskId);

    // Cancel the instance.
    await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_42' });

    // Now try to complete the cancelled task.
    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('already_dispositioned');
  });
});
