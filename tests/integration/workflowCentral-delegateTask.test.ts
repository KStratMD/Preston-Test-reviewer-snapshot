/**
 * WorkflowCentral delegateTask integration tests (T12).
 *
 * End-to-end via POST /api/workflow-central/tasks/:id/delegate.
 * Uses in-memory SQLite + real DI container.
 *
 * Covers:
 *   - Happy path (atomic SELECT-then-UPDATE, previous/new assignee in audit)
 *   - Task not pending (R5 F-03 failure audit)
 *   - Task not found (R5 F-03)
 *   - Cross-tenant 404 (R6 F-01)
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
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { TaskAction } from '../../src/services/WorkflowCentralService';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

describe('workflow-central delegateTask integration (T12)', () => {
  let app: express.Express;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    // T10: readiness gate is now mounted on the router; set hydrationReady=true
    // so integration tests aren't blocked with 503 before server.start().
    // Engine is not otherwise exercised by delegate tests (repo-only path).
    container.get<WorkflowEngineService>(TYPES.WorkflowEngineService).hydrationReady = true;
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

  let seq = 0;

  async function seedTask(opts: {
    taskId: string;
    tenantId?: string;
    status?: 'pending' | 'completed' | 'cancelled';
    assigneeId?: string;
  }): Promise<void> {
    seq++;
    const now = new Date().toISOString();
    const actions: TaskAction[] = [
      { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
    ];
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: opts.taskId,
        tenant_id: opts.tenantId ?? TENANT_ID,
        instance_id: `INST-delegate-${seq}`,
        workflow_id: 'WF-delegate-test',
        workflow_name: 'Delegate WF',
        step_id: 'STEP-1',
        step_name: 'Step 1',
        task_type: 'task',
        status: opts.status ?? 'pending',
        priority: 'medium',
        assignee_id: opts.assigneeId ?? 'alice',
        assignee_name: opts.assigneeId ?? 'Alice',
        description: 'Delegate test task',
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

  async function fetchDelegateAudit() {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    return db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'workflow_central.delegate_task')
      .orderBy('created_at', 'desc')
      .execute();
  }

  // ---------------------------------------------------------------------------
  // Happy path: atomic SELECT-then-UPDATE
  // ---------------------------------------------------------------------------

  it('happy path: 200 + assignee updated + audit with previous/new assignee', async () => {
    const taskId = `TASK-delegate-happy-${Date.now()}`;
    await seedTask({ taskId, assigneeId: 'alice' });

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/delegate`)
      .send({ newAssigneeId: 'bob', newAssigneeName: 'Bob', delegatedBy: 'op_42' });

    expect(res.status).toBe(200);
    // Route returns the updated task (via WCS.delegateTask → PersistedTask).
    expect(res.body).toBeDefined();
    // Task has new assignee in DB.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const row = await db
      .selectFrom('workflow_central_tasks')
      .select(['assignee_id', 'status'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    expect(row?.assignee_id).toBe('bob');
    expect(row?.status).toBe('pending');

    const audits = await fetchDelegateAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.previous_assignee_id).toBe('alice');
    expect(details.new_assignee_id).toBe('bob');
    expect(details.delegation_result).toBe('success');
  });

  // ---------------------------------------------------------------------------
  // Task not pending → already_dispositioned failure audit (R5 F-03)
  // ---------------------------------------------------------------------------

  it('R5 F-03: 404 + failure audit with delegation_result=already_dispositioned for completed task', async () => {
    const taskId = `TASK-delegate-completed-${Date.now()}`;
    await seedTask({ taskId, status: 'completed', assigneeId: 'alice' });

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/delegate`)
      .send({ newAssigneeId: 'bob', newAssigneeName: 'Bob', delegatedBy: 'op_42' });

    // Route returns 404 when delegateTask returns null.
    expect(res.status).toBe(404);

    const audits = await fetchDelegateAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.delegation_result).toBe('already_dispositioned');
  });

  // ---------------------------------------------------------------------------
  // Task not found (R5 F-03)
  // ---------------------------------------------------------------------------

  it('R5 F-03: 404 + failure audit with delegation_result=not_found for unknown task', async () => {
    const res = await request(app)
      .post('/api/workflow-central/tasks/TASK-ghost-delegate/delegate')
      .send({ newAssigneeId: 'bob', newAssigneeName: 'Bob', delegatedBy: 'op_42' });

    expect(res.status).toBe(404);

    const audits = await fetchDelegateAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.delegation_result).toBe('not_found');
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant (R6 F-01): task seeded under a different tenant is invisible
  // ---------------------------------------------------------------------------

  it('R6 F-01: 404 when task belongs to a different tenant', async () => {
    const taskId = `TASK-delegate-tenant-${Date.now()}`;
    // Seed task under a different tenant ('other-tenant'), not SYSTEM_IDENTITY.
    await seedTask({ taskId, tenantId: 'other-tenant', assigneeId: 'alice' });

    // Unauthenticated request → SYSTEM_IDENTITY → TENANT_ID = '__system__'.
    // Task under 'other-tenant' should be invisible.
    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/delegate`)
      .send({ newAssigneeId: 'bob', newAssigneeName: 'Bob', delegatedBy: 'op_42' });

    expect(res.status).toBe(404);

    // Task row under other-tenant must NOT be modified.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const row = await db
      .selectFrom('workflow_central_tasks')
      .select(['assignee_id', 'tenant_id'])
      .where('id', '=', taskId)
      .executeTakeFirst();
    expect(row?.assignee_id).toBe('alice'); // unchanged
    expect(row?.tenant_id).toBe('other-tenant');

    const audits = await fetchDelegateAudit();
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.delegation_result).toBe('not_found');
  });

});
