import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as m045 } from '../../../../src/database/migrations/045-create-governance-approvals-table';
import { migration as m050 } from '../../../../src/database/migrations/050-add-write-descriptor-to-governance-approvals';
import { migration } from '../../../../src/database/migrations/051-add-apply-lifecycle-to-governance-approvals';

function makeDb(): Kysely<Database> {
  const sqlite = new BetterSqlite3(':memory:');
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
}

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
    write_descriptor: null,
  };
}

describe('migration 051 — add apply lifecycle columns to governance_approvals', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await m045.run(db, 'sqlite');
    await m050.run(db, 'sqlite');
  });

  afterEach(async () => {
    await db.destroy();
  });

  it('up() adds apply_status, applied_at, apply_failed_at, apply_error columns', async () => {
    await migration.run(db, 'sqlite');

    const cols = await sql<{ name: string }>`PRAGMA table_info(governance_approvals)`.execute(db);
    const names = cols.rows.map((r) => r.name);
    expect(names).toContain('apply_status');
    expect(names).toContain('applied_at');
    expect(names).toContain('apply_failed_at');
    expect(names).toContain('apply_error');
  });

  it('apply_status defaults to "not_started" for new rows', async () => {
    await migration.run(db, 'sqlite');

    await db.insertInto('governance_approvals').values(baseRow('apr_default')).execute();

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_default')
      .executeTakeFirstOrThrow();

    expect(row.apply_status).toBe('not_started');
    expect(row.applied_at).toBeNull();
    expect(row.apply_failed_at).toBeNull();
    expect(row.apply_error).toBeNull();
  });

  it('new rows accept apply lifecycle field values round-trip', async () => {
    await migration.run(db, 'sqlite');

    const failedAt = new Date().toISOString();
    await db
      .insertInto('governance_approvals')
      .values({
        ...baseRow('apr_failed'),
        apply_status: 'failed',
        apply_failed_at: failedAt,
        apply_error: 'connector down',
      })
      .execute();

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_failed')
      .executeTakeFirstOrThrow();

    expect(row.apply_status).toBe('failed');
    expect(row.apply_failed_at).toBe(failedAt);
    expect(row.apply_error).toBe('connector down');
  });

  it('is idempotent (replaying up() does not throw)', async () => {
    await migration.run(db, 'sqlite');
    // Second run must not throw — duplicate column is swallowed.
    await expect(migration.run(db, 'sqlite')).resolves.toBeUndefined();
  });

  it('backfills apply_status="claimed" for legacy rows with apply_idempotency_key set (Copilot R14)', async () => {
    // Simulate a row written under the pre-051 schema (apply_idempotency_key
    // set from PR 13c-2's worker, but no apply_status column yet). The base
    // table from m045 + write_descriptor from m050 already accepts this row;
    // apply_idempotency_key is part of the m045 row shape, just no lifecycle
    // status alongside.
    await db
      .insertInto('governance_approvals')
      .values({
        ...baseRow('apr_legacy_claimed'),
        apply_idempotency_key: 'resume::apr_legacy_claimed',
      })
      .execute();

    await migration.run(db, 'sqlite');

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_legacy_claimed')
      .executeTakeFirstOrThrow();

    // Backfill UPDATE ran after the column adds: claimed-but-incomplete
    // legacy rows now correctly report apply_status='claimed'.
    expect(row.apply_status).toBe('claimed');
    expect(row.apply_idempotency_key).toBe('resume::apr_legacy_claimed');
  });

  it('does NOT touch apply_status on legacy rows without an apply_idempotency_key', async () => {
    await db
      .insertInto('governance_approvals')
      .values(baseRow('apr_legacy_unclaimed'))
      .execute();

    await migration.run(db, 'sqlite');

    const row = await db
      .selectFrom('governance_approvals')
      .selectAll()
      .where('id', '=', 'apr_legacy_unclaimed')
      .executeTakeFirstOrThrow();

    expect(row.apply_status).toBe('not_started');
    expect(row.apply_idempotency_key).toBeNull();
  });
});
