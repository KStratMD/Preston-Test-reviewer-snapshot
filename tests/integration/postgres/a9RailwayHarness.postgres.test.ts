import { Kysely, PostgresDialect, sql } from 'kysely';
import { Pool } from 'pg';
import type { Database } from '../../../src/database/types';
import {
  A9HarnessError,
  A9RailwayHarness,
  parseA9HarnessEnvironment,
} from '../../../src/services/serializedAsset/A9RailwayHarness';

const ADMIN_DATABASE_URL = process.env.DATABASE_URL!;
const TEST_DATABASE_NAME = `a9_harness_${process.pid}_${Math.random().toString(36).slice(2, 10)}`;
const BASE_RUN_ID = '22222222-2222-4222-8222-222222222222';
const BASE_GIT_SHA = '0123456789abcdef0123456789abcdef01234567';

function makeEnvironment(
  runId = BASE_RUN_ID,
  replicaId = 'replica-a',
  deploymentId = 'deployment-a',
) {
  return parseA9HarnessEnvironment({
    A9_RAILWAY_HARNESS_ACK: 'MUTATE_DISPOSABLE_A9_DATABASE',
    A9_HARNESS_RUN_ID: runId,
    RAILWAY_ENVIRONMENT_NAME: 'a9-harness-postgres-test',
    RAILWAY_REPLICA_ID: replicaId,
    RAILWAY_DEPLOYMENT_ID: deploymentId,
    RAILWAY_GIT_COMMIT_SHA: BASE_GIT_SHA,
    DATABASE_URL: ADMIN_DATABASE_URL,
  });
}

function makeDisposableDatabaseUrl(): string {
  const databaseUrl = new URL(ADMIN_DATABASE_URL);
  databaseUrl.pathname = `/${TEST_DATABASE_NAME}`;
  return databaseUrl.toString();
}

describe('A9RailwayHarness PostgreSQL isolation and initialization', () => {
  let adminPool: Pool;
  let databaseAdminPool: Pool;
  let harnessPool: Pool;
  let db: Kysely<Database>;
  let unexpectedPostgresPoolError: unknown = null;

  function observePool(pool: Pool): Pool {
    pool.on('error', (error: unknown) => {
      if (!error || typeof error !== 'object' || !('code' in error) || (error as { code?: unknown }).code !== '57P01') {
        unexpectedPostgresPoolError = error;
      }
    });
    return pool;
  }

  beforeAll(async () => {
    adminPool = observePool(new Pool({ connectionString: ADMIN_DATABASE_URL, connectionTimeoutMillis: 2_000 }));
    if (!/^[a-z0-9_]+$/.test(TEST_DATABASE_NAME)) throw new Error('invalid disposable database identifier');
    await adminPool.query(`CREATE DATABASE "${TEST_DATABASE_NAME}"`);

    const databaseUrl = new URL(makeDisposableDatabaseUrl());
    harnessPool = observePool(new Pool({
      connectionString: databaseUrl.toString(),
      max: 4,
      connectionTimeoutMillis: 2_000,
      options: '-c search_path=public -c lock_timeout=10000 -c statement_timeout=15000 -c idle_in_transaction_session_timeout=30000',
    }));
    databaseAdminPool = observePool(new Pool({ connectionString: databaseUrl.toString(), connectionTimeoutMillis: 2_000 }));
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool: harnessPool }) });
  });

  afterAll(async () => {
    await db.destroy();
    await databaseAdminPool.end();
    await adminPool.query(`DROP DATABASE IF EXISTS "${TEST_DATABASE_NAME}"`);
    await adminPool.end();
    if (unexpectedPostgresPoolError !== null) throw unexpectedPostgresPoolError;
  });

  beforeEach(async () => {
    await databaseAdminPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  });

  it('serializes same-run initialization and assigns distinct roles A and B', async () => {
    const first = new A9RailwayHarness(db, makeEnvironment(BASE_RUN_ID, 'replica-a'), 'postgres');
    const second = new A9RailwayHarness(db, makeEnvironment(BASE_RUN_ID, 'replica-b'), 'postgres');

    const roles = await Promise.all([first.initializeParticipant(), second.initializeParticipant()]);
    expect(new Set(roles)).toEqual(new Set(['A', 'B']));
    const guard = await sql<{ run_id: string }>`SELECT run_id FROM a9_harness_guard`.execute(db);
    expect(guard.rows).toEqual([{ run_id: BASE_RUN_ID }]);
  });

  it('rejects the cross-run loser with the fixed schema code and no loser mutation', async () => {
    const firstRun = new A9RailwayHarness(db, makeEnvironment(BASE_RUN_ID, 'replica-a', 'deployment-a'), 'postgres');
    const secondRun = new A9RailwayHarness(
      db,
      makeEnvironment('33333333-3333-4333-8333-333333333333', 'replica-b', 'deployment-b'),
      'postgres',
    );

    const results = await Promise.allSettled([
      firstRun.initializeParticipant(),
      secondRun.initializeParticipant(),
    ]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<'A' | 'B'> => result.status === 'fulfilled');
    const rejected = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(A9HarnessError);
    expect((rejected[0].reason as A9HarnessError).code).toBe('A9_SCHEMA_REJECTED');

    const rows = await sql<{ run_id: string; replica_id: string }>`
      SELECT run_id, replica_id FROM a9_harness_participants
    `.execute(db);
    expect(rows.rows).toHaveLength(1);
    const guardRunId = (await sql<{ run_id: string }>`SELECT run_id FROM a9_harness_guard`.execute(db)).rows[0].run_id;
    expect(rows.rows[0].run_id).toBe(guardRunId);
    expect([BASE_RUN_ID, '33333333-3333-4333-8333-333333333333']).toContain(guardRunId);
    expect((await sql`SELECT COUNT(*)::int AS count FROM a9_harness_events`.execute(db)).rows[0].count).toBe(0);
    expect((await sql`SELECT COUNT(*)::int AS count FROM serialized_asset_retry_operations`.execute(db)).rows[0].count).toBe(0);
  });

  it('rejects a non-public effective search path before touching the schema', async () => {
    await databaseAdminPool.query('CREATE SCHEMA other');
    const databaseUrl = new URL(makeDisposableDatabaseUrl());
    const wrongPathPool = observePool(new Pool({
      connectionString: databaseUrl.toString(),
      max: 1,
      options: '-c search_path=other -c lock_timeout=10000 -c statement_timeout=15000',
    }));
    const wrongPathDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: wrongPathPool }) });
    try {
      await expect(new A9RailwayHarness(wrongPathDb, makeEnvironment(), 'postgres').initializeParticipant()).rejects.toMatchObject({
        code: 'A9_SCHEMA_REJECTED',
      });
      expect((await databaseAdminPool.query("SELECT to_regclass('public.a9_harness_guard') AS guard")).rows[0].guard).toBeNull();
    } finally {
      await wrongPathDb.destroy();
    }
  });

  it.each(['table', 'view', 'materialized view', 'sequence'])('rejects a pre-existing public %s', async (kind) => {
    if (kind === 'table') await databaseAdminPool.query('CREATE TABLE public.preexisting_table (id INTEGER)');
    if (kind === 'view') await databaseAdminPool.query('CREATE VIEW public.preexisting_view AS SELECT 1 AS id');
    if (kind === 'materialized view') await databaseAdminPool.query('CREATE MATERIALIZED VIEW public.preexisting_materialized_view AS SELECT 1 AS id');
    if (kind === 'sequence') await databaseAdminPool.query('CREATE SEQUENCE public.preexisting_sequence');

    await expect(new A9RailwayHarness(db, makeEnvironment(), 'postgres').initializeParticipant()).rejects.toMatchObject({
      code: 'A9_SCHEMA_REJECTED',
    });
  });

  it('rejects a pre-existing foreign table relation', async () => {
    await databaseAdminPool.query('CREATE EXTENSION IF NOT EXISTS postgres_fdw');
    await databaseAdminPool.query("CREATE SERVER a9_dummy FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host '127.0.0.1')");
    await databaseAdminPool.query("CREATE FOREIGN TABLE public.preexisting_foreign (id INTEGER) SERVER a9_dummy OPTIONS (table_name 'missing')");
    await expect(new A9RailwayHarness(db, makeEnvironment(), 'postgres').initializeParticipant()).rejects.toMatchObject({
      code: 'A9_SCHEMA_REJECTED',
    });
  });

  it('maps a held initialization lock to the fixed timeout code', async () => {
    const timeoutPool = observePool(new Pool({
      connectionString: makeDisposableDatabaseUrl(),
      max: 1,
      connectionTimeoutMillis: 2_000,
      options: '-c search_path=public -c lock_timeout=100 -c statement_timeout=1000',
    }));
    const timeoutDb = new Kysely<Database>({ dialect: new PostgresDialect({ pool: timeoutPool }) });
    const lockClient = await databaseAdminPool.connect();
    const startedAt = Date.now();
    try {
      await lockClient.query('BEGIN');
      await lockClient.query("SELECT pg_advisory_xact_lock(hashtextextended('preston-a9-harness-init-v1', 0))");
      await expect(new A9RailwayHarness(timeoutDb, makeEnvironment(), 'postgres').initializeParticipant()).rejects.toMatchObject({
        code: 'A9_TIMEOUT',
      });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await lockClient.query('ROLLBACK');
      lockClient.release();
      await timeoutDb.destroy();
    }
  });

  it('cuts off a deliberately long PostgreSQL query with statement_timeout', async () => {
    const timeoutPool = observePool(new Pool({
      connectionString: makeDisposableDatabaseUrl(),
      max: 1,
      connectionTimeoutMillis: 2_000,
      options: '-c search_path=public -c lock_timeout=1000 -c statement_timeout=100',
    }));
    const startedAt = Date.now();
    try {
      await expect(timeoutPool.query('SELECT pg_sleep(1)')).rejects.toMatchObject({ code: '57014' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    } finally {
      await timeoutPool.end();
    }
  });

  it('creates migration 063 objects without migrator bookkeeping', async () => {
    await new A9RailwayHarness(db, makeEnvironment(), 'postgres').initializeParticipant();
    const relations = await databaseAdminPool.query(
      "SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY relname",
    );
    expect(relations.rows.map((row) => row.relname)).toEqual([
      'a9_harness_events',
      'a9_harness_guard',
      'a9_harness_participants',
      'serialized_asset_retry_operations',
    ]);
    expect((await databaseAdminPool.query("SELECT to_regclass('public.migrations') AS migrations")).rows[0].migrations).toBeNull();
    const indexes = await databaseAdminPool.query(
      "SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('uq_serialized_asset_retry_active', 'idx_serialized_asset_retry_tenant_config_status', 'idx_serialized_asset_retry_claimable') ORDER BY indexname",
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      'idx_serialized_asset_retry_claimable',
      'idx_serialized_asset_retry_tenant_config_status',
      'uq_serialized_asset_retry_active',
    ]);
  });
});
