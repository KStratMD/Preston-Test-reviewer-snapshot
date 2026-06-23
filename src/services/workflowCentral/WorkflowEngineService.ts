/**
 * WorkflowEngineService — in-memory cache + cascade planner for WorkflowCentral.
 *
 * Post-PR-OP-3 (T5) responsibilities:
 *   - Owns the definitions Map (WorkflowDefinition).
 *   - Owns the instances Map (WorkflowInstance) as a CACHE of the canonical
 *     durable state in `workflow_central_instances`. Cache writes happen
 *     exclusively via `refreshCacheFromCommit` after a TX commits successfully
 *     (D9 atomic Map.set incl. cancellationReason; D10 createInstance returns
 *     ephemeral and is cached by the caller post-commit).
 *   - Provides Definition CRUD.
 *   - planCascade() is a near-PURE function: it does NOT mutate the
 *     `definitions` or `instances` Maps, but DOES bump the engine-level
 *     `idSeq` counter (via buildTaskRowForStep) when minting new TASK-/EXEC-
 *     IDs for the proposed downstream rows.
 *   - buildInitialTaskRow() produces a NewTaskRow for the first task/approval step.
 *   - hydrate() rebuilds the cache from the DB on boot; readiness gate (T6)
 *     observes `hydrationReady`.
 *   - getInstanceFromAnywhere() reads cache-first, falls back to a single
 *     non-locking DB SELECT, and warms the cache for in-window rows (D24).
 *   - seedDemoDefinitions() seeds definitions for non-production startup.
 *   - getDemoInstanceRows() returns the demo instance rows (NewInstanceRow[]) for
 *     the caller (demoSeed.ts) to insert via repo within a TX (T12).
 *
 * DELETED in T5 (DB is now canonical; direct Map mutators are forbidden):
 *   - applyVolatileState — replaced by post-commit refreshCacheFromCommit.
 *   - setInstanceStatus / setInstanceStatusForTenant — DB UPDATE then refresh.
 *   - updateStepHistory — repo.updateInstanceForTenant({kind:'completeTask'})
 *     appends to step_history; cache is then refreshed.
 *   - deleteInstance — instance rows are durable; cancel writes status.
 *
 * NO DatabaseService or Repository imports — this service binds sync. Methods
 * that need DB access take `repo` as a method parameter.
 *
 * See docs/plans/2026-05-15-workflow-central-instance-durability-plan.md T5.
 */

import { injectable, inject } from 'inversify';
import { TYPES } from '../../inversify/types';
import type { Logger } from '../../utils/Logger';
import { SYSTEM_IDENTITY } from '../governance/identityContext';
import type {
  WorkflowDefinition,
  WorkflowInstance,
  WorkflowStep,
  StepExecution,
  TaskAction,
} from '../WorkflowCentralService';
import type { CascadePlan, NewInstanceRow, NewTaskRow, PersistedInstance, PersistedTask } from './types';
import { recentTerminalHydrationDays } from './config';
import { countActiveInstances, workflowCentralInstanceActiveCount } from './metrics';

// Re-export for callers who compose this with WorkflowCentralService types.
export type { WorkflowDefinition, WorkflowInstance, TaskAction, CascadePlan, NewTaskRow, PersistedTask };

// Module-level constants (hoisted out of hot paths).
const TERMINAL_STATUSES: ReadonlySet<WorkflowInstance['status']> = new Set([
  'completed', 'cancelled', 'failed',
]);

// Snake_case PersistedInstance → camelCase WorkflowInstance. The single source
// of mapping truth used by both refreshCacheFromCommit (write path, with Map
// side-effect) and getInstanceFromAnywhere (read path, no Map mutation).
// paused_from_status is intentionally NOT mapped — see WorkflowInstance type.
export function persistedToWorkflowInstance(
  row: PersistedInstance,
  cancellationReason: string | null,
): WorkflowInstance {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    workflowVersion: row.workflow_version,
    status: row.status,
    currentStepId: row.current_step_id,
    currentStepName: row.current_step_name,
    variables: row.variables,
    stepHistory: row.step_history,
    startedBy: row.started_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    dueAt: row.due_at,
    error: row.error,
    cancellationReason,
  };
}

// ============================================================================
// Filters / results
// ============================================================================

export interface DefinitionFilters {
  category?: string;
  status?: WorkflowDefinition['status'];
  search?: string;
  limit?: number;
  offset?: number;
}

export interface InstanceFilters {
  workflowId?: string;
  status?: WorkflowInstance['status'];
  // Multi-status filter (DB-only, repo `listInstances`). The route translates
  // the synthetic `status=active` query string into `statuses=['running',
  // 'waiting', 'unknown_recovered']` so /instances?status=active surfaces
  // backfilled `unknown_recovered` rows alongside currently-executing ones
  // (spec §3.5 / D5). When both `status` and `statuses` are set, a NON-EMPTY
  // `statuses` takes precedence; an empty `statuses` array is ignored and
  // `status` (if present) applies as a single-value predicate.
  statuses?: WorkflowInstance['status'][];
  startedBy?: string;
  limit?: number;
  offset?: number;
}

// ============================================================================
// CreateDefinition input
// ============================================================================

export interface CreateDefinitionInput {
  name: string;
  description: string;
  category: string;
  triggerType: WorkflowDefinition['triggerType'];
  triggerConfig?: Record<string, unknown>;
  steps?: WorkflowDefinition['steps'];
  variables?: WorkflowDefinition['variables'];
  slaHours?: number;
  createdBy: string;
}

// ============================================================================
// WorkflowEngineService
// ============================================================================

@injectable()
export class WorkflowEngineService {
  /** Keyed by definition id. */
  private definitions = new Map<string, WorkflowDefinition>();

  /**
   * Keyed by instance id. CACHE of `workflow_central_instances`. The DB is the
   * source of truth — see refreshCacheFromCommit (write path) and
   * getInstanceFromAnywhere (read path) for the read/write contract (D9, D24).
   */
  private instances = new Map<string, WorkflowInstance>();

  /** Monotonic counter for collision-safe IDs within a single engine instance. */
  private idSeq = 0;

  /**
   * Boot-time readiness flag (spec §3.3, T-25). False until `hydrate()` has
   * loaded the instance cache from the DB. The route-side readiness middleware
   * (T6) returns 503 while false; flipping to true is the LAST step of hydrate
   * after the active-count gauge is emitted (§6.2 OOM-resilience).
   */
  public hydrationReady = false;

  constructor(
    @inject(TYPES.Logger) private readonly logger: Logger
  ) {}

  // ==========================================================================
  // Definition CRUD
  // ==========================================================================

  getDefinition(id: string): WorkflowDefinition | null {
    return this.definitions.get(id) ?? null;
  }

  getDefinitions(filters?: DefinitionFilters): { definitions: WorkflowDefinition[]; total: number } {
    let defs = Array.from(this.definitions.values());

    if (filters?.category) {
      defs = defs.filter(d => d.category === filters.category);
    }
    if (filters?.status) {
      defs = defs.filter(d => d.status === filters.status);
    }
    if (filters?.search) {
      const q = filters.search.toLowerCase();
      defs = defs.filter(d =>
        d.name.toLowerCase().includes(q) || d.description.toLowerCase().includes(q)
      );
    }

    defs.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const total = defs.length;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 50;

    return { definitions: defs.slice(offset, offset + limit), total };
  }

  createDefinition(data: CreateDefinitionInput): WorkflowDefinition {
    const id = `WF-${Date.now()}-${++this.idSeq}`;
    const now = new Date().toISOString();

    const definition: WorkflowDefinition = {
      id,
      name: data.name,
      description: data.description,
      category: data.category,
      version: 1,
      status: 'draft',
      triggerType: data.triggerType,
      triggerConfig: data.triggerConfig ?? {},
      steps: data.steps ?? [],
      variables: data.variables ?? [],
      slaHours: data.slaHours ?? null,
      createdBy: data.createdBy,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };

    this.definitions.set(id, definition);
    this.logger.info('WorkflowEngineService: created definition', { workflowId: id });
    return definition;
  }

  updateDefinition(
    id: string,
    updates: Partial<Pick<
      WorkflowDefinition,
      'name' | 'description' | 'category' | 'triggerType' | 'triggerConfig' | 'steps' | 'variables' | 'slaHours'
    >>
  ): WorkflowDefinition | null {
    const def = this.definitions.get(id);
    // Only draft definitions may be updated.
    if (!def || def.status !== 'draft') return null;

    if (updates.name !== undefined) def.name = updates.name;
    if (updates.description !== undefined) def.description = updates.description;
    if (updates.category !== undefined) def.category = updates.category;
    if (updates.triggerType !== undefined) def.triggerType = updates.triggerType;
    if (updates.triggerConfig !== undefined) def.triggerConfig = updates.triggerConfig;
    if (updates.steps !== undefined) def.steps = updates.steps;
    // WorkflowDefinition.variables is a `WorkflowVariable[]` (variable
    // DECLARATIONS on the workflow template, not runtime customer data).
    // Out of scope for ADR-019 Phase 1 (targets WorkflowInstance.variables /
    // Task.data — runtime values, not definition schemas).
    // LEGACY-COMPAT: payload-custody-gate
    if (updates.variables !== undefined) def.variables = updates.variables;
    if (updates.slaHours !== undefined) def.slaHours = updates.slaHours;

    def.updatedAt = new Date().toISOString();
    this.definitions.set(id, def);
    return def;
  }

  /**
   * Set the definition lifecycle status (draft / active / paused / archived).
   * Copilot R12 SHOULD-FIX: integration tests previously reached into the
   * private `definitions` Map via `as unknown as { definitions: Map<...> }`
   * to flip a draft definition to 'active' before exercising the start path.
   * This public method replaces that cast pattern (used in startInstance /
   * completeTask / cancelInstance integration tests).
   *
   * Returns the updated definition, or null if the id is not registered.
   * No additional state-transition validation is enforced here — callers
   * choose any valid status; production code paths still go through the
   * normal create/update/publish lifecycle.
   */
  setDefinitionStatus(
    id: string,
    status: WorkflowDefinition['status'],
  ): WorkflowDefinition | null {
    const def = this.definitions.get(id);
    if (!def) return null;
    def.status = status;
    def.updatedAt = new Date().toISOString();
    return def;
  }

  // ==========================================================================
  // Instance CRUD
  // ==========================================================================

  getInstance(tenantId: string, id: string): WorkflowInstance | null {
    const inst = this.instances.get(id) ?? null;
    if (!inst) return null;
    // Cross-tenant guard: only return if tenantId matches.
    if (inst.tenantId !== tenantId) return null;
    return inst;
  }

  getInstances(tenantId: string, filters?: InstanceFilters): { instances: WorkflowInstance[]; total: number } {
    let insts = Array.from(this.instances.values()).filter(i => i.tenantId === tenantId);

    if (filters?.workflowId) {
      insts = insts.filter(i => i.workflowId === filters.workflowId);
    }
    if (filters?.status) {
      insts = insts.filter(i => i.status === filters.status);
    }
    if (filters?.startedBy) {
      insts = insts.filter(i => i.startedBy === filters.startedBy);
    }

    insts.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());

    const total = insts.length;
    const offset = filters?.offset ?? 0;
    const limit = filters?.limit ?? 50;

    return { instances: insts.slice(offset, offset + limit), total };
  }

  /**
   * createInstance — produces an EPHEMERAL WorkflowInstance object (D10).
   *
   * Post-PR-OP-3 T5: this method NO LONGER writes to the in-memory `instances`
   * Map. The caller (`WorkflowCentralService.startInstance`, T9) is responsible
   * for persisting via `repo.insertInstance(tx, …)` inside a TX and, ONLY after
   * the TX commits successfully, calling `refreshCacheFromCommit({instance})`
   * to populate the cache. This makes the DB the canonical source of truth and
   * prevents a partial-failure window where a cached instance exists with no
   * matching DB row (the pre-T5 footgun that motivated this PR).
   */
  createInstance(
    tenantId: string,
    workflowId: string,
    variables: Record<string, unknown>,
    startedBy: string
  ): WorkflowInstance {
    const definition = this.definitions.get(workflowId);
    const id = `INST-${Date.now()}-${++this.idSeq}`;
    const now = new Date().toISOString();

    const firstStep = definition?.steps.find(s => s.order === 1);
    const dueAt = definition?.slaHours
      ? new Date(Date.now() + definition.slaHours * 3_600_000).toISOString()
      : null;

    const instance: WorkflowInstance = {
      id,
      tenantId,
      workflowId,
      workflowName: definition?.name ?? workflowId,
      workflowVersion: definition?.version ?? 1,
      status: 'running',
      currentStepId: firstStep?.id ?? null,
      currentStepName: firstStep?.name ?? null,
      variables,
      startedBy,
      startedAt: now,
      completedAt: null,
      dueAt,
      error: null,
      stepHistory: [],
    };

    // D10: deliberately NOT cached here. Caller persists then calls
    // refreshCacheFromCommit(). See class-level docstring.
    return instance;
  }

  /**
   * refreshCacheFromCommit — single write path into the `instances` Map.
   *
   * Called by every operator action AFTER its TX commits successfully. Maps
   * snake_case `PersistedInstance` (canonical DB shape) → camelCase
   * `WorkflowInstance` (the in-process planner shape) and writes the result to
   * the Map. The optional `cancellationReason` (D8 DLP carve-out — never durable)
   * is stamped in the SAME Map.set as the rest of the instance (D9 atomicity).
   *
   * Write-path age gate: terminal rows older than `recentTerminalHydrationDays`
   * are EVICTED rather than cached, matching the SQL WHERE in
   * `repo.listInstancesForHydration` (§4.4) so the Map's size invariant holds
   * for long-lived processes:
   *   |Map| ≤ |active instances| + |terminals within recentTerminalHydrationDays|
   *
   * Returns the cached camelCase `WorkflowInstance` for the caller to surface
   * to the operator UI / route response.
   */
  refreshCacheFromCommit(payload: {
    instance: PersistedInstance;
    cancellationReason?: string | null;
  }): WorkflowInstance {
    // Note: PersistedInstance.paused_from_status (D23) is intentionally NOT
    // mapped onto WorkflowInstance — the cached shape is the operator-facing
    // surface and resume restores the prior status via repo.selectInstanceForUpdate.
    const cached: WorkflowInstance = persistedToWorkflowInstance(
      payload.instance,
      payload.cancellationReason ?? null,
    );
    try {
      if (this.isWithinHydrationSet(payload.instance)) {
        this.instances.set(cached.id, cached);
      } else {
        // Already-cached row aged out of the window → drop it. New reads will
        // miss the cache and fall back to repo.getInstanceById which won't
        // re-warm because the row also fails isWithinHydrationSet().
        this.instances.delete(cached.id);
      }
      // Live active-instance gauge — every write keeps the metric current.
      // Filters to non-terminal statuses so the count matches the semantic the
      // gauge name advertises ('active'), not raw cache size.
      workflowCentralInstanceActiveCount.set(countActiveInstances([...this.instances.values()]));
    } catch (err) {
      this.logger.warn(
        'refreshCacheFromCommit Map mutation failed (DB is canonical; next read hydrates)',
        { instance_id: cached.id, error: (err as Error).message },
      );
    }
    return cached;
  }

  /**
   * hydrate — rebuild the in-memory instance cache from the DB on boot.
   *
   * Sets `hydrationReady = false` first, clears the Map, then re-populates from
   * `repo.listInstancesForHydration()` (active + recent-terminal rows). Emits
   * the active-count gauge BEFORE flipping `hydrationReady = true` so that a
   * metric-emit failure surfaces as not-ready (503) per spec §3.3 step 3 /
   * §6.2 OOM-resilience.
   *
   * If `listInstancesForHydration` rejects, the await re-throws; `hydrationReady`
   * stays false and the readiness gate (T6) will continue returning 503. We
   * INTENTIONALLY do not swallow — the gate needs to see the false flag.
   */
  async hydrate(repo: {
    listInstancesForHydration(tenantId?: string): Promise<PersistedInstance[]>;
  }): Promise<void> {
    this.hydrationReady = false;
    this.instances.clear();
    const rows = await repo.listInstancesForHydration();
    for (const row of rows) {
      this.refreshCacheFromCommit({ instance: row });
    }
    workflowCentralInstanceActiveCount.set(countActiveInstances(rows));
    this.hydrationReady = true;
    this.logger.info('WorkflowEngineService.hydrate complete', { count: rows.length });
  }

  /**
   * D24 cache-miss DB-read fallback used by read-only routes outside a mutating
   * TX (GET /instances/:id). MUST NOT be called inside a mutating TX — there
   * the locking repo.selectInstanceForUpdate is required.
   *
   * Cache key is the instance `id` alone (PR-OP-2 convention — see getInstance
   * above). Instance ids are globally unique across tenants; tenant defence is
   * applied AFTER the lookup to avoid leaking cached rows cross-tenant.
   *
   * Warm-back is gated to the hydration set (§4.4) so audit-drilldown reads on
   * old terminal rows don't grow the cache unboundedly.
   */
  async getInstanceFromAnywhere(
    repo: { getInstanceById(tenantId: string, id: string): Promise<PersistedInstance | null> },
    tenantId: string,
    id: string,
  ): Promise<WorkflowInstance | null> {
    const cached = this.instances.get(id);
    if (cached) {
      return cached.tenantId === tenantId ? cached : null;
    }
    const row = await repo.getInstanceById(tenantId, id);
    if (!row) return null;
    if (this.isWithinHydrationSet(row)) {
      this.refreshCacheFromCommit({ instance: row });
    }
    // cancellationReason is the D8 DLP carve-out — NEVER durable, so always null when sourced from the DB.
    return persistedToWorkflowInstance(row, null);
  }

  /**
   * Hydration-set predicate; mirrors the SQL WHERE in
   * `repo.listInstancesForHydration` (§4.4). Active statuses always qualify;
   * terminal rows must have `completed_at` within the recent-terminal window.
   */
  private isWithinHydrationSet(row: PersistedInstance): boolean {
    if (!TERMINAL_STATUSES.has(row.status)) return true;
    const cutoffMs = Date.now() - recentTerminalHydrationDays * 86_400_000;
    return row.completed_at != null && Date.parse(row.completed_at) >= cutoffMs;
  }

  /**
   * Public observability accessor for hydration tests + metrics callers. The
   * `instances` Map remains private; this returns just the size.
   */
  public getCacheSize(): number {
    return this.instances.size;
  }

  // ==========================================================================
  // Cascade planning (PURE — no Map mutation)
  // ==========================================================================

  /**
   * planCascade — pure function.  Returns a CascadePlan describing downstream
   * task rows and instance mutations to apply post-commit.  Does NOT mutate any
   * Map.
   */
  planCascade(
    task: PersistedTask,
    instance: WorkflowInstance | null,
    action: TaskAction
  ): CascadePlan {
    if (instance === null) {
      return { downstreamTaskRows: [], instanceUpdates: null, workflowDefinitionMissing: true };
    }

    const definition = this.definitions.get(task.workflowId);
    if (!definition) {
      return { downstreamTaskRows: [], instanceUpdates: null, workflowDefinitionMissing: true };
    }

    const currentStep = definition.steps.find(s => s.id === task.stepId);
    if (!currentStep) {
      // Step not found in definition — return empty plan, not missing context.
      return { downstreamTaskRows: [], instanceUpdates: null, workflowDefinitionMissing: false };
    }

    // Build the stepHistory entry that applyVolatileState will append.
    const stepHistoryEntry: StepExecution = {
      id: `EXEC-${Date.now()}-${++this.idSeq}`,
      stepId: task.stepId,
      stepName: task.stepName,
      status: 'completed',
      assigneeId: task.assigneeId,
      assigneeName: task.assigneeName,
      startedAt: task.createdAt,
      completedAt: new Date().toISOString(),
      result: { action: action.type },
      error: null,
      comments: null,
    };

    // Reject path
    // Copilot R12 SHOULD-FIX: this matcher accepts both `'rejected'` and
    // `'reject'` as transition condition synonyms (definition authors
    // historically have written either). The accepted set is documented
    // on the `WorkflowTransition.condition` type at types.ts; canonical
    // form is `'rejected'`. Definition authors writing new workflows
    // should use `'rejected'`; `'reject'` is kept here for backwards
    // compatibility with existing seeded definitions.
    if (action.type === 'reject') {
      const rejectionTransition = currentStep.transitions.find(
        t => t.condition === 'rejected' || t.condition === 'reject'
      );

      if (rejectionTransition) {
        const rejectionStep = definition.steps.find(s => s.id === rejectionTransition.targetStepId);
        if (rejectionStep) {
          const downstreamTaskRows: NewTaskRow[] = [];
          if (rejectionStep.type === 'task' || rejectionStep.type === 'approval') {
            downstreamTaskRows.push(this.buildTaskRowForStep(instance, rejectionStep, definition));
          }
          return {
            downstreamTaskRows,
            instanceUpdates: {
              currentStepId: rejectionStep.id,
              currentStepName: rejectionStep.name,
              appendStepHistory: stepHistoryEntry,
            },
            workflowDefinitionMissing: false,
          };
        }
      }

      // No rejection transition → fail instance.
      return {
        downstreamTaskRows: [],
        instanceUpdates: {
          currentStepId: null,
          currentStepName: null,
          status: 'failed',
          appendStepHistory: stepHistoryEntry,
        },
        workflowDefinitionMissing: false,
      };
    }

    // Normal / default / order+1 path.
    let nextStepId: string | null = null;

    if (action.nextStepId) {
      nextStepId = action.nextStepId;
    } else {
      const defaultTransition = currentStep.transitions.find(t => t.isDefault);
      if (defaultTransition) {
        nextStepId = defaultTransition.targetStepId;
      } else {
        const nextStep = definition.steps.find(s => s.order === currentStep.order + 1);
        nextStepId = nextStep?.id ?? null;
      }
    }

    if (nextStepId) {
      const nextStep = definition.steps.find(s => s.id === nextStepId);
      if (nextStep) {
        const downstreamTaskRows: NewTaskRow[] = [];
        if (nextStep.type === 'task' || nextStep.type === 'approval') {
          downstreamTaskRows.push(this.buildTaskRowForStep(instance, nextStep, definition));
        }
        return {
          downstreamTaskRows,
          instanceUpdates: {
            currentStepId: nextStep.id,
            currentStepName: nextStep.name,
            appendStepHistory: stepHistoryEntry,
          },
          workflowDefinitionMissing: false,
        };
      }
    }

    // End-of-workflow.
    return {
      downstreamTaskRows: [],
      instanceUpdates: {
        currentStepId: null,
        currentStepName: null,
        status: 'completed',
        appendStepHistory: stepHistoryEntry,
      },
      workflowDefinitionMissing: false,
    };
  }

  /**
   * buildInitialTaskRow — produces a NewTaskRow for the first step of the
   * workflow definition (order === 1).  Returns null if the first step is missing
   * or is not of type 'task' or 'approval'.
   *
   * Spec R3 F-06.
   */
  buildInitialTaskRow(instance: WorkflowInstance, definition: WorkflowDefinition): NewTaskRow | null {
    const first = definition.steps.find(s => s.order === 1);
    if (!first) return null;
    if (first.type !== 'task' && first.type !== 'approval') return null;

    return this.buildTaskRowForStep(instance, first, definition);
  }

  // ==========================================================================
  // Demo seeding (non-production startup only)
  // ==========================================================================

  /**
   * seedDemoDefinitions — seeds the 3 demo workflow definitions into the
   * in-memory definitions Map.
   *
   * Definition durability is deferred per Known Gap #4 — definitions remain
   * volatile and are re-seeded on every boot. Instance seeding is now handled
   * by getDemoInstanceRows() + demoSeed.ts (T12).
   *
   * HARDCODED ids (`WF-1000`, `WF-1001`, `WF-1002`) are deliberate: demo seed
   * rows need stable, well-known ids so demoSeed.ts task rows (which reference
   * these instances) can pre-bind at compile time. Do NOT change to generated
   * ids without updating demoSeed and its tests too.
   */
  seedDemoDefinitions(): void {
    const now = new Date();

    // -------------------------------------------------------------------------
    // Definitions
    // -------------------------------------------------------------------------
    const demoDefinitions: (Omit<WorkflowDefinition, 'id' | 'createdAt' | 'updatedAt'> & { _id: string; _createdDaysAgo: number })[] = [
      {
        _id: 'WF-1000',
        _createdDaysAgo: 90,
        name: 'Purchase Order Approval',
        description: 'Multi-level approval workflow for purchase orders',
        category: 'Finance',
        version: 1,
        status: 'active',
        triggerType: 'event',
        triggerConfig: { event: 'purchase_order_created', threshold: 1000 },
        steps: [
          {
            id: 'STEP-1', name: 'Manager Approval', type: 'approval', order: 1,
            config: { approvalType: 'single', assigneeType: 'role', assigneeValue: 'manager' },
            transitions: [{ id: 'T1', targetStepId: 'STEP-2', isDefault: true }],
            timeoutHours: 24, retryPolicy: null,
          },
          {
            id: 'STEP-2', name: 'Finance Review', type: 'task', order: 2,
            config: { taskType: 'review', assigneeType: 'group', assigneeValue: 'finance-team' },
            transitions: [{ id: 'T2', targetStepId: 'STEP-3', isDefault: true }],
            timeoutHours: 48, retryPolicy: null,
          },
          {
            id: 'STEP-3', name: 'CFO Approval', type: 'approval', order: 3,
            config: { approvalType: 'single', assigneeType: 'user', assigneeValue: 'cfo' },
            transitions: [],
            timeoutHours: 24, retryPolicy: null,
          },
        ],
        variables: [
          { name: 'poNumber', type: 'string', required: true },
          { name: 'amount', type: 'number', required: true },
          { name: 'vendor', type: 'string', required: true },
        ],
        slaHours: 72,
        createdBy: 'system',
        publishedAt: new Date(now.getTime() - 30 * 24 * 3_600_000).toISOString(),
      },
      {
        _id: 'WF-1001',
        _createdDaysAgo: 70,
        name: 'Employee Onboarding',
        description: 'New employee onboarding workflow',
        category: 'HR',
        version: 1,
        status: 'active',
        triggerType: 'manual',
        triggerConfig: {},
        steps: [
          {
            id: 'STEP-1', name: 'IT Setup', type: 'task', order: 1,
            config: { taskType: 'setup', assigneeType: 'group', assigneeValue: 'it-team' },
            transitions: [{ id: 'T1', targetStepId: 'STEP-2', isDefault: true }],
            timeoutHours: 24, retryPolicy: null,
          },
          {
            id: 'STEP-2', name: 'HR Orientation', type: 'task', order: 2,
            config: { taskType: 'orientation', assigneeType: 'role', assigneeValue: 'hr-rep' },
            transitions: [{ id: 'T2', targetStepId: 'STEP-3', isDefault: true }],
            timeoutHours: 8, retryPolicy: null,
          },
          {
            id: 'STEP-3', name: 'Manager Welcome', type: 'notification', order: 3,
            config: { notificationTemplate: 'welcome_email' },
            transitions: [],
            timeoutHours: null, retryPolicy: null,
          },
        ],
        variables: [
          { name: 'employeeName', type: 'string', required: true },
          { name: 'department', type: 'string', required: true },
          { name: 'startDate', type: 'date', required: true },
        ],
        slaHours: 48,
        createdBy: 'system',
        publishedAt: new Date(now.getTime() - 60 * 24 * 3_600_000).toISOString(),
      },
      {
        _id: 'WF-1002',
        _createdDaysAgo: 50,
        name: 'Invoice Processing',
        description: 'Automated invoice processing and approval',
        category: 'Finance',
        version: 2,
        status: 'active',
        triggerType: 'api',
        triggerConfig: { endpoint: '/api/invoices/process' },
        steps: [
          {
            id: 'STEP-1', name: 'Data Validation', type: 'integration', order: 1,
            config: { integrationId: 'validation-service' },
            transitions: [{ id: 'T1', targetStepId: 'STEP-2', isDefault: true }],
            timeoutHours: 1,
            retryPolicy: { maxRetries: 3, retryDelayMinutes: 5, backoffMultiplier: 2 },
          },
          {
            id: 'STEP-2', name: 'Approval', type: 'approval', order: 2,
            config: { approvalType: 'single', assigneeType: 'role', assigneeValue: 'ap-manager' },
            transitions: [{ id: 'T2', targetStepId: 'STEP-3', isDefault: true }],
            timeoutHours: 24, retryPolicy: null,
          },
          {
            id: 'STEP-3', name: 'Payment Processing', type: 'integration', order: 3,
            config: { integrationId: 'payment-service' },
            transitions: [],
            timeoutHours: 4,
            retryPolicy: { maxRetries: 2, retryDelayMinutes: 15, backoffMultiplier: 1.5 },
          },
        ],
        variables: [
          { name: 'invoiceNumber', type: 'string', required: true },
          { name: 'amount', type: 'number', required: true },
          { name: 'vendorId', type: 'string', required: true },
        ],
        slaHours: 48,
        createdBy: 'system',
        publishedAt: new Date(now.getTime() - 15 * 24 * 3_600_000).toISOString(),
      },
    ];

    for (const { _id, _createdDaysAgo, ...rest } of demoDefinitions) {
      const createdAt = new Date(now.getTime() - _createdDaysAgo * 24 * 3_600_000).toISOString();
      this.definitions.set(_id, { ...rest, id: _id, createdAt, updatedAt: createdAt } as WorkflowDefinition);
    }

    this.logger.info('WorkflowEngineService: demo definitions seeded', { definitions: this.definitions.size });
  }

  /**
   * getDemoInstanceRows — returns the 3 demo instance rows in NewInstanceRow shape
   * (camelCase). Pure — no Map mutation, no DB write. The caller (demoSeed.ts)
   * inserts these rows inside a TX via repo.insertInstance.
   *
   * tenantId = SYSTEM_IDENTITY.tenantId per spec D6.
   * pausedFromStatus is null for all 3 (none are paused).
   */
  getDemoInstanceRows(): NewInstanceRow[] {
    const now = new Date();
    return [
      {
        id: 'INST-1000',
        tenantId: SYSTEM_IDENTITY.tenantId,
        workflowId: 'WF-1000',
        workflowName: 'Purchase Order Approval',
        workflowVersion: 1,
        status: 'running',
        currentStepId: 'STEP-2',
        currentStepName: 'Finance Review',
        variables: { poNumber: 'PO-2024-001', amount: 25000, vendor: 'Acme Supplies' },
        payload: {
          mode: 'external_reference',
          references: [{
            system: 'netsuite',
            recordType: 'purchaseOrder',
            recordId: 'PO-2024-001',
            displayHint: 'PO-2024-001 — Acme Supplies — $25,000',
          }],
        },
        startedBy: 'john.smith',
        startedAt: new Date(now.getTime() - 5 * 24 * 3_600_000).toISOString(),
        completedAt: null,
        dueAt: new Date(now.getTime() + 24 * 3_600_000).toISOString(),
        error: null,
        pausedFromStatus: null,
        stepHistory: [
          {
            id: 'EXEC-1', stepId: 'STEP-1', stepName: 'Manager Approval', status: 'completed',
            assigneeId: 'manager1', assigneeName: 'Jane Manager',
            startedAt: new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString(),
            completedAt: new Date(now.getTime() - 1 * 24 * 3_600_000).toISOString(),
            result: { action: 'approve' }, error: null, comments: 'Approved',
          },
        ],
      },
      {
        id: 'INST-1001',
        tenantId: SYSTEM_IDENTITY.tenantId,
        workflowId: 'WF-1001',
        workflowName: 'Employee Onboarding',
        workflowVersion: 1,
        status: 'waiting',
        currentStepId: 'STEP-1',
        currentStepName: 'IT Setup',
        variables: { employeeName: 'Bob Johnson', department: 'Engineering', startDate: '2025-02-01' },
        payload: {
          mode: 'external_reference',
          references: [{
            system: 'netsuite',
            recordType: 'employee',
            recordId: 'EMP-BOB-JOHNSON-2025-02-01',
            displayHint: 'Bob Johnson — Engineering — starts 2025-02-01',
          }],
        },
        startedBy: 'hr.admin',
        startedAt: new Date(now.getTime() - 4 * 24 * 3_600_000).toISOString(),
        completedAt: null,
        dueAt: new Date(now.getTime() + 36 * 3_600_000).toISOString(),
        error: null,
        pausedFromStatus: null,
        stepHistory: [],
      },
      {
        id: 'INST-1002',
        tenantId: SYSTEM_IDENTITY.tenantId,
        workflowId: 'WF-1002',
        workflowName: 'Invoice Processing',
        workflowVersion: 2,
        status: 'completed',
        currentStepId: null,
        currentStepName: null,
        variables: { invoiceNumber: 'INV-2024-500', amount: 15750, vendorId: 'VEND-001' },
        payload: {
          mode: 'external_reference',
          references: [{
            system: 'netsuite',
            recordType: 'vendorBill',
            recordId: 'INV-2024-500',
            displayHint: 'INV-2024-500 — VEND-001 — $15,750',
          }],
        },
        startedBy: 'ap.clerk',
        startedAt: new Date(now.getTime() - 3 * 24 * 3_600_000).toISOString(),
        completedAt: new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString(),
        dueAt: new Date(now.getTime() - 1 * 24 * 3_600_000).toISOString(),
        error: null,
        pausedFromStatus: null,
        stepHistory: [
          {
            id: 'EXEC-1', stepId: 'STEP-1', stepName: 'Data Validation', status: 'completed',
            assigneeId: null, assigneeName: null,
            startedAt: new Date(now.getTime() - 4 * 24 * 3_600_000).toISOString(),
            completedAt: new Date(now.getTime() - 4 * 24 * 3_600_000 + 30 * 60_000).toISOString(),
            result: { valid: true }, error: null, comments: null,
          },
          {
            id: 'EXEC-2', stepId: 'STEP-2', stepName: 'Approval', status: 'completed',
            assigneeId: 'ap-mgr', assigneeName: 'AP Manager',
            startedAt: new Date(now.getTime() - 4 * 24 * 3_600_000 + 3_600_000).toISOString(),
            completedAt: new Date(now.getTime() - 3 * 24 * 3_600_000).toISOString(),
            result: { action: 'approve' }, error: null, comments: 'Verified and approved',
          },
          {
            id: 'EXEC-3', stepId: 'STEP-3', stepName: 'Payment Processing', status: 'completed',
            assigneeId: null, assigneeName: null,
            startedAt: new Date(now.getTime() - 3 * 24 * 3_600_000).toISOString(),
            completedAt: new Date(now.getTime() - 2 * 24 * 3_600_000).toISOString(),
            result: { paymentId: 'PAY-12345' }, error: null, comments: null,
          },
        ],
      },
    ];
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  /**
   * buildTaskRowForStep — shared builder used by planCascade and buildInitialTaskRow.
   * Produces a NewTaskRow for the given step.
   */
  private buildTaskRowForStep(
    instance: WorkflowInstance,
    step: WorkflowStep,
    definition: WorkflowDefinition
  ): NewTaskRow {
    const now = new Date().toISOString();
    const dueAt = step.timeoutHours
      ? new Date(Date.now() + step.timeoutHours * 3_600_000).toISOString()
      : null;

    const actions: TaskAction[] =
      step.type === 'approval'
        ? [
            { id: 'approve', label: 'Approve', type: 'approve', requiresComment: false },
            { id: 'reject', label: 'Reject', type: 'reject', requiresComment: true },
          ]
        : [{ id: 'complete', label: 'Complete', type: 'complete', requiresComment: false }];

    return {
      id: `TASK-${Date.now()}-${++this.idSeq}`,
      tenantId: instance.tenantId,
      instanceId: instance.id,
      workflowId: definition.id,
      workflowName: definition.name,
      stepId: step.id,
      stepName: step.name,
      taskType: step.type,
      status: 'pending',
      priority: 'medium',
      // Copilot R7 SHOULD-FIX: assigneeValue may be a userId, role name (e.g.
      // 'manager'), or group name (e.g. 'finance-team') depending on
      // step.config.assigneeType. Today we store the raw value into both
      // assigneeId and assigneeName, which makes listByAssignee(tenantId, userId)
      // miss role/group-targeted tasks unless userId === role-name literally.
      // The previous in-memory implementation had the same shape, but persisting
      // it durably mis-keys role-targeted tasks. PR-OP-5 follow-up: resolve
      // assigneeType==='role'/'group' to one-or-many user IDs via a governance-
      // side role resolver before insert. Tracked as Known Gap in proof card.
      assigneeId: step.config.assigneeValue ?? 'unassigned',
      assigneeName: step.config.assigneeValue ?? 'Unassigned',
      description: `${step.name} for ${definition.name}`,
      dueAt,
      data: instance.variables,
      actions,
      createdAt: now,
      updatedAt: now,
    };
  }
}
