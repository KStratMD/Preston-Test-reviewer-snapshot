import { Pool } from 'pg';
import { importBundleIntoPostgres } from '../../../src/database/transfer/postgresTarget';
import { createTemporaryPostgresDatabase, createTransferFixture, transferManifest, type TemporaryPostgresDatabase, type TransferFixture } from './db-transfer-fixture';

describe('PostgreSQL transfer import', () => {
  let fixture: TransferFixture;
  let database: TemporaryPostgresDatabase;

  beforeAll(async () => {
    fixture = await createTransferFixture();
    database = await createTemporaryPostgresDatabase();
  }, 300000);

  afterAll(async () => {
    await database?.close();
    fixture?.cleanup();
  });

  it('imports the authenticated bundle into a fresh isolated database', async () => {
    const result = await importBundleIntoPostgres({
      bundlePath: fixture.bundlePath,
      key: fixture.key,
      connectionString: database.connectionString,
      manifest: transferManifest,
    });
    expect(result.rowCount).toBe(fixture.rowCount);

    const pool = new Pool({ connectionString: database.connectionString, max: 1 });
    try {
      const migrations = await pool.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM public.migrations');
      expect(Number(migrations.rows[0]?.count)).toBe(transferManifest.migrationNames.length);
      const tables = await pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'migrations'`);
      expect(Number(tables.rows[0]?.count)).toBe(transferManifest.tables.length);
      const apiKey = await pool.query<{ permissions: string[] }>('SELECT permissions FROM api_keys WHERE id = $1', ['550e8400-e29b-41d4-a716-446655440000']);
      expect(apiKey.rows[0]?.permissions).toEqual(['read', 'write']);
    } finally {
      await pool.end();
    }
  }, 300000);
});
