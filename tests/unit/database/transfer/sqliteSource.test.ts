import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { MIGRATIONS } from '../../../../src/database/migrations';
import type { Database } from '../../../../src/database/types';
import { SqliteTransferSource } from '../../../../src/database/transfer/sqliteSource';

describe('SqliteTransferSource', () => {
  let filePath: string;
  beforeEach(async () => {
    filePath = path.join(os.tmpdir(), `db-transfer-source-${process.pid}-${Date.now()}.sqlite`);
    const raw = new BetterSqlite3(filePath);
    const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: raw }) });
    for (const migration of MIGRATIONS) await migration.run(db, 'sqlite');
    await db.destroy(); raw.close();
  });
  afterEach(() => { try { fs.rmSync(filePath, { force: true }); } catch { /* fixture cleanup */ } });

  it('opens an existing source read-only and rejects writes', () => {
    const source = new SqliteTransferSource({ filePath });
    expect(source.db.pragma('query_only', { simple: true })).toBe(1);
    source.beginRead();
    expect(() => source.db.prepare('CREATE TABLE should_not_exist(id INTEGER)').run()).toThrow();
    source.endRead(); source.close();
  });
});
