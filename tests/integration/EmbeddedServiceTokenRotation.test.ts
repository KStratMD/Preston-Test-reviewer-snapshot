/**
 * EmbeddedServiceTokenRotation integration test (PR 10a).
 *
 * Pins the round-7 + round-8 invariants on the dual-store rotation flow:
 *  - rotateToken inserts a new active row + retires the previous to a
 *    24h overlap window (default)
 *  - validateToken accepts BOTH old and new during the overlap window
 *  - validateToken rejects the old token after overlap expires
 *  - revokeAllForTenant marks every non-retired row retired_at=now AND
 *    purges the SCM raw token (subsequent validateToken on either token
 *    returns null)
 *  - validateToken cross-checks platform header + platformAccountId
 */
import 'reflect-metadata';
import { DatabaseService } from '../../src/database/DatabaseService';
import {
  EmbeddedServiceTokenRepository,
  DEFAULT_ROTATION_OVERLAP_MS,
} from '../../src/services/embedded/EmbeddedServiceTokenRepository';
import { Logger } from '../../src/utils/Logger';
import type { SecureCredentialManager } from '../../src/services/SecureCredentialManager';

function buildLogger(): Logger {
  return new Logger('embedded-token-test');
}

function buildScmStub(): { scm: SecureCredentialManager; calls: { stored: number; deleted: number } } {
  const calls = { stored: 0, deleted: 0 };
  const scm = {
    storeCredentials: async () => {
      calls.stored++;
    },
    deleteCredentials: async () => {
      calls.deleted++;
    },
  } as unknown as SecureCredentialManager;
  return { scm, calls };
}

async function buildDb(): Promise<DatabaseService> {
  process.env.DB_TYPE = 'sqlite';
  process.env.SQLITE_DB_PATH = ':memory:';
  const dbService = new DatabaseService(buildLogger());
  await dbService.initialize();
  return dbService;
}

describe('EmbeddedServiceTokenRepository — rotation + revocation (PR 10a)', () => {
  let dbService: DatabaseService;
  let scmCalls: { stored: number; deleted: number };
  let repo: EmbeddedServiceTokenRepository;

  beforeAll(async () => {
    dbService = await buildDb();
    const stub = buildScmStub();
    scmCalls = stub.calls;
    repo = new EmbeddedServiceTokenRepository(dbService, stub.scm, buildLogger());
  });

  afterAll(async () => {
    await dbService.shutdown();
  });

  it('generates sct_-prefixed base64url tokens', () => {
    const t = EmbeddedServiceTokenRepository.generateRawToken();
    expect(t).toMatch(/^sct_[A-Za-z0-9_-]{43}$/);
    const t2 = EmbeddedServiceTokenRepository.generateRawToken();
    expect(t).not.toBe(t2);
  });

  it('provisionInitialToken stores both versions row + SCM raw', async () => {
    const before = scmCalls.stored;
    const { rawToken } = await repo.provisionInitialToken({
      tenantId: 't_initial',
      platform: 'netsuite',
      platformAccountId: 'acct_init_001',
    });
    expect(rawToken.startsWith('sct_')).toBe(true);
    expect(scmCalls.stored).toBe(before + 1);
    const validated = await repo.validateToken({
      rawToken,
      expectedPlatform: 'netsuite',
      expectedPlatformAccountId: 'acct_init_001',
    });
    expect(validated).not.toBeNull();
    expect(validated?.tenant_id).toBe('t_initial');
  });

  it('rotateToken: both old and new tokens validate during overlap window', async () => {
    const { rawToken: oldRaw } = await repo.provisionInitialToken({
      tenantId: 't_rotate',
      platform: 'netsuite',
      platformAccountId: 'acct_rotate_001',
    });
    const { rawToken: newRaw } = await repo.rotateToken({
      tenantId: 't_rotate',
      platform: 'netsuite',
      platformAccountId: 'acct_rotate_001',
    });
    expect(newRaw).not.toBe(oldRaw);
    const oldOk = await repo.validateToken({
      rawToken: oldRaw,
      expectedPlatform: 'netsuite',
      expectedPlatformAccountId: 'acct_rotate_001',
    });
    const newOk = await repo.validateToken({
      rawToken: newRaw,
      expectedPlatform: 'netsuite',
      expectedPlatformAccountId: 'acct_rotate_001',
    });
    expect(oldOk).not.toBeNull();
    expect(newOk).not.toBeNull();
  });

  it('rotateToken: old token rejected after overlap window expires', async () => {
    const { rawToken: oldRaw } = await repo.provisionInitialToken({
      tenantId: 't_rotate_post',
      platform: 'business_central',
      platformAccountId: 'env_post_001',
    });
    await repo.rotateToken({
      tenantId: 't_rotate_post',
      platform: 'business_central',
      platformAccountId: 'env_post_001',
    });
    // Simulate "now" past the overlap window.
    const futureNow = new Date(Date.now() + DEFAULT_ROTATION_OVERLAP_MS + 60_000);
    const oldExpired = await repo.validateToken({
      rawToken: oldRaw,
      expectedPlatform: 'business_central',
      expectedPlatformAccountId: 'env_post_001',
      now: futureNow,
    });
    expect(oldExpired).toBeNull();
  });

  it('revokeAllForTenant: both tokens fail validation immediately', async () => {
    const { rawToken: oldRaw } = await repo.provisionInitialToken({
      tenantId: 't_revoke',
      platform: 'netsuite',
      platformAccountId: 'acct_revoke_001',
    });
    const { rawToken: newRaw } = await repo.rotateToken({
      tenantId: 't_revoke',
      platform: 'netsuite',
      platformAccountId: 'acct_revoke_001',
    });
    const beforeDelete = scmCalls.deleted;
    const versionsRevoked = await repo.revokeAllForTenant('t_revoke');
    expect(versionsRevoked).toBeGreaterThanOrEqual(2);
    expect(scmCalls.deleted).toBe(beforeDelete + 1);
    expect(
      await repo.validateToken({
        rawToken: oldRaw,
        expectedPlatform: 'netsuite',
        expectedPlatformAccountId: 'acct_revoke_001',
      }),
    ).toBeNull();
    expect(
      await repo.validateToken({
        rawToken: newRaw,
        expectedPlatform: 'netsuite',
        expectedPlatformAccountId: 'acct_revoke_001',
      }),
    ).toBeNull();
  });

  it('validateToken rejects on platform header mismatch', async () => {
    const { rawToken } = await repo.provisionInitialToken({
      tenantId: 't_xref',
      platform: 'netsuite',
      platformAccountId: 'acct_xref_001',
    });
    const result = await repo.validateToken({
      rawToken,
      expectedPlatform: 'business_central', // wrong
      expectedPlatformAccountId: 'acct_xref_001',
    });
    expect(result).toBeNull();
  });

  it('validateToken rejects on platformAccountId mismatch', async () => {
    const { rawToken } = await repo.provisionInitialToken({
      tenantId: 't_xref_acct',
      platform: 'netsuite',
      platformAccountId: 'acct_correct',
    });
    const result = await repo.validateToken({
      rawToken,
      expectedPlatform: 'netsuite',
      expectedPlatformAccountId: 'acct_wrong',
    });
    expect(result).toBeNull();
  });

  it('provisionInitialToken throws if a current token already exists', async () => {
    await repo.provisionInitialToken({
      tenantId: 't_dup',
      platform: 'netsuite',
      platformAccountId: 'acct_dup',
    });
    await expect(
      repo.provisionInitialToken({
        tenantId: 't_dup',
        platform: 'netsuite',
        platformAccountId: 'acct_dup',
      }),
    ).rejects.toThrow(/already provisioned/i);
  });

  it('retireExpiredVersions + purgeForensicallyRetired clean stale rows', async () => {
    // Provision + immediately rotate so the first version becomes overlap-windowed.
    await repo.provisionInitialToken({
      tenantId: 't_retire',
      platform: 'netsuite',
      platformAccountId: 'acct_retire',
    });
    await repo.rotateToken({
      tenantId: 't_retire',
      platform: 'netsuite',
      platformAccountId: 'acct_retire',
    });
    // Force the previous version's valid_until into the past via a synthetic now.
    const future = new Date(Date.now() + DEFAULT_ROTATION_OVERLAP_MS + 60_000);
    const retired = await repo.retireExpiredVersions(future);
    expect(retired).toBeGreaterThanOrEqual(1);
    // Nothing forensically purgeable yet (just retired), but the call should not throw.
    const purged = await repo.purgeForensicallyRetired(future, 7 * 24 * 60 * 60 * 1000);
    expect(purged).toBe(0);
    // 8 days later: the retired rows should be eligible for forensic purge.
    const farFuture = new Date(future.getTime() + 8 * 24 * 60 * 60 * 1000);
    const purgedLate = await repo.purgeForensicallyRetired(farFuture, 7 * 24 * 60 * 60 * 1000);
    expect(purgedLate).toBeGreaterThanOrEqual(1);
  });
});
