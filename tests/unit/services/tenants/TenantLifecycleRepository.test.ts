import { describe, it, expect, beforeEach } from '@jest/globals';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import { migration } from '../../../../src/database/migrations/040-create-tenants-and-status-audit-tables';
import { TenantLifecycleRepository } from '../../../../src/services/tenants/TenantLifecycleRepository';

describe('TenantLifecycleRepository', () => {
  let db: Kysely<any>;
  let repo: TenantLifecycleRepository;

  beforeEach(async () => {
    const sqlite = new BetterSqlite3(':memory:');
    // Mirror production DatabaseService — enable FK so tenant_status_audit's
    // FK on tenant_id is enforced inside the test's in-memory connection.
    sqlite.pragma('foreign_keys = ON');
    db = new Kysely({ dialect: new SqliteDialect({ database: sqlite }) });
    await migration.run(db, 'sqlite');
    repo = new TenantLifecycleRepository(db);
  });

  it('returns undefined for unknown tenant', async () => {
    expect(await repo.findById('unknown')).toBeUndefined();
  });

  it('ensureExists creates row with status=active by default', async () => {
    await repo.ensureExists('t1');
    const row = await repo.findById('t1');
    expect(row?.status).toBe('active');
  });

  it('ensureExists is idempotent — second call does not overwrite status', async () => {
    await repo.ensureExists('t1');
    await repo.updateStatus({
      tenantId: 't1', previousStatus: 'active', newStatus: 'disabled',
      actorUserId: 'admin', actorSource: 'admin_route', reason: 'test',
    });
    await repo.ensureExists('t1');
    expect((await repo.findById('t1'))?.status).toBe('disabled');
  });

  it('updateStatus writes both row and audit atomically', async () => {
    await repo.ensureExists('t1');
    await repo.updateStatus({
      tenantId: 't1', previousStatus: 'active', newStatus: 'suspended',
      actorUserId: 'admin', actorSource: 'admin_route', reason: 'investigating',
    });
    expect((await repo.findById('t1'))?.status).toBe('suspended');
    const audit = await repo.listAudit('t1');
    expect(audit).toHaveLength(1);
    expect(audit[0].newStatus).toBe('suspended');
  });

  it('listAudit returns rows newest-first', async () => {
    await repo.ensureExists('t1');
    await repo.updateStatus({
      tenantId: 't1', previousStatus: 'active', newStatus: 'suspended',
      actorUserId: 'admin', actorSource: 'admin_route',
    });
    await repo.updateStatus({
      tenantId: 't1', previousStatus: 'suspended', newStatus: 'active',
      actorUserId: 'admin', actorSource: 'admin_route',
    });
    const audit = await repo.listAudit('t1');
    expect(audit.map((r) => r.newStatus)).toEqual(['active', 'suspended']);
  });

  it('findById throws loudly if a row carries a status outside the union (defence-in-depth)', async () => {
    // The real migration has a CHECK constraint that BLOCKS even direct-SQL
    // inserts of bogus values — so to simulate a corrupt DB (e.g. a row
    // written by a manual UPDATE that disabled the constraint, or a forked
    // schema without the CHECK) we build a stand-in table without it.
    const corruptDb = new Kysely<any>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    await sql`
      CREATE TABLE tenants (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active',
        status_changed_at TEXT, status_changed_by TEXT, status_reason TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )
    `.execute(corruptDb);
    await sql`
      INSERT INTO tenants (id, status, created_at, updated_at)
      VALUES ('t-corrupt', 'rogue_value', '2026-05-13', '2026-05-13')
    `.execute(corruptDb);
    const corruptRepo = new TenantLifecycleRepository(corruptDb);
    await expect(corruptRepo.findById('t-corrupt'))
      .rejects.toThrow(/invalid TenantStatus from DB.*rogue_value/);
    await corruptDb.destroy();
  });

  it('listAudit throws loudly if an audit row carries a status outside the union', async () => {
    // Same simulation pattern as the findById corruption test: build a
    // stand-in audit table without CHECK so we can insert a bogus value.
    // FK is also omitted so the audit row can reference a tenant that
    // doesn't exist in this isolated stand-in DB.
    const corruptDb = new Kysely<any>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
    await sql`
      CREATE TABLE tenant_status_audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        tenant_id TEXT NOT NULL,
        previous_status TEXT NOT NULL,
        new_status TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        actor_source TEXT NOT NULL,
        reason TEXT,
        occurred_at TEXT NOT NULL
      )
    `.execute(corruptDb);
    await sql`
      INSERT INTO tenant_status_audit
        (id, tenant_id, previous_status, new_status, actor_user_id, actor_source, occurred_at)
      VALUES ('a-bad', 't1', 'active', 'rogue_value', 'admin', 'audit_corruption', '2026-05-13T00:00:00Z')
    `.execute(corruptDb);
    const corruptRepo = new TenantLifecycleRepository(corruptDb);
    await expect(corruptRepo.listAudit('t1'))
      .rejects.toThrow(/invalid TenantStatus from DB.*rogue_value/);
    await corruptDb.destroy();
  });

  it('updateStatus throws TenantNotFoundError when no tenants row exists (R3-2)', async () => {
    // Service path always pre-checks via peekStatus, but the repository is a
    // public class — a direct call against a missing id must surface a
    // distinguishable typed error so callers can map it to 404 rather than
    // confusing it with a CAS race (which maps to 409).
    const { TenantNotFoundError } = await import('../../../../src/services/tenants/TenantErrors');
    await expect(repo.updateStatus({
      tenantId: 'no-such', previousStatus: 'active', newStatus: 'disabled',
      actorUserId: 'admin', actorSource: 'admin_route',
    })).rejects.toBeInstanceOf(TenantNotFoundError);
  });
});
