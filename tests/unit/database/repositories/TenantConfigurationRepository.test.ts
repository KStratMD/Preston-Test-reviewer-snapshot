import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { SecretManager, SecretValue } from '../../../../src/services/SecretManager';
import type { Logger } from '../../../../src/utils/Logger';
import { migration as createTenantConfigs } from '../../../../src/database/migrations/008-create-tenant-configurations-table';
import { migration as addTenantConfigIndex } from '../../../../src/database/migrations/034-add-tenant-configurations-key-value-index';
import { TenantConfigurationRepository } from '../../../../src/database/repositories/TenantConfigurationRepository';

// Mirrors DatabaseService.ts:108-113 — better-sqlite3 rejects native boolean/Date
// parameters by default. Production code goes through DatabaseService's adapter,
// which converts these at the driver layer; this test bypasses DatabaseService,
// so we apply the same conversion locally.
function patchBooleansAndDates(sqlite: BetterSqlite3.Database): BetterSqlite3.Database {
  const isPlainObject = (v: unknown) => Object.prototype.toString.call(v) === '[object Object]';
  const convert = (value: unknown): unknown => {
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (value == null) return value;
    if (Array.isArray(value)) return value.map(convert);
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof Date) return value.toISOString();
    if (isPlainObject(value)) {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) out[k] = convert(v);
      return out;
    }
    return value;
  };
  const originalPrepare = sqlite.prepare.bind(sqlite);
  (sqlite as unknown as { prepare: (s: string) => unknown }).prepare = (source: string) => {
    const stmt = originalPrepare(source) as unknown as Record<string, unknown>;
    for (const name of ['run', 'get', 'all', 'iterate', 'bind']) {
      const method = stmt[name];
      if (typeof method !== 'function') continue;
      const original = (method as (...a: unknown[]) => unknown).bind(stmt);
      stmt[name] = (...args: unknown[]) => original(...args.map(convert));
    }
    return stmt;
  };
  return sqlite;
}

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: patchBooleansAndDates(new BetterSqlite3(':memory:')) }),
  });
}

interface MockSecretManager extends Pick<SecretManager, 'getSecret' | 'setSecret'> {
  getSecret: jest.Mock<Promise<SecretValue>, [string, unknown?]>;
  setSecret: jest.Mock<Promise<void>, [string, string, unknown?]>;
  // In-memory store backing the default mock implementations.
  _store: Map<string, string>;
}

function makeSecretManagerMock(): MockSecretManager {
  const store = new Map<string, string>();
  const mock: MockSecretManager = {
    _store: store,
    getSecret: jest.fn(async (name: string) => {
      if (!store.has(name)) throw new Error(`secret '${name}' not found`);
      return { value: store.get(name) as string };
    }),
    setSecret: jest.fn(async (name: string, value: string) => {
      store.set(name, value);
    }),
  };
  return mock;
}

/** Shape of the logger mock used in this test file — captures the methods
 *  the repo actually calls plus the required `withCorrelationId` chainer.
 *  Used so the makeRepo() signature carries type info instead of `never`. */
type LoggerMock = {
  info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock;
  withCorrelationId: jest.Mock;
};

function makeRepo(
  db: Kysely<Database>,
  secretManager: MockSecretManager,
  logger: LoggerMock,
): TenantConfigurationRepository {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  return new TenantConfigurationRepository(
    databaseService,
    secretManager as unknown as SecretManager,
    logger as unknown as Logger,
  );
}

const SECRET_NAME_RE = /^tenant-config-[0-9a-f]{16}-[0-9a-f]{16}$/;

describe('TenantConfigurationRepository', () => {
  let db: Kysely<Database>;
  let repo: TenantConfigurationRepository;
  let secretManager: MockSecretManager;
  const mockLogger = {
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    withCorrelationId: jest.fn().mockReturnThis(),
  };

  beforeEach(async () => {
    db = makeDb();
    await createTenantConfigs.run(db, 'sqlite');
    await addTenantConfigIndex.run(db, 'sqlite');
    secretManager = makeSecretManagerMock();
    // Pass logger via constructor (3rd arg, @optional) instead of mutating
    // a private field — keeps the test honest about the public API.
    repo = makeRepo(db, secretManager, mockLogger);
    jest.clearAllMocks();
  });

  afterEach(async () => { await db.destroy(); });

  describe('getBoolean', () => {
    it('returns false when setting key is missing', async () => {
      expect(await repo.getBoolean('t1', 'missing.key')).toBe(false);
    });

    it('returns true ONLY when setting_value === "true"', async () => {
      await repo.upsert('t1', 'flag.a', 'true');
      await repo.upsert('t1', 'flag.b', 'TRUE');
      await repo.upsert('t1', 'flag.c', '1');
      await repo.upsert('t1', 'flag.d', 'yes');
      expect(await repo.getBoolean('t1', 'flag.a')).toBe(true);
      expect(await repo.getBoolean('t1', 'flag.b')).toBe(false);
      expect(await repo.getBoolean('t1', 'flag.c')).toBe(false);
      expect(await repo.getBoolean('t1', 'flag.d')).toBe(false);
    });

    it('resolves encrypted boolean through SecretManager', async () => {
      await repo.upsert('t1', 'flag.enc', 'true', { isEncrypted: true });
      expect(await repo.getBoolean('t1', 'flag.enc')).toBe(true);
      expect(secretManager.getSecret).toHaveBeenCalledWith(
        expect.stringMatching(SECRET_NAME_RE),
      );
    });
  });

  describe('getBooleanStrict (plaintext-only, fail-closed)', () => {
    it('returns false for missing row (absent setting = deny)', async () => {
      expect(await repo.getBooleanStrict('t1', 'missing.key')).toBe(false);
    });

    it('returns true only when plaintext setting_value === "true"', async () => {
      await repo.upsert('t1', 'strict.a', 'true');
      await repo.upsert('t1', 'strict.b', 'false');
      await repo.upsert('t1', 'strict.c', 'TRUE');
      expect(await repo.getBooleanStrict('t1', 'strict.a')).toBe(true);
      expect(await repo.getBooleanStrict('t1', 'strict.b')).toBe(false);
      expect(await repo.getBooleanStrict('t1', 'strict.c')).toBe(false);
    });

    it('throws when row is encrypted (caller must store gate as plaintext)', async () => {
      await repo.upsert('t1', 'flag.enc', 'true', { isEncrypted: true });
      await expect(repo.getBooleanStrict('t1', 'flag.enc')).rejects.toThrow(
        /must be stored as plaintext/,
      );
      // The strict path must NOT consult the SecretManager — that would
      // defeat the purpose (SecretManager failures would still surface
      // here, but as a separate failure mode).
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });

    it('does not consult SecretManager on the plaintext happy path', async () => {
      await repo.upsert('t1', 'strict.plain', 'true');
      jest.clearAllMocks();
      await repo.getBooleanStrict('t1', 'strict.plain');
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });
  });

  describe('getInt', () => {
    it('returns null when missing', async () => {
      expect(await repo.getInt('t1', 'missing')).toBeNull();
    });

    it('returns parsed integer for numeric values', async () => {
      await repo.upsert('t1', 'count', '30');
      expect(await repo.getInt('t1', 'count')).toBe(30);
    });

    it('returns null for non-numeric values', async () => {
      await repo.upsert('t1', 'bad', 'thirty');
      expect(await repo.getInt('t1', 'bad')).toBeNull();
    });

    it('resolves encrypted int through SecretManager', async () => {
      await repo.upsert('t1', 'count.enc', '42', { isEncrypted: true });
      expect(await repo.getInt('t1', 'count.enc')).toBe(42);
      expect(secretManager.getSecret).toHaveBeenCalledWith(
        expect.stringMatching(SECRET_NAME_RE),
      );
    });
  });

  describe('getString', () => {
    it('returns null when missing', async () => {
      expect(await repo.getString('t1', 'missing')).toBeNull();
    });

    it('returns raw setting_value when not encrypted', async () => {
      await repo.upsert('t1', 'name', 'hello');
      expect(await repo.getString('t1', 'name')).toBe('hello');
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });

    it('round-trips plaintext through SecretManager when is_encrypted=true', async () => {
      await repo.upsert('t1', 'sec', 'plaintext-value', { isEncrypted: true });
      expect(await repo.getString('t1', 'sec')).toBe('plaintext-value');
      // upsert called setSecret with the deterministic name; getString called getSecret with the same name
      expect(secretManager.setSecret).toHaveBeenCalledWith(
        expect.stringMatching(SECRET_NAME_RE),
        'plaintext-value',
      );
      const setName = secretManager.setSecret.mock.calls[0][0];
      expect(secretManager.getSecret).toHaveBeenCalledWith(setName);
    });

    it('returns null and logs error when SecretManager.getSecret throws', async () => {
      await repo.upsert('t1', 'sec', 'plaintext', { isEncrypted: true });
      const thrownError = new Error('backend unavailable');
      secretManager.getSecret.mockRejectedValueOnce(thrownError);
      const result = await repo.getString('t1', 'sec');
      expect(result).toBeNull();
      // Logger.error(message, error?, metadata) — Error is 2nd arg (attached
      // to context.error by Logger), metadata is 3rd arg.
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('decrypt'),
        thrownError,
        expect.objectContaining({ tenantId: 't1', settingKey: 'sec' }),
      );
    });

    it('coerces non-Error rejection values via the Logger error arg', async () => {
      await repo.upsert('t1', 'sec', 'plaintext', { isEncrypted: true });
      // Throw a plain string — Logger.error's `error instanceof Error` check
      // drops non-Error values cleanly (they don't become `context.error`).
      // We still pass `err` as the 2nd arg per the signature; the metadata
      // (tenantId/settingKey) goes in the 3rd arg and is emitted regardless.
      secretManager.getSecret.mockRejectedValueOnce('non-Error rejection');
      const result = await repo.getString('t1', 'sec');
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('decrypt'),
        'non-Error rejection',
        expect.objectContaining({ tenantId: 't1', settingKey: 'sec' }),
      );
    });

    it('does not store plaintext in the DB row when is_encrypted=true', async () => {
      await repo.upsert('t1', 'sec', 'plaintext-must-not-be-in-db', { isEncrypted: true });
      const row = await db
        .selectFrom('tenant_configurations')
        .select(['setting_value', 'is_encrypted'])
        .where('tenant_id', '=', 't1')
        .where('setting_key', '=', 'sec')
        .executeTakeFirst();
      expect(row?.setting_value).not.toBe('plaintext-must-not-be-in-db');
      expect(row?.setting_value).toMatch(SECRET_NAME_RE);
      // is_encrypted is stored as 1 in SQLite (boolean adapted by patchBooleansAndDates)
      expect(row?.is_encrypted).toBeTruthy();
    });

    it('rejects rows where setting_value does not match the deterministic secret name (anti-exfiltration)', async () => {
      // Direct DB insert simulating a corrupted/tampered row: is_encrypted=true
      // but setting_value points at an attacker-chosen name (e.g., an env var
      // the attacker wants to read via SecretManager's env-provider fallback).
      await db.insertInto('tenant_configurations').values({
        id: 'tampered',
        tenant_id: 't1',
        setting_key: 'sec',
        setting_value: 'PATH', // would resolve to process.env.PATH under env provider
        is_encrypted: true,
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
      const result = await repo.getString('t1', 'sec');
      expect(result).toBeNull();
      // SecretManager.getSecret MUST NOT have been called — the mismatch
      // guard kicks in BEFORE any backend lookup.
      expect(secretManager.getSecret).not.toHaveBeenCalled();
      // Logger.error(message, error?, metadata) — no Error on the mismatch
      // path, so `undefined` is the 2nd arg and metadata is the 3rd.
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('mismatches deterministic secret name'),
        undefined,
        expect.objectContaining({
          tenantId: 't1',
          settingKey: 'sec',
          actualValueLength: 'PATH'.length,
        }),
      );
    });

    it('does not log the raw mismatched setting_value (Codex P1 — no secret-material leak)', async () => {
      // If a corrupted/legacy row stores raw secret material in setting_value
      // (instead of the deterministic name), the mismatch log MUST NOT echo
      // it back. Only a non-reversible sha256 digest + length should appear.
      const rawSecretMaterial = 'super-secret-bearer-token-do-not-log';
      await db.insertInto('tenant_configurations').values({
        id: 'legacy',
        tenant_id: 't1',
        setting_key: 'sec',
        setting_value: rawSecretMaterial,
        is_encrypted: true,
        created_at: new Date(),
        updated_at: new Date(),
      }).execute();
      await repo.getString('t1', 'sec');
      // Walk every error-log call and assert none of the args contain the raw
      // secret. Logger.error's (message, error?, metadata) signature means the
      // 2nd arg is intentionally `undefined` on the mismatch path — skip
      // undefined values (JSON.stringify(undefined) is `undefined`, not a
      // string, which the matcher rejects).
      for (const call of mockLogger.error.mock.calls) {
        for (const arg of call) {
          if (arg === undefined) continue;
          expect(JSON.stringify(arg)).not.toContain(rawSecretMaterial);
        }
      }
      // Positive control: the digest field IS present in the metadata
      // (3rd arg per Logger.error's (message, error?, metadata) signature).
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.any(String),
        undefined,
        expect.objectContaining({
          actualValueDigestSha256: expect.stringMatching(/^[0-9a-f]{16}$/),
        }),
      );
    });
  });

  describe('resolveBooleanForRow (pre-fetched-row variant)', () => {
    it('returns true for plaintext row with setting_value === "true"', async () => {
      const result = await repo.resolveBooleanForRow('t1', 'flag', {
        setting_value: 'true', is_encrypted: false,
      });
      expect(result).toBe(true);
      expect(secretManager.getSecret).not.toHaveBeenCalled();
    });

    it('returns false for plaintext row with any other value', async () => {
      const result = await repo.resolveBooleanForRow('t1', 'flag', {
        setting_value: 'false', is_encrypted: false,
      });
      expect(result).toBe(false);
    });

    it('resolves encrypted row through SecretManager without re-querying the DB', async () => {
      // Pre-seed the SecretManager so the deterministic name returns 'true'.
      await repo.upsert('t1', 'flag', 'true', { isEncrypted: true });
      // Capture how many DB SELECTs happened on upsert (it does one DB write,
      // not a SELECT we care about). Reset getSecret call count.
      secretManager.getSecret.mockClear();

      // Read back the row directly so we can pass it to resolveBooleanForRow.
      const row = await db.selectFrom('tenant_configurations')
        .select(['setting_value', 'is_encrypted'])
        .where('tenant_id', '=', 't1').where('setting_key', '=', 'flag')
        .executeTakeFirstOrThrow();

      const result = await repo.resolveBooleanForRow('t1', 'flag', row);
      expect(result).toBe(true);
      // SecretManager.getSecret was called once with the deterministic name —
      // no extra DB read (that's the helper's purpose).
      expect(secretManager.getSecret).toHaveBeenCalledTimes(1);
      expect(secretManager.getSecret).toHaveBeenCalledWith(
        expect.stringMatching(SECRET_NAME_RE),
      );
    });
  });

  describe('upsert', () => {
    it('inserts a new row when key is novel', async () => {
      await repo.upsert('t1', 'k', 'v');
      expect(await repo.getString('t1', 'k')).toBe('v');
    });

    it('updates existing row on key collision (UNIQUE on tenant_id, setting_key)', async () => {
      await repo.upsert('t1', 'k', 'v1');
      await repo.upsert('t1', 'k', 'v2');
      expect(await repo.getString('t1', 'k')).toBe('v2');
    });

    it('overwrites encrypted secret on upsert with same key', async () => {
      await repo.upsert('t1', 'sec', 'first', { isEncrypted: true });
      await repo.upsert('t1', 'sec', 'second', { isEncrypted: true });
      expect(await repo.getString('t1', 'sec')).toBe('second');
      // Same secret name reused (deterministic from tenantId+settingKey)
      const firstName = secretManager.setSecret.mock.calls[0][0];
      const secondName = secretManager.setSecret.mock.calls[1][0];
      expect(firstName).toBe(secondName);
    });

    it('bubbles error when SecretManager.setSecret throws (no DB row written)', async () => {
      secretManager.setSecret.mockRejectedValueOnce(new Error('env provider rejects writes'));
      await expect(repo.upsert('t1', 'sec', 'plaintext', { isEncrypted: true }))
        .rejects.toThrow('env provider rejects writes');
      const row = await db
        .selectFrom('tenant_configurations')
        .select('id')
        .where('tenant_id', '=', 't1')
        .where('setting_key', '=', 'sec')
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });

  describe('secret-name scheme (no PII/IDs leaked to backend)', () => {
    it('produces deterministic but tenant- and key-distinct names', async () => {
      await repo.upsert('t1', 'k1', 'v', { isEncrypted: true });
      await repo.upsert('t1', 'k2', 'v', { isEncrypted: true });
      await repo.upsert('t2', 'k1', 'v', { isEncrypted: true });
      const names = secretManager.setSecret.mock.calls.map((c) => c[0]);
      expect(new Set(names).size).toBe(3); // all three distinct
      names.forEach((n) => expect(n).toMatch(SECRET_NAME_RE));
      // Tenant ID and setting key NOT present in the secret name
      names.forEach((n) => {
        expect(n).not.toContain('t1');
        expect(n).not.toContain('t2');
        expect(n).not.toContain('k1');
        expect(n).not.toContain('k2');
      });
    });
  });
});
