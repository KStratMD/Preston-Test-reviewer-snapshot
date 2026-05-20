/**
 * WorkflowEngineService Unit Tests
 *
 * Post-PR-OP-3 T5: covers Definition CRUD, Instance CRUD (cache-read only),
 * Cascade planning, buildInitialTaskRow, refreshCacheFromCommit, hydrate, and
 * getInstanceFromAnywhere.
 *
 * Tests for the deleted direct-Map-mutators (applyVolatileState,
 * setInstanceStatus[ForTenant], updateStepHistory, deleteInstance) have been
 * removed; the durable equivalents live behind repo.updateInstanceForTenant
 * and refreshCacheFromCommit.
 *
 * Spec ref: docs/plans/2026-05-15-workflow-central-instance-durability-plan.md T5
 */

import 'reflect-metadata';
import { WorkflowEngineService } from '../../../../src/services/workflowCentral/WorkflowEngineService';
import type { Logger } from '../../../../src/utils/Logger';
import type {
  WorkflowDefinition,
  WorkflowInstance,
  TaskAction,
} from '../../../../src/services/WorkflowCentralService';
import type {
  PersistedInstance,
  PersistedTask,
} from '../../../../src/services/workflowCentral/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

let seq = 0;
function makeEngine(): WorkflowEngineService {
  return new WorkflowEngineService(makeLogger());
}

function makeDefinition(engine: WorkflowEngineService, overrides: Partial<{
  name: string;
  category: string;
  steps: WorkflowDefinition['steps'];
}> = {}): WorkflowDefinition {
  seq++;
  return engine.createDefinition({
    name: overrides.name ?? `Workflow ${seq}`,
    description: 'Test workflow',
    category: overrides.category ?? 'Test',
    triggerType: 'manual',
    steps: overrides.steps ?? [],
    createdBy: 'test',
  });
}

function makeInstance(engine: WorkflowEngineService, tenantId = 'tnt_A', workflowId = 'wf-x'): WorkflowInstance {
  return engine.createInstance(tenantId, workflowId, { key: 'value' }, 'user1');
}

/** Minimal two-step definition: step1=approval, step2=task, with reject transition. */
function makeTwoStepDefinition(engine: WorkflowEngineService): WorkflowDefinition {
  return makeDefinition(engine, {
    name: 'Two Step',
    steps: [
      {
        id: 'STEP-1',
        name: 'Manager Approval',
        type: 'approval',
        order: 1,
        config: { assigneeValue: 'manager' },
        transitions: [
          { id: 'T-rej', targetStepId: 'STEP-REJ', condition: 'reject', isDefault: false },
          { id: 'T-def', targetStepId: 'STEP-2', isDefault: true },
        ],
        timeoutHours: 24,
        retryPolicy: null,
      },
      {
        id: 'STEP-2',
        name: 'Finance Review',
        type: 'task',
        order: 2,
        config: { assigneeValue: 'finance' },
        transitions: [],
        timeoutHours: 8,
        retryPolicy: null,
      },
      {
        id: 'STEP-REJ',
        name: 'Rejection Review',
        type: 'task',
        order: 10,
        config: { assigneeValue: 'reviewer' },
        transitions: [],
        timeoutHours: null,
        retryPolicy: null,
      },
    ],
  });
}

function makePersistedInstance(overrides: Partial<PersistedInstance> = {}): PersistedInstance {
  const now = new Date().toISOString();
  return {
    id: 'INST-PERSIST-1',
    tenant_id: 'tnt_A',
    workflow_id: 'WF-X',
    workflow_name: 'Persisted Workflow',
    workflow_version: 1,
    status: 'running',
    current_step_id: 'STEP-1',
    current_step_name: 'Step One',
    variables: { key: 'value' },
    step_history: [],
    started_by: 'user-1',
    started_at: now,
    completed_at: null,
    due_at: null,
    error: null,
    paused_from_status: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function makePersistedTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: 'TASK-T1',
    tenantId: 'tnt_A',
    instanceId: 'INST-1',
    workflowId: 'WF-X',
    workflowName: 'Test Wf',
    stepId: 'STEP-1',
    stepName: 'Manager Approval',
    taskType: 'approval',
    status: 'pending',
    priority: 'medium',
    assigneeId: 'user_mgr',
    assigneeName: 'Manager',
    description: 'Approve',
    dueAt: null,
    data: {},
    actions: [
      { id: 'approve', label: 'Approve', type: 'approve', requiresComment: false },
      { id: 'reject', label: 'Reject', type: 'reject', requiresComment: true },
    ],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    completedBy: null,
    completionActionId: null,
    completionComment: null,
    ...overrides,
  };
}

const approveAction: TaskAction = { id: 'approve', label: 'Approve', type: 'approve', requiresComment: false };
const rejectAction: TaskAction = { id: 'reject', label: 'Reject', type: 'reject', requiresComment: true };

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('WorkflowEngineService', () => {

  // ==========================================================================
  // Definition CRUD
  // ==========================================================================

  describe('Definition CRUD', () => {
    it('getDefinition returns null for unknown id', () => {
      const engine = makeEngine();
      expect(engine.getDefinition('nonexistent')).toBeNull();
    });

    it('createDefinition populates id + timestamps + status=draft', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine);

      expect(def.id).toBeTruthy();
      expect(def.status).toBe('draft');
      expect(def.version).toBe(1);
      expect(def.createdAt).toBeTruthy();
      expect(def.updatedAt).toBeTruthy();
      expect(def.publishedAt).toBeNull();
    });

    it('updateDefinition only mutates draft definitions — returns null for active', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine);

      // Manually promote to active (simulating publish).
      const raw = engine.getDefinition(def.id)!;
      raw.status = 'active';
      // Update should now return null.
      const result = engine.updateDefinition(def.id, { name: 'New Name' });
      expect(result).toBeNull();
    });

    it('updateDefinition mutates a draft definition and updates updatedAt', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, { name: 'Original' });
      const before = def.updatedAt;

      // Advance clock slightly.
      const updated = engine.updateDefinition(def.id, { name: 'Updated', category: 'Finance' });
      expect(updated).not.toBeNull();
      expect(updated!.name).toBe('Updated');
      expect(updated!.category).toBe('Finance');
      expect(updated!.updatedAt >= before).toBe(true);
    });

    it('getDefinitions filters by status and category', () => {
      const engine = makeEngine();
      const d1 = makeDefinition(engine, { category: 'Finance' });
      const d2 = makeDefinition(engine, { category: 'HR' });
      // Manually mark d1 as active for filter test.
      engine.getDefinition(d1.id)!.status = 'active';

      const activeResult = engine.getDefinitions({ status: 'active' });
      expect(activeResult.definitions.some(d => d.id === d1.id)).toBe(true);
      expect(activeResult.definitions.some(d => d.id === d2.id)).toBe(false);

      const hrResult = engine.getDefinitions({ category: 'HR' });
      expect(hrResult.definitions.some(d => d.id === d2.id)).toBe(true);
    });

    it('getDefinitions paginates with offset + limit', () => {
      const engine = makeEngine();
      for (let i = 0; i < 5; i++) makeDefinition(engine);

      const page1 = engine.getDefinitions({ limit: 2, offset: 0 });
      const page2 = engine.getDefinitions({ limit: 2, offset: 2 });

      expect(page1.definitions).toHaveLength(2);
      expect(page1.total).toBeGreaterThanOrEqual(5);
      expect(page2.definitions).toHaveLength(2);
      // Pages must not overlap.
      const p1Ids = new Set(page1.definitions.map(d => d.id));
      expect(page2.definitions.every(d => !p1Ids.has(d.id))).toBe(true);
    });
  });

  // ==========================================================================
  // Instance CRUD
  // ==========================================================================

  describe('Instance CRUD', () => {
    it('getInstance returns null for unknown id', () => {
      const engine = makeEngine();
      expect(engine.getInstance('tnt_A', 'nonexistent')).toBeNull();
    });

    it('getInstance returns null when tenantId mismatches (cross-tenant guard, cache-side)', () => {
      const engine = makeEngine();
      // Populate the cache via refreshCacheFromCommit — createInstance no
      // longer caches (D10). The cross-tenant guard is on the cache READ.
      const persisted = makePersistedInstance({ tenant_id: 'tnt_A' });
      engine.refreshCacheFromCommit({ instance: persisted });
      expect(engine.getInstance('tnt_B', persisted.id)).toBeNull();
      expect(engine.getInstance('tnt_A', persisted.id)?.tenantId).toBe('tnt_A');
    });

    it('createInstance populates id, tenantId, and currentStepId from first step (ephemeral; NOT cached)', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          { id: 'S1', name: 'First', type: 'task', order: 1, config: {}, transitions: [], timeoutHours: null, retryPolicy: null },
        ],
      });

      // Publish the definition so it can be used.
      engine.getDefinition(def.id)!.status = 'active';
      const inst = engine.createInstance('tnt_X', def.id, {}, 'alice');

      expect(inst.id).toBeTruthy();
      expect(inst.tenantId).toBe('tnt_X');
      expect(inst.currentStepId).toBe('S1');
      expect(inst.currentStepName).toBe('First');
      expect(inst.status).toBe('running');
      expect(inst.stepHistory).toEqual([]);

      // D10: createInstance returns an EPHEMERAL object. The caller persists
      // via repo.insertInstance inside a TX and only then calls
      // refreshCacheFromCommit. Until that happens, the engine cache MUST
      // NOT see this instance (no read-your-own-write before commit).
      expect(engine.getInstance('tnt_X', inst.id)).toBeNull();
      expect(engine.getCacheSize()).toBe(0);
    });

    it('getInstances filters by status and sorts by startedAt DESC (cache-fed via refreshCacheFromCommit)', () => {
      const engine = makeEngine();
      const i1 = makePersistedInstance({ id: 'INST-1', tenant_id: 'tnt_A', status: 'completed',
        completed_at: new Date().toISOString(),
        started_at: new Date(Date.now() - 10_000).toISOString() });
      const i2 = makePersistedInstance({ id: 'INST-2', tenant_id: 'tnt_A', status: 'running',
        started_at: new Date(Date.now() - 5_000).toISOString() });
      const i3 = makePersistedInstance({ id: 'INST-3', tenant_id: 'tnt_A', status: 'running',
        started_at: new Date(Date.now() - 1_000).toISOString() });

      engine.refreshCacheFromCommit({ instance: i1 });
      engine.refreshCacheFromCommit({ instance: i2 });
      engine.refreshCacheFromCommit({ instance: i3 });

      const runningResult = engine.getInstances('tnt_A', { status: 'running' });
      expect(runningResult.instances.every(i => i.status === 'running')).toBe(true);
      expect(runningResult.instances.some(i => i.id === 'INST-1')).toBe(false);

      const allResult = engine.getInstances('tnt_A');
      const ids = allResult.instances.map(i => i.id);
      // i3 started more recently → should appear before i2 in DESC order.
      expect(ids.indexOf('INST-3')).toBeLessThan(ids.indexOf('INST-2'));
    });
  });

  // ==========================================================================
  // Cascade planning
  // ==========================================================================

  describe('planCascade', () => {
    it('returns workflowDefinitionMissing:true + no rows when instance is null', () => {
      const engine = makeEngine();
      const task = makePersistedTask();
      const plan = engine.planCascade(task, null, approveAction);

      expect(plan.workflowDefinitionMissing).toBe(true);
      expect(plan.downstreamTaskRows).toHaveLength(0);
      expect(plan.instanceUpdates).toBeNull();
    });

    it('returns workflowDefinitionMissing:true when definition is not found', () => {
      const engine = makeEngine();
      const inst = makeInstance(engine, 'tnt_A');
      const task = makePersistedTask({ workflowId: 'WF-NONEXISTENT', instanceId: inst.id });

      const plan = engine.planCascade(task, inst, approveAction);

      expect(plan.workflowDefinitionMissing).toBe(true);
      expect(plan.downstreamTaskRows).toHaveLength(0);
    });

    it('reject + rejection transition → routes to rejection step and creates task row', () => {
      const engine = makeEngine();
      const def = makeTwoStepDefinition(engine);
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan = engine.planCascade(task, inst, rejectAction);

      expect(plan.workflowDefinitionMissing).toBe(false);
      expect(plan.instanceUpdates?.currentStepId).toBe('STEP-REJ');
      expect(plan.instanceUpdates?.currentStepName).toBe('Rejection Review');
      expect(plan.downstreamTaskRows).toHaveLength(1);
      expect(plan.downstreamTaskRows[0].stepId).toBe('STEP-REJ');
    });

    it('reject + NO rejection transition → status=failed, no task rows', () => {
      const engine = makeEngine();
      // Single step approval with no rejection transition.
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-1', name: 'Approval', type: 'approval', order: 1,
            config: { assigneeValue: 'mgr' },
            transitions: [],
            timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan = engine.planCascade(task, inst, rejectAction);

      expect(plan.workflowDefinitionMissing).toBe(false);
      expect(plan.instanceUpdates?.status).toBe('failed');
      expect(plan.downstreamTaskRows).toHaveLength(0);
      expect(plan.instanceUpdates?.currentStepId).toBeNull();
    });

    it('action.nextStepId set → routes to that step', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-1', name: 'Step1', type: 'task', order: 1,
            config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
          },
          {
            id: 'STEP-3', name: 'Override Step', type: 'task', order: 3,
            config: { assigneeValue: 'user' }, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const action: TaskAction = { id: 'go3', label: 'Go3', type: 'complete', requiresComment: false, nextStepId: 'STEP-3' };
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan = engine.planCascade(task, inst, action);

      expect(plan.instanceUpdates?.currentStepId).toBe('STEP-3');
      expect(plan.downstreamTaskRows).toHaveLength(1);
      expect(plan.downstreamTaskRows[0].stepId).toBe('STEP-3');
    });

    it('default transition → routes to defaultTransition.targetStepId', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-1', name: 'Step1', type: 'task', order: 1,
            config: {},
            transitions: [{ id: 'T-def', targetStepId: 'STEP-DEFAULT', isDefault: true }],
            timeoutHours: null, retryPolicy: null,
          },
          {
            id: 'STEP-DEFAULT', name: 'Default Step', type: 'task', order: 5,
            config: { assigneeValue: 'user' }, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan = engine.planCascade(task, inst, approveAction);

      expect(plan.instanceUpdates?.currentStepId).toBe('STEP-DEFAULT');
    });

    it('no transition → routes to order+1 next step', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-A', name: 'First', type: 'task', order: 1,
            config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
          },
          {
            id: 'STEP-B', name: 'Second', type: 'task', order: 2,
            config: { assigneeValue: 'user' }, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-A' });

      const plan = engine.planCascade(task, inst, approveAction);

      expect(plan.instanceUpdates?.currentStepId).toBe('STEP-B');
      expect(plan.downstreamTaskRows[0].stepId).toBe('STEP-B');
    });

    it('end-of-workflow → status=completed, no task rows, currentStepId=null', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-LAST', name: 'Last', type: 'task', order: 1,
            config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-LAST' });

      const plan = engine.planCascade(task, inst, approveAction);

      expect(plan.instanceUpdates?.status).toBe('completed');
      expect(plan.instanceUpdates?.currentStepId).toBeNull();
      expect(plan.downstreamTaskRows).toHaveLength(0);
    });

    it('non-task next step (notification) → no task rows but currentStepId advances', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-1', name: 'Task', type: 'task', order: 1,
            config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
          },
          {
            id: 'STEP-2', name: 'Notify', type: 'notification', order: 2,
            config: { notificationTemplate: 'done' }, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan = engine.planCascade(task, inst, approveAction);

      expect(plan.instanceUpdates?.currentStepId).toBe('STEP-2');
      // notification step → no DB task row.
      expect(plan.downstreamTaskRows).toHaveLength(0);
    });

    it('planCascade is PURE — calling twice produces equivalent results without Map mutation', () => {
      const engine = makeEngine();
      const def = makeTwoStepDefinition(engine);
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');
      const task = makePersistedTask({ workflowId: def.id, instanceId: inst.id, stepId: 'STEP-1' });

      const plan1 = engine.planCascade(task, inst, approveAction);
      const plan2 = engine.planCascade(task, inst, approveAction);

      // Both plans agree — Map was not mutated by the first call.
      expect(plan1.instanceUpdates?.currentStepId).toBe(plan2.instanceUpdates?.currentStepId);
      expect(plan1.downstreamTaskRows).toHaveLength(plan2.downstreamTaskRows.length);

      // Instance currentStepId is unchanged (planCascade did not mutate it).
      expect(inst.currentStepId).not.toBe('STEP-2'); // still unmodified
      // stepHistory is also unchanged — guards against a future planner that
      // mutates history while leaving currentStepId untouched.
      expect(inst.stepHistory).toHaveLength(0);
    });
  });

  // ==========================================================================
  // buildInitialTaskRow
  // ==========================================================================

  describe('buildInitialTaskRow', () => {
    it('returns null when no steps exist (first step missing)', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine); // no steps
      const inst = makeInstance(engine, 'tnt_A', def.id);

      expect(engine.buildInitialTaskRow(inst, def)).toBeNull();
    });

    it('returns null when first step type is notification (not task/approval)', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        steps: [
          {
            id: 'STEP-1', name: 'Notify', type: 'notification', order: 1,
            config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, {}, 'user1');

      expect(engine.buildInitialTaskRow(inst, def)).toBeNull();
    });

    it('returns NewTaskRow with correct shape for type=approval', () => {
      const engine = makeEngine();
      const def = makeDefinition(engine, {
        name: 'Approval Flow',
        steps: [
          {
            id: 'STEP-1', name: 'Manager Approval', type: 'approval', order: 1,
            config: { assigneeValue: 'mgr' },
            transitions: [], timeoutHours: 24, retryPolicy: null,
          },
        ],
      });
      const inst = engine.createInstance('tnt_A', def.id, { poNum: 'PO-001' }, 'alice');
      const row = engine.buildInitialTaskRow(inst, def);

      expect(row).not.toBeNull();
      expect(row!.tenantId).toBe('tnt_A');
      expect(row!.instanceId).toBe(inst.id);
      expect(row!.workflowId).toBe(def.id);
      expect(row!.stepId).toBe('STEP-1');
      expect(row!.taskType).toBe('approval');
      expect(row!.status).toBe('pending');
      expect(row!.priority).toBe('medium');
      expect(row!.assigneeId).toBe('mgr');
      // Approval actions must include approve + reject.
      const actionTypes = row!.actions.map(a => a.type);
      expect(actionTypes).toContain('approve');
      expect(actionTypes).toContain('reject');
      // dueAt must be set because timeoutHours=24.
      expect(row!.dueAt).toBeTruthy();
      // data should mirror instance variables.
      expect(row!.data).toEqual({ poNum: 'PO-001' });
    });
  });

  // ==========================================================================
  // refreshCacheFromCommit (D9, D10 — single post-commit write path)
  // ==========================================================================

  describe('refreshCacheFromCommit', () => {
    it('writes the instance to the cache and returns the camelCase WorkflowInstance', () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({ id: 'INST-RC-1', tenant_id: 'tnt_A' });
      const cached = engine.refreshCacheFromCommit({ instance: persisted });

      expect(cached.id).toBe('INST-RC-1');
      expect(cached.tenantId).toBe('tnt_A');                     // snake → camel
      expect(cached.workflowId).toBe(persisted.workflow_id);     // snake → camel
      expect(cached.workflowName).toBe(persisted.workflow_name);
      expect(cached.workflowVersion).toBe(persisted.workflow_version);
      expect(cached.currentStepId).toBe(persisted.current_step_id);
      expect(cached.startedAt).toBe(persisted.started_at);
      expect(engine.getInstance('tnt_A', 'INST-RC-1')).toEqual(cached);
      expect(engine.getCacheSize()).toBe(1);
    });

    it('is idempotent — calling twice does not duplicate or break the cache', () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({ id: 'INST-RC-2', tenant_id: 'tnt_A' });
      engine.refreshCacheFromCommit({ instance: persisted });
      engine.refreshCacheFromCommit({ instance: persisted });
      expect(engine.getCacheSize()).toBe(1);
      expect(engine.getInstance('tnt_A', 'INST-RC-2')?.id).toBe('INST-RC-2');
    });

    it('stamps cancellationReason atomically in the SAME Map.set as the rest of the instance (D9)', () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({
        id: 'INST-RC-3',
        tenant_id: 'tnt_A',
        status: 'cancelled',
        completed_at: new Date().toISOString(),
      });
      const cached = engine.refreshCacheFromCommit({
        instance: persisted,
        cancellationReason: 'redacted_reason',
      });
      expect(cached.cancellationReason).toBe('redacted_reason');
      // Same value visible on subsequent read — proves it was written in the
      // same Map.set, not patched in afterwards.
      expect(engine.getInstance('tnt_A', 'INST-RC-3')?.cancellationReason).toBe(
        'redacted_reason',
      );
    });

    it('caches terminal rows within the recent-terminal hydration window', () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({
        id: 'INST-RC-4',
        tenant_id: 'tnt_A',
        status: 'completed',
        // 1 second ago — well within the default 7-day window.
        completed_at: new Date(Date.now() - 1_000).toISOString(),
      });
      engine.refreshCacheFromCommit({ instance: persisted });
      expect(engine.getInstance('tnt_A', 'INST-RC-4')).not.toBeNull();
      expect(engine.getCacheSize()).toBe(1);
    });

    it('evicts a terminal row whose completed_at is older than the hydration window', () => {
      const engine = makeEngine();
      // Pre-cache by treating it as recent first…
      const recent = makePersistedInstance({
        id: 'INST-RC-5',
        tenant_id: 'tnt_A',
        status: 'completed',
        completed_at: new Date(Date.now() - 1_000).toISOString(),
      });
      engine.refreshCacheFromCommit({ instance: recent });
      expect(engine.getCacheSize()).toBe(1);

      // …then write an aged copy. Default window is 7 days; 100 days is well outside.
      const aged: PersistedInstance = {
        ...recent,
        completed_at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      };
      engine.refreshCacheFromCommit({ instance: aged });

      expect(engine.getInstance('tnt_A', 'INST-RC-5')).toBeNull();
      expect(engine.getCacheSize()).toBe(0);
    });
  });

  // ==========================================================================
  // hydrate — boot-time rebuild of the in-memory cache from the DB
  // ==========================================================================

  describe('hydrate', () => {
    it('starts with hydrationReady=false and flips to true after a successful load', async () => {
      const engine = makeEngine();
      expect(engine.hydrationReady).toBe(false);

      const repo = {
        listInstancesForHydration: jest.fn().mockResolvedValue([
          makePersistedInstance({ id: 'INST-H-1' }),
          makePersistedInstance({ id: 'INST-H-2' }),
        ]),
      };

      await engine.hydrate(repo);

      expect(engine.hydrationReady).toBe(true);
      expect(engine.getCacheSize()).toBe(2);
      expect(repo.listInstancesForHydration).toHaveBeenCalledTimes(1);
    });

    it('clears the cache before loading (idempotent on re-call)', async () => {
      const engine = makeEngine();
      // Seed an unrelated row first; it should be cleared by hydrate.
      engine.refreshCacheFromCommit({
        instance: makePersistedInstance({ id: 'INST-STALE' }),
      });
      expect(engine.getCacheSize()).toBe(1);

      const repo = {
        listInstancesForHydration: jest.fn().mockResolvedValue([
          makePersistedInstance({ id: 'INST-FRESH' }),
        ]),
      };

      await engine.hydrate(repo);
      expect(engine.getCacheSize()).toBe(1);
      expect(engine.getInstance('tnt_A', 'INST-STALE')).toBeNull();
      expect(engine.getInstance('tnt_A', 'INST-FRESH')).not.toBeNull();

      // Re-call → still idempotent, same single row.
      await engine.hydrate(repo);
      expect(engine.getCacheSize()).toBe(1);
    });

    it('leaves hydrationReady=false when listInstancesForHydration rejects (readiness gate stays 503)', async () => {
      const engine = makeEngine();
      const repo = {
        listInstancesForHydration: jest
          .fn()
          .mockRejectedValue(new Error('db down')),
      };
      await expect(engine.hydrate(repo)).rejects.toThrow('db down');
      expect(engine.hydrationReady).toBe(false);
    });

    it('emits the active-count gauge BEFORE flipping hydrationReady (§3.3 step 3 / §6.2)', async () => {
      const engine = makeEngine();
      const rows = [
        makePersistedInstance({ id: 'INST-G-1' }),
        makePersistedInstance({ id: 'INST-G-2' }),
        makePersistedInstance({ id: 'INST-G-3' }),
      ];
      const repo = {
        listInstancesForHydration: jest.fn().mockResolvedValue(rows),
      };
      // Spy on gauge.set inside hydrate's terminal emit; assert hydrationReady
      // was still false when gauge.set fired (regression net against swapping
      // the two lines). The hydrate loop also fires gauge.set per row via
      // refreshCacheFromCommit, so we capture the LAST call before the flag flip.
      const { workflowCentralInstanceActiveCount } = await import(
        '../../../../src/services/workflowCentral/metrics'
      );
      let readyAtLastGaugeSet: boolean | null = null;
      const realSet = workflowCentralInstanceActiveCount.set.bind(workflowCentralInstanceActiveCount);
      const setSpy = jest.spyOn(workflowCentralInstanceActiveCount, 'set')
        .mockImplementation((v: number) => {
          readyAtLastGaugeSet = engine.hydrationReady;
          realSet(v);  // let the real gauge update so the post-hydrate value assertion below still works
        });
      await engine.hydrate(repo);
      expect(engine.hydrationReady).toBe(true);
      expect(engine.getCacheSize()).toBe(3);
      // Invariant: gauge.set fired while ready was still false (regression net for spec §3.3 step 3 ordering).
      expect(readyAtLastGaugeSet).toBe(false);
      setSpy.mockRestore();
      // Now the real (un-spied) gauge value should reflect the post-hydrate count.
      const { register } = await import('prom-client');
      const value = await register.getSingleMetric('workflow_central_instance_active_count')?.get();
      expect(value?.values?.[0]?.value).toBe(3);
    });
  });

  // ==========================================================================
  // getInstanceFromAnywhere (D24 — cache-first + DB fallback)
  // ==========================================================================

  describe('getInstanceFromAnywhere', () => {
    it('returns the cached row when present without touching the repo', async () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({ id: 'INST-GA-1', tenant_id: 'tnt_A' });
      engine.refreshCacheFromCommit({ instance: persisted });
      const repo = { getInstanceById: jest.fn() };
      const result = await engine.getInstanceFromAnywhere(repo, 'tnt_A', 'INST-GA-1');
      expect(result?.id).toBe('INST-GA-1');
      expect(repo.getInstanceById).not.toHaveBeenCalled();
    });

    it('returns null on cache-hit but cross-tenant id (defence-in-depth)', async () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({ id: 'INST-GA-2', tenant_id: 'tnt_A' });
      engine.refreshCacheFromCommit({ instance: persisted });
      const repo = { getInstanceById: jest.fn() };
      const result = await engine.getInstanceFromAnywhere(repo, 'tnt_OTHER', 'INST-GA-2');
      expect(result).toBeNull();
      // Did NOT fall through to the repo — we have the row in cache and
      // know it's the wrong tenant.
      expect(repo.getInstanceById).not.toHaveBeenCalled();
    });

    it('falls back to repo.getInstanceById on cache miss and warms the cache for in-window rows', async () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({ id: 'INST-GA-3', tenant_id: 'tnt_A' });
      const repo = {
        getInstanceById: jest.fn().mockResolvedValue(persisted),
      };
      const result = await engine.getInstanceFromAnywhere(repo, 'tnt_A', 'INST-GA-3');
      expect(result?.id).toBe('INST-GA-3');
      expect(result?.cancellationReason).toBeNull(); // D8 DLP carve-out
      expect(repo.getInstanceById).toHaveBeenCalledWith('tnt_A', 'INST-GA-3');
      // Warmed.
      expect(engine.getCacheSize()).toBe(1);
      expect(engine.getInstance('tnt_A', 'INST-GA-3')).not.toBeNull();
    });

    it('does NOT warm the cache for out-of-window terminal rows', async () => {
      const engine = makeEngine();
      const persisted = makePersistedInstance({
        id: 'INST-GA-4',
        tenant_id: 'tnt_A',
        status: 'completed',
        completed_at: new Date(Date.now() - 100 * 86_400_000).toISOString(),
      });
      const repo = {
        getInstanceById: jest.fn().mockResolvedValue(persisted),
      };
      const result = await engine.getInstanceFromAnywhere(repo, 'tnt_A', 'INST-GA-4');
      expect(result?.id).toBe('INST-GA-4'); // row still returned to caller
      expect(engine.getCacheSize()).toBe(0); // …but cache untouched
    });

    it('returns null when the repo also has no row', async () => {
      const engine = makeEngine();
      const repo = { getInstanceById: jest.fn().mockResolvedValue(null) };
      const result = await engine.getInstanceFromAnywhere(repo, 'tnt_A', 'INST-GA-NONE');
      expect(result).toBeNull();
    });
  });

  // ==========================================================================
  // seedDemoData
  // ==========================================================================

  // Copilot R12 #3 SHOULD-FIX: setDefinitionStatus is the public helper that
  // replaces the private-Map cast pattern used by integration tests.
  describe('setDefinitionStatus', () => {
    it('flips draft → active and stamps updatedAt', () => {
      const engine = makeEngine();
      const def = engine.createDefinition({
        name: 'X', description: '', category: 'test', createdBy: 'test-user',
        triggerType: 'manual', triggerConfig: {}, steps: [], variables: [],
      });
      expect(def.status).toBe('draft');

      const before = def.updatedAt;
      const result = engine.setDefinitionStatus(def.id, 'active');

      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.updatedAt >= before).toBe(true);
      // Engine state mutated too.
      expect(engine.getDefinitions().definitions.find((d) => d.id === def.id)?.status).toBe('active');
    });

    it('supports any valid status transition (no state-machine enforcement)', () => {
      const engine = makeEngine();
      const def = engine.createDefinition({
        name: 'Y', description: '', category: 'test', createdBy: 'test-user',
        triggerType: 'manual', triggerConfig: {}, steps: [], variables: [],
      });
      engine.setDefinitionStatus(def.id, 'active');
      const archived = engine.setDefinitionStatus(def.id, 'archived');
      expect(archived?.status).toBe('archived');
    });

    it('returns null for an unknown id (does not throw, does not create)', () => {
      const engine = makeEngine();
      const result = engine.setDefinitionStatus('WF-nonexistent', 'active');
      expect(result).toBeNull();
    });
  });

  describe('seedDemoDefinitions + getDemoInstanceRows', () => {
    it('seedDemoDefinitions populates definitions map', () => {
      const engine = makeEngine();
      engine.seedDemoDefinitions();

      const { definitions, total } = engine.getDefinitions();
      expect(total).toBeGreaterThanOrEqual(3);
      expect(definitions.every(d => d.id.startsWith('WF-'))).toBe(true);
    });

    it('getDemoInstanceRows returns 3 rows with correct tenantId', () => {
      const engine = makeEngine();
      const rows = engine.getDemoInstanceRows();

      expect(rows).toHaveLength(3);
      expect(rows.every(r => r.tenantId === '__system__')).toBe(true);
      expect(rows.map(r => r.id)).toEqual(['INST-1000', 'INST-1001', 'INST-1002']);
    });

    it('getDemoInstanceRows is pure — does not mutate the instances Map', () => {
      const engine = makeEngine();
      const { instances: before } = engine.getInstances('__system__');
      engine.getDemoInstanceRows();
      const { instances: after } = engine.getInstances('__system__');
      expect(after.length).toBe(before.length);
    });
  });

});
