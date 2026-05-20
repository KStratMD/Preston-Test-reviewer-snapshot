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
      case '--help':
        console.log('Usage: node scripts/verify-metrics.mjs [--root <dir>] [--metrics metrics.json] [--skip-regenerate]');
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
  delete normalized.coverage;
  return normalized;
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
      console.error('metrics.json drift detected (structural fields only — loc.total_*, loc.total_files, tests.*, and coverage.* are excluded from comparison):');
      console.error(diffLines.join('\n'));
      assert(false, `${options.metrics} is stale. Run npm run metrics:generate and npm run metrics:sync-tokens.`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  assert(fs.existsSync(metricsPath), `Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate first.`);

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
