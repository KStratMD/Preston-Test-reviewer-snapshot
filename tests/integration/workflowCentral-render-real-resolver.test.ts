/**
 * WorkflowCentral render route — real-resolver integration tests (T17-follow-up).
 *
 * T17 (PR #813) spied at `WorkflowPayloadResolver.prototype.resolve`, so every
 * response shape was asserted but the resolver's behavior (DLP scanning, per-ref
 * outcome translation, cross-system fan-out, cache coalescing) was NOT exercised
 * end-to-end through the route.
 *
 * This file moves the spy boundary ONE LAYER LOWER — to
 * `ConnectorManager.prototype.getConnector`. The real WorkflowPayloadResolver,
 * real DLPService, real WorkflowPayloadCache, and real route handler all run.
 *
 *   HTTP → router → operator.getTaskForOperator
 *                      ↓
 *                   WorkflowPayloadResolver.resolveOne (REAL)
 *                      ↓
 *               ┌──────┴──────────────────────────┐
 *               ↓                                 ↓
 *        WorkflowPayloadCache (REAL)      ConnectorManager.getConnector (SPIED)
 *               ↑                                 ↓
 *               └─── set on success ────  DLPService.scanForPII (REAL, autoRedact:true)
 *
 * Cross-file note: jest.slow.config.cjs sets maxWorkers: 1, so ALL integration
 * files run sequentially in ONE worker process with a shared module graph and a
 * shared DI container. WorkflowPayloadCache is `inSingletonScope()` —
 * `beforeAll` AND `afterEach` invalidate the cache to keep inherited state from
 * polluting cache-coalescing assertions.
 */
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
import { DLPService } from '../../src/services/security/DLPService';
import type { DatabaseService } from '../../src/database/DatabaseService';
import type { WorkflowPayload } from '../../src/services/workflowCentral/payload/WorkflowPayload';
import type { IConnector } from '../../src/interfaces/IConnector';
import type { DataRecord } from '../../src/types';
import type { PIIDetectionResult } from '../../src/services/security/DLPService';

const SYSTEM_TENANT = SYSTEM_IDENTITY.tenantId; // '__system__'
const OTHER_TENANT = 'tenant-other';
const FLAG = 'WORKFLOW_ALLOW_EPHEMERAL_PAYLOAD';


describe('workflow-central render route — real-resolver integration (T17-follow-up)', () => {
  let app: express.Express;
  let engine: WorkflowEngineService;
  let cache: WorkflowPayloadCache;
  let originalFlag: string | undefined;

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
    // Same auth shim as workflowCentral-render.test.ts — populates req.user when
    // X-Test-Tenant-Id is supplied so cross-tenant cache-isolation tests can
    // drive the tenant boundary. Absence falls through to SYSTEM_IDENTITY.
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
    // Clear inherited cache state from prior test files in this Jest worker
    // (maxWorkers: 1 + singleton-scoped cache = cross-file persistence).
    cache.invalidate(SYSTEM_TENANT);
    cache.invalidate(OTHER_TENANT);

    originalFlag = process.env[FLAG];
  });

  afterAll(async () => {
    if (originalFlag === undefined) delete process.env[FLAG];
    else process.env[FLAG] = originalFlag;
    await teardownTestDatabase();
    // Revert all binding mutations from this file's beforeAll (DatabaseService
    // rebind from setupTestDatabase + AuditLogRepository/WorkflowCentralRepository/
    // WorkflowCentralOperatorService rebinds from rebindWorkflowCentralStackForFreshDb).
    // Pairs with the container.snapshot() above.
    container.restore();
  });

  beforeEach(async () => {
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await sql`DELETE FROM workflow_central_tasks`.execute(db);
    await sql`DELETE FROM audit_logs WHERE action LIKE 'workflow_central.%'`.execute(db);
    delete process.env[FLAG];
  });

  afterEach(() => {
    jest.restoreAllMocks();
    // Keep `it` blocks independent — cache singleton persists across them.
    cache.invalidate(SYSTEM_TENANT);
    cache.invalidate(OTHER_TENANT);
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Seed a workflow_central_tasks row. Copied from workflowCentral-render.test.ts:97-136. */
  async function seedTask(args: {
    id: string;
    tenantId?: string;
    payload?: WorkflowPayload | null;
    data?: Record<string, unknown>;
  }): Promise<void> {
    const tenantId = args.tenantId ?? SYSTEM_TENANT;
    const now = new Date().toISOString();
    const db = (await container.getAsync<DatabaseService>(TYPES.DatabaseService)).getDatabase();
    await db
      .insertInto('workflow_central_tasks')
      .values({
        id: args.id,
        tenant_id: tenantId,
        instance_id: `INST-${args.id}`,
        workflow_id: `WF-${args.id}`,
        workflow_name: 'Render WF',
        step_id: 'STEP-A',
        step_name: 'Step A',
        task_type: 'task',
        status: 'pending',
        priority: 'medium',
        assignee_id: 'alice',
        assignee_name: 'Alice',
        description: 'render test',
        due_at: null,
        data: JSON.stringify(args.data ?? {}),
        actions: JSON.stringify([
          { id: 'complete', label: 'Complete', type: 'complete', requiresComment: false },
        ]),
        created_at: now,
        updated_at: now,
        completed_at: null,
        completed_by: null,
        completion_action_id: null,
        completion_comment: null,
        payload: args.payload ? JSON.stringify(args.payload) : null,
      })
      .execute();
  }

  /**
   * Build a fake IConnector whose `read` is the supplied jest.fn. Other
   * IConnector members are throw-on-call sentinels — the render path only
   * touches read(); any other call indicates a regression in the resolver's
   * call shape.
   */
  function makeFakeConnector(readImpl: jest.Mock<Promise<DataRecord | null>, [string, string]>): IConnector {
    const throwUnexpected = (member: string) => () => {
      throw new Error(`render-path test: unexpected IConnector.${member} call`);
    };
    return {
      systemType: 'fake',
      systemId: 'fake-1',
      initialize: throwUnexpected('initialize'),
      testConnection: throwUnexpected('testConnection'),
      getSystemInfo: throwUnexpected('getSystemInfo'),
      authenticate: throwUnexpected('authenticate'),
      create: throwUnexpected('create'),
      read: readImpl,
      update: throwUnexpected('update'),
      delete: throwUnexpected('delete'),
      list: throwUnexpected('list'),
      search: throwUnexpected('search'),
      bulkCreate: throwUnexpected('bulkCreate'),
      bulkUpdate: throwUnexpected('bulkUpdate'),
      bulkDelete: throwUnexpected('bulkDelete'),
    } as unknown as IConnector;
  }

  // Common ref shape used by Group A and parts of Group C.
  const ssnRefFixture = {
    system: 'netsuite' as const,
    recordType: 'customer',
    recordId: 'CUST-SSN-1',
  };

  // ===========================================================================
  // Group A — DLP end-to-end (real DLPService in the loop)
  // ===========================================================================

  describe('Group A — DLP end-to-end', () => {
    it('A1: PII detected → fields redacted in response; raw PII never appears', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({
          customerName: 'Acme',
          email: 'jane@example.com',
          ssn: '123-45-6789',
          amount: 9000,
        });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-dlp-a1',
        payload: { mode: 'external_reference', references: [ssnRefFixture] },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-dlp-a1/render');

      expect(res.status).toBe(200);
      expect(res.body.kind).toBe('resolved');
      expect(res.body.resolution).toHaveLength(1);
      expect(res.body.resolution[0].status).toBe('resolved');
      // SSN regex is /\b\d{3}-\d{2}-\d{4}\b|\b\d{9}\b/g → redacts to '***-**-****'
      // (per DLPService.ts:189-196).
      expect(res.body.resolution[0].fields.ssn).not.toBe('123-45-6789');
      expect(res.body.resolution[0].fields.ssn).toBe('***-**-****');
      // Defense-in-depth: the raw SSN MUST NOT appear anywhere in the response.
      expect(JSON.stringify(res.body)).not.toContain('123-45-6789');
    });

    it('A2: DLP scanFailed → outcome status=failed with PAYLOAD_REF_DLP_SCAN_FAILED', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({ amount: 9000, sensitive: 'must-not-leak' });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      // Force DLP to report scanFailed:true (the resolver's fail-closed branch
      // at WorkflowPayloadResolver.ts:87-90 should then mark the outcome failed).
      jest.spyOn(DLPService.prototype, 'scanForPII').mockResolvedValueOnce({
        detected: false,
        piiTypes: [],
        findings: [],
        riskLevel: 'low',
        recommendation: 'Scan failed - manual review recommended',
        scanFailed: true,
      } as PIIDetectionResult);

      await seedTask({
        id: 'TASK-dlp-a2',
        payload: { mode: 'external_reference', references: [ssnRefFixture] },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-dlp-a2/render');

      expect(res.status).toBe(200);
      expect(res.body.resolution[0].status).toBe('failed');
      expect(res.body.resolution[0].error.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
      expect(res.body.resolution[0].error.statusCode).toBe(500);
      // Raw record MUST NOT have leaked.
      expect(JSON.stringify(res.body)).not.toContain('must-not-leak');
    });

    it('A3: DLP findings present but redactedData undefined → same failed outcome', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({ ssn: '123-45-6789', extra: 'must-not-leak' });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      // Findings present but redactData fails (returns undefined) — exercises
      // WorkflowPayloadResolver.ts:116-121 (no-redactor fail-closed).
      jest.spyOn(DLPService.prototype, 'scanForPII').mockResolvedValueOnce({
        detected: true,
        piiTypes: ['ssn'],
        findings: [{
          type: 'ssn',
          value: '123-45-6789',
          confidence: 0.95,
          location: { path: 'ssn' },
          severity: 'critical',
          redactedValue: '***-**-****',
        }],
        riskLevel: 'critical',
        recommendation: 'Redact',
      } as PIIDetectionResult);
      jest.spyOn(DLPService.prototype, 'redactData').mockReturnValueOnce(undefined);

      await seedTask({
        id: 'TASK-dlp-a3',
        payload: { mode: 'external_reference', references: [ssnRefFixture] },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-dlp-a3/render');

      expect(res.status).toBe(200);
      expect(res.body.resolution[0].status).toBe('failed');
      expect(res.body.resolution[0].error.code).toBe('PAYLOAD_REF_DLP_SCAN_FAILED');
      expect(JSON.stringify(res.body)).not.toContain('must-not-leak');
    });
  });

  // ===========================================================================
  // Group B — Cross-system compose
  // ===========================================================================

  describe('Group B — Cross-system compose', () => {
    it('B1: two refs (netsuite + salesforce), both succeed → resolution[] independent', async () => {
      // Use field names that DLP does NOT field-gate. The 'name' PII pattern
      // (DLPService.ts) auto-redacts paths containing "name", so a field like
      // `companyName: 'Acme NetSuite'` would surface as `[NAME_REDACTED]` and
      // mask the cross-system fan-out signal this test is meant to prove.
      const stagedByRecordId: Record<string, DataRecord> = {
        'NS-1': { id: 'NS-1', amount: 9000, currency: 'USD' },
        'SF-1': { id: 'SF-1', amount: 5500, stage: 'closed_won' },
      };
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockImplementation(async (_entityType, id) => stagedByRecordId[id] ?? null);
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-cross-b1',
        payload: {
          mode: 'external_reference',
          references: [
            { system: 'netsuite', recordType: 'customer', recordId: 'NS-1' },
            { system: 'salesforce', recordType: 'Account', recordId: 'SF-1' },
          ],
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-cross-b1/render');

      expect(res.status).toBe(200);
      expect(res.body.resolution).toHaveLength(2);
      expect(res.body.resolution[0].ref.system).toBe('netsuite');
      expect(res.body.resolution[0].status).toBe('resolved');
      expect(res.body.resolution[0].fields).toMatchObject({ id: 'NS-1', amount: 9000, currency: 'USD' });
      expect(res.body.resolution[1].ref.system).toBe('salesforce');
      expect(res.body.resolution[1].status).toBe('resolved');
      expect(res.body.resolution[1].fields).toMatchObject({ id: 'SF-1', amount: 5500, stage: 'closed_won' });
    });

    it('B2: two refs, one connector throws {statusCode: 503} → partial success preserved', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockImplementation(async (_entityType, id) => {
          if (id === 'NS-OK') return { id: 'NS-OK', amount: 9000 };
          // eslint-disable-next-line @typescript-eslint/no-throw-literal
          throw { statusCode: 503, message: 'salesforce down' };
        });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-cross-b2',
        payload: {
          mode: 'external_reference',
          references: [
            { system: 'netsuite', recordType: 'customer', recordId: 'NS-OK' },
            { system: 'salesforce', recordType: 'Account', recordId: 'SF-DOWN' },
          ],
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-cross-b2/render');

      expect(res.status).toBe(200);
      expect(res.body.resolution).toHaveLength(2);
      expect(res.body.resolution[0].status).toBe('resolved');
      expect(res.body.resolution[1].status).toBe('failed');
      expect(res.body.resolution[1].error.code).toBe('PAYLOAD_REF_CONNECTOR_UNAVAILABLE');
      expect(res.body.resolution[1].error.statusCode).toBe(503);
    });

    it('B3: three refs across three systems → getConnector called once per ref with correct tuples', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockImplementation(async (_entityType, id) => ({ id }));
      const getConnectorSpy = jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-cross-b3',
        payload: {
          mode: 'external_reference',
          references: [
            { system: 'netsuite', recordType: 'customer', recordId: 'NS-2' },
            { system: 'businesscentral', recordType: 'salesOrder', recordId: 'BC-2' },
            { system: 'salesforce', recordType: 'Opportunity', recordId: 'SF-2' },
          ],
        },
      });

      const res = await request(app).get('/api/workflow-central/tasks/TASK-cross-b3/render');

      expect(res.status).toBe(200);
      expect(res.body.resolution).toHaveLength(3);

      // Resolver builds systemId as `${ref.system}_${tenantId}` (per
      // WorkflowPayloadResolver.ts:66). SYSTEM_TENANT = '__system__'.
      const expectedTuples: Array<[string, string]> = [
        ['netsuite', `netsuite_${SYSTEM_TENANT}`],
        ['businesscentral', `businesscentral_${SYSTEM_TENANT}`],
        ['salesforce', `salesforce_${SYSTEM_TENANT}`],
      ];
      const actualTuples = getConnectorSpy.mock.calls.map((c) => [c[0], c[1]] as [string, string]);
      expect(actualTuples).toEqual(expectedTuples);
    });
  });

  // ===========================================================================
  // Group C — Cache behavior
  // ===========================================================================

  describe('Group C — Cache behavior', () => {
    it('C1: same task rendered 100 times → connector.read invoked exactly 1 time', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({ id: 'CACHE-1', amount: 9000 });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-cache-c1',
        payload: {
          mode: 'external_reference',
          references: [{ system: 'netsuite', recordType: 'customer', recordId: 'CACHE-1' }],
        },
      });

      for (let i = 0; i < 100; i++) {
        const res = await request(app).get('/api/workflow-central/tasks/TASK-cache-c1/render');
        expect(res.status).toBe(200);
        expect(res.body.resolution[0].status).toBe('resolved');
        expect(res.body.resolution[0].fields).toMatchObject({ id: 'CACHE-1', amount: 9000 });
      }
      // Coalesced: the cache absorbs renders 2..100.
      expect(readSpy).toHaveBeenCalledTimes(1);
    });

    it('C2: cache miss on TTL expiry — second render after Date.now() past 30s → second read', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({ id: 'TTL-1', amount: 9000 });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      // Spy on Date.now (NOT jest.useFakeTimers — supertest interacts with
      // timer fakes; Date.now spy is scoped and doesn't touch setTimeout/
      // setImmediate).
      let nowMs = Date.now();
      const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => nowMs);

      await seedTask({
        id: 'TASK-cache-c2',
        payload: {
          mode: 'external_reference',
          references: [{ system: 'netsuite', recordType: 'customer', recordId: 'TTL-1' }],
        },
      });

      // First render → connector read once.
      const r1 = await request(app).get('/api/workflow-central/tasks/TASK-cache-c2/render');
      expect(r1.status).toBe(200);
      expect(readSpy).toHaveBeenCalledTimes(1);

      // Push past default 30s TTL (WorkflowPayloadCache.ts:37).
      nowMs += 31_000;

      // Second render → cache miss → connector read again.
      const r2 = await request(app).get('/api/workflow-central/tasks/TASK-cache-c2/render');
      expect(r2.status).toBe(200);
      expect(readSpy).toHaveBeenCalledTimes(2);

      dateNowSpy.mockRestore();
    });

    it('C3: per-tenant cache isolation — same ref shape, two tenants → 2 read calls', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        .mockResolvedValue({ id: 'ISO-1', amount: 9000 });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      // Two tasks under two tenants with the same ref shape. Task ids are
      // arbitrary strings; distinct ids keep route lookups independent. The
      // cache key includes tenantId at WorkflowPayloadCache.ts:99, so the two
      // renders MUST NOT share a cache entry.
      const sharedRef = { system: 'netsuite' as const, recordType: 'customer', recordId: 'ISO-1' };
      await seedTask({
        id: 'TASK-cache-iso-sys',
        tenantId: SYSTEM_TENANT,
        payload: { mode: 'external_reference', references: [sharedRef] },
      });
      await seedTask({
        id: 'TASK-cache-iso-other',
        tenantId: OTHER_TENANT,
        payload: { mode: 'external_reference', references: [sharedRef] },
      });

      const r1 = await request(app)
        .get('/api/workflow-central/tasks/TASK-cache-iso-sys/render')
        .set('X-Test-Tenant-Id', SYSTEM_TENANT);
      expect(r1.status).toBe(200);
      const r2 = await request(app)
        .get('/api/workflow-central/tasks/TASK-cache-iso-other/render')
        .set('X-Test-Tenant-Id', OTHER_TENANT);
      expect(r2.status).toBe(200);

      expect(readSpy).toHaveBeenCalledTimes(2);
    });

    it('C4: failed outcome NOT cached — render fails, connector recovers, second render triggers a fresh read', async () => {
      const readSpy = jest.fn<Promise<DataRecord | null>, [string, string]>()
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        .mockRejectedValueOnce({ statusCode: 503, message: 'transient' })
        .mockResolvedValueOnce({ id: 'RECOVER-1', amount: 9000 });
      jest.spyOn(ConnectorManager.prototype, 'getConnector')
        .mockResolvedValue(makeFakeConnector(readSpy) as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);

      await seedTask({
        id: 'TASK-cache-c4',
        payload: {
          mode: 'external_reference',
          references: [{ system: 'netsuite', recordType: 'customer', recordId: 'RECOVER-1' }],
        },
      });

      // First call: connector throws → outcome failed → NOT cached (per
      // WorkflowPayloadResolver.ts:104 comment "no negative caching").
      const r1 = await request(app).get('/api/workflow-central/tasks/TASK-cache-c4/render');
      expect(r1.status).toBe(200);
      expect(r1.body.resolution[0].status).toBe('failed');

      // Second call: connector recovers → fresh read because failure wasn't cached.
      const r2 = await request(app).get('/api/workflow-central/tasks/TASK-cache-c4/render');
      expect(r2.status).toBe(200);
      expect(r2.body.resolution[0].status).toBe('resolved');
      expect(r2.body.resolution[0].fields).toMatchObject({ id: 'RECOVER-1', amount: 9000 });
      expect(readSpy).toHaveBeenCalledTimes(2);
    });
  });
});
