import { describe, it, expect, beforeAll } from '@jest/globals';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { migration } from '../../../../src/database/migrations/040-create-tenants-and-status-audit-tables';

describe('Migration 040: tenants and tenant_status_audit', () => {
  let db: Kysely<any>;
  let sqlite: BetterSqlite3.Database;

  beforeAll(async () => {
    sqlite = new BetterSqlite3(':memory:');
    // Production DatabaseService sets this pragma at connection open; mirror
    // it here so the FK on tenant_status_audit.tenant_id (added in R4) is
    // actually enforced inside this test's in-memory connection.
    sqlite.pragma('foreign_keys = ON');
    db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    await migration.run(db, 'sqlite');
  });

  it('creates tenants table with status column defaulting to active', async () => {
    await db.insertInto('tenants').values({ id: 't1', created_at: '2026-05-13', updated_at: '2026-05-13' }).execute();
    const row = await db.selectFrom('tenants').selectAll().where('id', '=', 't1').executeTakeFirstOrThrow();
    expect(row.status).toBe('active');
  });

  it('rejects invalid status values via CHECK constraint', async () => {
    // SQLite enforces column-level CHECK constraints. Strict assertion: the
    // insert MUST throw — anything else (silently dropped, silently no-op,
    // succeeded-with-bogus-value) is a real defect since the test exists
    // specifically to pin that the constraint is active. PRAGMA
    // ignore_check_constraints accidentally enabled, a forked sqlite build
    // without CHECK support, or a future schema regression all become loud.
    let threw = false;
    try {
      await sql`
        INSERT INTO tenants (id, status, created_at, updated_at)
        VALUES ('t2', 'bogus', '2026-05-13', '2026-05-13')
      `.execute(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    // Belt-and-braces: even if a future engine were to throw asynchronously,
    // make sure the row was not committed.
    const after = await db.selectFrom('tenants').selectAll().where('id', '=', 't2').executeTakeFirst();
    expect(after).toBeUndefined();
  });

  it('creates tenant_status_audit with required transition fields', async () => {
    await db.insertInto('tenant_status_audit').values({
      id: 'a1', tenant_id: 't1', previous_status: 'active', new_status: 'disabled',
      actor_user_id: 'admin@squire.test', actor_source: 'admin_route',
      reason: 'test', occurred_at: '2026-05-13T00:00:00Z',
    }).execute();
    const audit = await db.selectFrom('tenant_status_audit').selectAll().execute();
    expect(audit).toHaveLength(1);
    expect(audit[0].new_status).toBe('disabled');
  });

  it('seq auto-increments and provides stable ordering for same-occurred_at rows', async () => {
    // Audit rows reference tenants(id) — pre-create t2 so the FK is satisfied.
    await db.insertInto('tenants').values({
      id: 't2', created_at: '2026-05-13', updated_at: '2026-05-13',
    }).execute();
    await db.insertInto('tenant_status_audit').values({
      id: 'b1', tenant_id: 't2', previous_status: 'active', new_status: 'suspended',
      actor_user_id: 'u', actor_source: 'test', occurred_at: '2026-05-13T01:00:00Z',
    }).execute();
    await db.insertInto('tenant_status_audit').values({
      id: 'b2', tenant_id: 't2', previous_status: 'suspended', new_status: 'active',
      actor_user_id: 'u', actor_source: 'test', occurred_at: '2026-05-13T01:00:00Z',
    }).execute();
    const rows = await db.selectFrom('tenant_status_audit')
      .selectAll().where('tenant_id', '=', 't2').orderBy('seq', 'desc').execute();
    expect(rows.map((r) => r.id)).toEqual(['b2', 'b1']);
    expect(rows[0].seq).toBeGreaterThan(rows[1].seq);
  });

  it('rejects audit rows whose previous_status is outside the union (CHECK)', async () => {
    // R5-1: tenant_status_audit now has CHECK on previous_status/new_status
    // symmetric with the tenants.status CHECK. Strict assertion: insert MUST
    // throw — silent no-op would mean the constraint isn't enforced and the
    // test exists specifically to catch that regression.
    let threw = false;
    try {
      await sql`
        INSERT INTO tenant_status_audit
          (id, tenant_id, previous_status, new_status, actor_user_id, actor_source, occurred_at)
        VALUES ('bad-prev', 't1', 'rogue', 'disabled', 'u', 'test', '2026-05-13T03:00:00Z')
      `.execute(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const after = await db.selectFrom('tenant_status_audit')
      .selectAll().where('id', '=', 'bad-prev').executeTakeFirst();
    expect(after).toBeUndefined();
  });

  it('rejects audit rows whose new_status is outside the union (CHECK)', async () => {
    let threw = false;
    try {
      await sql`
        INSERT INTO tenant_status_audit
          (id, tenant_id, previous_status, new_status, actor_user_id, actor_source, occurred_at)
        VALUES ('bad-new', 't1', 'active', 'rogue', 'u', 'test', '2026-05-13T03:00:00Z')
      `.execute(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const after = await db.selectFrom('tenant_status_audit')
      .selectAll().where('id', '=', 'bad-new').executeTakeFirst();
    expect(after).toBeUndefined();
  });

  it('rejects audit rows whose tenant_id has no matching tenants row (FK enforcement)', async () => {
    // R3-3 regression-pin: the FK on tenant_status_audit.tenant_id → tenants(id)
    // protects audit-trail referential integrity even against direct-SQL writes
    // that bypass the service / repository layer. Strict: must throw.
    let threw = false;
    try {
      await sql`
        INSERT INTO tenant_status_audit
          (id, tenant_id, previous_status, new_status, actor_user_id, actor_source, occurred_at)
        VALUES ('orphan', 'never-existed', 'active', 'disabled', 'u', 'test', '2026-05-13T02:00:00Z')
      `.execute(db);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const after = await db.selectFrom('tenant_status_audit')
      .selectAll().where('id', '=', 'orphan').executeTakeFirst();
    expect(after).toBeUndefined();
  });
});
