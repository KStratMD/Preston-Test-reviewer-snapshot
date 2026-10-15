import { container } from '../../inversify/inversify.config';
import { TYPES } from '../../inversify/types';
import { env } from '../../config';
import { CENTRAL_DEMO_TENANT_ID, shouldSeedDemoData } from './demoTenant';
import type { Logger } from '../../utils/Logger';

/**
 * Boot-time demo seeding for the durable `*-central` fixtures.
 *
 * Extracted verbatim from Server.start() (src/index.ts) in PR-F5b-3 so the
 * behavior is reachable from a test: jest suites deliberately never import
 * src/index.ts (module-level side effects — f5MountComposition.test.ts asserts
 * its source as text for the same reason), and the seeding step is the thing
 * the hosted-demo content proof has to exercise.
 *
 * Fixtures are written under CENTRAL_DEMO_TENANT_ID, which is where
 * resolveCentralTenantId sends gate-attested anonymous demo reads. Migrations
 * (including 061, which deletes the legacy system-tenant copies) have already
 * run by the time this is called.
 *
 * Gating is the shared shouldSeedDemoData predicate, so a HOSTED_DEMO=1
 * deployment seeds while ordinary production and jest never do. The early
 * return also avoids paying the DI resolution + dynamic-import cost when the
 * answer is no (Copilot R6 on the original block).
 *
 * Failure posture is unchanged: seeding is best-effort. A failure leaves the
 * dashboards empty rather than breaking startup.
 */
export async function seedCentralDemoFixturesAtBoot(logger: Logger): Promise<void> {
  if (!shouldSeedDemoData(process.env.NODE_ENV, env.HOSTED_DEMO)) return;

  // PR 6 (operator-promotion): seed FinanceCentral demo approvals into the
  // finance_central_approvals table for the dashboard read path. The seed
  // function self-gates too, and is idempotent (ON CONFLICT DO NOTHING).
  try {
    const { seedFinanceCentralDemoData } = await import('../financeCentral/demoSeed');
    const { FinanceCentralRepository } = await import('../financeCentral/FinanceCentralRepository');
    const repo = await container.getAsync<InstanceType<typeof FinanceCentralRepository>>(
      TYPES.FinanceCentralRepository,
    );
    await seedFinanceCentralDemoData(repo, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
  } catch (error) {
    logger.warn(
      'Failed to seed FinanceCentral demo data; dashboard pending-approvals list will be empty.',
      { error: (error as Error).message },
    );
  }

  // PR-OP-2 / T11 + T12: seed WorkflowCentral demo data.
  // seedWorkflowCentralDemoData seeds in-memory definitions via
  // engine.seedDemoDefinitions() AND inserts instance rows durably via
  // repo.insertInstanceIfMissing inside a TX (so instances survive hydration).
  // seedWorkflowCentralDemoTasks seeds the tasks the dashboard reads from
  // workflow_central_tasks. Both use real ON CONFLICT DO NOTHING upserts, so a
  // re-seed is a no-op even on Postgres (F5b-3 blocker 2).
  try {
    const { WorkflowEngineService } = await import('../workflowCentral/WorkflowEngineService');
    const { seedWorkflowCentralDemoData, seedWorkflowCentralDemoTasks } = await import(
      '../workflowCentral/demoSeed'
    );
    const { WorkflowCentralRepository } = await import(
      '../workflowCentral/WorkflowCentralRepository'
    );
    const { DatabaseService } = await import('../../database/DatabaseService');
    const engine = container.get<InstanceType<typeof WorkflowEngineService>>(
      TYPES.WorkflowEngineService,
    );
    const wcRepo = await container.getAsync<InstanceType<typeof WorkflowCentralRepository>>(
      TYPES.WorkflowCentralRepository,
    );
    const dbService = await container.getAsync<InstanceType<typeof DatabaseService>>(
      TYPES.DatabaseService,
    );
    await seedWorkflowCentralDemoData(engine, wcRepo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
    await seedWorkflowCentralDemoTasks(wcRepo, dbService, {
      tenantId: CENTRAL_DEMO_TENANT_ID,
      logger,
    });
  } catch (error) {
    logger.warn('Failed to seed WorkflowCentral demo data; dashboard task list may be empty.', {
      error: (error as Error).message,
    });
  }
}
