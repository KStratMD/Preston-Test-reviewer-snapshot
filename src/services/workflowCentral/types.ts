// Shared types for WorkflowCentral operator-promotion.
// See docs/plans/2026-05-14-workflow-central-operator-promotion-spec.md §5 T2.

import type { StepExecution, TaskAction, WorkflowDefinition, WorkflowInstance } from '../WorkflowCentralService';
import type { WorkflowPayload } from './payload/WorkflowPayload';

export type CompleteTaskResultCode =
  | 'ok'
  | 'not_found'
  | 'already_dispositioned'
  | 'invalid_action'
  | 'cascade_failed';

/**
 * Codex SHOULD-FIX (post-rebase): the in-tx CAS race for completeTask
 * (UPDATE ... WHERE status='pending' rowcount=0) is a "race lost between
 * pre-flight SELECT and the UPDATE" — semantically equivalent to
 * already_dispositioned, NOT a cascade failure. A typed error lets the
 * operator service distinguish race-loss (→ 409) from a true downstream
 * INSERT failure (→ 500).
 */
export class RaceLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RaceLostError';
  }
}

// DB-row shape for a task. Status enum is narrower than WorkflowTask's
// 'in_progress' because in_progress is an in-memory transient state not
// modelled in the DB (spec §2.D3).
export interface PersistedTask {
  id: string;
  tenantId: string;
  instanceId: string;
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepName: string;
  taskType: string;
  status: 'pending' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigneeId: string;
  assigneeName: string;
  description: string;
  dueAt: string | null;
  /** @deprecated — superseded by `payload` in governance-without-hosting-data Phase 1 (ADR-019). */
  data: Record<string, unknown>;
  actions: TaskAction[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: string | null;
  completionActionId: string | null;
  completionComment: string | null;
  /** Tagged-union payload (refs or ephemeral). Optional — legacy rows pre-backfill rely on `data` fallback. */
  payload?: WorkflowPayload;
}

export type CompleteTaskResult =
  | {
      ok: true;
      code: 'ok';
      task: PersistedTask;
      downstreamTaskIds: string[];
      workflowDefinitionMissing?: boolean;
    }
  | {
      ok: false;
      code: Exclude<CompleteTaskResultCode, 'ok'>;
      message?: string;
      cause?: string;
    };

// NewTaskRow omits the nullable completion columns that are only set when the
// task transitions to completed.
export type NewTaskRow = Omit<
  PersistedTask,
  'completedAt' | 'completedBy' | 'completionActionId' | 'completionComment'
>;

export interface CascadePlan {
  downstreamTaskRows: NewTaskRow[];
  instanceUpdates: {
    currentStepId: string | null;
    currentStepName: string | null;
    status?: WorkflowInstance['status'];
    appendStepHistory?: object;
  } | null;
  workflowDefinitionMissing: boolean;
}

export interface DelegateTaskResult {
  updatedTask: PersistedTask;
  previousAssigneeId: string;
}

// Re-export upstream types so callers don't need to import from two places.
export type { StepExecution, TaskAction, WorkflowDefinition, WorkflowInstance };

// ============================================================================
// Persisted instance types (T2 — PR-OP-3 instance durability)
// ============================================================================

/**
 * PersistedInstance — the row shape returned by repo SELECTs.
 * Snake_case fields match the DB schema (workflow_central_instances migration 042).
 */
export interface PersistedInstance {
  id: string;
  tenant_id: string;
  workflow_id: string;
  workflow_name: string;
  workflow_version: number;
  status: WorkflowInstance['status'];
  current_step_id: string | null;
  current_step_name: string | null;
  /** @deprecated — superseded by `payload` in governance-without-hosting-data Phase 1 (ADR-019). */
  variables: Record<string, unknown>;
  step_history: StepExecution[];
  started_by: string;
  started_at: string;
  completed_at: string | null;
  due_at: string | null;
  error: string | null;
  paused_from_status: WorkflowInstance['status'] | null;
  created_at: string;
  updated_at: string;
  /** Tagged-union payload (refs or ephemeral). Optional — legacy rows pre-backfill rely on `variables` fallback. */
  payload?: WorkflowPayload;
}

/**
 * NewInstanceRow — input shape for repo.insertInstance().
 * CamelCase, distinct from PersistedInstance to express the intent of
 * "creating new" (no created_at / updated_at — the DB fills those).
 */
export interface NewInstanceRow {
  id: string;
  tenantId: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  status: WorkflowInstance['status'];
  currentStepId: string | null;
  currentStepName: string | null;
  /** @deprecated — superseded by `payload` in governance-without-hosting-data Phase 1 (ADR-019). */
  variables: Record<string, unknown>;
  stepHistory: StepExecution[];
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
  dueAt: string | null;
  error: string | null;
  pausedFromStatus: WorkflowInstance['status'] | null;
  /** Tagged-union payload (refs or ephemeral). Optional — legacy rows pre-backfill rely on `variables` fallback. */
  payload?: WorkflowPayload;
}

/**
 * InstancePatch — tagged union discriminated by `kind`.
 * Used by repo.updateInstanceForTenant(tenantId, id, patch) to express
 * what column-set a particular operator action mutates.
 *
 * RESERVED kinds (delegateTask / startInstance) exist for exhaustive typing:
 *   - delegateTask: D13 says delegate doesn't touch the instance row.
 *   - startInstance: D10 uses insertInstance, not an update.
 */
export type InstancePatch =
  | {
      kind: 'completeTask';
      currentStepId: string | null;
      currentStepName: string | null;
      stepHistoryAppend: StepExecution;
      // T8 amendment: planCascade can yield 'failed' on a reject-with-no-transition
      // path (engine.ts L555). Operator widens the patch.status union to match.
      status?: 'completed' | 'failed';
      completedAt?: string;
      updatedAt: string;
    }
  | {
      kind: 'cancelInstance';
      status: 'cancelled';
      completedAt: string;
      clearPausedFromStatus: true;
      updatedAt: string;
    }
  | { kind: 'delegateTask'; updatedAt: string }   // RESERVED — D13: delegate doesn't touch instance row
  | { kind: 'startInstance' }                      // RESERVED — D10: uses insertInstance
  | {
      kind: 'pauseInstance';
      status: 'paused';
      pausedFromStatus: WorkflowInstance['status'];
      updatedAt: string;
    }
  | {
      kind: 'resumeInstance';
      status: WorkflowInstance['status'];           // D23: restored pre-pause status, not hardcoded
      clearPausedFromStatus: true;
      updatedAt: string;
    };

// ============================================================================
// WorkflowInstanceMetrics (T4 — PR-OP-3 instance durability, spec §3.6)
// ============================================================================

/**
 * Instance-derived subset of `WorkflowMetrics`. Returned by
 * `WorkflowCentralRepository.computeMetrics(tenantId)` — does NOT include
 * `totalWorkflows` / `activeWorkflows` (definition-durability deferral) or
 * `pendingTasks` / `overdueTasks` / `tasksCompletedToday` (already served
 * by PR-OP-2 task-count repo methods). `WorkflowCentralService.getMetrics()`
 * merges all three sources into the full `WorkflowMetrics` response.
 *
 * Why a distinct DTO (and not just `Partial<WorkflowMetrics>`): the empty
 * fields are NOT optional/missing — they're computed by different sources
 * altogether. A nominal type forces the service-layer merge to be explicit
 * and prevents an implementer from silently returning 0 for the engine-
 * sourced definition fields.
 */
export interface WorkflowInstanceMetrics {
  totalInstances: number;
  runningInstances: number;     // status IN [running, waiting]
  completedInstances: number;
  failedInstances: number;
  avgCompletionTime: number;    // hours, rounded to 1 decimal
  slaComplianceRate: number;    // % on-time; 100 when denom=0
  instancesStartedToday: number;
}

/**
 * Insert-shape for a new activity-log row (PR-OP-3b). Matches the
 * `WorkflowActivityLog` service shape plus `tenantId` for tenant scoping.
 * `details` is opaque text — callers JSON-stringify structured payloads.
 */
export interface NewActivityLogRow {
  id: string;
  tenantId: string;
  instanceId: string;
  workflowName: string;
  action: string;
  userId: string;
  userName: string;
  stepName: string | null;
  details: string | null;
  timestamp: string;
}

export interface ListActivityOptions {
  limit?: number;
  instanceId?: string;
}
