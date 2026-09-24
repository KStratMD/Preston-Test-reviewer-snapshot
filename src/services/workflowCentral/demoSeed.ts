import type { Logger } from '../../utils/Logger';
import type { DatabaseService } from '../../database/DatabaseService';
import type { WorkflowCentralRepository } from './WorkflowCentralRepository';
import type { WorkflowEngineService } from './WorkflowEngineService';
import type { NewTaskRow, PersistedTask } from './types';
import type { TaskAction } from '../WorkflowCentralService';
import { env } from '../../config';
import { shouldSeedDemoData } from '../governance/demoTenant';

const DAY_MS = 86_400_000;

/**
 * Seed WorkflowCentral tasks for demo/dev environments.
 *
 * Spec D6 + T11: only the tasks Map's writes flow to the repository in v1.
 * In-memory definitions + instances are seeded by `engine.seedDemoData()`;
 * this function seeds the corresponding tasks into `workflow_central_tasks`
 * so the dashboard "myTasks" view returns rows post-migration.
 *
 * Gated by the shared `shouldSeedDemoData` predicate (NODE_ENV + HOSTED_DEMO):
 * ordinary production starts never insert demo rows and jest never does, but a
 * HOSTED_DEMO=1 deployment seeds so the hosted demo dashboard shows content
 * (F5b-3). Tests opt in by exercising the repo directly.
 *
 * Idempotent: rows go through `repo.insertTaskIfMissing`, a real
 * ON CONFLICT DO NOTHING upsert, so a re-run skips existing ids without
 * raising (a caught PK violation would abort the surrounding Postgres TX).
 */
export async function seedWorkflowCentralDemoTasks(
  repo: WorkflowCentralRepository,
  db: DatabaseService,
  opts: { tenantId: string; logger?: Logger; nowMs?: number },
): Promise<{ inserted: number; skipped: number }> {
  // Copilot R12 SHOULD-FIX: the environment early-return is INTENTIONAL — demo
  // task seeding must never run in ordinary production (would pollute real
  // tenant data) AND must never run in jest unit tests (would race with
  // per-test DB resets + insert fixed-id rows that collide across test files).
  // F5b-3 routes the decision through the shared shouldSeedDemoData predicate,
  // which additionally lets a HOSTED_DEMO=1 deployment seed. To exercise the
  // seed logic in tests, override via `process.env.NODE_ENV = 'development'`
  // (or any non-production/non-test value) in a setup block; the dedicated unit
  // test at tests/unit/services/workflowCentral/demoSeed.test.ts uses that
  // pattern. The conflict-skipping upsert later in this function is also
  // intentional: re-running the seed must be idempotent because
  // composition-root wiring calls it once per server startup.
  if (!shouldSeedDemoData(process.env.NODE_ENV, env.HOSTED_DEMO)) {
    return { inserted: 0, skipped: 0 };
  }

  const now = opts.nowMs ?? Date.now();
  const iso = (offsetDays: number): string =>
    new Date(now - offsetDays * DAY_MS).toISOString();
  const isoFuture = (offsetDays: number): string =>
    new Date(now + offsetDays * DAY_MS).toISOString();

  const approveActions: TaskAction[] = [
    { id: 'approve', label: 'Approve', type: 'approve', requiresComment: false },
    { id: 'reject', label: 'Reject', type: 'reject', requiresComment: true },
  ];
  const completeActions: TaskAction[] = [
    { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
  ];

  const base = {
    tenantId: opts.tenantId,
    status: 'pending' as PersistedTask['status'],
  };

  // Copilot R9 SHOULD-FIX: aligned with WorkflowEngineService.seedDemoData()
  // ground truth. Engine seeds three instances:
  //   - INST-1000 / WF-1000 / "Purchase Order Approval" (running)
  //   - INST-1001 / WF-1001 / "Employee Onboarding" (waiting)
  //   - INST-1002 / WF-1002 / "Invoice Processing" (completed — skipped here
  //                                                  since pending tasks on a
  //                                                  completed instance are
  //                                                  logically invalid)
  // Step IDs/names are the values the engine would write at task creation
  // time, per each workflow's step list. Previous mis-keying made the
  // dashboard's myTasks view display tasks attributed to the wrong workflow.
  const rows: NewTaskRow[] = [
    {
      ...base,
      id: 'WCTASK-demo-001',
      instanceId: 'INST-1000',
      workflowId: 'WF-1000',
      workflowName: 'Purchase Order Approval',
      stepId: 'STEP-1',
      stepName: 'Manager Approval',
      taskType: 'approval',
      priority: 'high',
      assigneeId: 'jane.doe@company.com',
      assigneeName: 'Jane Doe',
      description: 'Manager Approval for Purchase Order Approval',
      dueAt: isoFuture(2),
      data: { poNumber: 'PO-2026-1042', amount: 12000, vendor: 'Office Supplies Inc' },
      payload: {
        mode: 'external_reference',
        references: [{
          system: 'netsuite',
          recordType: 'purchaseOrder',
          recordId: 'PO-2026-1042',
          displayHint: 'PO-2026-1042 — Office Supplies Inc — $12,000',
        }],
      },
      actions: approveActions,
      createdAt: iso(1),
      updatedAt: iso(1),
    },
    {
      ...base,
      id: 'WCTASK-demo-002',
      instanceId: 'INST-1001',
      workflowId: 'WF-1001',
      workflowName: 'Employee Onboarding',
      stepId: 'STEP-1',
      stepName: 'IT Setup',
      taskType: 'task',
      priority: 'medium',
      assigneeId: 'ops@company.com',
      assigneeName: 'Operations Team',
      description: 'IT Setup for Employee Onboarding',
      dueAt: isoFuture(3),
      data: { employeeName: 'Casey Chen', department: 'Engineering', startDate: '2026-06-01' },
      payload: {
        mode: 'external_reference',
        references: [{
          system: 'netsuite',
          recordType: 'employee',
          recordId: 'EMP-CASEY-CHEN-2026-06-01',
          displayHint: 'Casey Chen — Engineering — starts 2026-06-01',
        }],
      },
      actions: completeActions,
      createdAt: iso(0.5),
      updatedAt: iso(0.5),
    },
    {
      ...base,
      id: 'WCTASK-demo-003',
      instanceId: 'INST-1000',
      workflowId: 'WF-1000',
      workflowName: 'Purchase Order Approval',
      stepId: 'STEP-3',
      stepName: 'CFO Approval',
      taskType: 'approval',
      priority: 'urgent',
      assigneeId: 'cfo@company.com',
      assigneeName: 'CFO',
      description: 'CFO Approval for Purchase Order Approval — overdue',
      dueAt: iso(1), // overdue (past due_at)
      data: { poNumber: 'PO-2026-1043', amount: 85000, vendor: 'Enterprise Services LLC' },
      payload: {
        mode: 'external_reference',
        references: [{
          system: 'netsuite',
          recordType: 'purchaseOrder',
          recordId: 'PO-2026-1043',
          displayHint: 'PO-2026-1043 — Enterprise Services LLC — $85,000',
        }],
      },
      actions: approveActions,
      createdAt: iso(3),
      updatedAt: iso(3),
    },
  ];

  let inserted = 0;
  let skipped = 0;

  await db.transaction(async (tx) => {
    for (const row of rows) {
      if (await repo.insertTaskIfMissing(tx, row)) inserted++;
      else skipped++;
    }
  });

  opts.logger?.info('WorkflowCentral demo tasks seeded', {
    inserted,
    skipped,
    tenant_id: opts.tenantId,
  });

  return { inserted, skipped };
}

/**
 * seedWorkflowCentralDemoData — seeds both definitions (in-memory) and
 * instance rows (durable DB write) for non-production startup.
 *
 * T12: replaces the old engine.seedDemoData() call in index.ts. Definitions
 * are still seeded into the in-memory Map (definition durability is deferred,
 * Known Gap #4). Instance rows are inserted into workflow_central_instances
 * via repo.insertInstanceIfMissing inside a single TX so they survive
 * hydration.
 *
 * Idempotent: rows go through `repo.insertInstanceIfMissing` (a real
 * ON CONFLICT DO NOTHING upsert); an already-present id is logged as warn and
 * subsequent rows continue. Catching the violation instead would abort the
 * surrounding Postgres transaction and fail every later insert.
 *
 * NOTE: This function does NOT self-gate — the caller is responsible for the
 * environment guard. In production that caller is seedCentralDemoFixturesAtBoot
 * (src/services/governance/demoSeedBoot.ts), which applies shouldSeedDemoData
 * once for both workflow seeders.
 */
export async function seedWorkflowCentralDemoData(
  engine: WorkflowEngineService,
  repo: WorkflowCentralRepository,
  database: DatabaseService,
  options: {
    tenantId: string;
    logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void };
  },
): Promise<void> {
  engine.seedDemoDefinitions();
  const demoRows = engine.getDemoInstanceRows(options.tenantId);
  await database.transaction(async (tx) => {
    for (const row of demoRows) {
      if (!(await repo.insertInstanceIfMissing(tx, row))) {
        options.logger.warn('demo instance already seeded; skipping', { id: row.id });
      }
    }
  });
  options.logger.info('WorkflowCentral demo data seeded', { definitions: 3, instances: demoRows.length });
}
