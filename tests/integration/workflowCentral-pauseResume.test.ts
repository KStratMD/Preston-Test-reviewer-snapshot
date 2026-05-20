/**
 * WorkflowCentral pause/resume durability integration tests (T13.4).
 *
 * 9 tests cover T-16 → T-23 per the PR-OP-3 follow-up plan (Task 13 Step 4).
 * (The T-16..T-23 range yields 8 user-facing IDs; T-19b is the additional D23
 * regression net listed in the plan, bringing the test count to 9.)
 * The keystone regression net is T-19b (D23): a `waiting`-paused instance MUST
 * resume back to `waiting`, NOT `running`. PR-OP-3 added `paused_from_status`
 * on the instance row exactly so resume could restore the pre-pause status.
 *
 * Test inventory (user-supplied numbering; aligns to spec §7.2 IDs in parens):
 *   - T-16  pause running → paused (spec T-16)
 *   - T-17  resume paused-from-running → running (spec T-19a)
 *   - T-18  pause already-paused → 409 invalid_state_transition (spec T-18 partial)
 *   - T-19  resume non-paused → 409 invalid_state_transition (spec T-20)
 *   - T-19b waiting → paused → waiting D23 round-trip (spec T-19b, CRITICAL)
 *   - T-20  pause survives simulated restart via hydrate (spec T-21)
 *   - T-21  completeTask on paused instance blocked (spec T-23)
 *   - T-22  pause on terminal instance → 409 invalid_state_transition (spec T-18 terminal-half)
 *   - T-23  resume audit row observability fields (operator-promotion contract)
 *
 * Pattern source: tests/integration/workflow-central-restart-recovery.test.ts
 * Spec ref: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md
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
import type { NewInstanceRow } from '../../src/services/workflowCentral/types';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let instanceSeq = 0;

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
 * Create a workflow definition with a 2-step task workflow and activate it.
 * Mirrors createActiveDefinition() in workflow-central-restart-recovery.test.ts.
 * Returns the workflow id.
 */
function createActiveDefinition(engine: WorkflowEngineService): string {
  instanceSeq++;
  const def = engine.createDefinition({
    name: `PauseResume WF ${instanceSeq}`,
    description: 'Pause/resume integration test',
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
 * Seed an instance row directly into the DB.
 * Used to set up arbitrary instance states (terminal, etc.) the engine wouldn't
 * naturally produce via the route.
 */
async function seedInstanceRow(overrides: {
  id?: string;
  status?: NewInstanceRow['status'];
  completedAt?: string | null;
  workflowId?: string;
  stepId?: string | null;
  stepName?: string | null;
  pausedFromStatus?: NewInstanceRow['pausedFromStatus'];
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
    currentStepId: overrides.stepId !== undefined ? overrides.stepId : `STEP-A-${instanceSeq}`,
    currentStepName: overrides.stepName !== undefined ? overrides.stepName : 'Step A',
    variables: {},
    stepHistory: [],
    startedBy: 'test',
    startedAt: now,
    completedAt: overrides.completedAt ?? null,
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

/** Read the raw instance row from DB. Snake_case fields per migration 042. */
async function readInstanceRow(instanceId: string) {
  const dbService = await getDbService();
  const db = dbService.getDatabase();
  return db
    .selectFrom('workflow_central_instances')
    .selectAll()
    .where('id', '=', instanceId)
    .executeTakeFirst();
}

/** Fetch audit_logs rows for a given action. */
async function fetchAudit(action: string) {
  const dbService = await getDbService();
  const db = dbService.getDatabase();
  return db
    .selectFrom('audit_logs')
    .selectAll()
    .where('action', '=', action)
    .orderBy('created_at', 'desc')
    .execute();
}

/** Parse an audit row's `details` JSON column (TEXT in SQLite, JSONB in PG). */
function parseAuditDetails(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') return JSON.parse(raw) as Record<string, unknown>;
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  throw new Error(`unexpected audit details shape: ${typeof raw}`);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('workflow-central pause/resume durability integration (T13.4)', () => {
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
  // T-16 — pause running → paused (durable; paused_from_status='running')
  // ==========================================================================

  it('T-16: pause running instance persists status=paused + paused_from_status=running + audit row', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t16' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    // Pre-pause snapshot — sanity check that the row landed running.
    const preRow = await readInstanceRow(instanceId);
    expect(preRow).toBeDefined();
    expect(preRow!.status).toBe('running');
    expect(preRow!.paused_from_status).toBeNull();

    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);
    expect(pauseRes.body).toMatchObject({ id: instanceId, status: 'paused' });

    // DB assertion — D14 + D23: status='paused', paused_from_status='running'.
    const postRow = await readInstanceRow(instanceId);
    expect(postRow).toBeDefined();
    expect(postRow!.status).toBe('paused');
    expect(postRow!.paused_from_status).toBe('running');

    // Audit row — workflow_central.pause_instance success.
    const audits = await fetchAudit('workflow_central.pause_instance');
    expect(audits).toHaveLength(1);
    expect(audits[0].resource_id).toBe(instanceId);
    expect(audits[0].result).toBe('success');
    const details = parseAuditDetails(audits[0].details);
    expect(details.instance_id).toBe(instanceId);
    expect(details.tenant_id).toBe(TENANT_ID);
    expect(details.previous_status).toBe('running');
  });

  // ==========================================================================
  // T-17 — resume paused-from-running → running (durable; paused_from_status cleared)
  // ==========================================================================

  it('T-17: resume paused (was running) restores status=running, clears paused_from_status, emits audit', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t17' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    // Pause first.
    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);

    // Now resume.
    const resumeRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/resume`)
      .send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body).toMatchObject({ id: instanceId, status: 'running' });

    // DB assertion — D23: restored to 'running', paused_from_status NULL.
    const row = await readInstanceRow(instanceId);
    expect(row).toBeDefined();
    expect(row!.status).toBe('running');
    expect(row!.paused_from_status).toBeNull();

    // Audit row for resume.
    const audits = await fetchAudit('workflow_central.resume_instance');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    expect(audits[0].resource_id).toBe(instanceId);
  });

  // ==========================================================================
  // T-18 — pause already-paused → 409 invalid_state_transition, state unchanged
  // ==========================================================================

  it('T-18: pause an already-paused instance returns 409 invalid_state_transition and leaves DB state unchanged', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t18' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    // First pause — succeeds.
    const first = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(first.status).toBe(200);

    const snapshotBefore = await readInstanceRow(instanceId);
    expect(snapshotBefore!.status).toBe('paused');
    expect(snapshotBefore!.paused_from_status).toBe('running');

    // Second pause — must reject with 409 (pauseInstance source-state guard
    // accepts only {running, waiting}; 'paused' is invalid → InvalidStateTransitionError
    // → mapper returns 409 + code 'invalid_state_transition').
    const second = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ ok: false, code: 'invalid_state_transition' });

    // State unchanged.
    const snapshotAfter = await readInstanceRow(instanceId);
    expect(snapshotAfter!.status).toBe('paused');
    expect(snapshotAfter!.paused_from_status).toBe('running');
    expect(snapshotAfter!.updated_at).toBe(snapshotBefore!.updated_at);
  });

  // ==========================================================================
  // T-19 — resume non-paused → 409, state unchanged
  // ==========================================================================

  it('T-19: resume a running (non-paused) instance returns 409 and leaves DB state unchanged', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t19' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    const snapshotBefore = await readInstanceRow(instanceId);
    expect(snapshotBefore!.status).toBe('running');

    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/resume`)
      .send({});
    // resumeInstance source-state guard accepts only 'paused'.
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: 'invalid_state_transition' });

    const snapshotAfter = await readInstanceRow(instanceId);
    expect(snapshotAfter!.status).toBe('running');
    expect(snapshotAfter!.paused_from_status).toBeNull();
    expect(snapshotAfter!.updated_at).toBe(snapshotBefore!.updated_at);
  });

  // ==========================================================================
  // T-19b — D23 REGRESSION NET: waiting → paused → waiting (CRITICAL)
  // ==========================================================================

  it('T-19b (D23 CRITICAL): waiting → paused stores paused_from_status=waiting; resume restores waiting NOT running', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t19b' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    // Force the instance into 'waiting' state via direct DB update — the
    // engine doesn't currently expose a route-driven path that produces 'waiting',
    // but D14 widened the pause source-state set to {running, waiting}. After
    // mutating the DB, re-hydrate so the engine cache sees the new status.
    const dbService = await getDbService();
    await dbService.transaction(async (tx) => {
      await tx
        .updateTable('workflow_central_instances')
        .set({ status: 'waiting', updated_at: new Date().toISOString() })
        .where('id', '=', instanceId)
        .execute();
    });
    const repo = await getRepo();
    await engine.hydrate(repo);
    engine.hydrationReady = true;

    // Pause from 'waiting'. D14: pause must accept 'waiting' as source.
    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);

    // D23: paused_from_status MUST be 'waiting' (the pre-pause source state).
    const rowPaused = await readInstanceRow(instanceId);
    expect(rowPaused!.status).toBe('paused');
    expect(rowPaused!.paused_from_status).toBe('waiting');

    // Resume — D23 round-trip: status MUST be restored to 'waiting', NOT 'running'.
    // This is the explicit regression net against the prior bug where resume
    // hardcoded status='running'.
    const resumeRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/resume`)
      .send({});
    expect(resumeRes.status).toBe(200);
    expect(resumeRes.body).toMatchObject({ id: instanceId, status: 'waiting' });

    const rowResumed = await readInstanceRow(instanceId);
    expect(rowResumed!.status).toBe('waiting');
    expect(rowResumed!.status).not.toBe('running');
    expect(rowResumed!.paused_from_status).toBeNull();
  });

  // ==========================================================================
  // T-20 — pause survives simulated restart via hydrate
  // ==========================================================================

  it('T-20: paused instance survives simulated restart — hydrate restores status=paused + paused_from_status', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t20' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);

    // Simulate restart — hydrate clears the engine's in-memory Map then
    // repopulates from the DB.
    const repo = await getRepo();
    await engine.hydrate(repo);
    expect(engine.hydrationReady).toBe(true);

    // Engine cache: the in-memory WorkflowInstance type does NOT carry
    // pausedFromStatus (intentional — see persistedToWorkflowInstance in
    // WorkflowEngineService.ts). What we CAN assert in cache is status='paused'.
    const cached = engine.getInstance(TENANT_ID, instanceId);
    expect(cached).not.toBeNull();
    expect(cached!.status).toBe('paused');

    // DB row carries the durability proof for paused_from_status.
    const row = await readInstanceRow(instanceId);
    expect(row!.status).toBe('paused');
    expect(row!.paused_from_status).toBe('running');
  });

  // ==========================================================================
  // T-21 — completeTask on a paused instance is blocked (D21 paused gate)
  // ==========================================================================

  it('T-21: completeTask on a paused instance returns 409 instance_paused; state unchanged; failure audit emitted', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t21' });
    expect(startRes.status).toBe(201);
    const { instanceId, initialTaskId } = startRes.body as {
      instanceId: string;
      initialTaskId: string;
    };

    // Pause the instance.
    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);

    // Snapshot DB state before attempted completeTask.
    const taskBefore = await (await getDbService())
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('id', '=', initialTaskId)
      .executeTakeFirst();
    expect(taskBefore!.status).toBe('pending');

    // Attempt completeTask — D21 paused gate in
    // WorkflowCentralOperatorService.completeTask throws InstancePausedError,
    // which the route mapper translates to 409 + code 'instance_paused'.
    const completeRes = await request(app)
      .post(`/api/workflow-central/tasks/${initialTaskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_t21' });
    expect(completeRes.status).toBe(409);
    expect(completeRes.body).toMatchObject({ ok: false, code: 'instance_paused' });

    // Task row unchanged.
    const taskAfter = await (await getDbService())
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('id', '=', initialTaskId)
      .executeTakeFirst();
    expect(taskAfter!.status).toBe('pending');
    expect(taskAfter!.completed_at).toBeNull();

    // Instance row still paused.
    const instRow = await readInstanceRow(instanceId);
    expect(instRow!.status).toBe('paused');
    expect(instRow!.paused_from_status).toBe('running');

    // Failure audit emitted for the blocked completeTask attempt (operator
    // service catch block emits result='failure' + error_message='instance_paused').
    const completeAudits = await fetchAudit('workflow_central.complete_task');
    expect(completeAudits.length).toBeGreaterThanOrEqual(1);
    const failureAudit = completeAudits.find((a) => a.result === 'failure');
    expect(failureAudit).toBeDefined();
    expect(failureAudit!.error_message).toBe('instance_paused');
  });

  // ==========================================================================
  // T-22 — pause on terminal instance → 409, state unchanged
  // ==========================================================================

  it('T-22: pause on a terminal (completed) instance returns 409 invalid_state_transition; state unchanged', async () => {
    // Seed a completed instance directly — pauseInstance source-state guard
    // accepts only {running, waiting}, so 'completed' must reject.
    const seeded = await seedInstanceRow({
      status: 'completed',
      completedAt: new Date().toISOString(),
      stepId: null,
      stepName: null,
    });

    const snapshotBefore = await readInstanceRow(seeded.id);
    expect(snapshotBefore!.status).toBe('completed');

    const res = await request(app)
      .post(`/api/workflow-central/instances/${seeded.id}/pause`)
      .send({});
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: 'invalid_state_transition' });

    // State unchanged.
    const snapshotAfter = await readInstanceRow(seeded.id);
    expect(snapshotAfter!.status).toBe('completed');
    expect(snapshotAfter!.paused_from_status).toBeNull();
    expect(snapshotAfter!.completed_at).toBe(snapshotBefore!.completed_at);
  });

  // ==========================================================================
  // T-23 — resume audit row includes observability fields
  // ==========================================================================

  it('T-23: resume audit row details include previous_status and resumed_to_status observability fields', async () => {
    const workflowId = createActiveDefinition(engine);

    const startRes = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_t23' });
    expect(startRes.status).toBe(201);
    const { instanceId } = startRes.body as { instanceId: string };

    const pauseRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/pause`)
      .send({});
    expect(pauseRes.status).toBe(200);

    const resumeRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/resume`)
      .send({});
    expect(resumeRes.status).toBe(200);

    const audits = await fetchAudit('workflow_central.resume_instance');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    expect(audits[0].resource_id).toBe(instanceId);
    expect(audits[0].resource_type).toBe('workflow_central_instance');

    const details = parseAuditDetails(audits[0].details);

    // Observability contract: the service emits previous_status (the source
    // state when resume began, which is always 'paused' on success) and
    // resumed_to_status (the restored pre-pause status). Source:
    // WorkflowCentralService.resumeInstance details payload (~L795-L800).
    expect(details.tenant_id).toBe(TENANT_ID);
    expect(details.instance_id).toBe(instanceId);
    expect(details.previous_status).toBe('paused');
    expect(details.resumed_to_status).toBe('running');
  });
});
