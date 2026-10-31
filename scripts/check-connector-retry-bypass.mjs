#!/usr/bin/env node
/** Scans top-level src/connectors/*.ts files only; nested directories are not
 * covered. House-pattern ratchet against connector-local retry loops, not a complete
 * semantic retry detector: new dispatch forms require independent review.
 * Exit 0: clean; 1: violation; 2: invalid arguments or unreadable/empty tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  const args = process.argv.slice(2);
  let root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (args.length) {
    if (args.length !== 2 || args[0] !== '--root' || !args[1] || args[1].startsWith('--')) {
      throw new Error('usage: check-connector-retry-bypass.mjs [--root <directory>]');
    }
    root = path.resolve(args[1]);
  }
  const directory = path.join(root, 'src', 'connectors');
  const files = fs.readdirSync(directory).filter(file => file.endsWith('.ts') && !file.endsWith('.test.ts')).sort();
  if (!files.length) throw new Error(`no connector TypeScript files in ${directory}`);
  const patterns = [/axios-retry/, /for\s*\(\s*let\s+attempt\b/, /while\s*\(\s*attempt\b/, /retryCount\s*\+\+/, /attempt\s*<\s*maxRetries/];
  const hits = [];
  for (const file of files) {
    const source = fs.readFileSync(path.join(directory, file), 'utf8');
    const pattern = patterns.find(pattern => pattern.test(source));
    if (pattern) hits.push(`src/connectors/${file}: ${pattern}`);
  }
  if (hits.length) {
    console.error(`[connector-retry-bypass] FAIL (${hits.length}):\n${hits.join('\n')}`);
    process.exitCode = 1;
  } else console.log(`[connector-retry-bypass] OK (${files.length} connector files)`);
} catch (error) {
  console.error(`[connector-retry-bypass] ERROR: ${error.message}`);
  process.exitCode = 2;
}
