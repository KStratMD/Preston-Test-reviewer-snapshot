import 'reflect-metadata';
import { randomUUID, createHash } from 'node:crypto';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database, SyncErrorAssistProcessed } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import type { SecretManager } from '../../../../src/services/SecretManager';
import { migration as createTenantConfigs } from '../../../../src/database/migrations/008-create-tenant-configurations-table';
import { migration as addTenantConfigIndex } from '../../../../src/database/migrations/034-add-tenant-configurations-key-value-index';
import { migration as createRuns } from '../../../../src/database/migrations/035-create-sync-error-assist-runs-table';
import { migration as createProcessed } from '../../../../src/database/migrations/036-create-sync-error-assist-processed-table';
import { migration as extendProcessed } from '../../../../src/database/migrations/037-extend-sync-error-assist-processed';
import { migration as addErrorLastModified } from '../../../../src/database/migrations/038-add-sync-error-assist-processed-error-last-modified';
import { SyncErrorAssistRepository } from '../../../../src/services/syncErrorAssist/SyncErrorAssistRepository';
import { TenantConfigurationRepository } from '../../../../src/database/repositories/TenantConfigurationRepository';

// Mirrors DatabaseService.ts:108-113 — better-sqlite3 rejects native boolean/Date
// parameters by default. Production code goes through DatabaseService's adapter,
// which converts these at the driver layer; this test bypasses DatabaseService,
// so we apply the same conversion locally. Needed by `getActiveTenants`'s
// `is_encrypted = true` WHERE clause (R9.2).
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

// Build the deterministic name TenantConfigurationRepository uses for an
// encrypted (tenant_id, setting_key) pair so tests can seed a legitimate
// encrypted row pointing at a real secret in the mock SecretManager.
function deterministicSecretName(tenantId: string, settingKey: string): string {
  const hashPart = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 16);
  return `tenant-config-${hashPart(tenantId)}-${hashPart(settingKey)}`;
}

// Typed as Pick<SecretManager, 'getSecret' | 'setSecret'> so a signature
// change to either method surfaces here at compile time (Copilot R8.2 —
// avoids the silent-passing `as unknown as SecretManager` whole-object cast).
type MockSecretManager = Pick<SecretManager, 'getSecret' | 'setSecret'>;

function makeMockSecretManager(): { mgr: MockSecretManager; store: Map<string, string> } {
  const store = new Map<string, string>();
  const mgr: MockSecretManager = {
    getSecret: async (name: string) => {
      if (!store.has(name)) throw new Error(`secret '${name}' not found`);
      return { value: store.get(name) as string };
    },
    setSecret: async (name: string, value: string) => { store.set(name, value); },
  };
  return { mgr, store };
}

function makeRepo(db: Kysely<Database>): SyncErrorAssistRepository {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  const { mgr } = makeMockSecretManager();
  const tenantConfig = new TenantConfigurationRepository(databaseService, mgr as unknown as SecretManager);
  return new SyncErrorAssistRepository(databaseService, tenantConfig);
}

// Variant of makeRepo that returns the SecretManager mock store so tests can
// seed encrypted enrolled-flag values via the real backend, exercising the
// decrypting discovery path end-to-end.
function makeRepoWithSecretStore(db: Kysely<Database>): {
  repo: SyncErrorAssistRepository;
  secretStore: Map<string, string>;
} {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  const { mgr, store } = makeMockSecretManager();
  const tenantConfig = new TenantConfigurationRepository(databaseService, mgr as unknown as SecretManager);
  const repo = new SyncErrorAssistRepository(databaseService, tenantConfig);
  return { repo, secretStore: store };
}

async function seedTenantEnabled(db: Kysely<Database>, tenantId: string, enabled: boolean) {
  await db.insertInto('tenant_configurations').values({
    id: `tc-${tenantId}-enabled`,
    tenant_id: tenantId,
    setting_key: 'sync_error_assist.enabled',
    setting_value: enabled ? 'true' : 'false',
    is_encrypted: 0 as unknown as boolean,
    created_at: new Date().toISOString() as unknown as Date,
    updated_at: new Date().toISOString() as unknown as Date,
  }).execute();
}

async function seedProcessed(db: Kysely<Database>, row: Partial<SyncErrorAssistProcessed> & { tenant_id: string; error_record_id: string; status: string }) {
  await db.insertInto('sync_error_assist_processed').values({
    id: row.id ?? `r-${row.tenant_id}-${row.error_record_id}`,
    tenant_id: row.tenant_id,
    error_record_id: row.error_record_id,
    status: row.status,
    attempts: row.attempts ?? 1,
    suggestion_record_id: row.suggestion_record_id ?? null,
    trace_id: row.trace_id ?? null,
    provider: row.provider ?? null,
    cost_estimate_usd_cents: row.cost_estimate_usd_cents ?? null,
    failure_reason: row.failure_reason ?? null,
    reserved_at: row.reserved_at ?? new Date().toISOString(),
    completed_at: row.completed_at ?? null,
    error_last_modified_at: row.error_last_modified_at instanceof Date
      ? row.error_last_modified_at.toISOString()
      : row.error_last_modified_at ?? null,
  }).execute();
}

describe('SyncErrorAssistRepository', () => {
  let db: Kysely<Database>;
  let repo: SyncErrorAssistRepository;

  beforeEach(async () => {
    db = makeDb();
    await createTenantConfigs.run(db, 'sqlite');
    await addTenantConfigIndex.run(db, 'sqlite');
    await createRuns.run(db, 'sqlite');
    await createProcessed.run(db, 'sqlite');
    await extendProcessed.run(db, 'sqlite');
    await addErrorLastModified.run(db, 'sqlite');
    repo = makeRepo(db);
  });

  afterEach(async () => { await db.destroy(); });

  describe('getActiveTenants', () => {
    it('returns empty array when no tenants have sync_error_assist.enabled=true', async () => {
      await seedTenantEnabled(db, 't1', false);
      expect(await repo.getActiveTenants()).toEqual([]);
    });

    it('returns only tenants where sync_error_assist.enabled === "true"', async () => {
      await seedTenantEnabled(db, 't1', true);
      await seedTenantEnabled(db, 't2', false);
      await seedTenantEnabled(db, 't3', true);
      const result = await repo.getActiveTenants();
      expect(result.sort()).toEqual(['t1', 't3']);
    });

    it('treats setting_value !== "true" as disabled (strict)', async () => {
      await db.insertInto('tenant_configurations').values({
        id: 'tc-x',
        tenant_id: 't1',
        setting_key: 'sync_error_assist.enabled',
        setting_value: 'TRUE',  // wrong case
        is_encrypted: 0 as unknown as boolean,
        created_at: new Date().toISOString() as unknown as Date,
        updated_at: new Date().toISOString() as unknown as Date,
      }).execute();
      expect(await repo.getActiveTenants()).toEqual([]);
    });

    // Codex P2 finding on PR #808: when sync_error_assist.enabled is stored
    // encrypted (deterministic secret name in setting_value, true plaintext
    // in SecretManager), the previous direct `WHERE setting_value='true'`
    // discovery query silently skipped the tenant. After the fix,
    // getActiveTenants() routes through tenantConfig.getBoolean() per
    // candidate tenant so encrypted enrollments are honored end-to-end.
    it('honors encrypted enabled-flag rows via SecretManager (Codex P2 regression)', async () => {
      const { repo: localRepo, secretStore } = makeRepoWithSecretStore(db);
      const tenantId = 't-enc';
      const settingKey = 'sync_error_assist.enabled';
      const expectedName = deterministicSecretName(tenantId, settingKey);
      // Seed the encrypted row directly: setting_value holds the deterministic
      // secret name, is_encrypted=true, and the SecretManager-backing store
      // holds the actual 'true' plaintext under the same name.
      await db.insertInto('tenant_configurations').values({
        id: 'tc-enc-1',
        tenant_id: tenantId,
        setting_key: settingKey,
        setting_value: expectedName,
        is_encrypted: 1 as unknown as boolean,
        created_at: new Date().toISOString() as unknown as Date,
        updated_at: new Date().toISOString() as unknown as Date,
      }).execute();
      secretStore.set(expectedName, 'true');
      expect(await localRepo.getActiveTenants()).toEqual([tenantId]);
    });

    // Negative control: encrypted row whose decrypted value is 'false' is
    // correctly excluded (proves the per-tenant getBoolean gate works).
    it('excludes encrypted rows whose decrypted value is false', async () => {
      const { repo: localRepo, secretStore } = makeRepoWithSecretStore(db);
      const tenantId = 't-enc-off';
      const settingKey = 'sync_error_assist.enabled';
      const expectedName = deterministicSecretName(tenantId, settingKey);
      await db.insertInto('tenant_configurations').values({
        id: 'tc-enc-2',
        tenant_id: tenantId,
        setting_key: settingKey,
        setting_value: expectedName,
        is_encrypted: 1 as unknown as boolean,
        created_at: new Date().toISOString() as unknown as Date,
        updated_at: new Date().toISOString() as unknown as Date,
      }).execute();
      secretStore.set(expectedName, 'false');
      expect(await localRepo.getActiveTenants()).toEqual([]);
    });
  });

  describe('claim', () => {
    it('inserts new row when (tenant_id, error_record_id) is novel', async () => {
      const claim = await repo.claim('t1', 'err-1');
      expect(claim).toEqual({ id: expect.any(String), tenantId: 't1', errorRecordId: 'err-1', attempts: 1 });
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('tenant_id', '=', 't1').where('error_record_id', '=', 'err-1').executeTakeFirst();
      expect(row?.status).toBe('processing');
      expect(row?.attempts).toBe(1);
    });

    it('returns null when row exists with status=succeeded', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'succeeded', attempts: 1 });
      expect(await repo.claim('t1', 'err-1')).toBeNull();
    });

    it('returns null when row exists with status=processing', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'processing', attempts: 1 });
      expect(await repo.claim('t1', 'err-1')).toBeNull();
    });

    it('retries-existing when status=failed_retryable AND attempts < 3', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'failed_retryable', attempts: 1 });
      const claim = await repo.claim('t1', 'err-1');
      expect(claim).toEqual({ id: expect.any(String), tenantId: 't1', errorRecordId: 'err-1', attempts: 2 });
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('tenant_id', '=', 't1').where('error_record_id', '=', 'err-1').executeTakeFirst();
      expect(row?.status).toBe('processing');
      expect(row?.attempts).toBe(2);
    });

    it('returns null when status=failed_retryable AND attempts >= 3 (exhausted)', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'failed_retryable', attempts: 3 });
      expect(await repo.claim('t1', 'err-1')).toBeNull();
    });

    it('returns null when status=failed_non_retryable (terminal)', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'failed_non_retryable', attempts: 3 });
      expect(await repo.claim('t1', 'err-1')).toBeNull();
    });
  });

  describe('updateSucceeded', () => {
    it('transitions a processing row to succeeded with provided fields', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'processing', attempts: 1, id: 'r1' });
      await repo.updateSucceeded('r1', {
        suggestionRecordId: 'ns-100',
        traceId: 'sess-abc',
        provider: 'cloud-api',
        costEstimateUsdCents: 5,
        confidence: 'high',
        suggestionType: 'create_missing_record',
        suggestionText: 'Create item 1234',
        referencesField: 'item_id',
      });
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('id', '=', 'r1').executeTakeFirstOrThrow();
      expect(row.status).toBe('succeeded');
      expect(row.suggestion_record_id).toBe('ns-100');
      expect(row.trace_id).toBe('sess-abc');
      expect(row.provider).toBe('cloud-api');
      expect(row.cost_estimate_usd_cents).toBe(5);
      expect(row.confidence).toBe('high');
      expect(row.suggestion_type).toBe('create_missing_record');
      expect(row.suggestion_text).toBe('Create item 1234');
      expect(row.references_field).toBe('item_id');
      expect(row.completed_at).not.toBeNull();
    });

    it('is a no-op when row has been terminated by the reaper (OCC guard)', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'failed_non_retryable', attempts: 3, id: 'r1' });
      await repo.updateSucceeded('r1', {
        suggestionRecordId: 'ns-100', traceId: 'sess-abc', provider: 'cloud-api', costEstimateUsdCents: 5,
        confidence: 'high', suggestionType: 'create_missing_record', suggestionText: 'fix', referencesField: null,
      });
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('id', '=', 'r1').executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_non_retryable');                // unchanged
      expect(row.suggestion_record_id).toBeNull();
    });
  });

  describe('updateFailed', () => {
    it('transitions a processing row to failed_retryable with reason', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'processing', attempts: 1, id: 'r1' });
      await repo.updateFailed('r1', 'failed_retryable', 'AI timeout');
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('id', '=', 'r1').executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_retryable');
      expect(row.failure_reason).toBe('AI timeout');
      expect(row.completed_at).not.toBeNull();
    });

    it('is a no-op when row is already terminal (OCC guard)', async () => {
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'err-1', status: 'failed_non_retryable', attempts: 3, id: 'r1', failure_reason: 'orig reason' });
      await repo.updateFailed('r1', 'failed_retryable', 'new reason');
      const row = await db.selectFrom('sync_error_assist_processed').selectAll()
        .where('id', '=', 'r1').executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_non_retryable');                // unchanged
      expect(row.failure_reason).toBe('orig reason');                  // unchanged
    });
  });

  describe('reapStuckProcessing', () => {
    it('returns {reaped:0, recoveries:[]} when no stuck rows exist', async () => {
      expect(await repo.reapStuckProcessing(new Date())).toEqual({ reaped: 0, recoveries: [] });
    });

    it('only reaps rows with status=processing AND reserved_at < cutoff', async () => {
      const fresh = new Date('2026-05-07T12:00:00Z');
      const stale = new Date('2026-05-07T10:00:00Z');
      const cutoff = new Date('2026-05-07T11:00:00Z');

      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'fresh', status: 'processing', reserved_at: fresh.toISOString(), id: 'r-fresh' });
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'stale', status: 'processing', reserved_at: stale.toISOString(), id: 'r-stale' });
      await seedProcessed(db, { tenant_id: 't2', error_record_id: 'succ', status: 'succeeded', reserved_at: stale.toISOString(), id: 'r-succ' });

      const outcome = await repo.reapStuckProcessing(cutoff);
      expect(outcome.reaped).toBe(1);

      const stalRow = await db.selectFrom('sync_error_assist_processed').selectAll().where('id', '=', 'r-stale').executeTakeFirstOrThrow();
      expect(stalRow.status).toBe('failed_retryable');
      expect(stalRow.attempts).toBe(2);

      const freshRow = await db.selectFrom('sync_error_assist_processed').selectAll().where('id', '=', 'r-fresh').executeTakeFirstOrThrow();
      expect(freshRow.status).toBe('processing');                    // not reaped — fresh
    });

    it('promotes attempts >= 3 rows to terminal failed_non_retryable', async () => {
      const stale = new Date('2026-05-07T10:00:00Z');
      const cutoff = new Date('2026-05-07T11:00:00Z');
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'last', status: 'processing', attempts: 3, reserved_at: stale.toISOString(), id: 'r-last' });

      await repo.reapStuckProcessing(cutoff);
      const row = await db.selectFrom('sync_error_assist_processed').selectAll().where('id', '=', 'r-last').executeTakeFirstOrThrow();
      expect(row.status).toBe('failed_non_retryable');               // attempts=3+1 clamped → terminal
      expect(row.attempts).toBe(3);
      expect(row.failure_reason).toContain('orphaned');
    });

    it('clamps attempts at 3 (no overflow)', async () => {
      const stale = new Date('2026-05-07T10:00:00Z');
      const cutoff = new Date('2026-05-07T11:00:00Z');
      await seedProcessed(db, { tenant_id: 't1', error_record_id: 'x', status: 'processing', attempts: 2, reserved_at: stale.toISOString(), id: 'r-x' });

      await repo.reapStuckProcessing(cutoff);
      const row = await db.selectFrom('sync_error_assist_processed').selectAll().where('id', '=', 'r-x').executeTakeFirstOrThrow();
      expect(row.attempts).toBe(3);
      expect(row.status).toBe('failed_non_retryable');               // clamped to 3 → terminal
    });

    it('OCC-lost path: idempotent on repeated calls — second call returns 0 (Codex R2-4)', async () => {
      // Codex R2-4: the WHERE-status='processing' OCC guard at the SELECT level
      // (and the per-row UPDATE) ensures rows already advanced past 'processing'
      // are not re-reaped. Calling reapStuckProcessing twice in succession on the
      // same fixture should reap on the first call and return 0 on the second
      // because the row's status is no longer 'processing' — confirms the SELECT
      // filter is doing its job (no double-decrement of attempts, no double-flip).
      const stale = new Date('2026-05-07T10:00:00Z');
      const cutoff = new Date('2026-05-07T11:00:00Z');
      await seedProcessed(db, {
        tenant_id: 't1', error_record_id: 'occ', status: 'processing',
        attempts: 1, reserved_at: stale.toISOString(), id: 'r-occ',
      });

      const firstOutcome = await repo.reapStuckProcessing(cutoff);
      expect(firstOutcome.reaped).toBe(1);
      const afterFirst = await db.selectFrom('sync_error_assist_processed')
        .selectAll().where('id', '=', 'r-occ').executeTakeFirstOrThrow();
      expect(afterFirst.status).toBe('failed_retryable');  // attempts=1+1=2, not yet terminal
      expect(afterFirst.attempts).toBe(2);

      // Second call: SELECT now matches zero rows (status !== 'processing')
      const secondOutcome = await repo.reapStuckProcessing(cutoff);
      expect(secondOutcome.reaped).toBe(0);
      // Row state must NOT have advanced further
      const afterSecond = await db.selectFrom('sync_error_assist_processed')
        .selectAll().where('id', '=', 'r-occ').executeTakeFirstOrThrow();
      expect(afterSecond.status).toBe('failed_retryable');
      expect(afterSecond.attempts).toBe(2);
    });
  });

  describe('watermark', () => {
    it('getWatermark returns null when no row exists for tenant', async () => {
      expect(await repo.getWatermark('t1')).toBeNull();
    });

    it('tryAdvanceWatermark inserts a fresh row when no processing rows exist', async () => {
      const t = new Date('2026-05-01T10:00:00Z');
      const advanced = await repo.tryAdvanceWatermark('t1', t);
      expect(advanced).toBe(true);
      const result = await repo.getWatermark('t1');
      expect(result).not.toBeNull();
      expect(result!.getTime()).toBe(t.getTime());
    });

    it('tryAdvanceWatermark updates existing row when no processing rows exist', async () => {
      const t1 = new Date('2026-05-01T10:00:00Z');
      const t2 = new Date('2026-05-01T11:00:00Z');
      expect(await repo.tryAdvanceWatermark('t1', t1)).toBe(true);
      expect(await repo.tryAdvanceWatermark('t1', t2)).toBe(true);
      const result = await repo.getWatermark('t1');
      expect(result!.getTime()).toBe(t2.getTime());
    });

    it('tryAdvanceWatermark holds (returns false, leaves DB unchanged) when a processing row exists', async () => {
      const t1 = new Date('2026-05-01T10:00:00Z');
      const t2 = new Date('2026-05-01T11:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', t1)).toBe(true);
      // Insert processing row, then attempt advance — should be held.
      const claim = await repo.claim('acme', 'err-1');
      expect(claim).not.toBeNull();
      const advanced = await repo.tryAdvanceWatermark('acme', t2);
      expect(advanced).toBe(false);
      const result = await repo.getWatermark('acme');
      expect(result!.getTime()).toBe(t1.getTime()); // unchanged
    });

    it('tryAdvanceWatermark holds for first-time tenant when a processing row already exists', async () => {
      const claim = await repo.claim('first-time', 'err-1');
      expect(claim).not.toBeNull();
      const advanced = await repo.tryAdvanceWatermark('first-time', new Date('2026-05-01T10:00:00Z'));
      expect(advanced).toBe(false);
      expect(await repo.getWatermark('first-time')).toBeNull(); // no row inserted
    });

    it('tryAdvanceWatermark is per-tenant — processing in tenant A does NOT block advance for tenant B', async () => {
      await repo.claim('acme', 'err-1');
      const t = new Date('2026-05-01T10:00:00Z');
      const advanced = await repo.tryAdvanceWatermark('beta', t);
      expect(advanced).toBe(true);
      const result = await repo.getWatermark('beta');
      expect(result!.getTime()).toBe(t.getTime());
    });

    it('tryAdvanceWatermark advances again after the blocking row terminates', async () => {
      const claim = await repo.claim('acme', 'err-1');
      expect(claim).not.toBeNull();
      const t1 = new Date('2026-05-01T10:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', t1)).toBe(false);
      await repo.updateSucceeded(claim!.id, {
        suggestionRecordId: 'ns-1',
        traceId: 'trace-1',
        provider: 'fixture',
        costEstimateUsdCents: null,
        confidence: 'mid',
        suggestionType: 'manual_review',
        suggestionText: 'review',
        referencesField: null,
      });
      const t2 = new Date('2026-05-01T11:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', t2)).toBe(true);
      const result = await repo.getWatermark('acme');
      expect(result!.getTime()).toBe(t2.getTime());
    });

    it('tryAdvanceWatermark is monotonic — backward candidate is held, watermark not regressed (Copilot R2)', async () => {
      // Set watermark to t2 first.
      const t2 = new Date('2026-05-02T11:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', t2)).toBe(true);
      // Try to advance to an earlier time — should be held, watermark stays at t2.
      const tEarlier = new Date('2026-05-01T10:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', tEarlier)).toBe(false);
      expect((await repo.getWatermark('acme'))!.getTime()).toBe(t2.getTime());
      // Same-instant candidate is also held (strict >).
      expect(await repo.tryAdvanceWatermark('acme', t2)).toBe(false);
      expect((await repo.getWatermark('acme'))!.getTime()).toBe(t2.getTime());
    });
  });

  describe('recoverWatermarkAfterReap (PR 17c-followup watermark race closure)', () => {
    it('returns recovered=false when no failed_retryable rows exist for the tenant', async () => {
      const t = new Date('2026-05-12T10:00:00Z');
      expect(await repo.tryAdvanceWatermark('t1', t)).toBe(true);
      const result = await repo.recoverWatermarkAfterReap('t1');
      expect(result.recovered).toBe(false);
      expect(result.recoveredTo).toBeNull();
      expect((await repo.getWatermark('t1'))!.getTime()).toBe(t.getTime());
    });

    it('returns recovered=false when failed_retryable rows have NULL error_last_modified_at (legacy pre-migration-038 rows)', async () => {
      const t = new Date('2026-05-12T10:00:00Z');
      expect(await repo.tryAdvanceWatermark('t1', t)).toBe(true);
      await seedProcessed(db, {
        tenant_id: 't1', error_record_id: 'legacy', status: 'failed_retryable',
        attempts: 2, reserved_at: '2026-05-12T09:00:00Z',
        id: 'r-legacy',
        // No error_last_modified_at — emulates a pre-migration row
      });
      const result = await repo.recoverWatermarkAfterReap('t1');
      expect(result.recovered).toBe(false);
      expect(result.recoveredTo).toBeNull();
      // Watermark untouched.
      expect((await repo.getWatermark('t1'))!.getTime()).toBe(t.getTime());
    });

    it('ratchets watermark backward to MIN(error_last_modified_at) - 1ms when surviving failed_retryable rows have older anchors', async () => {
      // Watermark advanced past the orphaned row's lastModified (simulates the
      // READ COMMITTED race). Now we rebuild that scenario.
      const overAdvancedTo = new Date('2026-05-12T12:00:00Z');
      expect(await repo.tryAdvanceWatermark('t1', overAdvancedTo)).toBe(true);

      // Two surviving failed_retryable rows for t1, the OLDER of which is
      // earlier than the over-advanced watermark.
      const olderAnchor = '2026-05-12T10:30:00.000Z';
      const newerAnchor = '2026-05-12T11:30:00.000Z';
      await seedProcessed(db, {
        tenant_id: 't1', error_record_id: 'older', status: 'failed_retryable',
        attempts: 2, reserved_at: '2026-05-12T10:00:00Z',
        error_last_modified_at: olderAnchor, id: 'r-older',
      });
      await seedProcessed(db, {
        tenant_id: 't1', error_record_id: 'newer', status: 'failed_retryable',
        attempts: 2, reserved_at: '2026-05-12T11:00:00Z',
        error_last_modified_at: newerAnchor, id: 'r-newer',
      });

      const result = await repo.recoverWatermarkAfterReap('t1');
      expect(result.recovered).toBe(true);
      // Expected: watermark rolled back to olderAnchor - 1ms so the polling
      // path's strict `> watermark` filter re-includes the row's exact
      // lastModified value.
      const expectedRecoveredEpoch = new Date(olderAnchor).getTime() - 1;
      expect(result.recoveredTo).toBe(new Date(expectedRecoveredEpoch).toISOString());
      expect((await repo.getWatermark('t1'))!.getTime()).toBe(expectedRecoveredEpoch);
    });

    it('does NOT ratchet forward — if MIN(error_last_modified_at) is newer than the current watermark, no change', async () => {
      // Watermark at an earlier time than any failed_retryable row's anchor.
      const earlier = new Date('2026-05-12T08:00:00Z');
      expect(await repo.tryAdvanceWatermark('t1', earlier)).toBe(true);

      await seedProcessed(db, {
        tenant_id: 't1', error_record_id: 'later', status: 'failed_retryable',
        attempts: 2, reserved_at: '2026-05-12T11:00:00Z',
        error_last_modified_at: '2026-05-12T10:30:00Z', id: 'r-later',
      });

      const result = await repo.recoverWatermarkAfterReap('t1');
      // Despite the MIN being non-null, it's newer than the watermark, so
      // the conditional UPDATE matches zero rows.
      expect(result.recovered).toBe(false);
      expect((await repo.getWatermark('t1'))!.getTime()).toBe(earlier.getTime());
    });

    it('per-tenant isolation: recovery for tenant A does not touch tenant B', async () => {
      const tA = new Date('2026-05-12T12:00:00Z');
      const tB = new Date('2026-05-12T12:00:00Z');
      expect(await repo.tryAdvanceWatermark('tenant-A', tA)).toBe(true);
      expect(await repo.tryAdvanceWatermark('tenant-B', tB)).toBe(true);

      await seedProcessed(db, {
        tenant_id: 'tenant-A', error_record_id: 'A-row', status: 'failed_retryable',
        attempts: 2, reserved_at: '2026-05-12T10:00:00Z',
        error_last_modified_at: '2026-05-12T10:00:00Z', id: 'rA',
      });

      const result = await repo.recoverWatermarkAfterReap('tenant-A');
      expect(result.recovered).toBe(true);
      // tenant-A rolled back, tenant-B untouched.
      const wA = await repo.getWatermark('tenant-A');
      const wB = await repo.getWatermark('tenant-B');
      expect(wA!.getTime()).toBeLessThan(tA.getTime());
      expect(wB!.getTime()).toBe(tB.getTime());
    });

    it('reapStuckProcessing triggers watermark recovery automatically for affected tenants', async () => {
      // End-to-end happy path: tenant has an over-advanced watermark from the
      // READ COMMITTED race, a stalled `processing` row with error_last_modified_at,
      // and the reaper run rolls the watermark back as a side-effect of the reap.
      const overAdvancedTo = new Date('2026-05-12T12:00:00Z');
      expect(await repo.tryAdvanceWatermark('acme', overAdvancedTo)).toBe(true);

      const errorLastModifiedAt = '2026-05-12T10:00:00.000Z';
      const stuckAt = '2026-05-12T10:05:00Z';
      const cutoff = new Date('2026-05-12T11:00:00Z');

      // Manually seed the stuck row (simulates a webhook that crashed mid-
      // process). claim() is the canonical caller in production.
      await seedProcessed(db, {
        tenant_id: 'acme', error_record_id: 'stuck', status: 'processing',
        attempts: 1, reserved_at: stuckAt,
        error_last_modified_at: errorLastModifiedAt, id: 'r-stuck',
      });

      const outcome = await repo.reapStuckProcessing(cutoff);
      expect(outcome.reaped).toBe(1);

      // The reap flipped status to failed_retryable, AND the watermark
      // ratcheted back to errorLastModifiedAt - 1ms.
      const expectedRecoveredEpoch = new Date(errorLastModifiedAt).getTime() - 1;
      expect((await repo.getWatermark('acme'))!.getTime()).toBe(expectedRecoveredEpoch);

      // Codex PR #777 R2 NIT: the recovery is now observable via the
      // outcome's `recoveries` array — service layer logs each entry.
      expect(outcome.recoveries).toHaveLength(1);
      expect(outcome.recoveries[0]).toEqual({
        tenantId: 'acme',
        recoveredTo: new Date(expectedRecoveredEpoch).toISOString(),
      });

      // Polling-path simulation: tryAdvanceWatermark with a candidate
      // equal to the orphaned row's exact lastModified now passes the
      // monotonicity gate (because watermark < lastModified).
      // We'd advance — but ONLY after the failed_retryable row is reprocessed,
      // which would happen on the next cycle via claim()'s retry branch.
    });
  });

  describe('SyncErrorAssistRepository operator-surface methods', () => {
    async function insertProcessed(repo: SyncErrorAssistRepository, args: {
      tenantId: string;
      errorRecordId: string;
      status?: string;
      operatorDisposition?: 'pending' | 'applying' | 'accepted' | 'rejected' | 'escalated';
      operatorDispositionUserId?: string | null;
      confidence?: 'high' | 'mid' | 'low' | null;
      completedAtIso?: string;
    }): Promise<void> {
      const db = (repo as any)['db'].getDatabase();
      await db.insertInto('sync_error_assist_processed').values({
        id: randomUUID(),
        tenant_id: args.tenantId,
        error_record_id: args.errorRecordId,
        status: args.status ?? 'succeeded',
        attempts: 1,
        suggestion_record_id: `ns_${randomUUID()}`,
        trace_id: `trace_${randomUUID()}`,
        provider: 'cloud-api',
        cost_estimate_usd_cents: 12,
        confidence: args.confidence === undefined ? 'high' : args.confidence,
        suggestion_type: 'create_missing_record',
        suggestion_text: 'fixture',
        references_field: null,
        failure_reason: null,
        reserved_at: new Date().toISOString(),
        completed_at: args.completedAtIso ?? new Date().toISOString(),
        operator_disposition: args.operatorDisposition ?? 'pending',
        operator_disposition_at: args.operatorDispositionUserId ? new Date().toISOString() : null,
        operator_disposition_user_id: args.operatorDispositionUserId ?? null,
      }).execute();
    }

    it('listPendingSuggestionsByTenant returns only succeeded+pending rows for the given tenant', async () => {
      const tenant = 'tnt_A';
      const otherTenant = 'tnt_B';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'pending' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e2', status: 'succeeded', operatorDisposition: 'rejected' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e3', status: 'succeeded', operatorDisposition: 'applying' });
      await insertProcessed(repo, { tenantId: otherTenant, errorRecordId: 'e4', status: 'succeeded', operatorDisposition: 'pending' });

      const items = await repo.listPendingSuggestionsByTenant(tenant, { limit: 50 });
      expect(items).toHaveLength(1);
      expect(items[0].errorRecordId).toBe('e1');
      expect(items[0].tenantId).toBe(tenant);
    });

    it('listPendingSuggestionsByTenant orders high>mid>low>unknown regardless of completed_at recency', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_low',  confidence: 'low',  completedAtIso: '2026-05-08T03:00:00.000Z' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_high', confidence: 'high', completedAtIso: '2026-05-08T02:00:00.000Z' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_mid',  confidence: 'mid',  completedAtIso: '2026-05-08T01:00:00.000Z' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_null', confidence: null,   completedAtIso: '2026-05-08T10:00:00.000Z' });
      const items = await repo.listPendingSuggestionsByTenant(tenant, { limit: 50 });
      expect(items.map(i => i.errorRecordId)).toEqual(['e_high', 'e_mid', 'e_low', 'e_null']);
    });

    it('listPendingSuggestionsByTenant keeps NULL completed_at rows after non-null rows within same confidence', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_high_has_date', confidence: 'high', completedAtIso: '2026-05-08T02:00:00.000Z' });
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e_high_null_date', confidence: 'high', completedAtIso: undefined });

      const db = (repo as any)['db'].getDatabase();
      await db.updateTable('sync_error_assist_processed')
        .set({ completed_at: null })
        .where('tenant_id', '=', tenant)
        .where('error_record_id', '=', 'e_high_null_date')
        .execute();

      const items = await repo.listPendingSuggestionsByTenant(tenant, { limit: 50 });
      expect(items.map(i => i.errorRecordId)).toEqual(['e_high_has_date', 'e_high_null_date']);
    });

    it('listPendingSuggestionsByTenant uses reserved_at as createdAt fallback when completed_at is null', async () => {
      const tenant = 'tnt_A';
      const reservedAt = '2026-05-08T07:00:00.000Z';
      await insertProcessed(repo, {
        tenantId: tenant,
        errorRecordId: 'e_null_completed',
        confidence: 'high',
        completedAtIso: undefined,
      });
      const db = (repo as any)['db'].getDatabase();
      await db.updateTable('sync_error_assist_processed')
        .set({ completed_at: null, reserved_at: reservedAt })
        .where('tenant_id', '=', tenant)
        .where('error_record_id', '=', 'e_null_completed')
        .execute();

      const [item] = await repo.listPendingSuggestionsByTenant(tenant, { limit: 50 });
      expect(item.createdAt).toBe(reservedAt);
    });

    it('beginAccept transitions pending→applying atomically and returns true', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'pending' });
      const ok = await repo.beginAccept({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_42' });
      expect(ok).toBe(true);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('applying');
      expect(row?.operator_disposition_user_id).toBe('op_42');
      expect(row?.operator_disposition_at).not.toBeNull();
    });

    it('beginAccept returns false when row is already applying (concurrent caller wins)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'applying' });
      const ok = await repo.beginAccept({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_99' });
      expect(ok).toBe(false);
    });

    it('beginAccept returns false when row is already accepted/rejected/escalated', async () => {
      const tenant = 'tnt_A';
      for (const d of ['accepted', 'rejected', 'escalated'] as const) {
        await insertProcessed(repo, { tenantId: tenant, errorRecordId: `e_${d}`, status: 'succeeded', operatorDisposition: d });
        const ok = await repo.beginAccept({ tenantId: tenant, errorRecordId: `e_${d}`, userId: 'op_42' });
        expect(ok).toBe(false);
      }
    });

    it('completeAccept transitions applying→accepted atomically; returns false if state moved (e.g., reaper reverted)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'applying', operatorDispositionUserId: 'op_42' });
      const ok = await repo.completeAccept({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_42' });
      expect(ok).toBe(true);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('accepted');

      const ok2 = await repo.completeAccept({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_42' });
      expect(ok2).toBe(false);
    });

    it('completeAccept refuses to complete a lease held by a DIFFERENT user (lease isolation)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'applying', operatorDispositionUserId: 'op_42' });
      const ok = await repo.completeAccept({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_OTHER' });
      expect(ok).toBe(false);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('applying');
      expect(row?.operator_disposition_user_id).toBe('op_42');
    });

    it('revertToPending transitions applying→pending atomically (failure path)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'applying', operatorDispositionUserId: 'op_42' });
      const ok = await repo.revertToPending({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_42' });
      expect(ok).toBe(true);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('pending');
    });

    it('revertToPending refuses to revert a lease held by a DIFFERENT user (lease isolation)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'applying', operatorDispositionUserId: 'op_42' });
      const ok = await repo.revertToPending({ tenantId: tenant, errorRecordId: 'e1', userId: 'op_OTHER' });
      expect(ok).toBe(false);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('applying');
    });

    it('markDisposition handles pending→rejected with userId+timestamp; returns false on non-pending state', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'pending' });
      const ok = await repo.markDisposition({
        tenantId: tenant, errorRecordId: 'e1', newDisposition: 'rejected', userId: 'op_42',
      });
      expect(ok).toBe(true);
      const row = await repo.getProcessedRowByErrorRecord(tenant, 'e1');
      expect(row?.operator_disposition).toBe('rejected');

      const ok2 = await repo.markDisposition({
        tenantId: tenant, errorRecordId: 'e1', newDisposition: 'escalated', userId: 'op_99',
      });
      expect(ok2).toBe(false);
    });

    it('markDisposition does NOT accept newDisposition of accepted (must go through beginAccept/completeAccept)', async () => {
      const tenant = 'tnt_A';
      await insertProcessed(repo, { tenantId: tenant, errorRecordId: 'e1', status: 'succeeded', operatorDisposition: 'pending' });
      // @ts-expect-error — type narrowing should reject 'accepted'
      await expect(repo.markDisposition({ tenantId: tenant, errorRecordId: 'e1', newDisposition: 'accepted', userId: 'op_42' }))
        .rejects.toThrow();
    });

    it('getProcessedRowByErrorRecord returns null for unknown row', async () => {
      const row = await repo.getProcessedRowByErrorRecord('tnt_A', 'does_not_exist');
      expect(row).toBeNull();
    });
  });

});
