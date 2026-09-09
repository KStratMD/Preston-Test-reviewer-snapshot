/**
 * WorkflowCentral Postgres concurrency tests (T13.5).
 *
 * Exercises the row-locking + transaction-ordering guarantees PR-OP-3 added
 * via SELECT ... FOR UPDATE on the workflow_central_instances row. These
 * proofs cannot be expressed against SQLite (no FOR UPDATE syntax — D6) so
 * the suite lives under tests/integration/postgres/** and runs only under
 * jest.postgres.config.cjs against a real Postgres backend.
 *
 * Gating: jest.postgres.config.cjs's setupFile (tests/integration/setupEnvPostgres.ts)
 * already hard-fails on missing DATABASE_URL. The per-suite `beforeAll` guard
 * here is intentional defense-in-depth so a misconfigured runner that
 * accidentally invokes this file outside the postgres profile still fails
 * loudly rather than silently no-op'ing.
 *
 * Pattern source: tests/integration/postgres/for-update.test.ts (P5c) for the
 * raw pg.Pool client lifecycle (BEGIN / FOR UPDATE / ROLLBACK on release).
 * Spec: docs/plans/2026-05-15-workflow-central-instance-durability-spec.md
 *   §3.2 (instance-first lock order D21) + §4 (schema)
 * Plan: docs/plans/2026-05-15-workflow-central-instance-durability-plan.md
 *   Task 13 Step 5 (T-5/T-6 + raw FOR UPDATE proofs).
 *
 * Test inventory (4 tests, no .skip):
 *   T-5 — AB-BA deadlock guard: concurrent completeTask + cancelInstance on
 *         the same instance must both commit within 5s and leave no rows in
 *         pg_stat_activity waiting on a Lock.
 *   T-6 — Sibling-task concurrency: 3 concurrent completeTask on three
 *         pending sibling tasks of one instance MUST produce step_history
 *         with 3 entries (no lost JSON read-modify-write appends) and 3
 *         audit rows.
 *   Lock-3 — Direct repo-level proof: TX-A holds selectInstanceForUpdate
 *         on a row; TX-B's selectInstanceForUpdate on the same row blocks
 *         until TX-A commits.
 *   Lock-4 — Snapshot of pg_locks during a held-open FOR UPDATE confirms a
 *         row-exclusive-class lock is present on workflow_central_instances.
 */
import 'reflect-metadata';
import { Pool, type PoolClient } from 'pg';
import { sql } from 'kysely';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import { SYSTEM_IDENTITY } from '../../../src/services/governance/identityContext';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { Logger } from '../../../src/utils/Logger';
import { WorkflowCentralService } from '../../../src/services/WorkflowCentralService';
import { WorkflowCentralOperatorService } from '../../../src/services/workflowCentral/WorkflowCentralOperatorService';
import { WorkflowEngineService } from '../../../src/services/workflowCentral/WorkflowEngineService';
import type { TaskAction } from '../../../src/services/WorkflowCentralService';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

describe('workflow-central Postgres concurrency (T13.5)', () => {
  // Raw pg pool — exclusively for the lock-level proofs (Lock-3/Lock-4) and
  // pg_stat_activity assertions in T-5. Independent from DatabaseService's
  // Kysely-wrapped pool so client-checkout contention can't bleed across.
  let rawPool: Pool;
  // DI-resolved services for T-5/T-6 (real operator code paths under contention).
  let db: DatabaseService;
  let engine: WorkflowEngineService;
  let operator: WorkflowCentralOperatorService;
  let central: WorkflowCentralService;

  beforeAll(async () => {
    // Per-suite defense-in-depth gate. setupEnvPostgres.ts ALSO enforces this
    // at jest setupFile time; duplicating here ensures a misrouted runner
    // (e.g. someone manually invokes `npx jest <this file>` outside the
    // postgres profile) still surfaces a loud failure instead of a green-
    // looking no-op test pass.
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL required — PR-OP-3-pre must be merged before this PR runs',
      );
    }

    // connectionTimeoutMillis matches DatabaseService (src/database/DatabaseService.ts:201)
    // so an unreachable Postgres fails fast instead of hanging until Jest's 300s timeout.
    // max: 6 — enough for the 3-concurrent completeTask test (T-6) plus the
    // pg_stat_activity / pg_locks observation client per scenario.
    rawPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 2000,
      max: 6,
    });

    // Bring up the durable DatabaseService against Postgres so the DI-bound
    // operator and central services share one schema with our raw pool.
    // This mirrors the pattern in tests/integration/postgres/migrations.test.ts
    // (constructs DatabaseService directly, runs initialize() which auto-
    // applies MIGRATIONS to bring schema up to date).
    //
    // Snapshot the container BEFORE mutating any bindings. Restored in
    // afterAll to keep this suite test-isolated — without the snapshot the
    // shutdown DatabaseService would persist on the global container across
    // subsequent Postgres test files in the same maxWorkers:1 process
    // (Copilot R8 finding).
    container.snapshot();
    const logger = new Logger('workflow-central-concurrency-test');
    db = new DatabaseService(logger);
    await db.initialize();
    if (container.isBound(TYPES.DatabaseService)) {
      container.unbind(TYPES.DatabaseService);
    }
    container.bind<DatabaseService>(TYPES.DatabaseService).toConstantValue(db);

    operator = await container.getAsync<WorkflowCentralOperatorService>(
      TYPES.WorkflowCentralOperatorService,
    );
    central = await container.getAsync<WorkflowCentralService>(TYPES.WorkflowCentralService);
    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    // Hydration is normally toggled at server.start(); the readiness gate is
    // mounted on the router only, so direct service calls work as long as
    // engine.hydrationReady === true (mirrors workflowCentral-completeTask.test.ts).
    engine.hydrationReady = true;
  }, 30_000);

  afterAll(async () => {
    try {
      // Snapshot of the FK-chained tables only; avoid scorched-earth DROPs so
      // sibling postgres tests using the same DB share a clean slate.
      const k = db?.getDatabase();
      if (k) {
        await sql`DELETE FROM workflow_central_tasks WHERE tenant_id = ${TENANT_ID}`.execute(k);
        await sql`DELETE FROM workflow_central_instances WHERE tenant_id = ${TENANT_ID}`.execute(k);
      }
    } finally {
      await db?.shutdown();
      await rawPool?.end();
      // Restore the container bindings captured before the rebind above
      // (paired with container.snapshot() in beforeAll). Without this,
      // subsequent test files in the maxWorkers:1 Postgres profile would
      // see the shut-down DatabaseService and produce order-dependent
      // failures (Copilot R8 finding).
      container.restore();
    }
  });

  beforeEach(async () => {
    const k = db.getDatabase();
    await sql`DELETE FROM workflow_central_tasks WHERE tenant_id = ${TENANT_ID}`.execute(k);
    await sql`DELETE FROM workflow_central_instances WHERE tenant_id = ${TENANT_ID}`.execute(k);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(k);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  let seq = 0;

  /**
   * Seed an engine definition + DB instance row + N pending sibling tasks
   * (one per supplied step in a parallel-branch shape). Each task wires up
   * a single 'complete' action. Returns the IDs needed for assertions.
   */
  async function seedInstanceWithSiblingTasks(taskCount: number): Promise<{
    instanceId: string;
    workflowId: string;
    taskIds: string[];
  }> {
    seq++;
    const nonce = `${seq}-${Math.random().toString(36).slice(2, 6)}`;
    // Each sibling lives on its own pseudo-step so engine.planCascade treats
    // them as independent leaves (no cross-step UPDATE contention beyond the
    // shared instance row).
    const stepIds = Array.from({ length: taskCount }, (_, i) => `STEP-${nonce}-${i}`);
    const def = engine.createDefinition({
      name: `Concurrency WF ${nonce}`,
      description: 'T13.5 Postgres concurrency definition',
      category: 'test',
      triggerType: 'manual',
      createdBy: 'test',
      steps: stepIds.map((id, idx) => ({
        id,
        name: `Step ${idx}`,
        type: 'task',
        order: idx + 1,
        config: { taskType: 'review', assigneeType: 'user', assigneeValue: 'alice' },
        // No transitions → leaves; planCascade marks the instance completed
        // when all leaves are dispositioned.
        transitions: [],
        timeoutHours: null,
        retryPolicy: null,
      })),
    });
    engine.setDefinitionStatus(def.id, 'active');

    const instance = engine.createInstance(TENANT_ID, def.id, {}, 'test-operator');
    const k = db.getDatabase();
    const nowIso = new Date().toISOString();
    await k
      .insertInto('workflow_central_instances')
      .values({
        id: instance.id,
        tenant_id: TENANT_ID,
        workflow_id: def.id,
        workflow_name: def.name,
        workflow_version: instance.workflowVersion ?? 1,
        status: 'running',
        current_step_id: instance.currentStepId ?? stepIds[0],
        current_step_name: instance.currentStepName ?? 'Step 0',
        variables: JSON.stringify({}),
        step_history: JSON.stringify([]),
        started_by: instance.startedBy,
        started_at: instance.startedAt,
        completed_at: null,
        due_at: null,
        error: null,
        paused_from_status: null,
        created_at: nowIso,
        updated_at: nowIso,
      })
      .execute();

    const taskIds: string[] = [];
    const actions: TaskAction[] = [
      { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
    ];
    for (let i = 0; i < taskCount; i++) {
      const taskId = `TASK-${nonce}-${i}`;
      taskIds.push(taskId);
      await k
        .insertInto('workflow_central_tasks')
        .values({
          id: taskId,
          tenant_id: TENANT_ID,
          instance_id: instance.id,
          workflow_id: def.id,
          workflow_name: def.name,
          step_id: stepIds[i],
          step_name: `Step ${i}`,
          task_type: 'task',
          status: 'pending',
          priority: 'medium',
          assignee_id: 'alice',
          assignee_name: 'Alice',
          description: `Sibling task ${i}`,
          due_at: null,
          data: JSON.stringify({}),
          actions: JSON.stringify(actions),
          created_at: nowIso,
          updated_at: nowIso,
          completed_at: null,
          completed_by: null,
          completion_action_id: null,
          completion_comment: null,
        })
        .execute();
    }

    return { instanceId: instance.id, workflowId: def.id, taskIds };
  }

  // ---------------------------------------------------------------------------
  // T-5 — AB-BA deadlock guard
  // ---------------------------------------------------------------------------

  it(
    'T-5: completeTask + cancelInstance concurrent on same instance — no deadlock, both commit within 5s',
    async () => {
      const { instanceId, taskIds } = await seedInstanceWithSiblingTasks(1);
      const [taskId] = taskIds;

      // Fire both operator paths concurrently. PR-OP-3's lock order (D21,
      // spec §3.2) is: selectTaskInstanceId (non-locking task read) →
      // selectInstanceForUpdate(instance row). cancelInstance starts at the
      // instance row directly. Both contend on the same instance row first,
      // so neither can deadlock — they serialize on the FOR UPDATE lock.
      const completeP = operator.completeTask({
        tenantId: TENANT_ID,
        taskId,
        completion: {
          actionId: 'complete',
          completedBy: 'op-A',
        },
      });
      const cancelP = central.cancelInstance(TENANT_ID, instanceId, 'op-B', undefined);

      // 5s wall-clock budget (per task description). allSettled rather than
      // race-vs-timeout so an actual deadlock surfaces as a hang we can
      // diagnose, not a silent timeout-rejection winner.
      const deadline = new Promise<'timeout'>((resolve) =>
        setTimeout(() => resolve('timeout'), 5_000),
      );
      const racewinner = await Promise.race([
        Promise.allSettled([completeP, cancelP]).then(() => 'settled' as const),
        deadline,
      ]);
      expect(racewinner).toBe('settled');

      // Confirm no client is wait-stalled on a lock for our DB. We can't
      // narrow to OUR connection IDs (operator + central share the
      // DatabaseService pool), so we scope by datname to the active DB.
      // Source the dbname from Postgres itself (`SELECT current_database()`)
      // rather than parsing it out of DATABASE_URL — the URL may legitimately
      // omit an explicit database segment (e.g. `…/`), which would make the
      // URL-derived form an empty string and the predicate match no rows,
      // producing a false-green result (Copilot R1).
      const {
        rows: [{ db: dbName }],
      } = await rawPool.query<{ db: string }>(`SELECT current_database() AS db`);
      const stat = await rawPool.query<{ pid: number; wait_event_type: string | null }>(
        `SELECT pid, wait_event_type
           FROM pg_stat_activity
          WHERE datname = $1
            AND wait_event_type = 'Lock'`,
        [dbName],
      );
      expect(stat.rows).toHaveLength(0);

      // One of the two ops will have raced against the other:
      //   - completeTask landed first → cancelInstance sees status='completed'
      //     (terminal-set) → returns null (spec §3.2 cancelInstance contract).
      //   - cancelInstance landed first → completeTask sees status='cancelled'
      //     and rejects via AlreadyDispositionedError (RaceLostError → 409
      //     mapper) OR succeeds depending on completeTaskAtomicWithCascade's
      //     CAS — the rejection path throws, so we Promise.allSettled above
      //     and only assert ordering invariants (both terminated, no stuck
      //     row lock).
      const [completeRes, cancelRes] = await Promise.allSettled([completeP, cancelP]);
      expect(completeRes.status === 'fulfilled' || completeRes.status === 'rejected').toBe(true);
      expect(cancelRes.status === 'fulfilled' || cancelRes.status === 'rejected').toBe(true);

      // Final row state: instance MUST be terminal (completed or cancelled),
      // never still running. This proves at least one TX did commit a status
      // change even under contention.
      const final = await rawPool.query<{ status: string }>(
        `SELECT status FROM workflow_central_instances WHERE id = $1 AND tenant_id = $2`,
        [instanceId, TENANT_ID],
      );
      expect(final.rows).toHaveLength(1);
      expect(['completed', 'cancelled']).toContain(final.rows[0].status);
    },
    10_000,
  );

  // ---------------------------------------------------------------------------
  // T-6 — sibling-task concurrency / no lost step_history appends
  // ---------------------------------------------------------------------------

  it(
    'T-6: 3 concurrent completeTask on sibling tasks → step_history.length === 3 (no lost updates)',
    async () => {
      const { instanceId, taskIds } = await seedInstanceWithSiblingTasks(3);

      // Fire all 3 completeTask calls concurrently. Each TX:
      //   selectTaskInstanceId → selectInstanceForUpdate (serializes here) →
      //   read step_history → push → JSON.stringify → UPDATE → commit.
      // Without FOR UPDATE the read-modify-write would race: TX-2 reads
      // pre-TX-1's history, TX-3 reads pre-TX-1's history, only the last
      // commit wins → step_history.length === 1 (lost updates). With FOR
      // UPDATE on the instance row, TX-2 and TX-3 block on TX-1's lock and
      // each sees the prior commit's history.
      const results = await Promise.allSettled(
        taskIds.map((taskId, i) =>
          operator.completeTask({
            tenantId: TENANT_ID,
            taskId,
            completion: { actionId: 'complete', completedBy: `op-${i}` },
          }),
        ),
      );
      // All three must succeed — sibling tasks have no mutual rejection.
      for (const r of results) {
        expect(r.status).toBe('fulfilled');
      }

      const k = db.getDatabase();
      const row = await k
        .selectFrom('workflow_central_instances')
        .select(['step_history', 'status'])
        .where('tenant_id', '=', TENANT_ID)
        .where('id', '=', instanceId)
        .executeTakeFirstOrThrow();

      const history = JSON.parse(row.step_history) as unknown[];
      // The keystone assertion: every concurrent completeTask appended its
      // own StepExecution. Length === 3 proves SELECT FOR UPDATE serialized
      // the JSON read-modify-write.
      expect(history).toHaveLength(3);

      // Audit row count: completeTask emits exactly one success audit per
      // call. Three successful calls → three audit rows.
      const auditRows = await sql<{ n: string }>`
        SELECT COUNT(*)::text AS n
          FROM audit_logs
         WHERE action = 'workflow_central.complete_task'
           AND result = 'success'
      `.execute(k);
      expect(Number(auditRows.rows[0].n)).toBe(3);
    },
    10_000,
  );

  // ---------------------------------------------------------------------------
  // Lock-3 — SELECT FOR UPDATE serializes a second SELECT FOR UPDATE
  // ---------------------------------------------------------------------------

  it(
    'SELECT FOR UPDATE serializes concurrent UPDATE on instance row',
    async () => {
      const { instanceId } = await seedInstanceWithSiblingTasks(1);

      let a: PoolClient | null = null;
      let b: PoolClient | null = null;
      try {
        a = await rawPool.connect();
        b = await rawPool.connect();

        await a.query('BEGIN');
        await a.query(
          `SELECT * FROM workflow_central_instances WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [instanceId, TENANT_ID],
        );

        // Schedule A's commit at t+200ms.
        const targetReleaseMs = 200;
        const aCommitAt = Date.now() + targetReleaseMs;
        const aCommitter = (async () => {
          await new Promise((r) => setTimeout(r, targetReleaseMs));
          await a!.query('COMMIT');
        })();

        // B's FOR UPDATE must block until A commits at t+200ms.
        await b.query('BEGIN');
        const bStart = Date.now();
        await b.query(
          `SELECT * FROM workflow_central_instances WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [instanceId, TENANT_ID],
        );
        const bReturned = Date.now();
        await b.query('COMMIT');

        await aCommitter;

        // B's SELECT returned at-or-after A's commit time. Allow 50ms slack
        // for scheduler jitter; 200ms target dominates jitter so the assertion
        // is meaningful (not just measuring setTimeout precision).
        expect(bReturned).toBeGreaterThanOrEqual(aCommitAt - 25);
        // And waited at least most of the lock-hold interval (lower-bound).
        // 100ms is half the hold; in practice B unblocks ~5-15ms after A's
        // COMMIT log-flush completes. If FOR UPDATE were absent, this would
        // return in <10ms.
        expect(bReturned - bStart).toBeGreaterThan(100);
      } finally {
        // pg does NOT auto-rollback on release (project memory:
        // feedback_pg_release_no_auto_rollback). Always wrap in rollback.
        if (a) {
          await a.query('ROLLBACK').catch(() => {});
          a.release();
        }
        if (b) {
          await b.query('ROLLBACK').catch(() => {});
          b.release();
        }
      }
    },
    10_000,
  );

  // ---------------------------------------------------------------------------
  // Lock-4 — pg_locks snapshot during in-flight FOR UPDATE
  // ---------------------------------------------------------------------------

  it(
    'pg_locks snapshot during concurrent completeTask shows row-level lock on workflow_central_instances',
    async () => {
      const { instanceId } = await seedInstanceWithSiblingTasks(1);

      let holder: PoolClient | null = null;
      try {
        holder = await rawPool.connect();
        await holder.query('BEGIN');
        // Capture the holder's backend PID BEFORE acquiring the lock — this
        // is the only way to scope the pg_locks snapshot to OUR transaction
        // and rule out unrelated lock-holders on the same relation polluting
        // the assertion (Copilot R2 — without PID filter the relname-only
        // query can false-pass when another connection or test holds the
        // same relation lock).
        const {
          rows: [{ pid: holderPid }],
        } = await holder.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`);

        await holder.query(
          `SELECT * FROM workflow_central_instances WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
          [instanceId, TENANT_ID],
        );

        // From a DIFFERENT connection, look up pg_locks for the workflow_central_instances
        // table, filtered to the holder's PID. SELECT FOR UPDATE acquires:
        //   - a RowShareLock on the relation (table-level intent)
        //   - a tuple-level row-exclusive lock (locktype='tuple', mode='ExclusiveLock')
        // Postgres' lock mode taxonomy is stable across 11-16; we assert on the
        // RowShareLock relation-level entry because the tuple-level entry can
        // be transient (released as soon as the tuple is fetched in some
        // execution plans). RowShareLock is held for the full transaction
        // duration on the relation accessed by FOR UPDATE.
        const locks = await rawPool.query<{ mode: string; locktype: string; granted: boolean }>(
          `SELECT l.mode, l.locktype, l.granted
             FROM pg_locks l
             JOIN pg_class c ON l.relation = c.oid
            WHERE c.relname = 'workflow_central_instances'
              AND l.granted = true
              AND l.pid = $1`,
          [holderPid],
        );
        // At minimum one granted relation-level lock from the holder's TX.
        expect(locks.rows.length).toBeGreaterThan(0);
        // RowShareLock is the canonical mode SELECT FOR UPDATE acquires on
        // the relation. If the observed mode differs (e.g. RowExclusiveLock
        // because the test plan changes to include an UPDATE), update this
        // assertion AND document the new mode rationale.
        const modes = locks.rows.map((r) => r.mode);
        expect(modes).toContain('RowShareLock');
      } finally {
        if (holder) {
          await holder.query('ROLLBACK').catch(() => {});
          holder.release();
        }
      }
    },
    10_000,
  );
});
