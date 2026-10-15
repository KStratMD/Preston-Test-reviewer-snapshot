import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration } from '../../../../src/database/migrations/049-create-lineage-events-table';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

describe('migration 049 — lineage_events', () => {
  let db: Kysely<Database>;

  beforeEach(() => {
    db = makeDb();
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('creates lineage_events with the required lookup indexes (record_lookup + correlation; tenant_chain is implicit via UNIQUE)', async () => {
    await migration.run(db, 'sqlite');

    const tables = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table'`.execute(db);
    expect(tables.rows.map((r) => r.name)).toContain('lineage_events');

    const indexes = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index'`.execute(db);
    const indexNames = indexes.rows.map((r) => r.name);
    // idx_lineage_events_tenant_chain is intentionally NOT in this list — it
    // would duplicate the auto-index sqlite/postgres create for the
    // UNIQUE(tenant_id, chain_id, sequence) constraint (PR #846 R2).
    expect(indexNames).toEqual(expect.arrayContaining([
      'idx_lineage_events_record_lookup',
      'idx_lineage_events_correlation',
    ]));
    expect(indexNames).not.toContain('idx_lineage_events_tenant_chain');
  });

  it('creates lineage_events with the documented columns', async () => {
    await migration.run(db, 'sqlite');
    const cols = await sql<{ name: string }>`PRAGMA table_info(lineage_events)`.execute(db);
    const names = cols.rows.map((r) => r.name).sort();
    expect(names).toEqual([
      'chain_id',
      'correlation_id',
      'event_type',
      'governance_result',
      'id',
      'metadata_json',
      'occurred_at',
      'payload_hash',
      'sequence',
      'source_entity_id',
      'source_entity_type',
      'source_system',
      'target_entity_id',
      'target_entity_type',
      'target_system',
      'template_id',
      'tenant_id',
    ]);
  });

  it('enforces UNIQUE(tenant_id, chain_id, sequence)', async () => {
    await migration.run(db, 'sqlite');
    const now = new Date().toISOString();
    await db.insertInto('lineage_events').values({
      id: 'lin_1', tenant_id: 't', chain_id: 'c', sequence: 1,
      event_type: 'source_read', source_system: null, source_entity_type: null, source_entity_id: null,
      target_system: null, target_entity_type: null, target_entity_id: null,
      template_id: null, correlation_id: 'corr_1', governance_result: null, payload_hash: null,
      metadata_json: '{}', occurred_at: now,
    }).execute();
    // Duplicate composite-key row must be rejected by UNIQUE(tenant_id, chain_id, sequence).
    // Use try/catch + message assertion rather than expect().rejects.toThrow() because
    // better-sqlite3's native binding caches its SqliteError constructor process-globally
    // (see node_modules/better-sqlite3/lib/database.js:58-61). When this test file runs
    // AFTER another test file (e.g. tests/unit/services/lineage/LineageRepository.test.ts)
    // that already initialized better-sqlite3 in a different Jest VM context, the thrown
    // error's `instanceof Error` resolves against the wrong realm's Error.prototype.
    // Jest's `expect(...).rejects.toThrow()` matcher gates on `_expectUtils.isError(received)`
    // which returns false in that cross-realm case, producing a misleading
    // "Received function did not throw" message even though the constraint DID fire.
    // try/catch sidesteps the matcher's isError gate and asserts on the error message directly.
    // Same pattern used by migration 040 + 042 tests (see comment in 042 file).
    let dupErr: unknown = null;
    try {
      await db.insertInto('lineage_events').values({
        id: 'lin_2', tenant_id: 't', chain_id: 'c', sequence: 1,
        event_type: 'source_read', source_system: null, source_entity_type: null, source_entity_id: null,
        target_system: null, target_entity_type: null, target_entity_id: null,
        template_id: null, correlation_id: 'corr_1', governance_result: null, payload_hash: null,
        metadata_json: '{}', occurred_at: now,
      }).execute();
    } catch (e) {
      dupErr = e;
    }
    expect(dupErr).not.toBeNull();
    expect(String(dupErr)).toMatch(/UNIQUE constraint failed/);
    // Belt-and-braces: confirm the row was NOT committed (only the first lin_1 row exists).
    const rows = await db.selectFrom('lineage_events').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('lin_1');
  });

  it('rejects event_type values outside the allowed set', async () => {
    await migration.run(db, 'sqlite');
    const now = new Date().toISOString();
    // See UNIQUE-constraint test above for why try/catch is preferred over
    // expect().rejects.toThrow() (cross-realm SqliteError vs Jest's isError gate).
    let checkErr: unknown = null;
    try {
      await db.insertInto('lineage_events').values({
        id: 'lin_bad', tenant_id: 't', chain_id: 'c', sequence: 1,
        // @ts-expect-error — exercising the CHECK constraint
        event_type: 'invalid_type',
        source_system: null, source_entity_type: null, source_entity_id: null,
        target_system: null, target_entity_type: null, target_entity_id: null,
        template_id: null, correlation_id: 'corr_1', governance_result: null, payload_hash: null,
        metadata_json: '{}', occurred_at: now,
      }).execute();
    } catch (e) {
      checkErr = e;
    }
    expect(checkErr).not.toBeNull();
    expect(String(checkErr)).toMatch(/CHECK constraint failed/);
    // Belt-and-braces: confirm the row was NOT committed.
    const rows = await db.selectFrom('lineage_events').selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
