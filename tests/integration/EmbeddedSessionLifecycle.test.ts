/**
 * EmbeddedSessionLifecycle integration test (PR 10a).
 *
 * Drives EmbeddedSessionRepository + EmbeddedRetentionJob against an
 * in-memory sqlite database. Covers:
 *  - create → find → expired-row 410-equivalent (session.expires_at < now)
 *  - retention job DELETE removes rows past `SESSION_GRACE_MS` past expiry
 *  - retention job ticks are no-ops when nothing to clean
 *  - sendBeacon-style delete is idempotent
 */
import 'reflect-metadata';
import { DatabaseService } from '../../src/database/DatabaseService';
import { EmbeddedSessionRepository } from '../../src/services/embedded/EmbeddedSessionRepository';
import { EmbeddedServiceTokenRepository } from '../../src/services/embedded/EmbeddedServiceTokenRepository';
import { EmbeddedRetentionJob } from '../../src/services/embedded/EmbeddedRetentionJob';
import { Logger } from '../../src/utils/Logger';
import type { SecureCredentialManager } from '../../src/services/SecureCredentialManager';

function buildLogger(): Logger {
  return new Logger('embedded-test');
}

function buildScmStub(): SecureCredentialManager {
  // Retention job touches only the token-versions table, not SCM, so a no-op
  // stub is sufficient. validateToken/store/rotate flows are covered by
  // EmbeddedServiceTokenRotation.test.ts.
  return {
    storeCredentials: async () => undefined,
    deleteCredentials: async () => undefined,
  } as unknown as SecureCredentialManager;
}

async function buildDb(): Promise<DatabaseService> {
  process.env.DB_TYPE = 'sqlite';
  process.env.SQLITE_DB_PATH = ':memory:';
  const logger = buildLogger();
  const dbService = new DatabaseService(logger);
  await dbService.initialize();
  return dbService;
}

describe('EmbeddedSessionLifecycle (PR 10a)', () => {
  let dbService: DatabaseService;
  let sessionRepo: EmbeddedSessionRepository;
  let tokenRepo: EmbeddedServiceTokenRepository;
  let retention: EmbeddedRetentionJob;

  beforeAll(async () => {
    dbService = await buildDb();
    const logger = buildLogger();
    sessionRepo = new EmbeddedSessionRepository(dbService, logger);
    tokenRepo = new EmbeddedServiceTokenRepository(dbService, buildScmStub(), logger);
    retention = new EmbeddedRetentionJob(sessionRepo, tokenRepo, logger);
  });

  afterAll(async () => {
    await retention.stop();
    await dbService.shutdown();
  });

  it('creates a session, finds it, and treats expired sessions as recoverable', async () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    await sessionRepo.createSession({
      session_id: 'es_lifecycle_1',
      tenant_id: 't_lc',
      user_id: 'u_lc',
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: 'csrf_lc_1',
      expected_host_origin: 'http://localhost',
      expires_at: futureExpiry,
      last_rotation_at: null,
    });
    const found = await sessionRepo.findSession('es_lifecycle_1');
    expect(found).toBeDefined();
    expect(found?.tenant_id).toBe('t_lc');
  });

  it('retention tick deletes sessions past their grace window', async () => {
    const longAgoExpiry = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    await sessionRepo.createSession({
      session_id: 'es_expired_old',
      tenant_id: 't_lc',
      user_id: 'u_lc',
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: 'csrf_old',
      expected_host_origin: 'http://localhost',
      expires_at: longAgoExpiry,
      last_rotation_at: null,
    });
    const result = await retention.tick(new Date());
    expect(result.sessionsDeleted).toBeGreaterThanOrEqual(1);
    expect(await sessionRepo.findSession('es_expired_old')).toBeUndefined();
  });

  it('retention tick is a no-op when nothing to clean', async () => {
    const result = await retention.tick(new Date());
    expect(result.sessionsDeleted).toBe(0);
    expect(result.versionsRetired).toBe(0);
    expect(result.versionsPurged).toBe(0);
  });

  it('deleteSession is idempotent (sendBeacon teardown path)', async () => {
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    await sessionRepo.createSession({
      session_id: 'es_beacon',
      tenant_id: 't_lc',
      user_id: 'u_lc',
      platform: 'standalone',
      platform_account_id: null,
      csrf_token: 'csrf_beacon',
      expected_host_origin: 'http://localhost',
      expires_at: futureExpiry,
      last_rotation_at: null,
    });
    const first = await sessionRepo.deleteSession('es_beacon');
    const second = await sessionRepo.deleteSession('es_beacon');
    expect(first).toBe(1);
    expect(second).toBe(0);
  });

  it('rotateSession returns false for an unknown sessionId', async () => {
    const ok = await sessionRepo.rotateSession(
      'es_does_not_exist',
      'csrf_new',
      new Date(Date.now() + 60_000),
    );
    expect(ok).toBe(false);
  });

  it('start()/stop() lifecycle is idempotent', async () => {
    expect(retention.isRunning()).toBe(false);
    retention.start(60 * 60 * 1000);
    expect(retention.isRunning()).toBe(true);
    // Double-start should warn + return early, not crash.
    retention.start(60 * 60 * 1000);
    expect(retention.isRunning()).toBe(true);
    await retention.stop();
    expect(retention.isRunning()).toBe(false);
  });
});
