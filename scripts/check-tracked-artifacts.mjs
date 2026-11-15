#!/usr/bin/env node
// @ts-check
//
// check-tracked-artifacts.mjs
//
// Two independent guards against hygiene drift:
//
// 1. FORBIDDEN list — fails CI if any file from the known-local artifact
//    list is tracked in git. Complements .gitignore: if someone adds a file
//    BEFORE the gitignore rule is in place, or uses `git add -f`, gitignore
//    alone won't stop it. This script does.
//
// 2. .ts/.js filename collisions — fails CI if a tracked `.ts` file has a
//    tracked `.js` sibling at the same path. Any `tsc` invocation that emits
//    (direct `tsc`, `npm run build`, an IDE's TSServer background compile,
//    or `ts-node --emit`) will write the .ts-compiled output over the .js
//    peer, changing its behavior per-build. (Default `ts-node` executes in
//    memory and does NOT emit files — only `ts-node --emit` or similar
//    opt-in emit modes cause the overwrite.) This is a latent trap we hit
//    during Phase 4 local verification (details in the PR that added this
//    check).
//
// Lowering either list (removing an entry from FORBIDDEN, adding a stem
// to COLLISION_ALLOWLIST with a justification comment) is allowed when a
// case becomes legitimate. Both require reviewer sign-off.

import { execFileSync } from 'node:child_process';

const FORBIDDEN = [
  '.grafana_cookies.txt',
  '.server.pid',
  '.eslint-report.json',
  'eslint-report.json',
  'progress.txt',
  'ralph-coverage-log.txt',
  'demo-start.json',
  // Database-transfer captures are deliberately local-only. Keep these
  // directory prefixes here as a tracked-file guard in addition to .gitignore.
  '.local/db-transfer/',
  'db-transfer-artifacts/',
];

// Path stems (without extension) where a .ts/.js pair is intentional and
// the .js is NOT an auto-generated compile output. Empty today — every new
// entry needs a justification comment next to it. `src/public/docs-search.js`
// does NOT belong here because there is no TS twin at that location
// (hand-written JS without a TS twin is fine; the guard only fires when
// BOTH extensions are tracked at the same path).
/** @type {Set<string>} */
const COLLISION_ALLOWLIST = new Set([
  // e.g. 'path/to/intentional-pair' — none today
]);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const trackedSet = new Set(tracked);

// --- Guard 1: FORBIDDEN list ------------------------------------------------
const forbiddenViolations = FORBIDDEN.filter((path) => {
  if (path.endsWith('/')) return tracked.some((file) => file.startsWith(path));
  return trackedSet.has(path);
});

if (forbiddenViolations.length > 0) {
  console.error('[tracked-artifacts] FAIL: local/runtime artifacts are tracked:');
  for (const path of forbiddenViolations) console.error(`  - ${path}`);
  console.error('');
  console.error('[tracked-artifacts] Fix: `git rm --cached <path>` and rotate any leaked');
  console.error('[tracked-artifacts] secrets/sessions (history retention means gitignore alone is not enough).');
  process.exit(1);
}

// --- Guard 2: .ts/.js filename collisions -----------------------------------
const tsStems = new Set();
const jsStems = new Set();
for (const path of tracked) {
  if (path.endsWith('.d.ts')) continue;           // declarations don't emit .js
  if (path.endsWith('.ts')) tsStems.add(path.slice(0, -'.ts'.length));
  else if (path.endsWith('.js')) jsStems.add(path.slice(0, -'.js'.length));
}

const collisions = [];
for (const stem of tsStems) {
  if (jsStems.has(stem) && !COLLISION_ALLOWLIST.has(stem)) {
    collisions.push(stem);
  }
}

if (collisions.length > 0) {
  console.error('[tracked-artifacts] FAIL: .ts/.js filename collisions detected:');
  for (const stem of collisions) console.error(`  - ${stem}.ts  AND  ${stem}.js  (both tracked)`);
  console.error('');
  console.error('[tracked-artifacts] Any emitting TypeScript compile (direct `tsc`, `npm run');
  console.error('[tracked-artifacts] build`, IDE TSServer background compile, or `ts-node --emit`)');
  console.error('[tracked-artifacts] overwrites the .js with the .ts-compiled output, so the');
  console.error('[tracked-artifacts] tracked .js changes behavior per-build. Fix options:');
  console.error('[tracked-artifacts]   (a) `git rm` one of the pair — usually the .js, unless');
  console.error('[tracked-artifacts]       the .js is hand-written and the .ts is stale');
  console.error('[tracked-artifacts]   (b) rename one of them so the stems differ');
  console.error('[tracked-artifacts]   (c) if the collision is genuinely intentional, add the');
  console.error('[tracked-artifacts]       stem to COLLISION_ALLOWLIST in this script with a');
  console.error('[tracked-artifacts]       one-line justification comment.');
  process.exit(1);
}

console.log(
  `[tracked-artifacts] OK: ${FORBIDDEN.length} forbidden artifacts clear, ` +
    `0 .ts/.js collisions across ${tsStems.size} .ts + ${jsStems.size} .js tracked files.`,
);
