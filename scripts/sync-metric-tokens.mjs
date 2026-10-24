#!/usr/bin/env node
// @ts-check

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
// #1190: the value group must never match a newline. The previous lazy
// any-character form did, which let an unclosed opener in prose pair with a
// closer thousands of lines below — and because the write path replaces the
// ENTIRE matched span, a run that exited 0 silently deleted everything between
// them. Every real token span in the repo is written on a single line (16 of 16
// at 8e4b655592), so requiring that makes the destructive match structurally
// impossible rather than merely unlikely.
const TOKEN_PATTERN = /<!--\s*METRIC:([a-zA-Z0-9_.-]+)\s*-->([^\n]*?)<!--\s*\/METRIC\s*-->/g;
// Bare opener, used to find openers TOKEN_PATTERN can no longer consume.
const OPENER_PATTERN = /<!--\s*METRIC:([a-zA-Z0-9_.-]+)\s*-->/g;
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
  // #1119: a metric token is a factual claim in a reviewer-facing document, and
  // null is not a claim it may assert. Rendering it produced lines like
  // "Total TypeScript LOC: null" in EVALUATION.md whenever regeneration could
  // not run cloc — a silent near-miss no downstream gate rejected at the time,
  // because verify-metrics then dropped an uncomputable loc total out of its
  // drift comparison and still reported success. That fallback is gone: PR
  // #1195 made verify-metrics fail closed when cloc cannot run, and the
  // generator now refuses to write null LOC unless asked with
  // --allow-missing-cloc. This check is the last of the three, and stays: it is
  // the only one on the render path, so it still fails closed on a null reached
  // any other way. Fail closed instead.
  if (value === null) {
    throw new Error(`Metric token '${keyPath}' resolved to null; refusing to render the literal string \"null\"`);
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
// Plans, never writes: returns { status: 'skipped' | 'current' | 'stale', path?, contents? }
// so main() can buffer the bytes and commit them only if the whole run validates.
function planExecMetricsJs(root) {
  const baselinePath = path.join(root, '.baseline-drift.json');
  const execMetricsPath = path.join(root, 'public', 'js', 'exec-metrics.js');
  if (!fs.existsSync(baselinePath) || !fs.existsSync(execMetricsPath)) return { status: 'skipped' };

  const current = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).current;
  if (!current) return { status: 'skipped' };
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
  if (after === before) return { status: 'current' };
  return { status: 'stale', path: execMetricsPath, contents: after };
}

// #1190: an opener that TOKEN_PATTERN cannot consume is, by construction, an
// opener with no closer on its own line. Before the same-line rule it was
// dormant rather than harmless: the first closer added anywhere below it armed
// the destructive match. Report it with file:line and its own wording so
// `--check` distinguishes "this number needs updating" from "this file is one
// sync away from losing its content" — the two were the same message before.
function findUnclosedOpeners(text) {
  /** @type {{ line: number, key: string }[]} */
  const found = [];
  text.split(/\r?\n/).forEach((line, index) => {
    TOKEN_PATTERN.lastIndex = 0;
    const withoutCompleteSpans = line.replace(TOKEN_PATTERN, '');
    OPENER_PATTERN.lastIndex = 0;
    let match;
    while ((match = OPENER_PATTERN.exec(withoutCompleteSpans)) !== null) {
      found.push({ line: index + 1, key: match[1] });
    }
  });
  return found;
}

// Plan a markdown file without touching it. Returns either the errors that
// disqualify the whole run or the exact bytes the write phase would commit.
function planMarkdownFile(file, root, metrics) {
  const relPath = rel(root, file);
  const before = fs.readFileSync(file, 'utf8');

  const unclosed = findUnclosedOpeners(before);
  if (unclosed.length > 0) {
    return {
      errors: unclosed.map(
        ({ line, key }) =>
          `${relPath}:${line}: unclosed METRIC token opener for '${key}' — an opener and its <!-- /METRIC --> closer must be on the same line`,
      ),
    };
  }

  /** @type {string[]} */
  const errors = [];
  TOKEN_PATTERN.lastIndex = 0;
  const after = before.replace(TOKEN_PATTERN, (match, rawKey) => {
    const keyPath = rawKey.trim();
    try {
      return `<!-- METRIC:${keyPath} -->${valueAtPath(metrics, keyPath)}<!-- /METRIC -->`;
    } catch (error) {
      errors.push(`${relPath}: ${error instanceof Error ? error.message : String(error)}`);
      return match;
    }
  });

  if (errors.length > 0) return { errors };
  return { errors: [], path: file, relPath, changed: after !== before, contents: after };
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const metricsPath = path.resolve(options.root, options.metrics);
  if (!fs.existsSync(metricsPath)) {
    throw new Error(`Missing ${rel(options.root, metricsPath)}. Run npm run metrics:generate:authoring first.`);
  }
  const metrics = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));

  // Two phases, deliberately. Everything is validated and the exact output bytes
  // are buffered before a single file is touched, so a failure in the last file
  // scanned cannot leave the first one rewritten. The previous shape wrote
  // exec-metrics.js and then each markdown file inside the scan loop, which made
  // a partially-updated tree the normal outcome of any mid-run error.
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const stale = [];
  /** @type {{ path: string, relPath: string, contents: string }[]} */
  const pendingWrites = [];

  const execMetricsPlan = planExecMetricsJs(options.root);
  if (execMetricsPlan.status === 'stale') {
    stale.push('public/js/exec-metrics.js (METRICS block lags .baseline-drift.json:current)');
    pendingWrites.push({
      path: execMetricsPlan.path,
      relPath: 'public/js/exec-metrics.js',
      contents: execMetricsPlan.contents,
    });
  }

  for (const file of listMarkdownFiles(options.root)) {
    const plan = planMarkdownFile(file, options.root, metrics);
    if (plan.errors.length > 0) {
      errors.push(...plan.errors);
      continue;
    }
    if (plan.changed) {
      stale.push(plan.relPath);
      pendingWrites.push({ path: plan.path, relPath: plan.relPath, contents: plan.contents });
    }
  }

  // Validation failures are not staleness. They exit nonzero in BOTH modes and
  // never write, because the thing that makes them dangerous is precisely that
  // the old code treated them as ordinary work and completed successfully.
  if (errors.length > 0) {
    console.error(`Metric token validation failed in ${errors.length} place(s):`);
    for (const message of errors) {
      console.error(`  - ${message}`);
    }
    console.error('No files were written.');
    process.exit(1);
  }

  if (options.check) {
    if (stale.length > 0) {
      console.error(`Metric tokens are stale in ${stale.length} file(s):`);
      for (const file of stale) {
        console.error(`  - ${file}`);
      }
      process.exit(1);
    }
    console.log('Metric tokens are current.');
    return;
  }

  for (const write of pendingWrites) {
    fs.writeFileSync(write.path, write.contents);
  }

  if (pendingWrites.length > 0) {
    console.log(`Updated metric tokens in ${pendingWrites.length} file(s).`);
  } else {
    console.log('No metric tokens found or all tokens already current.');
  }
}
main();
