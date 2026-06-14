/**
 * embeddedHostHandshake integration test (PR 10a).
 *
 * Mounts the three embedded routers on a bare Express app and drives the
 * end-to-end handshake via supertest:
 *   1. host-bootstrap with valid service-token → 200 + sessionId/csrfToken/embedSrc
 *   2. host-bootstrap with invalid token       → 401
 *   3. host-bootstrap with platform mismatch   → 401 (collapsed for probing)
 *   4. guest context-fetch with valid sessionId → 200 + EmbeddedContext
 *   5. guest context-fetch with non-existent sessionId → 404
 *   6. session teardown DELETE with sessionId mismatch → 400
 *
 * Bootstraps a real in-memory sqlite DB + real EmbeddedServiceTokenRepository
 * with a stubbed SecureCredentialManager (no real secret store needed for
 * the handshake — token_hash lookup is the hot path).
 */
import 'reflect-metadata';
import express from 'express';
import request from 'supertest';
import { DatabaseService } from '../../src/database/DatabaseService';
import { EmbeddedSessionRepository } from '../../src/services/embedded/EmbeddedSessionRepository';
import { EmbeddedServiceTokenRepository } from '../../src/services/embedded/EmbeddedServiceTokenRepository';
import { Logger } from '../../src/utils/Logger';
import { container } from '../../src/inversify/inversify.config';
import { TYPES } from '../../src/inversify/types';
import type { SecureCredentialManager } from '../../src/services/SecureCredentialManager';

function buildScmStub(): SecureCredentialManager {
  return {
    storeCredentials: async () => undefined,
    deleteCredentials: async () => undefined,
  } as unknown as SecureCredentialManager;
}

async function buildApp(): Promise<{
  app: express.Express;
  tokenRepo: EmbeddedServiceTokenRepository;
  sessionRepo: EmbeddedSessionRepository;
  dbService: DatabaseService;
}> {
  process.env.DB_TYPE = 'sqlite';
  process.env.SQLITE_DB_PATH = ':memory:';
  process.env.NODE_ENV = 'test';
  const logger = new Logger('embedded-handshake-test');
  const dbService = new DatabaseService(logger);
  await dbService.initialize();

  const sessionRepo = new EmbeddedSessionRepository(dbService, logger);
  const tokenRepo = new EmbeddedServiceTokenRepository(dbService, buildScmStub(), logger);

  // Override container bindings with the test instances so the route handlers
  // (which call container.get(...) inside) see our wired repos.
  if (container.isBound(TYPES.EmbeddedSessionRepository)) {
    container.unbind(TYPES.EmbeddedSessionRepository);
  }
  if (container.isBound(TYPES.EmbeddedServiceTokenRepository)) {
    container.unbind(TYPES.EmbeddedServiceTokenRepository);
  }
  container.bind<EmbeddedSessionRepository>(TYPES.EmbeddedSessionRepository).toConstantValue(sessionRepo);
  container.bind<EmbeddedServiceTokenRepository>(TYPES.EmbeddedServiceTokenRepository).toConstantValue(tokenRepo);

  const { hostBootstrapRouter } = await import('../../src/routes/embedded/hostBootstrapRouter');
  const { contextBootstrapRouter } = await import('../../src/routes/embedded/contextBootstrapRouter');
  const { sessionTeardownRouter } = await import('../../src/routes/embedded/sessionTeardownRouter');

  const app = express();
  app.use(express.json());
  app.use('/api/embedded/host-bootstrap', hostBootstrapRouter);
  app.use('/api/embedded/context', contextBootstrapRouter);
  app.use('/api/embedded/sessions', sessionTeardownRouter);

  return { app, tokenRepo, sessionRepo, dbService };
}

describe('Embedded host handshake (PR 10a)', () => {
  let app: express.Express;
  let tokenRepo: EmbeddedServiceTokenRepository;
  let dbService: DatabaseService;

  beforeAll(async () => {
    const built = await buildApp();
    app = built.app;
    tokenRepo = built.tokenRepo;
    dbService = built.dbService;
  });

  afterAll(async () => {
    await dbService.shutdown();
  });

  // NetSuite host origin used by every NetSuite test below — round-2
  // BLOCKS-MERGE #8 requires non-standalone bootstraps to supply this.
  const NS_ORIGIN = 'https://12345.app.netsuite.com';

  it('host-bootstrap with valid NetSuite service-token returns sessionId/csrfToken/embedSrc', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_ns',
      platform: 'netsuite',
      platformAccountId: 'acct_ns_001',
    });
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_ns_001',
        expectedHostOrigin: NS_ORIGIN,
      });
    expect(response.status).toBe(200);
    expect(response.body.sessionId).toMatch(/^es_/);
    expect(response.body.csrfToken).toMatch(/^csrf_/);
    expect(response.body.embedSrc).toContain('embeddedContextId=');
    expect(response.body.sessionExpiresAt).toBeDefined();
  });

  it('host-bootstrap for NetSuite WITHOUT expectedHostOrigin returns 400 (round-2 #8)', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_ns_no_origin',
      platform: 'netsuite',
      platformAccountId: 'acct_ns_no_origin',
    });
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({ platformAccountId: 'acct_ns_no_origin' });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_expected_host_origin');
  });

  it('host-bootstrap with off-allowlist expectedHostOrigin returns 400', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_bad_origin',
      platform: 'netsuite',
      platformAccountId: 'acct_bad_origin',
    });
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_bad_origin',
        expectedHostOrigin: 'https://attacker.example.test',
      });
    expect(response.status).toBe(400);
  });

  it('host-bootstrap with revoked token returns 401', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_revoked',
      platform: 'netsuite',
      platformAccountId: 'acct_revoked_001',
    });
    await tokenRepo.revokeAllForTenant('t_handshake_revoked');
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_revoked_001',
        expectedHostOrigin: NS_ORIGIN,
      });
    expect(response.status).toBe(401);
  });

  it('host-bootstrap with platform header mismatch returns 401 (collapsed)', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_xref',
      platform: 'netsuite',
      platformAccountId: 'acct_xref_001',
    });
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'business_central')
      .send({
        platformAccountId: 'acct_xref_001',
        expectedHostOrigin: 'https://test.dynamics.com',
      });
    expect(response.status).toBe(401);
  });

  it('host-bootstrap missing X-Embedded-Platform returns 400', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_missing_platform',
      platform: 'netsuite',
      platformAccountId: 'acct_mp_001',
    });
    const response = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .send({ platformAccountId: 'acct_mp_001' });
    expect(response.status).toBe(400);
  });

  it('guest context-fetch with valid sessionId returns matching EmbeddedContext', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_guest',
      platform: 'netsuite',
      platformAccountId: 'acct_guest_001',
    });
    const bootstrap = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_guest_001',
        expectedHostOrigin: NS_ORIGIN,
      });
    expect(bootstrap.status).toBe(200);
    const sessionId = bootstrap.body.sessionId as string;
    const csrfToken = bootstrap.body.csrfToken as string;
    const guest = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', sessionId)
      .send({});
    expect(guest.status).toBe(200);
    expect(guest.body.sessionId).toBe(sessionId);
    expect(guest.body.csrfToken).toBe(csrfToken);
    expect(guest.body.tenantId).toBe('t_handshake_guest');
    expect(guest.body.platform).toBe('netsuite');
  });

  it('guest context-fetch with unknown sessionId returns 404', async () => {
    const response = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', 'es_does_not_exist_xxx')
      .send({});
    expect(response.status).toBe(404);
  });

  it('guest context-fetch WITHOUT Origin header is rejected (round-2 #5)', async () => {
    const response = await request(app)
      .post('/api/embedded/context')
      .set('X-Embedded-Session-Id', 'es_anything')
      .send({});
    expect(response.status).toBe(403);
    expect(response.body.error).toBe('cross_origin_rejected');
  });

  it('session teardown with X-Embedded-Session-Id mismatching :id returns 400', async () => {
    const response = await request(app)
      .delete('/api/embedded/sessions/es_path_id')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', 'es_header_id_different')
      .send();
    expect(response.status).toBe(400);
  });

  it('session teardown for unknown session returns 404 (not silent 200)', async () => {
    const response = await request(app)
      .delete('/api/embedded/sessions/es_forged_xxx')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', 'es_forged_xxx')
      .send();
    expect(response.status).toBe(404);
  });

  it('ERP record context flows host-bootstrap → guest context (scenario 13)', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_erp',
      platform: 'netsuite',
      platformAccountId: 'acct_erp_001',
    });
    const bootstrap = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_erp_001',
        expectedHostOrigin: NS_ORIGIN,
        erpRecord: {
          type: 'invoice',
          id: '12345',
          url: 'https://12345.app.netsuite.com/app/accounting/transactions/invoice.nl?id=12345',
        },
      });
    expect(bootstrap.status).toBe(200);
    const guest = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', bootstrap.body.sessionId)
      .send({});
    expect(guest.status).toBe(200);
    expect(guest.body.erpRecord).toEqual({
      type: 'invoice',
      id: '12345',
      url: 'https://12345.app.netsuite.com/app/accounting/transactions/invoice.nl?id=12345',
    });
  });

  it('ERP record absent on host-bootstrap omits erpRecord from EmbeddedContext', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_no_erp',
      platform: 'netsuite',
      platformAccountId: 'acct_no_erp_001',
    });
    const bootstrap = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_no_erp_001',
        expectedHostOrigin: NS_ORIGIN,
      });
    expect(bootstrap.status).toBe(200);
    const guest = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', bootstrap.body.sessionId)
      .send({});
    expect(guest.status).toBe(200);
    expect(guest.body.erpRecord).toBeUndefined();
  });

  it('userRoles flow host-bootstrap → guest context (round-2 #6)', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_roles',
      platform: 'netsuite',
      platformAccountId: 'acct_roles_001',
    });
    const bootstrap = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_roles_001',
        expectedHostOrigin: NS_ORIGIN,
        userId: 'u_finance_lead',
        userRoles: ['finance', 'approver'],
      });
    expect(bootstrap.status).toBe(200);
    const guest = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', bootstrap.body.sessionId)
      .send({});
    expect(guest.status).toBe(200);
    expect(guest.body.userId).toBe('u_finance_lead');
    expect(guest.body.userRoles).toEqual(['finance', 'approver']);
  });

  it('userRoles defaults to empty array when not supplied', async () => {
    const { rawToken } = await tokenRepo.provisionInitialToken({
      tenantId: 't_handshake_no_roles',
      platform: 'netsuite',
      platformAccountId: 'acct_no_roles_001',
    });
    const bootstrap = await request(app)
      .post('/api/embedded/host-bootstrap')
      .set('Authorization', `Bearer ${rawToken}`)
      .set('X-Embedded-Platform', 'netsuite')
      .send({
        platformAccountId: 'acct_no_roles_001',
        expectedHostOrigin: NS_ORIGIN,
      });
    const guest = await request(app)
      .post('/api/embedded/context')
      .set('Origin', 'http://127.0.0.1')
      .set('X-Embedded-Session-Id', bootstrap.body.sessionId)
      .send({});
    expect(guest.body.userRoles).toEqual([]);
  });
});
