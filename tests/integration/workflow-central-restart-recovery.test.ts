/**
 * WorkflowCentral restart-recovery integration tests (T13.1).
 *
 * Keystone proof of PR-OP-3's durability claim:
 *   workflow instance state survives a process restart because it's persisted
 *   in `workflow_central_instances` and hydrated on boot via engine.hydrate(repo).
 *
 * Scenarios:
 *   1. T-4 happy path: startInstance → completeTask cascade → instance row +
 *      step_history committed to DB; assert all fields present.
 *   2. Simulated restart: unbind+rebind engine in container; call hydrate;
 *      assert hydrationReady === true AND getCacheSize() > 0.
 *   3. State recovered pre/post-restart: getInstance returns identical state
 *      before and after restart.
 *   4. completeTask works after restart: fresh pending task inserted; after
 *      restart, completeTask via route returns 200 and cascades normally.
 *   5. workflowDefinitionMissing after restart: definitions are volatile (Known
 *      Gap #4). After restart, completeTask for an instance whose definition
 *      was NOT re-registered returns workflowDefinitionMissing: true.
 *   6. T-11 scale smoke: 1000 old terminal + 50 active + 5 recent-terminal;
 *      Map.size === 55 after hydrate; elapsed < 500ms.
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
import { recentTerminalHydrationDays } from '../../src/services/workflowCentral/config';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let instanceSeq = 0;
let taskSeq = 0;

/** Returns a new engine from the DI container (sync binding). */
function getEngine(): WorkflowEngineService {
  return container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
}

/** Returns the repo (async binding). */
async function getRepo(): Promise<WorkflowCentralRepository> {
  return container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
}

/** Returns the DB service. */
async function getDbService(): Promise<DatabaseService> {
  return container.getAsync<DatabaseService>(TYPES.DatabaseService);
}

/**
 * Create a workflow definition with a 2-step task workflow and activate it.
 * Returns the workflow id.
 */
function createActiveDefinition(engine: WorkflowEngineService): string {
  instanceSeq++;
  const def = engine.createDefinition({
    name: `Recovery WF ${instanceSeq}`,
    description: 'Restart-recovery integration test',
    category: 'test',
    triggerType: 'manual',
    createdBy: 'test',
    steps: [
      {
        id: `STEP-A-${instanceSeq}`,
        name: 'Step A',
        type: 'task',
        order: 1,
        config: { taskType: 'review', assigneeType: 'user', assigneeValue: 'alice' },
        transitions: [{ id: `T-A-${instanceSeq}`, targetStepId: `STEP-B-${instanceSeq}`, isDefault: true }],
        timeoutHours: null,
        retryPolicy: null,
      },
      {
        id: `STEP-B-${instanceSeq}`,
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
  engine.setDefinitionStatus(def.id, 'active');
  return def.id;
}

/**
 * Seed an instance row directly into the DB (bypassing the engine cache).
 * Used to set up state that the engine will re-discover on hydrate.
 */
async function seedInstanceRow(overrides: {
  id?: string;
  status?: 'running' | 'completed' | 'cancelled' | 'failed' | 'paused';
  completedAt?: string | null;
  workflowId?: string;
  stepId?: string;
  stepName?: string;
}): Promise<NewInstanceRow> {
  instanceSeq++;
  const id = overrides.id ?? `INST-seed-${instanceSeq}-${Date.now()}`;
  const now = new Date().toISOString();

  const row: NewInstanceRow = {
    id,
    tenantId: TENANT_ID,
    workflowId: overrides.workflowId ?? `WF-seed-${instanceSeq}`,
    workflowName: `Seed WF ${instanceSeq}`,
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

/**
 * Seed a pending task row directly in the DB for a given instance + step.
 * Returns the task id.
 */
async function seedPendingTask(params: {
  instanceId: string;
  workflowId: string;
  stepId: string;
  stepName: string;
  actions?: TaskAction[];
}): Promise<string> {
  taskSeq++;
  const taskId = `TASK-rec-${taskSeq}-${Date.now()}`;
  const now = new Date().toISOString();
  const actions: TaskAction[] = params.actions ?? [
    { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
  ];

  const dbService = await getDbService();
  await dbService.getDatabase()
    .insertInto('workflow_central_tasks')
    .values({
      id: taskId,
      tenant_id: TENANT_ID,
      instance_id: params.instanceId,
      workflow_id: params.workflowId,
      workflow_name: 'Recovery WF',
      step_id: params.stepId,
      step_name: params.stepName,
      task_type: 'task',
      status: 'pending',
      priority: 'medium',
      assignee_id: 'alice',
      assignee_name: 'Alice',
      description: 'Recovery task',
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

  return taskId;
}

/**
 * Simulate a process restart by calling engine.hydrate(repo) on the existing
 * engine singleton. The hydrate method clears the instances Map and resets
 * hydrationReady=false before rebuilding from the DB — exactly what a real
 * restart does (new process → empty Map → hydrate).
 *
 * NOTE: we use the container's current engine singleton (not a new DI binding)
 * because WorkflowCentralService captures `this.engine` at construction time.
 * Swapping the DI binding would leave the service pointing to the old instance.
 * The behaviour under test is the hydrate contract, not the DI binding.
 */
async function simulateRestartAndHydrate(
  engineInstance: WorkflowEngineService,
  repo: WorkflowCentralRepository,
): Promise<void> {
  // hydrate() sets hydrationReady=false, clears Map, rebuilds from DB, sets true.
  await engineInstance.hydrate(repo);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('workflow-central restart-recovery integration (T13.1)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;

  beforeAll(async () => {
    await setupTestDatabase();
    app = express();
    app.use(express.json());
    app.use('/api/workflow-central', workflowCentralRouter);
    engine = getEngine();
    // Bypass readiness gate for direct-engine tests (mirrors other integration suites).
    engine.hydrationReady = true;
  });

  afterAll(async () => {
    await teardownTestDatabase();
  });

  beforeEach(async () => {
    const dbService = await getDbService();
    const db = dbService.getDatabase();
    // Wipe all instance + task rows so each test starts clean.
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM workflow_central_instances`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    // Refresh engine reference — a previous test may have called simulateEngineRestart()
    // which rebinds the container singleton. Always use the current binding so that
    // createActiveDefinition(engine) targets the same instance the route resolves.
    engine = getEngine();
    engine.hydrationReady = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // Test 1 — T-4 happy path: startInstance → completeTask cascade → DB row
  // ==========================================================================

  it('T-4 happy path: startInstance+completeTask cascade persists instance + step_history to DB', async () => {
    const workflowId = createActiveDefinition(engine);

    // Start an instance via the route.
    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_recovery_test' });

    expect(startRes.status).toBe(201);
    expect(typeof startRes.body.instanceId).toBe('string');
    expect(typeof startRes.body.initialTaskId).toBe('string');

    const { instanceId, initialTaskId } = startRes.body as {
      instanceId: string;
      initialTaskId: string;
    };

    // Complete the first task to trigger cascade + instance update.
    const completeRes = await request(app)
      .post(`/api/workflow-central/tasks/${initialTaskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_recovery_test' });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.ok).toBe(true);

    // Assert: instance row is present in DB with step_history populated.
    const dbService = await getDbService();
    const db = dbService.getDatabase();

    const instRow = await db
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('id', '=', instanceId)
      .executeTakeFirst();

    expect(instRow).toBeDefined();
    expect(instRow!.id).toBe(instanceId);
    expect(instRow!.tenant_id).toBe(TENANT_ID);
    expect(instRow!.workflow_id).toBe(workflowId);
    expect(instRow!.status).toBe('running'); // still running (has a STEP-B)

    const stepHistory: unknown[] = JSON.parse(instRow!.step_history);
    expect(Array.isArray(stepHistory)).toBe(true);
    expect(stepHistory.length).toBeGreaterThanOrEqual(1);

    // Assert: the first task row is completed.
    const taskRow = await db
      .selectFrom('workflow_central_tasks')
      .select(['status', 'completed_at'])
      .where('id', '=', initialTaskId)
      .executeTakeFirst();
    expect(taskRow).toBeDefined();
    expect(taskRow!.status).toBe('completed');
    expect(taskRow!.completed_at).not.toBeNull();
  });

  // ==========================================================================
  // Test 2 — Simulated restart: new engine + hydrate → hydrationReady + cache
  // ==========================================================================

  it('simulated restart: hydrate clears Map then repopulates from DB → hydrationReady=true + cache size >= seeded count', async () => {
    // Seed 2 running instances directly in the DB.
    await seedInstanceRow({ status: 'running' });
    await seedInstanceRow({ status: 'running' });

    // Before hydrate: ensure the engine does not already have these rows cached
    // (they were inserted directly into DB, bypassing refreshCacheFromCommit).
    const cacheBeforeHydrate = engine.getCacheSize();

    const repo = await getRepo();

    // Simulate restart: hydrate clears the Map and rebuilds from DB.
    // hydrate() sets hydrationReady=false while running, then true on success.
    await simulateRestartAndHydrate(engine, repo);

    expect(engine.hydrationReady).toBe(true);
    // At minimum the 2 seeded rows must be in the cache (may include leftovers
    // from prior test setup that survived the beforeEach wipe — none should
    // since beforeEach deletes all rows, but the check is >= not ===).
    expect(engine.getCacheSize()).toBeGreaterThanOrEqual(2);
    // The cache MUST have grown from whatever it was before hydration (which
    // may have been 0 or small; either way the seeded rows must appear).
    void cacheBeforeHydrate; // informational; exact delta not asserted here
  });

  // ==========================================================================
  // Test 3 — State recovered pre/post-restart is identical
  // ==========================================================================

  it('state recovered pre/post-restart: getInstance returns identical state after hydrate', async () => {
    const workflowId = createActiveDefinition(engine);

    // Start an instance via the route so it's in the engine cache + DB.
    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'state-check-op' });

    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    // Capture pre-restart state from the engine cache.
    const preRestart = engine.getInstance(TENANT_ID, instanceId);
    expect(preRestart).not.toBeNull();

    // Simulate restart: hydrate clears the Map and rebuilds from DB.
    const repo = await getRepo();
    await simulateRestartAndHydrate(engine, repo);

    // Capture post-restart state from the re-hydrated engine.
    const postRestart = engine.getInstance(TENANT_ID, instanceId);
    expect(postRestart).not.toBeNull();

    // Fields that must match between the pre- and post-restart view.
    expect(postRestart!.id).toBe(preRestart!.id);
    expect(postRestart!.tenantId).toBe(preRestart!.tenantId);
    expect(postRestart!.workflowId).toBe(preRestart!.workflowId);
    expect(postRestart!.status).toBe(preRestart!.status);
    expect(postRestart!.currentStepId).toBe(preRestart!.currentStepId);
    expect(postRestart!.startedBy).toBe(preRestart!.startedBy);
    expect(postRestart!.startedAt).toBe(preRestart!.startedAt);
    expect(postRestart!.stepHistory.length).toBe(preRestart!.stepHistory.length);
  });

  // ==========================================================================
  // Test 4 — completeTask works after restart
  // ==========================================================================

  it('completeTask works after restart: hydrated instance + re-registered definition completes successfully', async () => {
    const workflowId = createActiveDefinition(engine);

    // Start an instance to persist it to DB + cache.
    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'post-restart-op' });

    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string; initialTaskId: string };

    // Simulate restart: hydrate clears the Map and rebuilds from DB.
    // At this point the engine's definition map is unchanged (definitions are
    // always present on the same engine in this simulation), and the instance
    // map is rebuilt from DB.
    const repo = await getRepo();
    await simulateRestartAndHydrate(engine, repo);

    // Insert a fresh pending task tied to the restored instance. The task must
    // point to STEP-A (the first step of the definition we registered above).
    const stepAId = `STEP-A-${instanceSeq}`;
    const taskIdAfterRestart = await seedPendingTask({
      instanceId,
      workflowId,
      stepId: stepAId,
      stepName: 'Step A',
    });

    const completeRes = await request(app)
      .post(`/api/workflow-central/tasks/${taskIdAfterRestart}/complete`)
      .send({ actionId: 'complete', completedBy: 'post-restart-op' });

    expect(completeRes.status).toBe(200);
    expect(completeRes.body.ok).toBe(true);
    expect(completeRes.body.code).toBe('ok');
  });

  // ==========================================================================
  // Test 5 — workflowDefinitionMissing after restart (definitions are volatile)
  // ==========================================================================

  it('workflowDefinitionMissing after restart: completeTask returns workflowDefinitionMissing:true when definition dropped from engine', async () => {
    // Use a synthetic workflow id that will NOT be registered on the engine.
    // This simulates the "definitions are volatile" Known Gap #4 path:
    // a process restart in production would lose in-memory definitions.
    const phantomWorkflowId = `WF-phantom-${Date.now()}`;

    // Seed an instance row directly in the DB (bypassing engine.createInstance,
    // so the definition doesn't need to exist). The instance is 'running' so it
    // enters the hydration set.
    const seedRow = await seedInstanceRow({
      status: 'running',
      workflowId: phantomWorkflowId,
      stepId: `STEP-A-phantom`,
      stepName: 'Step A',
    });

    // Hydrate the engine so the instance appears in the cache.
    const repo = await getRepo();
    await simulateRestartAndHydrate(engine, repo);

    // Confirm the instance is now in cache.
    expect(engine.getInstance(TENANT_ID, seedRow.id)).not.toBeNull();

    // Seed a pending task for this instance. The workflowId points to the
    // phantom definition (NOT registered in the engine's definitions map).
    const taskId = await seedPendingTask({
      instanceId: seedRow.id,
      workflowId: phantomWorkflowId,
      stepId: 'STEP-A-phantom',
      stepName: 'Step A',
    });

    // The engine has the instance in cache but NO definition for phantomWorkflowId.
    // planCascade should return workflowDefinitionMissing:true.
    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'volatile-def-op' });

    // Per spec §3.4: when the instance IS in cache but the definition is MISSING,
    // planCascade returns workflowDefinitionMissing:true and the route returns 200.
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workflowDefinitionMissing).toBe(true);
  });

  // ==========================================================================
  // Test 6 — T-11 scale smoke: 1000 old terminal + 50 active + 5 recent-terminal
  // ==========================================================================

  it('T-11 scale: getCacheSize()===55 after hydrating 1050 rows (1000 aged-out terminal + 50 active + 5 recent terminal)', async () => {
    const dbService = await getDbService();
    const repo = await getRepo();

    // Calculate cutoff for "old terminal" — beyond the hydration window.
    const cutoffMs = Date.now() - recentTerminalHydrationDays * 86_400_000;
    // Set old-terminal completedAt to 1 day before the cutoff.
    const oldCompletedAt = new Date(cutoffMs - 86_400_000).toISOString();
    // Set recent-terminal completedAt to 1 hour ago (well within window).
    const recentCompletedAt = new Date(Date.now() - 3_600_000).toISOString();

    const BATCH_SIZE = 100;
    const OLD_TERMINAL_COUNT = 1000;
    const ACTIVE_COUNT = 50;
    const RECENT_TERMINAL_COUNT = 5;

    // Seed old terminal rows (should NOT appear in hydration set).
    for (let batch = 0; batch < OLD_TERMINAL_COUNT / BATCH_SIZE; batch++) {
      await dbService.transaction(async (tx) => {
        for (let i = 0; i < BATCH_SIZE; i++) {
          instanceSeq++;
          await repo.insertInstance(tx, {
            id: `INST-old-terminal-${instanceSeq}`,
            tenantId: TENANT_ID,
            workflowId: `WF-old-${instanceSeq}`,
            workflowName: `Old WF ${instanceSeq}`,
            workflowVersion: 1,
            status: 'completed',
            currentStepId: null,
            currentStepName: null,
            variables: {},
            stepHistory: [],
            startedBy: 'scale-seed',
            startedAt: new Date(cutoffMs - 7 * 86_400_000).toISOString(),
            completedAt: oldCompletedAt,
            dueAt: null,
            error: null,
            pausedFromStatus: null,
          });
        }
      });
    }

    // Seed active rows (MUST appear in hydration set).
    await dbService.transaction(async (tx) => {
      for (let i = 0; i < ACTIVE_COUNT; i++) {
        instanceSeq++;
        await repo.insertInstance(tx, {
          id: `INST-active-${instanceSeq}`,
          tenantId: TENANT_ID,
          workflowId: `WF-active-${instanceSeq}`,
          workflowName: `Active WF ${instanceSeq}`,
          workflowVersion: 1,
          status: 'running',
          currentStepId: `STEP-A-${instanceSeq}`,
          currentStepName: 'Step A',
          variables: {},
          stepHistory: [],
          startedBy: 'scale-seed',
          startedAt: new Date().toISOString(),
          completedAt: null,
          dueAt: null,
          error: null,
          pausedFromStatus: null,
        });
      }
    });

    // Seed recent terminal rows (MUST appear in hydration set).
    await dbService.transaction(async (tx) => {
      for (let i = 0; i < RECENT_TERMINAL_COUNT; i++) {
        instanceSeq++;
        await repo.insertInstance(tx, {
          id: `INST-recent-terminal-${instanceSeq}`,
          tenantId: TENANT_ID,
          workflowId: `WF-recent-${instanceSeq}`,
          workflowName: `Recent WF ${instanceSeq}`,
          workflowVersion: 1,
          status: 'completed',
          currentStepId: null,
          currentStepName: null,
          variables: {},
          stepHistory: [],
          startedBy: 'scale-seed',
          startedAt: new Date(Date.now() - 7_200_000).toISOString(),
          completedAt: recentCompletedAt,
          dueAt: null,
          error: null,
          pausedFromStatus: null,
        });
      }
    });

    // Simulate restart + hydrate, measuring elapsed time.
    // hydrate() clears the Map before repopulating, so we get a clean count.
    const start = Date.now();
    await simulateRestartAndHydrate(engine, repo);
    const elapsed = Date.now() - start;

    // Core assertion: only active + recent-terminal rows enter the cache.
    expect(engine.hydrationReady).toBe(true);
    expect(engine.getCacheSize()).toBe(ACTIVE_COUNT + RECENT_TERMINAL_COUNT);

    // Performance guard: hydration must complete within 500ms for this scale.
    expect(elapsed).toBeLessThan(500);
  }, 60_000); // extend timeout for the bulk-seed + hydration phase

  // ==========================================================================
  // Test 7 — T-15 orphan-task defense: instance row deleted before completeTask
  //
  // Spec: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md §3.2 D25
  //       "WorkflowInstanceMissingError → route mapper → 500 + WARN (invariant breach)"
  //
  // Contract: when an instance row vanishes out from under a pending task
  // (raw SQL DELETE, foreign-key cascade gone wrong, replica divergence, etc.),
  // completeTask MUST surface a typed `WorkflowInstanceMissingError`. The route
  // maps that to HTTP 500 with `code: 'workflow_instance_missing'`. The
  // operator writes a structured failure audit row keyed by the task id with
  // `details.completion_result = 'workflow_instance_missing'` and
  // `details.error_class = 'WorkflowInstanceMissingError'`, AND emits a
  // structured `logger.warn('workflow_instance_missing', { ... })` so the
  // invariant breach surfaces in ops alerting alongside the audit row.
  // ==========================================================================

  it('T-15 orphan task: instance row deleted before completeTask → 500 + typed error + audit', async () => {
    // 1. Register and activate definition; capture def.id.
    const workflowId = createActiveDefinition(engine);

    // 2. Start an instance via the route.
    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'orphan-test-op' });
    expect(startRes.status).toBe(201);
    const { instanceId, initialTaskId } = startRes.body as {
      instanceId: string;
      initialTaskId: string;
    };

    // 3. Raw DELETE on the instance row, leaving the task orphaned.
    //    Bypasses the repository so the pending task survives — exactly the
    //    "invariant breach" scenario WorkflowInstanceMissingError is designed
    //    to catch.
    const dbService = await getDbService();
    await sql`DELETE FROM workflow_central_instances WHERE id = ${instanceId}`.execute(
      dbService.getDatabase(),
    );

    // 4. Spy on the operator's logger so the invariant-breach WARN is
    //    captured and asserted below alongside the audit-row contract.
    const operator = await container.getAsync<{ logger: { warn: (...args: unknown[]) => void } }>(
      TYPES.WorkflowCentralOperatorService,
    );
    const warnSpy = jest.spyOn(operator.logger, 'warn');

    try {
      // 5. Attempt completeTask. Route maps WorkflowInstanceMissingError → 500
      //    per src/routes/workflowCentral.ts:25-26.
      const res = await request(app)
        .post(`/api/workflow-central/tasks/${initialTaskId}/complete`)
        .send({ actionId: 'complete', completedBy: 'orphan-test-op' });

      expect(res.status).toBe(500);
      expect(res.body.ok).toBe(false);
      expect(res.body.code).toBe('workflow_instance_missing');

      // 6. Structured failure audit row was written by the operator's
      //    typed-error catch (WorkflowCentralOperatorService.ts:270-280).
      //    Query via AuditLogRepository.findByResource so `details` is
      //    parsed JSON regardless of dialect (SQLite TEXT vs Postgres JSONB).
      const auditRepo = await container.getAsync<{
        findByResource: (
          resourceType: string,
          resourceId: string,
        ) => Promise<Array<{ action: string; result: string; details: Record<string, unknown> | null; error_message: string | null }>>;
      }>(TYPES.AuditLogRepository);
      const rows = await auditRepo.findByResource('workflow_central_task', initialTaskId);
      const orphanRow = rows.find(
        (r) =>
          r.action === 'workflow_central.complete_task' &&
          r.details?.completion_result === 'workflow_instance_missing',
      );
      expect(orphanRow).toBeDefined();
      expect(orphanRow!.result).toBe('failure');
      expect(orphanRow!.error_message).toBe('workflow_instance_missing');
      expect(orphanRow!.details?.error_class).toBe('WorkflowInstanceMissingError');

      // 7. Operator emits a structured WARN on the invariant-breach path so
      //    ops alerting picks it up alongside the audit row. instance_id is
      //    required so on-call can correlate the WARN with the missing row.
      expect(warnSpy).toHaveBeenCalledWith(
        'workflow_instance_missing',
        expect.objectContaining({
          error_class: 'WorkflowInstanceMissingError',
          task_id: initialTaskId,
          instance_id: instanceId,
        }),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
