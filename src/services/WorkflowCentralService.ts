/**
 * WorkflowCentralService - Business Process Automation
 *
 * Post-T9 shape (PR-OP-3 instance durability):
 *   - Definitions stay on WorkflowEngineService (in-memory).
 *   - Instances are DURABLE — every write goes through repo.insertInstance /
 *     repo.updateInstanceForTenant inside a TX, followed by
 *     engine.refreshCacheFromCommit() to keep the engine's in-memory cache
 *     in sync. The engine Map is a strict read-through cache except for the
 *     D8 carve-out (cancellationReason — DLP-redacted, never durable).
 *   - getInstances / getMetrics / getDashboard.recentInstances all read from
 *     the repo (DB-canonical) per spec §3.5 + §3.6.
 *   - Tasks stay on WorkflowCentralRepository (PR-OP-2).
 *
 * completeTask / advanceWorkflow / createTaskForStep have been DELETED —
 * task completion lives in WorkflowCentralOperatorService (T8).
 *
 * @module services/WorkflowCentralService
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../inversify/types';
import type { Logger } from '../utils/Logger';
import type { DatabaseService } from '../database/DatabaseService';
import type { NewAuditLog } from '../database/types';
import type { AuditLogRepository } from '../database/repositories/AuditLogRepository';
import { WorkflowEngineService } from './workflowCentral/WorkflowEngineService';
import { WorkflowCentralRepository } from './workflowCentral/WorkflowCentralRepository';
import type { GovernanceService } from './ai/orchestrator/GovernanceService';
import type {
  DefinitionFilters,
  InstanceFilters,
  CreateDefinitionInput,
} from './workflowCentral/WorkflowEngineService';
import type {
  PersistedTask,
  NewInstanceRow,
} from './workflowCentral/types';
import { DLPService } from './security/DLPService';
import {
  InvalidStateTransitionError,
  NotFoundError,
} from './workflowCentral/errors';
import { workflowCentralAuditDeliveryFailures } from './workflowCentral/metrics';
import { safeActivityLog } from './workflowCentral/activityLog';
import { randomUUID } from 'crypto';
import { SYSTEM_IDENTITY } from './governance/identityContext';

// DLP placeholder used when scanText throws OR returns findings without
// redactedData (fail-closed per spec §3.2 cancelInstance modes (a)+(b)).
const REDACT_PLACEHOLDER = '[redacted: dlp failed-closed]';

// ============================================================================
// Interfaces — re-exported for callers (routes, tests, etc.)
// ============================================================================

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  category: string;
  version: number;
  status: 'draft' | 'active' | 'deprecated' | 'archived';
  triggerType: 'manual' | 'scheduled' | 'event' | 'api';
  triggerConfig: Record<string, unknown>;
  steps: WorkflowStep[];
  variables: WorkflowVariable[];
  slaHours: number | null;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
}

export interface WorkflowStep {
  id: string;
  name: string;
  type: 'task' | 'approval' | 'notification' | 'condition' | 'parallel' | 'loop' | 'integration';
  order: number;
  config: StepConfig;
  transitions: StepTransition[];
  timeoutHours: number | null;
  retryPolicy: RetryPolicy | null;
}

export interface StepConfig {
  taskType?: string;
  assigneeType?: 'user' | 'role' | 'group' | 'dynamic';
  assigneeValue?: string;
  approvalType?: 'single' | 'sequential' | 'parallel' | 'unanimous';
  approvers?: string[];
  notificationTemplate?: string;
  notificationRecipients?: string[];
  conditionExpression?: string;
  integrationId?: string;
  integrationAction?: string;
  loopVariable?: string;
  loopCollection?: string;
  parallelBranches?: WorkflowStep[][];
  customFields?: Record<string, unknown>;
}

export interface StepTransition {
  id: string;
  targetStepId: string;
  condition?: string;
  isDefault: boolean;
}

export interface RetryPolicy {
  maxRetries: number;
  retryDelayMinutes: number;
  backoffMultiplier: number;
}

export interface WorkflowVariable {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'date' | 'object' | 'array';
  defaultValue?: unknown;
  required: boolean;
  description?: string;
}

export interface WorkflowInstance {
  id: string;
  workflowId: string;
  workflowName: string;
  workflowVersion: number;
  tenantId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'paused' | 'waiting' | 'unknown_recovered';
  currentStepId: string | null;
  currentStepName: string | null;
  variables: Record<string, unknown>;
  startedBy: string;
  startedAt: string;
  completedAt: string | null;
  dueAt: string | null;
  error: string | null;
  stepHistory: StepExecution[];
  // D8 carve-out — cancellation reason flows through the synchronous response
  // path so the operator UI can display "why was this cancelled". The reason
  // is INTENTIONALLY OMITTED from the persisted audit log (DLP-sensitive free
  // text) AND from the DB row (cache-only — never durable). Always null when
  // sourced from the DB; only present on the cached instance after the cancel
  // TX commits + DLP redaction completes.
  cancellationReason?: string | null;
}

export interface StepExecution {
  id: string;
  stepId: string;
  stepName: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'skipped' | 'waiting';
  assigneeId: string | null;
  assigneeName: string | null;
  startedAt: string;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  comments: string | null;
}

/**
 * WorkflowTask is the OLD in-memory shape (pre-T8).  Routes still use it for
 * responses that haven't migrated to PersistedTask yet.  New task reads return
 * PersistedTask from the repository.
 */
export interface WorkflowTask {
  id: string;
  instanceId: string;
  workflowName: string;
  stepId: string;
  stepName: string;
  taskType: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'low' | 'medium' | 'high' | 'urgent';
  assigneeId: string;
  assigneeName: string;
  description: string;
  dueAt: string | null;
  data: Record<string, unknown>;
  actions: TaskAction[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  completedBy: string | null;
}

export interface TaskAction {
  id: string;
  label: string;
  type: 'approve' | 'reject' | 'complete' | 'delegate' | 'escalate' | 'custom';
  requiresComment: boolean;
  nextStepId?: string;
}

export interface WorkflowMetrics {
  totalWorkflows: number;
  activeWorkflows: number;
  totalInstances: number;
  runningInstances: number;
  completedInstances: number;
  failedInstances: number;
  avgCompletionTime: number;
  slaComplianceRate: number;
  pendingTasks: number;
  overdueTasks: number;
  tasksCompletedToday: number;
  instancesStartedToday: number;
}

export interface WorkflowDashboard {
  summary: {
    activeWorkflows: number;
    runningInstances: number;
    pendingTasks: number;
    overdueItems: number;
  };
  metrics: WorkflowMetrics;
  recentInstances: WorkflowInstance[];
  myTasks: PersistedTask[];
  workflowsByCategory: { category: string; count: number }[];
  recentActivity: WorkflowActivityLog[];
  lastUpdated: number;
}

export interface WorkflowActivityLog {
  id: string;
  instanceId: string;
  workflowName: string;
  action: string;
  userId: string;
  userName: string;
  stepName: string | null;
  details: string | null;
  timestamp: string;
}

// ============================================================================
// Service Implementation
// ============================================================================

@injectable()
export class WorkflowCentralService {
  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger,
    @inject(TYPES.WorkflowEngineService) private readonly engine: WorkflowEngineService,
    @inject(TYPES.WorkflowCentralRepository) private readonly repo: WorkflowCentralRepository,
    @inject(TYPES.DatabaseService) private readonly db: DatabaseService,
    @inject(TYPES.AuditLogRepository) private readonly auditLog: AuditLogRepository,
    @inject(TYPES.DLPService) private readonly dlpService: DLPService,
    @inject(TYPES.GovernanceService) private readonly governance: GovernanceService,
  ) {
    this.logger.info('WorkflowCentralService initialized');
    // NOTE: initializeDemoData() call removed — T11 wires it from composition root
    // via engine.seedDemoData().
  }

  // ==========================================================================
  // Dashboard & Metrics
  // ==========================================================================

  public async getDashboard(tenantId: string, userId?: string): Promise<WorkflowDashboard> {
    this.logger.info('Fetching workflow central dashboard');

    const metrics = await this.getMetrics(tenantId);
    // §3.6 / T9 Step 6.7: recent instances come from the DB, NOT engine.getInstances.
    // Engine cache is bounded by recentTerminalHydrationDays; the dashboard read
    // is most-recent-started across all rows the tenant owns.
    const recentResult = await this.repo.listInstances(tenantId, {
      limit: 5,
      orderBy: 'started_at DESC',
    });
    const recentInstances = recentResult.instances;
    const myTasks: PersistedTask[] = userId
      ? await this.repo.listByAssignee(tenantId, userId)
      : [];
    const workflowsByCategory = this.getWorkflowsByCategory();
    const recentActivity = await this.getRecentActivity(tenantId, { limit: 10 });

    const overdueItems = await this.getOverdueCount(tenantId);

    return {
      summary: {
        activeWorkflows: metrics.activeWorkflows,
        runningInstances: metrics.runningInstances,
        pendingTasks: metrics.pendingTasks,
        overdueItems,
      },
      metrics,
      recentInstances,
      myTasks,
      workflowsByCategory,
      recentActivity,
      lastUpdated: Date.now(),
    };
  }

  /**
   * §3.6 / T9 Step 6.6 — three-source merge:
   *   - Engine map: definition counts (totalWorkflows, activeWorkflows).
   *   - Repo SQL (computeMetrics): instance-derived subset (counts,
   *     avgCompletionTime, slaComplianceRate, instancesStartedToday).
   *   - Repo SQL (PR-OP-2 task helpers): pendingTasks, overdueTasks,
   *     tasksCompletedToday.
   * DELETES the prior in-memory iteration over engine.getInstances — that path
   * was bounded by Number.MAX_SAFE_INTEGER + cache size, but the cache is now
   * bounded by recentTerminalHydrationDays so old terminals would silently
   * drop out of the count. SQL aggregation has no such bound.
   */
  public async getMetrics(tenantId: string): Promise<WorkflowMetrics> {
    // Engine — definition counts only.
    const defsResult = this.engine.getDefinitions({ limit: Number.MAX_SAFE_INTEGER });
    const definitions = defsResult.definitions;
    const totalWorkflows = definitions.length;
    const activeWorkflows = definitions.filter((d) => d.status === 'active').length;

    // Repo SQL — instance-derived metrics (full table, not bounded by hydration window).
    const instanceMetrics = await this.repo.computeMetrics(tenantId);

    // Repo SQL — task counts (PR-OP-2 helpers).
    const pendingTasks = await this.repo.countByStatus(tenantId, 'pending');
    const nowIso = new Date().toISOString();
    const overdueTasks = await this.repo.countOverdue(tenantId, nowIso);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tasksCompletedToday = await this.repo.countCompletedSince(
      tenantId,
      today.toISOString(),
    );

    return {
      totalWorkflows,
      activeWorkflows,
      totalInstances: instanceMetrics.totalInstances,
      runningInstances: instanceMetrics.runningInstances,
      completedInstances: instanceMetrics.completedInstances,
      failedInstances: instanceMetrics.failedInstances,
      avgCompletionTime: instanceMetrics.avgCompletionTime,
      slaComplianceRate: instanceMetrics.slaComplianceRate,
      pendingTasks,
      overdueTasks,
      tasksCompletedToday,
      instancesStartedToday: instanceMetrics.instancesStartedToday,
    };
  }

  public getWorkflowsByCategory(): { category: string; count: number }[] {
    const definitions = this.engine
      .getDefinitions({ status: 'active', limit: Number.MAX_SAFE_INTEGER })
      .definitions;
    const categoryMap = new Map<string, number>();
    for (const d of definitions) {
      categoryMap.set(d.category, (categoryMap.get(d.category) ?? 0) + 1);
    }
    return Array.from(categoryMap.entries()).map(([category, count]) => ({
      category,
      count,
    }));
  }

  // ==========================================================================
  // Workflow Definition Management — thin engine delegations
  // ==========================================================================

  public async getDefinitions(filters?: DefinitionFilters): Promise<{
    definitions: WorkflowDefinition[];
    total: number;
  }> {
    return this.engine.getDefinitions(filters);
  }

  public async getDefinition(id: string): Promise<WorkflowDefinition | null> {
    return this.engine.getDefinition(id);
  }

  public async createDefinition(
    data: CreateDefinitionInput
  ): Promise<WorkflowDefinition> {
    return this.engine.createDefinition(data);
  }

  public async updateDefinition(
    id: string,
    updates: Partial<
      Pick<
        WorkflowDefinition,
        | 'name'
        | 'description'
        | 'category'
        | 'triggerType'
        | 'triggerConfig'
        | 'steps'
        | 'variables'
        | 'slaHours'
      >
    >
  ): Promise<WorkflowDefinition | null> {
    return this.engine.updateDefinition(id, updates);
  }

  public async publishDefinition(id: string): Promise<WorkflowDefinition | null> {
    const def = this.engine.getDefinition(id);
    if (!def || def.status !== 'draft') return null;
    const now = new Date().toISOString();
    def.status = 'active';
    def.publishedAt = now;
    def.updatedAt = now;
    this.logger.info('Published workflow definition', { workflowId: id });
    return def;
  }

  public async deprecateDefinition(id: string): Promise<WorkflowDefinition | null> {
    const def = this.engine.getDefinition(id);
    if (!def || def.status !== 'active') return null;
    def.status = 'deprecated';
    def.updatedAt = new Date().toISOString();
    this.logger.info('Deprecated workflow definition', { workflowId: id });
    return def;
  }

  public async addStep(
    workflowId: string,
    step: Omit<WorkflowStep, 'id'>
  ): Promise<WorkflowDefinition | null> {
    const def = this.engine.getDefinition(workflowId);
    if (!def || def.status !== 'draft') return null;
    const stepId = `STEP-${Date.now()}`;
    const newStep: WorkflowStep = { id: stepId, ...step };
    def.steps.push(newStep);
    def.updatedAt = new Date().toISOString();
    return def;
  }

  // ==========================================================================
  // Workflow Instance Management — DB-canonical (T9)
  // ==========================================================================

  /**
   * §3.5 / T9 Step 6.5 — DB-canonical read. Engine cache may have
   * recent-terminal rows pruned by the hydration window; the repo returns
   * the full set. Pass-through to repo.listInstances.
   */
  public async getInstances(
    tenantId: string,
    filters?: InstanceFilters
  ): Promise<{ instances: WorkflowInstance[]; total: number }> {
    return this.repo.listInstances(tenantId, filters);
  }

  public async getInstance(
    tenantId: string,
    id: string
  ): Promise<WorkflowInstance | null> {
    // D24 cache-first read with non-locking DB fallback for terminal rows
    // aged out of the hydration window. Tenant guard inside.
    return this.engine.getInstanceFromAnywhere(this.repo, tenantId, id);
  }

  /**
   * startInstance — deferred Map.set (D10/§3.2).
   *
   * Order:
   *   1. Validate definition (must exist + be active).
   *   2. engine.createInstance returns ephemeral (NO Map mutation).
   *   3. engine.buildInitialTaskRow (still pure — no Map mutation).
   *   4. db.transaction: insertInstance + (optional) insertTask.
   *   5. POST-TX: engine.refreshCacheFromCommit({ instance: ephemeral }).
   *   6. safeAudit success.
   *
   * If the TX throws, the cache was never touched — no cleanup needed.
   * This obsoletes the prior PR-OP-2 retry-cleanup via engine.deleteInstance.
   */
  public async startInstance(args: {
    tenantId: string;
    workflowId: string;
    variables?: Record<string, unknown>;
    startedBy: string;
  }): Promise<{ instanceId: string; initialTaskId: string | null } | null> {
    const startedAt = Date.now();
    const definition = this.engine.getDefinition(args.workflowId);
    if (!definition || definition.status !== 'active') return null;

    const ephemeral = this.engine.createInstance(
      args.tenantId,
      args.workflowId,
      args.variables ?? {},
      args.startedBy,
    );

    const initialTaskRow = this.engine.buildInitialTaskRow(ephemeral, definition);

    // Capture the DB-returned PersistedInstance so refreshCacheFromCommit uses the
    // canonical row (correct timestamps from `returningAll`) rather than a
    // synthesized snapshot — addresses Copilot R2 concern about created_at/updated_at
    // drift between cache and DB for any future consumer that reads those columns.
    let insertedInstance: import('./workflowCentral/types').PersistedInstance | undefined;
    try {
      insertedInstance = await this.db.transaction(async (tx) => {
        const inserted = await this.repo.insertInstance(tx, this.toNewInstanceRow(ephemeral));
        if (initialTaskRow) {
          await this.repo.insertTask(tx, initialTaskRow);
        }
        return inserted;
      });
    } catch (err) {
      // Cache was NEVER mutated — no engine cleanup needed. Audit failure +
      // rethrow. Note: per existing PR-OP-2 contract (preserved here for
      // observability), failure-audit is INCLUDED on the start path because
      // the operator may want to see "I tried to start; got DB error".
      await this.safeAudit({
        ...this.baseAudit(
          'workflow_central.start_instance',
          { tenantId: args.tenantId, instanceId: ephemeral.id },
          startedAt,
          args.startedBy,
        ),
        result: 'failure',
        error_message: err instanceof Error ? err.message : String(err),
        details: {
          tenant_id: args.tenantId,
          instance_id: ephemeral.id,
          workflow_id: args.workflowId,
          workflow_name: definition.name,
          started_by: args.startedBy,
          task_insert_succeeded: false,
        },
      });
      throw err;
    }

    // Single Map.set, post-commit. Use the DB-returned row so created_at /
    // updated_at reflect what was persisted (Copilot R2 finding).
    this.engine.refreshCacheFromCommit({
      instance: insertedInstance,
    });

    await this.safeAudit({
      ...this.baseAudit(
        'workflow_central.start_instance',
        { tenantId: args.tenantId, instanceId: ephemeral.id },
        startedAt,
        args.startedBy,
      ),
      result: 'success',
      error_message: null,
      details: {
        tenant_id: args.tenantId,
        instance_id: ephemeral.id,
        workflow_id: args.workflowId,
        workflow_name: definition.name,
        initial_task_id: initialTaskRow?.id ?? null,
        started_by: args.startedBy,
        task_insert_succeeded: true,
      },
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      row: {
        id: randomUUID(),
        tenantId: args.tenantId,
        instanceId: ephemeral.id,
        workflowName: definition.name,
        action: 'instance_started',
        userId: args.startedBy,
        userName: args.startedBy,
        stepName: null,
        details: JSON.stringify({
          workflow_id: args.workflowId,
          started_by: args.startedBy,
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return { instanceId: ephemeral.id, initialTaskId: initialTaskRow?.id ?? null };
  }

  /**
   * cancelInstance — DB-canonical + DLP-redacted reason (D8/§3.2).
   *
   * TX:
   *   1. selectInstanceForUpdate (locking; tenant-scoped).
   *   2. Terminal-set rejection → null (route → 404).
   *   3. updateInstanceForTenant({kind: 'cancelInstance', clearPausedFromStatus: true}).
   *      D22+D23: paused→cancelled clears paused_from_status for symmetry.
   *   4. cancelPendingForInstance (best-effort cascade — same TX).
   *
   * POST-TX:
   *   5. redactCancellationReason (fail-closed per spec modes (a)+(b)).
   *   6. refreshCacheFromCommit with redacted reason (single Map.set).
   *   7. safeAudit (reason INTENTIONALLY OMITTED — DLP carve-out).
   *
   * Returns the cached `WorkflowInstance` so the route returns it directly.
   * `null` is returned on cross-tenant id, unknown id, or terminal state
   * (route maps null → 404).
   */
  public async cancelInstance(
    tenantId: string,
    instanceId: string,
    cancelledBy: string,
    reason?: string,
  ): Promise<WorkflowInstance | null> {
    const startedAt = Date.now();
    let txResult!: { updated: import('./workflowCentral/types').PersistedInstance; cancelledTaskIds: string[] };

    try {
      txResult = await this.db.transaction(async (tx) => {
        const instance = await this.repo.selectInstanceForUpdate(tx, tenantId, instanceId);
        if (!instance) {
          throw new NotFoundError(`workflow instance ${instanceId} not found in tenant ${tenantId}`);
        }
        // Terminal-set rejection. paused is intentionally accepted (D22).
        if (
          instance.status === 'completed' ||
          instance.status === 'failed' ||
          instance.status === 'cancelled'
        ) {
          throw new NotFoundError(`workflow instance ${instanceId} not in cancellable state (${instance.status})`);
        }
        const nowIso = new Date().toISOString();
        const updated = await this.repo.updateInstanceForTenant(tx, tenantId, instanceId, {
          kind: 'cancelInstance',
          status: 'cancelled',
          completedAt: nowIso,
          clearPausedFromStatus: true,
          updatedAt: nowIso,
        });
        const cancelledTaskIds = await this.repo.cancelPendingForInstance(
          tx,
          tenantId,
          instanceId,
        );
        return { updated, cancelledTaskIds };
      });
    } catch (err) {
      // Pre-flight rejection paths (NotFoundError thrown inside TX before any
      // commit) return null to the route → 404. No audit row — nothing
      // committed. Other errors rethrow per existing contract.
      if (err instanceof NotFoundError) {
        return null;
      }
      this.logger.warn('cancelInstance DB cancel failed', {
        err: err instanceof Error ? err.message : String(err),
        instanceId,
      });
      throw err;
    }

    // POST-TX. DLP fail-closed.
    const redactedReason = await this.redactCancellationReason(reason, tenantId, instanceId);
    // Non-sensitive flags for audit observability (Copilot R2 — compliance
    // drilldown needs to know whether the operator supplied a reason AND
    // whether DLP fired, without leaking the reason itself).
    const reasonSupplied = typeof reason === 'string' && reason.trim().length > 0;
    const reasonWasRedacted = reasonSupplied
      && redactedReason !== null
      && (redactedReason === REDACT_PLACEHOLDER || redactedReason !== reason);

    const cached = this.engine.refreshCacheFromCommit({
      instance: txResult.updated,
      cancellationReason: redactedReason,
    });

    await this.safeAudit({
      ...this.baseAudit(
        'workflow_central.cancel_instance',
        { tenantId, instanceId },
        startedAt,
        cancelledBy,
      ),
      result: 'success',
      error_message: null,
      details: {
        tenant_id: tenantId,
        instance_id: instanceId,
        workflow_id: txResult.updated.workflow_id,
        cancelled_task_ids: txResult.cancelledTaskIds.slice(0, 100),
        cancelled_task_count: txResult.cancelledTaskIds.length,
        cancelled_by: cancelledBy,
        reason_supplied: reasonSupplied,
        reason_was_redacted: reasonWasRedacted,
        // cancellation_reason INTENTIONALLY OMITTED — DLP-sensitive user
        // free text. Matches the complete-task pattern that strips `comment`
        // and `data` from audit details. The reason still flows through the
        // synchronous response (cached.cancellationReason) for the operator
        // UI; only the persisted audit is sanitized.
      },
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      row: {
        id: randomUUID(),
        tenantId,
        instanceId,
        workflowName: txResult.updated.workflow_name,
        action: 'instance_cancelled',
        userId: cancelledBy,
        userName: cancelledBy,
        stepName: txResult.updated.current_step_name,
        details: JSON.stringify({
          cancelled_by: cancelledBy,
          cancelled_task_count: txResult.cancelledTaskIds.length,
          reason_supplied: reasonSupplied,
          reason_was_redacted: reasonWasRedacted,
          // cancellation_reason INTENTIONALLY OMITTED — DLP carve-out
          // mirrors the audit detail above.
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return cached;
  }

  /**
   * pauseInstance — durable (D14/§3.2).
   *
   * TX: selectInstanceForUpdate → status guard (running/waiting) →
   * updateInstanceForTenant({kind: 'pauseInstance', pausedFromStatus}).
   * POST-TX: refreshCacheFromCommit + safeAudit.
   * Returns the cached WorkflowInstance, or null on unknown/cross-tenant id.
   * Throws InvalidStateTransitionError on non-pausable status (route → 409).
   */
  public async pauseInstance(tenantId: string, id: string): Promise<WorkflowInstance | null> {
    const startedAt = Date.now();
    let txResult!: { previousStatus: WorkflowInstance['status']; updated: import('./workflowCentral/types').PersistedInstance };

    try {
      txResult = await this.db.transaction(async (tx) => {
        const instance = await this.repo.selectInstanceForUpdate(tx, tenantId, id);
        if (!instance) {
          throw new NotFoundError(`workflow instance ${id} not found in tenant ${tenantId}`);
        }
        if (instance.status !== 'running' && instance.status !== 'waiting') {
          throw new InvalidStateTransitionError(
            tenantId,
            id,
            instance.status,
            'pause',
            ['running', 'waiting'],
          );
        }
        const nowIso = new Date().toISOString();
        const updated = await this.repo.updateInstanceForTenant(tx, tenantId, id, {
          kind: 'pauseInstance',
          status: 'paused',
          pausedFromStatus: instance.status,
          updatedAt: nowIso,
        });
        return { previousStatus: instance.status, updated };
      });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err; // InvalidStateTransitionError + others rethrow → route mapper
    }

    const cached = this.engine.refreshCacheFromCommit({ instance: txResult.updated });

    await this.safeAudit({
      ...this.baseAudit(
        'workflow_central.pause_instance',
        { tenantId, instanceId: id },
        startedAt,
        null,
      ),
      result: 'success',
      error_message: null,
      details: {
        tenant_id: tenantId,
        instance_id: id,
        previous_status: txResult.previousStatus,
      },
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      // KNOWN-LIMITATION: pause/resume route handlers do not thread userId
      // (`router.post('/instances/:id/pause', …)` calls `service.pauseInstance(tenantId, id)`).
      // The activity row attributes to SYSTEM_IDENTITY rather than the
      // caller. Real per-user attribution requires a route-layer signature
      // change + new positional param on pauseInstance/resumeInstance and
      // is deferred to PR-OP-3b-followup. The audit row at `:744-756` has
      // the same gap (also passes `null` for userId via baseAudit).
      row: {
        id: randomUUID(),
        tenantId,
        instanceId: id,
        workflowName: txResult.updated.workflow_name,
        action: 'instance_paused',
        userId: SYSTEM_IDENTITY.userId,
        userName: SYSTEM_IDENTITY.userId,
        stepName: txResult.updated.current_step_name,
        details: JSON.stringify({
          previous_status: txResult.previousStatus,
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return cached;
  }

  /**
   * resumeInstance — durable, restores pre-pause status (D23/§3.2).
   *
   * TX: selectInstanceForUpdate → status === 'paused' guard →
   * updateInstanceForTenant({kind: 'resumeInstance', status: paused_from_status ?? 'running'}).
   * SNAKE_CASE: PersistedInstance.paused_from_status (NOT camelCase).
   * Fallback to 'running' is defensive only — PR-OP-3-paused rows always
   * have paused_from_status; the fallback covers legacy/manual rows.
   * POST-TX: refreshCacheFromCommit + safeAudit.
   * Returns cached WorkflowInstance, or null on unknown id. Throws
   * InvalidStateTransitionError on non-paused status (route → 409).
   */
  public async resumeInstance(tenantId: string, id: string): Promise<WorkflowInstance | null> {
    const startedAt = Date.now();
    let txResult!: { previousStatus: WorkflowInstance['status']; updated: import('./workflowCentral/types').PersistedInstance };

    try {
      txResult = await this.db.transaction(async (tx) => {
        const instance = await this.repo.selectInstanceForUpdate(tx, tenantId, id);
        if (!instance) {
          throw new NotFoundError(`workflow instance ${id} not found in tenant ${tenantId}`);
        }
        if (instance.status !== 'paused') {
          throw new InvalidStateTransitionError(
            tenantId,
            id,
            instance.status,
            'resume',
            ['paused'],
          );
        }
        // D23: restore pre-pause status. SNAKE_CASE field on PersistedInstance.
        const targetStatus: WorkflowInstance['status'] = instance.paused_from_status ?? 'running';
        const nowIso = new Date().toISOString();
        const updated = await this.repo.updateInstanceForTenant(tx, tenantId, id, {
          kind: 'resumeInstance',
          status: targetStatus,
          clearPausedFromStatus: true,
          updatedAt: nowIso,
        });
        return { previousStatus: instance.status, updated };
      });
    } catch (err) {
      if (err instanceof NotFoundError) return null;
      throw err;
    }

    const cached = this.engine.refreshCacheFromCommit({ instance: txResult.updated });

    await this.safeAudit({
      ...this.baseAudit(
        'workflow_central.resume_instance',
        { tenantId, instanceId: id },
        startedAt,
        null,
      ),
      result: 'success',
      error_message: null,
      details: {
        tenant_id: tenantId,
        instance_id: id,
        previous_status: txResult.previousStatus,
        resumed_to_status: txResult.updated.status,
      },
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      // KNOWN-LIMITATION: same as pauseInstance above. Audit row at `:810-820`
      // has the same gap. Deferred to PR-OP-3b-followup.
      row: {
        id: randomUUID(),
        tenantId,
        instanceId: id,
        workflowName: txResult.updated.workflow_name,
        action: 'instance_resumed',
        userId: SYSTEM_IDENTITY.userId,
        userName: SYSTEM_IDENTITY.userId,
        stepName: txResult.updated.current_step_name,
        details: JSON.stringify({
          previous_status: txResult.previousStatus,
          resumed_to_status: txResult.updated.status,
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return cached;
  }

  // ==========================================================================
  // Task Reads — repo delegations (tenant-scoped)
  // ==========================================================================

  public async getTasks(
    tenantId: string,
    filters?: {
      instanceId?: string;
      status?: 'pending' | 'completed' | 'cancelled';
      priority?: 'low' | 'medium' | 'high' | 'urgent';
      limit?: number;
      offset?: number;
    }
  ): Promise<{ tasks: PersistedTask[]; total: number }> {
    const [tasks, total] = await Promise.all([
      this.repo.listTasks({
        tenantId,
        instanceId: filters?.instanceId,
        status: filters?.status,
        priority: filters?.priority,
        limit: filters?.limit,
        offset: filters?.offset,
      }),
      this.repo.countTasks({
        tenantId,
        instanceId: filters?.instanceId,
        status: filters?.status,
        priority: filters?.priority,
      }),
    ]);
    return { tasks, total };
  }

  public async getTask(
    tenantId: string,
    id: string
  ): Promise<PersistedTask | null> {
    return this.repo.getById(tenantId, id);
  }

  public async getTasksByAssignee(
    tenantId: string,
    assigneeId: string,
    status?: 'pending' | 'completed' | 'cancelled'
  ): Promise<PersistedTask[]> {
    return this.repo.listByAssignee(tenantId, assigneeId, status);
  }

  public async getOverdueCount(tenantId: string): Promise<number> {
    const nowIso = new Date().toISOString();
    const overdueTaskCount = await this.repo.countOverdue(tenantId, nowIso);
    // Engine cache is bounded by recentTerminalHydrationDays; in steady state
    // the active set fits comfortably so iteration is cheap. The overdue
    // instance count is the subset of cached `running` rows whose dueAt has
    // passed.
    const overdueInstances = this.engine
      .getInstances(tenantId, { limit: Number.MAX_SAFE_INTEGER })
      .instances.filter(
        (i) => i.status === 'running' && i.dueAt && new Date(i.dueAt) < new Date()
      ).length;
    return overdueTaskCount + overdueInstances;
  }

  // ==========================================================================
  // Task Writes — delegateTask stays here; completeTask lives in operator svc
  // ==========================================================================

  /**
   * delegateTask — SELECT-then-UPDATE via repo.delegatePendingTask + failure
   * code resolution (R4 F-01).
   */
  public async delegateTask(
    tenantId: string,
    taskId: string,
    newAssigneeId: string,
    newAssigneeName: string,
    delegatedBy: string
  ): Promise<PersistedTask | null> {
    const startedAt = Date.now();
    const result = await this.db.transaction(async (tx) =>
      this.repo.delegatePendingTask(tx, tenantId, taskId, newAssigneeId, newAssigneeName)
    );

    if (!result) {
      const existing = await this.repo.getById(tenantId, taskId);
      const failureCode = existing ? 'already_dispositioned' : 'not_found';
      await this.safeAudit({
        ...this.baseAudit(
          'workflow_central.delegate_task',
          { tenantId, taskId },
          startedAt,
          delegatedBy,
        ),
        result: 'failure',
        error_message: failureCode,
        details: {
          tenant_id: tenantId,
          task_id: taskId,
          delegated_by: delegatedBy,
          delegation_result: failureCode,
        },
      });
      return null;
    }

    await this.safeAudit({
      ...this.baseAudit(
        'workflow_central.delegate_task',
        { tenantId, taskId },
        startedAt,
        delegatedBy,
      ),
      result: 'success',
      error_message: null,
      details: {
        tenant_id: tenantId,
        task_id: taskId,
        instance_id: result.updatedTask.instanceId,
        previous_assignee_id: result.previousAssigneeId,
        new_assignee_id: newAssigneeId,
        new_assignee_name: newAssigneeName,
        delegated_by: delegatedBy,
        delegation_result: 'success',
      },
    });

    await safeActivityLog({
      repo: this.repo,
      logger: this.logger,
      row: {
        id: randomUUID(),
        tenantId,
        instanceId: result.updatedTask.instanceId,
        workflowName: result.updatedTask.workflowName,
        action: 'task_delegated',
        userId: delegatedBy,
        userName: delegatedBy,
        stepName: result.updatedTask.stepName,
        details: JSON.stringify({
          task_id: taskId,
          previous_assignee_id: result.previousAssigneeId,
          new_assignee_id: newAssigneeId,
          new_assignee_name: newAssigneeName,
          delegated_by: delegatedBy,
        }),
        timestamp: new Date().toISOString(),
      },
    });

    return result.updatedTask;
  }

  // ==========================================================================
  // Activity — DB-canonical, tenant-scoped (PR-OP-3b).
  //
  // Previously the activity Map was a dead stub (never written, always empty).
  // PR-OP-3b tees inserts off the existing safeAudit success sites into
  // `workflow_central_activity_logs` and reads through the repo. Tenant
  // scoping is enforced at the SQL boundary — no overload omits tenantId.
  //
  // `limit` is bounded `[1, ACTIVITY_LOG_MAX_LIMIT]`; out-of-range values
  // throw `InvalidLimitError` (route → 400). Caller may pass `instanceId`
  // to narrow to a single workflow instance.
  // ==========================================================================

  public async getRecentActivity(
    tenantId: string,
    opts?: { limit?: number; instanceId?: string },
  ): Promise<WorkflowActivityLog[]> {
    return this.repo.listRecentActivityForTenant(tenantId, opts);
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * Map the engine's ephemeral WorkflowInstance → NewInstanceRow for the
   * insertInstance call. The shapes are aligned column-for-column except:
   *   - pausedFromStatus: always null for a freshly-started instance.
   *   - cancellationReason: not part of NewInstanceRow (cache-only D8 carve-out).
   */
  private toNewInstanceRow(instance: WorkflowInstance): NewInstanceRow {
    return {
      id: instance.id,
      tenantId: instance.tenantId,
      workflowId: instance.workflowId,
      workflowName: instance.workflowName,
      workflowVersion: instance.workflowVersion,
      status: instance.status,
      currentStepId: instance.currentStepId,
      currentStepName: instance.currentStepName,
      variables: instance.variables,
      stepHistory: instance.stepHistory,
      startedBy: instance.startedBy,
      startedAt: instance.startedAt,
      completedAt: instance.completedAt,
      dueAt: instance.dueAt,
      error: instance.error,
      pausedFromStatus: null,
    };
  }

  /**
   * DLP redact a cancellation reason. Posture-aware (PR C3.1b/c migration).
   * Returns:
   *   - null when caller passed undefined/null reason.
   *   - The original reason verbatim when `posture.allowPII === true` (tenant
   *     has explicitly opted in to surfacing raw PII in cancellation context).
   *   - REDACT_PLACEHOLDER on any failure-closed condition:
   *       * scanText throws,
   *       * relevant findings exist AND (`posture.blockOnDetection` is true
   *         OR `posture.autoRedact` is false),
   *       * `dlpService.redactData(reason, relevantFindings)` returns undefined.
   *   - dlpService.redactData(...) output (the redacted text) when relevant
   *     findings exist, redaction is permitted, and redactData succeeds.
   *   - original reason when no posture-relevant findings (`posture.piiTypes`
   *     filter narrowed all scan findings away).
   *
   * Scan policy uses `autoRedact: false` so this function controls per-finding
   * narrowing via `dlpService.redactData(reason, relevantFindings)`; the
   * legacy scan-side `redactedData` is not consulted.
   *
   * scanText coverage caveat (spec §3.2 table): field-gated patterns (date_of_birth,
   * passport, bank_account, drivers_license, name, phone_intl) are SKIPPED on raw
   * text — they only fire via scanForPII with structured field paths.
   */
  private async redactCancellationReason(
    reason: string | undefined,
    tenantId: string,
    instanceId: string,
  ): Promise<string | null> {
    if (!reason) return null;

    const posture = await this.governance.getPostureForTenant(tenantId);

    if (posture.allowPII) {
      return reason;
    }

    let scan;
    try {
      scan = await this.dlpService.scanText(reason, {
        allowPII: false, piiTypes: [], autoRedact: false, blockOnDetection: false,
      });
    } catch (err) {
      this.logger.warn('cancellation reason DLP failed-closed (scanText threw)', {
        tenant_id: tenantId, instance_id: instanceId,
        error_class: err instanceof Error ? err.constructor.name : 'unknown',
      });
      return REDACT_PLACEHOLDER;
    }

    const relevantFindings = posture.piiTypes.length === 0
      ? scan.findings
      : scan.findings.filter(f => posture.piiTypes.includes(f.type));

    if (relevantFindings.length === 0) return reason;

    if (posture.blockOnDetection || !posture.autoRedact) {
      return REDACT_PLACEHOLDER;
    }

    const redacted = this.dlpService.redactData(reason, relevantFindings) as string | undefined;
    if (redacted === undefined) {
      this.logger.warn('cancellation reason DLP failed-closed (redactData produced no output)', {
        tenant_id: tenantId, instance_id: instanceId, finding_count: relevantFindings.length,
      });
      return REDACT_PLACEHOLDER;
    }
    return redacted;
  }

  /**
   * Service-private audit shape builder. Mirrors WorkflowCentralOperatorService's
   * baseAudit so the audit log columns are populated consistently across the
   * operator-action set (PR-OP-2 task surface + PR-OP-3 instance surface).
   */
  private baseAudit(
    action: string,
    args: { tenantId: string; instanceId?: string; taskId?: string },
    startedAt: number,
    actorId: string | null,
  ): Omit<NewAuditLog, 'result' | 'details' | 'error_message'> & { error_message: string | null } {
    return {
      tenant_id: args.tenantId,
      user_id: actorId ?? '',
      action,
      resource_type: 'workflow_central_instance',
      resource_id: args.instanceId ?? args.taskId ?? '',
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      duration_ms: Date.now() - startedAt,
      error_message: null,
    };
  }

  /**
   * Best-effort audit. NEVER throws. Increments
   * workflow_central_audit_delivery_failures_total when audit insert fails
   * AFTER a durable state TX commit — surfacing the durability gap to
   * operators per D15.
   */
  private async safeAudit(entry: NewAuditLog): Promise<void> {
    try {
      await this.auditLog.create(entry);
    } catch (err) {
      this.logger.warn(
        'audit log write failed for workflow-central instance action (instance state durable; audit gap)',
        {
          action: entry.action,
          resource_id: entry.resource_id,
          error: err instanceof Error ? err.message : String(err),
          error_class: err instanceof Error ? err.constructor.name : 'unknown',
        },
      );
      workflowCentralAuditDeliveryFailures.inc({
        action: (entry.action ?? '').replace('workflow_central.', ''),
        outcome: 'thrown',
      });
    }
  }
}
