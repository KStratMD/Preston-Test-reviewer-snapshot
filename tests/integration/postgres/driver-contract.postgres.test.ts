import { Pool } from 'pg';
import { PostgresTransferTarget } from '../../../src/database/transfer/postgresTarget';
import { reconcilePostgres } from '../../../src/database/transfer/reconcile';
import { digestCanonicalRow, digestCanonicalTable, digestHex } from '../../../src/database/transfer/digests';
import { createTemporaryPostgresDatabase, transferManifest, type TemporaryPostgresDatabase } from './db-transfer-fixture';

describe('PostgreSQL driver compatibility contracts', () => {
  let database: TemporaryPostgresDatabase;
  let target: PostgresTransferTarget;
  let ordinary: Pool;

  beforeAll(async () => {
    database = await createTemporaryPostgresDatabase();
    target = new PostgresTransferTarget({ connectionString: database.connectionString, manifest: transferManifest });
    ordinary = new Pool({ connectionString: database.connectionString, max: 1 });
  });

  afterAll(async () => {
    await ordinary?.end();
    await target?.close();
    await database?.close();
  });

  it('retains the seven transfer text parsers without changing ordinary pools', async () => {
    const query = `SELECT '2026-09-12'::date AS day,
      '2026-09-12 12:34:56.123456'::timestamp AS local_time,
      '2026-09-12 12:34:56.123456+00'::timestamptz AS instant,
      '1.25'::real AS narrow_float, '1.125'::double precision AS wide_float,
      '{"n":9007199254740993}'::json AS raw_json,
      '{"n":9007199254740993}'::jsonb AS normalized_json`;
    expect((await target.pool.query(query)).rows).toEqual([{
      day: '2026-09-12', local_time: '2026-09-12 12:34:56.123456',
      instant: '2026-09-12 12:34:56.123456+00', narrow_float: '1.25', wide_float: '1.125',
      raw_json: '{"n":9007199254740993}', normalized_json: '{"n": 9007199254740993}',
    }]);
    const normal = (await ordinary.query(query)).rows[0];
    expect(normal.narrow_float).toBe(1.25);
    expect(normal.wide_float).toBe(1.125);
    expect(normal.instant).toBeInstanceOf(Date);
    expect(typeof normal.raw_json).toBe('object');
    expect(typeof normal.normalized_json).toBe('object');
  });

  it('reads and reconciles an exact PostgreSQL int8 and detects a one-unit change', async () => {
    // Direct PostgreSQL fixture: this does not exercise the SQLite export reader.
    await target.pool.query(`CREATE TABLE sync_error_assist_runs (
      tenant_id TEXT PRIMARY KEY, last_modified_at BIGINT NOT NULL, updated_at TIMESTAMP NOT NULL)`);
    await target.pool.query('INSERT INTO sync_error_assist_runs VALUES ($1, $2, $3)',
      ['driver-contract', '9007199254740993', '2026-09-12 12:34:56.123456']);
    const result = await target.pool.query('SELECT last_modified_at FROM sync_error_assist_runs');
    expect(result.rows[0].last_modified_at).toBe('9007199254740993');
    const manifest = { ...transferManifest, tables: transferManifest.tables.filter((table) => table.name === 'sync_error_assist_runs') };
    expect(manifest.tables).toHaveLength(1);
    const digest = digestHex(digestCanonicalTable([digestCanonicalRow([
      { type: 'text', value: 'driver-contract' },
      { type: 'integer', value: '9007199254740993' },
      { type: 'naive_timestamp', value: '2026-09-12T12:34:56.123456' },
    ])]));
    const frames = [{ type: 'table_end' as const, table: 'sync_error_assist_runs', rowCount: 1, digest }];
    await expect(reconcilePostgres(target.pool, frames, manifest)).resolves.toEqual({ ok: true, mismatches: [] });
    await target.pool.query('UPDATE sync_error_assist_runs SET last_modified_at = last_modified_at - 1');
    const mismatch = await reconcilePostgres(target.pool, frames, manifest);
    expect(mismatch.ok).toBe(false);
    expect(mismatch.mismatches).toEqual([expect.objectContaining({ table: 'sync_error_assist_runs', code: 'DIGEST_MISMATCH' })]);
  });

  it('preserves queued parameter results and recovers after a failed named parse', async () => {
    const client = await ordinary.connect();
    try {
      const queued = await Promise.all([1, 2, 3].map((value) => client.query('SELECT $1::integer AS value', [value])));
      expect(queued.map((result) => result.rows[0].value)).toEqual([1, 2, 3]);
      await client.query('BEGIN');
      // Named queries are upstream compatibility coverage; app queries are unnamed.
      await expect(client.query({ name: 'failed-parse', text: 'SELECT * FROM' })).rejects.toMatchObject({ code: '42601' });
      await client.query('ROLLBACK');
      const recovered = await client.query({ name: 'failed-parse', text: 'SELECT $1::integer AS value', values: [42] });
      expect(recovered.rows[0].value).toBe(42);
    } finally {
      client.release();
    }
    expect((await ordinary.query('SELECT 1 AS value')).rows[0].value).toBe(1);
  });
});
