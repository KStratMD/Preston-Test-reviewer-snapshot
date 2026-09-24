import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { captureSqliteFrozen, captureSqliteOnline } from '../../../../src/database/transfer/capture';

describe('SQLite capture helpers', () => {
  it('captures online and under an IMMEDIATE freeze without changing source bytes', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-transfer-capture-'));
    const sourcePath = path.join(dir, 'source.sqlite'); const onlinePath = path.join(dir, 'online.sqlite'); const frozenPath = path.join(dir, 'frozen.sqlite');
    const db = new BetterSqlite3(sourcePath); db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO t(value) VALUES (\'x\');'); db.close();
    const before = fs.readFileSync(sourcePath).toString('hex');
    expect((await captureSqliteOnline(sourcePath, onlinePath)).mode).toBe('online');
    expect((await captureSqliteFrozen(sourcePath, frozenPath)).mode).toBe('frozen');
    expect(fs.readFileSync(sourcePath).toString('hex')).toBe(before);
    const frozen = new BetterSqlite3(frozenPath, { readonly: true });
    expect(frozen.prepare('SELECT COUNT(*) AS count FROM t').get()).toEqual({ count: 1 });
    frozen.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
