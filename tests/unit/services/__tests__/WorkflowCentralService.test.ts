/**
 * WorkflowCentralService Unit Tests — post-T9 (PR-OP-3 instance durability)
 *
 * Constructor: WorkflowCentralService(logger, engine, repo, db, auditLog, dlpService)
 *
 * Removed tests (methods deleted in T8/T9):
 *   - completeTask      → WorkflowCentralOperatorService
 *   - advanceWorkflow   → engine.planCascade / engine.applyVolatileState
 *   - createTaskForStep → engine.buildInitialTaskRow
 *   - initializeDemoData → engine.seedDemoDefinitions + repo instance insert (T12)
 *   - engine.deleteInstance / engine.setInstanceStatusForTenant invocations
 *     from cancel/pause/resume — replaced by repo.updateInstanceForTenant
 *     + engine.refreshCacheFromCommit (D9 atomic Map.set).
 *
 * New tests cover:
 *   - startInstance: deferred Map.set (no engine cache mutation if insert throws)
 *   - cancelInstance: DLP redact applied + reason omitted from audit + DLP fail-closed
 *   - pause/resume: status validation + paused_from_status round-trip (D23)
 *   - getInstances: thin pass-through to repo (DB-canonical per §3.5)
 *   - getMetrics: three-source merge (engine defs + repo SQL instance + repo SQL tasks)
 *   - getDashboard.recentInstances: from repo.listInstances, not engine
 *   - safeAudit: increments workflow_central_audit_delivery_failures on throw
 */

import 'reflect-metadata';
import { WorkflowCentralService } from '../../../../src/services/WorkflowCentralService';
import type { WorkflowDefinition } from '../../../../src/services/WorkflowCentralService';
import type { WorkflowEngineService } from '../../../../src/services/workflowCentral/WorkflowEngineService';
import type { WorkflowCentralRepository } from '../../../../src/services/workflowCentral/WorkflowCentralRepository';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';
import type { Logger } from '../../../../src/utils/Logger';
import type { DLPService } from '../../../../src/services/security/DLPService';
import type {
  PersistedTask,
  PersistedInstance,
} from '../../../../src/services/workflowCentral/types';
import { InvalidStateTransitionError } from '../../../../src/services/workflowCentral/errors';
import type { Kysely } from 'kysely';
import type { Database } from '../../../../src/database/types';
import { workflowCentralAuditDeliveryFailures } from '../../../../src/services/workflowCentral/metrics';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function createMockLogger(): jest.Mocked<Logger> {
  return {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    child: jest.fn().mockReturnThis(),
  } as unknown as jest.Mocked<Logger>;
}

function makeDefinition(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    id: 'WF-1000',
    name: 'Test Workflow',
    description: 'desc',
    category: 'Finance',
    version: 1,
    status: 'active',
    triggerType: 'manual',
    triggerConfig: {},
    steps: [],
    variables: [],
    slaHours: null,
    createdBy: 'system',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    publishedAt: null,
    ...overrides,
  };
}

function makeInstance(overrides = {}) {
  return {
    id: 'INST-1000',
    workflowId: 'WF-1000',
    workflowName: 'Test Workflow',
    workflowVersion: 1,
    tenantId: 'tenant-1',
    status: 'running' as const,
    currentStepId: null,
    currentStepName: null,
    variables: {},
    startedBy: 'user-1',
    startedAt: new Date().toISOString(),
    completedAt: null,
    dueAt: null,
    error: null,
    stepHistory: [],
    ...overrides,
  };
}

function makePersistedInstance(overrides: Partial<PersistedInstance> = {}): PersistedInstance {
  const now = new Date().toISOString();
  return {
    id: 'INST-1000',
    tenant_id: 'tenant-1',
    workflow_id: 'WF-1000',
    workflow_name: 'Test Workflow',
    workflow_version: 1,
    status: 'running',
    current_step_id: null,
    current_step_name: null,
    variables: {},
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
    id: 'TASK-1',
    tenantId: 'tenant-1',
    instanceId: 'INST-1000',
    workflowId: 'WF-1000',
    workflowName: 'Test Workflow',
    stepId: 'STEP-1',
    stepName: 'Step 1',
    taskType: 'task',
    status: 'pending',
    priority: 'medium',
    assigneeId: 'user-1',
    assigneeName: 'User One',
    description: 'Do the thing',
    dueAt: null,
    data: {},
    actions: [{ id: 'complete', label: 'Complete', type: 'complete', requiresComment: false }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: null,
    completedBy: null,
    completionActionId: null,
    completionComment: null,
    ...overrides,
  };
}

function createMockEngine(): jest.Mocked<WorkflowEngineService> {
  const def = makeDefinition();
  const inst = makeInstance();
  return {
    getDefinition: jest.fn().mockReturnValue(def),
    getDefinitions: jest.fn().mockReturnValue({ definitions: [def], total: 1 }),
    createDefinition: jest.fn().mockReturnValue(def),
    updateDefinition: jest.fn().mockReturnValue(def),
    getInstance: jest.fn().mockReturnValue(inst),
    getInstanceFromAnywhere: jest.fn().mockResolvedValue(inst),
    getInstances: jest.fn().mockReturnValue({ instances: [inst], total: 1 }),
    createInstance: jest.fn().mockReturnValue(inst),
    buildInitialTaskRow: jest.fn().mockReturnValue(null),
    refreshCacheFromCommit: jest.fn().mockImplementation(
      ({ instance, cancellationReason }: { instance: PersistedInstance; cancellationReason?: string | null }) => ({
        ...makeInstance({
          id: instance.id,
          tenantId: instance.tenant_id,
          status: instance.status,
        }),
        cancellationReason: cancellationReason ?? null,
      }),
    ),
    planCascade: jest.fn(),
    seedDemoDefinitions: jest.fn(),
    getDemoInstanceRows: jest.fn().mockReturnValue([]),
    hydrate: jest.fn(),
    hydrationReady: true,
    getCacheSize: jest.fn().mockReturnValue(0),
  } as unknown as jest.Mocked<WorkflowEngineService>;
}

function createMockRepo(): jest.Mocked<WorkflowCentralRepository> {
  const task = makePersistedTask();
  const persistedInstance = makePersistedInstance();
  return {
    getById: jest.fn().mockResolvedValue(task),
    listTasks: jest.fn().mockResolvedValue([task]),
    countTasks: jest.fn().mockResolvedValue(1),
    listByAssignee: jest.fn().mockResolvedValue([task]),
    listByInstance: jest.fn().mockResolvedValue([task]),
    listOverdue: jest.fn().mockResolvedValue([]),
    countOverdue: jest.fn().mockResolvedValue(0),
    countByStatus: jest.fn().mockResolvedValue(1),
    countCompletedSince: jest.fn().mockResolvedValue(0),
    insertTask: jest.fn().mockResolvedValue(undefined),
    insertInstance: jest.fn().mockResolvedValue(persistedInstance),
    selectInstanceForUpdate: jest.fn().mockResolvedValue(persistedInstance),
    getInstanceById: jest.fn().mockResolvedValue(persistedInstance),
    updateInstanceForTenant: jest.fn().mockResolvedValue(persistedInstance),
    listInstances: jest.fn().mockResolvedValue({
      instances: [makeInstance()],
      total: 1,
    }),
    listInstancesForHydration: jest.fn().mockResolvedValue([persistedInstance]),
    computeMetrics: jest.fn().mockResolvedValue({
      totalInstances: 5,
      runningInstances: 2,
      completedInstances: 2,
      failedInstances: 1,
      avgCompletionTime: 1.5,
      slaComplianceRate: 90,
      instancesStartedToday: 1,
    }),
    completeTaskAtomicWithCascade: jest.fn(),
    cancelPendingForInstance: jest.fn().mockResolvedValue(['TASK-1']),
    delegatePendingTask: jest.fn().mockResolvedValue({
      updatedTask: makePersistedTask({ assigneeId: 'new-user', assigneeName: 'New User' }),
      previousAssigneeId: 'user-1',
    }),
    catchUpBackfill: jest.fn().mockResolvedValue({ recovered: 0 }),
    insertActivityLog: jest.fn().mockResolvedValue(undefined),
    listRecentActivityForTenant: jest.fn().mockResolvedValue([]),
  } as unknown as jest.Mocked<WorkflowCentralRepository>;
}

function createMockDb(): jest.Mocked<DatabaseService> {
  const mockTx = {} as Kysely<Database>;
  return {
    transaction: jest.fn().mockImplementation(
      async (cb: (tx: Kysely<Database>) => Promise<unknown>) => cb(mockTx),
    ),
    getDatabase: jest.fn(),
  } as unknown as jest.Mocked<DatabaseService>;
}

function createMockAuditLog(): jest.Mocked<AuditLogRepository> {
  return {
    create: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<AuditLogRepository>;
}

function createMockDlp(): jest.Mocked<DLPService> {
  return {
    scanText: jest.fn().mockResolvedValue({
      findings: [],
      piiTypes: [],
      redactedData: undefined,
    }),
  } as unknown as jest.Mocked<DLPService>;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('WorkflowCentralService (post-T9 / PR-OP-3 instance durability)', () => {
  let service: WorkflowCentralService;
  let mockLogger: jest.Mocked<Logger>;
  let mockEngine: jest.Mocked<WorkflowEngineService>;
  let mockRepo: jest.Mocked<WorkflowCentralRepository>;
  let mockDb: jest.Mocked<DatabaseService>;
  let mockAuditLog: jest.Mocked<AuditLogRepository>;
  let mockDlp: jest.Mocked<DLPService>;

  beforeEach(() => {
    mockLogger = createMockLogger();
    mockEngine = createMockEngine();
    mockRepo = createMockRepo();
    mockDb = createMockDb();
    mockAuditLog = createMockAuditLog();
    mockDlp = createMockDlp();
    service = new WorkflowCentralService(
      mockLogger,
      mockEngine,
      mockRepo,
      mockDb,
      mockAuditLog,
      mockDlp,
    );
  });

  // -------------------------------------------------------------------------
  // Initialization
  // -------------------------------------------------------------------------

  describe('initialization', () => {
    it('logs initialized message', () => {
      expect(mockLogger.info).toHaveBeenCalledWith('WorkflowCentralService initialized');
    });

    it('does NOT call engine.seedDemoDefinitions (T12 wires it from composition root)', () => {
      expect(mockEngine.seedDemoDefinitions).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Dashboard & Metrics
  // -------------------------------------------------------------------------

  describe('getDashboard', () => {
    it('returns dashboard structure with required fields', async () => {
      const dashboard = await service.getDashboard('tenant-1');
      expect(dashboard).toHaveProperty('summary');
      expect(dashboard).toHaveProperty('metrics');
      expect(dashboard).toHaveProperty('recentInstances');
      expect(dashboard).toHaveProperty('myTasks');
      expect(dashboard).toHaveProperty('workflowsByCategory');
      expect(dashboard).toHaveProperty('recentActivity');
      expect(dashboard).toHaveProperty('lastUpdated');
    });

    it('reads recentInstances from repo.listInstances (DB-canonical, NOT engine)', async () => {
      await service.getDashboard('tenant-abc');
      expect(mockRepo.listInstances).toHaveBeenCalledWith('tenant-abc', {
        limit: 5,
        orderBy: 'started_at DESC',
      });
    });

    it('calls repo.listByAssignee when userId is provided', async () => {
      await service.getDashboard('tenant-1', 'user-42');
      expect(mockRepo.listByAssignee).toHaveBeenCalledWith('tenant-1', 'user-42');
    });

    it('does not call repo.listByAssignee when userId is absent', async () => {
      await service.getDashboard('tenant-1');
      expect(mockRepo.listByAssignee).not.toHaveBeenCalled();
    });
  });

  describe('getMetrics (three-source merge per §3.6)', () => {
    it('returns full WorkflowMetrics shape', async () => {
      const metrics = await service.getMetrics('tenant-1');
      expect(metrics).toHaveProperty('totalWorkflows');
      expect(metrics).toHaveProperty('activeWorkflows');
      expect(metrics).toHaveProperty('totalInstances');
      expect(metrics).toHaveProperty('runningInstances');
      expect(metrics).toHaveProperty('completedInstances');
      expect(metrics).toHaveProperty('failedInstances');
      expect(metrics).toHaveProperty('avgCompletionTime');
      expect(metrics).toHaveProperty('slaComplianceRate');
      expect(metrics).toHaveProperty('pendingTasks');
      expect(metrics).toHaveProperty('overdueTasks');
      expect(metrics).toHaveProperty('tasksCompletedToday');
      expect(metrics).toHaveProperty('instancesStartedToday');
    });

    it('reads definition counts from engine (totalWorkflows + activeWorkflows)', async () => {
      mockEngine.getDefinitions.mockReturnValueOnce({
        definitions: [
          makeDefinition({ status: 'active' }),
          makeDefinition({ id: 'WF-2', status: 'active' }),
          makeDefinition({ id: 'WF-3', status: 'draft' }),
        ],
        total: 3,
      });
      const metrics = await service.getMetrics('tenant-1');
      expect(metrics.totalWorkflows).toBe(3);
      expect(metrics.activeWorkflows).toBe(2);
    });

    it('reads instance-derived counts from repo.computeMetrics (NOT engine iteration)', async () => {
      mockRepo.computeMetrics.mockResolvedValueOnce({
        totalInstances: 7,
        runningInstances: 3,
        completedInstances: 3,
        failedInstances: 1,
        avgCompletionTime: 2.5,
        slaComplianceRate: 85.5,
        instancesStartedToday: 2,
      });
      const metrics = await service.getMetrics('tenant-1');
      expect(metrics.totalInstances).toBe(7);
      expect(metrics.runningInstances).toBe(3);
      expect(metrics.completedInstances).toBe(3);
      expect(metrics.failedInstances).toBe(1);
      expect(metrics.avgCompletionTime).toBe(2.5);
      expect(metrics.slaComplianceRate).toBe(85.5);
      expect(metrics.instancesStartedToday).toBe(2);
    });

    it('delegates pending-task count to repo.countByStatus', async () => {
      await service.getMetrics('tenant-1');
      expect(mockRepo.countByStatus).toHaveBeenCalledWith('tenant-1', 'pending');
    });

    it('delegates overdueTasks to repo.countOverdue', async () => {
      mockRepo.countOverdue.mockResolvedValueOnce(4);
      const metrics = await service.getMetrics('tenant-1');
      expect(metrics.overdueTasks).toBe(4);
    });

    it('delegates completed-today count to repo.countCompletedSince', async () => {
      await service.getMetrics('tenant-1');
      expect(mockRepo.countCompletedSince).toHaveBeenCalledWith('tenant-1', expect.any(String));
    });
  });

  describe('getWorkflowsByCategory', () => {
    it('returns category grouping from engine', () => {
      mockEngine.getDefinitions.mockReturnValueOnce({
        definitions: [
          makeDefinition({ category: 'Finance' }),
          makeDefinition({ id: 'WF-1001', category: 'Finance' }),
          makeDefinition({ id: 'WF-1002', category: 'HR' }),
        ],
        total: 3,
      });
      const result = service.getWorkflowsByCategory();
      expect(result).toEqual(
        expect.arrayContaining([
          { category: 'Finance', count: 2 },
          { category: 'HR', count: 1 },
        ])
      );
    });
  });

  // -------------------------------------------------------------------------
  // Definition CRUD — engine delegations
  // -------------------------------------------------------------------------

  describe('getDefinitions', () => {
    it('delegates to engine.getDefinitions', async () => {
      const result = await service.getDefinitions({ status: 'active' });
      expect(mockEngine.getDefinitions).toHaveBeenCalledWith({ status: 'active' });
      expect(result.definitions.length).toBeGreaterThan(0);
    });
  });

  describe('getDefinition', () => {
    it('delegates to engine.getDefinition', async () => {
      const result = await service.getDefinition('WF-1000');
      expect(mockEngine.getDefinition).toHaveBeenCalledWith('WF-1000');
      expect(result).not.toBeNull();
    });

    it('returns null for unknown id', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(null);
      const result = await service.getDefinition('NON-EXISTENT');
      expect(result).toBeNull();
    });
  });

  describe('createDefinition', () => {
    it('delegates to engine.createDefinition', async () => {
      const data = {
        name: 'New WF',
        description: 'desc',
        category: 'Test',
        triggerType: 'manual' as const,
        createdBy: 'user-1',
      };
      await service.createDefinition(data);
      expect(mockEngine.createDefinition).toHaveBeenCalledWith(data);
    });
  });

  describe('updateDefinition', () => {
    it('delegates to engine.updateDefinition', async () => {
      await service.updateDefinition('WF-1000', { name: 'Updated' });
      expect(mockEngine.updateDefinition).toHaveBeenCalledWith('WF-1000', { name: 'Updated' });
    });

    it('returns null when engine returns null', async () => {
      mockEngine.updateDefinition.mockReturnValueOnce(null);
      const result = await service.updateDefinition('WF-1000', { name: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('publishDefinition', () => {
    it('publishes a draft definition', async () => {
      const draft = makeDefinition({ status: 'draft' });
      mockEngine.getDefinition.mockReturnValueOnce(draft);
      const result = await service.publishDefinition('WF-1000');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('active');
      expect(result!.publishedAt).not.toBeNull();
    });

    it('returns null for non-draft definition', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(makeDefinition({ status: 'active' }));
      const result = await service.publishDefinition('WF-1000');
      expect(result).toBeNull();
    });

    it('returns null when definition does not exist', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(null);
      const result = await service.publishDefinition('NON-EXISTENT');
      expect(result).toBeNull();
    });
  });

  describe('deprecateDefinition', () => {
    it('deprecates an active definition', async () => {
      const active = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(active);
      const result = await service.deprecateDefinition('WF-1000');
      expect(result).not.toBeNull();
      expect(result!.status).toBe('deprecated');
    });

    it('returns null for non-active definition', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(makeDefinition({ status: 'draft' }));
      const result = await service.deprecateDefinition('WF-1000');
      expect(result).toBeNull();
    });
  });

  describe('addStep', () => {
    it('adds step to draft definition', async () => {
      const draft = makeDefinition({ status: 'draft', steps: [] });
      mockEngine.getDefinition.mockReturnValueOnce(draft);
      const result = await service.addStep('WF-1000', {
        name: 'Review Step',
        type: 'task',
        order: 1,
        config: {},
        transitions: [],
        timeoutHours: null,
        retryPolicy: null,
      });
      expect(result).not.toBeNull();
      expect(result!.steps).toHaveLength(1);
      expect(result!.steps[0].id).toMatch(/^STEP-/);
    });

    it('returns null for non-draft definition', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(makeDefinition({ status: 'active' }));
      const result = await service.addStep('WF-1000', {
        name: 'x', type: 'task', order: 1, config: {}, transitions: [], timeoutHours: null, retryPolicy: null,
      });
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Instance reads — DB-canonical per §3.5
  // -------------------------------------------------------------------------

  describe('getInstances (DB-canonical)', () => {
    it('delegates to repo.listInstances (NOT engine.getInstances)', async () => {
      const result = await service.getInstances('tenant-1', { status: 'running' });
      expect(mockRepo.listInstances).toHaveBeenCalledWith('tenant-1', { status: 'running' });
      expect(mockEngine.getInstances).not.toHaveBeenCalled();
      expect(result.instances.length).toBeGreaterThan(0);
    });

    it('preserves { instances, total } shape and PRE-PAGINATION total', async () => {
      mockRepo.listInstances.mockResolvedValueOnce({
        instances: [makeInstance(), makeInstance({ id: 'INST-2' })],
        total: 13,
      });
      const result = await service.getInstances('tenant-1', { limit: 5 });
      expect(result.instances).toHaveLength(2);
      expect(result.total).toBe(13);
    });

    it('surfaces terminal instances older than the hydration window (no engine bound)', async () => {
      // Spec contract: repo.listInstances is NOT bounded by recentTerminalHydrationDays.
      // A completed row 60 days old must still surface here.
      const oldCompleted = makeInstance({
        id: 'INST-OLD',
        status: 'completed',
        completedAt: new Date(Date.now() - 60 * 24 * 3_600_000).toISOString(),
      });
      mockRepo.listInstances.mockResolvedValueOnce({
        instances: [oldCompleted],
        total: 1,
      });
      const result = await service.getInstances('tenant-1', { status: 'completed' });
      expect(result.instances[0].id).toBe('INST-OLD');
    });
  });

  describe('getInstance (cache-first with DB fallback)', () => {
    it('delegates to engine.getInstanceFromAnywhere with repo', async () => {
      const result = await service.getInstance('tenant-1', 'INST-1000');
      expect(mockEngine.getInstanceFromAnywhere).toHaveBeenCalledWith(
        mockRepo,
        'tenant-1',
        'INST-1000',
      );
      expect(result).not.toBeNull();
    });

    it('returns null for unknown instance', async () => {
      mockEngine.getInstanceFromAnywhere.mockResolvedValueOnce(null);
      const result = await service.getInstance('tenant-1', 'NON-EXISTENT');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // startInstance — deferred Map.set (D10)
  // -------------------------------------------------------------------------

  describe('startInstance (deferred Map.set per D10)', () => {
    it('returns null when definition is not active', async () => {
      mockEngine.getDefinition.mockReturnValueOnce(null);
      const result = await service.startInstance({
        tenantId: 'tenant-1',
        workflowId: 'WF-MISSING',
        startedBy: 'user-1',
      });
      expect(result).toBeNull();
    });

    it('creates ephemeral via engine, inserts via repo, refreshes cache POST-commit', async () => {
      const def = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(def);
      mockEngine.buildInitialTaskRow.mockReturnValueOnce(null);

      const result = await service.startInstance({
        tenantId: 'tenant-1',
        workflowId: 'WF-1000',
        startedBy: 'user-1',
      });

      expect(mockEngine.createInstance).toHaveBeenCalledWith(
        'tenant-1', 'WF-1000', {}, 'user-1',
      );
      expect(mockRepo.insertInstance).toHaveBeenCalled();
      expect(mockEngine.refreshCacheFromCommit).toHaveBeenCalled();
      expect(result).not.toBeNull();
      expect(result!.instanceId).toBe('INST-1000');
      expect(result!.initialTaskId).toBeNull();
    });

    it('inserts initial task row when buildInitialTaskRow returns a row', async () => {
      const def = makeDefinition({ status: 'active' });
      const taskRow = {
        id: 'TASK-NEW',
        tenantId: 'tenant-1',
        instanceId: 'INST-1000',
        workflowId: 'WF-1000',
        workflowName: 'Test Workflow',
        stepId: 'STEP-1',
        stepName: 'Step 1',
        taskType: 'task',
        status: 'pending' as const,
        priority: 'medium' as const,
        assigneeId: 'manager',
        assigneeName: 'Manager',
        description: 'Test',
        dueAt: null,
        data: {},
        actions: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      mockEngine.getDefinition.mockReturnValueOnce(def);
      mockEngine.buildInitialTaskRow.mockReturnValueOnce(taskRow);

      const result = await service.startInstance({
        tenantId: 'tenant-1',
        workflowId: 'WF-1000',
        startedBy: 'user-1',
      });

      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockRepo.insertTask).toHaveBeenCalled();
      expect(result!.initialTaskId).toBe('TASK-NEW');
    });

    it('does NOT mutate engine cache when DB insert throws (deferred Map.set)', async () => {
      const def = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(def);
      mockEngine.buildInitialTaskRow.mockReturnValueOnce(null);
      mockDb.transaction.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.startInstance({
          tenantId: 'tenant-1',
          workflowId: 'WF-1000',
          startedBy: 'user-1',
        }),
      ).rejects.toThrow('DB error');

      // Spec D10: cache was NEVER mutated → no refresh, no cleanup needed.
      expect(mockEngine.refreshCacheFromCommit).not.toHaveBeenCalled();
    });

    it('emits failure audit on DB insert error', async () => {
      const def = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(def);
      mockEngine.buildInitialTaskRow.mockReturnValueOnce(null);
      mockDb.transaction.mockRejectedValueOnce(new Error('DB error'));

      await expect(
        service.startInstance({
          tenantId: 'tenant-1',
          workflowId: 'WF-1000',
          startedBy: 'user-1',
        }),
      ).rejects.toThrow('DB error');

      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.start_instance',
          result: 'failure',
        }),
      );
    });

    it('emits success audit on happy path with the DB-returned instance id', async () => {
      const def = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(def);
      mockEngine.buildInitialTaskRow.mockReturnValueOnce(null);

      await service.startInstance({
        tenantId: 'tenant-1',
        workflowId: 'WF-1000',
        startedBy: 'user-1',
      });

      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.start_instance',
          result: 'success',
        }),
      );
    });

    it('preserves PR-OP-2 return contract: { instanceId, initialTaskId }', async () => {
      const def = makeDefinition({ status: 'active' });
      mockEngine.getDefinition.mockReturnValueOnce(def);
      const result = await service.startInstance({
        tenantId: 'tenant-1',
        workflowId: 'WF-1000',
        startedBy: 'user-1',
      });
      expect(result).toHaveProperty('instanceId');
      expect(result).toHaveProperty('initialTaskId');
    });
  });

  // -------------------------------------------------------------------------
  // cancelInstance — DB-canonical + DLP redact
  // -------------------------------------------------------------------------

  describe('cancelInstance (DB-canonical + DLP redact)', () => {
    it('runs cancel TX (updateInstanceForTenant + cancelPendingForInstance) on running instance', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      const result = await service.cancelInstance('tenant-1', 'INST-1000', 'admin');
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({
          kind: 'cancelInstance',
          status: 'cancelled',
          clearPausedFromStatus: true,
        }),
      );
      expect(mockRepo.cancelPendingForInstance).toHaveBeenCalled();
      expect(result).not.toBeNull();
    });

    it('returns null on unknown instance (selectInstanceForUpdate returns null → NotFoundError → 404)', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(null);
      const result = await service.cancelInstance('tenant-1', 'INST-WRONG', 'admin');
      expect(result).toBeNull();
      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
    });

    it('returns null when instance is in terminal state (completed/failed/cancelled)', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'completed' }),
      );
      const result = await service.cancelInstance('tenant-1', 'INST-1000', 'admin');
      expect(result).toBeNull();
      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
    });

    it('accepts paused → cancelled (D22)', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'running' }),
      );
      const result = await service.cancelInstance('tenant-1', 'INST-1000', 'admin');
      expect(result).not.toBeNull();
      // Clears paused_from_status per D22+D23 symmetry.
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({ kind: 'cancelInstance', clearPausedFromStatus: true }),
      );
    });

    it('applies DLP redact to cancellation reason (autoRedact + redactedData)', async () => {
      mockDlp.scanText.mockResolvedValueOnce({
        findings: [{ type: 'ssn', field: '', value: '123-45-6789', startIndex: 0, endIndex: 11 } as unknown as never],
        piiTypes: ['ssn'],
        redactedData: 'budget revoked; SSN [REDACTED]',
      });
      const result = await service.cancelInstance(
        'tenant-1',
        'INST-1000',
        'admin',
        'budget revoked; SSN 123-45-6789',
      );
      expect(mockDlp.scanText).toHaveBeenCalled();
      expect(result).not.toBeNull();
      // refreshCacheFromCommit was called with the redacted reason; the mocked
      // engine echoes cancellationReason through to the returned instance.
      expect(result!.cancellationReason).toBe('budget revoked; SSN [REDACTED]');
    });

    it('DLP fail-closed (a): scanText throws → REDACT_PLACEHOLDER', async () => {
      mockDlp.scanText.mockRejectedValueOnce(new Error('DLP unavailable'));
      const result = await service.cancelInstance(
        'tenant-1',
        'INST-1000',
        'admin',
        'some sensitive reason',
      );
      expect(result).not.toBeNull();
      expect(result!.cancellationReason).toBe('[redacted: dlp failed-closed]');
    });

    it('DLP fail-closed (b): findings present but redactedData undefined → REDACT_PLACEHOLDER', async () => {
      mockDlp.scanText.mockResolvedValueOnce({
        findings: [{ type: 'ssn', field: '', value: 'x', startIndex: 0, endIndex: 1 } as unknown as never],
        piiTypes: ['ssn'],
        redactedData: undefined,
      });
      const result = await service.cancelInstance(
        'tenant-1',
        'INST-1000',
        'admin',
        'tainted reason',
      );
      expect(result).not.toBeNull();
      expect(result!.cancellationReason).toBe('[redacted: dlp failed-closed]');
    });

    it('returns null cancellationReason when caller passed no reason (no DLP call)', async () => {
      const result = await service.cancelInstance('tenant-1', 'INST-1000', 'admin');
      expect(result).not.toBeNull();
      expect(result!.cancellationReason).toBeNull();
      expect(mockDlp.scanText).not.toHaveBeenCalled();
    });

    it('passes original reason when no findings AND no redactedData (clean text)', async () => {
      mockDlp.scanText.mockResolvedValueOnce({
        findings: [],
        piiTypes: [],
        redactedData: undefined,
      });
      const result = await service.cancelInstance(
        'tenant-1',
        'INST-1000',
        'admin',
        'budget revoked by finance',
      );
      expect(result).not.toBeNull();
      expect(result!.cancellationReason).toBe('budget revoked by finance');
    });

    it('omits cancellation_reason from the audit log details (DLP carve-out)', async () => {
      await service.cancelInstance('tenant-1', 'INST-1000', 'admin', 'sensitive PII text');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.cancel_instance',
          result: 'success',
          resource_id: 'INST-1000',
          details: expect.not.objectContaining({ cancellation_reason: expect.anything() }),
        }),
      );
    });

    it('emits NO audit on DB transaction failure (deliberate — no committed state)', async () => {
      mockDb.transaction.mockRejectedValueOnce(new Error('tx fail'));
      await expect(
        service.cancelInstance('tenant-1', 'INST-1000', 'admin'),
      ).rejects.toThrow('tx fail');
      expect(mockAuditLog.create).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // pauseInstance / resumeInstance — durable per D14 + D23
  // -------------------------------------------------------------------------

  describe('pauseInstance (durable, D14)', () => {
    it('runs pause TX when instance is running, sets paused_from_status to running', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      const result = await service.pauseInstance('tenant-1', 'INST-1000');
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({
          kind: 'pauseInstance',
          status: 'paused',
          pausedFromStatus: 'running',
        }),
      );
      expect(result).not.toBeNull();
    });

    it('captures paused_from_status as waiting (D23 sets prior status, NOT hardcoded "running")', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'waiting' }),
      );
      await service.pauseInstance('tenant-1', 'INST-1000');
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({
          kind: 'pauseInstance',
          pausedFromStatus: 'waiting',
        }),
      );
    });

    it('returns null when instance not found', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(null);
      const result = await service.pauseInstance('tenant-1', 'INST-WRONG');
      expect(result).toBeNull();
      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
    });

    it('throws InvalidStateTransitionError when instance is in terminal state', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'completed' }),
      );
      await expect(
        service.pauseInstance('tenant-1', 'INST-1000'),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('throws InvalidStateTransitionError when instance is already paused', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused' }),
      );
      await expect(
        service.pauseInstance('tenant-1', 'INST-1000'),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('emits pause audit on success', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      await service.pauseInstance('tenant-1', 'INST-1000');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.pause_instance',
          result: 'success',
        }),
      );
    });
  });

  describe('resumeInstance (durable, restores pre-pause status per D23)', () => {
    it('restores status from paused_from_status (D23 — NOT hardcoded "running")', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'waiting' }),
      );
      await service.resumeInstance('tenant-1', 'INST-1000');
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({
          kind: 'resumeInstance',
          status: 'waiting',
          clearPausedFromStatus: true,
        }),
      );
    });

    it('falls back to running when paused_from_status is null (defensive — legacy rows)', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: null }),
      );
      await service.resumeInstance('tenant-1', 'INST-1000');
      expect(mockRepo.updateInstanceForTenant).toHaveBeenCalledWith(
        expect.anything(),
        'tenant-1',
        'INST-1000',
        expect.objectContaining({
          kind: 'resumeInstance',
          status: 'running',
        }),
      );
    });

    it('returns null when instance not found', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(null);
      const result = await service.resumeInstance('tenant-1', 'INST-WRONG');
      expect(result).toBeNull();
      expect(mockRepo.updateInstanceForTenant).not.toHaveBeenCalled();
    });

    it('throws InvalidStateTransitionError when instance is not paused', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      await expect(
        service.resumeInstance('tenant-1', 'INST-1000'),
      ).rejects.toThrow(InvalidStateTransitionError);
    });

    it('emits resume audit with previous_status + resumed_to_status', async () => {
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'paused', paused_from_status: 'waiting' }),
      );
      mockRepo.updateInstanceForTenant.mockResolvedValueOnce(
        makePersistedInstance({ status: 'waiting', paused_from_status: null }),
      );
      await service.resumeInstance('tenant-1', 'INST-1000');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.resume_instance',
          result: 'success',
          details: expect.objectContaining({
            previous_status: 'paused',
            resumed_to_status: 'waiting',
          }),
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Task Reads — repo delegations
  // -------------------------------------------------------------------------

  describe('getTasks', () => {
    it('delegates to repo.listTasks with tenantId', async () => {
      const result = await service.getTasks('tenant-1', { status: 'pending' });
      expect(mockRepo.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenant-1', status: 'pending' })
      );
      expect(result.tasks.length).toBeGreaterThan(0);
    });

    it('passes limit and offset to repo', async () => {
      await service.getTasks('tenant-1', { limit: 10, offset: 5 });
      expect(mockRepo.listTasks).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 10, offset: 5 })
      );
    });
  });

  describe('getTask', () => {
    it('delegates to repo.getById with tenantId', async () => {
      const result = await service.getTask('tenant-1', 'TASK-1');
      expect(mockRepo.getById).toHaveBeenCalledWith('tenant-1', 'TASK-1');
      expect(result).not.toBeNull();
    });

    it('returns null for unknown task', async () => {
      mockRepo.getById.mockResolvedValueOnce(null);
      const result = await service.getTask('tenant-1', 'TASK-MISSING');
      expect(result).toBeNull();
    });
  });

  describe('getTasksByAssignee', () => {
    it('delegates to repo.listByAssignee with tenantId', async () => {
      const result = await service.getTasksByAssignee('tenant-1', 'user-42', 'pending');
      expect(mockRepo.listByAssignee).toHaveBeenCalledWith('tenant-1', 'user-42', 'pending');
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('getOverdueCount', () => {
    it('sums overdue tasks from repo and overdue instances from engine', async () => {
      mockRepo.countOverdue.mockResolvedValueOnce(2);
      mockEngine.getInstances.mockReturnValueOnce({
        instances: [
          makeInstance({ status: 'running', dueAt: new Date(Date.now() - 1000).toISOString() }),
        ],
        total: 1,
      });

      const count = await service.getOverdueCount('tenant-1');
      expect(count).toBe(3); // 2 repo + 1 engine
    });
  });

  // -------------------------------------------------------------------------
  // delegateTask
  // -------------------------------------------------------------------------

  describe('delegateTask', () => {
    it('delegates pending task and returns updated task', async () => {
      const result = await service.delegateTask(
        'tenant-1', 'TASK-1', 'new-user', 'New User', 'delegator'
      );
      expect(mockDb.transaction).toHaveBeenCalled();
      expect(mockRepo.delegatePendingTask).toHaveBeenCalledWith(
        expect.anything(), 'tenant-1', 'TASK-1', 'new-user', 'New User'
      );
      expect(result).not.toBeNull();
      expect(result!.assigneeId).toBe('new-user');
    });

    it('emits success audit entry', async () => {
      await service.delegateTask('tenant-1', 'TASK-1', 'new-user', 'New User', 'delegator');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.delegate_task',
          result: 'success',
          resource_id: 'TASK-1',
        })
      );
    });

    it('returns null when task not found or already disposed', async () => {
      mockRepo.delegatePendingTask.mockResolvedValueOnce(null);
      mockRepo.getById.mockResolvedValueOnce(null);

      const result = await service.delegateTask(
        'tenant-1', 'TASK-MISSING', 'new-user', 'New User', 'delegator'
      );
      expect(result).toBeNull();
    });

    it('emits failure audit with not_found code when task does not exist', async () => {
      mockRepo.delegatePendingTask.mockResolvedValueOnce(null);
      mockRepo.getById.mockResolvedValueOnce(null);

      await service.delegateTask('tenant-1', 'TASK-MISSING', 'new-user', 'New User', 'delegator');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.delegate_task',
          result: 'failure',
          error_message: 'not_found',
        })
      );
    });

    it('emits failure audit with already_dispositioned code when task exists but not pending', async () => {
      mockRepo.delegatePendingTask.mockResolvedValueOnce(null);
      mockRepo.getById.mockResolvedValueOnce(makePersistedTask({ status: 'completed' }));

      await service.delegateTask('tenant-1', 'TASK-1', 'new-user', 'New User', 'delegator');
      expect(mockAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'workflow_central.delegate_task',
          result: 'failure',
          error_message: 'already_dispositioned',
        })
      );
    });
  });

  // -------------------------------------------------------------------------
  // safeAudit — best-effort + metric on failure (D15)
  // -------------------------------------------------------------------------

  describe('safeAudit (best-effort + metric per D15)', () => {
    it('increments workflow_central_audit_delivery_failures_total when audit throws', async () => {
      // Force the audit insert to throw and assert the counter increments.
      mockAuditLog.create.mockRejectedValueOnce(new Error('audit DB down'));
      const before = await readCounterValue();

      // Any successful operator path triggers safeAudit; use cancelInstance for this.
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      await service.cancelInstance('tenant-1', 'INST-1000', 'admin');

      const after = await readCounterValue();
      expect(after).toBeGreaterThan(before);
    });

    it('does NOT propagate audit failure to caller (instance state durable)', async () => {
      mockAuditLog.create.mockRejectedValueOnce(new Error('audit DB down'));
      mockRepo.selectInstanceForUpdate.mockResolvedValueOnce(
        makePersistedInstance({ status: 'running' }),
      );
      await expect(
        service.cancelInstance('tenant-1', 'INST-1000', 'admin'),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Activity
  // -------------------------------------------------------------------------

  describe('getRecentActivity', () => {
    it('delegates to repo.listRecentActivityForTenant with tenant scoping', async () => {
      mockRepo.listRecentActivityForTenant.mockResolvedValueOnce([]);
      const activity = await service.getRecentActivity('tenant-1', { limit: 10 });
      expect(Array.isArray(activity)).toBe(true);
      expect(mockRepo.listRecentActivityForTenant).toHaveBeenCalledWith(
        'tenant-1',
        { limit: 10 },
      );
    });

    it('forwards instanceId filter to the repo', async () => {
      mockRepo.listRecentActivityForTenant.mockResolvedValueOnce([]);
      await service.getRecentActivity('tenant-1', { limit: 5, instanceId: 'INST-1' });
      expect(mockRepo.listRecentActivityForTenant).toHaveBeenCalledWith(
        'tenant-1',
        { limit: 5, instanceId: 'INST-1' },
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Counter readback helper — sums all label combinations for the metric.
// ---------------------------------------------------------------------------
async function readCounterValue(): Promise<number> {
  const snap = await workflowCentralAuditDeliveryFailures.get();
  return snap.values.reduce((sum, v) => sum + (v.value ?? 0), 0);
}
