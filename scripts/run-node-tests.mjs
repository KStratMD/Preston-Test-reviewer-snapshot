#!/usr/bin/env node
// Runs `node --test` over explicit test files and fails if any of them is missing.
// Plain `node --test present.mjs missing.mjs` silently skips the missing file and
// exits 0 on Node 22.22.2 and 22.23.1, so a deleted or renamed file would
// shrink a suite without failing it. Usage: node scripts/run-node-tests.mjs <file>...

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = process.argv.slice(2).map((file) => resolve(process.cwd(), file));

if (files.length === 0) {
  console.error('run-node-tests: no test files given');
  process.exit(1);
}

const missing = files.filter((file) => !existsSync(file));
if (missing.length > 0) {
  for (const file of missing) console.error(`run-node-tests: missing test file: ${file}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
if (result.error) {
  console.error(`run-node-tests: failed to run node --test: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
