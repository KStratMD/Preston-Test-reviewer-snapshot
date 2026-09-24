#!/usr/bin/env node
// Compare committed rung-2 fixtures with a fresh deterministic generation. No Git
// index is needed, so the same gate works in the exported reviewer snapshot.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const files = ['orders.json', 'erp-documents.json', 'payouts.json', 'expected-detections.json'];
function check() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--root' || !args[1] || args[1].startsWith('--'))) {
    throw new Error('usage: check-order-to-cash-fixtures.mjs [--root <repository directory>]');
  }
  const root = path.resolve(args[1] ?? process.cwd());
  let validRoot = false;
  try { validRoot = fs.statSync(root).isDirectory(); } catch { /* Report all invalid roots consistently. */ }
  if (!validRoot) throw new Error(`invalid root: ${root}`);
  const committed = path.join(root, 'tests', 'fixtures', 'order-to-cash');
  if (!fs.existsSync(committed) || !fs.lstatSync(committed).isDirectory()) {
    console.error('fixture freshness: missing dataset directory');
    return 1;
  }
  const names = fs.readdirSync(committed).sort();
  if (JSON.stringify(names) !== JSON.stringify([...files].sort())) {
    console.error('fixture freshness: missing or unexpected output; expected only the four generated JSON files');
    return 1;
  }
  for (const name of files) {
    if (!fs.lstatSync(path.join(committed, name)).isFile()) {
      console.error(`fixture freshness: ${name} must be a regular file`);
      return 1;
    }
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'o2c-freshness-'));
  try {
    const generator = fileURLToPath(new URL('./fixtures/generate-order-to-cash.mjs', import.meta.url));
    execFileSync(process.execPath, [generator, '--seed', '42', '--orders', '200', '--out', scratch], { stdio: 'pipe' });
    for (const name of files) {
      if (!fs.readFileSync(path.join(committed, name)).equals(fs.readFileSync(path.join(scratch, name)))) {
        console.error(`fixture freshness: stale ${name}; run npm run fixtures:order-to-cash`);
        return 1;
      }
    }
    console.log('fixture freshness: OK (four files, seed 42, 200 orders)');
    return 0;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}
try { process.exitCode = check(); }
catch (error) { console.error(`fixture freshness: ${error.message}`); process.exitCode = 2; }
