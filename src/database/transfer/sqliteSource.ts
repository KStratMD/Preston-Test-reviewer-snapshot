import fs from 'node:fs';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

export interface SqliteSourceOptions { readonly filePath: string; }

function quote(identifier: string): string { return `"${identifier.replace(/"/g, '""')}"`; }

export class SqliteTransferSource {
  readonly filePath: string;
  readonly db: BetterSqlite3.Database;
  private inReadTransaction = false;

  constructor(options: SqliteSourceOptions) {
    if (!fs.existsSync(options.filePath)) throw new Error('SQLite source file does not exist');
    this.filePath = options.filePath;
    this.db = new BetterSqlite3(options.filePath, { readonly: true, fileMustExist: true });
    this.db.pragma('query_only = ON');
    this.db.pragma('foreign_keys = ON');
  }

  beginRead(): void {
    if (this.inReadTransaction) throw new Error('SQLite read transaction already open');
    this.db.prepare('BEGIN').run();
    this.inReadTransaction = true;
  }

  endRead(): void {
    if (!this.inReadTransaction) return;
    this.db.prepare('ROLLBACK').run();
    this.inReadTransaction = false;
  }

  integrityCheck(): string[] {
    return (this.db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[]).map((row) => row.integrity_check);
  }

  foreignKeyCheck(): readonly Record<string, unknown>[] {
    return this.db.prepare('PRAGMA foreign_key_check').all() as readonly Record<string, unknown>[];
  }

  rows(table: string, columns: readonly string[], sortColumns: readonly string[]): readonly Record<string, unknown>[] {
    if (!this.inReadTransaction) throw new Error('SQLite source read transaction is required');
    const select = columns.map(quote).join(', ');
    const order = sortColumns.map(quote).join(', ');
    return this.db.prepare(`SELECT ${select} FROM ${quote(table)} ORDER BY ${order}`).all() as readonly Record<string, unknown>[];
  }

  count(table: string): number {
    return (this.db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table)}`).get() as { count: number }).count;
  }

  sha256(): string {
    const hash = createHash('sha256');
    for (const suffix of ['', '-wal', '-shm']) {
      const candidate = `${this.filePath}${suffix}`;
      hash.update(Buffer.from(suffix, 'utf8')); hash.update(Buffer.from([0]));
      if (fs.existsSync(candidate)) hash.update(fs.readFileSync(candidate));
    }
    return hash.digest('hex');
  }

  close(): void {
    this.endRead();
    this.db.close();
  }
}
