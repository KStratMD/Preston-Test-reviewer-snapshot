/**
 * WorkflowCentral cancellation-reason DLP carve-out integration tests (T13.3 / T-7).
 *
 * Verifies the D8 DLP carve-out for `cancellationReason`:
 *   - The reason flows through the synchronous response body AFTER DLP redaction.
 *   - The audit row NEVER contains the raw or redacted reason text (only
 *     non-sensitive observability flags reason_supplied / reason_was_redacted).
 *   - The in-memory engine Map cache holds the REDACTED reason (not the raw
 *     value) so subsequent GET reads in the same process are also redacted.
 *   - The reason is NEVER persisted — after a simulated restart and hydrate
 *     from the DB, the recovered instance has cancellationReason === null,
 *     proving the carve-out is cache-only.
 *
 * Pattern source: tests/integration/workflow-central-restart-recovery.test.ts
 *   (mirrors imports, setupTestDatabase, TENANT_ID, express + router wiring,
 *   simulated restart via engine.hydrate(repo)).
 *
 * Plan: docs/plans/2026-05-15-workflow-central-instance-durability-plan.md
 *       Task 13 Step 3 (T-7 DLP carve-out, 4 tests).
 * Spec: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md §7.1 T-7.
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

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

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
 * Create + activate a single-step task workflow and start an instance through
 * the route so it's persisted AND in the engine cache. Returns the instance id.
 */
async function startInstanceViaRoute(
  app: express.Express,
  engine: WorkflowEngineService,
): Promise<string> {
  seq++;
  const def = engine.createDefinition({
    name: `DLP Cancel WF ${seq}`,
    description: 'Cancellation-reason DLP carve-out integration test',
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

  const res = await request(app)
    .post('/api/workflow-central/instances')
    .send({ workflowId: def.id, startedBy: 'op_dlp_test' });
  expect(res.status).toBe(201);
  return (res.body as { instanceId: string }).instanceId;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('workflow-central cancellation-reason DLP carve-out (T13.3 / T-7)', () => {
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
    // Refresh engine reference in case prior tests in the file altered state.
    engine = getEngine();
    engine.hydrationReady = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // T-7a: response body reason is DLP-redacted
  // ==========================================================================

  it('T-7a: cancelInstance with reason="SSN 123-45-6789" returns DLP-redacted reason in response body', async () => {
    const instanceId = await startInstanceViaRoute(app, engine);

    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_dlp_test', reason: 'SSN 123-45-6789' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: instanceId, status: 'cancelled' });

    // DLPService.scanText() with autoRedact:true replaces matched SSN tokens with
    // the per-pattern redact() output. The SSN pattern returns '***-**-****'
    // (DLPService.ts:195). The response must NOT echo the raw '123-45-6789'.
    expect(typeof res.body.cancellationReason).toBe('string');
    expect(res.body.cancellationReason).not.toContain('123-45-6789');
    expect(res.body.cancellationReason).toContain('***-**-****');
  });

  // ==========================================================================
  // T-7b: audit row has NO reason field at all (carve-out, never persisted)
  // ==========================================================================

  it('T-7b: audit row written by cancelInstance has NO cancellation_reason field (DLP carve-out)', async () => {
    const instanceId = await startInstanceViaRoute(app, engine);

    const rawReason = 'cancelling because SSN 123-45-6789 is on the request';
    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_dlp_test', reason: rawReason });
    expect(res.status).toBe(200);

    const dbService = await getDbService();
    const db = dbService.getDatabase();
    const rows = await db
      .selectFrom('audit_logs')
      .selectAll()
      .where('action', '=', 'workflow_central.cancel_instance')
      .where('resource_id', '=', instanceId)
      .execute();

    expect(rows).toHaveLength(1);
    const details = JSON.parse(rows[0].details as unknown as string) as Record<string, unknown>;

    // The reason MUST NOT appear in details — neither under any plausible key
    // nor as a substring of any string value (covers both raw + redacted text).
    expect(details).not.toHaveProperty('cancellation_reason');
    expect(details).not.toHaveProperty('cancellationReason');
    expect(details).not.toHaveProperty('reason');

    // Serialize the entire row + details to be doubly sure no leak occurred via
    // some other column (e.g., error_message). raw SSN MUST be absent
    // everywhere.
    const fullSerialized = JSON.stringify(rows[0]);
    expect(fullSerialized).not.toContain('123-45-6789');
    expect(fullSerialized).not.toContain('cancelling because');

    // Non-sensitive observability flags ARE persisted (per the carve-out
    // contract — operators need to know DLP fired without seeing the text).
    expect(details.reason_supplied).toBe(true);
    expect(details.reason_was_redacted).toBe(true);
    expect(details.cancelled_by).toBe('op_dlp_test');
  });

  // ==========================================================================
  // T-7c: engine Map cache holds the REDACTED reason (not raw)
  // ==========================================================================

  it('T-7c: engine in-memory cache holds the redacted reason (not the raw text)', async () => {
    const instanceId = await startInstanceViaRoute(app, engine);

    const res = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_dlp_test', reason: 'SSN 123-45-6789' });
    expect(res.status).toBe(200);

    // Inspect the engine's in-memory cache directly. The single Map.set in
    // refreshCacheFromCommit (D9 atomicity) stamps cancellationReason alongside
    // the rest of the WorkflowInstance. The value MUST be the redacted form
    // produced by redactCancellationReason — never the raw input.
    const cached = engine.getInstance(TENANT_ID, instanceId);
    expect(cached).not.toBeNull();
    expect(cached!.status).toBe('cancelled');
    expect(typeof cached!.cancellationReason).toBe('string');
    expect(cached!.cancellationReason).not.toContain('123-45-6789');
    expect(cached!.cancellationReason).toContain('***-**-****');
  });

  // ==========================================================================
  // T-7d: after restart + hydrate, cancellationReason is null (proves non-durability)
  // ==========================================================================

  it('T-7d: after simulated restart + engine.hydrate(repo), recovered instance has cancellationReason=null (non-durable)', async () => {
    const instanceId = await startInstanceViaRoute(app, engine);

    const cancelRes = await request(app)
      .post(`/api/workflow-central/instances/${instanceId}/cancel`)
      .send({ cancelledBy: 'op_dlp_test', reason: 'SSN 123-45-6789' });
    expect(cancelRes.status).toBe(200);

    // Sanity: before restart, the cache holds the redacted reason.
    const preRestart = engine.getInstance(TENANT_ID, instanceId);
    expect(preRestart).not.toBeNull();
    expect(typeof preRestart!.cancellationReason).toBe('string');

    // Simulate a process restart: hydrate clears the Map and re-populates it
    // exclusively from `repo.listInstancesForHydration()` — the DB. The
    // `cancellation_reason` column DOES NOT EXIST (migration 042 omits it per
    // the D8 carve-out), so the recovered instance MUST surface
    // cancellationReason=null. This is the durability proof for the carve-out:
    // the redacted text lived only in the Map and dies on restart.
    const repo = await getRepo();
    await engine.hydrate(repo);

    expect(engine.hydrationReady).toBe(true);
    const postRestart = engine.getInstance(TENANT_ID, instanceId);
    expect(postRestart).not.toBeNull();
    expect(postRestart!.status).toBe('cancelled');
    // The key durability assertion — null after rebuild from DB.
    expect(postRestart!.cancellationReason).toBeNull();
  });
});
