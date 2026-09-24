import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

const MIGRATION_061_NAME = 'delete_system_tenant_demo_fixtures';
const MIGRATION_062_NAME = 'add_governance_approval_request_fingerprint';

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
// + string match instead (same pattern as the 040/042/049/056/057/058 tests).
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

const CREATED = '2026-08-08T00:00:00.000Z';
const FUTURE = '2026-08-09T00:00:00.000Z';
const PAST = '2026-08-07T00:00:00.000Z';
const FP_A = 'a'.repeat(64);
const FP_B = 'b'.repeat(64);

interface ApprovalOverrides {
  id?: string;
  tenantId?: string;
  operationType?: string;
  status?: string;
  expiresAt?: string;
  fingerprint?: string | null;
}

async function insertApproval(db: Kysely<Database>, o: ApprovalOverrides = {}): Promise<void> {
  await sql`
    INSERT INTO governance_approvals
      (id, tenant_id, requester_user_id, operation_type, resource_type, resource_id,
       risk_level, redacted_payload, policy_findings, status, created_at, expires_at,
       request_fingerprint)
    VALUES
      (${o.id ?? `ap-${Math.random().toString(36).slice(2)}`},
       ${o.tenantId ?? 'tenant-a'}, ${'user-1'}, ${o.operationType ?? 'ownership_write'},
       ${'contacts'}, ${'new'}, ${'medium'}, ${'{}'}, ${'[]'},
       ${o.status ?? 'pending'}, ${CREATED}, ${o.expiresAt ?? FUTURE},
       ${o.fingerprint === undefined ? FP_A : o.fingerprint})
  `.execute(db);
}

describe('migration 062 — governance_approvals.request_fingerprint', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('registration', () => {
    it('is registered exactly once, immediately after migration 061', () => {
      const names = MIGRATIONS.map((m) => m.name);
      expect(names.filter((n) => n === MIGRATION_062_NAME)).toHaveLength(1);
      expect(names.indexOf(MIGRATION_062_NAME)).toBe(names.indexOf(MIGRATION_061_NAME) + 1);
      // Deliberately NOT asserting this is the last migration. That claim was
      // here and broke the moment 063 landed: "is last" is a property of the
      // repository's history, not of this migration, so it would fail every
      // future PR for no reason. Relative ordering is the real invariant.
    });

    it('is idempotent on replay', async () => {
      const m062 = MIGRATIONS.find((m) => m.name === MIGRATION_062_NAME);
      expect(m062).toBeDefined();
      await m062!.run(db, 'sqlite');
      await m062!.run(db, 'sqlite');

      await insertApproval(db);
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(1);
    });
  });

  describe('the column', () => {
    it('accepts a fingerprint and reads it back', async () => {
      await insertApproval(db, { id: 'ap-1', fingerprint: FP_A });
      const rows = await sql<{ request_fingerprint: string | null }>`
        SELECT request_fingerprint FROM governance_approvals WHERE id = ${'ap-1'}
      `.execute(db);
      expect(rows.rows[0]!.request_fingerprint).toBe(FP_A);
    });

    it('is nullable, so legacy and non-ownership rows need no backfill', async () => {
      await insertApproval(db, { id: 'ap-legacy', operationType: 'ai_call', fingerprint: null });
      const rows = await sql<{ request_fingerprint: string | null }>`
        SELECT request_fingerprint FROM governance_approvals WHERE id = ${'ap-legacy'}
      `.execute(db);
      expect(rows.rows[0]!.request_fingerprint).toBeNull();
    });
  });

  describe('the partial unique index — the dedupe domain', () => {
    it('REJECTS a second pending ownership row with the same tenant and fingerprint', async () => {
      await insertApproval(db, { id: 'ap-1', fingerprint: FP_A });
      const message = await captureExecError(() => insertApproval(db, { id: 'ap-2', fingerprint: FP_A }));
      expect(message).toMatch(/UNIQUE constraint failed/i);
    });

    it('allows the same fingerprint under a DIFFERENT tenant', async () => {
      // Tenant scoping is the point: two tenants issuing an identical write
      // intent are two separate approvals, and collapsing them would leak one
      // tenant's queue state into another's.
      await insertApproval(db, { id: 'ap-1', tenantId: 'tenant-a', fingerprint: FP_A });
      await insertApproval(db, { id: 'ap-2', tenantId: 'tenant-b', fingerprint: FP_A });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('allows a different fingerprint under the same tenant', async () => {
      await insertApproval(db, { id: 'ap-1', fingerprint: FP_A });
      await insertApproval(db, { id: 'ap-2', fingerprint: FP_B });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it.each(['approved', 'rejected', 'expired'])(
      'does not let a %s row block a new pending one with the same fingerprint',
      async (terminalStatus) => {
        // A decided approval is history. Blocking on it would mean a write
        // intent could only ever be approved ONCE for the lifetime of the
        // tenant — the same mutation could never legitimately recur.
        await insertApproval(db, { id: 'ap-old', status: terminalStatus, fingerprint: FP_A });
        await insertApproval(db, { id: 'ap-new', status: 'pending', fingerprint: FP_A });
        const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
        expect(Number(rows.rows[0]!.c)).toBe(2);
      },
    );

    it('does not constrain non-ownership operation types', async () => {
      await insertApproval(db, { id: 'ap-1', operationType: 'ai_call', fingerprint: FP_A });
      await insertApproval(db, { id: 'ap-2', operationType: 'ai_call', fingerprint: FP_A });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('does not collapse legacy NULL-fingerprint pending rows onto each other', async () => {
      // SQL NULLs are distinct under a unique index, but assert it rather than
      // assume: if it were otherwise, the migration would fail on any existing
      // deployment carrying two pending ownership rows.
      await insertApproval(db, { id: 'ap-1', fingerprint: null });
      await insertApproval(db, { id: 'ap-2', fingerprint: null });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });

    it('still blocks an EXPIRED-BY-TIME row that is nonetheless status=pending', async () => {
      // The index predicate cannot express `expires_at > now` — a partial index
      // must be immutable — so a stale unreaped row DOES block. That is exactly
      // why enqueue needs the bounded conflict protocol (A8.3) rather than
      // relying on the index alone; pinning it here so the protocol's reason
      // for existing is visible in the schema tests.
      await insertApproval(db, { id: 'ap-stale', status: 'pending', expiresAt: PAST, fingerprint: FP_A });
      const message = await captureExecError(() =>
        insertApproval(db, { id: 'ap-new', status: 'pending', expiresAt: FUTURE, fingerprint: FP_A }),
      );
      expect(message).toMatch(/UNIQUE constraint failed/i);
    });

    it('frees the fingerprint once the blocking row leaves pending', async () => {
      await insertApproval(db, { id: 'ap-stale', status: 'pending', expiresAt: PAST, fingerprint: FP_A });
      await sql`UPDATE governance_approvals SET status = ${'expired'} WHERE id = ${'ap-stale'}`.execute(db);
      await insertApproval(db, { id: 'ap-new', status: 'pending', fingerprint: FP_A });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM governance_approvals`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(2);
    });
  });
});
