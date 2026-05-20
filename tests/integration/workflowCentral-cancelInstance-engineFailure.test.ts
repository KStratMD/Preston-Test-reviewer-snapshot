/**
 * WorkflowCentral cancelInstance — TX rollback symmetry (T12, PR-OP-3 rewrite).
 *
 * Pins R3 F-11 / F-03 post-PR-OP-3 D9+D11: the single cancel TX
 * (selectInstanceForUpdate → updateInstanceForTenant → cancelPendingForInstance)
 * commits atomically. If cancelPendingForInstance throws mid-TX, the whole TX
 * rolls back — the instance row stays at its prior status AND all pending tasks
 * remain pending. The pre-PR-OP-3 surface (a separate `engine.setInstanceStatus`
 * mutation that could succeed/fail independently from the DB, surfaced via an
 * `engine_status_applied` audit flag) is gone; engine cache refresh now happens
 * post-commit and is best-effort.
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

describe('workflow-central cancelInstance TX rollback symmetry (T12)', () => {
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
   * Post-PR-OP-3 T5 the engine no longer persists; see the matching helper in
   * tests/integration/workflowCentral-cancelInstance.test.ts.
   */
  async function seedInstanceRow(): Promise<string> {
    seq++;
    const id = `INST-engine-fail-${seq}-${Date.now()}`;
    const now = new Date().toISOString();
    const row: NewInstanceRow = {
      id,
      tenantId: TENANT_ID,
      workflowId: `WF-engine-fail-${seq}`,
      workflowName: `Engine Fail WF ${seq}`,
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
        workflow_id: 'WF-engine-fail',
        workflow_name: 'Engine Fail WF',
        step_id: 'STEP-1',
        step_name: 'Step 1',
        task_type: 'task',
        status: 'pending',
        priority: 'medium',
        assignee_id: 'alice',
        assignee_name: 'Alice',
        description: 'Engine failure test task',
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

  // ---------------------------------------------------------------------------
  // Main test: DB canonical when engine throws
  // ---------------------------------------------------------------------------

  it('R3 F-11/F-03 (PR-OP-3 rewrite): instance UPDATE + task cancel are atomic; both commit together or both roll back', async () => {
    // PR-OP-3 D9 + D11: cancelInstance runs a single TX where:
    //   selectInstanceForUpdate (lock) → updateInstanceForTenant({kind: 'cancelInstance'})
    //   → cancelPendingForInstance.
    // The old "engine.setInstanceStatusForTenant might return null / throw post-DB"
    // failure surface is gone — there's no separate engine mutation that can fail
    // independently. If any step in the TX throws, the whole TX rolls back: instance
    // row stays at its prior status AND all tasks stay pending. Post-TX, the engine
    // cache refresh is best-effort (refreshCacheFromCommit catches Map errors with a
    // WARN log); cache divergence no longer corrupts durable state.
    //
    // This test verifies the rollback symmetry: when cancelPendingForInstance throws,
    // the instance UPDATE rolls back too.
    const instanceId = await seedInstanceRow();
    const task1 = `TASK-ef1-${seq}`;
    const task2 = `TASK-ef2-${seq}`;
    await seedPendingTask(instanceId, task1);
    await seedPendingTask(instanceId, task2);

    // Stub repo.cancelPendingForInstance to throw mid-TX.
    jest
      .spyOn(WorkflowCentralRepository.prototype, 'cancelPendingForInstance')
      .mockRejectedValueOnce(new Error('simulated DB failure during task cancel'));

    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_42', reason: 'rollback symmetry test' });

    // Route bubbles the error → 500.
    expect(res.status).toBe(500);

    // Rollback symmetry: instance status should STILL be 'running' (NOT 'cancelled')
    // because the TX rolled back when cancelPendingForInstance threw.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const instanceRow = await db
      .selectFrom('workflow_central_instances')
      .select('status')
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(instanceRow.status).toBe('running');

    // Tasks should still be 'pending' (TX rollback preserves them too).
    const tasks = await db
      .selectFrom('workflow_central_tasks')
      .select(['id', 'status'])
      .where('instance_id', '=', instanceId)
      .execute();
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.status).toBe('pending');
    }
  });
});
