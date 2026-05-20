/**
 * WorkflowCentral backfill + unknown_recovered lifecycle integration tests.
 *
 * PR-OP-3 follow-up — covers T13.2 (migration 042 + catchUpBackfill) and
 * T13.3d (unknown_recovered lifecycle). T13.1 keystone restart-recovery
 * proofs already shipped at tests/integration/workflow-central-restart-recovery.test.ts.
 *
 * Spec refs: §4.2 (backfill source-of-truth rules), §4.5 (identity),
 *            D5 (no auto-transition on unknown_recovered),
 *            D19 (most-recent pending wins per-group), D20 (idempotent
 *            INSERT OR IGNORE / ON CONFLICT DO NOTHING).
 *
 * Scenarios:
 *   T-2a — Disagreeing workflow_name across tasks → migration WARNs;
 *          exactly one synth row inserted per (tenant, instance_id).
 *   T-2b — Synth row's status === 'unknown_recovered'.
 *   T-2c — Synth row's current_step_id matches the MOST RECENT PENDING
 *          task's step_id (D19) — NOT lexicographic max.
 *   T-3a — Orphan task (no instance row) + catchUpBackfill → recovered:1.
 *   T-3b — Second catchUpBackfill with no new orphans → recovered:0.
 *   T-13  — Backfilled instance retains status='unknown_recovered' after
 *           completing a task (no auto-transition per D5).
 *   T-13b — Backfill picks workflow_id from most-recent PENDING task
 *           when source rows disagree; started_at = MIN(created_at).
 *   T-13c — GET /api/workflow-central/instances?status=active includes
 *           both 'running' and 'unknown_recovered'; excludes 'completed'.
 *           Route translates the synthetic `?status=active` to
 *           statuses=['running','waiting','unknown_recovered'] (R0 fix).
 *   T-13c-guard — Malformed query params (arrays, NaN integers, empty
 *           strings on integer params) return HTTP 400 (R3+R6+R7 fixes).
 *
 * Jest config: jest.slow.config.cjs (NOT jest.ci.config.cjs).
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
import type { NewInstanceRow, TaskAction } from '../../src/services/workflowCentral/types';
import { migration as instancesTableMigration } from '../../src/database/migrations/042-create-workflow-central-instances-table';

const TENANT_ID = SYSTEM_IDENTITY.tenantId;

// ---------------------------------------------------------------------------
// Helpers (copied from workflow-central-restart-recovery.test.ts to keep
// the integration test surface self-contained per the canonical pattern).
// ---------------------------------------------------------------------------

let instanceSeq = 0;
let taskSeq = 0;

function getEngine(): WorkflowEngineService {
  return container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
}

async function getRepo(): Promise<WorkflowCentralRepository> {
  return container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
}

async function getDbService(): Promise<DatabaseService> {
  return container.getAsync<DatabaseService>(TYPES.DatabaseService);
}

/**
 * Insert a task row directly into workflow_central_tasks. Used to seed the
 * pre-state the backfill consumes — bypasses the engine entirely.
 */
async function insertTaskRow(params: {
  taskId?: string;
  instanceId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepName?: string;
  status?: 'pending' | 'completed' | 'cancelled';
  createdAt?: string;
  actions?: TaskAction[];
}): Promise<string> {
  taskSeq++;
  const taskId = params.taskId ?? `TASK-bf-${taskSeq}-${Date.now()}`;
  const createdAt = params.createdAt ?? new Date().toISOString();
  const actions: TaskAction[] = params.actions ?? [
    { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
  ];

  const dbService = await getDbService();
  await dbService
    .getDatabase()
    .insertInto('workflow_central_tasks')
    .values({
      id: taskId,
      tenant_id: TENANT_ID,
      instance_id: params.instanceId,
      workflow_id: params.workflowId,
      workflow_name: params.workflowName,
      step_id: params.stepId,
      step_name: params.stepName ?? params.stepId,
      task_type: 'task',
      status: params.status ?? 'pending',
      priority: 'medium',
      assignee_id: 'alice',
      assignee_name: 'Alice',
      description: 'Backfill seed task',
      due_at: null,
      data: '{}',
      actions: JSON.stringify(actions),
      created_at: createdAt,
      updated_at: createdAt,
      completed_at: params.status === 'completed' ? createdAt : null,
      completed_by: params.status === 'completed' ? 'seed' : null,
      completion_action_id: null,
      completion_comment: null,
    })
    .execute();

  return taskId;
}

/** Direct-insert an instance row (snake_case is what selectAll returns). */
async function seedInstanceRow(overrides: {
  id?: string;
  status?: 'running' | 'completed' | 'cancelled' | 'failed' | 'paused' | 'unknown_recovered';
  workflowId?: string;
  workflowName?: string;
  stepId?: string;
  stepName?: string;
  completedAt?: string | null;
}): Promise<NewInstanceRow> {
  instanceSeq++;
  const id = overrides.id ?? `INST-seed-${instanceSeq}-${Date.now()}`;
  const now = new Date().toISOString();

  const row: NewInstanceRow = {
    id,
    tenantId: TENANT_ID,
    workflowId: overrides.workflowId ?? `WF-seed-${instanceSeq}`,
    workflowName: overrides.workflowName ?? `Seed WF ${instanceSeq}`,
    workflowVersion: 1,
    status: overrides.status ?? 'running',
    currentStepId: overrides.stepId ?? `STEP-A-${instanceSeq}`,
    currentStepName: overrides.stepName ?? 'Step A',
    variables: {},
    stepHistory: [],
    startedBy: 'test',
    startedAt: now,
    completedAt: overrides.completedAt ?? null,
    dueAt: null,
    error: null,
    pausedFromStatus: null,
  };

  const dbService = await getDbService();
  const repo = await getRepo();
  await dbService.transaction(async (tx) => {
    await repo.insertInstance(tx, row);
  });
  return row;
}

/** Re-run migration 042 against the live DB. Idempotent by design (D20). */
async function rerunMigration042(): Promise<void> {
  const dbService = await getDbService();
  await instancesTableMigration.run(dbService.getDatabase(), dbService.getDbType());
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('workflow-central backfill + unknown_recovered lifecycle (T13.2, T13.3d)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    engine = getEngine();
    engine.hydrationReady = true;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    const dbService = await getDbService();
    const db = dbService.getDatabase();
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM workflow_central_instances`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    engine = getEngine();
    engine.hydrationReady = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // T-2a — disagreeing workflow_name across two tasks for one (tenant, instance)
  // ==========================================================================

  it('T-2a: disagreeing workflow_name across tasks → exactly one synth row + WARN log', async () => {
    const instanceId = 'INST-disagree-name';
    const workflowId = 'WF-name-conflict';

    // Two tasks for the same (tenant, instance_id) with different workflow_name.
    await insertTaskRow({
      instanceId,
      workflowId,
      workflowName: 'Old WF',
      stepId: 'STEP-OLD',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertTaskRow({
      instanceId,
      workflowId,
      workflowName: 'New WF',
      stepId: 'STEP-NEW',
      status: 'pending',
      createdAt: '2026-02-01T00:00:00.000Z',
    });

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    await rerunMigration042();

    // Migration's pre-flight should have emitted a workflow-metadata disagreement
    // WARN. (The cross-tenant probe never fires because both tasks share a tenant.)
    const disagreementWarn = warnSpy.mock.calls.find((call) => {
      const msg = String(call[0] ?? '');
      return msg.includes('workflow-metadata disagreement');
    });
    expect(disagreementWarn).toBeDefined();

    // Exactly one synth row for this (tenant, instance_id).
    const dbService = await getDbService();
    const db = dbService.getDatabase();
    const rows = await db
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .execute();
    expect(rows.length).toBe(1);
  });

  // ==========================================================================
  // T-2b — synth row has status === 'unknown_recovered'
  // ==========================================================================

  it('T-2b: backfilled synth row has status=unknown_recovered', async () => {
    const instanceId = 'INST-bf-status';
    await insertTaskRow({
      instanceId,
      workflowId: 'WF-status-test',
      workflowName: 'Status Test WF',
      stepId: 'STEP-A',
      status: 'pending',
    });

    await rerunMigration042();

    const dbService = await getDbService();
    const db = dbService.getDatabase();
    const row = await db
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row!.status).toBe('unknown_recovered');
  });

  // ==========================================================================
  // T-2c — most-recent-pending wins per D19 (NOT lexicographic max)
  // ==========================================================================

  it('T-2c: synth row.current_step_id = MOST RECENT PENDING task step (D19, not lexicographic max)', async () => {
    const instanceId = 'INST-most-recent-pending';
    const workflowId = 'WF-most-recent-pending';
    // Lexicographically: 'STEP-AAA' < 'STEP-ZZZ'. By created_at the LATER task is
    // 'STEP-AAA' so a lexicographic-max impl would pick STEP-ZZZ; D19 picks STEP-AAA.
    await insertTaskRow({
      instanceId,
      workflowId,
      workflowName: 'MRPending',
      stepId: 'STEP-ZZZ',
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await insertTaskRow({
      instanceId,
      workflowId,
      workflowName: 'MRPending',
      stepId: 'STEP-AAA',
      status: 'pending',
      createdAt: '2026-02-01T00:00:00.000Z',
    });

    await rerunMigration042();

    const dbService = await getDbService();
    const db = dbService.getDatabase();
    const row = await db
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(row.current_step_id).toBe('STEP-AAA');
  });

  // ==========================================================================
  // T-3a — runtime catchUpBackfill on an orphan task → recovered:1
  // ==========================================================================

  it('T-3a: orphan task triggers catchUpBackfill → recovered:1 with synth instance row inserted', async () => {
    // Run migration 042 first (with no tasks present) so the table exists
    // and existing rows are reconciled with the empty task set.
    await rerunMigration042();

    // Now insert an orphan task (no matching instance row).
    const instanceId = 'INST-orphan-runtime';
    await insertTaskRow({
      instanceId,
      workflowId: 'WF-orphan',
      workflowName: 'Orphan WF',
      stepId: 'STEP-ORPHAN',
      status: 'pending',
    });

    const repo = await getRepo();
    const result = await repo.catchUpBackfill();
    expect(result.recovered).toBe(1);

    const dbService = await getDbService();
    const row = await dbService
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row!.status).toBe('unknown_recovered');
    expect(row!.workflow_id).toBe('WF-orphan');
  });

  // ==========================================================================
  // T-3b — catchUpBackfill is idempotent: second call recovers 0
  // ==========================================================================

  it('T-3b: catchUpBackfill is idempotent — second call with no new orphans → recovered:0', async () => {
    await rerunMigration042();
    await insertTaskRow({
      instanceId: 'INST-idempotent',
      workflowId: 'WF-idemp',
      workflowName: 'Idemp WF',
      stepId: 'STEP-IDEMP',
      status: 'pending',
    });

    const repo = await getRepo();
    const first = await repo.catchUpBackfill();
    expect(first.recovered).toBe(1);

    const second = await repo.catchUpBackfill();
    expect(second.recovered).toBe(0);

    // Confirm no duplicate rows snuck in.
    const dbService = await getDbService();
    const rows = await dbService
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', 'INST-idempotent')
      .execute();
    expect(rows.length).toBe(1);
  });

  // ==========================================================================
  // T-13 — unknown_recovered does NOT auto-transition on completeTask (D5)
  // ==========================================================================

  it('T-13: backfilled unknown_recovered instance retains status after completing a task (no auto-transition, D5)', async () => {
    // Register a definition with one task step so the engine has something
    // to plan against; the task itself we seed directly to point at that step.
    instanceSeq++;
    const stepId = `STEP-REC-${instanceSeq}`;
    const def = engine.createDefinition({
      name: `Recovered WF ${instanceSeq}`,
      description: 'unknown_recovered lifecycle test',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps: [
        {
          id: stepId,
          name: 'Recovered Step',
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

    // Seed an orphan task that the backfill will synthesize an instance for.
    const instanceId = `INST-rec-${instanceSeq}-${Date.now()}`;
    const taskId = await insertTaskRow({
      instanceId,
      workflowId: def.id,
      workflowName: 'Recovered',
      stepId,
      stepName: 'Recovered Step',
      status: 'pending',
    });

    // Synthesize the instance row via catchUpBackfill and re-hydrate the engine
    // so the cache reflects the unknown_recovered row.
    const repo = await getRepo();
    const cu = await repo.catchUpBackfill();
    expect(cu.recovered).toBe(1);
    await engine.hydrate(repo);
    engine.hydrationReady = true;

    // Complete the task through the route.
    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'lifecycle-op' });
    expect(res.status).toBe(200);

    // Read the instance row directly from the DB. D5: completing a task on an
    // unknown_recovered instance must NOT auto-transition the status.
    const dbService = await getDbService();
    const row = await dbService
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe('unknown_recovered');
    expect(row.workflow_id).toBe(def.id);
    expect(row.workflow_name).toBe('Recovered');
  });

  // ==========================================================================
  // T-13b — backfill picks workflow_id from MOST RECENT PENDING task (D19);
  //         started_at = MIN(created_at) over the group (Codex #3 regression net).
  // ==========================================================================

  it('T-13b: backfill picks workflow_id from most-recent PENDING task; started_at = MIN(created_at) over the group', async () => {
    // Two definitions: defOld (completed task ref) and defNew (pending task ref).
    instanceSeq++;
    const defOld = engine.createDefinition({
      name: 'Old',
      description: 'old def',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps: [],
    });
    instanceSeq++;
    const defNew = engine.createDefinition({
      name: 'New',
      description: 'new def',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps: [],
    });
    engine.setDefinitionStatus(defOld.id, 'active');
    engine.setDefinitionStatus(defNew.id, 'active');

    const instanceId = 'I-DISAGREE';
    // COMPLETED task ref'ing defOld at the earlier timestamp.
    await insertTaskRow({
      instanceId,
      workflowId: defOld.id,
      workflowName: 'Old',
      stepId: 'STEP-OLD',
      status: 'completed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // PENDING task ref'ing defNew at the later timestamp.
    await insertTaskRow({
      instanceId,
      workflowId: defNew.id,
      workflowName: 'New',
      stepId: 'STEP-NEW',
      status: 'pending',
      createdAt: '2026-02-01T00:00:00.000Z',
    });

    await rerunMigration042();

    const dbService = await getDbService();
    const row = await dbService
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', TENANT_ID)
      .where('id', '=', instanceId)
      .executeTakeFirstOrThrow();

    // D19: most-recent PENDING wins for workflow_id / workflow_name / step.
    expect(row.workflow_id).toBe(defNew.id);
    expect(row.workflow_name).toBe('New');
    expect(row.current_step_id).toBe('STEP-NEW');

    // started_at = MIN(created_at) over the group → earliest task starts the instance.
    // Postgres CASTs to TIMESTAMP, SQLite stores TEXT — normalise via Date.parse.
    expect(new Date(row.started_at as string).toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  // ==========================================================================
  // T-13c — GET /api/workflow-central/instances?status=active includes both
  //         'running' AND 'unknown_recovered'; excludes 'completed'.
  //
  // The route at src/routes/workflowCentral.ts intentionally treats
  // `?status=active` as a synthetic bucket: it translates the literal
  // string into `statuses=['running', 'waiting', 'unknown_recovered']` and
  // dispatches to the multi-status repo predicate (`where('status', 'in',
  // […])`). Terminal states (`completed`, `cancelled`, `failed`) and
  // `paused` are intentionally excluded. This test pins that contract so a
  // future change to the active-bucket definition surfaces here.
  // ==========================================================================

  it('T-13c: GET /instances?status=active returns running + unknown_recovered, excludes completed', async () => {
    // Seed three instances directly.
    const running = await seedInstanceRow({ id: 'INST-active-running', status: 'running' });
    const recovered = await seedInstanceRow({
      id: 'INST-active-recovered',
      status: 'unknown_recovered',
    });
    const completed = await seedInstanceRow({
      id: 'INST-active-completed',
      status: 'completed',
      completedAt: new Date().toISOString(),
    });

    // Make sure the engine cache reflects DB so any cache-touching code path
    // does not mask the route behavior under test.
    const repo = await getRepo();
    await engine.hydrate(repo);
    engine.hydrationReady = true;

    const res = await request(app).get('/api/workflow-central/instances?status=active');
    expect(res.status).toBe(200);

    const ids = (res.body.instances as Array<{ id: string }>).map((i) => i.id);
    expect(ids).toContain(running.id);
    expect(ids).toContain(recovered.id);
    expect(ids).not.toContain(completed.id);
  });

  // ==========================================================================
  // T-13c-guard — malformed query params (Express-parsed arrays + non-integer
  //   limit/offset) MUST be rejected with HTTP 400 + code 'invalid_query_param',
  //   NOT bleed a 500 out of the repo predicate (Copilot R3 + R6 findings).
  // ==========================================================================

  it('T-13c-guard: GET /instances?status=running&status=waiting → 400 invalid_query_param', async () => {
    const res = await request(app).get(
      '/api/workflow-central/instances?status=running&status=waiting',
    );
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/must be a single string/);
  });

  it('T-13c-guard: array-valued workflowId → 400 invalid_query_param', async () => {
    const res = await request(app).get(
      '/api/workflow-central/instances?workflowId=a&workflowId=b',
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/workflowId/);
  });

  it('T-13c-guard: array-valued startedBy → 400 invalid_query_param', async () => {
    const res = await request(app).get(
      '/api/workflow-central/instances?startedBy=alice&startedBy=bob',
    );
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/startedBy/);
  });

  it('T-13c-guard: non-numeric limit → 400 (NaN would otherwise corrupt SQL binding)', async () => {
    const res = await request(app).get('/api/workflow-central/instances?limit=not-a-number');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/limit/);
  });

  it('T-13c-guard: negative offset → 400 (must be non-negative integer)', async () => {
    const res = await request(app).get('/api/workflow-central/instances?offset=-5');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/offset/);
  });

  it('T-13c-guard: array-valued limit → 400 invalid_query_param', async () => {
    const res = await request(app).get('/api/workflow-central/instances?limit=10&limit=20');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_query_param');
    expect(res.body.message).toMatch(/limit/);
  });

  it('T-13c-guard: empty limit string (`?limit=`) → treated as absent, not 0 (Copilot R7 + Codex)', async () => {
    // Regression net: `Number('')` is 0 and would silently change paging
    // semantics from "default limit" to "return zero rows". Empty / whitespace
    // strings now route through the same "param absent" path as missing.
    await seedInstanceRow({ id: 'INST-empty-limit-1', status: 'running' });
    const res = await request(app).get('/api/workflow-central/instances?limit=');
    expect(res.status).toBe(200);
    expect((res.body.instances as Array<{ id: string }>).map((i) => i.id))
      .toContain('INST-empty-limit-1');
  });

  it('T-13c-guard: whitespace-only offset (`?offset=   `) → treated as absent', async () => {
    await seedInstanceRow({ id: 'INST-empty-offset-1', status: 'running' });
    const res = await request(app).get(
      `/api/workflow-central/instances?offset=${encodeURIComponent('   ')}`,
    );
    expect(res.status).toBe(200);
    expect((res.body.instances as Array<{ id: string }>).map((i) => i.id))
      .toContain('INST-empty-offset-1');
  });
});
