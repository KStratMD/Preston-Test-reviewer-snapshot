import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { DEFERRED_SERIALIZED_UNIT_REASONS } from '../../../../src/services/serializedAsset/DeferredSerializedUnitRepository';

const MIGRATION_058_NAME = 'create_deferred_serialized_units_table';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) {
    await m.run(db, 'sqlite');
  }
}

// better-sqlite3 caches its SqliteError constructor process-globally, so
// `.rejects.toThrow()` can misfire across Jest VM realms. Capture via try/catch
// + string match instead (same pattern as the 040/042/049/056/057 migration tests).
async function captureExecError(run: () => Promise<unknown>): Promise<string> {
  let err: unknown = null;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  expect(err).not.toBeNull();
  return String(err);
}

const NOW = '2026-07-27T00:00:00.000Z';

async function insertDeferred(
  db: Kysely<Database>,
  overrides: {
    tenantId?: string;
    configurationId?: string;
    inventoryNumberId?: string;
    reason?: string;
  } = {},
): Promise<void> {
  await sql`
    INSERT INTO deferred_serialized_units
      (tenant_id, configuration_id, inventory_number_id, normalized_payload, reason, attempt_count, next_attempt_at, first_deferred_at, last_attempt_at)
    VALUES
      (${overrides.tenantId ?? 'tenant-a'}, ${overrides.configurationId ?? 'cfg-1'}, ${overrides.inventoryNumberId ?? 'inv-1'},
       ${'{"tenantId":"tenant-a","configurationId":"cfg-1","inventoryNumberId":"inv-1","serialNumber":"SN-1","itemId":"item-1"}'},
       ${overrides.reason ?? 'parent_missing'}, ${1}, ${NOW}, ${NOW}, ${NOW})
  `.execute(db);
}

describe('migration 058 — deferred_serialized_units schema', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('is registered under its canonical name', () => {
    expect(MIGRATIONS.some((m) => m.name === MIGRATION_058_NAME)).toBe(true);
  });

  it('creates the deferred_serialized_units table and due index', async () => {
    const tables = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='table'
    `.execute(db);
    expect(tables.rows.map((r) => r.name)).toContain('deferred_serialized_units');

    const indexes = await sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type='index'
    `.execute(db);
    expect(indexes.rows.map((r) => r.name)).toContain('idx_deferred_serialized_units_due');
  });

  it('creates the documented columns', async () => {
    const cols = await sql<{ name: string }>`PRAGMA table_info(deferred_serialized_units)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'attempt_count',
      'configuration_id',
      'first_deferred_at',
      'inventory_number_id',
      'last_attempt_at',
      'next_attempt_at',
      'normalized_payload',
      'reason',
      'tenant_id',
    ]);
  });

  it('enforces the composite primary key (tenant_id, configuration_id, inventory_number_id)', async () => {
    await insertDeferred(db);
    const err = await captureExecError(() => insertDeferred(db));
    expect(err).toMatch(/UNIQUE|constraint/i);
  });

  it('allows the same inventory_number_id under a different configuration or tenant', async () => {
    await insertDeferred(db, { configurationId: 'cfg-1' });
    await expect(insertDeferred(db, { configurationId: 'cfg-2' })).resolves.toBeUndefined();
    await expect(insertDeferred(db, { tenantId: 'tenant-b' })).resolves.toBeUndefined();
  });

  it('enforces the reason CHECK constraint', async () => {
    const err = await captureExecError(() => insertDeferred(db, { reason: 'bogus_reason' }));
    expect(err).toMatch(/CHECK|constraint/i);
  });

  // Driven from the TYPE's own tuple rather than a hand-copied list, so adding a
  // reason to `DeferredSerializedUnitReason` without widening this CHECK fails
  // here instead of at write time in production. That failure mode matters more
  // than usual: on Postgres a CHECK violation's `DETAIL` embeds the whole
  // failing row — `normalized_payload`, i.e. the serial — which is exactly the
  // decision-8 leak this column's closed vocabulary exists to prevent.
  it('accepts every documented reason value, and the list is the type itself', async () => {
    expect(DEFERRED_SERIALIZED_UNIT_REASONS.length).toBeGreaterThan(0);

    for (const [index, reason] of DEFERRED_SERIALIZED_UNIT_REASONS.entries()) {
      await expect(
        insertDeferred(db, { inventoryNumberId: `inv-${index}`, reason }),
      ).resolves.toBeUndefined();
    }
  });

  it('is replay-safe (running the migration twice does not throw)', async () => {
    const migration = MIGRATIONS.find((m) => m.name === MIGRATION_058_NAME);
    expect(migration).toBeDefined();
    await expect(migration!.run(db, 'sqlite')).resolves.not.toThrow();
    await expect(migration!.run(db, 'sqlite')).resolves.not.toThrow();
  });
});
