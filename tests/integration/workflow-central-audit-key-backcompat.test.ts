/**
 * WorkflowCentral audit-key rename + backcompat reader tests (T13.3b).
 *
 * PR-OP-3 T-8 renamed the audit details key
 *   `workflow_context_missing` → `workflow_definition_missing`
 * (canonical write sites: WorkflowCentralOperatorService.ts:325 + :358,
 *  route mapper: routes/workflowCentral.ts:29, error class: errors.ts:21).
 *
 * Scope per IMPLEMENTER NOTE in the followup-PR plan:
 *
 *   - Test #1 (integration) — drives the production route and asserts that
 *     the NEW audit row written by current code uses the new key and does
 *     NOT carry the old one.
 *
 *   - Tests #2 + #3 (unit-level on AuditLogRepository) — there is no
 *     `/api/audit` HTTP surface; the audit query API consumed by these
 *     tests is `AuditLogRepository.findByAuditFilters({ actions })` from
 *     `src/database/repositories/AuditLogRepository.ts`. Tests assert that
 *     historical PR-OP-2 rows persisted with the old key are still
 *     readable through that query path, and that the query returns BOTH
 *     old-key (legacy) and new-key (current) rows under a single action
 *     filter (the OR-filter requirement reduces to a single broad action
 *     filter at the repo level, per the plan's note).
 *
 * Jest config: jest.slow.config.cjs (integration profile).
 * Pattern source: tests/integration/workflow-central-restart-recovery.test.ts
 * Audit-fetch pattern: tests/integration/workflowCentral-completeTask.test.ts
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
import { AuditLogRepository } from '../../src/database/repositories/AuditLogRepository';
import type { DatabaseService } from '../../src/database/DatabaseService';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'
const ACTION = 'workflow_central.complete_task';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let seq = 0;

async function getDbService(): Promise<DatabaseService> {
  return container.getAsync<DatabaseService>(TYPES.DatabaseService);
}

async function getAuditRepo(): Promise<AuditLogRepository> {
  return container.getAsync<AuditLogRepository>(TYPES.AuditLogRepository);
}

/**
 * Parse the `details` column. SQLite stores JSONB as a TEXT string; Postgres
 * returns the parsed object. The repository's `normalizeRow` already parses
 * the column for us, but we keep a defensive fallback in case a raw row is
 * passed in.
 */
function parseDetails(details: unknown): Record<string, unknown> {
  if (details == null) return {};
  if (typeof details === 'string') {
    try {
      const parsed = JSON.parse(details);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  if (typeof details === 'object') return details as Record<string, unknown>;
  return {};
}

/**
 * Seed a pending task + instance row whose workflow definition is NOT
 * registered with the engine. completeTask via the route will then drop
 * into the `definition_missing` branch (operator service §3.4) and write
 * the new-key audit row (workflow_definition_missing: true).
 *
 * Mirrors the seedOrphanTask() helper in workflowCentral-completeTask.test.ts.
 */
async function seedOrphanTask(): Promise<{ taskId: string; instanceId: string; workflowId: string }> {
  seq++;
  const taskId = `TASK-backcompat-${seq}-${Date.now()}`;
  const instanceId = `INST-backcompat-${seq}`;
  const workflowId = `WF-backcompat-unreg-${seq}`;
  const now = new Date().toISOString();

  const db = (await getDbService()).getDatabase();
  await db
    .insertInto('workflow_central_instances')
    .values({
      id: instanceId,
      tenant_id: TENANT_ID,
      workflow_id: workflowId,
      workflow_name: 'Backcompat WF',
      workflow_version: 1,
      status: 'running',
      current_step_id: 'STEP-X',
      current_step_name: 'Step X',
      variables: '{}',
      step_history: '[]',
      started_by: 'test-op',
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
      id: taskId,
      tenant_id: TENANT_ID,
      instance_id: instanceId,
      workflow_id: workflowId,
      workflow_name: 'Backcompat WF',
      step_id: 'STEP-X',
      step_name: 'Step X',
      task_type: 'task',
      status: 'pending',
      priority: 'low',
      assignee_id: 'nobody',
      assignee_name: 'Nobody',
      description: 'Backcompat orphan task',
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

  return { taskId, instanceId, workflowId };
}

/**
 * Insert a "legacy" PR-OP-2 audit row directly via AuditLogRepository.create()
 * with the OLD details key (`workflow_context_missing`). The id is supplied
 * explicitly because SQLite's `audit_logs.id TEXT PRIMARY KEY` has no default
 * value (see migration 006); production write paths get away with omitting
 * it because SQLite tolerates NULL in TEXT PRIMARY KEY columns, but we must
 * be explicit when we seed multiple rows to keep them distinguishable.
 */
async function seedLegacyAuditRow(resourceId: string): Promise<string> {
  seq++;
  const id = `audit-legacy-${seq}-${Date.now()}`;
  const repo = await getAuditRepo();
  await repo.create({
    id,
    tenant_id: TENANT_ID,
    user_id: 'op_legacy',
    action: ACTION,
    resource_type: 'workflow_central_task',
    resource_id: resourceId,
    old_values: null,
    new_values: null,
    details: {
      tenant_id: TENANT_ID,
      task_id: resourceId,
      completion_result: 'success',
      result_code: 'workflow_definition_missing',
      // Old key — the rename target. Historical PR-OP-2 rows look like this.
      workflow_context_missing: true,
      instance_id: `INST-legacy-${seq}`,
    },
    result: 'success',
    error_message: null,
    duration_ms: 1,
    ip_address: null,
    user_agent: null,
    created_at: new Date().toISOString(),
  });
  return id;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('workflow-central audit-key rename + backcompat reader (T13.3b)', () => {
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
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM workflow_central_instances`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    engine.hydrationReady = true;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // Test #1 — Integration: new code writes the NEW key, never the old one
  // ==========================================================================

  it('integration: completeTask against missing-definition instance writes workflow_definition_missing (NEW key) and does NOT write workflow_context_missing (OLD key)', async () => {
    const { taskId } = await seedOrphanTask();

    const res = await request(app)
      .post(`/api/workflow-central/tasks/${taskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op1' });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.workflowDefinitionMissing).toBe(true);

    // Query the audit via the repo (the canonical reader API: there is no
    // /api/audit HTTP surface in this codebase).
    const repo = await getAuditRepo();
    const rows = await repo.findByAuditFilters({
      actions: [ACTION],
      tenantIds: [TENANT_ID],
    });

    // Filter to the row tied to THIS taskId so we don't get noise from any
    // other test rows that survived (beforeEach wipes them, but be defensive).
    const myRows = rows.filter((r) => r.resource_id === taskId);
    expect(myRows).toHaveLength(1);

    const details = parseDetails(myRows[0].details);

    // Positive assertion: new key present and true.
    expect(details.workflow_definition_missing).toBe(true);
    // Negative assertion: old key MUST NOT be written by current code.
    expect(details).not.toHaveProperty('workflow_context_missing');
  });

  // ==========================================================================
  // Test #2 — Unit-level: legacy old-key rows are still readable
  // ==========================================================================

  it('unit: a legacy PR-OP-2 row written with the OLD key (workflow_context_missing) is returned unchanged by AuditLogRepository.findByAuditFilters', async () => {
    const legacyTaskId = 'T-LEGACY-1';
    await seedLegacyAuditRow(legacyTaskId);

    const repo = await getAuditRepo();
    const rows = await repo.findByAuditFilters({
      actions: [ACTION],
      tenantIds: [TENANT_ID],
    });

    const myRows = rows.filter((r) => r.resource_id === legacyTaskId);
    expect(myRows).toHaveLength(1);

    const details = parseDetails(myRows[0].details);

    // The reader returns the row's `details` payload verbatim — no migration
    // happens at read time. Historical key is preserved as-is.
    expect(details.workflow_context_missing).toBe(true);
    // The legacy row predates the rename, so it MUST NOT carry the new key.
    expect(details).not.toHaveProperty('workflow_definition_missing');
  });

  // ==========================================================================
  // Test #3 — Unit-level: a single action filter returns BOTH old + new rows
  // ==========================================================================

  it('unit: action="workflow_central.complete_task" filter returns BOTH a current-code (new-key) row AND a legacy (old-key) row in the same query result', async () => {
    // (a) Produce a "current code" row via the production route.
    const { taskId: newKeyTaskId } = await seedOrphanTask();
    const completeRes = await request(app)
      .post(`/api/workflow-central/tasks/${newKeyTaskId}/complete`)
      .send({ actionId: 'complete', completedBy: 'op_new' });
    expect(completeRes.status).toBe(200);
    expect(completeRes.body.workflowDefinitionMissing).toBe(true);

    // (b) Seed a legacy row directly with the old key.
    const legacyTaskId = 'T-LEGACY-1';
    await seedLegacyAuditRow(legacyTaskId);

    // (c) Single action filter — no `details` filter exists on the repo
    //     API, so per the plan's IMPLEMENTER NOTE, the "OR over old/new key"
    //     requirement reduces to a single broad action filter here.
    const repo = await getAuditRepo();
    const rows = await repo.findByAuditFilters({
      actions: [ACTION],
      tenantIds: [TENANT_ID],
    });

    // Both rows MUST appear in the result set.
    const newKeyRow = rows.find((r) => r.resource_id === newKeyTaskId);
    const legacyRow = rows.find((r) => r.resource_id === legacyTaskId);
    expect(newKeyRow).toBeDefined();
    expect(legacyRow).toBeDefined();

    const newKeyDetails = parseDetails(newKeyRow!.details);
    const legacyDetails = parseDetails(legacyRow!.details);

    // New row uses ONLY the new key.
    expect(newKeyDetails.workflow_definition_missing).toBe(true);
    expect(newKeyDetails).not.toHaveProperty('workflow_context_missing');

    // Legacy row preserves ONLY the old key.
    expect(legacyDetails.workflow_context_missing).toBe(true);
    expect(legacyDetails).not.toHaveProperty('workflow_definition_missing');
  });
});
