import { Pool } from 'pg';

/**
 * P5(a) smoke test: driver path.
 *
 * Opens a raw pg.Pool connection (no DatabaseService, no Kysely, no migrations)
 * and runs SELECT 1. Fails only when the driver/connection layer is broken —
 * independent of P5(b) migrations and P5(c) FOR UPDATE.
 *
 * This test is the canonical "can we even reach the database" check.
 * DatabaseService-level coverage is implicit in P5(b) which exercises the
 * full Kysely + MigrationRunner stack.
 */
describe('postgres connection smoke (P5a)', () => {
  let pool: Pool;

  beforeAll(async () => {
    // DATABASE_URL is guaranteed by setupEnvPostgres.ts.
    // connectionTimeoutMillis matches DatabaseService (src/database/DatabaseService.ts:201)
    // so an unreachable Postgres fails fast instead of hanging until Jest's 300s timeout.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('DATABASE_URL is set and DB_TYPE is postgres', () => {
    expect(process.env.DATABASE_URL).toBeTruthy();
    expect(process.env.DB_TYPE).toBe('postgres');
  });

  it('executes SELECT 1', async () => {
    const result = await pool.query('SELECT 1 AS one');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].one).toBe(1);
  });

  it('reports server_version as 15.x', async () => {
    const result = await pool.query('SHOW server_version');
    const ver: string = result.rows[0].server_version;
    expect(ver.startsWith('15.')).toBe(true);
  });
});
