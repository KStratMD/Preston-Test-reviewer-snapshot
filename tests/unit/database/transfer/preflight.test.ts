import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { MIGRATIONS } from '../../../../src/database/migrations';
import type { Database } from '../../../../src/database/types';
import manifest from '../../../../src/database/transfer/manifest.generated.json';
import { SqliteTransferSource } from '../../../../src/database/transfer/sqliteSource';
import { runSqlitePreflight } from '../../../../src/database/transfer/preflight';

describe('SQLite transfer preflight', () => {
  let filePath: string;
  beforeEach(async () => {
    filePath = path.join(os.tmpdir(), `db-transfer-preflight-${process.pid}-${Date.now()}.sqlite`);
    const raw = new BetterSqlite3(filePath);
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) });
    for (const migration of MIGRATIONS) await migration.run(db, 'sqlite');
    await db.destroy(); raw.close();
  });
  afterEach(() => { try { fs.rmSync(filePath, { force: true }); } catch { /* fixture cleanup */ } });

  it('passes an untouched migrated source without changing its bytes', () => {
    const source = new SqliteTransferSource({ filePath });
    const result = runSqlitePreflight(source, manifest);
    expect(result.ok).toBe(true);
    expect(result.evidence.status).toBe('passed');
    source.close();
  });

  it('reports schema drift as an aggregate safe finding', () => {
    const raw = new BetterSqlite3(filePath);
    raw.exec('PRAGMA writable_schema = ON;');
    // An unknown table is intentionally a hard stop. It is created before the
    // read-only source opens, so source bytes remain observable and unchanged by
    // the preflight itself.
    raw.exec('CREATE TABLE unexpected_transfer_table(id INTEGER PRIMARY KEY);');
    raw.close();
    const source = new SqliteTransferSource({ filePath });
    const result = runSqlitePreflight(source, manifest);
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'UNKNOWN_TABLE', table: 'unexpected_transfer_table' })]));
    expect(JSON.stringify(result)).not.toContain('source-value-sentinel');
    source.close();
  });

  it('reports a manifest-only table as a structured finding instead of throwing', () => {
    const source = new SqliteTransferSource({ filePath });
    const missingTable = {
      name: 'manifest_only_table',
      primaryKey: ['id'],
      sortColumns: ['id'],
      dependsOn: [],
      columns: [{
        name: 'id', sourceType: 'TEXT', targetType: 'TEXT', sourceNullable: false, targetNullable: false, kind: 'text' as const,
      }],
      sequenceColumns: [],
    };
    const result = runSqlitePreflight(source, { ...manifest, tables: [...manifest.tables, missingTable] });
    expect(result.ok).toBe(false);
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'MISSING_TABLE', table: 'manifest_only_table' })]));
    source.close();
  });
});
