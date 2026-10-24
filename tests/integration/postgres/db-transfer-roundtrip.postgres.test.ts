import fs from 'node:fs';
import { Pool } from 'pg';
import { decodeBundle } from '../../../src/database/transfer/bundleCrypto';
import { importBundleIntoPostgres } from '../../../src/database/transfer/postgresTarget';
import { reconcilePostgres } from '../../../src/database/transfer/reconcile';
import type { BundleFrame } from '../../../src/database/transfer/types';
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
      // Independent decimal literals: never derive the oracle from the source,
      // fixture bindings, bundle or destination, which could all agree on rounding.
      for (const [tenantId, expected] of [
        ['precision-positive', '9007199254740993'], ['precision-negative', '-9007199254740993'],
        ['precision-min', '-9223372036854775808'], ['precision-max', '9223372036854775807'],
        ['precision-safe', '9007199254740991'],
      ] as const) {
        const matching = frames.filter((frame): frame is Extract<BundleFrame, { type: 'row' }> =>
          frame.type === 'row' && frame.table === 'sync_error_assist_runs'
          && frame.values.tenant_id.type === 'text' && frame.values.tenant_id.value === tenantId);
        expect(matching).toHaveLength(1);
        expect(matching[0].values.last_modified_at).toEqual({ type: 'integer', value: expected });
        const result = await pool.query<{ last_modified_at: unknown }>(
          'SELECT last_modified_at FROM sync_error_assist_runs WHERE tenant_id = $1', [tenantId],
        );
        expect(result.rows).toHaveLength(1);
        expect(typeof result.rows[0].last_modified_at).toBe('string');
        expect(result.rows[0].last_modified_at).toBe(expected);
      }
      await expect(reconcilePostgres(pool, frames, transferManifest, { verifyMetadata: true })).resolves.toEqual({ ok: true, mismatches: [] });
    } finally {
      await pool.end();
    }
  }, 300000);
});
