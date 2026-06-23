#!/usr/bin/env node
// @ts-check
//
// build-portfolio-evidence-manifest.mjs (PR 22 / Phase 4 — SuiteCentral
// Portfolio Evidence View)
//
// Parses every Squire product card under
// `docs/review/squire-product-cards/<slug>.md` and writes a deterministic
// JSON manifest at `public/portfolio-evidence.json`. The static surface
// `public/squire-portfolio-evidence.html` consumes that JSON at render time
// so the page has no runtime data dependencies (acceptance criterion #1:
// offline-clean).
//
// Companion: scripts/audit-portfolio-evidence.mjs re-runs this builder and
// compares against the committed JSON to fail CI on drift.
//
// Usage:
//   node scripts/build-portfolio-evidence-manifest.mjs           # write manifest
//   node scripts/build-portfolio-evidence-manifest.mjs --root <dir>   # for tests

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest, MANIFEST_PATH } from './lib/portfolio-evidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { root: REPO_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--help':
        console.log(
          'Usage: node scripts/build-portfolio-evidence-manifest.mjs [--root <dir>]',
        );
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function main() {
  const { root } = parseArgs(process.argv.slice(2));
  const manifest = buildManifest(root);
  const outPath = path.join(root, MANIFEST_PATH);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  // Trailing newline matches the repo's prevailing JSON style. The audit
  // is a deep-value (JSON.parse-then-per-field) compare, not byte-for-
  // byte — see scripts/audit-portfolio-evidence.mjs header — so the
  // newline is style consistency, not load-bearing for the gate.
  fs.writeFileSync(outPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  console.log(
    `build-portfolio-evidence-manifest: wrote ${manifest.cardCount} cards to ${MANIFEST_PATH}`,
  );
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
