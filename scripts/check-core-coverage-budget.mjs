#!/usr/bin/env node
// @ts-check
//
// check-core-coverage-budget.mjs (Phase 5b)
//
// Per-file coverage ratchet for the load-bearing files behind the Phase 4
// proof cards. Reads `coverage-core/coverage-summary.json` (produced by
// `npm run test:coverage:core`) and compares each tracked file's pct values
// against `.core-coverage-budget.json`. Mirrors the .strict-null-budget
// pattern: any change in either direction fails CI unless the budget is
// re-stamped in the same PR.
//
// Why a ratchet vs. a Jest threshold: per-file ratcheting forces every
// coverage-affecting PR to commit the new floor, so a single low-coverage
// file (e.g., HubSpotConnector.ts at 8.88% lines) can ratchet up
// independently of files that are already at 95%+.
//
// Usage:
//   node scripts/check-core-coverage-budget.mjs
//     # exits 0 only when current === budget
//   node scripts/check-core-coverage-budget.mjs --write
//     # writes current into .core-coverage-budget.json
//   node scripts/check-core-coverage-budget.mjs --summary coverage-core/coverage-summary.json
//     # reads coverage from a non-default summary file
//   node scripts/check-core-coverage-budget.mjs --budget .core-coverage-budget.json
//     # reads budget from a non-default budget file
//
// Failure modes:
//   - regressed:    current < budget → fix the test or restamp with --write
//   - improved:     current > budget → restamp with --write to lock in the gain
//   - file missing: file in budget but not in summary → coverage profile changed
//   - file extra:   file in summary but not in budget → add it to the budget
//
// Determinism: jest.core.config.cjs enumerates an explicit testMatch (19 unit
// test files) so the same Jest invocation runs locally and in CI. The seed
// .core-coverage-budget.json was stamped from that exact command, so no
// first-run restamp is required.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const budgetPath = path.join(repoRoot, '.core-coverage-budget.json');
const summaryPath = path.join(repoRoot, 'coverage-core', 'coverage-summary.json');

const METRICS = ['lines', 'statements', 'functions', 'branches'];

const args = parseArgs(process.argv.slice(2));
const summaryPathArg = args.values.summary || summaryPath;
const budgetPathArg = args.values.budget || budgetPath;

// Display paths: prefer repo-root-relative form so error messages are
// copy-paste-stable across local/CI/absolute-path invocations.
const budgetDisplay = displayPath(budgetPathArg, repoRoot);
const summaryDisplay = displayPath(summaryPathArg, repoRoot);

if (!fs.existsSync(budgetPathArg)) {
  console.error(`FAIL: missing ${budgetDisplay}`);
  process.exit(2);
}
if (!fs.existsSync(summaryPathArg)) {
  console.error(`FAIL: missing ${summaryDisplay} — run 'npm run test:coverage:core' first`);
  process.exit(2);
}

const budget = readJson(budgetPathArg);
const summary = readJson(summaryPathArg);

assertPlainObject(budget, budgetDisplay);
assertPlainObject(summary, summaryDisplay);

const summaryByRelPath = normalizeSummary(summary, repoRoot);
const budgetEntries = Object.entries(budget).filter(([k]) => !k.startsWith('_'));

for (const [relPath, budgetMetrics] of budgetEntries) {
  if (!isPlainObject(budgetMetrics)) {
    console.error(`FAIL: ${budgetDisplay} entry "${relPath}" must be an object with numeric lines/statements/functions/branches fields, got ${describeValue(budgetMetrics)}`);
    process.exit(2);
  }
  for (const metric of METRICS) {
    const v = budgetMetrics[metric];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      console.error(`FAIL: ${budgetDisplay} entry "${relPath}.${metric}" must be a finite number, got ${describeValue(v)}`);
      process.exit(2);
    }
  }
}

const failures = [];
const restamp = {};

for (const [relPath, budgetMetrics] of budgetEntries) {
  const current = summaryByRelPath.get(relPath);
  if (!current) {
    failures.push(`MISSING: ${relPath} is in budget but not in coverage summary (jest.core.config.cjs allowlist drift)`);
    continue;
  }
  const restampMetrics = {};
  for (const metric of METRICS) {
    const budgetVal = round2(budgetMetrics[metric]);
    const currentVal = round2(current[metric]);
    if (currentVal < budgetVal) {
      failures.push(`REGRESSED: ${relPath} ${metric} dropped from ${budgetVal}% to ${currentVal}%`);
    } else if (currentVal > budgetVal) {
      failures.push(`IMPROVED: ${relPath} ${metric} rose from ${budgetVal}% to ${currentVal}% — re-stamp ${budgetDisplay} with --write to lock in the gain`);
    }
    restampMetrics[metric] = currentVal;
  }
  restamp[relPath] = restampMetrics;
}

const budgetKeys = new Set(budgetEntries.map(([k]) => k));
for (const relPath of summaryByRelPath.keys()) {
  if (!budgetKeys.has(relPath)) {
    failures.push(`EXTRA: ${relPath} is measured but not in budget — add it to ${budgetDisplay}`);
    restamp[relPath] = pickPctValues(summaryByRelPath.get(relPath));
  }
}

if (args.flags.has('--write')) {
  const next = {};
  for (const [k, v] of Object.entries(budget)) {
    if (k.startsWith('_')) next[k] = v;
  }
  for (const relPath of [...Object.keys(restamp)].sort()) {
    next[relPath] = restamp[relPath];
  }
  fs.writeFileSync(budgetPathArg, JSON.stringify(next, null, 2) + '\n');
  console.log(`Wrote ${Object.keys(restamp).length} file entries to ${budgetDisplay}`);
  process.exit(0);
}

if (failures.length > 0) {
  console.error('Core coverage budget check FAILED:');
  for (const f of failures) console.error(`  ${f}`);
  console.error('\nTo accept the new numbers and lock them as the new floor:');
  console.error('  node scripts/check-core-coverage-budget.mjs --write');
  console.error(`  git add ${budgetDisplay}`);
  process.exit(1);
}

console.log(`Core coverage budget OK (${budgetEntries.length} files matched).`);
process.exit(0);

function usage() {
  return 'Usage: node scripts/check-core-coverage-budget.mjs [--write] [--summary <path>] [--budget <path>]';
}
function argError(message) {
  console.error(`FAIL: ${message}`);
  console.error(usage());
  process.exit(2);
}
function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') {
      flags.add('--write');
    } else if (a === '--summary' || a === '--budget') {
      const next = argv[i + 1];
      if (typeof next !== 'string' || next.length === 0 || next.startsWith('--')) {
        argError(`missing value for ${a}`);
      }
      values[a.slice(2)] = next;
      i++;
    } else {
      argError(`unknown argument: ${a}`);
    }
  }
  return { flags, values };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`FAIL: could not parse ${p} as JSON: ${e.message}`);
    process.exit(2);
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function assertPlainObject(v, displayName) {
  if (!isPlainObject(v)) {
    console.error(`FAIL: ${displayName} must contain a JSON object at the top level, got ${describeValue(v)}`);
    process.exit(2);
  }
}

function describeValue(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v;
}

function displayPath(p, root) {
  // Prefer a repo-root-relative POSIX form so failure-message paths are
  // stable copy-paste targets across local invocations, CI logs, and any
  // --budget/--summary overrides that pass absolute paths.
  if (!path.isAbsolute(p)) return p.split(path.sep).join('/');
  const rel = path.relative(root, p);
  // If the path is outside the repo (rel starts with '..'), keep it absolute
  // rather than emitting a confusing '../../tmp/foo.json' that won't paste back.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return p;
  return rel.split(path.sep).join('/');
}

function normalizeSummary(summary, root) {
  const out = new Map();
  for (const [k, v] of Object.entries(summary)) {
    if (k === 'total') continue;
    const rel = path.relative(root, k).split(path.sep).join('/');
    out.set(rel, v);
  }
  return out;
}

function pickPctValues(entry) {
  const out = {};
  for (const m of METRICS) out[m] = round2(entry[m]?.pct ?? 0);
  return out;
}

function round2(n) {
  // Coverage summary stores both `entry.lines.pct` (number) and the bare metric
  // value. We accept either: when reading budget JSON we pass the bare pct
  // number; when reading coverage-summary.json the value is the wrapper object.
  if (typeof n === 'object' && n !== null && 'pct' in n) {
    n = n.pct;
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}
