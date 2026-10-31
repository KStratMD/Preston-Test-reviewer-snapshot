#!/usr/bin/env node
/**
 * audit-otel-graph — fail-closed OpenTelemetry dependency-graph gate.
 *
 * npm's own validation (`npm ls --all --json`) is the authority for missing,
 * invalid, extraneous, and manifest-range violations: a nonzero exit or any
 * `problems` entry fails the gate immediately. On top of that, this script
 * enforces the one invariant npm does not: CARDINALITY AND UNIQUENESS of
 * resolved `@opentelemetry/*` versions.
 *
 *  - Every direct `@opentelemetry/*` dependency (dependencies +
 *    devDependencies in package.json) must resolve to exactly one version
 *    in the tree. Zero (missing) and more than one both fail.
 *  - Every transitive `@opentelemetry/*` package encountered must resolve
 *    to one unique version; multiple resolved versions fail.
 *
 * No hardcoded version literals (the lockfile pins them) and no second
 * semver-range checker (successful `npm ls` already enforces declared
 * ranges). Physical copy count is NOT the risk — same-version copies share
 * the registered global provider — so the gate deduplicates by resolved
 * version. Multiple resolved `@opentelemetry/api` versions introduce
 * compatibility-order ambiguity in the `globalThis` provider registration,
 * which is exactly what this gate exists to prevent.
 *
 * Usage:
 *   node scripts/check-otel-graph.mjs [--root <dir>] [--ls-json <file>] [--ls-exit <code>]
 *
 *   --root     directory whose package.json + npm tree are audited
 *              (default: repo root).
 *   --ls-json  read a captured `npm ls --all --json` document instead of
 *              running npm (testability seam for the regression harness,
 *              following the `--root` precedent in
 *              scripts/check-mirror-reproducibility.mjs).
 *   --ls-exit  simulate the `npm ls` subprocess exit code (seam; requires
 *              --ls-json so the seam can never masquerade as a real run).
 *              A nonzero code takes the same fail-immediately path as a
 *              real nonzero `npm ls`.
 *
 * The default no-flag invocation always runs the real `npm ls`.
 *
 * Exit codes: 0 = invariants hold; 1 = gate violation (nonzero npm ls,
 * problems, missing direct dep, duplicate versions); 2 = cannot run at all
 * (unreadable inputs, npm not launchable, signal-terminated npm) — fail
 * closed, never a silent skip.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OTEL_SCOPE = '@opentelemetry/';

function parseArgs(argv) {
  const args = { root: resolve(dirname(fileURLToPath(import.meta.url)), '..'), lsJson: null, lsExit: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--root' && argv[i + 1]) args.root = resolve(argv[++i]);
    else if (argv[i] === '--ls-json' && argv[i + 1]) args.lsJson = resolve(argv[++i]);
    else if (argv[i] === '--ls-exit' && argv[i + 1]) args.lsExit = Number(argv[++i]);
    else {
      console.error(`check-otel-graph: unknown argument '${argv[i]}'`);
      process.exit(2);
    }
  }
  if (args.lsExit !== null && (!Number.isInteger(args.lsExit) || args.lsJson === null)) {
    console.error('check-otel-graph: --ls-exit requires an integer code and --ls-json (test seam only)');
    process.exit(2);
  }
  return args;
}

function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    console.error(`check-otel-graph: cannot read ${label} at ${path}: ${err.message}`);
    process.exit(2);
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`check-otel-graph: cannot parse ${label} at ${path}: ${err.message}`);
    process.exit(2);
  }
}

function runNpmLs(root) {
  // shell: true so Windows resolves the extensionless npm shim (npm.cmd).
  const res = spawnSync('npm', ['ls', '--all', '--json'], {
    cwd: root,
    encoding: 'utf8',
    shell: true,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    console.error(`check-otel-graph: cannot launch npm: ${res.error.message}`);
    process.exit(2);
  }
  if (res.status === null) {
    // Signal-terminated subprocess: infrastructure failure, not a verdict
    // about the dependency tree — fail closed as cannot-run.
    console.error(`check-otel-graph: npm ls terminated by signal ${res.signal ?? 'unknown'}; cannot evaluate the tree.`);
    process.exit(2);
  }
  if (res.status !== 0) {
    // Do not parse a nonzero command's partial JSON as a healthy tree.
    console.error(`check-otel-graph: npm ls --all exited ${res.status}; the dependency tree is not healthy.`);
    const firstLines = `${res.stdout || ''}\n${res.stderr || ''}`.split('\n').filter(Boolean).slice(0, 12);
    for (const line of firstLines) console.error(`  ${line}`);
    process.exit(1);
  }
  try {
    return JSON.parse(res.stdout);
  } catch (err) {
    console.error(`check-otel-graph: cannot parse npm ls output: ${err.message}`);
    process.exit(2);
  }
}

function collectProblems(node, out, seen) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (Array.isArray(node.problems)) out.push(...node.problems);
  for (const child of Object.values(node.dependencies ?? {})) collectProblems(child, out, seen);
}

function collectOtelVersions(node, map, seen) {
  if (!node || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  for (const [name, child] of Object.entries(node.dependencies ?? {})) {
    if (!child || typeof child !== 'object') continue;
    if (name.startsWith(OTEL_SCOPE) && typeof child.version === 'string' && child.version.length > 0) {
      if (!map.has(name)) map.set(name, new Set());
      map.get(name).add(child.version);
    }
    collectOtelVersions(child, map, seen);
  }
}

const { root, lsJson, lsExit } = parseArgs(process.argv);

const pkg = readJson(join(root, 'package.json'), 'package.json');
const directOtelDeps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  .filter((name) => name.startsWith(OTEL_SCOPE))
  .sort();

if (lsExit !== null && lsExit !== 0) {
  // Seam-simulated nonzero subprocess: same fail-immediately contract as a
  // real nonzero `npm ls` — never parse the document as a healthy tree.
  console.error(`check-otel-graph: npm ls --all exited ${lsExit}; the dependency tree is not healthy.`);
  process.exit(1);
}
const tree = lsJson ? readJson(lsJson, 'ls JSON') : runNpmLs(root);

const problems = [];
collectProblems(tree, problems, new Set());
if (problems.length > 0) {
  console.error(`check-otel-graph: npm ls reports ${problems.length} problems:`);
  for (const p of problems.slice(0, 12)) console.error(`  ${p}`);
  process.exit(1);
}

const versions = new Map();
collectOtelVersions(tree, versions, new Set());

const failures = [];
for (const name of directOtelDeps) {
  const resolved = versions.get(name);
  if (!resolved || resolved.size === 0) {
    failures.push(`direct dependency ${name} has no resolved version in the tree`);
  }
}
for (const [name, resolved] of [...versions.entries()].sort(([a], [b]) => a.localeCompare(b))) {
  if (resolved.size > 1) {
    failures.push(`${name} has multiple resolved versions: ${[...resolved].sort().join(', ')}`);
  }
}

if (failures.length > 0) {
  console.error('check-otel-graph: FAIL');
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}

console.log(
  `check-otel-graph: OK — ${versions.size} @opentelemetry package(s), each with a single resolved version; ` +
  `${directOtelDeps.length} direct dep(s) present.`,
);
