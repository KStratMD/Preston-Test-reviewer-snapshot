/**
 * The grant repository is the only writer of privileged roles. Before it, the
 * host-bootstrap request body was — a body carrying `["admin","approver"]`
 * returned 200 and both governance predicates answered true (measured
 * 2026-09-03).
 *
 * Two behaviours here are easy to get subtly wrong and are pinned deliberately:
 *
 * Renewal must CLOSE the row it replaces. The unique index is partial over
 * `revoked_at IS NULL`, so an expired-but-unrevoked grant still occupies the
 * slot; a renewal that only inserted would hit the constraint, and one that
 * relied on `expires_at` to step aside would leave two open rows the day the
 * index was ever relaxed.
 *
 * `listActiveRoles` must exclude expired rows even though they are unrevoked.
 * Expiry is invisible to the index but must not be invisible to authorization.
 */
import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { EmbeddedRoleGrantRepository, isExpired } from '../../../../src/services/embedded/EmbeddedRoleGrantRepository';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { Logger } from '../../../../src/utils/Logger';
import type { EncryptionService } from '../../../../src/services/security/EncryptionService';

/**
 * A reversible stand-in for EncryptionService. Deliberately NOT a no-op: the
 * test asserts the stored ciphertext does not contain the plaintext secret, so
 * a fake that returned its input would make that assertion vacuous.
 */
function fakeEncryption(): EncryptionService {
  return {
    encryptForStorage: async (plaintext: string) =>
      JSON.stringify({ v: 1, data: Buffer.from(plaintext, 'utf8').toString('base64') }),
    decryptFromStorage: async (json: string) =>
      Buffer.from((JSON.parse(json) as { data: string }).data, 'base64').toString('utf8'),
  } as unknown as EncryptionService;
}

function fakeLogger(): Logger {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;
}

const KEY = { tenantId: 't1', platform: 'netsuite', platformAccountId: 'a1', userId: 'u1' };

const ARGS = {
  tenant_id: 't1',
  platform: 'netsuite',
  platform_account_id: 'a1',
  user_id: 'u1',
  role: 'approver' as const,
  source: 'squire_operator' as const,
  granted_by: 'op',
  expires_at: null,
};

describe('EmbeddedRoleGrantRepository', () => {
  let db: Kysely<Database>;
  let repo: EmbeddedRoleGrantRepository;

  beforeEach(async () => {
    db = new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    for (const m of MIGRATIONS) await m.run(db, 'sqlite');
    const dbService = { getDatabase: () => db } as unknown as DatabaseService;
    repo = new EmbeddedRoleGrantRepository(dbService, fakeLogger(), fakeEncryption());
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('grants, lists and revokes, and never stores the secret in the clear', async () => {
    const { row, secret } = await repo.grant(ARGS);

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(row.secret_enc).not.toContain(secret);
    expect(await repo.listActiveRoles(KEY)).toEqual(['approver']);

    expect(await repo.revoke(row.id, 'op')).toBe(true);
    expect(await repo.listActiveRoles(KEY)).toEqual([]);
  });

  it('returns false when revoking a grant that is already closed or absent', async () => {
    const { row } = await repo.grant(ARGS);
    expect(await repo.revoke(row.id, 'op')).toBe(true);
    expect(await repo.revoke(row.id, 'op')).toBe(false);
    expect(await repo.revoke('erg_does_not_exist', 'op')).toBe(false);
  });

  it('ignores expired grants and renews by closing the old row', async () => {
    const { row: old } = await repo.grant({ ...ARGS, expires_at: '2000-01-01T00:00:00.000Z' });
    expect(await repo.listActiveRoles(KEY)).toEqual([]);

    const { row: renewed } = await repo.grant(ARGS);
    expect(await repo.listActiveRoles(KEY)).toEqual(['approver']);

    const closed = await db
      .selectFrom('embedded_role_grants')
      .selectAll()
      .where('id', '=', old.id)
      .executeTakeFirstOrThrow();
    expect(closed.revoked_by).toBe(`replaced:${renewed.id}`);
    expect(closed.revoked_at).not.toBeNull();
  });

  it('is scoped by tenant and by platform account', async () => {
    await repo.grant({ ...ARGS, user_id: 'u3' });
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u3' })).toEqual(['approver']);
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u3', tenantId: 't2' })).toEqual([]);
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u3', platformAccountId: 'a9' })).toEqual([]);
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u3', platform: 'business_central' })).toEqual([]);
  });

  it('a viewer grant does not make the user a verified requester', async () => {
    await repo.grant({ ...ARGS, user_id: 'u4', role: 'viewer' });
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u4' })).toEqual(['viewer']);
  });

  it('lists multiple distinct roles for one user in a stable order', async () => {
    await repo.grant({ ...ARGS, user_id: 'u5', role: 'approver' });
    await repo.grant({ ...ARGS, user_id: 'u5', role: 'viewer' });
    expect(await repo.listActiveRoles({ ...KEY, userId: 'u5' })).toEqual(['approver', 'viewer']);
  });

  describe('getActiveGrant', () => {
    it('returns the row with its ciphertext while the grant is open and unexpired', async () => {
      const { row } = await repo.grant(ARGS);
      const active = await repo.getActiveGrant(row.id);
      expect(active).not.toBeNull();
      expect(active!.id).toBe(row.id);
      expect(active!.secret_enc).toBe(row.secret_enc);
    });

    it('returns null once the grant is revoked', async () => {
      const { row } = await repo.grant(ARGS);
      await repo.revoke(row.id, 'op');
      expect(await repo.getActiveGrant(row.id)).toBeNull();
    });

    it('returns null once the grant has expired, though the row is still open', async () => {
      const { row } = await repo.grant({ ...ARGS, user_id: 'u6', expires_at: '2000-01-01T00:00:00.000Z' });
      expect(await repo.getActiveGrant(row.id)).toBeNull();

      // Still an OPEN row — expiry does not free the unique-index slot.
      const stored = await db
        .selectFrom('embedded_role_grants')
        .selectAll()
        .where('id', '=', row.id)
        .executeTakeFirstOrThrow();
      expect(stored.revoked_at).toBeNull();
    });

    it('returns null for an unknown id', async () => {
      expect(await repo.getActiveGrant('erg_nope')).toBeNull();
    });

    it('treats expiry as strictly past, evaluated against the supplied clock', async () => {
      const { row } = await repo.grant({ ...ARGS, user_id: 'u7', expires_at: '2030-01-01T00:00:00.000Z' });
      expect(await repo.getActiveGrant(row.id, new Date('2029-12-31T23:59:59.000Z'))).not.toBeNull();
      expect(await repo.getActiveGrant(row.id, new Date('2030-01-02T00:00:00.000Z'))).toBeNull();
    });
  });

  describe('expiry is compared as an instant, not as a string', () => {
    // The column is TEXT on SQLite and TIMESTAMPTZ on Postgres, so a row can
    // arrive as a Date. String(date) is "Wed Sep 03 2026 ..." — lexically
    // GREATER than any ISO timestamp — so a string comparison reported every
    // expired grant on Postgres as still active, which is the direction that
    // silently keeps a time-revoked approver approving.
    //
    // The predicate is tested directly because SQLite cannot bind a Date, so
    // the Postgres row shape cannot be produced through the repository's own
    // in-memory database at all.
    const NOW = new Date('2026-09-03T12:00:00.000Z');

    it('handles the Postgres shape (Date) in both directions', () => {
      expect(isExpired(new Date('2000-01-01T00:00:00.000Z'), NOW)).toBe(true);
      expect(isExpired(new Date('2099-01-01T00:00:00.000Z'), NOW)).toBe(false);
    });

    it('handles the SQLite shape (ISO string) in both directions', () => {
      expect(isExpired('2000-01-01T00:00:00.000Z', NOW)).toBe(true);
      expect(isExpired('2099-01-01T00:00:00.000Z', NOW)).toBe(false);
    });

    it('would have been wrong under a string comparison', () => {
      // The exact regression: String(Date) sorts above every ISO timestamp, so
      // `String(expires_at) > nowIso` answered "still active" for a date two
      // decades past. Asserting the old expression here keeps the reason this
      // predicate exists from being lost to a later simplification.
      const pgExpired = new Date('2000-01-01T00:00:00.000Z');
      expect(String(pgExpired) > NOW.toISOString()).toBe(true); // the old, wrong answer
      expect(isExpired(pgExpired, NOW)).toBe(true); // the correct one
    });

    it('treats a null expiry as never expiring', () => {
      expect(isExpired(null, NOW)).toBe(false);
    });

    it('fails closed on an unparseable expiry', () => {
      expect(isExpired('not-a-timestamp', NOW)).toBe(true);
      expect(isExpired(new Date('nonsense'), NOW)).toBe(true);
    });

    it('is inclusive at the boundary — expiry exactly now counts as expired', () => {
      expect(isExpired(NOW.toISOString(), NOW)).toBe(true);
      expect(isExpired(new Date(NOW.getTime() + 1), NOW)).toBe(false);
    });

    it('fails closed through the repository too, for a stored unparseable value', async () => {
      const { row } = await repo.grant({ ...ARGS, user_id: 'u_garbage' });
      await db
        .updateTable('embedded_role_grants')
        .set({ expires_at: 'not-a-timestamp' })
        .where('id', '=', row.id)
        .execute();

      expect(await repo.getActiveGrant(row.id)).toBeNull();
      expect(await repo.listActiveRoles({ ...KEY, userId: 'u_garbage' })).toEqual([]);
    });
  });

  it('mints a distinct secret per grant', async () => {
    const a = await repo.grant({ ...ARGS, user_id: 'u8' });
    const b = await repo.grant({ ...ARGS, user_id: 'u9' });
    expect(a.secret).not.toBe(b.secret);
    expect(a.row.secret_enc).not.toBe(b.row.secret_enc);
  });

  it('does not log the secret', async () => {
    const logger = fakeLogger();
    const dbService = { getDatabase: () => db } as unknown as DatabaseService;
    const r = new EmbeddedRoleGrantRepository(dbService, logger, fakeEncryption());
    const { secret } = await r.grant({ ...ARGS, user_id: 'u10' });

    const logged = JSON.stringify([
      (logger.info as jest.Mock).mock.calls,
      (logger.debug as jest.Mock).mock.calls,
      (logger.warn as jest.Mock).mock.calls,
      (logger.error as jest.Mock).mock.calls,
    ]);
    expect(logged).not.toContain(secret);
  });
});
