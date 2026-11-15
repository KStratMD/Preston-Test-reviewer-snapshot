import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import BetterSqlite3 from 'better-sqlite3';

function waitForReady(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`capture helper did not become ready: ${output}`)), 10000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.split(/\r?\n/).find((candidate) => candidate.startsWith('CAPTURE_READY '));
      if (line) { clearTimeout(timer); resolve(line); }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

function waitForExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
}

describe('sqlite freeze capture helper', () => {
  it('verifies the captured destination and exits nonzero when interrupted', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-freeze-capture-'));
    const sourcePath = path.join(directory, 'source.sqlite');
    const destinationPath = path.join(directory, 'snapshot.sqlite');
    const source = new BetterSqlite3(sourcePath);
    source.exec("CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records(value) VALUES ('preserved');");
    source.close();

    const child = spawn(process.execPath, [path.resolve(__dirname, '../../../scripts/railway/sqlite-freeze-capture.cjs')], {
      env: { ...process.env, SQLITE_SOURCE_PATH: sourcePath, SQLITE_DESTINATION_PATH: destinationPath, SQLITE_HEARTBEAT_MS: '100' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      const ready = await waitForReady(child);
      expect(ready.split(' ')).toHaveLength(3);
      const captured = new BetterSqlite3(destinationPath, { readonly: true });
      expect(captured.prepare('PRAGMA integrity_check').pluck().get()).toBe('ok');
      expect(captured.prepare('SELECT value FROM records WHERE id = 1').pluck().get()).toBe('preserved');
      captured.close();
      child.kill('SIGTERM');
      const result = await waitForExit(child);
      expect(result.code === null ? result.signal : result.code).not.toBe(0);
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGTERM');
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }, 30000);
});
