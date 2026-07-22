/**
 * WorkflowCentral completeTask integration tests (T12).
 *
 * End-to-end via POST /api/workflow-central/tasks/:id/complete.
 * Uses in-memory SQLite + real DI container.
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
import { WorkflowCentralRepository } from '../../src/services/workflowCentral/WorkflowCentralRepository';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { NewTaskRow } from '../../src/services/workflowCentral/types';
import type { TaskAction } from '../../src/services/WorkflowCentralService';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

describe('workflow-central completeTask integration (T12)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    // Copilot R12 SHOULD-FIX: repo was only used to reach into the private
    // db field via cast. Removed since the test helpers use the DI
    // container's DatabaseService directly now.
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
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let taskSeq = 0;

  /** Seed a definition + instance in the engine and a pending task row in the DB. */
  async function seedTaskWithEngine(overrides: {
    taskId?: string;
    actions?: TaskAction[];
    status?: 'pending' | 'completed' | 'cancelled';
  } = {}): Promise<{ taskId: string; instanceId: string; workflowId: string }> {
    taskSeq++;
    const taskId = overrides.taskId ?? `TASK-test-${taskSeq}-${Math.random().toString(36).slice(2, 6)}`;

    // Seed a definition with a 2-step workflow (task → task).
    const def = engine.createDefinition({
      name: `Test WF ${taskSeq}`,
      description: 'Integration test definition',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps: [
        {
          id: 'STEP-A',
          name: 'Step A',
          type: 'task',
          order: 1,
          config: { taskType: 'review', assigneeType: 'user', assigneeValue: 'alice' },
          transitions: [{ id: 'T-A', targetStepId: 'STEP-B', isDefault: true }],
          timeoutHours: null,
          retryPolicy: null,
        },
        {
          id: 'STEP-B',
          name: 'Step B',
          type: 'task',
          order: 2,
          config: { taskType: 'review', assigneeType: 'user', assigneeValue: 'bob' },
          transitions: [],
          timeoutHours: null,
          retryPolicy: null,
        },
      ],
    });

    // Copilot R12 SHOULD-FIX: publish the definition so the engine treats it
    // as active. Uses public `engine.setDefinitionStatus(id, 'active')`
    // helper instead of reaching into the private `definitions` Map via
    // an unsafe cast.
    engine.setDefinitionStatus(def.id, 'active');

    const instance = engine.createInstance(TENANT_ID, def.id, {}, 'test-operator');

    // PR-OP-3 D10: createInstance is ephemeral — DB row must be persisted
    // separately so selectInstanceForUpdate (in completeTask) finds it.
    const dbForInstance = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const nowSeed = new Date().toISOString();
    await dbForInstance
      .insertInto('workflow_central_instances')
      .values({
        id: instance.id,
        tenant_id: TENANT_ID,
        workflow_id: def.id,
        workflow_name: def.name,
        workflow_version: instance.workflowVersion ?? 1,
        status: instance.status,
        current_step_id: instance.currentStepId,
        current_step_name: instance.currentStepName,
        variables: JSON.stringify(instance.variables ?? {}),
        step_history: JSON.stringify(instance.stepHistory ?? []),
        started_by: instance.startedBy,
        started_at: instance.startedAt,
        completed_at: instance.completedAt,
        due_at: instance.dueAt,
        error: instance.error,
        paused_from_status: null,
        created_at: nowSeed,
        updated_at: nowSeed,
      })
      .execute();

    const actions: TaskAction[] = overrides.actions ?? [
      { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
    ];

    const now = new Date().toISOString();
    const row: NewTaskRow = {
      id: taskId,
      tenantId: TENANT_ID,
      instanceId: instance.id,
      workflowId: def.id,
      workflowName: def.name,
      stepId: 'STEP-A',
      stepName: 'Step A',
      taskType: 'task',
      status: overrides.status ?? 'pending',
      priority: 'medium',
      assigneeId: 'alice',
      assigneeName: 'Alice',
      description: 'Step A task',
      dueAt: null,
      data: {},
      actions,
      createdAt: now,
      updatedAt: now,
    };

    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    // Copilot R12 SHOULD-FIX: previously cast `repo as unknown as { db: ... }`
    // to reach the private db field, even though we already have `db` from
    // the line above. Use the local `db` handle directly.
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        instance_id: row.instanceId,
        workflow_id: row.workflowId,
        workflow_name: row.workflowName,
        step_id: row.stepId,
        step_name: row.stepName,
        task_type: row.taskType,
        status: row.status,
        priority: row.priority,
        assignee_id: row.assigneeId,
        assignee_name: row.assigneeName,
        description: row.description,
        due_at: row.dueAt,
        data: JSON.stringify(row.data),
        actions: JSON.stringify(row.actions),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
      })
      .execute();
    void db;

    return { taskId, instanceId: instance.id, workflowId: def.id };
  }

  /** Seed a pending task + instance row whose WORKFLOW DEFINITION is NOT registered in the engine.
   * Post-PR-OP-3, `workflowDefinitionMissing` is triggered only when `engine.getDefinition(workflow_id)`
   * returns null — the instance row must exist in the DB or selectInstanceForUpdate throws first. */
  async function seedOrphanTask(taskId?: string): Promise<string> {
    taskSeq++;
    const id = taskId ?? `TASK-orphan-${taskSeq}`;
    const instanceId = `INST-orphan-${taskSeq}`;
    const workflowId = `WF-unregistered-${taskSeq}`;
    const now = new Date().toISOString();

    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    // Persist the instance row so selectInstanceForUpdate finds it. The workflow_id
    // intentionally does NOT match any engine.createDefinition call — engine.getDefinition
    // returns null → operator returns kind='definition_missing' → 200 + workflowDefinitionMissing:true.
    await db
      .insertInto('workflow_central_instances')
      .values({
        id: instanceId,
        tenant_id: TENANT_ID,
        workflow_id: workflowId,
        workflow_name: 'Orphan WF',
        workflow_version: 1,
        status: 'running',
        current_step_id: 'STEP-X',
        current_step_name: 'Step X',
        variables: '{}',
        step_history: '[]',
        started_by: 'test-operator',
        started_at: now,
        completed_at: null,
        due_at: null,
        error: null,
        paused_from_status: null,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id,
        tenant_id: TENANT_ID,
        instance_id: instanceId,
        workflow_id: workflowId,
        workflow_name: 'Orphan WF',
        step_id: 'STEP-X',
        step_name: 'Step X',
        task_type: 'task',
        status: 'pending',
        priority: 'low',
        assignee_id: 'nobody',
        assignee_name: 'Nobody',
        description: 'Orphan task',
        due_at: null,
        data: '{}',
        actions: JSON.stringify([
          { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
        ]),
        created_at: now,
        updated_at: now,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
      })
      .execute();
    return id;
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
  // Happy path with cascade
  // ---------------------------------------------------------------------------

  it('happy path: 200 + task completed + downstream task inserted + audit success', async () => {
    const { taskId, instanceId } = await seedTaskWithEngine();

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.code).toBe('ok');
    expect(res.body.task.status).toBe('completed');
    expect(Array.isArray(res.body.downstreamTaskIds)).toBe(true);

    // Downstream task row exists in DB.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    for (const childId of res.body.downstreamTaskIds as string[]) {
      const child = await db
        .selectFrom('workflow_central_tasks')
        .select(['id', 'status', 'instance_id'])
        .where('id', '=', childId)
        .executeTakeFirst();
      expect(child).toBeDefined();
      expect(child!.status).toBe('pending');
      expect(child!.instance_id).toBe(instanceId);
    }

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(Array.isArray(details.downstream_task_ids)).toBe(true);
    expect(details.downstream_task_ids).toEqual(res.body.downstreamTaskIds);
  });

  // ---------------------------------------------------------------------------
  // not_found
  // ---------------------------------------------------------------------------

  it('404 not_found when taskId does not exist', async () => {
    const res = await request(app)
      .post('/api/workflow-central/tasks/TASK-ghost/complete')
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('not_found');

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.completion_result).toBe('not_found');
  });

  // ---------------------------------------------------------------------------
  // already_dispositioned
  // ---------------------------------------------------------------------------

  it('409 already_dispositioned when task is already completed', async () => {
    const { taskId } = await seedTaskWithEngine({ status: 'completed' });

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(409);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('already_dispositioned');
  });

  // ---------------------------------------------------------------------------
  // invalid_action
  // ---------------------------------------------------------------------------

  it('400 invalid_action when actionId is not in task.actions', async () => {
    const { taskId } = await seedTaskWithEngine({
      actions: [{ id: 'approve', label: 'Approve', type: 'approve', requiresComment: false }],
    });

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'unknown', completedBy: 'op_42' });

    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('invalid_action');

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.completion_result).toBe('invalid_action');
  });

  // ---------------------------------------------------------------------------
  // cascade_failed
  // ---------------------------------------------------------------------------

  it('500 cascade_failed when DB throws during atomic cascade', async () => {
    const { taskId } = await seedTaskWithEngine();

    // Stub completeTaskAtomicWithCascade to throw a DB error.
    jest
      .spyOn(WorkflowCentralRepository.prototype, 'completeTaskAtomicWithCascade')
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: workflow_central_tasks.id'));

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('cascade_failed');
    expect(typeof res.body.cause).toBe('string');

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.completion_result).toBe('cascade_failed');
  });

  // ---------------------------------------------------------------------------
  // workflow_definition_missing
  // ---------------------------------------------------------------------------

  it('200 workflowDefinitionMissing:true when instance not found in engine', async () => {
    // Seed a task whose instanceId does not exist in the engine.
    const taskId = await seedOrphanTask();

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_42' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workflowDefinitionMissing).toBe(true);

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.workflow_definition_missing).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // volatile_state_applied — removed (T2: DB-canonical cascade is atomic;
  // applyVolatileState step dropped from completeTask)
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Body validation (4 sub-tests)
  // ---------------------------------------------------------------------------

  describe('body validation', () => {
    it('400 invalid_request_body when actionId is missing', async () => {
      const { taskId } = await seedTaskWithEngine();
      const res = await request(app)
        .post(`/api/workflow-central/tasks/${taskId}/complete`)
        .send({ completedBy: 'op_42' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request_body');
    });

    it('400 invalid_request_body when actionId is empty string', async () => {
      const { taskId } = await seedTaskWithEngine();
      const res = await request(app)
        .post(`/api/workflow-central/tasks/${taskId}/complete`)
        .send({ actionId: '', completedBy: 'op_42' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request_body');
    });

    it('400 invalid_request_body when completedBy is missing', async () => {
      const { taskId } = await seedTaskWithEngine();
      const res = await request(app)
        .post(`/api/workflow-central/tasks/${taskId}/complete`)
        .send({ actionId: 'complete' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request_body');
    });

    it('400 invalid_request_body when data is an array', async () => {
      const { taskId } = await seedTaskWithEngine();
      const res = await request(app)
        .post(`/api/workflow-central/tasks/${taskId}/complete`)
        .send({ actionId: 'complete', completedBy: 'op_42', data: [1, 2, 3] });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_request_body');
    });
  });

  // ---------------------------------------------------------------------------
  // DLP key absence (audit strips user-supplied keys; DB row retains value)
  // ---------------------------------------------------------------------------

  it('DLP: audit details must NOT contain comment/data/completion_comment keys', async () => {
    const { taskId } = await seedTaskWithEngine();

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({
        actionId: 'complete',
        completedBy: 'op_42',
        comment: 'sk-secret-value',
        data: { api_key: 'sk-supersecret' },
      });

    expect(res.status).toBe(200);

    const audits = await fetchAudit('workflow_central.complete_task');
    expect(audits).toHaveLength(1);
    const details = JSON.parse(audits[0].details as unknown as string);

    // Audit must NOT expose user-supplied sensitive fields (spec R1 F-14 / R2 F-08).
    expect(details).not.toHaveProperty('comment');
    expect(details).not.toHaveProperty('data');
    expect(details).not.toHaveProperty('completion_comment');

    // Task row DOES persist the comment (trust-internal-data policy).
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const row = await db
      .selectFrom('workflow_central_tasks')
      .select(['completion_comment'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    expect(row?.completion_comment).toBe('sk-secret-value');
  });
});
