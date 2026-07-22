//
// Source-of-truth invariant (per PR-OP-3 spec):
// All durable workflow instance state is committed in the same task
// transaction. The in-memory Map (in WorkflowEngineService) is a cache
// except for the DLP-excluded `cancellationReason` field, which is a
// best-effort local UI hint — not observable workflow state.
//

import { inject, injectable } from 'inversify';
import { sql } from 'kysely';
import type { Kysely } from 'kysely';
import type { Logger } from '../../utils/Logger';
import { TYPES } from '../../inversify/types';
import type { DatabaseService } from '../../database/DatabaseService';
import type { Database } from '../../database/types';
import type {
  WorkflowCentralInstanceTable,
  WorkflowCentralTaskTable,
} from '../../database/types';
import {
  RaceLostError,
  type CascadePlan,
  type DelegateTaskResult,
  type InstancePatch,
  type ListActivityOptions,
  type NewActivityLogRow,
  type NewInstanceRow,
  type NewTaskRow,
  type PersistedInstance,
  type PersistedTask,
  type WorkflowInstanceMetrics,
} from './types';
import { InvalidLimitError, WorkflowInstanceMissingError } from './errors';
import type { StepExecution, TaskAction, WorkflowActivityLog, WorkflowInstance } from '../WorkflowCentralService';
import {
  ACTIVITY_LOG_DEFAULT_LIMIT,
  ACTIVITY_LOG_MAX_LIMIT,
  ACTIVITY_LOG_MIN_LIMIT,
  recentTerminalHydrationDays,
} from './config';
import { SYSTEM_IDENTITY } from '../governance/identityContext';
import {
  isWorkflowPayloadReference,
  isEphemeralWorkflowPayload,
  type WorkflowPayload,
} from './payload/WorkflowPayload';

// ---------------------------------------------------------------------------
// JSON boundary helpers
// ---------------------------------------------------------------------------

function parseDataOrFallback(text: string, logger?: Logger): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    logger?.warn('workflow_central_tasks.data JSON parse failed; using {} fallback', { err });
    return {};
  }
}

function parseActionsOrFallback(text: string, logger?: Logger): TaskAction[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as TaskAction[]) : [];
  } catch (err) {
    logger?.warn('workflow_central_tasks.actions JSON parse failed; using [] fallback', { err });
    return [];
  }
}

function parseVariablesOrFallback(text: string, logger?: Logger): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch (err) {
    logger?.warn('workflow_central_instances.variables JSON parse failed; using {} fallback', {
      err,
    });
    return {};
  }
}

/**
 * Parse the `payload` column (JSON-serialized WorkflowPayload tagged union)
 * for governance-without-hosting-data Phase 1 (ADR-019). Returns undefined for:
 *   - null/empty column (legacy rows pre-backfill — caller falls back to data/variables)
 *   - malformed JSON
 *   - JSON that doesn't validate as a known WorkflowPayload mode
 * Logs a warn on validation failure; never throws.
 */
function parsePayloadOrUndefined(
  text: string | null,
  context: 'task' | 'instance',
  logger?: Logger,
): WorkflowPayload | undefined {
  if (text === null || text === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    logger?.warn(`workflow_central_${context}s.payload JSON parse failed; falling through to legacy field`, { err });
    return undefined;
  }
  if (isWorkflowPayloadReference(parsed) || isEphemeralWorkflowPayload(parsed)) {
    return parsed;
  }
  logger?.warn(`workflow_central_${context}s.payload shape invalid; falling through to legacy field`);
  return undefined;
}

function parseStepHistoryOrFallback(text: string, logger?: Logger): StepExecution[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as StepExecution[]) : [];
  } catch (err) {
    logger?.warn('workflow_central_instances.step_history JSON parse failed; using [] fallback', {
      err,
    });
    return [];
  }
}

/**
 * DB row → PersistedInstance (snake_case fields preserved).
 * Used by repo methods returning the canonical durable shape.
 */
function rowToPersistedInstance(
  row: WorkflowCentralInstanceTable,
  logger?: Logger,
): PersistedInstance {
  const payload = parsePayloadOrUndefined(row.payload, 'instance', logger);
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    workflow_id: row.workflow_id,
    workflow_name: row.workflow_name,
    workflow_version: row.workflow_version,
    status: row.status as WorkflowInstance['status'],
    current_step_id: row.current_step_id,
    current_step_name: row.current_step_name,
    variables: parseVariablesOrFallback(row.variables, logger),
    step_history: parseStepHistoryOrFallback(row.step_history, logger),
    started_by: row.started_by,
    started_at: row.started_at,
    completed_at: row.completed_at,
    due_at: row.due_at,
    error: row.error,
    paused_from_status: row.paused_from_status as WorkflowInstance['status'] | null,
    created_at: row.created_at,
    updated_at: row.updated_at,
    ...(payload !== undefined ? { payload } : {}),
  };
}

/**
 * DB row → WorkflowInstance (camelCase service-layer shape).
 * Used by `listInstances` per spec §3.5 — service stays a thin
 * pass-through to the repo and the route's pagination metadata
 * (`{ instances, total }`) reaches the response without re-mapping.
 *
 * `cancellationReason` and `pausedFromStatus` are NOT on
 * `WorkflowInstance`; the former is DLP-excluded (D8) and the latter
 * is durable-only state (D23). Both are intentionally absent here.
 */
function rowToWorkflowInstance(
  row: WorkflowCentralInstanceTable,
  logger?: Logger,
): WorkflowInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status as WorkflowInstance['status'],
    currentStepId: row.current_step_id,
    currentStepName: row.current_step_name,
    variables: parseVariablesOrFallback(row.variables, logger),
    stepHistory: parseStepHistoryOrFallback(row.step_history, logger),
    startedBy: row.started_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    error: row.error,
  };
}

// WorkflowInstance public-domain shape does NOT yet surface `payload` — Task 11
// (route layer + getTaskForOperator) handles render via the resolver, not the
// list endpoint. Surfacing it on listInstances responses would force every
// dashboard caller to handle the tagged union — out of scope for Phase 1.

function rowToPersistedTask(row: WorkflowCentralTaskTable, logger?: Logger): PersistedTask {
  const payload = parsePayloadOrUndefined(row.payload, 'task', logger);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    instanceId: row.instance_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    stepId: row.step_id,
    stepName: row.step_name,
    taskType: row.task_type,
    status: row.status,
    priority: row.priority,
    assigneeId: row.assignee_id,
    assigneeName: row.assignee_name,
    description: row.description,
    dueAt: row.due_at,
    data: parseDataOrFallback(row.data, logger),
    actions: parseActionsOrFallback(row.actions, logger),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    completionActionId: row.completion_action_id,
    completionComment: row.completion_comment,
    ...(payload !== undefined ? { payload } : {}),
  };
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

@injectable()
export class WorkflowCentralRepository {
  constructor(
    @inject(TYPES.DatabaseService) private readonly db: DatabaseService,
    @inject(TYPES.Logger) private readonly logger: Logger,
  ) {}

  // ------- Read path -------------------------------------------------------

  async getById(tenantId: string, taskId: string): Promise<PersistedTask | null> {
    const row = await this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    return row ? rowToPersistedTask(row, this.logger) : null;
  }

  /**
   * List tasks for a tenant with optional filters.
   * Sort: priority DESC (urgent>high>medium>low), then created_at DESC.
   * Spec R3 F-05 lock.
   *
   * Priority is a string enum, so a direct `ORDER BY priority DESC` would sort
   * alphabetically (urgent < medium < low < high — wrong). The CASE expression
   * maps to integers for severity-ordered sort. Portable across SQLite + Postgres.
   */
  async listTasks(filters: {
    tenantId: string;
    instanceId?: string;
    status?: 'pending' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
    limit?: number;
    offset?: number;
  }): Promise<PersistedTask[]> {
    let q = this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', filters.tenantId);

    if (filters.instanceId !== undefined) {
      q = q.where('instance_id', '=', filters.instanceId);
    }
    if (filters.status !== undefined) {
      q = q.where('status', '=', filters.status);
    }
    if (filters.priority !== undefined) {
      q = q.where('priority', '=', filters.priority);
    }

    q = q
      .orderBy(
        sql<number>`CASE priority WHEN 'urgent' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END`,
        'desc',
      )
      .orderBy('created_at', 'desc');

    if (filters.limit !== undefined) {
      q = q.limit(filters.limit);
    }
    if (filters.offset !== undefined) {
      q = q.offset(filters.offset);
    }

    const rows = await q.execute();
    return rows.map((r) => rowToPersistedTask(r, this.logger));
  }

  /**
   * Count tasks matching the same filter set as listTasks, IGNORING limit/offset.
   * Used by WorkflowCentralService.getTasks to compute a true total for paginated
   * responses (Codex IMPORTANT-1 R-fix: prior implementation reported `tasks.length`
   * which equals the page size, not the total row count).
   */
  async countTasks(filters: {
    tenantId: string;
    instanceId?: string;
    status?: 'pending' | 'completed' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'urgent';
  }): Promise<number> {
    let q = this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('cnt'))
      .where('tenant_id', '=', filters.tenantId);

    if (filters.instanceId !== undefined) {
      q = q.where('instance_id', '=', filters.instanceId);
    }
    if (filters.status !== undefined) {
      q = q.where('status', '=', filters.status);
    }
    if (filters.priority !== undefined) {
      q = q.where('priority', '=', filters.priority);
    }

    const row = await q.executeTakeFirst();
    // SQLite COUNT returns number; Postgres COUNT returns bigint (string under node-postgres).
    // Coerce defensively at the read boundary so the service-layer always sees a JS number.
    return row ? Number(row.cnt) : 0;
  }

  async listByAssignee(
    tenantId: string,
    assigneeId: string,
    status?: 'pending' | 'completed' | 'cancelled',
  ): Promise<PersistedTask[]> {
    let q = this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('assignee_id', '=', assigneeId);

    if (status !== undefined) {
      q = q.where('status', '=', status);
    }

    const rows = await q.execute();
    return rows.map((r) => rowToPersistedTask(r, this.logger));
  }

  async listByInstance(
    tenantId: string,
    instanceId: string,
    status?: 'pending' | 'completed' | 'cancelled',
  ): Promise<PersistedTask[]> {
    let q = this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('instance_id', '=', instanceId);

    if (status !== undefined) {
      q = q.where('status', '=', status);
    }

    const rows = await q.execute();
    return rows.map((r) => rowToPersistedTask(r, this.logger));
  }

  /** Returns tasks that are pending and past due_at. */
  async listOverdue(tenantId: string, nowIso: string): Promise<PersistedTask[]> {
    const rows = await this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'pending')
      .where('due_at', 'is not', null)
      .where('due_at', '<', nowIso)
      .execute();
    return rows.map((r) => rowToPersistedTask(r, this.logger));
  }

  /**
   * Count overdue pending tasks for a tenant. Mirrors the predicate in
   * listOverdue but returns a count without materialising rows. Copilot R7
   * SHOULD-FIX: getOverdueCount + getMetrics + getDashboard previously
   * called listOverdue 3× per dashboard request just to take .length;
   * countOverdue replaces those with index-friendly SELECT COUNT(*).
   */
  async countOverdue(tenantId: string, nowIso: string): Promise<number> {
    const result = await this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('cnt'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'pending')
      .where('due_at', 'is not', null)
      .where('due_at', '<', nowIso)
      .executeTakeFirstOrThrow();
    return Number(result.cnt);
  }

  async countByStatus(
    tenantId: string,
    status: 'pending' | 'completed' | 'cancelled',
  ): Promise<number> {
    const result = await this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('cnt'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', status)
      .executeTakeFirstOrThrow();
    return Number(result.cnt);
  }

  async countCompletedSince(tenantId: string, sinceIso: string): Promise<number> {
    const result = await this.db
      .getDatabase()
      .selectFrom('workflow_central_tasks')
      .select((eb) => eb.fn.countAll<number>().as('cnt'))
      .where('tenant_id', '=', tenantId)
      .where('status', '=', 'completed')
      .where('completed_at', '>=', sinceIso)
      .executeTakeFirstOrThrow();
    return Number(result.cnt);
  }

  // ------- Write path (tx-taking methods) ----------------------------------

  /**
   * Single-row INSERT; throws on PK collision. No onConflict clause by design.
   * Caller supplies the id in the existing TASK-${Date.now()}-... format.
   */
  async insertTask(tx: Kysely<Database>, row: NewTaskRow): Promise<void> {
    await tx
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
        data: JSON.stringify(row.data ?? {}),
        actions: JSON.stringify(row.actions ?? []),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
        payload: row.payload ? JSON.stringify(row.payload) : null,
      })
      .execute();
  }

  /**
   * Atomic UPDATE parent + INSERTs cascade children.
   *
   * Spec §5 T2 contract:
   * 1. UPDATE the parent row with status='completed', sets completion fields
   *    and optionally merges data.
   * 2. Assert rowcount == 1 — else throw (race: parallel writer stole the row).
   * 3. INSERT each downstream task row. Throws on first failure (tx rollback).
   * 4. Re-read parent for canonical post-update view.
   */
  async completeTaskAtomicWithCascade(
    tx: Kysely<Database>,
    tenantId: string,
    taskId: string,
    completion: {
      completedBy: string;
      completedAt: string;
      actionId: string;
      comment?: string;
      data?: Record<string, unknown>;
    },
    plan: CascadePlan,
  ): Promise<{ updatedTask: PersistedTask; insertedIds: string[] }> {
    const now = completion.completedAt;

    // 1. If caller supplied data to merge, read the current row and merge.
    // Lookup is by (tenant_id, id) ONLY — NOT gated on status='pending'.
    // Copilot R7 SHOULD-FIX: a prior version filtered on status='pending'
    // here, which would silently fall back to '{}' if the row existed but
    // was already dispositioned. The CAS race is handled by the UPDATE's
    // WHERE-status guard below (rowcount=0 → RaceLostError →
    // already_dispositioned); dropping the SELECT's status filter removes
    // the fragile coupling where any future loosening of the UPDATE guard
    // would turn the read-fallback into silent data loss.
    //
    // Copilot R12 SHOULD-FIX: when completion.data is absent/empty there
    // is nothing to merge, and re-writing the existing data column would
    // be a no-op. Skip the SELECT AND the data UPDATE column entirely in
    // that case — saves a round-trip per completion.
    const mergeData = !!(completion.data && Object.keys(completion.data).length > 0);
    let mergedData: string | undefined;
    if (mergeData) {
      const current = await tx
        .selectFrom('workflow_central_tasks')
        .select('data')
        .where('tenant_id', '=', tenantId)
        .where('id', '=', taskId)
        .executeTakeFirst();
      const existingData = current ? parseDataOrFallback(current.data, this.logger) : {};
      mergedData = JSON.stringify({ ...existingData, ...completion.data });
    }

    // 2. UPDATE parent row — WHERE status='pending' guards against race.
    const updateResult = await tx
      .updateTable('workflow_central_tasks')
      .set({
        status: 'completed',
        completed_at: now,
        completed_by: completion.completedBy,
        completion_action_id: completion.actionId,
        completion_comment: completion.comment ?? null,
        ...(mergedData !== undefined ? { data: mergedData } : {}),
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .where('status', '=', 'pending')
      .execute();

    const updatedCount = updateResult.reduce(
      (sum, r) => sum + Number(r.numUpdatedRows ?? 0),
      0,
    );
    if (updatedCount === 0) {
      // Codex SHOULD-FIX: in-tx CAS race-loss (rowcount=0 after a pre-flight
      // SELECT showed pending) is semantically already_dispositioned, not a
      // cascade failure. Throw a typed error so the operator service can
      // distinguish race-loss (→ 409) from a downstream INSERT failure (→ 500).
      throw new RaceLostError(
        `race lost during cascade for task ${taskId} in tenant ${tenantId}`,
      );
    }

    // 3. INSERT downstream rows — throw on first failure; tx auto-rolls back.
    const insertedIds: string[] = [];
    for (const downstream of plan.downstreamTaskRows) {
      await this.insertTask(tx, downstream);
      insertedIds.push(downstream.id);
    }

    // 4. Re-read parent for canonical post-update state.
    const updatedRow = await tx
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .executeTakeFirstOrThrow();

    return { updatedTask: rowToPersistedTask(updatedRow, this.logger), insertedIds };
  }

  /**
   * Cancel all pending tasks for an instance.
   * Returns the cancelled task IDs in created_at ASC, id ASC order (spec R5 F-05
   * deterministic 100-cap).
   */
  async cancelPendingForInstance(
    tx: Kysely<Database>,
    tenantId: string,
    instanceId: string,
  ): Promise<string[]> {
    // SELECT first to capture IDs in deterministic order.
    const rows = await tx
      .selectFrom('workflow_central_tasks')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('instance_id', '=', instanceId)
      .where('status', '=', 'pending')
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .execute();

    if (rows.length === 0) {
      return [];
    }

    const ids = rows.map((r) => r.id);
    const now = new Date().toISOString();

    // Codex R6 HIGH: UPDATE re-asserts `status = 'pending'` as a CAS guard.
    // Without it, a concurrent writer that completes one of these rows
    // between our SELECT and UPDATE would have its `completed` overwritten
    // back to `cancelled` (data corruption). With the guard, the racing
    // row stays `completed` and our UPDATE silently skips it.
    //
    // Returned `ids` reflects the SELECT snapshot — which is the set of
    // rows we ATTEMPTED to cancel. Audit consumers should treat this as
    // "tasks targeted for cancellation"; the actual cancelled set is the
    // intersection of `ids` with the post-UPDATE pending set (very rare to
    // differ in practice — concurrent complete-during-cancel is a niche
    // race). The trade-off keeps the audit shape stable + transactional.
    await tx
      .updateTable('workflow_central_tasks')
      .set({ status: 'cancelled', updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('id', 'in', ids)
      .where('status', '=', 'pending')
      .execute();

    return ids;
  }

  /**
   * Delegate a pending task to a new assignee.
   *
   * Uses SELECT-then-UPDATE pattern per spec R4 F-01 lock.
   * NEVER uses UPDATE...RETURNING — on Kysely 0.28.17 + better-sqlite3,
   * RETURNING yields POST-update values, not pre-update values.
   *
   * Returns null if the row does not exist as pending (not found or
   * already dispositioned).
   */
  async delegatePendingTask(
    tx: Kysely<Database>,
    tenantId: string,
    taskId: string,
    newAssigneeId: string,
    newAssigneeName: string,
  ): Promise<DelegateTaskResult | null> {
    // 1. SELECT to capture the pre-update assignee_id, filtered by tenant +
    //    status='pending'.
    const existing = await tx
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .where('status', '=', 'pending')
      .executeTakeFirst();

    if (!existing) return null;

    const now = new Date().toISOString();

    // 2. UPDATE with the same WHERE guards (re-checks status='pending' to
    //    guard against tx anomalies).
    const updateResult = await tx
      .updateTable('workflow_central_tasks')
      .set({
        assignee_id: newAssigneeId,
        assignee_name: newAssigneeName,
        updated_at: now,
      })
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .where('status', '=', 'pending')
      .execute();

    const updated = updateResult.reduce(
      (sum, r) => sum + Number(r.numUpdatedRows ?? 0),
      0,
    );
    if (updated === 0) return null;

    // 3. Re-read for canonical post-update row state.
    const updatedRow = await tx
      .selectFrom('workflow_central_tasks')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .executeTakeFirst();

    if (!updatedRow) return null;

    return {
      updatedTask: rowToPersistedTask(updatedRow, this.logger),
      previousAssigneeId: existing.assignee_id, // PRE-update value captured in step 1
    };
  }

  // ==========================================================================
  // Instance-side methods (PR-OP-3 — durable workflow instance state)
  // ==========================================================================

  /**
   * INSERT a new instance row inside the supplied TX. Returns the persisted
   * row (snake_case). No onConflict clause — D20's race-safe ignore is reserved
   * for `catchUpBackfill`; first-write paths should fail loudly on PK
   * collision so cleanup logic (engine.deleteInstance in PR-OP-2 callers, or
   * deferred Map.set in §3.2 step 6) can roll back deterministically.
   */
  async insertInstance(
    tx: Kysely<Database>,
    row: NewInstanceRow,
  ): Promise<PersistedInstance> {
    const nowIso = new Date().toISOString();
    const result = await tx
      .insertInto('workflow_central_instances')
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        workflow_id: row.workflowId,
        workflow_name: row.workflowName,
        workflow_version: row.workflowVersion,
        status: row.status,
        current_step_id: row.currentStepId,
        current_step_name: row.currentStepName,
        variables: JSON.stringify(row.variables),
        step_history: JSON.stringify(row.stepHistory),
        started_by: row.startedBy,
        started_at: row.startedAt,
        completed_at: row.completedAt,
        due_at: row.dueAt,
        error: row.error,
        paused_from_status: row.pausedFromStatus,
        created_at: nowIso,
        updated_at: nowIso,
        payload: row.payload ? JSON.stringify(row.payload) : null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return rowToPersistedInstance(result, this.logger);
  }

  /**
   * Locking read of an instance row. D6: SQLite has no FOR UPDATE syntax;
   * Postgres needs it explicitly. Kysely's `modifyEnd` is the lowest-
   * coupling way to append the clause only when dialect is postgres.
   */
  async selectInstanceForUpdate(
    tx: Kysely<Database>,
    tenantId: string,
    id: string,
  ): Promise<PersistedInstance | null> {
    let qb = tx
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id);
    if (this.db.getDbType() === 'postgres') {
      qb = qb.modifyEnd(sql`FOR UPDATE`);
    }
    const row = await qb.executeTakeFirst();
    return row ? rowToPersistedInstance(row, this.logger) : null;
  }

  /**
   * D24 NON-locking sibling of `selectInstanceForUpdate`. Used by routes
   * outside a mutating TX (via `engine.getInstanceFromAnywhere`) to read
   * terminal rows older than the recent-terminal hydration window (D16).
   * MUST NOT be used inside a mutating TX — the row lock is required there.
   */
  async getInstanceById(
    tenantId: string,
    id: string,
  ): Promise<PersistedInstance | null> {
    const row = await this.db
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirst();
    return row ? rowToPersistedInstance(row, this.logger) : null;
  }

  /**
   * D12: lightweight non-locking lookup used by `completeTask`'s
   * deadlock-safe instance-first lock order (spec §3.2 step 1). Returns
   * just enough to find the instance row to lock. Returns camelCase
   * `{ instanceId }` at the DTO boundary — the repo is the column↔DTO
   * conversion layer.
   */
  async selectTaskInstanceId(
    tx: Kysely<Database>,
    tenantId: string,
    taskId: string,
  ): Promise<{ instanceId: string } | null> {
    const row = await tx
      .selectFrom('workflow_central_tasks')
      .select('instance_id')
      .where('tenant_id', '=', tenantId)
      .where('id', '=', taskId)
      .executeTakeFirst();
    return row ? { instanceId: row.instance_id } : null;
  }

  /**
   * Switchboard for instance-row mutations driven by each operator action.
   * D25: throws `WorkflowInstanceMissingError` (NOT `RaceLostError`) when
   * rowcount === 0 — this path is reached AFTER the caller held a row lock
   * via `selectInstanceForUpdate`, so a missing row is an invariant breach
   * (mapped to 500 + WARN), not a CAS race.
   *
   * The RESERVED `delegateTask` / `startInstance` kinds exist for exhaustive
   * typing; receiving one at runtime indicates a wiring bug and throws.
   */
  async updateInstanceForTenant(
    tx: Kysely<Database>,
    tenantId: string,
    id: string,
    patch: InstancePatch,
  ): Promise<PersistedInstance> {
    // Build the snake_case update set from the camelCase patch.
    // `unknown` here keeps us off `any` — Kysely's UpdateExpression on the
    // instance table accepts each of these keys structurally.
    const updates: Record<string, unknown> = {};

    switch (patch.kind) {
      case 'completeTask': {
        // Append to step_history JSON. Read first so we can merge.
        const current = await tx
          .selectFrom('workflow_central_instances')
          .select('step_history')
          .where('tenant_id', '=', tenantId)
          .where('id', '=', id)
          .executeTakeFirst();
        if (!current) {
          throw new WorkflowInstanceMissingError(tenantId, id);
        }
        const history = parseStepHistoryOrFallback(current.step_history, this.logger);
        history.push(patch.stepHistoryAppend);
        updates.current_step_id = patch.currentStepId;
        updates.current_step_name = patch.currentStepName;
        updates.step_history = JSON.stringify(history);
        if (patch.status !== undefined) updates.status = patch.status;
        if (patch.completedAt !== undefined) updates.completed_at = patch.completedAt;
        updates.updated_at = patch.updatedAt;
        break;
      }
      case 'cancelInstance': {
        updates.status = patch.status;
        updates.completed_at = patch.completedAt;
        updates.paused_from_status = null; // D22 + D23 symmetry: clear on terminal
        updates.updated_at = patch.updatedAt;
        break;
      }
      case 'pauseInstance': {
        updates.status = patch.status;
        updates.paused_from_status = patch.pausedFromStatus;
        updates.updated_at = patch.updatedAt;
        break;
      }
      case 'resumeInstance': {
        updates.status = patch.status; // D23: restored pre-pause status
        updates.paused_from_status = null; // D23 clear
        updates.updated_at = patch.updatedAt;
        break;
      }
      case 'delegateTask':
      case 'startInstance':
        // Reserved-but-unused at runtime — defensive throw per types.ts.
        throw new Error(
          `updateInstanceForTenant received reserved patch kind: ${patch.kind}`,
        );
    }

    // UPDATE + count rows. We rely on numUpdatedRows rather than RETURNING
    // for the rowcount check because Kysely's better-sqlite3 driver reports
    // it deterministically; the post-update re-read below gives us the
    // canonical row shape regardless of dialect.
    const updateResult = await tx
      .updateTable('workflow_central_instances')
      .set(updates)
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .execute();

    const updatedCount = updateResult.reduce(
      (sum, r) => sum + Number(r.numUpdatedRows ?? 0),
      0,
    );
    if (updatedCount === 0) {
      throw new WorkflowInstanceMissingError(tenantId, id);
    }

    // Re-read for canonical post-update view (deterministic across dialects).
    const updatedRow = await tx
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', tenantId)
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
    return rowToPersistedInstance(updatedRow, this.logger);
  }

  /**
   * Eager-hydration query: all non-terminal rows + recent-terminal rows
   * within `recentTerminalHydrationDays` (D16). Optionally tenant-filtered;
   * the unfiltered form is the default for server boot.
   */
  async listInstancesForHydration(tenantId?: string): Promise<PersistedInstance[]> {
    const cutoffIso = new Date(
      Date.now() - recentTerminalHydrationDays * 86_400_000,
    ).toISOString();
    let qb = this.db
      .getDatabase()
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where((eb) =>
        eb.or([
          eb('status', 'not in', ['completed', 'cancelled', 'failed']),
          eb.and([
            eb('status', 'in', ['completed', 'cancelled', 'failed']),
            eb('completed_at', '>=', cutoffIso),
          ]),
        ]),
      );
    if (tenantId !== undefined) {
      qb = qb.where('tenant_id', '=', tenantId);
    }
    const rows = await qb.orderBy('started_at', 'desc').execute();
    return rows.map((r) => rowToPersistedInstance(r, this.logger));
  }

  /**
   * General-list query for `GET /instances?status=…` routes AND dashboard
   * recents (Task 9 unwraps `.instances` and discards `.total`).
   *
   * Return shape `{ instances, total }` matches the existing
   * `service.getInstances` contract EXACTLY so the service body stays a
   * thin pass-through and the route's pagination metadata reaches the
   * response. Returning `WorkflowInstance[]` would silently drop `total`.
   *
   * NOT bounded by `recentTerminalHydrationDays` — terminal rows older
   * than D16's window ARE returned (unlike `engine.getInstances`).
   */
  async listInstances(
    tenantId: string,
    filters?: {
      status?: WorkflowInstance['status'];
      statuses?: WorkflowInstance['status'][];
      workflowId?: string;
      startedBy?: string;
      limit?: number;
      offset?: number;
      orderBy?: 'started_at DESC' | 'started_at ASC';
    },
  ): Promise<{ instances: WorkflowInstance[]; total: number }> {
    const db = this.db.getDatabase();
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    const orderDir: 'asc' | 'desc' =
      filters?.orderBy === 'started_at ASC' ? 'asc' : 'desc';

    // `statuses` (multi-value) takes precedence over `status` (single value)
    // only when `statuses` is non-empty. An empty `statuses` array is treated
    // as "no multi-status filter" and falls back to the single `status`
    // predicate (matches the unit test at `WorkflowCentralRepository.test.ts`
    // → "empty statuses array falls back to the single `status` filter").
    // The route uses this to translate the synthetic `?status=active` into
    // `running|waiting|unknown_recovered` (spec §3.5).
    const useStatuses =
      filters?.statuses !== undefined && filters.statuses.length > 0;

    // Page query.
    let pageQb = db
      .selectFrom('workflow_central_instances')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (useStatuses) {
      pageQb = pageQb.where('status', 'in', filters!.statuses!);
    } else if (filters?.status !== undefined) {
      pageQb = pageQb.where('status', '=', filters.status);
    }
    if (filters?.workflowId !== undefined) {
      pageQb = pageQb.where('workflow_id', '=', filters.workflowId);
    }
    if (filters?.startedBy !== undefined) {
      pageQb = pageQb.where('started_by', '=', filters.startedBy);
    }
    const pageRows = await pageQb
      .orderBy('started_at', orderDir)
      .limit(limit)
      .offset(offset)
      .execute();

    // Count query — same predicate, no limit/offset. `total` is the
    // PRE-PAGINATION count. Regression net: a 13-row seed with limit:5
    // must return `total === 13`, NOT `total === 5` (page length).
    let countQb = db
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('tenant_id', '=', tenantId);
    if (useStatuses) {
      countQb = countQb.where('status', 'in', filters!.statuses!);
    } else if (filters?.status !== undefined) {
      countQb = countQb.where('status', '=', filters.status);
    }
    if (filters?.workflowId !== undefined) {
      countQb = countQb.where('workflow_id', '=', filters.workflowId);
    }
    if (filters?.startedBy !== undefined) {
      countQb = countQb.where('started_by', '=', filters.startedBy);
    }
    const countRow = await countQb.executeTakeFirstOrThrow();

    return {
      instances: pageRows.map((r) => rowToWorkflowInstance(r, this.logger)),
      total: Number(countRow.c),
    };
  }

  /**
   * SQL aggregation for the INSTANCE-derived subset of `WorkflowMetrics`.
   * Returns `WorkflowInstanceMetrics` — NOT the full `WorkflowMetrics` shape.
   * Definition counts (`totalWorkflows`/`activeWorkflows`) stay on the engine
   * Map; task counts (`pendingTasks`/`overdueTasks`/`tasksCompletedToday`)
   * stay on PR-OP-2 repo methods. `WorkflowCentralService.getMetrics()`
   * merges all three sources.
   *
   * Full-table — NOT bounded by `recentTerminalHydrationDays`. The instance
   * fields would otherwise become partial after restart.
   */
  async computeMetrics(tenantId: string): Promise<WorkflowInstanceMetrics> {
    const db = this.db.getDatabase();
    const dbType = this.db.getDbType();

    // 1. Status counts via GROUP BY (one query).
    const byStatus = await db
      .selectFrom('workflow_central_instances')
      .select(['status', (eb) => eb.fn.countAll<number>().as('c')])
      .where('tenant_id', '=', tenantId)
      .groupBy('status')
      .execute();
    const statusCount: Record<string, number> = {};
    for (const r of byStatus) {
      statusCount[r.status] = Number(r.c);
    }
    const totalInstances = Object.values(statusCount).reduce((s, n) => s + n, 0);
    const runningInstances =
      (statusCount.running ?? 0) + (statusCount.waiting ?? 0);
    const completedInstances = statusCount.completed ?? 0;
    const failedInstances = statusCount.failed ?? 0;

    // 2. Average completion time — dialect-conditional date arithmetic.
    // Returns HOURS rounded to 1 decimal, matching the existing in-memory
    // computation at WorkflowCentralService.ts:288-294.
    const avgQuery =
      dbType === 'sqlite'
        ? sql<{ avg_hours: number | null }>`
            SELECT AVG((julianday(completed_at) - julianday(started_at)) * 24) AS avg_hours
            FROM workflow_central_instances
            WHERE tenant_id = ${tenantId} AND completed_at IS NOT NULL
          `
        : sql<{ avg_hours: number | null }>`
            SELECT AVG(EXTRACT(EPOCH FROM (completed_at - started_at)) / 3600.0) AS avg_hours
            FROM workflow_central_instances
            WHERE tenant_id = ${tenantId} AND completed_at IS NOT NULL
          `;
    const avgRow = await avgQuery.execute(db);
    const avgRaw = avgRow.rows[0]?.avg_hours ?? 0;
    const avgCompletionTime = avgRaw
      ? Math.round(Number(avgRaw) * 10) / 10
      : 0;

    // 3. SLA compliance — % of {completed AND has dueAt} completed on time.
    // Matches WorkflowCentralService.ts:301-304 (100 when denominator is 0).
    const slaQuery =
      dbType === 'sqlite'
        ? sql<{ on_time: number; total: number }>`
            SELECT
              SUM(CASE WHEN completed_at <= due_at THEN 1 ELSE 0 END) AS on_time,
              COUNT(*) AS total
            FROM workflow_central_instances
            WHERE tenant_id = ${tenantId} AND due_at IS NOT NULL AND completed_at IS NOT NULL
          `
        : sql<{ on_time: number; total: number }>`
            SELECT
              COUNT(*) FILTER (WHERE completed_at <= due_at) AS on_time,
              COUNT(*) AS total
            FROM workflow_central_instances
            WHERE tenant_id = ${tenantId} AND due_at IS NOT NULL AND completed_at IS NOT NULL
          `;
    const slaRow = await slaQuery.execute(db);
    const slaTotal = Number(slaRow.rows[0]?.total ?? 0);
    const slaOnTime = Number(slaRow.rows[0]?.on_time ?? 0);
    const slaComplianceRate =
      slaTotal > 0 ? Math.round((slaOnTime / slaTotal) * 1000) / 10 : 100;

    // 4. instancesStartedToday — single COUNT with midnight bound.
    const todayIso = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();
    const startedTodayRow = await db
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .where('tenant_id', '=', tenantId)
      .where('started_at', '>=', todayIso)
      .executeTakeFirstOrThrow();
    const instancesStartedToday = Number(startedTodayRow.c);

    return {
      totalInstances,
      runningInstances,
      completedInstances,
      failedInstances,
      avgCompletionTime,
      slaComplianceRate,
      instancesStartedToday,
    };
  }

  /**
   * Runtime variant of migration 042's backfill. Synthesizes instance rows
   * from any orphan tasks (tasks whose (tenant_id, instance_id) has no
   * matching instance row). Idempotent via dialect-conditional conflict-
   * ignore: `INSERT OR IGNORE` on SQLite, `ON CONFLICT (id) DO NOTHING`
   * on Postgres.
   *
   * D20: target the PK (`id`), NOT `(tenant_id, id)`. The PK fires first
   * even with the redundant UNIQUE constraint; targeting the composite
   * would never match (memory: feedback_on_conflict_must_match_pk).
   *
   * Returns the count of newly-recovered rows (post-INSERT - pre-INSERT).
   */
  async catchUpBackfill(): Promise<{ recovered: number }> {
    const nowIso = new Date().toISOString();
    const db = this.db.getDatabase();
    const before = await db
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirstOrThrow();

    if (this.db.getDbType() === 'sqlite') {
      await sql`
        INSERT OR IGNORE INTO workflow_central_instances (
          id, tenant_id, workflow_id, workflow_name, workflow_version, status,
          current_step_id, current_step_name, variables, step_history,
          started_by, started_at, completed_at, due_at, error, paused_from_status,
          created_at, updated_at
        )
        SELECT
          recent.instance_id,
          recent.tenant_id,
          recent.workflow_id,
          recent.workflow_name,
          1,
          'unknown_recovered',
          recent.step_id,
          recent.step_name,
          '{}',
          '[]',
          ${SYSTEM_IDENTITY.userId},
          recent.first_started_at,
          NULL,
          NULL,
          NULL,
          NULL,
          ${nowIso},
          ${nowIso}
        FROM (
          SELECT
            t.tenant_id,
            t.instance_id,
            t.workflow_id,
            t.workflow_name,
            t.step_id,
            t.step_name,
            (
              SELECT MIN(created_at)
              FROM workflow_central_tasks
              WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ) AS first_started_at
          FROM workflow_central_tasks t
          WHERE t.id = (
            SELECT id FROM workflow_central_tasks
            WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ORDER BY
              (CASE status WHEN 'pending' THEN 0 ELSE 1 END),
              created_at DESC,
              id ASC
            LIMIT 1
          )
        ) recent
      `.execute(db);
    } else {
      await sql`
        INSERT INTO workflow_central_instances (
          id, tenant_id, workflow_id, workflow_name, workflow_version, status,
          current_step_id, current_step_name, variables, step_history,
          started_by, started_at, completed_at, due_at, error, paused_from_status,
          created_at, updated_at
        )
        SELECT
          recent.instance_id,
          recent.tenant_id,
          recent.workflow_id,
          recent.workflow_name,
          1,
          'unknown_recovered',
          recent.step_id,
          recent.step_name,
          '{}',
          '[]',
          ${SYSTEM_IDENTITY.userId},
          CAST(recent.first_started_at AS TIMESTAMP),
          NULL,
          NULL,
          NULL,
          NULL,
          CAST(${nowIso} AS TIMESTAMP),
          CAST(${nowIso} AS TIMESTAMP)
        FROM (
          SELECT
            t.tenant_id,
            t.instance_id,
            t.workflow_id,
            t.workflow_name,
            t.step_id,
            t.step_name,
            (
              SELECT MIN(created_at)
              FROM workflow_central_tasks
              WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ) AS first_started_at
          FROM workflow_central_tasks t
          WHERE t.id = (
            SELECT id FROM workflow_central_tasks
            WHERE tenant_id = t.tenant_id AND instance_id = t.instance_id
            ORDER BY
              (CASE status WHEN 'pending' THEN 0 ELSE 1 END),
              created_at DESC,
              id ASC
            LIMIT 1
          )
        ) recent
        ON CONFLICT (id) DO NOTHING
      `.execute(db);
    }

    const after = await db
      .selectFrom('workflow_central_instances')
      .select((eb) => eb.fn.countAll<number>().as('c'))
      .executeTakeFirstOrThrow();
    return { recovered: Number(after.c) - Number(before.c) };
  }

  // =========================================================================
  // Activity logs (PR-OP-3b)
  //
  // Best-effort write-side: callers tee `insertActivityLog` off the existing
  // `safeAudit` block. Failures are caught + WARN + counter at the caller, never
  // bubbled — matches the audit-delivery contract from PR-OP-3 D15.
  //
  // Read-side: `listRecentActivityForTenant(tenantId, opts)` is the only
  // public read API. Tenant-scoped at the SQL boundary; no cross-tenant
  // fall-through.
  // =========================================================================

  // Bounds live in workflowCentral/config.ts so both the repo and the route
  // can import without the route having to pull in this module just for the
  // constants. Static re-exports kept as deprecated aliases for any external
  // caller that might still reference them. Copilot R4.
  /** @deprecated import { ACTIVITY_LOG_DEFAULT_LIMIT } from './config' instead. */
  static readonly ACTIVITY_LOG_DEFAULT_LIMIT = ACTIVITY_LOG_DEFAULT_LIMIT;
  /** @deprecated import { ACTIVITY_LOG_MAX_LIMIT } from './config' instead. */
  static readonly ACTIVITY_LOG_MAX_LIMIT = ACTIVITY_LOG_MAX_LIMIT;

  /**
   * INSERT a new activity-log row. No transaction parameter — activity rows
   * are written outside the request TX so a failed activity insert never
   * rolls back the operator action that produced it. The caller is responsible
   * for the surrounding try/catch + WARN + counter increment.
   */
  async insertActivityLog(row: NewActivityLogRow): Promise<void> {
    const db = this.db.getDatabase();
    await db
      .insertInto('workflow_central_activity_logs')
      .values({
        id: row.id,
        tenant_id: row.tenantId,
        instance_id: row.instanceId,
        workflow_name: row.workflowName,
        action: row.action,
        user_id: row.userId,
        user_name: row.userName,
        step_name: row.stepName,
        details: row.details,
        timestamp: row.timestamp,
      })
      .execute();
  }

  /**
   * Read the most-recent activity rows for `tenantId`, ordered timestamp DESC.
   * Optional `instanceId` filter narrows to a single instance for the
   * drilldown case. `limit` is bounded by `[1, ACTIVITY_LOG_MAX_LIMIT]`;
   * out-of-range values throw `InvalidLimitError` (route → 400).
   *
   * NOTE: the read is unconditionally tenant-scoped at the SQL `WHERE`. There
   * is no overload that omits `tenantId` — masked-but-real cross-tenant leak
   * defense (the previous in-memory Map had no tenant arg, so the moment a
   * writer existed it would have leaked).
   */
  async listRecentActivityForTenant(
    tenantId: string,
    opts: ListActivityOptions = {},
  ): Promise<WorkflowActivityLog[]> {
    const limit = this.validateLimit(opts.limit);
    const db = this.db.getDatabase();
    let qb = db
      .selectFrom('workflow_central_activity_logs')
      .selectAll()
      .where('tenant_id', '=', tenantId);
    if (opts.instanceId !== undefined) {
      qb = qb.where('instance_id', '=', opts.instanceId);
    }
    // Tiebreaker on `id` for stable ordering when multiple rows share the same
    // millisecond timestamp (write sites all use `new Date().toISOString()` —
    // same-tick inserts are realistic). Without this, the feed can reshuffle
    // between reads, which is user-visible. id is a UUID; DESC vs ASC is
    // arbitrary but stable. Codex R1 Medium.
    const rows = await qb
      .orderBy('timestamp', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
    return rows.map(rowToWorkflowActivityLog);
  }

  private validateLimit(received: unknown): number {
    if (received === undefined) {
      return ACTIVITY_LOG_DEFAULT_LIMIT;
    }
    if (typeof received !== 'number' || !Number.isInteger(received)) {
      throw new InvalidLimitError(received, ACTIVITY_LOG_MIN_LIMIT, ACTIVITY_LOG_MAX_LIMIT);
    }
    if (received < ACTIVITY_LOG_MIN_LIMIT || received > ACTIVITY_LOG_MAX_LIMIT) {
      throw new InvalidLimitError(received, ACTIVITY_LOG_MIN_LIMIT, ACTIVITY_LOG_MAX_LIMIT);
    }
    return received;
  }

  /**
   * Sweep ephemeral_hosted payloads whose `expiresAt` is in the past and NULL
   * out the `payload` column. Implements the proactive-deletion contract from
   * ADR-019 — lazy-expiry (on read in WorkflowCentralOperatorService) still
   * returns 410 to callers, this complements it by ensuring expired data does
   * not sit indefinitely on disk after the last read.
   *
   * Strategy: fetch candidate rows via a cross-DB-portable LIKE pre-filter
   * (`payload LIKE '%"ephemeral_hosted"%'`). The DB still evaluates the
   * predicate across all non-null payload rows (without an index on
   * `payload LIKE ...` the storage-layer scan is unchanged), but the
   * result set returned to the application — and therefore the
   * network round-trip plus Node-side JSON.parse cost — is reduced to
   * just the ephemeral-shaped rows. Storage-layer skip would require a
   * partial index or generated column (documented in the proof card's
   * Known Gaps as a future enhancement). Survivors are JSON-parsed in
   * Node and filtered for shape-valid expired ephemeral payloads.
   * UPDATEs are chunked at 500 ids per batch to stay below SQLite's
   * default 999-parameter limit (Postgres's ~64k is far more
   * permissive). Avoids dual-DB JSON-SQL incompatibility (SQLite
   * `json_extract` vs Postgres `->>`).
   *
   * Row-level: NEVER delete the row. Two columns are scrubbed:
   *   - `payload` is set to SQL NULL (the new contract surface).
   *   - The legacy mirror field (`data` for tasks, `variables` for
   *     instances) is reset to `'{}'`. The operator's legacy-fallback
   *     branch reads this field when payload is NULL; without the
   *     reset, expired ephemeral data mirrored into the legacy column
   *     would remain renderable as `kind='legacy'` AFTER the sweep,
   *     undercutting the data-liability contract this method delivers.
   *     The legacy columns are scheduled for removal in a future
   *     migration (CLAUDE.md Phase 1 follow-up); until then, the
   *     reaper must scrub both surfaces.
   *
   * Errors are isolated per table (independent try/catch) so a failure on
   * one table does not poison the other — matches `EmbeddedRetentionJob`
   * best-effort cleanup stance.
   */
  async clearExpiredEphemeralPayloads(now: Date): Promise<{
    tasksCleared: number;
    instancesCleared: number;
  }> {
    const db = this.db.getDatabase();
    const cutoffMs = now.getTime();

    // Per-table try/catch — a failure on one table (e.g. a transient DB
    // hiccup, stray FK, etc.) MUST NOT block the other table from running.
    // Matches the EmbeddedRetentionJob best-effort cleanup stance and
    // honors the contract stated above. Per-table failures emit
    // structured-log entries and return 0 for that table's counter so
    // partial counts are still observable.
    let tasksCleared = 0;
    let instancesCleared = 0;
    try {
      tasksCleared = await this.clearExpiredEphemeralOnTable(
        db,
        'workflow_central_tasks',
        cutoffMs,
      );
    } catch (err) {
      // Logger.error: Error as 2nd arg, metadata as 3rd. Non-Error 2nd arg
      // is silently dropped (feedback-logger-error-metadata-position-bug).
      // Metadata key MUST be `errorMessage` not `error` — Logger overwrites
      // `context.error` with the Error AFTER spreading metadata, so a
      // `metadata.error` string would be clobbered (Copilot R8 on PR #829).
      this.logger.error(
        '[WorkflowCentralRepository] clearExpiredEphemeralPayloads tasks sweep failed',
        err instanceof Error ? err : undefined,
        { errorMessage: err instanceof Error ? err.message : String(err) },
      );
    }
    try {
      instancesCleared = await this.clearExpiredEphemeralOnTable(
        db,
        'workflow_central_instances',
        cutoffMs,
      );
    } catch (err) {
      this.logger.error(
        '[WorkflowCentralRepository] clearExpiredEphemeralPayloads instances sweep failed',
        err instanceof Error ? err : undefined,
        { errorMessage: err instanceof Error ? err.message : String(err) },
      );
    }

    return { tasksCleared, instancesCleared };
  }

  private async clearExpiredEphemeralOnTable(
    db: Kysely<Database>,
    table: 'workflow_central_tasks' | 'workflow_central_instances',
    cutoffMs: number,
  ): Promise<number> {
    // Cross-DB portable pre-filter — application-side optimization, NOT a
    // storage-layer-skip. Without an index on `payload LIKE ...`, the DB
    // still evaluates the LIKE predicate across all non-null payload rows.
    // What this saves is downstream cost: the network round-trip carries
    // fewer rows back to the app, and Node-side JSON.parse runs only on
    // the ephemeral-shaped survivors instead of every external_reference
    // payload. False positives (e.g., an external_reference whose
    // `evaluationHints.note` text contains the substring) are filtered
    // out in Node by `isExpiredEphemeralPayload` (which delegates to the
    // canonical `isEphemeralWorkflowPayload` predicate).
    //
    // Storage-layer skip would require a partial index on
    // `payload LIKE '%ephemeral_hosted%'` (Postgres) or a generated
    // column; documented in the proof card's Known Gaps as a future
    // enhancement for multi-million-row workflow tables.
    const rows = await db
      .selectFrom(table)
      .select(['id', 'payload'])
      .where('payload', 'is not', null)
      .where('payload', 'like', '%"ephemeral_hosted"%')
      .execute();

    const idsToClear = rows
      .filter((r) => isExpiredEphemeralPayload(r.payload, cutoffMs))
      .map((r) => r.id);

    if (idsToClear.length === 0) return 0;

    // Chunk UPDATEs to avoid SQLite's default 999-parameter limit on a single
    // statement (a stricter floor than Postgres's ~64k, so chunking at 500
    // keeps both dialects safe). `WHERE payload IS NOT NULL` is a
    // defense-in-depth race guard — another replica may have NULL'd the row
    // between our SELECT and UPDATE; without this guard our UPDATE would
    // happily write NULL-over-NULL and inflate numUpdatedRows.
    //
    // Per-table legacy-field reset (Codex P1 on R1):
    //   - tasks: also set `data = '{}'` (operator's legacy-fallback branch
    //     reads `task.data` when payload is NULL; without this, expired
    //     ephemeral data mirrored into the legacy column would still be
    //     renderable as kind='legacy' AFTER the sweep, undercutting the
    //     entire data-liability contract this job exists to deliver)
    //   - instances: also set `variables = '{}'` (same logic, mirror field)
    //
    // The legacy columns are scheduled for removal in a future migration
    // (CLAUDE.md "Phase 1 follow-up migration drops them after backfill
    // verified"). Until then, the reaper must scrub both surfaces.
    const legacyField = table === 'workflow_central_tasks' ? 'data' : 'variables';
    const CHUNK_SIZE = 500;
    let totalUpdated = 0;
    for (let i = 0; i < idsToClear.length; i += CHUNK_SIZE) {
      const chunk = idsToClear.slice(i, i + CHUNK_SIZE);
      const result = await db
        .updateTable(table)
        // `payload: null` is intentional — sets the column to SQL NULL.
        // The legacy data/variables column is reset to '{}' so the operator's
        // legacy-fallback branch cannot render stale ephemeral payload data
        // after the sweep (Codex P1). The ternary on the already-narrowed
        // `legacyField` literal lets Kysely type each branch against the real
        // column name — no `as any` needed for the computed key.
        .set(legacyField === 'data' ? { payload: null, data: '{}' } : { payload: null, variables: '{}' })
        .where('id', 'in', chunk)
        .where('payload', 'is not', null)
        .executeTakeFirst();
      totalUpdated += Number(result.numUpdatedRows ?? 0n);
    }
    return totalUpdated;
  }
}

/**
 * True iff the row's payload column is a fully-shape-valid
 * `EphemeralWorkflowPayload` (per the canonical `isEphemeralWorkflowPayload`
 * predicate) AND its `expiresAt` is strictly in the past relative to
 * `cutoffMs`. Parse failures and shape mismatches return false (defensive —
 * the reaper must NEVER nuke a row whose payload it can't classify).
 *
 * Delegating to `isEphemeralWorkflowPayload` keeps the reaper aligned with
 * the same contract every other read path enforces (`parsePayloadOrUndefined`,
 * `WorkflowPayloadResolver`, the audit redactor). A row whose payload looks
 * superficially ephemeral but is missing `reason` or has a non-plain `data`
 * field is NOT cleared — it's an in-progress write or corrupted state that
 * the read paths already treat as undefined, and the reaper should match.
 */
function isExpiredEphemeralPayload(text: string | null | undefined, cutoffMs: number): boolean {
  if (text === null || text === undefined || text === '') return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isEphemeralWorkflowPayload(parsed)) return false;
  // expiresAt has already passed the ISO-format + Date.parse guards inside
  // isEphemeralWorkflowPayload; Date.parse here cannot return NaN.
  return Date.parse(parsed.expiresAt) < cutoffMs;
}

function rowToWorkflowActivityLog(row: {
  id: string;
  instance_id: string;
  workflow_name: string;
  action: string;
  user_id: string;
  user_name: string;
  step_name: string | null;
  details: string | null;
  timestamp: string;
}): WorkflowActivityLog {
  return {
    id: row.id,
    instanceId: row.instance_id,
    workflowName: row.workflow_name,
    action: row.action,
    userId: row.user_id,
    userName: row.user_name,
    stepName: row.step_name,
    details: row.details,
    timestamp: row.timestamp,
  };
}
