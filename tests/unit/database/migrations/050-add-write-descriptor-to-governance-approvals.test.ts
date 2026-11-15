import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as m045 } from '../../../../src/database/migrations/045-create-governance-approvals-table';
import { migration } from '../../../../src/database/migrations/050-add-write-descriptor-to-governance-approvals';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

/** Minimal base row minus write_descriptor (added by migration 050). */
function baseRow(id: string) {
  const now = new Date().toISOString();
  return {
    id,
    tenant_id: 'tenant_1',
    requester_user_id: 'user_1',
    operation_type: 'connector_write',
    resource_type: 'Contact',
    resource_id: 'rec_1',
    risk_level: 'medium',
    redacted_payload: '{}',
    policy_findings: '[]',
    status: 'pending',
    created_at: now,
    expires_at: now,
    decided_at: null,
    decided_by_user_id: null,
    decision_reason: null,
    apply_idempotency_key: null,
  };
}

describe('migration 050 — add write_descriptor to governance_approvals', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    // Bootstrap the base table first so ALTER TABLE has something to alter.
    await m045.run(db, 'sqlite');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('up() adds the write_descriptor column to governance_approvals', async () => {
    await migration.run(db, 'sqlite');

    const cols = await sql<{ name: string }>`PRAGMA table_info(governance_approvals)`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain('write_descriptor');
  });

  it('existing rows accept NULL for write_descriptor after up()', async () => {
    await migration.run(db, 'sqlite');

    await db.insertInto('governance_approvals').values({
      ...baseRow('apr_legacy'),
      write_descriptor: null,
    }).execute();

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_legacy')
      .executeTakeFirstOrThrow();

    expect(row.write_descriptor).toBeNull();
  });

  it('new rows persist a JSON write descriptor string round-trip', async () => {
    await migration.run(db, 'sqlite');

    const descriptor = {
      targetSystemId: 'hubspot',
      operation: 'create',
      entityType: 'Contact',
      args: { firstName: 'Ada', lastName: 'Lovelace' },
      ownership: {
        entity: 'customer',
        declaredOwner: 'hubspot',
        callerSystem: 'netsuite',
      },
    };

    await db.insertInto('governance_approvals').values({
      ...baseRow('apr_ownership'),
      operation_type: 'ownership_write',
      write_descriptor: JSON.stringify(descriptor),
    }).execute();

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_ownership')
      .executeTakeFirstOrThrow();

    expect(row.write_descriptor).not.toBeNull();
    const parsed = JSON.parse(row.write_descriptor as string);
    expect(parsed).toEqual(descriptor);
  });

  it('is idempotent (replaying up() does not throw)', async () => {
    await migration.run(db, 'sqlite');
    // Second run must not throw — duplicate column is swallowed.
    await expect(migration.run(db, 'sqlite')).resolves.toBeUndefined();
  });
});
