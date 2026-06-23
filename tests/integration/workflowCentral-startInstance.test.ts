/**
 * WorkflowCentral startInstance integration tests (T12).
 *
 * End-to-end via POST /api/workflow-central/instances.
 * Uses in-memory SQLite + real DI container.
 *
 * Covers:
 *   - Happy path: 201 + instanceId + initialTaskId + task row + audit success
 *   - No order-1 step: 201 with initialTaskId=null, no task row
 *   - Non-task first step: initialTaskId=null
 *   - Insert failure cleanup (R3 F-02): engine.deleteInstance called on error
 *   - Audit shape (F-12): required details keys
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

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

describe('workflow-central startInstance integration (T12)', () => {
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
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let seq = 0;

  /** Create and activate a definition. Returns its id. */
  function createActiveDefinition(opts: {
    firstStepType?: 'task' | 'approval' | 'notification' | 'integration';
    hasOrderOneStep?: boolean;
  } = {}): string {
    seq++;
    const firstStepType = opts.firstStepType ?? 'task';
    const hasOrderOneStep = opts.hasOrderOneStep ?? true;

    const steps = hasOrderOneStep
      ? [
          {
            id: `STEP-start-${seq}`,
            name: 'First Step',
            type: firstStepType,
            order: 1,
            config: {
              taskType: 'review',
              assigneeType: 'user' as const,
              assigneeValue: 'alice',
            },
            transitions: [] as Array<{ id: string; targetStepId: string; isDefault: boolean }>,
            timeoutHours: null as null,
            retryPolicy: null as null,
          },
        ]
      : [
          {
            id: `STEP-noorder1-${seq}`,
            name: 'Step at order 2',
            type: 'task' as const,
            order: 2,
            config: {
              taskType: 'review',
              assigneeType: 'user' as const,
              assigneeValue: 'alice',
            },
            transitions: [] as Array<{ id: string; targetStepId: string; isDefault: boolean }>,
            timeoutHours: null as null,
            retryPolicy: null as null,
          },
        ];

    const def = engine.createDefinition({
      name: `Start WF ${seq}`,
      description: 'StartInstance integration test',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps,
    });

    // Copilot R12 SHOULD-FIX: replace private-Map cast with the public
    // engine.setDefinitionStatus(id, 'active') helper. The previous
    // `as unknown as { definitions: Map<...> }` cast pattern is now gone.
    engine.setDefinitionStatus(def.id, 'active');

    return def.id;
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
  // Happy path
  // ---------------------------------------------------------------------------

  it('happy path: 201 + instanceId + initialTaskId + task row in DB + audit success', async () => {
    const workflowId = createActiveDefinition({ firstStepType: 'task' });

    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_42' });

    expect(res.status).toBe(201);
    expect(typeof res.body.instanceId).toBe('string');
    expect(typeof res.body.initialTaskId).toBe('string');

    const { instanceId, initialTaskId } = res.body as { instanceId: string; initialTaskId: string };

    // Task row exists in DB.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const row = await db
      .selectFrom('workflow_central_tasks')
      .select(['id', 'status', 'instance_id'])
      .where('id', '=', initialTaskId)
      .executeTakeFirst();
    expect(row).toBeDefined();
    expect(row!.status).toBe('pending');
    expect(row!.instance_id).toBe(instanceId);

    // Audit row.
    const audits = await fetchAudit('workflow_central.start_instance');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('success');
    const details = JSON.parse(audits[0].details as unknown as string);
    expect(details.initial_task_id).toBe(initialTaskId);
    expect(details.task_insert_succeeded).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // No order-1 step
  // ---------------------------------------------------------------------------

  it('no order-1 step: 201 with initialTaskId=null, no task row inserted', async () => {
    const workflowId = createActiveDefinition({ hasOrderOneStep: false });

    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_42' });

    expect(res.status).toBe(201);
    expect(res.body.initialTaskId).toBeNull();

    // No task row in DB.
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const rows = await db
      .selectFrom('workflow_central_tasks')
      .select('id')
      .where('instance_id', '=', res.body.instanceId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Non-task first step (notification)
  // ---------------------------------------------------------------------------

  it('non-task first step (notification): 201 with initialTaskId=null, no task row', async () => {
    const workflowId = createActiveDefinition({ firstStepType: 'notification' });

    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_42' });

    expect(res.status).toBe(201);
    expect(res.body.initialTaskId).toBeNull();

    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    const rows = await db
      .selectFrom('workflow_central_tasks')
      .select('id')
      .where('instance_id', '=', res.body.instanceId)
      .execute();
    expect(rows).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // Insert failure cleanup (R3 F-02)
  // ---------------------------------------------------------------------------

  it('R3 F-02 (PR-OP-3 rewrite): insert failure → no orphan task row + no cache entry (deferred Map.set obsoletes cleanup)', async () => {
    // PR-OP-3 D10: createInstance returns ephemeral and Map.set is deferred until
    // AFTER the TX commits. If repo.insertTask throws inside the TX, the entire
    // transaction rolls back AND the Map was never mutated — so there's nothing
    // to clean up. The old `engine.deleteInstance` cleanup path was obsoleted.
    const workflowId = createActiveDefinition({ firstStepType: 'task' });

    // Stub repo.insertTask to throw — TX rolls back.
    jest
      .spyOn(WorkflowCentralRepository.prototype, 'insertTask')
      .mockRejectedValueOnce(new Error('DB insert failed'));

    // Snapshot pre-state for assertions below.
    const engine = await container.getAsync<WorkflowEngineService>(TYPES.WorkflowEngineService);
    const cacheSizeBefore = engine.getCacheSize();

    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_42' });

    expect(res.status).toBe(500);

    // Cache size unchanged — deferred Map.set means no orphan to clean.
    expect(engine.getCacheSize()).toBe(cacheSizeBefore);

    // No instance row persisted (TX rolled back) — query directly.
    const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    const orphans = await dbService.getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('workflow_id', '=', workflowId)
      .execute();
    expect(orphans).toHaveLength(0);

    // Audit records failure.
    const audits = await fetchAudit('workflow_central.start_instance');
    expect(audits).toHaveLength(1);
    expect(audits[0].result).toBe('failure');
  });

  // ---------------------------------------------------------------------------
  // Audit shape (F-12)
  // ---------------------------------------------------------------------------

  it('F-12: audit details contains all required keys', async () => {
    const workflowId = createActiveDefinition({ firstStepType: 'task' });

    await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'op_review' });

    const audits = await fetchAudit('workflow_central.start_instance');
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(audits[0].details as unknown as string);

    // Required audit shape per spec F-12.
    expect(details).toHaveProperty('tenant_id');
    expect(details).toHaveProperty('instance_id');
    expect(details).toHaveProperty('workflow_id');
    expect(details).toHaveProperty('workflow_name');
    expect(details).toHaveProperty('initial_task_id');
    expect(details).toHaveProperty('started_by');
    expect(details).toHaveProperty('task_insert_succeeded');

    expect(details.tenant_id).toBe(TENANT_ID);
    expect(details.started_by).toBe('op_review');
    expect(details.task_insert_succeeded).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // Codex BLOCKS-MERGE R-fix: route-level body-actor override
  // ---------------------------------------------------------------------------

  it('post-auth: body-supplied startedBy is overridden by extractIdentityContext(req).userId', async () => {
    // Build a fresh app with auth-injecting middleware (mirrors
    // tests/integration/IdentityPropagation.test.ts pattern). When req.user
    // is populated with a non-SYSTEM_IDENTITY tenant + userId, the route
    // MUST ignore the body's startedBy and use ctx.userId instead.
    const authedApp = express();
    authedApp.use(express.json());
    authedApp.use((req, _res, next) => {
      (req as unknown as { user: Record<string, unknown> }).user = {
        id: 'auth-user-real',
        username: 'auth-user-real',
        tenantId: TENANT_ID, // tests use SYSTEM_IDENTITY.tenantId; ctxUserId differs
        roles: [],
        permissions: [],
      };
      next();
    });
    authedApp.use('/api/workflow-central', workflowCentralRouter);

    const workflowId = createActiveDefinition({ firstStepType: 'task' });

    const res = await request(authedApp)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'BODY-SPOOFED-ACTOR' });

    expect(res.status).toBe(201);

    const audits = await fetchAudit('workflow_central.start_instance');
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const details = JSON.parse(audits[audits.length - 1].details as unknown as string);

    // Body-supplied actor MUST NOT appear in audit. ctx.userId MUST appear.
    expect(details.started_by).toBe('auth-user-real');
    expect(details.started_by).not.toBe('BODY-SPOOFED-ACTOR');
    // user_id column on audit row is the canonical actor — must match ctx.
    expect(audits[audits.length - 1].user_id).toBe('auth-user-real');
  });

  it('pre-auth path still honors body startedBy (SYSTEM_IDENTITY fallback)', async () => {
    // Sanity-check the documented pre-auth demo behavior is preserved:
    // when extractIdentityContext returns SYSTEM_IDENTITY on both fields,
    // the body's startedBy IS used (existing F-12 test depends on this).
    const workflowId = createActiveDefinition({ firstStepType: 'task' });

    const res = await request(app)
      .post('/api/workflow-central/instances')
      .send({ workflowId, startedBy: 'pre-auth-body-actor' });

    expect(res.status).toBe(201);

    const audits = await fetchAudit('workflow_central.start_instance');
    const details = JSON.parse(audits[audits.length - 1].details as unknown as string);
    expect(details.started_by).toBe('pre-auth-body-actor');
  });
});
