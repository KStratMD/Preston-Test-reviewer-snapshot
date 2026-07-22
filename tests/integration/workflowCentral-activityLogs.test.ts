/**
 * PR-OP-3b — workflow-central activity-log durability integration tests.
 *
 * Covers end-to-end:
 *   - Each of the six audit-emitting verbs produces an activity row with the
 *     expected shape (action, instanceId, workflowName, stepName, details).
 *   - Read API tenant scoping (no cross-tenant leak).
 *   - GET /activity route happy path + query-shape defenses (400 on bad limit).
 *   - GET /activity?instanceId= filter.
 *
 * Spec: docs/plans/2026-05-18-workflow-central-activity-logs-durability-spec.md
 * Pattern source: tests/integration/workflowCentral-pauseResume.test.ts
 *
 * Jest config: jest.slow.config.cjs.
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
import { WorkflowCentralService } from '../../src/services/WorkflowCentralService';
import { WorkflowCentralOperatorService } from '../../src/services/workflowCentral/WorkflowCentralOperatorService';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { NewInstanceRow, NewTaskRow } from '../../src/services/workflowCentral/types';

const TENANT_ID = SYSTEM_IDENTITY.tenantId;
const TENANT_B = '__system_b__'; // distinct tenant for cross-tenant tests

let seq = 0;

async function getRepo(): Promise<WorkflowCentralRepository> {
  return container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
}

async function getDbService(): Promise<DatabaseService> {
  return container.getAsync<DatabaseService>(TYPES.DatabaseService);
}

async function getService(): Promise<WorkflowCentralService> {
  return container.getAsync<WorkflowCentralService>(TYPES.WorkflowCentralService);
}

async function getOperator(): Promise<WorkflowCentralOperatorService> {
  return container.getAsync<WorkflowCentralOperatorService>(TYPES.WorkflowCentralOperatorService);
}

function createActiveDefinition(engine: WorkflowEngineService): string {
  seq++;
  const def = engine.createDefinition({
    name: `Activity WF ${seq}`,
    description: 'Activity-log integration test',
    category: 'test',
    triggerType: 'manual',
    createdBy: 'test',
    steps: [
      {
        id: `STEP-A-${seq}`,
        name: 'Step A',
        type: 'task',
        order: 1,
        config: { taskType: 'review', assigneeType: 'user', assigneeValue: 'alice' },
        transitions: [],
        timeoutHours: null,
        retryPolicy: null,
      },
    ],
  });
  engine.setDefinitionStatus(def.id, 'active');
  return def.id;
}

async function seedInstanceRow(overrides: {
  tenantId?: string;
  status?: NewInstanceRow['status'];
  pausedFromStatus?: NewInstanceRow['pausedFromStatus'];
}): Promise<NewInstanceRow> {
  seq++;
  const id = `INST-seed-${seq}-${Date.now()}`;
  const now = new Date().toISOString();
  const row: NewInstanceRow = {
    id,
    tenantId: overrides.tenantId ?? TENANT_ID,
    workflowId: `WF-seed-${seq}`,
    workflowName: `Seed WF ${seq}`,
    workflowVersion: 1,
    status: overrides.status ?? 'running',
    currentStepId: `STEP-A-${seq}`,
    currentStepName: 'Step A',
    variables: {},
    stepHistory: [],
    startedBy: 'test',
    startedAt: now,
    completedAt: null,
    dueAt: null,
    error: null,
    pausedFromStatus: overrides.pausedFromStatus ?? null,
  };
  const dbService = await getDbService();
  const repo = await getRepo();
  await dbService.transaction(async (tx) => {
    await repo.insertInstance(tx, row);
  });
  return row;
}

async function seedTaskRow(opts: {
  tenantId?: string;
  instanceId: string;
  workflowId: string;
  workflowName: string;
}): Promise<NewTaskRow> {
  seq++;
  const now = new Date().toISOString();
  const row: NewTaskRow = {
    id: `TASK-seed-${seq}-${Date.now()}`,
    tenantId: opts.tenantId ?? TENANT_ID,
    instanceId: opts.instanceId,
    workflowId: opts.workflowId,
    workflowName: opts.workflowName,
    stepId: `STEP-A-${seq}`,
    stepName: 'Step A',
    taskType: 'approval',
    status: 'pending',
    priority: 'medium',
    assigneeId: 'alice',
    assigneeName: 'Alice',
    description: 'review',
    dueAt: null,
    data: {},
    actions: [{ id: 'approve', label: 'Approve', type: 'approve', requiresComment: false }],
    createdAt: now,
    updatedAt: now,
  };
  const dbService = await getDbService();
  const repo = await getRepo();
  await dbService.transaction(async (tx) => {
    await repo.insertTask(tx, row);
  });
  return row;
}

async function readActivityRows(tenantId: string) {
  const dbService = await getDbService();
  const db = dbService.getDatabase();
  return db
    .selectFrom('workflow_central_activity_logs')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .orderBy('timestamp', 'desc')
    .execute();
}

function parseDetails(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  return {};
}

describe('workflow-central activity-log durability integration (PR-OP-3b)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    engine.hydrationReady = true;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    const dbService = await getDbService();
    const db = dbService.getDatabase();
    await sql`DELETE FROM workflow_central_activity_logs`.execute(db);
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM workflow_central_instances`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    engine.hydrationReady = true;
  });

  // -------------------------------------------------------------------------
  // Write-site coverage — each verb produces exactly one activity row.
  // -------------------------------------------------------------------------

  describe('write-site activity rows', () => {
    it('startInstance produces an instance_started row', async () => {
      const workflowId = createActiveDefinition(engine);
      const service = await getService();
      await service.startInstance({
        tenantId: TENANT_ID,
        workflowId,
        startedBy: 'alice',
      });
      const rows = await readActivityRows(TENANT_ID);
      const started = rows.filter((r) => r.action === 'instance_started');
      expect(started).toHaveLength(1);
      expect(started[0].user_id).toBe('alice');
      expect(started[0].step_name).toBeNull();
      expect(parseDetails(started[0].details)).toMatchObject({
        workflow_id: workflowId,
        started_by: 'alice',
      });
    });

    it('cancelInstance produces an instance_cancelled row (reason redacted from details)', async () => {
      const seeded = await seedInstanceRow({ status: 'running' });
      const service = await getService();
      await service.cancelInstance(TENANT_ID, seeded.id, 'alice', 'sensitive reason');
      const rows = await readActivityRows(TENANT_ID);
      const cancelled = rows.filter((r) => r.action === 'instance_cancelled');
      expect(cancelled).toHaveLength(1);
      expect(cancelled[0].instance_id).toBe(seeded.id);
      expect(cancelled[0].user_id).toBe('alice');
      const details = parseDetails(cancelled[0].details);
      expect(details.cancelled_by).toBe('alice');
      expect(details.reason_supplied).toBe(true);
      // No leaked reason in activity details (DLP carve-out).
      expect(JSON.stringify(details)).not.toContain('sensitive reason');
    });

    it('pauseInstance produces an instance_paused row', async () => {
      const seeded = await seedInstanceRow({ status: 'running' });
      const service = await getService();
      await service.pauseInstance(TENANT_ID, seeded.id);
      const rows = await readActivityRows(TENANT_ID);
      const paused = rows.filter((r) => r.action === 'instance_paused');
      expect(paused).toHaveLength(1);
      expect(paused[0].instance_id).toBe(seeded.id);
      expect(parseDetails(paused[0].details)).toMatchObject({
        previous_status: 'running',
      });
    });

    it('resumeInstance produces an instance_resumed row restoring pre-pause status', async () => {
      const seeded = await seedInstanceRow({
        status: 'paused',
        pausedFromStatus: 'waiting',
      });
      const service = await getService();
      await service.resumeInstance(TENANT_ID, seeded.id);
      const rows = await readActivityRows(TENANT_ID);
      const resumed = rows.filter((r) => r.action === 'instance_resumed');
      expect(resumed).toHaveLength(1);
      expect(parseDetails(resumed[0].details)).toMatchObject({
        previous_status: 'paused',
        resumed_to_status: 'waiting',
      });
    });

    it('delegateTask produces a task_delegated row', async () => {
      const inst = await seedInstanceRow({ status: 'running' });
      const task = await seedTaskRow({
        instanceId: inst.id,
        workflowId: inst.workflowId,
        workflowName: inst.workflowName,
      });
      const service = await getService();
      await service.delegateTask(TENANT_ID, task.id, 'bob', 'Bob', 'alice');
      const rows = await readActivityRows(TENANT_ID);
      const delegated = rows.filter((r) => r.action === 'task_delegated');
      expect(delegated).toHaveLength(1);
      expect(delegated[0].user_id).toBe('alice');
      expect(parseDetails(delegated[0].details)).toMatchObject({
        task_id: task.id,
        previous_assignee_id: 'alice',
        new_assignee_id: 'bob',
      });
    });

    it('completeTask produces a task_completed row', async () => {
      const workflowId = createActiveDefinition(engine);
      const service = await getService();
      const started = await service.startInstance({
        tenantId: TENANT_ID,
        workflowId,
        startedBy: 'alice',
      });
      expect(started).not.toBeNull();
      expect(started!.initialTaskId).not.toBeNull();
      const { instanceId, initialTaskId } = started!;
      // Clear the start activity so we can isolate the complete row.
      const dbService = await getDbService();
      await sql`DELETE FROM workflow_central_activity_logs`.execute(dbService.getDatabase());

      // Look up the actual actionId the engine generated for this task —
      // workflow definitions in this test fixture default to a single
      // `complete` action, not `approve`.
      const repo = await getRepo();
      const task = await repo.getById(TENANT_ID, initialTaskId!);
      const firstActionId = task!.actions[0].id;

      const operator = await getOperator();
      const result = await operator.completeTask({
        tenantId: TENANT_ID,
        taskId: initialTaskId!,
        completion: {
          actionId: firstActionId,
          completedBy: 'alice',
        },
      });
      expect(result.ok).toBe(true);

      const rows = await readActivityRows(TENANT_ID);
      const completed = rows.filter((r) => r.action === 'task_completed');
      expect(completed).toHaveLength(1);
      expect(completed[0].instance_id).toBe(instanceId);
      expect(completed[0].user_id).toBe('alice');
      expect(parseDetails(completed[0].details)).toMatchObject({
        task_id: initialTaskId,
        action_id: firstActionId,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Cross-tenant isolation.
  // -------------------------------------------------------------------------

  describe('cross-tenant isolation', () => {
    it("tenant A's activity does not appear in tenant B's reads", async () => {
      const instA = await seedInstanceRow({ tenantId: TENANT_ID, status: 'running' });
      const instB = await seedInstanceRow({ tenantId: TENANT_B, status: 'running' });
      const service = await getService();
      await service.pauseInstance(TENANT_ID, instA.id);
      await service.pauseInstance(TENANT_B, instB.id);

      const outA = await service.getRecentActivity(TENANT_ID);
      const outB = await service.getRecentActivity(TENANT_B);
      expect(outA.every((r) => r.instanceId === instA.id)).toBe(true);
      expect(outB.every((r) => r.instanceId === instB.id)).toBe(true);
      // And the row counts equal exactly one each.
      expect(outA).toHaveLength(1);
      expect(outB).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // GET /activity route surface.
  // -------------------------------------------------------------------------

  describe('GET /api/workflow-central/activity', () => {
    it('returns 200 with tenant-scoped rows after a verb has run', async () => {
      const inst = await seedInstanceRow({ status: 'running' });
      const service = await getService();
      await service.pauseInstance(TENANT_ID, inst.id);
      const res = await request(app).get('/api/workflow-central/activity');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body.length).toBe(1);
      expect(res.body[0].action).toBe('instance_paused');
    });

    it('clamps limit to default when omitted', async () => {
      for (let i = 0; i < 12; i++) {
        const inst = await seedInstanceRow({ status: 'running' });
        const service = await getService();
        await service.pauseInstance(TENANT_ID, inst.id);
      }
      const res = await request(app).get('/api/workflow-central/activity');
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(10);
    });

    it('honors an explicit limit in range', async () => {
      for (let i = 0; i < 5; i++) {
        const inst = await seedInstanceRow({ status: 'running' });
        const service = await getService();
        await service.pauseInstance(TENANT_ID, inst.id);
      }
      const res = await request(app).get('/api/workflow-central/activity?limit=3');
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(3);
    });

    it.each(['abc', '0', '-1', '101', '1.5', ''])(
      'returns 400 invalid_limit for limit=%p',
      async (bad) => {
        const res = await request(app).get(`/api/workflow-central/activity?limit=${encodeURIComponent(bad)}`);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe('invalid_limit');
      },
    );

    it('returns 400 invalid_limit when limit is array-shaped', async () => {
      const res = await request(app).get('/api/workflow-central/activity?limit=1&limit=2');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_limit');
    });

    it('narrows by instanceId when supplied', async () => {
      const instA = await seedInstanceRow({ status: 'running' });
      const instB = await seedInstanceRow({ status: 'running' });
      const service = await getService();
      await service.pauseInstance(TENANT_ID, instA.id);
      await service.pauseInstance(TENANT_ID, instB.id);
      const res = await request(app).get(`/api/workflow-central/activity?instanceId=${instA.id}`);
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
      expect(res.body[0].instanceId).toBe(instA.id);
    });

    // Copilot R4: invalid_instance_id branch was untested; regression net
    // ensures the new typed error mapper stays exercised.
    it('returns 400 invalid_instance_id when instanceId is array-shaped', async () => {
      const res = await request(app).get('/api/workflow-central/activity?instanceId=a&instanceId=b');
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('invalid_instance_id');
      // Message should surface the array shape (Copilot R4 message-fidelity fix).
      expect(res.body.message).toMatch(/array\(length=2\)/);
    });

    it('returns 200 with no narrowing when instanceId is empty string (treated as no filter)', async () => {
      const inst = await seedInstanceRow({ status: 'running' });
      const service = await getService();
      await service.pauseInstance(TENANT_ID, inst.id);
      const res = await request(app).get('/api/workflow-central/activity?instanceId=');
      expect(res.status).toBe(200);
      expect(res.body.length).toBe(1);
    });
  });
});
