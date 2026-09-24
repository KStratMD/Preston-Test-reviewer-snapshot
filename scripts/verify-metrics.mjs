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
    allowMissingCloc: false,
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
      // (still excluding generated_at and git_sha). Only valid
      // AFTER the suite has produced test-summary.json + coverage-summary.json
      // (e.g. ci-minimal.yml right after test:coverage:ci); the reviewer-mirror
      // path runs verify-metrics WITHOUT this flag because it doesn't run the
      // suite. Closes the "committed metrics undercount" gap a reviewer reads.
      case '--include-test-coverage':
        options.includeTestCoverage = true;
        break;
      // Diagnostics-only opt-out of the fail-closed cloc requirement. Restores
      // the old behaviour — cloc-derived LOC fields are unavailable and are
      // either preserved from the prior artifact or omitted from comparison —
      // but the verdict says REDUCED instead of reporting a clean pass. Must
      // never be used by a required gate
      // (ci-minimal.yml, .husky/pre-push, or a package script they invoke):
      // that combination is exactly what let a stale metrics.json survive nine
      // consecutive pushes on PR #1183.
      case '--allow-missing-cloc':
        options.allowMissingCloc = true;
        break;
      case '--help':
        console.log('Usage: node scripts/verify-metrics.mjs [--root <dir>] [--metrics metrics.json] [--skip-regenerate] [--include-test-coverage] [--allow-missing-cloc (diagnostics only: preserve prior LOC or omit unavailable fields; reports a REDUCED verdict)]');
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

function normalizeMetricsForComparison(metrics, ignoredLocFields = []) {
  const normalized = structuredClone(metrics);
  delete normalized.generated_at;
  delete normalized.git_sha;
  // Git-manifest LOC totals are deterministic when cloc is available.
  // Optional regeneration may return null when cloc is absent; only those
  // unavailable fields are omitted by the caller.
  if (normalized.loc && typeof normalized.loc === 'object') {
    for (const key of ignoredLocFields) {
      delete normalized.loc[key];
    }
  }
  // tests.* counts are environmental: they only populate when
  // test-summary.json exists (jest --json --outputFile). reviewer-mirror.yml
  // runs verify-metrics without running the suite, so its regen produces
  // a {status: "missing"} sentinel. Committed metrics.json carries
  // populated counts from the PR-author's local run (or CI, when the
  // suite ran before metrics generation). The README badge sourcing from
  // metrics.json:tests.passing is informational, not an exact CI gate, so
  // the environment-sensitive tests block remains excluded and
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
    issues.push('tests block missing/unpopulated in committed metrics.json (run metrics:generate:authoring after the suite).');
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
    issues.push('coverage block missing/unpopulated in committed metrics.json (run metrics:generate:authoring after the suite).');
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

/**
 * @returns {string[]} cloc-derived `loc.*` fields that could not be compared.
 *   Always empty unless --allow-missing-cloc was passed, because the generator
 *   otherwise runs fail-closed and a missing cloc aborts before the compare.
 */
function verifyGeneratedMetricsAreCurrent(options, metrics) {
  if (options.skipRegenerate) {
    return [];
  }

  const generatorPath = path.join(options.root, 'scripts/generate-metrics.mjs');
  assert(fs.existsSync(generatorPath), `Missing ${rel(options.root, generatorPath)}. Cannot verify generated metrics are current.`);

  const tmpDir = makeTempDir('verify-metrics-');
  try {
    const generatedPath = path.join(tmpDir, 'metrics.json');
    const generated = spawnSync(
      process.execPath,
      // Fail closed: if the generator cannot recompute cloc-derived LOC fields,
      // the reduced compare below drops exactly those fields and the run still reports
      // success — a gate that cannot go red over a stale artifact. The
      // generator is fail-closed by default, so --require-cloc restates that
      // default; it is passed explicitly so this call site does not silently
      // change meaning if that default ever moves again. The degraded path must
      // be requested explicitly rather than inherited from a default: passing
      // no flag here would fail closed too, which would break --allow-missing-cloc.
      [generatorPath, '--root', options.root, '--output', generatedPath, ...(options.allowMissingCloc ? ['--allow-missing-cloc'] : ['--require-cloc'])],
      { cwd: options.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    if (generated.error) {
      throw generated.error;
    }
    if (generated.status !== 0) {
      const detail = generated.stderr || generated.stdout || `generate-metrics exited with code ${generated.status}`;
      if (!options.allowMissingCloc && /cloc required but unavailable/.test(detail)) {
        console.error('metrics.json freshness CANNOT be verified: cloc could not be run, so loc.total_ts cannot be compared.');
        console.error('Install cloc (npm i -g cloc; Windows also needs a perl — Git for Windows ships one) and re-run.');
        console.error('To inspect the other fields anyway, re-run with --allow-missing-cloc; that reports a REDUCED verdict and must not be used by a required gate.');
      }
      throw new Error(detail);
    }

    const regeneratedMetrics = JSON.parse(fs.readFileSync(generatedPath, 'utf8'));
    const locTotalFields = ['total_ts'];
    const preservedLocFields = options.allowMissingCloc && /preserving prior loc\.total_ts=/.test(generated.stderr)
      ? locTotalFields
      : [];
    const ignoredLocFields = [...new Set([
      ...locTotalFields.filter((key) => regeneratedMetrics.loc?.[key] === null),
      ...preservedLocFields,
    ])];
    const expectedNormalized = normalizeMetricsForComparison(regeneratedMetrics, ignoredLocFields);
    const actualNormalized = normalizeMetricsForComparison(metrics, ignoredLocFields);
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
      const optionalLocNote = ignoredLocFields.length
        ? `; unavailable or preserved optional LOC fields excluded: ${ignoredLocFields.join(', ')}`
        : '';
      console.error(`metrics.json drift detected (deterministic fields compared exactly; generated_at, git_sha, tests.*, and coverage.* excluded${optionalLocNote}):`);
      console.error(diffLines.join('\n'));
      assert(false, `${options.metrics} is stale. Run npm run metrics:generate:authoring and npm run metrics:sync-tokens, then git add ${options.metrics}.`);
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
        assert(false, `${options.metrics} tests/coverage are stale. Run the suite, then npm run metrics:generate:authoring && npm run metrics:sync-tokens && git add ${options.metrics}.`);
      }
    }

    return ignoredLocFields;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  assert(fs.existsSync(metricsPath), `Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate:authoring first.`);

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
  requireNumber(metrics.connectors?.production_ready, 'connectors.production_ready');
  requireNumber(metrics.connectors?.beta, 'connectors.beta');
  requireNumber(metrics.connectors?.demo_only, 'connectors.demo_only');
  requireNumber(metrics.connectors?.stub, 'connectors.stub');
  requireNumber(metrics.connectors?.unknown, 'connectors.unknown');
  assert(Array.isArray(metrics.connectors.items), 'connectors.items must be an array');
  requireNumber(metrics.loc?.production_ts, 'loc.production_ts');
  requireNumber(metrics.loc?.total_ts, 'loc.total_ts');

  const reducedLocFields = verifyGeneratedMetricsAreCurrent(options, metrics);

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

  // The verdict must state its own coverage. Printing an unqualified
  // "Metrics verified" after silently dropping fields from the comparison is
  // the defect this gate exists to prevent, so a reduced run says so.
  if (reducedLocFields.length) {
    console.log(`Metrics verified (REDUCED — NOT a freshness guarantee): ${rel(options.root, metricsPath)}`);
    console.log(`  cloc could not be run, so these fields were NOT compared: ${reducedLocFields.join(', ')}`);
    return;
  }
  console.log(`Metrics verified: ${rel(options.root, metricsPath)}`);
}

main();
