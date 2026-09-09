import fs from 'node:fs';
import { Pool } from 'pg';
import { decodeBundle } from '../../../src/database/transfer/bundleCrypto';
import { importBundleIntoPostgres } from '../../../src/database/transfer/postgresTarget';
import { reconcilePostgres } from '../../../src/database/transfer/reconcile';
import { createTemporaryPostgresDatabase, createTransferFixture, transferManifest, type TemporaryPostgresDatabase, type TransferFixture } from './db-transfer-fixture';

describe('SQLite to PostgreSQL transfer round trip', () => {
  let fixture: TransferFixture;
  let database: TemporaryPostgresDatabase;

  beforeAll(async () => {
    fixture = await createTransferFixture();
    database = await createTemporaryPostgresDatabase();
    await importBundleIntoPostgres({
      bundlePath: fixture.bundlePath,
      key: fixture.key,
      connectionString: database.connectionString,
      manifest: transferManifest,
    });
  }, 300000);

  afterAll(async () => {
    await database?.close();
    fixture?.cleanup();
  });

  it('reconciles every imported row against the authenticated source frames', async () => {
    const frames = decodeBundle(fs.readFileSync(fixture.bundlePath), fixture.key);
    const pool = new Pool({ connectionString: database.connectionString, max: 1 });
    try {
      await expect(reconcilePostgres(pool, frames, transferManifest, { verifyMetadata: true })).resolves.toEqual({ ok: true, mismatches: [] });
    } finally {
      await pool.end();
    }
  }, 300000);
});
