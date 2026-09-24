import { Pool } from 'pg';
import { DatabaseService } from '../../../src/database/DatabaseService';
import { Logger } from '../../../src/utils/Logger';
import manifestJson from '../../../src/database/transfer/manifest.generated.json';
import { parseTransferManifest } from '../../../src/database/transfer/manifest';
import { assertPostgresMatchesManifest } from '../../../src/database/transfer/manifestAuthoring';
import { discoverPostgresSchema } from '../../../src/database/transfer/schemaDiscovery';

describe('PostgreSQL transfer manifest', () => {
  const manifest = parseTransferManifest(manifestJson);
  let db: DatabaseService;
  let pool: Pool;
  beforeAll(async () => {
    db = new DatabaseService(new Logger('db-transfer-manifest-postgres'));
    await db.initialize();
    pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  });
  afterAll(async () => { await pool.end(); await db.shutdown(); });

  it('matches the migrated public schema and exact migration hash', async () => {
    const schema = await discoverPostgresSchema(pool);
    expect(schema.tables).toHaveLength(54);
    assertPostgresMatchesManifest(schema, manifest);
    expect(manifest.migrationNames).toHaveLength(65);
  });

  it('keeps the two formerly-float4 transfer columns at binary64 width', async () => {
    const result = await pool.query<{ table_name: string; data_type: string }>(`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND ((table_name = 'ai_sessions' AND column_name = 'overall_confidence')
        OR (table_name = 'reasoning_traces' AND column_name = 'confidence'))
      ORDER BY table_name
    `);
    expect(result.rows).toEqual([
      { table_name: 'ai_sessions', data_type: 'double precision' },
      { table_name: 'reasoning_traces', data_type: 'double precision' },
    ]);
  });
});
