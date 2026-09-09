import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import type { DatabaseService } from '../../../../src/database/DatabaseService';
import { migration as createAuditLogs } from '../../../../src/database/migrations/006-create-audit-logs-table';
import { migration as hardenAuditLogs } from '../../../../src/database/migrations/031-harden-audit-logs-for-persistence';
import { AuditLogRepository } from '../../../../src/database/repositories/AuditLogRepository';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }),
  });
}

function makeRepository(db: Kysely<Database>): AuditLogRepository {
  const databaseService = {
    getDatabase: () => db,
    getDbType: () => 'sqlite',
  } as unknown as DatabaseService;
  return new AuditLogRepository(databaseService);
}

describe('AuditLogRepository audit persistence helpers', () => {
  let db: Kysely<Database>;
  let repo: AuditLogRepository;

  beforeEach(async () => {
    db = makeDb();
    await createAuditLogs.run(db, 'sqlite');
    await hardenAuditLogs.run(db, 'sqlite');
    repo = makeRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('insertWithin', () => {
    const sample = {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      action: 'governance.approval.decided',
      resource_type: 'governance_approval',
      resource_id: 'apr-1',
      result: 'success',
      error_message: null,
      old_values: null,
      new_values: null,
      ip_address: null,
      user_agent: null,
      details: { requesterProvenance: 'squire_verified', sodWeak: false },
    } as const;

    it('writes the same row create() would, id aside', async () => {
      await repo.create({ ...sample, id: 'audit-create' });
      await db.transaction().execute(async (trx) => {
        await repo.insertWithin(trx, { ...sample, id: 'audit-within' });
      });

      const rows = await db.selectFrom('audit_logs').selectAll()
        .where('resource_id', '=', 'apr-1').orderBy('id').execute();
      expect(rows).toHaveLength(2);

      // Everything except the identity and the timestamp must match — the
      // point of extracting toInsertRow is that these two paths cannot drift.
      const strip = (r: Record<string, unknown>) => {
        const { id: _id, created_at: _createdAt, ...rest } = r;
        return rest;
      };
      expect(strip(rows[0] as unknown as Record<string, unknown>))
        .toEqual(strip(rows[1] as unknown as Record<string, unknown>));

      // And the JSON column is serialised, not left as a live object.
      expect(typeof rows[0].details).toBe('string');
      expect(JSON.parse(String(rows[0].details))).toEqual(sample.details);
    });

    it('writes nothing when the surrounding transaction rolls back', async () => {
      await expect(
        db.transaction().execute(async (trx) => {
          await repo.insertWithin(trx, { ...sample, id: 'audit-rollback', resource_id: 'apr-rollback' });
          throw new Error('caller failed after the audit insert');
        }),
      ).rejects.toThrow('caller failed after the audit insert');

      const rows = await db.selectFrom('audit_logs').selectAll()
        .where('resource_id', '=', 'apr-rollback').execute();
      expect(rows).toHaveLength(0);
    });
  });

  it('round-trips JSON details on sqlite', async () => {
    await repo.create({
      id: 'audit-1',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      action: 'execute_workflow',
      resource_type: 'multi_agent_orchestrator',
      resource_id: 'session-a',
      old_values: null,
      new_values: null,
      details: { schemaVersion: 1, message: 'stored' },
      result: 'success',
      error_message: null,
      duration_ms: 42,
      ip_address: null,
      user_agent: null,
    });

    const rows = await repo.findByAuditFilters({ tenantIds: ['tenant-a'] });
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toEqual({ schemaVersion: 1, message: 'stored' });
    expect(rows[0].duration_ms).toBe(42);
  });

  it('filters by tenant, session, result, and date', async () => {
    await repo.create({
      id: 'audit-1',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      action: 'execute_workflow',
      resource_type: 'multi_agent_orchestrator',
      resource_id: 'session-a',
      old_values: null,
      new_values: null,
      details: { schemaVersion: 1 },
      result: 'success',
      error_message: null,
      duration_ms: null,
      ip_address: null,
      user_agent: null,
    });
    await repo.create({
      id: 'audit-2',
      tenant_id: 'tenant-b',
      user_id: 'user-b',
      action: 'orchestrator_failure',
      resource_type: 'multi_agent_orchestrator',
      resource_id: 'session-b',
      old_values: null,
      new_values: null,
      details: { schemaVersion: 1 },
      result: 'failure',
      error_message: 'failed',
      duration_ms: null,
      ip_address: null,
      user_agent: null,
    });

    const rows = await repo.findByAuditFilters({
      tenantIds: ['tenant-b'],
      sessionIds: ['session-b'],
      result: 'failure',
      startDate: new Date('2000-01-01T00:00:00.000Z'),
      endDate: new Date('2999-01-01T00:00:00.000Z'),
    });

    expect(rows.map((row) => row.id)).toEqual(['audit-2']);
  });

  it('deletes rows older than a cutoff date', async () => {
    await sql`
      INSERT INTO audit_logs (
        id, tenant_id, user_id, action, resource_type, resource_id,
        result, created_at
      ) VALUES
        ('old-row', 'tenant-a', 'user-a', 'a', 'r', 'old', 'success', '2020-01-01T00:00:00.000Z'),
        ('new-row', 'tenant-a', 'user-a', 'a', 'r', 'new', 'success', '2026-01-01T00:00:00.000Z')
    `.execute(db);

    const deleted = await repo.deleteOlderThan(new Date('2025-01-01T00:00:00.000Z'));
    expect(deleted).toBe(1);

    const remaining = await repo.findByAuditFilters({ tenantIds: ['tenant-a'] });
    expect(remaining.map((row) => row.id)).toEqual(['new-row']);
  });

  it('deletes rows by id for retention cleanup', async () => {
    await sql`
      INSERT INTO audit_logs (
        id, tenant_id, user_id, action, resource_type, resource_id,
        result, created_at
      ) VALUES
        ('delete-me', 'tenant-a', 'user-a', 'a', 'r', 'delete-me', 'success', '2020-01-01T00:00:00.000Z'),
        ('keep-me', 'tenant-a', 'user-a', 'a', 'r', 'keep-me', 'success', '2020-01-01T00:00:00.000Z')
    `.execute(db);

    const deleted = await repo.deleteByIds(['delete-me']);
    expect(deleted).toBe(1);

    const remaining = await repo.findByAuditFilters({ tenantIds: ['tenant-a'] });
    expect(remaining.map((row) => row.id)).toEqual(['keep-me']);
  });

  // Most callers of create() omit `id` (authentication middleware,
  // ApiKeyService, OAuth2Service, ErrorHandlingService). Postgres has a column
  // default; SQLite does not, and it permits NULL in a TEXT primary key — so
  // those rows persisted with a NULL id and could never be targeted by
  // deleteByIds, which is the retention path.
  it('synthesizes an id when the caller omits one, so rows stay addressable', async () => {
    const base = {
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      action: 'a',
      resource_type: 'r',
      result: 'success' as const,
    };
    const first = await repo.create({ ...base, resource_id: 'first' });
    const second = await repo.create({ ...base, resource_id: 'second' });

    for (const row of [first, second]) {
      expect(typeof row.id).toBe('string');
      expect(row.id).not.toHaveLength(0);
    }
    expect(first.id).not.toBe(second.id);

    // Addressable: the retention path can target one without touching the other.
    expect(await repo.deleteByIds([first.id])).toBe(1);
    const remaining = await repo.findByAuditFilters({ tenantIds: ['tenant-a'] });
    expect(remaining.map((row) => row.resource_id)).toEqual(['second']);
  });

  it('preserves a caller-supplied id verbatim on sqlite', async () => {
    const created = await repo.create({
      id: 'audit_1753000000000_abc',
      tenant_id: 'tenant-a',
      user_id: 'user-a',
      action: 'a',
      resource_type: 'r',
      resource_id: 'supplied',
      result: 'success',
    });

    expect(created.id).toBe('audit_1753000000000_abc');
  });
});
