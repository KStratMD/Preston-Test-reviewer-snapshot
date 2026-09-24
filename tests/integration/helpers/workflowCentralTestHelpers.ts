/**
 * Shared workflow-central integration-test helpers (T17-follow-up R3).
 *
 * Extracted from per-file duplicates in
 * `workflowCentral-render-real-resolver.test.ts` and
 * `workflowCentral-render-netsuite.live.test.ts` per a Copilot finding
 * that hard-coding the DI rebind list in two places risks drift when
 * production wiring changes.
 *
 * Why the rebind exists at all (the underlying repo-wide gap):
 *
 *   `tests/integration/helpers/syncErrorAssistTestHelpers.ts:42` exposes
 *   `setupTestDatabase` which rebinds ONLY `TYPES.DatabaseService`.
 *   `AuditLogRepository`, `WorkflowCentralRepository`,
 *   `WorkflowCentralOperatorService`, and `TenantConfigurationRepository`
 *   are `inSingletonScope()` and capture `DatabaseService` at first
 *   resolution (per `src/inversify/inversify.config.ts:1192-1322` and
 *   `src/inversify/auth-bindings.ts:30-34`). Under
 *   `jest.slow.config.cjs:18` (`maxWorkers: 1`), all integration files run
 *   sequentially in ONE worker process with a shared module graph and a
 *   shared DI container. After a prior file calls `teardownTestDatabase`,
 *   the cached operator/repo/audit singletons still hold a reference to
 *   the now-shutdown DB — the NEXT file's first route call would hit a
 *   dead handle.
 *
 *   Test files using the workflow-central operator route stack call this
 *   helper after `setupTestDatabase` to force re-resolution against the
 *   fresh in-memory DB. The principled fix is to export binding factories
 *   from `inversify.config.ts` (or have `setupTestDatabase` itself walk
 *   and refresh DB-dependent singletons); both are out of scope for the
 *   T17-follow-up PR. Tracked in the PR body trade-offs section.
 *
 * Caller contract: pair this with `container.snapshot()` BEFORE the call
 * and `container.restore()` in `afterAll` so the mutations are strictly
 * test-scoped and do not leak into subsequent files. Pattern source:
 * `tests/integration/helpers/syncErrorAssistTestHelpers.ts:275-279`.
 */
import 'reflect-metadata';
import { container } from '../../../src/inversify/inversify.config';
import { TYPES } from '../../../src/inversify/types';
import type { SecretManager } from '../../../src/services/SecretManager';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { Logger } from '../../../src/utils/Logger';
import { AuditLogRepository } from '../../../src/database/repositories/AuditLogRepository';
import { TenantConfigurationRepository } from '../../../src/database/repositories/TenantConfigurationRepository';
import { WorkflowCentralRepository } from '../../../src/services/workflowCentral/WorkflowCentralRepository';
import { WorkflowCentralOperatorService } from '../../../src/services/workflowCentral/WorkflowCentralOperatorService';
import { WorkflowEngineService } from '../../../src/services/workflowCentral/WorkflowEngineService';
import { WorkflowPayloadResolver } from '../../../src/services/workflowCentral/payload/WorkflowPayloadResolver';

/**
 * Unbind + rebind the three workflow-central DI singletons that depend on
 * `DatabaseService`, so they pick up whatever `DatabaseService` the
 * container currently holds (typically a fresh in-memory DB from a just-
 * called `setupTestDatabase`).
 *
 * Mirrors the binding spec at `src/inversify/inversify.config.ts:1296-1322`
 * and `src/inversify/auth-bindings.ts:30-34`. Duplication is intentional
 * and bounded to test scope — see file header for the principled fix path.
 */
export async function rebindWorkflowCentralStackForFreshDb(): Promise<void> {
  const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
  const logger = container.get<Logger>(TYPES.Logger);

  if (container.isBound(TYPES.AuditLogRepository)) {
    container.unbind(TYPES.AuditLogRepository);
  }
  container.bind<AuditLogRepository>(TYPES.AuditLogRepository)
    .toConstantValue(new AuditLogRepository(dbService));

  if (container.isBound(TYPES.WorkflowCentralRepository)) {
    container.unbind(TYPES.WorkflowCentralRepository);
  }
  container.bind<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository)
    .toConstantValue(new WorkflowCentralRepository(dbService, logger));

  // TenantConfigurationRepository captures DatabaseService at construction
  // (inSingletonScope), same gap as the others — rebind against the fresh DB.
  // Pull the SecretManager from the container; it has no DB dep so the cached
  // singleton is safe to reuse across files.
  if (container.isBound(TYPES.TenantConfigurationRepository)) {
    container.unbind(TYPES.TenantConfigurationRepository);
  }
  const secretManager = await container.getAsync<SecretManager>(TYPES.SecretManager);
  container.bind<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository)
    .toConstantValue(new TenantConfigurationRepository(dbService, secretManager, logger));

  if (container.isBound(TYPES.WorkflowCentralOperatorService)) {
    container.unbind(TYPES.WorkflowCentralOperatorService);
  }
  const engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
  const auditLog = container.get<AuditLogRepository>(TYPES.AuditLogRepository);
  const resolver = container.get<WorkflowPayloadResolver>(TYPES.WorkflowPayloadResolver);
  const repo = await container.getAsync<WorkflowCentralRepository>(TYPES.WorkflowCentralRepository);
  const tenantConfig = container.get<TenantConfigurationRepository>(TYPES.TenantConfigurationRepository);
  container.bind<WorkflowCentralOperatorService>(TYPES.WorkflowCentralOperatorService)
    .toConstantValue(new WorkflowCentralOperatorService(logger, engine, repo, auditLog, dbService, resolver, tenantConfig));
}
