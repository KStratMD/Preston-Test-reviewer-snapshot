#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const TOKEN_PATTERN = /<!--\s*METRIC:([a-zA-Z0-9_.-]+)\s*-->([\s\S]*?)<!--\s*\/METRIC\s*-->/g;
const SKIP_DIRS = new Set(['.git', '.worktrees', 'coverage', 'dist', 'node_modules']);
// Git worktrees created under .claude/worktrees/ hold OTHER branches' copies of
// METRIC-token docs (EVALUATION.md, REVIEWER-GUIDE.md, …). Scanning them
// false-positives the staleness check against THIS tree's metrics.json. Skip by
// repo-relative path — basename 'worktrees' alone would be too generic to blanket-skip.
const SKIP_RELATIVE_DIRS = new Set(['.claude/worktrees']);

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    metrics: 'metrics.json',
    check: false,
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
      case '--check':
        options.check = true;
        break;
      case '--help':
        console.log('Usage: node scripts/sync-metric-tokens.mjs [--root <dir>] [--check] [--metrics metrics.json]');
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

function valueAtPath(source, keyPath) {
  const value = keyPath.split('.').reduce((current, part) => {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    return current[part];
  }, source);

  if (value === undefined) {
    throw new Error(`Metric token references missing key: ${keyPath}`);
  }
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
    return String(value);
  }
  return JSON.stringify(value);
}

function listMarkdownFiles(root) {
  /** @type {string[]} */
  const files = [];

  /** @param {string} current */
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        const full = path.join(current, entry.name);
        if (SKIP_DIRS.has(entry.name) || SKIP_RELATIVE_DIRS.has(rel(root, full))) {
          continue;
        }
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        files.push(path.join(current, entry.name));
      }
    }
  }

  walk(root);
  return files;
}

// PR-H (B1): maintain the runtime binding source public/js/exec-metrics.js
// from `.baseline-drift.json:current` — the canonical GRAND-TOTAL baseline
// (suites incl. integration/E2E). Deliberately NOT metrics.json:tests, which
// is the unit-profile-only count; binding exec surfaces to unit numbers is the
// exact unit-vs-grand-total confusion the 2026-07-17 audit-script fixes closed.
// Returns 'changed' | 'stale' | 'current' | 'skipped'.
function syncExecMetricsJs(root, options) {
  const baselinePath = path.join(root, '.baseline-drift.json');
  const execMetricsPath = path.join(root, 'public', 'js', 'exec-metrics.js');
  if (!fs.existsSync(baselinePath) || !fs.existsSync(execMetricsPath)) return 'skipped';

  const current = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).current;
  if (!current) return 'skipped';
  const wanted = {
    totalTests: current.total,
    passingTests: current.executedPassed,
    executedTests: current.executedPassed,
    skippedTests: current.skippedOverall,
    testSuites: current.totalSuites,
  };
  if (Object.values(wanted).some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    throw new Error('.baseline-drift.json:current is missing grand-total fields needed by exec-metrics.js');
  }

  const before = fs.readFileSync(execMetricsPath, 'utf8');
  const block =
    `  const METRICS = Object.freeze({\n` +
    `    totalTests: ${wanted.totalTests},\n` +
    `    passingTests: ${wanted.passingTests},\n` +
    `    executedTests: ${wanted.executedTests},\n` +
    `    skippedTests: ${wanted.skippedTests},\n` +
    `    testSuites: ${wanted.testSuites},\n` +
    `  });`;
  const pattern = /  const METRICS = Object\.freeze\(\{[\s\S]*?\}\);/;
  if (!pattern.test(before)) {
    throw new Error('exec-metrics.js METRICS block not found — the sync pattern needs updating');
  }
  const after = before.replace(pattern, block);
  if (after === before) return 'current';
  if (options.check) return 'stale';
  fs.writeFileSync(execMetricsPath, after);
  return 'changed';
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate first.`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

  const changed = [];
  const stale = [];

  const execMetricsResult = syncExecMetricsJs(options.root, options);
  if (execMetricsResult === 'changed') changed.push('public/js/exec-metrics.js');
  if (execMetricsResult === 'stale') stale.push('public/js/exec-metrics.js (METRICS block lags .baseline-drift.json:current)');

  for (const file of listMarkdownFiles(options.root)) {
    const before = fs.readFileSync(file, 'utf8');
    const after = before.replace(TOKEN_PATTERN, (_match, keyPath) => {
      const nextValue = valueAtPath(metrics, keyPath.trim());
      return `<!-- METRIC:${keyPath.trim()} -->${nextValue}<!-- /METRIC -->`;
    });

    if (after !== before) {
      if (options.check) {
        stale.push(rel(options.root, file));
      } else {
        fs.writeFileSync(file, after);
        changed.push(rel(options.root, file));
      }
    }
  }

  if (stale.length > 0) {
    console.error(`Metric tokens are stale in ${stale.length} file(s):`);
    for (const file of stale) {
      console.error(`  - ${file}`);
    }
    process.exit(1);
  }

  if (options.check) {
    console.log('Metric tokens are current.');
  } else if (changed.length > 0) {
    console.log(`Updated metric tokens in ${changed.length} file(s).`);
  } else {
    console.log('No metric tokens found or all tokens already current.');
  }
}

main();
