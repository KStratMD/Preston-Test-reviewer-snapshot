/**
 * Sync Error Assist triage — the authorization matrix.
 *
 * Every row of the matrix runs against all four endpoints (list, accept,
 * reject, escalate). The app mirrors production order: the global `/api`
 * optionalAuthMiddleware, then the strict central tenant gate (the triage
 * paths are exact trusted deferrals, so the route decides), then the real
 * `syncErrorAssistRoutes` router.
 *
 *   Embedded path — a VERIFIED approver/admin grant whose four-part scope
 *   (tenant, platform, platform account, user) matches the session.
 *   JWT path     — `tenant_admin` with a real tenant claim; never the platform
 *   wildcard, never a `service` token.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import type { Test as SupertestTest } from 'supertest';
import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import { sql } from 'kysely';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { DatabaseService } from '../../src/database/DatabaseService';
import { optionalAuthMiddleware } from '../../src/middleware/auth';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import { syncErrorAssistRoutes, resetTriageDispositionLimiterForTest } from '../../src/routes/syncErrorAssistRoutes';
import { SyncErrorAssistOperatorService } from '../../src/services/syncErrorAssist/SyncErrorAssistOperatorService';
import { ConnectorManager } from '../../src/services/integration/ConnectorManager';
import type { TenantLifecycleService } from '../../src/services/tenants/TenantLifecycleService';
import { PartialTenantRevocationError } from '../../src/services/tenants/TenantErrors';
import type { OwnershipResolver } from '../../src/governance/sourceOfTruth/OwnershipResolver';
import type { OwnershipDeclaration } from '../../src/governance/sourceOfTruth/SourceOfTruthManifest';
import { SYSTEM_IDENTITY } from '../../src/services/governance/identityContext';
import { env } from '../../src/config';
import {
  setupTestDatabase,
  teardownTestDatabase,
  seedEmbeddedAccountBinding,
  seedSuggestion,
  fetchAuditLogsByAction,
  clearSyncErrorAssistTestState,
} from './helpers/syncErrorAssistTestHelpers';

const HOST = 'localhost:3000';
const ORIGIN = 'http://localhost:3000';
const TENANT_A = 'tnt-triage-a';
const TENANT_B = 'tnt-triage-b';
const TENANT_SUSPENDED = 'tnt-triage-suspended';
const PLATFORM = 'netsuite';
const ACCOUNT = 'acct-triage-a';
const USER = 'triage-operator';

let app: express.Express;
let db: DatabaseService;
let mockConnector: { initialize: jest.Mock; create: jest.Mock; update: jest.Mock };

type Endpoint = 'list' | 'accept' | 'reject' | 'escalate';
const ENDPOINTS: Endpoint[] = ['list', 'accept', 'reject', 'escalate'];

function call(endpoint: Endpoint, errorRecordId = 'e1'): SupertestTest {
  switch (endpoint) {
    case 'list':
      return request(app).get('/api/sync-error-assist/suggestions');
    case 'accept':
      return request(app)
        .post(`/api/sync-error-assist/suggestions/${errorRecordId}/accept`)
        .send({ applyAction: { type: 'create', entityType: 'item', payload: { name: 'Widget' } } });
    case 'reject':
      return request(app).post(`/api/sync-error-assist/suggestions/${errorRecordId}/reject`).send({ reason: 'wrong' });
    case 'escalate':
      return request(app).post(`/api/sync-error-assist/suggestions/${errorRecordId}/escalate`).send({ note: 'look' });
  }
}

function embedded(t: SupertestTest, sessionId: string): SupertestTest {
  return t.set('Host', HOST).set('Origin', ORIGIN).set('X-Embedded-Session-Id', sessionId);
}

function bearer(t: SupertestTest, token: string): SupertestTest {
  return t.set('Authorization', `Bearer ${token}`);
}

function signJwt(claims: Record<string, unknown>, options: jwt.SignOptions = {}): string {
  return jwt.sign(claims, process.env.JWT_SECRET as string, { algorithm: 'HS256', expiresIn: '5m', ...options });
}

const tenantAdminToken = (tenantId = TENANT_A, sub = 'api-admin-1'): string =>
  signJwt({ sub, tenantId, roles: ['tenant_admin'] });

interface GrantSpec {
  role?: string;
  tenantId?: string;
  platform?: string;
  platformAccountId?: string;
  userId?: string;
  expiresAt?: string | null;
  revoked?: boolean;
}

/**
 * Insert a grant and a squire_verified session naming it. The session is
 * always TENANT_A / netsuite / ACCOUNT / USER; the grant's parts are
 * overridable so each scope mismatch can be pinned on its own.
 */
async function seedVerifiedSession(grant: GrantSpec = {}, sessionTenant = TENANT_A, sessionUser = USER): Promise<string> {
  const grantId = `erg_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const now = new Date().toISOString();
  await db
    .getDatabase()
    .insertInto('embedded_role_grants')
    .values({
      id: grantId,
      tenant_id: grant.tenantId ?? sessionTenant,
      platform: grant.platform ?? PLATFORM,
      platform_account_id: grant.platformAccountId ?? ACCOUNT,
      user_id: grant.userId ?? USER,
      role: grant.role ?? 'approver',
      source: 'squire_operator',
      granted_by: 'test-operator',
      granted_at: now,
      expires_at: grant.expiresAt ?? null,
      revoked_at: grant.revoked ? now : null,
      revoked_by: grant.revoked ? 'test-operator' : null,
      secret_enc: 'test-ciphertext-not-decrypted-on-this-path',
    })
    .execute();
  return seedSession({ tenantId: sessionTenant, identity: 'squire_verified', grantId, userId: sessionUser });
}

async function seedSession(args: {
  tenantId: string;
  identity: 'squire_verified' | 'host_asserted';
  grantId: string | null;
  userRoles?: string[];
  userId?: string;
}): Promise<string> {
  const sessionId = `es_test_${randomUUID()}`;
  await db
    .getDatabase()
    .insertInto('embedded_sessions')
    .values({
      session_id: sessionId,
      tenant_id: args.tenantId,
      user_id: args.userId ?? USER,
      platform: PLATFORM,
      platform_account_id: ACCOUNT,
      csrf_token: `csrf_test_${randomUUID()}`,
      expected_host_origin: 'https://12345.app.netsuite.com',
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      last_rotation_at: null,
      erp_record_type: null,
      erp_record_id: null,
      erp_record_url: null,
      user_roles: args.userRoles ? JSON.stringify(args.userRoles) : null,
      user_identity: args.identity,
      verified_grant_id: args.grantId,
    })
    .execute();
  return sessionId;
}

async function suggestionRow(tenantId: string, errorRecordId: string): Promise<Record<string, unknown> | undefined> {
  return db
    .getDatabase()
    .selectFrom('sync_error_assist_processed')
    .selectAll()
    .where('tenant_id', '=', tenantId)
    .where('error_record_id', '=', errorRecordId)
    .executeTakeFirst() as Promise<Record<string, unknown> | undefined>;
}

function detailsOf(row: { details: unknown }): Record<string, unknown> {
  return typeof row.details === 'string' ? (JSON.parse(row.details) as Record<string, unknown>) : (row.details as Record<string, unknown>);
}

beforeAll(async () => {
  container.snapshot();
  db = await setupTestDatabase();
  const lifecycle = await container.getAsync<TenantLifecycleService>(TYPES.TenantLifecycleService);
  await lifecycle.requireActive(TENANT_SUSPENDED);
  try {
    await lifecycle.setStatus({
      tenantId: TENANT_SUSPENDED,
      newStatus: 'suspended',
      actorUserId: 'test-admin',
      actorSource: 'integration-test',
      reason: 'triage-kill-switch',
    });
  } catch (err) {
    // The status flip commits before the revocation pass, which the test
    // SecretManager cannot complete. A surviving credential on a suspended
    // tenant is exactly what the request-time gate must refuse.
    if (!(err instanceof PartialTenantRevocationError)) throw err;
  }
  app = express();
  app.use(express.json());
  app.use('/api', optionalAuthMiddleware);
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.use(syncErrorAssistRoutes);
  // The production JSON error handler collapses forwarded errors to 500.
  app.use((_err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ ok: false, code: 'internal_error' });
  });
});

afterAll(async () => {
  await teardownTestDatabase();
  container.restore();
});

beforeEach(async () => {
  await clearSyncErrorAssistTestState();
  await sql`DELETE FROM embedded_role_grants WHERE granted_by = 'test-operator'`.execute(db.getDatabase());
  resetTriageDispositionLimiterForTest();
  mockConnector = {
    initialize: jest.fn().mockResolvedValue(undefined),
    create: jest.fn().mockResolvedValue({ id: 'ns_created_1' }),
    update: jest.fn().mockResolvedValue({ id: 'ns_updated_1' }),
  };
  jest
    .spyOn(ConnectorManager.prototype, 'getConnector')
    .mockResolvedValue(mockConnector as unknown as Awaited<ReturnType<ConnectorManager['getConnector']>>);
  await seedEmbeddedAccountBinding(TENANT_A);
  await seedSuggestion({ tenantId: TENANT_A, errorRecordId: 'e1' });
  await seedSuggestion({ tenantId: TENANT_B, errorRecordId: 'b1' });
});

afterEach(() => {
  jest.restoreAllMocks();
});

const SUCCESS: Record<Endpoint, number> = { list: 200, accept: 200, reject: 200, escalate: 200 };

describe('embedded path', () => {
  for (const role of ['approver', 'admin']) {
    for (const endpoint of ENDPOINTS) {
      it(`verified ${role} grant: ${endpoint} succeeds on the session tenant`, async () => {
        const sessionId = await seedVerifiedSession({ role });
        const res = await embedded(call(endpoint), sessionId);
        expect(res.status).toBe(SUCCESS[endpoint]);
        if (endpoint === 'list') {
          expect(res.body.items.map((i: { errorRecordId: string }) => i.errorRecordId)).toEqual(['e1']);
        } else {
          const audits = await fetchAuditLogsByAction(`sync_error_assist.${endpoint}`);
          expect(audits).toHaveLength(1);
          expect(audits[0].tenant_id).toBe(TENANT_A);
          expect(audits[0].user_id).toBe(USER);
          expect(detailsOf(audits[0])).toMatchObject({ auth_source: 'embedded_grant' });
        }
      });
    }
  }

  const DENIALS: { label: string; seed: () => Promise<string> }[] = [
    {
      label: 'host-asserted admin/ops/finance, no grant',
      seed: () => seedSession({ tenantId: TENANT_A, identity: 'host_asserted', grantId: null, userRoles: ['admin', 'ops', 'finance'] }),
    },
    { label: 'verified viewer grant', seed: () => seedVerifiedSession({ role: 'viewer' }) },
    { label: 'verified requester grant', seed: () => seedVerifiedSession({ role: 'requester' }) },
    { label: 'revoked approver grant', seed: () => seedVerifiedSession({ revoked: true }) },
    { label: 'expired approver grant', seed: () => seedVerifiedSession({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) },
    { label: 'approver grant for another tenant', seed: () => seedVerifiedSession({ tenantId: TENANT_B }) },
    { label: 'approver grant for another platform', seed: () => seedVerifiedSession({ platform: 'business_central' }) },
    { label: 'approver grant for another platform account', seed: () => seedVerifiedSession({ platformAccountId: 'acct-other' }) },
    { label: 'approver grant for another user', seed: () => seedVerifiedSession({ userId: 'someone-else' }) },
  ];

  for (const { label, seed } of DENIALS) {
    for (const endpoint of ENDPOINTS) {
      it(`${label}: ${endpoint} is 403 insufficient_role and changes nothing`, async () => {
        const sessionId = await seed();
        const before = await suggestionRow(TENANT_A, 'e1');
        const res = await embedded(call(endpoint), sessionId);
        expect(res.status).toBe(403);
        expect(res.body).toMatchObject({ ok: false, code: 'insufficient_role' });
        expect(await suggestionRow(TENANT_A, 'e1')).toEqual(before);
        expect(mockConnector.create).not.toHaveBeenCalled();
      });
    }
  }

  for (const endpoint of ENDPOINTS) {
    it(`suspended tenant: ${endpoint} is 403 tenant_blocked even with a verified admin grant`, async () => {
      const sessionId = await seedVerifiedSession({ role: 'admin' }, TENANT_SUSPENDED);
      const res = await embedded(call(endpoint), sessionId);
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    });
  }

  it('a Basic Authorization header with a session takes the embedded path', async () => {
    const sessionId = await seedVerifiedSession();
    const res = await embedded(call('list'), sessionId).set('Authorization', 'Basic c3RhZ2luZzpwcm94eQ==');
    expect(res.status).toBe(200);
  });

  it('no credentials: the route answers (cross_origin_rejected), not the central gate', async () => {
    const res = await call('list');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'cross_origin_rejected' });
  });

  for (const endpoint of ['accept', 'reject', 'escalate'] as const) {
    it(`cross-tenant ${endpoint} is 404 and leaves the other tenant's row byte-for-byte unchanged`, async () => {
      const sessionId = await seedVerifiedSession({ role: 'admin' });
      const before = await suggestionRow(TENANT_B, 'b1');
      const res = await embedded(call(endpoint, 'b1'), sessionId);
      expect(res.status).toBe(404);
      expect(await suggestionRow(TENANT_B, 'b1')).toEqual(before);
      expect(mockConnector.create).not.toHaveBeenCalled();
    });
  }
});

describe('JWT path', () => {
  for (const endpoint of ENDPOINTS) {
    it(`tenant_admin: ${endpoint} succeeds on the claim tenant, audited as the subject with auth_source api_jwt`, async () => {
      const res = await bearer(call(endpoint), tenantAdminToken());
      expect(res.status).toBe(SUCCESS[endpoint]);
      if (endpoint === 'list') {
        expect(res.body.items.map((i: { errorRecordId: string }) => i.errorRecordId)).toEqual(['e1']);
      } else {
        const audits = await fetchAuditLogsByAction(`sync_error_assist.${endpoint}`);
        expect(audits).toHaveLength(1);
        expect(audits[0].tenant_id).toBe(TENANT_A);
        expect(audits[0].user_id).toBe('api-admin-1');
        expect(detailsOf(audits[0])).toMatchObject({ auth_source: 'api_jwt' });
      }
    });
  }

  const JWT_DENIALS: { label: string; token: () => string; status: number; code?: string }[] = [
    { label: 'platform admin role only', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['admin'] }), status: 403, code: 'insufficient_role' },
    { label: 'wildcard permission only', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['user'], permissions: ['*'] }), status: 403, code: 'insufficient_role' },
    { label: 'plain user', token: () => signJwt({ sub: 'p', tenantId: TENANT_A }), status: 403, code: 'insufficient_role' },
    { label: 'tenant_admin plus platform admin', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin', 'admin'] }), status: 403, code: 'insufficient_role' },
    { label: 'tenant_admin plus wildcard permission', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin'], permissions: ['*'] }), status: 403, code: 'insufficient_role' },
    { label: 'tenant_admin plus service', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin', 'service'] }), status: 403, code: 'service_role_refused' },
    { label: 'no tenant claim', token: () => signJwt({ sub: 'p', roles: ['tenant_admin'] }), status: 401, code: 'tenant_identity_required' },
    { label: 'SYSTEM tenant claim', token: () => signJwt({ sub: 'p', tenantId: SYSTEM_IDENTITY.tenantId, roles: ['tenant_admin'] }), status: 401, code: 'tenant_identity_required' },
    { label: 'expired token', token: () => signJwt({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin'] }, { expiresIn: -10 }), status: 401 },
    { label: 'wrong signing key', token: () => jwt.sign({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin'] }, 'not-the-secret', { algorithm: 'HS256' }), status: 401 },
    { label: 'wrong algorithm (HS512)', token: () => jwt.sign({ sub: 'p', tenantId: TENANT_A, roles: ['tenant_admin'] }, process.env.JWT_SECRET as string, { algorithm: 'HS512' }), status: 401 },
    { label: 'garbage token', token: () => 'not-a-jwt', status: 401 },
  ];

  for (const { label, token, status, code } of JWT_DENIALS) {
    for (const endpoint of ENDPOINTS) {
      it(`${label}: ${endpoint} is ${status}${code ? ` ${code}` : ''} and changes nothing`, async () => {
        const before = await suggestionRow(TENANT_A, 'e1');
        const res = await bearer(call(endpoint), token());
        expect(res.status).toBe(status);
        if (code) expect(res.body).toMatchObject({ ok: false, code });
        expect(res.body.items).toBeUndefined();
        expect(await suggestionRow(TENANT_A, 'e1')).toEqual(before);
      });
    }
  }

  for (const endpoint of ENDPOINTS) {
    it(`suspended tenant: ${endpoint} is 403 tenant_blocked`, async () => {
      const res = await bearer(call(endpoint), tenantAdminToken(TENANT_SUSPENDED));
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: 'tenant_blocked' });
    });
  }

  it('cross-tenant list excludes the other tenant', async () => {
    const res = await bearer(call('list'), tenantAdminToken());
    expect(res.status).toBe(200);
    expect(res.body.items.find((i: { errorRecordId: string }) => i.errorRecordId === 'b1')).toBeUndefined();
  });

  for (const endpoint of ['accept', 'reject', 'escalate'] as const) {
    it(`cross-tenant ${endpoint} is 404 and leaves the other tenant's row byte-for-byte unchanged`, async () => {
      const before = await suggestionRow(TENANT_B, 'b1');
      const res = await bearer(call(endpoint, 'b1'), tenantAdminToken());
      expect(res.status).toBe(404);
      expect(await suggestionRow(TENANT_B, 'b1')).toEqual(before);
      expect(mockConnector.create).not.toHaveBeenCalled();
    });
  }
});

describe('credential dispatch', () => {
  for (const endpoint of ENDPOINTS) {
    it(`${endpoint}: canonical Bearer plus session header is 400 ambiguous_credentials, even with an invalid token`, async () => {
      const sessionId = await seedVerifiedSession({ role: 'admin' });
      for (const token of [tenantAdminToken(), 'not-a-jwt']) {
        const res = await bearer(embedded(call(endpoint), sessionId), token);
        expect(res.status).toBe(400);
        expect(res.body).toMatchObject({ ok: false, code: 'ambiguous_credentials' });
      }
    });
  }

  for (const header of ['bearer TOKEN', 'BEARER TOKEN', 'Bearer  TOKEN', 'Bearer']) {
    it(`malformed "${header}" is 401 invalid_authorization_scheme with and without a session`, async () => {
      const token = tenantAdminToken();
      const value = header.replace('TOKEN', token);
      const sessionId = await seedVerifiedSession({ role: 'admin' });
      const withSession = await embedded(call('list'), sessionId).set('Authorization', value);
      const without = await call('list').set('Authorization', value);
      for (const res of [withSession, without]) {
        expect(res.status).toBe(401);
        expect(res.body).toMatchObject({ ok: false, code: 'invalid_authorization_scheme' });
      }
    });
  }
});

describe('handler failures reach the error handler', () => {
  const FAILING = [
    { endpoint: 'list' as const, method: 'list' as const },
    { endpoint: 'reject' as const, method: 'reject' as const },
    { endpoint: 'escalate' as const, method: 'escalate' as const },
  ];
  for (const { endpoint, method } of FAILING) {
    it(`${endpoint}: a rejected service call is a 500, not a hung request`, async () => {
      const spy = jest.spyOn(SyncErrorAssistOperatorService.prototype, method).mockRejectedValue(new Error('db down'));
      try {
        const res = await bearer(call(endpoint), tenantAdminToken());
        expect(res.status).toBe(500);
        expect(res.body).toMatchObject({ ok: false, code: 'internal_error' });
      } finally {
        spy.mockRestore();
      }
    });
  }
});

describe('ERP-write budget', () => {
  it('accept, reject and escalate share one 60-per-window budget; the 61st of any kind is 429', async () => {
    const mutableEnv = env as unknown as { RATE_LIMIT_ENABLED: boolean };
    const original = mutableEnv.RATE_LIMIT_ENABLED;
    mutableEnv.RATE_LIMIT_ENABLED = true;
    try {
      resetTriageDispositionLimiterForTest();
      const token = tenantAdminToken();
      const kinds = ['accept', 'reject', 'escalate'] as const;
      for (let i = 0; i < 60; i++) {
        // Unknown ids: each disposition returns its normal 404, and still spends budget.
        const res = await bearer(call(kinds[i % 3], `missing-${i}`), token);
        expect(res.status).toBe(404);
      }
      for (const kind of kinds) {
        const res = await bearer(call(kind, 'missing-over'), token);
        expect(res.status).toBe(429);
      }
      // Reads are not metered by the disposition budget.
      const list = await bearer(call('list'), token);
      expect(list.status).toBe(200);
    } finally {
      mutableEnv.RATE_LIMIT_ENABLED = original;
      resetTriageDispositionLimiterForTest();
    }
  });

  it('two embedded operators behind one IP get separate budgets (keyed on the authorized actor, not req.user)', async () => {
    const mutableEnv = env as unknown as { RATE_LIMIT_ENABLED: boolean };
    const original = mutableEnv.RATE_LIMIT_ENABLED;
    mutableEnv.RATE_LIMIT_ENABLED = true;
    try {
      resetTriageDispositionLimiterForTest();
      const first = await seedVerifiedSession({ userId: 'operator-one' }, TENANT_A, 'operator-one');
      const second = await seedVerifiedSession({ userId: 'operator-two' }, TENANT_A, 'operator-two');
      for (let i = 0; i < 60; i++) {
        const res = await embedded(call('reject', `missing-${i}`), first);
        expect(res.status).toBe(404);
      }
      expect((await embedded(call('reject', 'missing-over'), first)).status).toBe(429);
      // The second operator, same IP, still has a full budget.
      expect((await embedded(call('reject', 'missing-other'), second)).status).toBe(404);
    } finally {
      mutableEnv.RATE_LIMIT_ENABLED = original;
      resetTriageDispositionLimiterForTest();
    }
  });
});

describe('queue_for_human entity (behaviour unchanged, pinned)', () => {
  const fixtureManifest: OwnershipDeclaration[] = [
    {
      entity: 'customer',
      owner: 'netsuite',
      consumers: ['salesforce'],
      conflictPolicy: 'queue_for_human',
      conflictPolicyRationale: 'triage queue_for_human fixture',
    },
  ];

  async function withFixtureManifest(fn: () => Promise<void>): Promise<void> {
    const resolver = await container.getAsync<OwnershipResolver>(TYPES.OwnershipResolver);
    const holder = resolver as unknown as { manifest: OwnershipDeclaration[] };
    const original = holder.manifest;
    holder.manifest = fixtureManifest;
    try {
      await fn();
    } finally {
      holder.manifest = original;
    }
  }

  const CALLERS: { label: string; send: (t: SupertestTest) => Promise<SupertestTest>; userId: string; source: string }[] = [
    { label: 'embedded grant', send: async (t) => embedded(t, await seedVerifiedSession({ role: 'admin' })), userId: USER, source: 'embedded_grant' },
    { label: 'tenant_admin JWT', send: async (t) => bearer(t, tenantAdminToken()), userId: 'api-admin-1', source: 'api_jwt' },
  ];

  for (const { label, send, userId, source } of CALLERS) {
    it(`${label}: accept is write_failed, the suggestion is back to pending, the failure is audited, no approval is queued`, async () => {
      await withFixtureManifest(async () => {
        const t = request(app)
          .post('/api/sync-error-assist/suggestions/e1/accept')
          .send({ applyAction: { type: 'create', entityType: 'customer', payload: { companyname: 'Acme' } } });
        const res = await send(t);
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ ok: false, code: 'write_failed' });
        // The failure is the missing resume descriptor, i.e. the queue branch
        // fired — not some unrelated write error.
        expect(res.body.message).toMatch(/^MissingWriteDescriptor: queue_for_human policy fired/);
      });
      expect(mockConnector.create).not.toHaveBeenCalled();
      expect((await suggestionRow(TENANT_A, 'e1'))?.operator_disposition).toBe('pending');
      const audits = await fetchAuditLogsByAction('sync_error_assist.accept');
      expect(audits).toHaveLength(1);
      expect(audits[0].result).toBe('failure');
      expect(audits[0].user_id).toBe(userId);
      expect(detailsOf(audits[0])).toMatchObject({ auth_source: source });
      const approvals = await sql<{ n: number }>`SELECT COUNT(*) AS n FROM governance_approvals WHERE tenant_id = ${TENANT_A}`.execute(db.getDatabase());
      expect(Number(approvals.rows[0].n)).toBe(0);
    });
  }
});
