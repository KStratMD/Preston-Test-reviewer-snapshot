/**
 * WorkflowCentral hydration scale test (T-24, env-gated).
 *
 * Long-running scale-bench (NOT a merge gate, per spec §7.3). Seeds 100,000
 * active instance rows, then exercises `engine.hydrate(repo)` and asserts:
 *   - hydrationReady flips to true
 *   - getCacheSize() === 100_000 (all rows enter the cache; none aged out)
 *   - RSS delta < 1 GB (the §6.2 OOM-resilience budget, default 1GB)
 *   - elapsed hydrate time < 600s (pathological-regression guard; spec does
 *     not pin a specific elapsed-time budget for the 100k case beyond the 1 GB
 *     RSS delta — see Time-budget note in the test body for derivation).
 *
 * Skipped by default. Enable with WORKFLOW_CENTRAL_RUN_SCALE_TEST=1.
 *
 * Jest config: jest.slow.config.cjs (NOT jest.ci.config.cjs).
 *
 * Note: the spec wording (§7.3 line 1071) references the env flag as
 * `WORKFLOW_HYDRATION_SCALE_TEST`; the follow-up PR task brief pins
 * `WORKFLOW_CENTRAL_RUN_SCALE_TEST`. We honour the task-brief name here; the
 * spec text will be reconciled in T14-followup.
 */

import 'reflect-metadata';
import { sql } from 'kysely';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
import { WorkflowCentralRepository } from '../../src/services/workflowCentral/WorkflowCentralRepository';
import type { DatabaseService } from '../../src/database/DatabaseService';

const TENANT_ID = SYSTEM_IDENTITY.tenantId; // '__system__'

const RUN_SCALE_TEST = process.env.WORKFLOW_CENTRAL_RUN_SCALE_TEST === '1';

// ---------------------------------------------------------------------------
// Helpers (mirror restart-recovery suite)
// ---------------------------------------------------------------------------

function getEngine(): WorkflowEngineService {
  return container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
}

async function getRepo(): Promise<WorkflowCentralRepository> {
  return container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
}

async function getDbService(): Promise<DatabaseService> {
  return container.getAsync<DatabaseService>(TYPES.DatabaseService);
}

// ---------------------------------------------------------------------------
// Suite (env-gated: describe.skip unless WORKFLOW_CENTRAL_RUN_SCALE_TEST=1)
// ---------------------------------------------------------------------------

(RUN_SCALE_TEST ? describe : describe.skip)(
  'workflow-central hydration scale (T-24, env-gated)',
  () => {
    let engine: WorkflowEngineService;

    beforeAll(async () => {
      await setupTestDatabase();
      engine = getEngine();
      // Engine starts with hydrationReady=false; let the test exercise hydrate().
      engine.hydrationReady = false;
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
      engine = getEngine();
      engine.hydrationReady = false;
    });

    // Generous per-test timeout: seeding 100k rows in 1000-row batched TXs on
    // SQLite takes ~3-5 minutes on commodity dev hardware; the hydrate() call
    // itself adds another 3-6 minutes due to per-row Kysely deserialization.
    // Postgres in a production-shaped CI lane is materially faster — this test
    // is a nightly bench, not a per-PR gate. 15-minute ceiling is the cap.
    jest.setTimeout(900_000);

    it(
      'T-24 hydration scale: 100k active rows → getCacheSize()===100_000, RSS delta < 1 GB, hydrate < 600s',
      async () => {
        const dbService = await getDbService();
        const repo = await getRepo();

        const BATCH_SIZE = 1000;
        const TOTAL = 100_000;
        const startTime = new Date().toISOString();

        let instanceSeq = 0;
        for (let batch = 0; batch < TOTAL / BATCH_SIZE; batch++) {
          await dbService.transaction(async (tx) => {
            for (let i = 0; i < BATCH_SIZE; i++) {
              instanceSeq++;
              await repo.insertInstance(tx, {
                id: `INST-scale-${instanceSeq}`,
                tenantId: TENANT_ID,
                workflowId: `WF-scale-${instanceSeq}`,
                workflowName: `Scale WF ${instanceSeq}`,
                workflowVersion: 1,
                status: 'running',
                currentStepId: 'STEP-A',
                currentStepName: 'Step A',
                variables: {},
                stepHistory: [],
                startedBy: 'scale-seed',
                startedAt: startTime,
                completedAt: null,
                dueAt: null,
                error: null,
                pausedFromStatus: null,
              });
            }
          });
        }

        // Force a GC pass before sampling RSS, if --expose-gc is available.
        // Without --expose-gc this is a no-op; the assertion is generous enough
        // (1 GB headroom) that the residual fragmentation is well within budget.
        if (typeof global.gc === 'function') {
          global.gc();
        }

        const rssBefore = process.memoryUsage().rss;
        const tStart = Date.now();
        await engine.hydrate(repo);
        const elapsed = Date.now() - tStart;
        const rssAfter = process.memoryUsage().rss;

        // Core hydrate contract.
        expect(engine.hydrationReady).toBe(true);
        expect(engine.getCacheSize()).toBe(TOTAL);

        // Memory budget — spec §6.2 / §7.3: default 1 GB RSS delta.
        expect(rssAfter - rssBefore).toBeLessThan(1024 * 1024 * 1024);

        // Time budget — the spec pins the memory budget but does NOT pin a
        // specific elapsed-time target for 100k rows (the 500ms T-11 figure
        // is for 1050 rows). Measured baseline on SQLite + Kysely + WSL2 is
        // ~5-6min for hydrate alone, driven by per-row deserialization in the
        // ORM layer; Postgres in the nightly scale-lane is materially faster.
        // 600s = 10min is a non-pathological ceiling — it catches infinite-loop
        // regressions and order-of-magnitude slowdowns without churning on the
        // ORM-bound SQLite baseline. Tighten when the lane runs on Postgres.
        expect(elapsed).toBeLessThan(600_000);
      },
      900_000,
    );
  },
);
