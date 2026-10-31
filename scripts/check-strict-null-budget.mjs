#!/usr/bin/env node
// @ts-check
//
// check-strict-null-budget.mjs
//
// Counts strictNullChecks errors from `tsc -p tsconfig.strict-preview.json`
// and fails CI unless the count exactly matches .strict-null-budget.
//
// Why a ratchet: turning strictNullChecks on in the main tsconfig.json
// today breaks thousands of call sites. The ratchet ships the gate
// today and drives the count down per-PR, mirroring the pattern
// .any-budget uses for `as any`.
//
// Usage:
//   node scripts/check-strict-null-budget.mjs           # exits 0 only when current === budget
//   node scripts/check-strict-null-budget.mjs --write   # writes current count into .strict-null-budget
//
// If current > budget, fail until the new null errors are fixed or the
// budget is explicitly raised with reviewer sign-off. If current < budget,
// fail until .strict-null-budget is re-stamped in the same PR so the lower
// count becomes the new enforced cap.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const budgetPath = path.join(repoRoot, '.strict-null-budget');
const previewConfig = path.join(repoRoot, 'tsconfig.strict-preview.json');

if (!fs.existsSync(budgetPath)) {
  console.error(`FAIL: missing ${budgetPath}`);
  process.exit(2);
}
if (!fs.existsSync(previewConfig)) {
  console.error(`FAIL: missing ${previewConfig}`);
  process.exit(2);
}

const budgetText = fs.readFileSync(budgetPath, 'utf8').trim();
// Strict digit-only check after trimming surrounding whitespace. parseInt is
// permissive — "67abc", "67 (was 68)", "67.5" would all parse to 67 silently
// — so the Number.isFinite fallback below would not catch a hand-edit that
// sneaks trailing garbage past the ratchet. Require the trimmed file contents
// to contain only ASCII digits.
if (!/^\d+$/.test(budgetText)) {
  console.error(`FAIL: ${budgetPath} must contain only ASCII digits after trimming surrounding whitespace (no comments, decimals, or signs), got "${budgetText}"`);
  process.exit(2);
}
const budget = parseInt(budgetText, 10);
if (!Number.isFinite(budget) || budget < 0) {
  console.error(`FAIL: ${budgetPath} must contain a non-negative integer, got "${budgetText}"`);
  process.exit(2);
}

// Invoke the repo's pinned TypeScript compiler directly through the current
// Node binary (C11): `spawnSync('npx', ...)` is ENOENT on Windows dev boxes
// (npx is npx.cmd there, and Node ≥18.20/20.12/22 refuses to spawn .cmd
// without a shell — EINVAL), so the gate could never run locally on win32.
// process.execPath + the resolved tsc entry point is fully cross-platform,
// avoids npx's resolution entirely, and guarantees the LOCKED typescript
// version runs (npx could fetch a different one on a box without the dep).
//
// spawnSync with an argv array (NOT a shell string) so paths containing
// spaces are passed verbatim. `--pretty false` strips ANSI colour / terminal
// width wrapping so the `error TS<N>:` regex below is stable regardless of
// whether stdout is a TTY.
const tscEntry = path.join(repoRoot, 'node_modules', 'typescript', 'bin', 'tsc');
if (!fs.existsSync(tscEntry)) {
  console.error(`FAIL: TypeScript compiler not found at ${tscEntry} — run npm ci first`);
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  [tscEntry, '-p', previewConfig, '--pretty', 'false'],
  { cwd: repoRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);

// Fail-CLOSED on execution failures. tsc is EXPECTED to exit non-zero when
// there are diagnostics (that is the normal success path for this script),
// but a spawn failure (ENOENT, PATH misconfiguration), signal termination,
// or a non-zero exit with no diagnostic lines all indicate the gate did
// not actually run. Treating those as "0 errors" would silently pass a
// PR that bypassed the check.
if (result.error) {
  console.error(`FAIL: could not execute tsc — ${result.error.message}`);
  process.exit(2);
}
if (result.status === null) {
  console.error(`FAIL: tsc terminated by signal ${result.signal ?? 'unknown'} before producing output`);
  process.exit(2);
}

const output = (result.stdout || '') + (result.stderr || '');
const errorLines = output.split('\n').filter((line) => /error TS\d+:/.test(line));
const current = errorLines.length;

// tsc exits 0 when there are no errors (future Stage-2 end state) and
// non-zero when there are any errors. If it exited non-zero but we parsed
// zero `error TS<N>:` lines, something non-diagnostic went wrong
// (tsconfig parse error, unknown CLI flag, missing include, etc.).
// Hard-fail so we don't write/compare a count of 0 that didn't come from
// a real strict-null compile.
if (result.status !== 0 && current === 0) {
  console.error(`FAIL: tsc exited ${result.status} with no 'error TS<N>:' lines — likely a non-diagnostic failure (config parse error, bad flag, missing include), not a real strict-null run.`);
  if (output.trim()) {
    console.error('--- tsc output (first 2000 chars) ---');
    console.error(output.slice(0, 2000));
  }
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.includes('--write')) {
  fs.writeFileSync(budgetPath, `${current}\n`);
  console.log(`Wrote ${current} to ${budgetPath}`);
  process.exit(0);
}

console.log(`strictNullChecks errors: current=${current} budget=${budget}`);

if (current > budget) {
  console.error(`FAIL: strictNullChecks error count rose from ${budget} to ${current}.`);
  console.error(`Either fix the new null errors or raise .strict-null-budget to ${current}`);
  console.error(`with reviewer sign-off and a PR-body justification explaining why the escape hatch was necessary.`);
  process.exit(1);
}
if (current < budget) {
  console.error(`FAIL: strictNullChecks errors dropped from ${budget} to ${current}. Re-stamp the budget in this PR:`);
  console.error(`  node scripts/check-strict-null-budget.mjs --write`);
  console.error(`and commit the updated .strict-null-budget in this PR.`);
  process.exit(1);
}
