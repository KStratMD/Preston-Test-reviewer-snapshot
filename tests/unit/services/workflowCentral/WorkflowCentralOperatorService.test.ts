/**
 * WorkflowCentralOperatorService Unit Tests — PR-OP-3 T8 rewrite
 *
 * Covers the instance-durability refactor:
 *   - Pre-TX validation throws typed errors (NotFoundError, InvalidActionError)
 *   - Inside-TX flow: instance-first lock order (selectTaskInstanceId →
 *     selectInstanceForUpdate) + D21 paused gate + planCascade + atomic cascade +
 *     CascadePlan → InstancePatch translation (D11) + post-TX refreshCacheFromCommit
 *   - Typed errors bubble: InstancePausedError, WorkflowInstanceMissingError,
 *     AlreadyDispositionedError (RaceLostError translated per D25)
 *   - Audit shape: workflow_definition_missing flag, DLP key-absence,
 *     safeAudit-on-failure metric increment
 *
 * Spec: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md §3.2 D11, D21, D25
 */

import 'reflect-metadata';
import { WorkflowCentralOperatorService } from '../../../../src/services/workflowCentral/WorkflowCentralOperatorService';
import type { WorkflowCentralRepository } from '../../../../src/services/workflowCentral/WorkflowCentralRepository';
import type { WorkflowEngineService } from '../../../../src/services/workflowCentral/WorkflowEngineService';
import type { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { Logger } from '../../../../src/utils/Logger';
import type {
  CascadePlan,
  PersistedInstance,
  PersistedTask,
  StepExecution,
  TaskAction,
  WorkflowInstance,
} from '../../../../src/services/workflowCentral/types';
import { RaceLostError } from '../../../../src/services/workflowCentral/types';
import {
  AlreadyDispositionedError,
  InstancePausedError,
  InvalidActionError,
  NotFoundError,
  WorkflowInstanceMissingError,
} from '../../../../src/services/workflowCentral/errors';
import { workflowCentralAuditDeliveryFailures } from '../../../../src/services/workflowCentral/metrics';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<TaskAction> = {}): TaskAction {
  return {
    id: 'act-complete',
    label: 'Complete',
    type: 'complete',
    requiresComment: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<PersistedTask> = {}): PersistedTask {
  return {
    id: 'TASK-1',
    tenantId: 'tnt_A',
    instanceId: 'INST-1',
    workflowId: 'WF-1',
    workflowName: 'Test Workflow',
    stepId: 'STEP-1',
    stepName: 'Step One',
    taskType: 'task',
    status: 'pending',
    priority: 'medium',
    assigneeId: 'user-1',
    assigneeName: 'Test User',
    description: 'Test task',
    dueAt: null,
    data: {},
    actions: [makeAction()],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    completedBy: null,
    completionActionId: null,
    completionComment: null,
    ...overrides,
  };
}

function makePersistedInstance(overrides: Partial<PersistedInstance> = {}): PersistedInstance {
  return {
    id: 'INST-1',
    tenant_id: 'tnt_A',
    workflow_id: 'WF-1',
    workflow_name: 'Test Workflow',
    workflow_version: 1,
    status: 'running',
    current_step_id: 'STEP-1',
    current_step_name: 'Step One',
    variables: {},
    step_history: [],
    started_by: 'user-1',
    started_at: '2026-01-01T00:00:00.000Z',
    completed_at: null,
    due_at: null,
    error: null,
    paused_from_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeInstance(overrides: Partial<WorkflowInstance> = {}): WorkflowInstance {
  return {
    id: 'INST-1',
    tenantId: 'tnt_A',
    workflowId: 'WF-1',
    workflowName: 'Test Workflow',
    workflowVersion: 1,
    status: 'running',
    currentStepId: 'STEP-1',
    currentStepName: 'Step One',
    variables: {},
    startedBy: 'user-1',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    dueAt: null,
    error: null,
    stepHistory: [],
    ...overrides,
  };
}

function makeStepHistoryEntry(): StepExecution {
  return {
    id: 'EXEC-1',
    stepId: 'STEP-1',
    stepName: 'Step One',
    status: 'completed',
    assigneeId: 'user-1',
    assigneeName: 'Test User',
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T01:00:00.000Z',
    result: { action: 'complete' },
    error: null,
    comments: null,
  };
}

function makeCompletedTask(task: PersistedTask): PersistedTask {
  return {
    ...task,
    status: 'completed',
    completedAt: '2026-01-01T01:00:00.000Z',
    completedBy: 'user-1',
    completionActionId: 'act-complete',
  };
}

function makeCascadePlan(overrides: Partial<CascadePlan> = {}): CascadePlan {
  return {
    downstreamTaskRows: [],
    instanceUpdates: {
      currentStepId: null,
      currentStepName: null,
      status: 'completed',
      appendStepHistory: makeStepHistoryEntry(),
    },
    workflowDefinitionMissing: false,
    ...overrides,
  };
}

function makeDefinition(): unknown {
  // Engine planCascade uses the definition; for unit-test purposes we only need
  // a truthy object since planCascade is stubbed.
  return { id: 'WF-1', name: 'Test Workflow', steps: [] };
}

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

function buildMocks() {
  const persistedTask = makeTask();
  const updatedPersistedTask = makeCompletedTask(persistedTask);
  const persistedInstance = makePersistedInstance();

  const mockRepo = {
    getById: jest.fn().mockResolvedValue(persistedTask),
    selectTaskInstanceId: jest.fn().mockResolvedValue({ instanceId: 'INST-1' }),
    selectInstanceForUpdate: jest.fn().mockResolvedValue(persistedInstance),
    completeTaskAtomicWithCascade: jest
      .fn()
      .mockResolvedValue({ updatedTask: updatedPersistedTask, insertedIds: [] }),
    updateInstanceForTenant: jest.fn().mockResolvedValue(persistedInstance),
  } as unknown as jest.Mocked<WorkflowCentralRepository>;

  const mockEngine = {
    getDefinition: jest.fn().mockReturnValue(makeDefinition()),
    planCascade: jest.fn().mockReturnValue(makeCascadePlan()),
    refreshCacheFromCommit: jest.fn().mockReturnValue(makeInstance()),
  } as unknown as jest.Mocked<WorkflowEngineService>;

  const mockAuditLog = {
    create: jest.fn().mockResolvedValue({}),
  } as unknown as jest.Mocked<AuditLogRepository>;

  const mockDb = {
    transaction: jest.fn().mockImplementation(async (cb: (tx: unknown) => Promise<unknown>) => cb({})),
  } as unknown as jest.Mocked<DatabaseService>;

  const mockLogger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  } as unknown as jest.Mocked<Logger>;

  const mockPayloadResolver = {
    resolve: jest.fn().mockResolvedValue([]),
  } as unknown as import('../../../../src/services/workflowCentral/payload/WorkflowPayloadResolver').WorkflowPayloadResolver;

  // Tenant-setting half of the ephemeral payload gate (PR follow-up to PR #811).
  // Default: getBooleanStrict returns false. Tests that exercise tenant opt-in
  // override per-case via mockResolvedValueOnce(true). getBooleanStrict (not
  // getBoolean) is the fail-closed entry point — see operator service.
  const mockTenantConfig = {
    getBoolean: jest.fn().mockResolvedValue(false),
    getBooleanStrict: jest.fn().mockResolvedValue(false),
    getString: jest.fn().mockResolvedValue(null),
    getInt: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue(undefined),
    resolveStringForRow: jest.fn().mockResolvedValue(null),
    resolveBooleanForRow: jest.fn().mockResolvedValue(false),
  } as unknown as import('../../../../src/database/repositories/TenantConfigurationRepository').TenantConfigurationRepository;

  const operator = new WorkflowCentralOperatorService(
    mockLogger,
    mockEngine,
    mockRepo,
    mockAuditLog,
    mockDb,
    mockPayloadResolver,
    mockTenantConfig,
  );

  return {
    operator,
    mockRepo,
    mockEngine,
    mockAuditLog,
    mockDb,
    mockLogger,
    mockPayloadResolver,
    mockTenantConfig,
    persistedTask,
    updatedPersistedTask,
    persistedInstance,
  };
}

function getAuditCall(mockAuditLog: jest.Mocked<AuditLogRepository>, result: 'success' | 'failure') {
  const calls = (mockAuditLog.create as jest.Mock).mock.calls;
  return calls.find((c: unknown[]) => (c[0] as Record<string, unknown>).result === result)?.[0] as
    | Record<string, unknown>
    | undefined;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkflowCentralOperatorService.completeTask (PR-OP-3 T8)', () => {
  // ============================================================================
  // Happy path
  // ============================================================================

  describe('happy path', () => {
    it('returns kind=ok and writes audit + refreshes cache with updatedInstance', async () => {
      const { operator, mockRepo, mockEngine, mockAuditLog, updatedPersistedTask, persistedInstance } =
        buildMocks();

      const result = await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.code).toBe('ok');
      expect(result.task).toEqual(updatedPersistedTask);
      expect(result.downstreamTaskIds).toEqual([]);
      expect(result.workflowDefinitionMissing).toBeUndefined();

      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tnt_A',
        'INST-1',
        expect.objectContaining({ kind: 'completeTask' }),
      );

      expect(mockEngine.refreshCacheFromCommit).toHaveBeenCalledWith({ instance: persistedInstance });

      const successAudit = getAuditCall(mockAuditLog, 'success');
      expect((successAudit?.details as Record<string, unknown>)?.workflow_definition_missing).toBe(false);
    });

    it('returns downstreamTaskIds when cascade inserts children', async () => {
      const { operator, mockRepo, mockEngine, updatedPersistedTask } = buildMocks();
      const downstreamTask = makeTask({ id: 'TASK-2' });
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({
          downstreamTaskRows: [downstreamTask],
          instanceUpdates: {
            currentStepId: 'STEP-2',
            currentStepName: 'Step Two',
            appendStepHistory: makeStepHistoryEntry(),
          },
        }),
      );
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockResolvedValueOnce({
        updatedTask: updatedPersistedTask,
        insertedIds: ['TASK-2'],
      });

      const result = await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.downstreamTaskIds).toEqual(['TASK-2']);
    });
  });

  // ============================================================================
  // Instance-first lock order
  // ============================================================================

  describe('instance-first lock order (D21, spec §3.2)', () => {
    it('inside TX: selectTaskInstanceId is called BEFORE selectInstanceForUpdate', async () => {
      const { operator, mockRepo } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const taskInstanceOrder = (mockRepo.selectTaskInstanceId as jest.Mock).mock.invocationCallOrder[0];
      const instanceLockOrder = (mockRepo.selectInstanceForUpdate as jest.Mock).mock.invocationCallOrder[0];
      expect(taskInstanceOrder).toBeLessThan(instanceLockOrder);
    });

    it('selectInstanceForUpdate called BEFORE planCascade + completeTaskAtomicWithCascade', async () => {
      const { operator, mockRepo, mockEngine } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const lockOrder = (mockRepo.selectInstanceForUpdate as jest.Mock).mock.invocationCallOrder[0];
      const planOrder = (mockEngine.planCascade as jest.Mock).mock.invocationCallOrder[0];
      const cascadeOrder = (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mock
        .invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(planOrder);
      expect(planOrder).toBeLessThan(cascadeOrder);
    });
  });

  // ============================================================================
  // D21 paused gate
  // ============================================================================

  describe('D21 paused gate', () => {
    it('throws InstancePausedError when instance.status === "paused"', async () => {
      const { operator, mockRepo } = buildMocks();
      (mockRepo.selectInstanceForUpdate as jest.Mock).mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'running' }),
      );

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(InstancePausedError);
    });

    it('paused gate: completeTaskAtomicWithCascade is NOT called', async () => {
      const { operator, mockRepo } = buildMocks();
      (mockRepo.selectInstanceForUpdate as jest.Mock).mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'running' }),
      );

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(InstancePausedError);

      expect(mockRepo.completeTaskAtomicWithCascade).not.toHaveBeenCalled();
    });

    it('paused gate: failure audit emitted with error_message="instance_paused"', async () => {
      const { operator, mockRepo, mockAuditLog } = buildMocks();
      (mockRepo.selectInstanceForUpdate as jest.Mock).mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'running' }),
      );

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(InstancePausedError);

      const failureAudit = getAuditCall(mockAuditLog, 'failure');
      expect(failureAudit?.error_message).toBe('instance_paused');
    });
  });

  // ============================================================================
  // Typed errors (pre-TX + TX-thrown)
  // ============================================================================

  describe('typed errors', () => {
    it('throws NotFoundError when repo.getById returns null', async () => {
      const { operator, mockRepo } = buildMocks();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-MISSING',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('throws InvalidActionError when actionId not in task.actions; carries validActionIds', async () => {
      const { operator } = buildMocks();

      try {
        await operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-nonexistent', completedBy: 'user-1' },
        });
        fail('expected InvalidActionError to be thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidActionError);
        const ie = err as InvalidActionError;
        expect(ie.actionId).toBe('act-nonexistent');
        expect(ie.validActionIds).toEqual(['act-complete']);
      }
    });

    it('throws WorkflowInstanceMissingError when selectInstanceForUpdate returns null', async () => {
      const { operator, mockRepo } = buildMocks();
      (mockRepo.selectInstanceForUpdate as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(WorkflowInstanceMissingError);
    });

    it('throws AlreadyDispositionedError when repo throws RaceLostError (D25)', async () => {
      const { operator, mockRepo, mockAuditLog } = buildMocks();
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockRejectedValueOnce(
        new RaceLostError('race lost during cascade for task TASK-1 in tenant tnt_A'),
      );

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-1',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(AlreadyDispositionedError);

      // Typed error paths MUST audit before re-throwing (D15 observability invariant).
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.complete_task',
          result: 'failure',
          error_message: 'already_dispositioned',
        }),
      );
    });

    it('NotFoundError + InvalidActionError fire BEFORE the TX opens', async () => {
      const { operator, mockRepo, mockDb } = buildMocks();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(null);

      await expect(
        operator.completeTask({
          tenantId: 'tnt_A',
          taskId: 'TASK-MISSING',
          completion: { actionId: 'act-complete', completedBy: 'user-1' },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);

      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // CompleteTaskTxResult discriminated union
  // ============================================================================

  describe('CompleteTaskTxResult discriminator', () => {
    it('kind="definition_missing" branch: engine.getDefinition returns null', async () => {
      const { operator, mockEngine, mockRepo, updatedPersistedTask } = buildMocks();
      (mockEngine.getDefinition as jest.Mock).mockReturnValueOnce(null);
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockResolvedValueOnce({
        updatedTask: updatedPersistedTask,
        insertedIds: [],
      });

      const result = await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.workflowDefinitionMissing).toBe(true);
      // No instance update / no refreshCacheFromCommit on definition_missing
      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
      expect(mockEngine.planCascade).not.toHaveBeenCalled();
    });

    it('kind="definition_missing": audit details include workflow_definition_missing=true', async () => {
      const { operator, mockEngine, mockRepo, mockAuditLog, updatedPersistedTask } = buildMocks();
      (mockEngine.getDefinition as jest.Mock).mockReturnValueOnce(null);
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockResolvedValueOnce({
        updatedTask: updatedPersistedTask,
        insertedIds: [],
      });

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const successAudit = getAuditCall(mockAuditLog, 'success');
      expect((successAudit?.details as Record<string, unknown>)?.workflow_definition_missing).toBe(true);
    });

    it('kind="ok": audit details include workflow_definition_missing=false', async () => {
      const { operator, mockAuditLog } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const successAudit = getAuditCall(mockAuditLog, 'success');
      expect((successAudit?.details as Record<string, unknown>)?.workflow_definition_missing).toBe(false);
    });
  });

  // ============================================================================
  // CascadePlan → InstancePatch (D11) inline translation
  // ============================================================================

  describe('D11 inline CascadePlan → InstancePatch translation', () => {
    it('verifies engine.applyToInstance is NOT called (inline translation lives in operator)', async () => {
      const { operator, mockEngine } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      // engine.applyToInstance does not exist on engine post-T5 — the absence is
      // confirmed by the operator never reaching for any non-mocked engine method.
      expect((mockEngine as unknown as Record<string, jest.Mock>).applyToInstance).toBeUndefined();
    });

    it('builds InstancePatch{kind: "completeTask"} with currentStepId/Name + stepHistoryAppend', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      const stepHistory = makeStepHistoryEntry();
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({
          instanceUpdates: {
            currentStepId: 'STEP-2',
            currentStepName: 'Step Two',
            appendStepHistory: stepHistory,
          },
        }),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tnt_A',
        'INST-1',
        expect.objectContaining({
          kind: 'completeTask',
          currentStepId: 'STEP-2',
          currentStepName: 'Step Two',
          stepHistoryAppend: stepHistory,
        }),
      );
    });

    it('sets status only when sourceStatus is "completed" or "failed"', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({
          instanceUpdates: {
            currentStepId: null,
            currentStepName: null,
            status: 'completed',
            appendStepHistory: makeStepHistoryEntry(),
          },
        }),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const patchArg = (mockRepo.updateInstanceForTenant as jest.Mock).mock.calls[0][3] as Record<
        string,
        unknown
      >;
      expect(patchArg.status).toBe('completed');
      expect(typeof patchArg.completedAt).toBe('string');
    });

    it('OMITS status when sourceStatus is undefined (intermediate-step path)', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({
          instanceUpdates: {
            currentStepId: 'STEP-2',
            currentStepName: 'Step Two',
            // no status → intermediate step
            appendStepHistory: makeStepHistoryEntry(),
          },
        }),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const patchArg = (mockRepo.updateInstanceForTenant as jest.Mock).mock.calls[0][3] as Record<
        string,
        unknown
      >;
      expect(patchArg.status).toBeUndefined();
      expect(patchArg.completedAt).toBeUndefined();
    });

    it('D5: when instance.status === "unknown_recovered", status is NOT overwritten by patch', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      (mockRepo.selectInstanceForUpdate as jest.Mock).mockResolvedValueOnce(
        makePersistedInstance({ status: 'unknown_recovered' }),
      );
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({
          instanceUpdates: {
            currentStepId: null,
            currentStepName: null,
            status: 'completed',
            appendStepHistory: makeStepHistoryEntry(),
          },
        }),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const patchArg = (mockRepo.updateInstanceForTenant as jest.Mock).mock.calls[0][3] as Record<
        string,
        unknown
      >;
      expect(patchArg.status).toBeUndefined();
      expect(patchArg.completedAt).toBeUndefined();
    });

    it('does NOT call updateInstanceForTenant when plan.instanceUpdates === null', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      (mockEngine.planCascade as jest.Mock).mockReturnValueOnce(
        makeCascadePlan({ instanceUpdates: null }),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // post-TX refreshCacheFromCommit
  // ============================================================================

  describe('post-TX refreshCacheFromCommit', () => {
    it('called with updatedInstance from updateInstanceForTenant (NOT planCascade output)', async () => {
      const { operator, mockEngine, mockRepo } = buildMocks();
      const updatedRow = makePersistedInstance({
        current_step_id: 'STEP-2',
        current_step_name: 'Step Two',
      });
      (mockRepo.updateInstanceForTenant as jest.Mock).mockResolvedValueOnce(updatedRow);

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(mockEngine.refreshCacheFromCommit).toHaveBeenCalledWith({ instance: updatedRow });
    });

    it('called AFTER the TX commits (not inside)', async () => {
      const { operator, mockDb, mockEngine } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const txOrder = (mockDb.transaction as jest.Mock).mock.invocationCallOrder[0];
      const refreshOrder = (mockEngine.refreshCacheFromCommit as jest.Mock).mock.invocationCallOrder[0];
      expect(txOrder).toBeLessThan(refreshOrder);
    });

    it('NOT called on definition_missing branch (no updatedInstance)', async () => {
      const { operator, mockEngine, mockRepo, updatedPersistedTask } = buildMocks();
      (mockEngine.getDefinition as jest.Mock).mockReturnValueOnce(null);
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockResolvedValueOnce({
        updatedTask: updatedPersistedTask,
        insertedIds: [],
      });

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(mockEngine.refreshCacheFromCommit).not.toHaveBeenCalled();
    });
  });

  // ============================================================================
  // safeAudit failure handling
  // ============================================================================

  describe('safeAudit', () => {
    it('throw → TX result still returned; WARN logged; metric incremented', async () => {
      const { operator, mockAuditLog, mockLogger } = buildMocks();
      (mockAuditLog.create as jest.Mock).mockRejectedValueOnce(new Error('audit-db down'));

      const before = await getCounterValue('thrown');

      const result = await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(result.ok).toBe(true);

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('audit log write failed'),
        expect.objectContaining({ action: 'workflow_central.complete_task' }),
      );

      const after = await getCounterValue('thrown');
      expect(after).toBeGreaterThan(before);
    });
  });

  // ============================================================================
  // DLP key-absence (regression net for PR-OP-2 contract)
  // ============================================================================

  describe('DLP key-absence', () => {
    it('success path: comment + data with secrets are NOT in audit details keys or values', async () => {
      const { operator, mockAuditLog } = buildMocks();

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: {
          actionId: 'act-complete',
          completedBy: 'user-1',
          comment: 'sk-secret-key-123',
          data: { api_key: 'sk-...' },
        },
      });

      const successAudit = getAuditCall(mockAuditLog, 'success');
      const details = successAudit?.details as Record<string, unknown>;
      expect(Object.keys(details)).not.toContain('comment');
      expect(Object.keys(details)).not.toContain('data');
      expect(Object.keys(details)).not.toContain('completion_comment');
      expect(JSON.stringify(details)).not.toContain('sk-secret-key-123');
    });
  });

  // ============================================================================
  // Cascade failed (untyped throw)
  // ============================================================================

  describe('cascade_failed', () => {
    it('returns ok=false, code=cascade_failed when an UNTYPED error escapes the TX', async () => {
      const { operator, mockRepo } = buildMocks();
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockRejectedValueOnce(
        new Error('constraint violation: workflow_central_tasks.id duplicate'),
      );

      const result = await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('cascade_failed');
      expect(result.cause).toContain('constraint violation');
    });

    it('cascade_failed audit carries cascade_error_message', async () => {
      const { operator, mockRepo, mockAuditLog } = buildMocks();
      (mockRepo.completeTaskAtomicWithCascade as jest.Mock).mockRejectedValueOnce(
        new Error('cascade error detail'),
      );

      await operator.completeTask({
        tenantId: 'tnt_A',
        taskId: 'TASK-1',
        completion: { actionId: 'act-complete', completedBy: 'user-1' },
      });

      const failureAudit = getAuditCall(mockAuditLog, 'failure');
      expect(failureAudit?.error_message).toBe('cascade_failed');
      expect((failureAudit?.details as Record<string, unknown>)?.cascade_error_message).toBe(
        'cascade error detail',
      );
    });
  });
});

// ============================================================================
// Phase 1 T9 — getTaskForOperator (ADR-019)
// ============================================================================

describe('WorkflowCentralOperatorService.getTaskForOperator (Phase 1 T9)', () => {
  it('throws NotFoundError when task is missing for the tenant', async () => {
    const { operator, mockRepo } = buildMocks();
    (mockRepo.getById as jest.Mock).mockResolvedValueOnce(null);

    const { NotFoundError } = await import('../../../../src/services/workflowCentral/errors');
    await expect(operator.getTaskForOperator('tnt_A', 'TASK-missing')).rejects.toBeInstanceOf(NotFoundError);
  });

  it('returns kind=resolved for external_reference payload — resolver invoked once with tenant', async () => {
    const { operator, mockRepo, mockPayloadResolver } = buildMocks();
    const refs = [{ system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-1' }];
    const payload = { mode: 'external_reference' as const, references: refs };
    const taskWithPayload = { ...makeTask(), payload };
    (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
    (mockPayloadResolver.resolve as jest.Mock).mockResolvedValueOnce([
      { ref: refs[0], status: 'resolved', fields: { name: 'Acme' }, resolvedAt: '2026-05-18T12:00:00Z' },
    ]);

    const out = await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') return;
    expect(out.task).toEqual(taskWithPayload);
    expect(out.resolution).toHaveLength(1);
    expect(out.resolution[0].status).toBe('resolved');
    expect(out.resolution[0].fields).toEqual({ name: 'Acme' });
    expect(mockPayloadResolver.resolve).toHaveBeenCalledWith(refs, 'tnt_A');
  });

  it('partial-success resolution flows through — per-ref failures surfaced inside the array, no throw', async () => {
    const { operator, mockRepo, mockPayloadResolver } = buildMocks();
    const refs = [
      { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-OK' },
      { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-DOWN' },
    ];
    const payload = { mode: 'external_reference' as const, references: refs };
    const taskWithPayload = { ...makeTask(), payload };
    (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
    (mockPayloadResolver.resolve as jest.Mock).mockResolvedValueOnce([
      { ref: refs[0], status: 'resolved', fields: { name: 'OK' } },
      { ref: refs[1], status: 'failed', error: { code: 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE', statusCode: 503, message: 'down' } },
    ]);

    const out = await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

    expect(out.kind).toBe('resolved');
    if (out.kind !== 'resolved') return;
    expect(out.resolution).toHaveLength(2);
    expect(out.resolution[0].status).toBe('resolved');
    expect(out.resolution[1].status).toBe('failed');
    expect(out.resolution[1].error?.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
  });

  describe('ephemeral opt-in gate (Codex P1 R2 — WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD)', () => {
    const prevEnv = process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
    beforeEach(() => { process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = '1'; });
    afterAll(() => {
      if (prevEnv === undefined) delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
      else process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = prevEnv;
    });

    it('returns kind=ephemeral for unexpired ephemeral payload — data flows inline to caller', async () => {
      const { operator, mockRepo, mockPayloadResolver } = buildMocks();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const payload = {
        mode: 'ephemeral_hosted' as const,
        expiresAt: future,
        reason: 'cross-system compose',
        data: { vendorName: 'Acme', amount: 25000 },
      };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

      const out = await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

      expect(out.kind).toBe('ephemeral');
      if (out.kind !== 'ephemeral') return;
      expect(out.ephemeral.expiresAt).toBe(future);
      expect(out.ephemeral.reason).toBe('cross-system compose');
      expect(out.ephemeral.data).toEqual({ vendorName: 'Acme', amount: 25000 });
      expect(mockPayloadResolver.resolve).not.toHaveBeenCalled();
    });

    it('throws EphemeralPayloadExpiredError when expiresAt is in the past', async () => {
      const { operator, mockRepo } = buildMocks();
      const past = new Date(Date.now() - 1).toISOString();
      const payload = {
        mode: 'ephemeral_hosted' as const,
        expiresAt: past,
        reason: 'old',
        data: { x: 1 },
      };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

      const { EphemeralPayloadExpiredError } = await import('../../../../src/services/workflowCentral/payload/errors');
      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id)).rejects.toBeInstanceOf(EphemeralPayloadExpiredError);
    });
  });

  it('throws EphemeralPayloadNotAllowedError when env flag is unset (default — Codex P1 R2)', async () => {
    const prev = process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
    delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
    try {
      const { operator, mockRepo } = buildMocks();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const payload = {
        mode: 'ephemeral_hosted' as const,
        expiresAt: future,
        reason: 'should be gated',
        data: { secret: 'should-not-render' },
      };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

      const { EphemeralPayloadNotAllowedError } = await import('../../../../src/services/workflowCentral/payload/errors');
      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id))
        .rejects.toBeInstanceOf(EphemeralPayloadNotAllowedError);
    } finally {
      if (prev === undefined) delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
      else process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = prev;
    }
  });

  describe('ephemeral opt-in gate (tenant-setting half — workflow.allow_ephemeral_payload)', () => {
    const prevEnv = process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
    beforeEach(() => { delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD; });
    afterAll(() => {
      if (prevEnv === undefined) delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
      else process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = prevEnv;
    });

    function makeEphemeralTask() {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const payload = {
        mode: 'ephemeral_hosted' as const,
        expiresAt: future,
        reason: 'cross-system compose',
        data: { vendorName: 'Acme', amount: 25000 },
      };
      return { ...makeTask(), payload };
    }

    it('allows render when tenant setting = true even with env unset', async () => {
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      (mockTenantConfig.getBooleanStrict as jest.Mock).mockResolvedValueOnce(true);

      const out = await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

      expect(out.kind).toBe('ephemeral');
      expect(mockTenantConfig.getBooleanStrict).toHaveBeenCalledWith('tnt_A', 'workflow.allow_ephemeral_payload');
    });

    it('rejects with EphemeralPayloadNotAllowedError when tenant setting = false and env unset', async () => {
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      (mockTenantConfig.getBooleanStrict as jest.Mock).mockResolvedValueOnce(false);

      const { EphemeralPayloadNotAllowedError } = await import('../../../../src/services/workflowCentral/payload/errors');
      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id))
        .rejects.toBeInstanceOf(EphemeralPayloadNotAllowedError);
      expect(mockTenantConfig.getBooleanStrict).toHaveBeenCalledWith('tnt_A', 'workflow.allow_ephemeral_payload');
    });

    it('rejects with EphemeralPayloadNotAllowedError when tenant setting is absent (no row) and env unset', async () => {
      // getBooleanStrict returns false for the missing-row case (absent
      // setting = deny). This codifies that semantic — distinct from the
      // explicit-false case above, even though they collapse to the same
      // return value here, because the strict path's "throw on encrypted"
      // branch means future callers can rely on false == "definitely
      // unset/disabled" rather than "could be infra failure".
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      (mockTenantConfig.getBooleanStrict as jest.Mock).mockResolvedValueOnce(false);

      const { EphemeralPayloadNotAllowedError } = await import('../../../../src/services/workflowCentral/payload/errors');
      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id))
        .rejects.toBeInstanceOf(EphemeralPayloadNotAllowedError);
    });

    it('env=true short-circuits — tenant setting NOT consulted (global override)', async () => {
      process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = '1';
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

      const out = await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

      expect(out.kind).toBe('ephemeral');
      expect(mockTenantConfig.getBooleanStrict).not.toHaveBeenCalled();
    });

    it('infra failure on tenant-setting lookup propagates (fail-closed via 500, NOT silent allow)', async () => {
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      const boom = new Error('connection refused');
      (mockTenantConfig.getBooleanStrict as jest.Mock).mockRejectedValueOnce(boom);

      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id)).rejects.toBe(boom);
    });

    it('encrypted-row error from getBooleanStrict propagates as 500 (NOT collapsed to 403) — Codex M1', async () => {
      // Codex M1 reproducer: if the gate routed through getBoolean instead
      // of getBooleanStrict, an encrypted row with a dead SecretManager
      // would silently return null → false → 403. The strict path throws
      // on encrypted rows so infra failures surface as the bugs they are.
      const { operator, mockRepo, mockTenantConfig } = buildMocks();
      const taskWithPayload = makeEphemeralTask();
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      const encryptedErr = new Error(
        'tenant_configurations.workflow.allow_ephemeral_payload for tenant tnt_A must be stored as plaintext for the strict-read path',
      );
      (mockTenantConfig.getBooleanStrict as jest.Mock).mockRejectedValueOnce(encryptedErr);

      await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id)).rejects.toBe(encryptedErr);
    });
  });

  it('returns kind=legacy when task has no payload but data is populated (pre-backfill fallback)', async () => {
    const { operator, mockRepo, mockPayloadResolver } = buildMocks();
    const legacyTask = { ...makeTask(), payload: undefined, data: { poNumber: 'PO-1', amount: 5000 } };
    (mockRepo.getById as jest.Mock).mockResolvedValueOnce(legacyTask);

    const out = await operator.getTaskForOperator('tnt_A', legacyTask.id);

    expect(out.kind).toBe('legacy');
    if (out.kind !== 'legacy') return;
    expect(out.legacyResolution.fields).toEqual({ poNumber: 'PO-1', amount: 5000 });
    expect(out.legacyResolution.source).toBe('legacy-row');
    expect(mockPayloadResolver.resolve).not.toHaveBeenCalled();
  });

  // ============================================================================
  // Phase 1 T12 — Audit redaction (ADR-019)
  // ============================================================================

  describe('audit redaction (Phase 1 T12)', () => {
    it('external_reference render: audit details contain refs but NEVER resolved field values', async () => {
      const { operator, mockRepo, mockPayloadResolver, mockAuditLog } = buildMocks();
      const refs = [{ system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-1' }];
      const payload = { mode: 'external_reference' as const, references: refs };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      (mockPayloadResolver.resolve as jest.Mock).mockResolvedValueOnce([
        { ref: refs[0], status: 'resolved', fields: { name: 'Acme', tax_id: '12-3456789-PII' } },
      ]);

      await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

      const auditCall = (mockAuditLog.create as jest.Mock).mock.calls[0]?.[0];
      expect(auditCall).toBeDefined();
      expect(auditCall.action).toBe('workflow_central.render_task');
      expect(auditCall.result).toBe('success');
      // Refs are in audit
      expect(auditCall.details.payload.references).toEqual(refs);
      // Resolved values are NOT in audit — serialized assertion is the load-bearing check
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('Acme');
      expect(serialized).not.toContain('12-3456789-PII');
    });

    it('ephemeral render: audit details contain mode+expiresAt+reason — ephemeral.data NEVER reaches audit', async () => {
      // Opt in to ephemeral so the success-audit fires, not the gate audit.
      // Codex P1 R2 gate fires BEFORE expiry/success path.
      const prevEnv = process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
      process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = '1';
      const { operator, mockRepo, mockAuditLog } = buildMocks();
      const future = new Date(Date.now() + 86_400_000).toISOString();
      const payload = {
        mode: 'ephemeral_hosted' as const,
        expiresAt: future,
        reason: 'cross-system compose',
        data: { secretSSN: '123-45-6789', secretAmount: 99999 },
      };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

      try {
        await operator.getTaskForOperator('tnt_A', taskWithPayload.id);
      } finally {
        if (prevEnv === undefined) delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
        else process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = prevEnv;
      }

      const auditCall = (mockAuditLog.create as jest.Mock).mock.calls[0]?.[0];
      expect(auditCall.details.payload).toEqual({
        mode: 'ephemeral_hosted',
        expiresAt: future,
        reason: 'cross-system compose',
      });
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('123-45-6789');
      expect(serialized).not.toContain('99999');
      expect(serialized).not.toContain('secretSSN');
    });

    it('expired ephemeral: audit row records failure WITHOUT leaking ephemeral.data', async () => {
      // Opt in to ephemeral so the expiry-specific audit fires (NOT the
      // gate-rejection audit). Codex P1 R2 gate fires BEFORE expiry check.
      const prevEnv = process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
      process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = '1';
      try {
        const { operator, mockRepo, mockAuditLog } = buildMocks();
        const past = new Date(Date.now() - 1000).toISOString();
        const payload = {
          mode: 'ephemeral_hosted' as const,
          expiresAt: past,
          reason: 'old',
          data: { secretX: 'should-not-leak' },
        };
        const taskWithPayload = { ...makeTask(), payload };
        (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);

        await expect(operator.getTaskForOperator('tnt_A', taskWithPayload.id)).rejects.toBeDefined();

        const auditCall = (mockAuditLog.create as jest.Mock).mock.calls[0]?.[0];
        expect(auditCall.result).toBe('failure');
        expect(auditCall.error_message).toBe('ephemeral_payload_expired');
        const serialized = JSON.stringify(auditCall);
        expect(serialized).not.toContain('should-not-leak');
        expect(serialized).not.toContain('secretX');
      } finally {
        if (prevEnv === undefined) delete process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD;
        else process.env.WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD = prevEnv;
      }
    });

    it('legacy render: audit details record source but NEVER serialize task.data', async () => {
      const { operator, mockRepo, mockAuditLog } = buildMocks();
      const legacyTask = { ...makeTask(), payload: undefined, data: { sensitivePII: 'should-not-leak', amount: 12345 } };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(legacyTask);

      await operator.getTaskForOperator('tnt_A', legacyTask.id);

      const auditCall = (mockAuditLog.create as jest.Mock).mock.calls[0]?.[0];
      expect(auditCall.details.payload_kind).toBe('legacy');
      expect(auditCall.details.source).toBe('legacy-row');
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('should-not-leak');
      expect(serialized).not.toContain('sensitivePII');
      expect(serialized).not.toContain('12345');
    });

    it('partial-success resolution: audit details report failure count but NEVER include the failed-ref payload values', async () => {
      const { operator, mockRepo, mockPayloadResolver, mockAuditLog } = buildMocks();
      const refs = [
        { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-OK' },
        { system: 'netsuite' as const, recordType: 'vendor', recordId: 'V-DOWN' },
      ];
      const payload = { mode: 'external_reference' as const, references: refs };
      const taskWithPayload = { ...makeTask(), payload };
      (mockRepo.getById as jest.Mock).mockResolvedValueOnce(taskWithPayload);
      (mockPayloadResolver.resolve as jest.Mock).mockResolvedValueOnce([
        { ref: refs[0], status: 'resolved', fields: { secretName: 'Acme' } },
        { ref: refs[1], status: 'failed', error: { code: 'PAYLOAD_REF_CONNECTOR_UNAVAILABLE', statusCode: 503, message: 'down' } },
      ]);

      await operator.getTaskForOperator('tnt_A', taskWithPayload.id);

      const auditCall = (mockAuditLog.create as jest.Mock).mock.calls[0]?.[0];
      expect(auditCall.details.ref_count).toBe(2);
      expect(auditCall.details.resolution_failures).toBe(1);
      const serialized = JSON.stringify(auditCall);
      expect(serialized).not.toContain('Acme');
      expect(serialized).not.toContain('secretName');
    });
  });
});

// ---------------------------------------------------------------------------
// Helper: read a workflow_central_audit_delivery_failures_total counter value
// ---------------------------------------------------------------------------

async function getCounterValue(outcomeLabel: string): Promise<number> {
  const metric = await workflowCentralAuditDeliveryFailures.get();
  const value = metric.values.find(
    (v) => v.labels.action === 'complete_task' && v.labels.outcome === outcomeLabel,
  );
  return value?.value ?? 0;
}
