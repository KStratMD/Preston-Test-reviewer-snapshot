/**
 * PR-F5b-3: hosted-demo boot seeding serves DEMO-TENANT content anonymously.
 *
 * This is the content proof F5b-2 deferred. The sibling suites prove the gate
 * COMPOSITION (who is admitted); this one proves the data half end to end:
 * boot seeding writes CENTRAL_DEMO_TENANT_ID, and an allowlisted anonymous
 * demo read returns those fixtures — the whole point of opening seeding to the
 * hosted demo runtime.
 *
 * Why the seam and not a Server boot: seeding lives in Server.start()
 * (src/index.ts), and jest suites deliberately never import that module
 * (port listeners, cron jobs, module-level side effects — f5MountComposition
 * asserts its source as TEXT for the same reason). F5b-3 extracted the block
 * into seedCentralDemoFixturesAtBoot precisely so it can be called here; the
 * last case pins that Server.start() still calls it, so the extraction cannot
 * silently drift away from production.
 *
 * Why NODE_ENV=development and not production: a real production in-process
 * boot demands real prod secrets (src/config/env.ts guards). The production
 * arm of the gate is proven as a pure function in
 * tests/unit/services/governance/demoTenant.test.ts
 * (shouldSeedDemoData('production', true) === true). What needs a booted app is
 * the rest of the chain — predicate-open seeding populates the demo tenant, and
 * anonymous allowlisted dashboards serve it — which this suite covers.
 */

// Hermetic env, BEFORE any src/ import. The project emits CommonJS, so each
// `require` stays at its source position and these assignments run before
// src/config/env is evaluated — which matters because HOSTED_DEMO is in the zod
// schema and is snapshotted into `env` at module evaluation. Values are PINNED
// rather than deleted: src/config/env.ts calls dotenv.config(), which populates
// absent keys from a developer's gitignored .env.
const ORIGINAL_ENV = {
  NODE_ENV: process.env.NODE_ENV,
  HOSTED_DEMO: process.env.HOSTED_DEMO,
  DEMO_MODE: process.env.DEMO_MODE,
  DB_TYPE: process.env.DB_TYPE,
  SQLITE_DB_PATH: process.env.SQLITE_DB_PATH,
};
// 'development' opens shouldSeedDemoData (jest's default 'test' never seeds, by
// design — fixed-id rows would race with per-test DB resets).
process.env.NODE_ENV = 'development';
// The hosted-demo deployment flag: activates the demo runtime for the gate AND
// is the production-arm input of the seed predicate.
process.env.HOSTED_DEMO = '1';
process.env.DEMO_MODE = '1';
// In-memory SQLite so the suite can never touch the repo's dev database. This
// matches tests/integration/setupEnv.ts; pinned explicitly here because
// deleting the keys is NOT hermetic (dotenv would refill them).
process.env.DB_TYPE = 'sqlite';
process.env.SQLITE_DB_PATH = ':memory:';

function restoreEnv(): void {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

// eslint-disable-next-line import/first
import fs from 'fs';
// eslint-disable-next-line import/first
import path from 'path';
// eslint-disable-next-line import/first
import request from 'supertest';
// eslint-disable-next-line import/first
import { App } from '../../src/app';
// eslint-disable-next-line import/first
import { container } from '../../src/inversify/inversify.config';
// eslint-disable-next-line import/first
import { TYPES } from '../../src/inversify/types';
// eslint-disable-next-line import/first
import type { DatabaseService } from '../../src/database/DatabaseService';
// eslint-disable-next-line import/first
import type { Logger } from '../../src/utils/Logger';
// eslint-disable-next-line import/first
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
// eslint-disable-next-line import/first
import { seedCentralDemoFixturesAtBoot } from '../../src/services/governance/demoSeedBoot';
// eslint-disable-next-line import/first
import { CENTRAL_DEMO_TENANT_ID } from '../../src/services/governance/demoTenant';
// eslint-disable-next-line import/first
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';

const DEMO_INSTANCE_IDS = ['INST-1000', 'INST-1001', 'INST-1002'];
/** appr-001's documentNumber — a fixture string that exists nowhere else. */
const SEEDED_APPROVAL_DOCUMENT = 'INV-2024-4521';

describe('hosted demo seeding — boot-path seeding serves demo-tenant content anonymously', () => {
  let appInstance: App;
  let server: ReturnType<App['getExpressApp']>;
  let db: Awaited<ReturnType<DatabaseService['getDatabase']>>;
  let logger: Logger;

  beforeAll(async () => {
    appInstance = new App({ lightweight: true });
    await appInstance.waitForInitialization();
    server = appInstance.getExpressApp();

    // Migrations (including 061) have run by the time DatabaseService resolves.
    const dbService = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
    db = dbService.getDatabase();
    logger = container.get<Logger>(TYPES.Logger);

    await seedCentralDemoFixturesAtBoot(logger);

    // Server.start() hydrates the engine after seeding; the dashboard's
    // readiness gate needs that flag (mirrors workflowCentral-activityLogs).
    container.get<WorkflowEngineService>(TYPES.WorkflowEngineService).hydrationReady = true;
  }, 60_000);

  afterAll(async () => {
    await appInstance.shutdown();
    restoreEnv();
  });

  it('boot seeded the demo tenant (not the system tenant)', async () => {
    const instances = await db
      .selectFrom('workflow_central_instances')
      .select(['id', 'tenant_id'])
      .where('id', 'in', DEMO_INSTANCE_IDS)
      .execute();
    expect(instances).toHaveLength(3);
    for (const row of instances) expect(row.tenant_id).toBe(CENTRAL_DEMO_TENANT_ID);

    const approvals = await db
      .selectFrom('finance_central_approvals')
      .select(['tenant_id'])
      .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
      .execute();
    expect(approvals.length).toBeGreaterThanOrEqual(12);

    // The other half of the claim: nothing landed on the system tenant.
    const systemRows = await db
      .selectFrom('finance_central_approvals')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('tenant_id', '=', SYSTEM_IDENTITY.tenantId)
      .executeTakeFirstOrThrow();
    expect(Number(systemRows.n)).toBe(0);
  });

  it('anonymous GET /api/finance-central/dashboard is 200 in the demo runtime WITH seeded content', async () => {
    const res = await request(server).get('/api/finance-central/dashboard');
    expect(res.status).toBe(200);
    expect(res.body.summary.pendingApprovals).toBeGreaterThanOrEqual(12);
    expect(JSON.stringify(res.body)).toContain(SEEDED_APPROVAL_DOCUMENT);
  });

  it('anonymous GET /api/workflow-central/dashboard is 200 in the demo runtime WITH seeded content', async () => {
    const res = await request(server).get('/api/workflow-central/dashboard');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('INST-1000');
  });

  it('a second boot-seed pass is a no-op (idempotent boot)', async () => {
    const counts = async () => ({
      instances: Number(
        (
          await db
            .selectFrom('workflow_central_instances')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
            .executeTakeFirstOrThrow()
        ).n,
      ),
      tasks: Number(
        (
          await db
            .selectFrom('workflow_central_tasks')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
            .executeTakeFirstOrThrow()
        ).n,
      ),
      approvals: Number(
        (
          await db
            .selectFrom('finance_central_approvals')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('tenant_id', '=', CENTRAL_DEMO_TENANT_ID)
            .executeTakeFirstOrThrow()
        ).n,
      ),
    });

    const before = await counts();
    expect(before).toEqual({ instances: 3, tasks: 3, approvals: 12 });
    await seedCentralDemoFixturesAtBoot(logger);
    expect(await counts()).toEqual(before);
  });

  it('Server.start() AWAITS seedCentralDemoFixturesAtBoot (boot wiring pinned without importing index.ts)', () => {
    // Source assertion — the same pattern f5MountComposition.test.ts uses for
    // index.ts wiring it cannot import (module-level side effects). Without it,
    // the extracted seam could keep passing here while production stopped
    // calling it.
    //
    // Comments are STRIPPED before matching, and the pattern is the awaited
    // CALL rather than the bare name: a plain `toContain(name)` check would be
    // satisfied by a comment that merely mentions the function — including the
    // explanatory comment sitting next to this very call site (Codex review).
    const raw = fs.readFileSync(path.join(__dirname, '../../src/index.ts'), 'utf8');
    const code = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).toMatch(/await\s+seedCentralDemoFixturesAtBoot\s*\(/);
  });
});
