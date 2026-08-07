import { sql } from 'kysely';
import { Logger } from '../../../src/utils/Logger';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { MIGRATIONS } from '../../../src/database/migrations';

function buildLogger(): Logger {
  return new Logger('postgres-migrations-smoke');
}

/**
 * P5(b) smoke test: schema path.
 *
 * Asserts all MIGRATIONS modules apply cleanly to a fresh Postgres database
 * and a spot-check column is present. DatabaseService.initialize() auto-runs
 * the migration runner; we read back the `migrations` log table to confirm
 * every module recorded a row.
 *
 * Independent of P5(a) connection and P5(c) FOR UPDATE — this test fails
 * only when a migration's SQL is incompatible with Postgres.
 */
describe('postgres migrations smoke (P5b)', () => {
  let db: DatabaseService;

  beforeAll(async () => {
    db = new DatabaseService(buildLogger());
    await db.initialize(); // runs MigrationRunner.runAll() internally
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('records one log row per MIGRATIONS module', async () => {
    const k = db.getDatabase();
    const result = await sql<{ count: string }>`SELECT COUNT(*)::text AS count FROM migrations`.execute(k);
    // Postgres COUNT returns bigint; cast to text in SQL to avoid JS BigInt vs number coercion.
    expect(Number(result.rows[0].count)).toBe(MIGRATIONS.length);
  });

  it('applied every named migration', async () => {
    const k = db.getDatabase();
    const result = await sql<{ name: string }>`SELECT name FROM migrations ORDER BY name`.execute(k);
    const recordedNames = result.rows.map((r) => r.name).sort();
    const expectedNames = MIGRATIONS.map((m) => m.name).sort();
    expect(recordedNames).toEqual(expectedNames);
  });

  it('produced workflow_central_tasks.tenant_id column (PR-OP-2, migration 041)', async () => {
    const k = db.getDatabase();
    const result = await sql<{ column_name: string }>`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'workflow_central_tasks'
        AND column_name = 'tenant_id'
    `.execute(k);
    expect(result.rows).toHaveLength(1);
  });
});
