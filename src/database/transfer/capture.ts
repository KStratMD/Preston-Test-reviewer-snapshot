import fs from 'node:fs';
import { createHash } from 'node:crypto';
import BetterSqlite3 from 'better-sqlite3';

export interface CaptureResult { readonly path: string; readonly sha256: string; readonly mode: 'online' | 'frozen'; }

function hashFile(filePath: string): string { return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); }

export async function captureSqliteOnline(sourcePath: string, destinationPath: string): Promise<CaptureResult> {
  const source = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try { await source.backup(destinationPath); }
  finally { source.close(); }
  return { path: destinationPath, sha256: hashFile(destinationPath), mode: 'online' };
}

export async function captureSqliteFrozen(sourcePath: string, destinationPath: string): Promise<CaptureResult> {
  const source = new BetterSqlite3(sourcePath, { fileMustExist: true });
  const snapshot = new BetterSqlite3(sourcePath, { readonly: true, fileMustExist: true });
  try {
    source.pragma('busy_timeout = 5000');
    source.exec('BEGIN IMMEDIATE');
    try { await snapshot.backup(destinationPath); source.exec('COMMIT'); }
    catch (error) { try { source.exec('ROLLBACK'); } catch { /* preserve original failure */ } throw error; }
  } finally { snapshot.close(); source.close(); }
  return { path: destinationPath, sha256: hashFile(destinationPath), mode: 'frozen' };
}
