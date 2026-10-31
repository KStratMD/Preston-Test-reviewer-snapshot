import { Pool } from 'pg';

/**
 * P5(c) smoke test: locking path.
 *
 * Verifies that Postgres SELECT ... FOR UPDATE NOWAIT semantics work as
 * documented: a row held under FOR UPDATE in transaction A causes a parallel
 * FOR UPDATE NOWAIT in transaction B to fail immediately with SQLSTATE 55P03
 * ("could not obtain lock"). After A commits, the row is free and B's retry
 * succeeds.
 *
 * Strategy: self-contained probe table created in beforeAll / dropped in
 * afterAll. No dependency on production schema invariants beyond migration
 * success (already covered by P5b). NOWAIT keeps the test deterministic;
 * no setTimeout / timing heuristics.
 *
 * Independent of P5(a) connection and P5(b) migrations — this test fails
 * only when row-level FOR UPDATE locking is broken in the deployed PG image.
 */
describe('postgres SELECT FOR UPDATE NOWAIT smoke (P5c)', () => {
  let pool: Pool;
  const probeTable = `probe_${Math.random().toString(36).slice(2, 10)}`;

  beforeAll(async () => {
    // DATABASE_URL is guaranteed by setupEnvPostgres.ts.
    // connectionTimeoutMillis matches DatabaseService (src/database/DatabaseService.ts:201)
    // so an unreachable Postgres fails fast instead of hanging until Jest's 300s timeout.
    pool = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 2000 });
    await pool.query(`CREATE TABLE ${probeTable} (id SERIAL PRIMARY KEY, v INT)`);
    await pool.query(`INSERT INTO ${probeTable} (v) VALUES (1)`);
  });

  afterAll(async () => {
    try {
      await pool.query(`DROP TABLE IF EXISTS ${probeTable}`);
    } finally {
      await pool.end();
    }
  });

  it('NOWAIT rejects when a sibling tx holds the row; succeeds after commit', async () => {
    let a: import('pg').PoolClient | null = null;
    let b: import('pg').PoolClient | null = null;
    try {
      a = await pool.connect();
      b = await pool.connect();

      await a.query('BEGIN');
      await a.query(`SELECT * FROM ${probeTable} WHERE id = 1 FOR UPDATE`);

      // Sibling tx attempts the same lock with NOWAIT — must fail immediately.
      let nowaitError: (Error & { code?: string }) | null = null;
      try {
        await b.query('BEGIN');
        await b.query(`SELECT * FROM ${probeTable} WHERE id = 1 FOR UPDATE NOWAIT`);
      } catch (e) {
        nowaitError = e as Error & { code?: string };
      } finally {
        await b.query('ROLLBACK').catch(() => {});
      }

      expect(nowaitError).not.toBeNull();
      // 55P03 = lock_not_available (the canonical SQLSTATE for NOWAIT rejection).
      expect(nowaitError?.code).toBe('55P03');

      // Free the lock and retry — must now succeed.
      await a.query('COMMIT');

      await b.query('BEGIN');
      const after = await b.query(`SELECT * FROM ${probeTable} WHERE id = 1 FOR UPDATE NOWAIT`);
      await b.query('COMMIT');
      expect(after.rows).toHaveLength(1);
      expect(after.rows[0].v).toBe(1);
    } finally {
      // Roll back any active transactions before releasing — pg does NOT auto-rollback on release.
      if (a) {
        await a.query('ROLLBACK').catch(() => {});
        a.release();
      }
      if (b) {
        await b.query('ROLLBACK').catch(() => {});
        b.release();
      }
    }
  });
});
