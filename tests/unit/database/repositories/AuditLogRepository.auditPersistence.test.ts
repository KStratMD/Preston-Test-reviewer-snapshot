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
});
