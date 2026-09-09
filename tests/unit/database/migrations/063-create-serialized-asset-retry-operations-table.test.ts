import 'reflect-metadata';
import { Kysely, SqliteDialect, sql } from 'kysely';
import BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../../../../src/database/types';
import { MIGRATIONS } from '../../../../src/database/migrations';

const MIGRATION_062_NAME = 'add_governance_approval_request_fingerprint';
const MIGRATION_063_NAME = 'create_serialized_asset_retry_operations_table';

function makeDb(): Kysely<Database> {
  return new Kysely<Database>({ dialect: new SqliteDialect({ database: new BetterSqlite3(':memory:') }) });
}

async function runAll(db: Kysely<Database>): Promise<void> {
  for (const m of MIGRATIONS) await m.run(db, 'sqlite');
}

// better-sqlite3 caches its SqliteError constructor process-globally, so
// `.rejects.toThrow()` can misfire across Jest VM realms. Capture via try/catch
// + string match instead (same pattern as the 040/042/049/056/057/058/062 tests).
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

const NOW = '2026-08-08T00:00:00.000Z';
const LATER = '2026-08-08T00:05:00.000Z';

interface OpOverrides {
  id?: string;
  tenantId?: string;
  configurationId?: string;
  status?: string;
  leaseOwner?: string | null;
  fencingToken?: number;
}

async function insertOperation(db: Kysely<Database>, o: OpOverrides = {}): Promise<void> {
  await sql`
    INSERT INTO serialized_asset_retry_operations
      (id, tenant_id, configuration_id, requester_user_id, correlation_id,
       status, lease_owner, fencing_token, created_at)
    VALUES
      (${o.id ?? `op-${Math.random().toString(36).slice(2, 10)}`},
       ${o.tenantId ?? 'tenant-a'}, ${o.configurationId ?? 'cfg-1'},
       ${'user-1'}, ${'corr-1'},
       ${o.status ?? 'accepted'}, ${o.leaseOwner ?? null}, ${o.fencingToken ?? 0}, ${NOW})
  `.execute(db);
}

describe('migration 063 — serialized_asset_retry_operations', () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = makeDb();
    await runAll(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe('registration', () => {
    it('is registered exactly once, immediately after migration 062', () => {
      const names = MIGRATIONS.map((m) => m.name);
      expect(names.filter((n) => n === MIGRATION_063_NAME)).toHaveLength(1);
      expect(names.indexOf(MIGRATION_063_NAME)).toBe(names.indexOf(MIGRATION_062_NAME) + 1);
      // No "is last" assertion — see the matching note in the 062 test. It
      // would fail on migration 064 without anything being wrong.
    });

    it('is idempotent on replay', async () => {
      const m063 = MIGRATIONS.find((m) => m.name === MIGRATION_063_NAME);
      expect(m063).toBeDefined();
      await m063!.run(db, 'sqlite');
      await m063!.run(db, 'sqlite');

      await insertOperation(db);
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM serialized_asset_retry_operations`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(1);
    });
  });

  describe('the closed status vocabulary', () => {
    it.each(['accepted', 'running', 'succeeded', 'failed', 'interrupted'])(
      'accepts the %s status',
      async (status) => {
        await insertOperation(db, { id: `op-${status}`, status });
        const rows = await sql<{ status: string }>`
          SELECT status FROM serialized_asset_retry_operations WHERE id = ${`op-${status}`}
        `.execute(db);
        expect(rows.rows[0]!.status).toBe(status);
      },
    );

    it('rejects a status outside the vocabulary', async () => {
      // A CHECK constraint, not merely a TypeScript union: the column is the
      // last line of defence for a value the worker reads back and dispatches
      // on, and a typo'd status that persists would strand the operation in a
      // state no code path can advance.
      const message = await captureExecError(() => insertOperation(db, { status: 'inflight' }));
      expect(message).toMatch(/CHECK constraint failed/i);
    });
  });

  describe('the single-active-operation rule', () => {
    it.each([
      ['accepted', 'accepted'],
      ['accepted', 'running'],
      ['running', 'running'],
    ])('refuses a second %s operation while one is %s for the same tenant + configuration', async (first, second) => {
      // The whole point of a durable reservation: a second forced retry for the
      // same configuration must converge on the existing operation rather than
      // start parallel work against the same backlog.
      await insertOperation(db, { id: 'op-1', status: first });
      const message = await captureExecError(() => insertOperation(db, { id: 'op-2', status: second }));
      expect(message).toMatch(/UNIQUE constraint failed/i);
    });

    it.each(['succeeded', 'failed', 'interrupted'])(
      'allows a new operation once the previous one is %s',
      async (terminal) => {
        // A finished retry is history. If terminal rows blocked, a
        // configuration could be force-retried exactly once, ever.
        await insertOperation(db, { id: 'op-old', status: terminal });
        await insertOperation(db, { id: 'op-new', status: 'accepted' });
        const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM serialized_asset_retry_operations`.execute(db);
        expect(Number(rows.rows[0]!.c)).toBe(2);
      },
    );

    it('scopes the rule per tenant and per configuration', async () => {
      await insertOperation(db, { id: 'op-a', tenantId: 'tenant-a', configurationId: 'cfg-1' });
      await insertOperation(db, { id: 'op-b', tenantId: 'tenant-b', configurationId: 'cfg-1' });
      await insertOperation(db, { id: 'op-c', tenantId: 'tenant-a', configurationId: 'cfg-2' });
      const rows = await sql<{ c: number }>`SELECT COUNT(*) AS c FROM serialized_asset_retry_operations`.execute(db);
      expect(Number(rows.rows[0]!.c)).toBe(3);
    });
  });

  describe('lease and fencing columns', () => {
    it('defaults a fresh reservation to an unowned lease at token zero', async () => {
      await insertOperation(db, { id: 'op-1' });
      const rows = await sql<{
        lease_owner: string | null;
        fencing_token: number;
        lease_expires_at: string | null;
        heartbeat_at: string | null;
        started_at: string | null;
        finished_at: string | null;
      }>`
        SELECT lease_owner, fencing_token, lease_expires_at, heartbeat_at, started_at, finished_at
        FROM serialized_asset_retry_operations WHERE id = ${'op-1'}
      `.execute(db);
      const row = rows.rows[0]!;
      expect(row.lease_owner).toBeNull();
      expect(Number(row.fencing_token)).toBe(0);
      expect(row.lease_expires_at).toBeNull();
      expect(row.heartbeat_at).toBeNull();
      expect(row.started_at).toBeNull();
      expect(row.finished_at).toBeNull();
    });

    it('round-trips a claim: owner, token, lease expiry and heartbeat', async () => {
      await insertOperation(db, { id: 'op-1' });
      await sql`
        UPDATE serialized_asset_retry_operations
        SET status = ${'running'}, lease_owner = ${'worker-1'}, fencing_token = ${1},
            lease_expires_at = ${LATER}, heartbeat_at = ${NOW}, started_at = ${NOW}
        WHERE id = ${'op-1'}
      `.execute(db);

      const rows = await sql<{ lease_owner: string; fencing_token: number; lease_expires_at: string }>`
        SELECT lease_owner, fencing_token, lease_expires_at
        FROM serialized_asset_retry_operations WHERE id = ${'op-1'}
      `.execute(db);
      expect(rows.rows[0]!.lease_owner).toBe('worker-1');
      expect(Number(rows.rows[0]!.fencing_token)).toBe(1);
      expect(rows.rows[0]!.lease_expires_at).toBe(LATER);
    });
  });

  describe('the sanitized result projection', () => {
    it('stores bounded counters and a fixed error code/class, and nothing else', async () => {
      // Decision 8: this table is operator-readable and reaches an HTTP status
      // endpoint, so it must never hold a serial number, a source payload, a
      // raw connector error, or a cause chain. The schema enforces that by
      // having nowhere to put one.
      await insertOperation(db, { id: 'op-1', status: 'running' });
      await sql`
        UPDATE serialized_asset_retry_operations
        SET status = ${'failed'}, finished_at = ${LATER},
            units_read = ${10}, units_upserted = ${4}, units_deferred = ${3},
            units_quarantined = ${2}, units_failed = ${1},
            error_code = ${'target_write_failed'}, error_class = ${'ConnectorError'}
        WHERE id = ${'op-1'}
      `.execute(db);

      const cols = await sql<{ name: string }>`
        SELECT name FROM pragma_table_info(${'serialized_asset_retry_operations'})
      `.execute(db);
      const names = cols.rows.map((r) => r.name).sort();
      expect(names).toEqual([
        'configuration_id',
        'correlation_id',
        'created_at',
        'error_class',
        'error_code',
        'fencing_token',
        'finished_at',
        'heartbeat_at',
        'id',
        'lease_expires_at',
        'lease_owner',
        'requester_user_id',
        'started_at',
        'status',
        'tenant_id',
        'units_deferred',
        'units_failed',
        'units_quarantined',
        'units_read',
        'units_upserted',
      ]);
    });
  });
});
