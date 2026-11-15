/**
 * Sync Error Assist triage — the production authorization path, end to end.
 *
 * Every other triage suite seeds `embedded_sessions` rows directly, so none of
 * them ever exercised what a real deployment does: a host adapter calls
 * host-bootstrap with the account service token and a signed
 * `X-Squire-User-Assertion`, the server records a `squire_verified` session
 * naming the proved grant, and only then does the browser call the triage API.
 *
 * Since #1238 host-bootstrap keeps only `viewer`/`requester` from the body, so
 * a real session can never carry the `ops`/`admin`/`finance` roles the triage
 * gate used to read. This suite drives that real sequence under the strict
 * central tenant gate, with the real `syncErrorAssistRoutes` router mounted.
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { randomBytes } from 'node:crypto';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import { Logger } from '../../src/utils/Logger';
import { EmbeddedServiceTokenRepository } from '../../src/services/embedded/EmbeddedServiceTokenRepository';
import type { EmbeddedRoleGrantRepository } from '../../src/services/embedded/EmbeddedRoleGrantRepository';
import type { SecureCredentialManager } from '../../src/services/SecureCredentialManager';
import { signUserAssertion } from '../../src/embedded/userAssertion';
import { mountCentralTenantGate } from '../../src/middleware/setup/RouteSetup';
import { syncErrorAssistRoutes } from '../../src/routes/syncErrorAssistRoutes';
import {
  setupTestDatabase,
  teardownTestDatabase,
  seedSuggestion,
  clearSyncErrorAssistTestState,
} from './helpers/syncErrorAssistTestHelpers';

const HOST = 'triage.example.test';
const ORIGIN = `https://${HOST}`;
const NS_ORIGIN = 'https://12345.app.netsuite.com';
const TENANT = 'tnt-triage-prod-path';
const PLATFORM = 'netsuite';
const ACCOUNT = 'acct_triage_prod';

let app: express.Express;
let rawServiceToken: string;

function buildScmStub(): SecureCredentialManager {
  return {
    storeCredentials: async () => undefined,
    deleteCredentials: async () => undefined,
  } as unknown as SecureCredentialManager;
}

async function bootstrap(opts: {
  userId: string;
  userRoles?: string[];
  assertion?: string;
}): Promise<request.Response> {
  const req = request(app)
    .post('/api/embedded/host-bootstrap')
    .set('Authorization', `Bearer ${rawServiceToken}`)
    .set('X-Embedded-Platform', PLATFORM);
  if (opts.assertion !== undefined) req.set('X-Squire-User-Assertion', opts.assertion);
  return req.send({
    platformAccountId: ACCOUNT,
    expectedHostOrigin: NS_ORIGIN,
    userId: opts.userId,
    ...(opts.userRoles ? { userRoles: opts.userRoles } : {}),
  });
}

function listSuggestions(sessionId: string): request.Test {
  return request(app)
    .get('/api/sync-error-assist/suggestions')
    .set('Host', HOST)
    .set('Origin', ORIGIN)
    .set('X-Embedded-Session-Id', sessionId);
}

beforeAll(async () => {
  // Bracket every rebinding so later integration files do not inherit them.
  container.snapshot();
  const db = await setupTestDatabase();
  const logger = new Logger('triage-production-path-test');
  const tokenRepo = new EmbeddedServiceTokenRepository(db, buildScmStub(), logger);
  container.rebind<EmbeddedServiceTokenRepository>(TYPES.EmbeddedServiceTokenRepository).toConstantValue(tokenRepo);

  ({ rawToken: rawServiceToken } = await tokenRepo.provisionInitialToken({
    tenantId: TENANT,
    platform: PLATFORM,
    platformAccountId: ACCOUNT,
  }));

  const { hostBootstrapRouter } = await import('../../src/routes/embedded/hostBootstrapRouter');
  app = express();
  mountCentralTenantGate(app, { strictMode: true, isDemoRuntime: () => false });
  app.use(express.json());
  app.use('/api/embedded/host-bootstrap', hostBootstrapRouter);
  app.use(syncErrorAssistRoutes);
});

afterAll(async () => {
  await teardownTestDatabase();
  container.restore();
});

beforeEach(async () => {
  await clearSyncErrorAssistTestState();
});

describe('triage on the production authorization path', () => {
  it('a session bootstrapped with a real admin grant and signed assertion can list suggestions', async () => {
    const grants = await container.getAsync<EmbeddedRoleGrantRepository>(TYPES.EmbeddedRoleGrantRepository);
    const userId = 'ns-user-admin';
    const { row, secret } = await grants.grant({
      tenant_id: TENANT,
      platform: PLATFORM,
      platform_account_id: ACCOUNT,
      user_id: userId,
      role: 'admin',
      source: 'squire_operator',
      granted_by: 'test-operator',
      expires_at: null,
    });
    const assertion = signUserAssertion({
      tenantId: TENANT,
      platform: PLATFORM,
      platformAccountId: ACCOUNT,
      userId,
      grantId: row.id,
      secret,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomBytes(16).toString('base64url'),
    });

    const boot = await bootstrap({ userId, assertion });
    expect(boot.status).toBe(200);

    await seedSuggestion({ tenantId: TENANT, errorRecordId: 'prod-path-e1' });
    const res = await listSuggestions(boot.body.sessionId as string);

    // Compared as one object so a failure prints the exact status and body.
    expect({ status: res.status, body: res.body }).toEqual({
      status: 200,
      body: { items: [expect.objectContaining({ errorRecordId: 'prod-path-e1' })] },
    });
  });

  it('host-asserted privileged roles without an assertion never authorize triage', async () => {
    const boot = await bootstrap({ userId: 'ns-user-claims-admin', userRoles: ['admin', 'ops', 'finance'] });
    expect(boot.status).toBe(200);

    await seedSuggestion({ tenantId: TENANT, errorRecordId: 'prod-path-e2' });
    const res = await listSuggestions(boot.body.sessionId as string);

    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ ok: false, code: 'insufficient_role' });
    expect(res.body.items).toBeUndefined();
  });

  it('an anonymous request reaches triage authorization, not the central TENANT_REQUIRED refusal', async () => {
    // The triage paths are exact trusted deferrals in the strict central gate,
    // so the route decides: no Origin and no session is the embedded path's
    // cross_origin_rejected, never the gate's 403 TENANT_REQUIRED.
    const res = await request(app).get('/api/sync-error-assist/suggestions');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'cross_origin_rejected' });
  });
});
