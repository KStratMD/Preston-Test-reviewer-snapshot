#!/usr/bin/env node
// @ts-check

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    metrics: 'metrics.json',
    skipRegenerate: false,
    includeTestCoverage: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--metrics':
        options.metrics = argv[++i];
        break;
      case '--skip-regenerate':
        options.skipRegenerate = true;
        break;
      // CI-strict mode: keep tests.*/coverage.* IN the drift comparison
      // (still excluding generated_at, git_sha, loc.total_*). Only valid
      // AFTER the suite has produced test-summary.json + coverage-summary.json
      // (e.g. ci-minimal.yml right after test:coverage:ci); the reviewer-mirror
      // path runs verify-metrics WITHOUT this flag because it doesn't run the
      // suite. Closes the "committed metrics undercount" gap a reviewer reads.
      case '--include-test-coverage':
        options.includeTestCoverage = true;
        break;
      case '--help':
        console.log('Usage: node scripts/verify-metrics.mjs [--root <dir>] [--metrics metrics.json] [--skip-regenerate] [--include-test-coverage]');
        process.exit(0);
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function rel(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join('/');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function requireNumber(value, key) {
  assert(typeof value === 'number' && Number.isFinite(value), `${key} must be a finite number`);
}

function normalizeMetricsForComparison(metrics) {
  const normalized = structuredClone(metrics);
  delete normalized.generated_at;
  delete normalized.git_sha;
  // loc.total_* and total_files drift environmentally — cloc walks the
  // whole repo and picks up env-specific files (CI's `npm ci` writes
  // .node-modules-runtime.json marker; cloc 1.98 occasionally classifies
  // edge-case files differently across hosts). loc.production_ts is
  // *deterministic* — it filters src/**/*.ts against the static Jest
  // collectCoverageFrom pattern set and counts non-blank lines, which
  // produces the same value on any environment with the same git tree.
  // So we keep production_ts in the strict check (catches stale values
  // after src/ edits) and drop only the cloc-derived totals.
  if (normalized.loc && typeof normalized.loc === 'object') {
    delete normalized.loc.total_files;
    for (const key of Object.keys(normalized.loc)) {
      if (key.startsWith('total_')) {
        delete normalized.loc[key];
      }
    }
  }
  // tests.* counts are environmental: they only populate when
  // test-summary.json exists (jest --json --outputFile). reviewer-mirror.yml
  // runs verify-metrics without running the suite, so its regen produces
  // a {status: "missing"} sentinel. Committed metrics.json carries
  // populated counts from the PR-author's local run (or CI, when the
  // suite ran before metrics:generate). Excluding the entire tests block
  // mirrors the loc.total_* treatment — the README badge sourcing from
  // metrics.json:tests.passing is informational, not a CI gate, so
  // bounded staleness is acceptable. The audit-status-claims gate still
  // catches drift in deterministic blocks (connectors, dlp_patterns).
  // tests.* is ALWAYS excluded from the exact deep-equal because the suite is
  // environment-sensitive (CI skips env-gated tests a dev box runs, so an exact
  // cross-environment match is impossible). --include-test-coverage instead
  // applies a separate TOLERANCE check (see checkTestCoverageTolerance) that
  // catches gross undercounting without failing on env jitter.
  delete normalized.tests;
  // coverage.* is also environmental for the same reason as tests.* —
  // populated when coverage/coverage-summary.json exists, missing-sentinel
  // otherwise. Now that coverage.* is excluded from drift comparison
  // (this deletion), committed metrics.json:coverage can be either the
  // missing-sentinel (reviewer-mirror.yml regen path) or populated values
  // (PR-author local regen path) — both states coexist without false-
  // failing verify-metrics. The .core-coverage-budget.json ratchet is the
  // source-of-truth per-file coverage gate; metrics.json:coverage is
  // informational/environmental data only — not consumed by the README
  // badges (which source from .core-coverage-budget.json and metrics.json:
  // tests.*) or by any CI gate.
  // coverage.* is ALWAYS excluded from the exact deep-equal for the same
  // environment-sensitivity reason as tests.*; --include-test-coverage applies
  // the tolerance check instead.
  delete normalized.coverage;
  return normalized;
}

// Tolerance comparison for the environment-sensitive tests/coverage blocks
// (used only in --include-test-coverage mode). An EXACT cross-environment match
// is impossible — CI skips env-gated tests a dev box runs, shifting both the
// test count and coverage by a small amount. So we fail only when committed
// metrics drift from the freshly-regenerated (live, this-environment) values by
// MORE than a tolerance, which catches gross undercounting (the "committed lags
// reality" concern) without false-failing on env jitter. Returns a list of
// human-readable issues (empty = within tolerance).
const TESTS_REL_TOL = 0.015; // 1.5% of the live count (env jitter observed ~0.09%; gross staleness ~2.3%)
const TESTS_ABS_FLOOR = 25; // never tighter than 25 tests, for small suites
const COVERAGE_ABS_TOL = 0.75; // percentage points (env jitter ~0.17pt; gross staleness ~1pt)

function checkTestCoverageTolerance(committed, regenerated) {
  const issues = [];
  const ct = committed?.tests;
  const rt = regenerated?.tests;
  // FAIL-CLOSED: if the freshly-regenerated (live) tests block is missing or
  // unpopulated — a {status:"missing"} sentinel or non-numeric values even
  // though main() confirmed the input files exist (e.g. malformed/empty
  // test-summary.json) — we must NOT silently skip and report success. The
  // gate's purpose is to enforce freshness; a missing live block means we
  // can't, so it's a hard issue (Copilot review on PR #877).
  if (!rt || typeof rt.passing !== 'number') {
    issues.push('live (regenerated) tests block is missing/unpopulated — cannot verify freshness. Ensure test-summary.json is valid JSON with numPassedTests (fail-closed).');
  } else if (!ct || typeof ct.passing !== 'number') {
    issues.push('tests block missing/unpopulated in committed metrics.json (run metrics:generate after the suite).');
  } else {
    for (const k of ['passing', 'total']) {
      const c = ct[k];
      const r = rt[k];
      if (typeof c === 'number' && typeof r === 'number') {
        const tol = Math.max(Math.ceil(r * TESTS_REL_TOL), TESTS_ABS_FLOOR);
        if (Math.abs(c - r) > tol) {
          issues.push(`tests.${k}: committed ${c} vs live ${r} (drift ${Math.abs(c - r)} > tolerance ${tol}).`);
        }
      }
    }
  }
  const cc = committed?.coverage;
  const rc = regenerated?.coverage;
  // FAIL-CLOSED for coverage, same rationale as tests above.
  if (!rc || typeof rc.lines !== 'number') {
    issues.push('live (regenerated) coverage block is missing/unpopulated — cannot verify freshness. Ensure coverage/coverage-summary.json is valid (fail-closed).');
  } else if (!cc || typeof cc.lines !== 'number') {
    issues.push('coverage block missing/unpopulated in committed metrics.json (run metrics:generate after the suite).');
  } else {
    for (const k of ['lines', 'branches', 'functions', 'statements']) {
      const c = cc[k];
      const r = rc[k];
      if (typeof c === 'number' && typeof r === 'number' && Math.abs(c - r) > COVERAGE_ABS_TOL) {
        issues.push(`coverage.${k}: committed ${c}% vs live ${r}% (drift ${Math.abs(c - r).toFixed(2)}pt > tolerance ${COVERAGE_ABS_TOL}pt).`);
      }
    }
  }
  return issues;
}

// Sort object keys recursively at every nesting level. Plain
// JSON.stringify(obj, [...keys], 2) uses an array replacer as a property
// allowlist applied at *every* level, which empties nested objects when
// their keys aren't in the top-level list. canonicalStringify produces
// the stable canonical form needed for the diagnostic line diff.
function canonicalStringify(value, indent) {
  return JSON.stringify(canonicalize(value), null, indent);
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sorted = {};
    for (const key of Object.keys(value).sort()) {
      sorted[key] = canonicalize(value[key]);
    }
    return sorted;
  }
  return value;
}

function makeTempDir(prefix) {
  const candidates = [os.tmpdir(), '/tmp'];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return fs.mkdtempSync(path.join(candidate, prefix));
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function verifyGeneratedMetricsAreCurrent(options, metrics) {
  if (options.skipRegenerate) {
    return;
  }

  const generatorPath = path.join(options.root, 'scripts/generate-metrics.mjs');
  assert(fs.existsSync(generatorPath), `Missing ${rel(options.root, generatorPath)}. Cannot verify generated metrics are current.`);

  const tmpDir = makeTempDir('verify-metrics-');
  try {
    const generatedPath = path.join(tmpDir, 'metrics.json');
    const generated = spawnSync(
      process.execPath,
      [generatorPath, '--root', options.root, '--output', generatedPath],
      { cwd: options.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (generated.error) {
      throw generated.error;
    }
    if (generated.status !== 0) {
      throw new Error(generated.stderr || generated.stdout || `generate-metrics exited with code ${generated.status}`);
    }

    const regeneratedMetrics = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    const expectedNormalized = normalizeMetricsForComparison(regeneratedMetrics);
    const actualNormalized = normalizeMetricsForComparison(metrics);
    // Use deep structural equality so a manual reformat of metrics.json
    // (different key insertion order, equivalent whitespace) doesn't
    // trigger spurious staleness — JSON object key order isn't semantic.
    if (!isDeepStrictEqual(actualNormalized, expectedNormalized)) {
      // Diagnostic: print canonical-key-sorted line diff so the failure
      // surfaces which fields actually differ. canonicalStringify sorts
      // keys recursively at every nesting level — using a top-level
      // array replacer would silently empty nested objects (the replacer
      // is a property allowlist applied at every level).
      const expectedSorted = canonicalStringify(expectedNormalized, 2);
      const actualSorted = canonicalStringify(actualNormalized, 2);
      const expectedLines = expectedSorted.split('\n');
      const actualLines = actualSorted.split('\n');
      const diffLines = [];
      const maxLines = Math.max(expectedLines.length, actualLines.length);
      for (let i = 0; i < maxLines; i += 1) {
        if (expectedLines[i] !== actualLines[i]) {
          diffLines.push(`  line ${i + 1}:`);
          diffLines.push(`    committed:   ${actualLines[i] ?? '(missing)'}`);
          diffLines.push(`    regenerated: ${expectedLines[i] ?? '(missing)'}`);
          if (diffLines.length >= 30) {
            diffLines.push('  ... (truncated)');
            break;
          }
        }
      }
      console.error('metrics.json drift detected (structural fields only — loc.total_*, loc.total_files, tests.*, and coverage.* are excluded from the exact comparison):');
      console.error(diffLines.join('\n'));
      assert(false, `${options.metrics} is stale. Run npm run metrics:generate and npm run metrics:sync-tokens, then git add ${options.metrics}.`);
    }

    // CI-strict mode: tests.*/coverage.* are environment-sensitive, so they are
    // checked with a TOLERANCE (not the exact deep-equal above) against the
    // freshly-regenerated live values. Catches gross undercounting without
    // false-failing on the small jitter from env-gated test skips.
    if (options.includeTestCoverage) {
      const issues = checkTestCoverageTolerance(metrics, regeneratedMetrics);
      if (issues.length) {
        console.error('metrics.json tests/coverage drift beyond tolerance (committed vs live suite):');
        for (const i of issues) console.error(`  - ${i}`);
        assert(false, `${options.metrics} tests/coverage are stale. Run the suite, then npm run metrics:generate && npm run metrics:sync-tokens && git add ${options.metrics}.`);
      }
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  assert(fs.existsSync(metricsPath), `Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate first.`);

  // CI-strict mode is only meaningful once the suite has produced its inputs.
  // Without them the regen would emit missing-sentinels and false-fail against
  // the committed (populated) counts, so fail-closed with exit 2 (input error)
  // rather than a confusing drift "stale" failure.
  if (options.includeTestCoverage) {
    const summaryPath = path.resolve(options.root, 'test-summary.json');
    const coveragePath = path.resolve(options.root, 'coverage/coverage-summary.json');
    if (!fs.existsSync(summaryPath) || !fs.existsSync(coveragePath)) {
      console.error('FAIL: --include-test-coverage requires test-summary.json + coverage/coverage-summary.json at the repo root.');
      console.error('Run the suite first, e.g.: npm run test:coverage:ci -- --json --outputFile=test-summary.json');
      process.exit(2);
    }
  }

  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  assert(typeof metrics.generated_at === 'string', 'generated_at must be a string');
  assert(typeof metrics.git_sha === 'string' || metrics.git_sha === null, 'git_sha must be a string or null');
  requireNumber(metrics.dlp_patterns?.count, 'dlp_patterns.count');
  assert(metrics.dlp_patterns.count > 0, 'dlp_patterns.count must be positive');
  requireNumber(metrics.connectors?.production, 'connectors.production');
  requireNumber(metrics.connectors?.beta, 'connectors.beta');
  requireNumber(metrics.connectors?.demo_only, 'connectors.demo_only');
  requireNumber(metrics.connectors?.stub, 'connectors.stub');
  requireNumber(metrics.connectors?.unknown, 'connectors.unknown');
  assert(Array.isArray(metrics.connectors.items), 'connectors.items must be an array');
  requireNumber(metrics.loc?.production_ts, 'loc.production_ts');
  requireNumber(metrics.loc?.total_ts, 'loc.total_ts');
  requireNumber(metrics.loc?.total_md, 'loc.total_md');

  verifyGeneratedMetricsAreCurrent(options, metrics);

  const tokenCheck = spawnSync(
    process.execPath,
    [path.join(options.root, 'scripts/sync-metric-tokens.mjs'), '--root', options.root, '--metrics', options.metrics, '--check'],
    { cwd: options.root, encoding: 'utf8', stdio: 'inherit' },
  );
  if (tokenCheck.error) {
    throw tokenCheck.error;
  }
  if (tokenCheck.status !== 0) {
    process.exit(tokenCheck.status ?? 1);
  }

  console.log(`Metrics verified: ${rel(options.root, metricsPath)}`);
}

main();
