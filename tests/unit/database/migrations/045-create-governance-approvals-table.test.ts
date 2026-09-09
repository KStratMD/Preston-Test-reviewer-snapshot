import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { migration as createGovernanceApprovals } from '../../../../src/database/migrations/045-create-governance-approvals-table';

// Returns BOTH the Kysely handle and the underlying BetterSqlite3 handle so
// `finally` can close the sqlite connection explicitly. Kysely.destroy() does
// NOT close the underlying sqlite handle — without sqlite.close() the file
// descriptor leaks and can keep the Jest event loop alive (mirrors the helper
// pattern in tests/unit/services/governance/ApprovalQueueRepository.test.ts).
// Copilot R1 PR #819.
function freshDb(): { db: Kysely<Database>; sqlite: BetterSqlite3.Database } {
  const sqlite = new BetterSqlite3(':memory:');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return { db, sqlite };
}

async function columnNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`.execute(db);
  return rows.rows.map((r) => r.name);
}

async function indexNames(db: Kysely<Database>, table: string): Promise<string[]> {
  const rows = await sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ${table}`.execute(db);
  return rows.rows.map((r) => r.name);
}

describe('Migration 045 — create governance_approvals table', () => {
  it('has the expected name', () => {
    expect(createGovernanceApprovals.name).toBe('create_governance_approvals_table');
  });

  it('creates the table with all expected columns', async () => {
    const { db, sqlite } = freshDb();
    try {
      await createGovernanceApprovals.run(db, 'sqlite');
      const cols = await columnNames(db, 'governance_approvals');
      expect(cols).toEqual(
        expect.arrayContaining([
          'id',
          'tenant_id',
          'requester_user_id',
          'operation_type',
          'resource_type',
          'resource_id',
          'risk_level',
          'redacted_payload',
          'policy_findings',
          'status',
          'created_at',
          'expires_at',
          'decided_at',
          'decided_by_user_id',
          'decision_reason',
          'apply_idempotency_key',
        ]),
      );
    } finally {
      await db.destroy();
      sqlite.close();
    }
  });

  it('creates the three indexes (two tenant-scoped + one maintenance)', async () => {
    const { db, sqlite } = freshDb();
    try {
      await createGovernanceApprovals.run(db, 'sqlite');
      const indexes = await indexNames(db, 'governance_approvals');
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_governance_approvals_tenant_status',
          'idx_governance_approvals_tenant_created',
          'idx_governance_approvals_expires_pending',
        ]),
      );
    } finally {
      await db.destroy();
      sqlite.close();
    }
  });

  it('is idempotent — replaying the migration is a no-op', async () => {
    const { db, sqlite } = freshDb();
    try {
      await createGovernanceApprovals.run(db, 'sqlite');
      await expect(createGovernanceApprovals.run(db, 'sqlite')).resolves.toBeUndefined();
      const cols = await columnNames(db, 'governance_approvals');
      expect(cols).toContain('id');
    } finally {
      await db.destroy();
      sqlite.close();
    }
  });

  it('accepts inserts with the expected shape', async () => {
    const { db, sqlite } = freshDb();
    try {
      await createGovernanceApprovals.run(db, 'sqlite');
      const redactedPayload = JSON.stringify({ email: '[REDACTED]', amount: 100 });
      const policyFindings = JSON.stringify(['ssn']);
      await sql`
        INSERT INTO governance_approvals (
          id, tenant_id, requester_user_id, operation_type, resource_type, resource_id,
          risk_level, redacted_payload, policy_findings, status, created_at, expires_at,
          decided_at, decided_by_user_id, decision_reason, apply_idempotency_key
        ) VALUES (
          'APR-1', 'tenant-A', 'user-1', 'connector_call', 'connector', 'salesforce',
          'high', ${redactedPayload}, ${policyFindings}, 'pending',
          '2026-05-18T00:00:00Z', '2026-05-18T01:00:00Z',
          '2026-05-18T00:30:00Z', 'approver-1', 'looks good', 'idem-key-1'
        )
      `.execute(db);
      const rows = await sql<{ id: string; redacted_payload: string; policy_findings: string }>`
        SELECT id, redacted_payload, policy_findings FROM governance_approvals WHERE id = 'APR-1'
      `.execute(db);
      expect(rows.rows[0]?.id).toBe('APR-1');
      expect(rows.rows[0]?.redacted_payload).toBe(redactedPayload);
      expect(rows.rows[0]?.policy_findings).toBe(policyFindings);
    } finally {
      await db.destroy();
      sqlite.close();
    }
  });

  it('allows nullable decided_at / decided_by_user_id / decision_reason / apply_idempotency_key', async () => {
    const { db, sqlite } = freshDb();
    try {
      await createGovernanceApprovals.run(db, 'sqlite');
      const redactedPayload = JSON.stringify({ amount: 50 });
      const policyFindings = JSON.stringify([]);
      await sql`
        INSERT INTO governance_approvals (
          id, tenant_id, requester_user_id, operation_type, resource_type, resource_id,
          risk_level, redacted_payload, policy_findings, status, created_at, expires_at,
          decided_at, decided_by_user_id, decision_reason, apply_idempotency_key
        ) VALUES (
          'APR-2', 'tenant-A', 'user-1', 'connector_call', 'connector', 'gmail',
          'low', ${redactedPayload}, ${policyFindings}, 'pending',
          '2026-05-18T00:00:01Z', '2026-05-18T01:00:01Z',
          NULL, NULL, NULL, NULL
        )
      `.execute(db);
      const rows = await sql<{
        decided_at: string | null;
        decided_by_user_id: string | null;
        decision_reason: string | null;
        apply_idempotency_key: string | null;
      }>`
        SELECT decided_at, decided_by_user_id, decision_reason, apply_idempotency_key
        FROM governance_approvals WHERE id = 'APR-2'
      `.execute(db);
      expect(rows.rows[0]?.decided_at).toBeNull();
      expect(rows.rows[0]?.decided_by_user_id).toBeNull();
      expect(rows.rows[0]?.decision_reason).toBeNull();
      expect(rows.rows[0]?.apply_idempotency_key).toBeNull();
    } finally {
      await db.destroy();
      sqlite.close();
    }
  });
});
