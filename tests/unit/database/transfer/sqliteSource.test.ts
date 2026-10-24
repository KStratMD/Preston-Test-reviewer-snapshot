import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import { MIGRATIONS } from '../../../../src/database/migrations';
import type { Database } from '../../../../src/database/types';
import { SqliteTransferSource } from '../../../../src/database/transfer/sqliteSource';
import { canonicalize } from '../../../../src/database/transfer/canonicalize';

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

  it('preserves exact int64 values and existing safe-number and scalar representations', () => {
    const writer = new BetterSqlite3(filePath);
    const integers = [9007199254740993n, -9007199254740993n, -9223372036854775808n,
      9223372036854775807n, -9007199254740991n, 9007199254740991n, 0n, 1n];
    try {
      writer.exec('CREATE TABLE precision_fixture (id INTEGER PRIMARY KEY, value INTEGER, real_value REAL, text_value TEXT, null_value TEXT, blob_value BLOB)');
      const insert = writer.prepare('INSERT INTO precision_fixture VALUES (?, ?, ?, ?, ?, ?)');
      integers.forEach((value, index) => insert.run(index, value, 1.25, 'unchanged', null, Buffer.from([0, 255])));
    } finally { writer.close(); }
    const source = new SqliteTransferSource({ filePath });
    try {
      expect(() => source.rows('precision_fixture', ['value'], ['id'])).toThrow(/read transaction/);
      source.beginRead();
      const rows = source.rows('precision_fixture', ['value', 'real_value', 'text_value', 'null_value', 'blob_value'], ['id']);
      expect(rows.map((row) => row.value)).toEqual([
        9007199254740993n, -9007199254740993n, -9223372036854775808n, 9223372036854775807n,
        -9007199254740991, 9007199254740991, 0, 1,
      ]);
      for (const row of rows) {
        expect(row.real_value).toBe(1.25);
        expect(row.text_value).toBe('unchanged');
        expect(row.null_value).toBeNull();
        expect(row.blob_value).toEqual(Buffer.from([0, 255]));
      }
      for (const [index, expected] of [[6, false], [7, true]] as const) {
        expect(typeof rows[index].value).toBe('number');
        expect(canonicalize(rows[index].value, 'boolean')).toEqual({ type: 'boolean', value: expected });
      }
      expect(source.count('precision_fixture')).toBe(8);
      expect(source.db.pragma('query_only', { simple: true })).toBe(1);
      expect(source.integrityCheck()).toEqual(['ok']);
    } finally { source.close(); }
  });
});
