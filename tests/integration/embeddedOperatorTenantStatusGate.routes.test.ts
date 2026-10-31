/**
 * Integration (F3 Task 7): the embedded lineage/reconciliation operator
 * surfaces must refuse blocked-tenant sessions AT REQUEST TIME — session
 * revocation on status transition can partially fail
 * (PartialTenantRevocationError), so a surviving session must still read
 * 403 tenant_blocked. Parameterized matrix over all three route
 * registrations. Fixture pattern: governanceApprovalsRouter.test.ts (real
 * container: EmbeddedSessionRepository + TenantLifecycleService against the
 * test DB; domain services faked via the router factories).
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import type { Test as SupertestTest } from 'supertest';
import { sql } from 'kysely';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { DatabaseService } from '../../src/database/DatabaseService';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { embeddedLineageRouter } from '../../src/routes/embedded/embeddedLineageRouter';
import { embeddedReconciliationRouter } from '../../src/routes/embedded/embeddedReconciliationRouter';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import type { LineageQueryService } from '../../src/services/lineage/LineageQueryService';
import type { ReconciliationCenterService } from '../../src/services/reconciliationCenter/ReconciliationCenterService';
import type { TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';
import { PartialTenantRevocationError } from '../../src/services/tenants/TenantErrors';
import { setupTestDatabase, teardownTestDatabase, seedEmbeddedSession } from './helpers/syncErrorAssistTestHelpers';

const HOST = '127.0.0.1';
const TENANT_ACTIVE = 'tenant-f3-emb-active';
const TENANT_SUSPENDED = 'tenant-f3-emb-suspended';

const lineageService = {
  chainForRecord: jest.fn(async () => []),
} as unknown as LineageQueryService;

const reconciliationService = {
  listOpen: jest.fn(async () => []),
  resolveException: jest.fn(async () => undefined),
} as unknown as ReconciliationCenterService;

let app: express.Application;

function withSession(t: SupertestTest, sessionId: string): SupertestTest {
  // Origin matches the request Host (supertest binds to 127.0.0.1) so
  // isSameOriginRequest returns true; without it validateGuestContext 403s.
  return t.set('X-Embedded-Session-Id', sessionId).set('Origin', `http://${HOST}`);
}

// One row per route registration — the matrix IS the completeness proof.
const ROUTES: Array<{ label: string; send: (sessionId: string) => SupertestTest }> = [
  {
    label: 'embedded lineage record read',
    send: (s) => withSession(request(app).get('/api/embedded/lineage/records/netsuite/customer/42'), s),
  },
  {
    label: 'embedded reconciliation list',
    send: (s) => withSession(request(app).get('/api/embedded/reconciliation/exceptions'), s),
  },
  {
    label: 'embedded reconciliation resolve',
    send: (s) => withSession(
      request(app).post('/api/embedded/reconciliation/exceptions/rex-1/resolve').send({ note: 'x' }),
      s,
    ),
  },
];

beforeAll(async () => {
  // container.snapshot()/restore() bracket is REQUIRED: setupTestDatabase()
  // rebinds DatabaseService and this suite resolves inSingletonScope services
  // (TenantLifecycleService, session repo) against it — without the bracket,
  // teardownTestDatabase() leaves later integration files holding cached
  // dead handles. Same documented pattern as
  // governanceApprovalQueueRouting.test.ts / governanceApprovalsRouter.test.ts.
  container.snapshot();
  await setupTestDatabase();
  const lifecycle = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
  await lifecycle.requireActive(TENANT_ACTIVE);
  await lifecycle.requireActive(TENANT_SUSPENDED);
  try {
    await lifecycle.setStatus({
      tenantId: TENANT_SUSPENDED,
      newStatus: 'suspended',
      actorUserId: 'test-admin',
      actorSource: 'integration-test',
      reason: 'f3-task7',
    });
  } catch (err) {
    // Status flip commits BEFORE the revocation pass; the test env's
    // SecretManager (environment provider) cannot store revocation
    // tombstones. A surviving session on a suspended tenant is exactly the
    // scenario the request-time gate must refuse.
    if (!(err instanceof PartialTenantRevocationError)) throw err;
  }
  app = express();
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.use(express.json());
  app.use('/api/embedded/lineage', embeddedLineageRouter(lineageService));
  app.use('/api/embedded/reconciliation', embeddedReconciliationRouter(reconciliationService));
});

afterAll(async () => {
  await teardownTestDatabase();
  container.restore();
});

beforeEach(() => jest.clearAllMocks());

describe('embedded lineage/reconciliation — request-time kill switch (F3 Task 7)', () => {
  for (const { label, send } of ROUTES) {
    it(`${label}: suspended tenant session → 403 tenant_blocked, service never called`, async () => {
      // Seeded AFTER suspension (beforeAll ordering) so the revocation pass
      // cannot have removed it — this pins the request-time gate.
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_SUSPENDED, userId: 'user-s', userRoles: ['approver'] });
      const res = await send(sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
      expect(lineageService.chainForRecord).not.toHaveBeenCalled();
      expect(reconciliationService.listOpen).not.toHaveBeenCalled();
      expect(reconciliationService.resolveException).not.toHaveBeenCalled();
    });

    it(`${label}: active tenant session passes the gate`, async () => {
      const sessionId = await seedEmbeddedSession({ tenantId: TENANT_ACTIVE, userId: 'user-a', userRoles: ['approver'] });
      const res = await send(sessionId);
      expect([200, 204, 404]).toContain(res.status); // route-specific success/miss — never a gate refusal
      expect(res.body).not.toMatchObject({ error: 'tenant_blocked' });
    });

    it(`${label}: non-canonical tenant id fails closed — 403, NO shadow tenant row minted, service never called`, async () => {
      // Codex R3: the session store persists tenant_id verbatim; a padded id
      // ('tenant-f3-emb-active ' with trailing space) must not auto-register
      // an active SHADOW tenant next to the canonical row.
      const paddedTenant = `${TENANT_ACTIVE} `;
      const sessionId = await seedEmbeddedSession({ tenantId: paddedTenant, userId: 'user-x', userRoles: ['approver'] });
      const res = await send(sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
      expect(lineageService.chainForRecord).not.toHaveBeenCalled();
      expect(reconciliationService.listOpen).not.toHaveBeenCalled();
      expect(reconciliationService.resolveException).not.toHaveBeenCalled();
      const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
      const rows = await sql`SELECT id FROM tenants WHERE id = ${paddedTenant}`.execute(db.getDatabase());
      expect(rows.rows).toHaveLength(0);
    });

    it(`${label}: __system__ session fails closed — 403, NO tenant row minted, service never called`, async () => {
      // requireActive auto-registers unknown tenants as active; the gate must
      // refuse the system marker BEFORE the lifecycle lookup or '__system__'
      // becomes a real active tenant row and the request reaches the handler.
      const sessionId = await seedEmbeddedSession({ tenantId: SYSTEM_IDENTITY.tenantId, userId: 'user-x', userRoles: ['approver'] });
      const res = await send(sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_id_missing' });
      expect(lineageService.chainForRecord).not.toHaveBeenCalled();
      expect(reconciliationService.listOpen).not.toHaveBeenCalled();
      expect(reconciliationService.resolveException).not.toHaveBeenCalled();
      const db = await container.getAsync<DatabaseService>(TYPES.DatabaseService);
      const rows = await sql`SELECT id FROM tenants WHERE id = ${SYSTEM_IDENTITY.tenantId}`.execute(db.getDatabase());
      expect(rows.rows).toHaveLength(0);
    });
  }
});
