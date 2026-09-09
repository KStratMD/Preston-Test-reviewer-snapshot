/**
 * WorkflowCentral render route — live NetSuite integration (T17-follow-up).
 *
 * Single end-to-end test exercising route → operator → real
 * WorkflowPayloadResolver → real DLPService → real WorkflowPayloadCache →
 * real NetSuiteConnector → live NetSuite sandbox.
 *
 * The seam is `ConnectorManager.prototype.getConnector` (spy returning a
 * pre-initialized NetSuiteConnector instance), NOT `container.rebind` — the
 * resolver/operator are inSingletonScope and captured the original
 * ConnectorManager reference at instantiation, so a rebind would not
 * propagate to them. The prototype spy reaches them via the prototype chain
 * without container surgery.
 *
 * The spy preserves the resolver-down stack but bypasses
 * `ConnectorManager.getConnectorRegistration` → factory pathway. That
 * instantiation contract is covered by the connector-registry and
 * ConnectorManager unit suites under the unit-tests directory.
 *
 * Required env vars (skip cleanly when absent):
 *   - NETSUITE_LIVE_TESTS=1
 *   - NETSUITE_ACCOUNT_ID
 *   - NETSUITE_CONSUMER_KEY
 *   - NETSUITE_CONSUMER_SECRET
 *   - NETSUITE_TOKEN_ID
 *   - NETSUITE_TOKEN_SECRET
 *   - NETSUITE_LIVE_RENDER_RECORD_ID  (no default — there is no universal
 *     sandbox record id; supply a known-good id from your sandbox)
 *   - NETSUITE_LIVE_RENDER_RECORD_TYPE  (default 'customer')
 */
import './setupEnv';
import 'reflect-metadata';
import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';
import { sql } from 'kysely';
import { workflowCentralRouter } from '../../src/routes/workflowCentral';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { setupTestDatabase, teardownTestDatabase } from './helpers/syncErrorAssistTestHelpers';
import { rebindWorkflowCentralStackForFreshDb } from './helpers/workflowCentralTestHelpers';
import { WorkflowEngineService } from '../../src/services/workflowCentral/WorkflowEngineService';
import { WorkflowPayloadCache } from '../../src/services/workflowCentral/payload/WorkflowPayloadCache';
import { ConnectorManager } from '../../src/services/integration/ConnectorManager';
import { NetSuiteConnector } from '../../src/connectors/NetSuiteConnector';
import { createMockOutboundGovernanceService } from '../governanceTestUtils';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { AuthService } from '../../src/services/AuthService';
import { Logger } from '../../src/utils/Logger';

const REQUIRED_ENV = [
  'NETSUITE_ACCOUNT_ID',
  'NETSUITE_CONSUMER_KEY',
  'NETSUITE_CONSUMER_SECRET',
  'NETSUITE_TOKEN_ID',
  'NETSUITE_TOKEN_SECRET',
  'NETSUITE_LIVE_RENDER_RECORD_ID',
] as const;

const missingEnv = REQUIRED_ENV.filter((n) => {
  const v = process.env[n];
  return v === undefined || v === '';
});

if (process.env.NETSUITE_LIVE_TESTS === '1' && missingEnv.length > 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `Skipping workflow-central live render test. Missing env vars: ${missingEnv.join(', ')}`,
  );
}

const shouldRunLive = process.env.NETSUITE_LIVE_TESTS === '1' && missingEnv.length === 0;
const describeLive = shouldRunLive ? describe : describe.skip;

const SYSTEM_TENANT = SYSTEM_IDENTITY.tenantId;


describeLive('workflow-central render route — live NetSuite (T17-follow-up)', () => {
  jest.setTimeout(60_000);

  let app: express.Express;
  let engine: WorkflowEngineService;
  let cache: WorkflowPayloadCache;
  let liveConnector: NetSuiteConnector;

  const accountId = process.env.NETSUITE_ACCOUNT_ID as string;
  const consumerKey = process.env.NETSUITE_CONSUMER_KEY as string;
  const consumerSecret = process.env.NETSUITE_CONSUMER_SECRET as string;
  const tokenId = process.env.NETSUITE_TOKEN_ID as string;
  const tokenSecret = process.env.NETSUITE_TOKEN_SECRET as string;
  const baseUrl = process.env.NETSUITE_BASE_URL ?? `https://${accountId}.suitetalk.api.netsuite.com`;
  const recordType = process.env.NETSUITE_LIVE_RENDER_RECORD_TYPE ?? 'customer';
  const recordId = process.env.NETSUITE_LIVE_RENDER_RECORD_ID as string;

  beforeAll(async () => {
    // R2 (Copilot): wrap test-scoped binding mutations in container.snapshot()
    // / container.restore() so the rebind helper does not leak permanent state
    // into subsequent integration files in the same Jest worker. Canonical
    // pattern per tests/integration/helpers/syncErrorAssistTestHelpers.ts:275-279.
    container.snapshot();
    await setupTestDatabase();
    await rebindWorkflowCentralStackForFreshDb();

    app = express();
    app.use(express.json());
    // Same auth shim shape as the offline file; live test only renders under
    // SYSTEM_TENANT so the shim falls through to SYSTEM_IDENTITY.
    app.use((req: Request, _res: Response, next: NextFunction) => {
      const t = req.headers['x-test-tenant-id'];
      if (typeof t === 'string' && t.length > 0) {
        (req as Request & { user?: { tenantId: string; id: string } }).user = {
          tenantId: t,
          id: 'test-user',
        };
      }
      next();
    });
    app.use('/api/workflow-central', workflowCentralRouter);

    engine = container.get<WorkflowEngineService>(TYPES.WorkflowEngineService);
    engine.hydrationReady = true;

    cache = container.get<WorkflowPayloadCache>(TYPES.WorkflowPayloadCache);
    // Drop any cache entries inherited from prior files in this Jest worker
    // (maxWorkers: 1 + singleton-scoped cache = cross-file persistence). A
    // leftover entry for the sandbox record would mask the real connector call.
    cache.invalidate(SYSTEM_TENANT);

    // Build a real NetSuiteConnector once and reuse via the prototype spy.
    // Mirrors tests/integration/netsuite.connector.live.test.ts:38-70.
    const baseLogger = {
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      child() {
        return this as unknown as Logger;
      },
    } as unknown as Logger;
    const authService = {
      authenticateOAuth1: async (authCredentials: { credentials: unknown }) => authCredentials.credentials,
    } as unknown as AuthService;

    liveConnector = new NetSuiteConnector(
      'live-render',
      baseLogger,
      authService,
      createMockOutboundGovernanceService(),
    );
    await liveConnector.initialize({
      type: 'oauth1',
      credentials: {
        accountId,
        consumerKey,
        consumerSecret,
        tokenId,
        tokenSecret,
        baseUrl,
      },
    });
    liveConnector.maxRetries = 2;
    await liveConnector.authenticate();

    jest
      .spyOn(ConnectorManager.prototype, 'getConnector')
      .mockImplementation(async (systemType: string) => {
        if (systemType === 'netsuite') {
          return liveConnector as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>;
        }
        throw new Error(
          `workflow-central live render test: unexpected systemType ${systemType}; only 'netsuite' is wired`,
        );
      });
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    cache.invalidate(SYSTEM_TENANT);
    await teardownTestDatabase();
    // Revert all binding mutations from this file's beforeAll. Pairs with the
    // container.snapshot() above. Without restore(), the prototype spy is gone
    // (jest.restoreAllMocks) but the rebound singleton bindings would persist
    // into the next file in the worker.
    container.restore();
  });

  beforeEach(async () => {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    cache.invalidate(SYSTEM_TENANT);
  });

  it('renders an external_reference payload pointing at the live sandbox record → 200 resolved with real fields', async () => {
    const now = new Date().toISOString();
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: 'TASK-live-render-1',
        tenant_id: SYSTEM_TENANT,
        instance_id: 'INST-live-1',
        workflow_id: 'WF-live-1',
        workflow_name: 'Live render WF',
        step_id: 'STEP-A',
        step_name: 'Step A',
        task_type: 'task',
        status: 'pending',
        priority: 'medium',
        assignee_id: 'alice',
        assignee_name: 'Alice',
        description: 'live render test',
        due_at: null,
        data: JSON.stringify({}),
        actions: JSON.stringify([
          { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
        ]),
        created_at: now,
        updated_at: now,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
        payload: JSON.stringify({
          mode: 'external_reference',
          references: [
            // No fieldsOfInterest — let everything flow through.
            //
            // Codex F2: NetSuiteConnector.formatDataFromNetSuite (NetSuiteConnector.ts:419-449)
            // returns `{ id, externalId, fields: { name?, email?, phone? }, metadata }`.
            // Business fields live under a NESTED `fields` key (and the NetSuite
            // `companyname` is mapped to `name`, not `companyName`). The resolver's
            // `pickFields` only picks TOP-LEVEL keys (WorkflowPayloadResolver.ts:74-76),
            // so `fieldsOfInterest: ['id', 'companyName']` would silently project
            // only `{ id }` and the test would pass without ever validating
            // business-field projection — exactly the gap Codex flagged.
            //
            // Dropping fieldsOfInterest lets the wrapped `fields` object surface
            // so we can assert it's a populated object (real business data was
            // returned by the connector), not just an empty shell.
            {
              system: 'netsuite',
              recordType,
              recordId,
            },
          ],
        }),
      })
      .execute();

    const res = await request(app).get('/api/workflow-central/tasks/TASK-live-render-1/render');

    expect(res.status).toBe(200);
    expect(res.body.kind).toBe('resolved');
    expect(res.body.resolution).toHaveLength(1);
    expect(res.body.resolution[0].status).toBe('resolved');
    expect(res.body.resolution[0].ref.system).toBe('netsuite');
    const projected = res.body.resolution[0].fields;
    expect(projected).toBeDefined();
    // Round-trip identity: NetSuite returns the requested record's internalid as
    // top-level `id` (NetSuiteConnector.ts:440).
    expect(projected.id).toBe(recordId);
    // Business-field presence: NetSuiteConnector wraps mapped business fields
    // under a nested `fields` key (NetSuiteConnector.ts:435-442). Asserting that
    // this object exists AND has at least one key proves the live connector
    // returned actual business data, not just an empty record shell. Specific
    // key contents are sandbox-dependent so we don't pin them.
    expect(typeof projected.fields).toBe('object');
    expect(projected.fields).not.toBeNull();
    expect(Object.keys(projected.fields as Record<string, unknown>).length).toBeGreaterThan(0);
  });
});
