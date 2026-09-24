import 'reflect-metadata';
import { Kysely, SqliteDialect } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';
import { SerializedAssetSweepCursorRepository } from '../../../../src/services/serializedAsset/SerializedAssetSweepCursorRepository';

/**
 * Migration 059's durable sweep cursor (Task 7 review round 2). The behaviour
 * that matters is tenant + configuration isolation and the "unknown config
 * starts at the beginning" default — the wrap/advance semantics themselves are
 * owned by the sync service and pinned there.
 */

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

const NOW = new Date('2026-07-27T00:00:00.000Z');

describe('SerializedAssetSweepCursorRepository', () => {
  let db: Kysely<Database>;
  let repo: SerializedAssetSweepCursorRepository;

  beforeEach(async () => {
    db = makeDb();
    for (const migration of MIGRATIONS) await migration.run(db, 'sqlite');
    repo = new SerializedAssetSweepCursorRepository({ getDatabase: () => db } as never);
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('a configuration that has never been swept starts at the beginning', async () => {
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(0);
  });

  it('round-trips an advanced offset', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 200, NOW);
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(200);
  });

  it('overwrites rather than accumulating rows for the same key', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 200, NOW);
    await repo.setNextOffset('tenant-a', 'cfg-1', 400, new Date(NOW.getTime() + 1000));

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(400);
    const rows = await db.selectFrom('serialized_asset_sweep_cursors').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('wraps to the beginning when set back to 0', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 400, NOW);
    await repo.setNextOffset('tenant-a', 'cfg-1', 0, new Date(NOW.getTime() + 1000));
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(0);
  });

  it('never crosses a tenant boundary', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 300, NOW);

    expect(await repo.getNextOffset('tenant-b', 'cfg-1')).toBe(0);
    await repo.setNextOffset('tenant-b', 'cfg-1', 700, NOW);
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(300);
    expect(await repo.getNextOffset('tenant-b', 'cfg-1')).toBe(700);
  });

  it('never crosses a configuration boundary within one tenant', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 300, NOW);

    expect(await repo.getNextOffset('tenant-a', 'cfg-2')).toBe(0);
    await repo.setNextOffset('tenant-a', 'cfg-2', 900, NOW);
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(300);
  });

  // The two tests below exercise the UPDATE branch specifically. Every other
  // isolation test here writes each key exactly once and therefore only ever
  // takes the INSERT branch — but UPDATE is the production hot path, taken by
  // every run after the first for a given (tenant, configuration). Each test
  // asserts the row count is unchanged so it cannot silently pass by having
  // taken the INSERT branch instead.

  it('the UPDATE branch never overwrites another TENANT holding the same configuration id', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 100, NOW);
    await repo.setNextOffset('tenant-b', 'cfg-1', 200, NOW); // sibling tenant, same config id

    // Second write to an existing key -> UPDATE branch.
    await repo.setNextOffset('tenant-a', 'cfg-1', 900, new Date(NOW.getTime() + 1000));

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(900);
    expect(await repo.getNextOffset('tenant-b', 'cfg-1')).toBe(200);
    const rows = await db.selectFrom('serialized_asset_sweep_cursors').selectAll().execute();
    expect(rows).toHaveLength(2); // proves the UPDATE branch ran, not INSERT
  });

  it('the UPDATE branch never overwrites another CONFIGURATION within the same tenant', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 100, NOW);
    await repo.setNextOffset('tenant-a', 'cfg-2', 200, NOW); // sibling config, same tenant

    await repo.setNextOffset('tenant-a', 'cfg-1', 900, new Date(NOW.getTime() + 1000));

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(900);
    expect(await repo.getNextOffset('tenant-a', 'cfg-2')).toBe(200);
    const rows = await db.selectFrom('serialized_asset_sweep_cursors').selectAll().execute();
    expect(rows).toHaveLength(2);
  });

  it('the UPDATE branch touches exactly one row with both siblings present', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 100, NOW);
    await repo.setNextOffset('tenant-b', 'cfg-1', 200, NOW);
    await repo.setNextOffset('tenant-a', 'cfg-2', 300, NOW);

    await repo.setNextOffset('tenant-a', 'cfg-1', 900, new Date(NOW.getTime() + 1000));

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(900);
    expect(await repo.getNextOffset('tenant-b', 'cfg-1')).toBe(200);
    expect(await repo.getNextOffset('tenant-a', 'cfg-2')).toBe(300);
    const rows = await db.selectFrom('serialized_asset_sweep_cursors').selectAll().execute();
    expect(rows).toHaveLength(3);
  });

  it('degrades a hostile offset to the beginning rather than skipping rows', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', -50, NOW);
    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(0);

    await repo.setNextOffset('tenant-a', 'cfg-2', 12.7, NOW);
    expect(await repo.getNextOffset('tenant-a', 'cfg-2')).toBe(12);
  });

  it('the schema itself refuses a negative offset, even from raw SQL', async () => {
    await repo.setNextOffset('tenant-a', 'cfg-1', 100, NOW);

    // Migration 059's CHECK is the primary defence: a negative offset cannot be
    // stored at all, so the "silently skip rows" failure mode is unreachable
    // through SQL rather than merely handled on read.
    //
    // Asserted via String(error) rather than `.rejects.toThrow()`: better-sqlite3
    // is a native module, and when another suite has already loaded it in the
    // same worker the thrown SqliteError is not `instanceof Error` in this
    // module registry, so `toThrow` reports "did not throw" even though the
    // constraint fired. Matching the message text is registry-independent.
    let rejection: unknown;
    try {
      await db
        .updateTable('serialized_asset_sweep_cursors')
        .set({ next_offset: -999 })
        .where('tenant_id', '=', 'tenant-a')
        .execute();
    } catch (error) {
      rejection = error;
    }
    expect(String(rejection)).toMatch(/CHECK constraint/i);

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(100);
  });

  it('reads a non-numeric stored offset as the beginning instead of trusting it', async () => {
    // Defence in depth for what the CHECK cannot catch: SQLite is loosely typed
    // and a driver can hand back a string. Restarting a sweep is always safe
    // (External-ID upserts are idempotent); trusting a bad offset would silently
    // skip rows.
    const { sql } = await import('kysely');
    await repo.setNextOffset('tenant-a', 'cfg-1', 100, NOW);
    await sql`UPDATE serialized_asset_sweep_cursors SET next_offset = 'corrupt' WHERE tenant_id = 'tenant-a'`.execute(db);

    expect(await repo.getNextOffset('tenant-a', 'cfg-1')).toBe(0);
  });
});
