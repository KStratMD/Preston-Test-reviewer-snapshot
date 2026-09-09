import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { MIGRATIONS } from '../../../../src/database/migrations';
import type { Database } from '../../../../src/database/types';
import manifest from '../../../../src/database/transfer/manifest.generated.json';
import { exportSqliteBundle } from '../../../../src/database/transfer/exporter';
import { decodeBundle } from '../../../../src/database/transfer/bundleCrypto';

describe('SQLite exporter', () => {
  it('preflights before writing an authenticated bundle', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-transfer-export-'));
    const sourcePath = path.join(dir, 'source.sqlite'); const outputPath = path.join(dir, 'capture.bundle');
    const raw = new BetterSqlite3(sourcePath); const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) });
    for (const migration of MIGRATIONS) await migration.run(db, 'sqlite');
    await db.destroy(); raw.close();
    const key = randomBytes(32);
    const result = exportSqliteBundle({ sourcePath, outputPath, key, manifest });
    expect(result.tableCount).toBe(54); expect(fs.existsSync(outputPath)).toBe(true);
    const frames = decodeBundle(fs.readFileSync(outputPath), key);
    expect(frames[0]?.type).toBe('bundle_header'); expect(frames.at(-1)?.type).toBe('bundle_end');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
