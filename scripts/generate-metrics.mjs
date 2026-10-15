#!/usr/bin/env node
// @ts-check

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import {
  extractStaticString,
  listConnectorFiles,
  readConnectorSourceFile,
} from './lib/connector-scan.mjs';
import { computeLocMetrics } from './lib/loc-metrics.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

import { CONNECTOR_STATUSES } from './lib/connectorStatuses.mjs';
const CONNECTOR_STATUS_VALUES = new Set(CONNECTOR_STATUSES);

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    output: 'metrics.json',
    coverage: 'coverage/coverage-summary.json',
    testSummary: 'test-summary.json',
    // Fail closed by default (PR #1195 follow-up). The old default silently
    // wrote `null` into loc.total_* whenever cloc could not run, so a bare
    // `npm run metrics:generate` on a cloc-less clone produced a degraded
    // metrics.json that looked like a successful regeneration. verify-metrics
    // now rejects that artifact after the fact; refusing to write it in the
    // first place is the cheaper failure. Opt out with --allow-missing-cloc.
    requireCloc: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case '--root':
        options.root = path.resolve(argv[++i]);
        break;
      case '--output':
        options.output = argv[++i];
        break;
      case '--coverage':
        options.coverage = argv[++i];
        break;
      case '--test-summary':
        options.testSummary = argv[++i];
        break;
      // Accepted and explicit, though it now restates the default: callers and
      // docs that spell it out stay correct, and package.json's
      // metrics:generate:authoring keeps documenting its own intent.
      case '--require-cloc':
        options.requireCloc = true;
        break;
      case '--allow-missing-cloc':
        options.requireCloc = false;
        break;
      case '--help':
        console.log(`Usage: node scripts/generate-metrics.mjs [--root <dir> (default: ${REPO_ROOT})] [--output <file> (default: metrics.json)] [--coverage <file> (default: coverage/coverage-summary.json)] [--test-summary <file> (default: test-summary.json)] [--require-cloc (default: fail when cloc is unavailable)] [--allow-missing-cloc (diagnostics only: preserve prior loc.total_ts when cloc is unavailable)]`);
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

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function previousLocTotalTs(root, outputPath) {
  const candidates = [outputPath, path.join(root, 'metrics.json')];
  for (const candidate of candidates) {
    const previous = readJsonIfExists(candidate);
    const totalTs = previous?.loc?.total_ts;
    if (typeof totalTs === 'number' && Number.isFinite(totalTs)) {
      return totalTs;
    }
  }
  return null;
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    const message = error?.stderr?.toString?.().trim() || error?.message || String(error);
    throw new Error(`${command} ${args.join(' ')} failed: ${message}`);
  }
}

function gitSha(root) {
  try {
    return run('git', ['rev-parse', 'HEAD'], root);
  } catch {
    return null;
  }
}

function createSourceFile(root, relativePath) {
  const absolutePath = path.join(root, relativePath);
  return ts.createSourceFile(relativePath, fs.readFileSync(absolutePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function countDlpPatterns(root) {
  const relativePath = 'src/services/security/DLPService.ts';
  const sourceFile = createSourceFile(root, relativePath);
  let count = null;
  let methodFound = false;

  /** @param {ts.Node} node */
  function visit(node) {
    if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'buildPatternRegistry'
    ) {
      methodFound = true;
      const returnStatement = node.body?.statements.find(ts.isReturnStatement);
      if (returnStatement?.expression && ts.isArrayLiteralExpression(returnStatement.expression)) {
        count = returnStatement.expression.elements.filter(ts.isObjectLiteralExpression).length;
      }
      return;
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  if (!methodFound || count === null) {
    throw new Error(`Could not find ${relativePath} buildPatternRegistry() return-array object literals`);
  }

  return {
    count,
    source: 'AST scan of DLPService.buildPatternRegistry() return-array object literals',
    runtime_endpoint: '/api/compliance/dlp-patterns (calls DLPService.getRegisteredPatterns())',
    implementation_file: `${relativePath}:181`,
  };
}

function listFiles(root, dir, predicate) {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) {
    return [];
  }

  /** @type {string[]} */
  const files = [];
  /** @param {string} current */
  function walk(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && predicate(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  walk(base);
  return files;
}

function connectorMetrics(root) {
  const files = listConnectorFiles(root);
  // Every value in CONNECTOR_STATUSES must start at 0 here, or `counts[status] += 1`
  // on a new status yields NaN and verify-metrics rejects the file.
  const counts = Object.fromEntries([...CONNECTOR_STATUSES, 'unknown'].map((s) => [s, 0]));
  const items = [];

  for (const file of files) {
    const relativePath = rel(root, file);
    const sourceFile = readConnectorSourceFile(file, relativePath);
    const productionStatus = extractStaticString(sourceFile, 'productionStatus');
    const status = productionStatus && CONNECTOR_STATUS_VALUES.has(productionStatus) ? productionStatus : 'unknown';
    counts[status] += 1;
    items.push({
      file: relativePath,
      name: path.basename(relativePath, '.ts'),
      productionStatus: status,
      statusEvidence: extractStaticString(sourceFile, 'statusEvidence'),
      proofCard: extractStaticString(sourceFile, 'proofCard'),
    });
  }

  items.sort((a, b) => a.file.localeCompare(b.file));
  return {
    ...counts,
    source: 'AST scan of static productionStatus fields in src/connectors/*Connector.ts (and the *ConnectorProd.ts naming exception, e.g. SuiteCentralConnectorProd.ts); unknown means Phase 3 tags have not landed yet',
    items,
  };
}

function coverageMetrics(root, coverageRelativePath) {
  const coveragePath = path.resolve(root, coverageRelativePath);
  const summary = readJsonIfExists(coveragePath);
  if (!summary?.total) {
    return {
      source: rel(root, coveragePath),
      status: 'missing',
      note: 'Run jest --config=jest.ci.config.cjs --coverage after json-summary reporter is available.',
    };
  }

  const total = summary.total;
  return {
    source: rel(root, coveragePath),
    lines: total.lines?.pct ?? null,
    branches: total.branches?.pct ?? null,
    functions: total.functions?.pct ?? null,
    statements: total.statements?.pct ?? null,
  };
}

function testsMetrics(root, summaryRelativePath) {
  const summaryPath = path.resolve(root, summaryRelativePath);
  const summary = readJsonIfExists(summaryPath);
  if (!summary) {
    return {
      source: rel(root, summaryPath),
      status: 'missing',
      note: 'Run jest with --json --outputFile=test-summary.json to populate pass/fail/skip counts.',
    };
  }

  return {
    source: rel(root, summaryPath),
    passing: summary.numPassedTests ?? null,
    failed: summary.numFailedTests ?? null,
    skipped: summary.numPendingTests ?? null,
    suites: summary.numTotalTestSuites ?? null,
    total: summary.numTotalTests ?? null,
  };
}

function globToRegex(pattern) {
  const segments = pattern.split('/');
  let regex = '^';

  segments.forEach((segment, index) => {
    if (segment === '**') {
      regex += index === segments.length - 1 ? '.*' : '(?:.*/)?';
      return;
    }

    if (index > 0 && segments[index - 1] !== '**') {
      regex += '/';
    }

    regex += [...segment].map((char) => {
      if (char === '*') return '[^/]*';
      if (char === '?') return '[^/]';
      return char.replace(/[|\\{}()[\]^$+.]/g, '\\$&');
    }).join('');
  });

  return new RegExp(`${regex}$`);
}

function matchesCollectCoverage(relativePath, patterns) {
  let included = false;
  for (const pattern of patterns) {
    const excluded = pattern.startsWith('!');
    const raw = excluded ? pattern.slice(1) : pattern;
    if (globToRegex(raw).test(relativePath)) {
      included = !excluded;
    }
  }
  return included;
}

function readJestCoveragePatterns(root) {
  const configPath = path.join(root, 'jest.ci.config.cjs');
  const config = require(configPath);
  return Array.isArray(config.collectCoverageFrom) ? config.collectCoverageFrom : ['src/**/*.ts'];
}

function productionTsLoc(root) {
  const patterns = readJestCoveragePatterns(root);
  const files = listFiles(root, 'src', (filePath) => filePath.endsWith('.ts') && !filePath.endsWith('.d.ts'));
  let loc = 0;
  for (const file of files) {
    const relativePath = rel(root, file);
    if (matchesCollectCoverage(relativePath, patterns)) {
      const text = fs.readFileSync(file, 'utf8');
      loc += text.split(/\r?\n/).filter((line) => line.trim() !== '').length;
    }
  }
  return loc;
}

// M1 Phase A: AI accuracy benchmark. `latest` mirrors `accuracy_top1` from
// the committed `docs/review/ai-accuracy-benchmark.json` (raw 0..1 fraction
// for downstream consumers); `latest_pct` is the percent-formatted string
// the README templates substitute via `<!-- METRIC:ai_accuracy.latest_pct -->`.
// Both resolve to the same underlying measurement; the README chooses the
// percent variant so the rendered prose is human-readable. Operator
// workflow: run `npm run benchmark:ai`, then `npm run metrics:generate:authoring` +
// `npm run metrics:sync-tokens`.
function aiAccuracyMetrics(root) {
  const benchmarkPath = path.join(root, 'docs/review/ai-accuracy-benchmark.json');
  const summary = readJsonIfExists(benchmarkPath);
  if (!summary) {
    // Sentinel MUST include `latest_pct` because README templates substitute
    // `<!-- METRIC:ai_accuracy.latest_pct -->` and `sync-metric-tokens.mjs`
    // throws on missing keys. Surface the missing-file state as a readable
    // string (e.g. "unknown — benchmark not yet run") rather than letting
    // the token-sub failure block ops. Per Copilot review on PR #837.
    return {
      latest: null,
      latest_pct: 'unknown',
      source: 'docs/review/ai-accuracy-benchmark.json',
      status: 'missing',
      note: 'Run npm run benchmark:ai (use --dry-run for a $0 deterministic oracle run).',
    };
  }
  if (typeof summary.accuracy_top1 !== 'number') {
    throw new Error('docs/review/ai-accuracy-benchmark.json missing numeric accuracy_top1 field');
  }
  // `latest` is the raw fraction (0..1) for consumers that want the number.
  // `latest_pct` is the display string the README templates substitute —
  // pre-formatted to keep README prose self-readable.
  const latest = summary.accuracy_top1;
  return {
    latest,
    latest_pct: `${(latest * 100).toFixed(1)}%`,
    run_mode: typeof summary.run_mode === 'string' ? summary.run_mode : null,
    provider: typeof summary.provider === 'string' ? summary.provider : null,
    model: typeof summary.model === 'string' ? summary.model : null,
    fixture_mappings: typeof summary.fixture_mappings === 'number' ? summary.fixture_mappings : null,
    hallucination_count: typeof summary.hallucination_count === 'number' ? summary.hallucination_count : null,
    source: 'docs/review/ai-accuracy-benchmark.json',
  };
}

function moduleMetrics(root) {
  const registryPath = path.join(root, 'src/modules/registry.ts');
  if (!fs.existsSync(registryPath)) {
    return {
      count: null,
      source: 'src/modules/registry.ts',
      status: 'missing',
      note: 'Phase 8 module registry has not landed yet.',
    };
  }

  const source = fs.readFileSync(registryPath, 'utf8');
  const matches = source.match(/\bid\s*:/g) ?? [];
  return {
    count: matches.length,
    source: 'src/modules/registry.ts',
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const root = options.root;
  const outputPath = path.resolve(root, options.output);
  const loc = computeLocMetrics(root, { requireCloc: options.requireCloc });
  const priorTotalTs = !options.requireCloc && loc.total_ts === null ? previousLocTotalTs(root, outputPath) : null;
  const totalTs = loc.total_ts ?? priorTotalTs;
  if (priorTotalTs !== null) {
    console.warn(`[loc-metrics] cloc unavailable; preserving prior loc.total_ts=${priorTotalTs} for diagnostics-only output.`);
  }

  const metrics = {
    generated_at: new Date().toISOString(),
    git_sha: gitSha(root),
    ai_accuracy: aiAccuracyMetrics(root),
    dlp_patterns: countDlpPatterns(root),
    connectors: connectorMetrics(root),
    modules: moduleMetrics(root),
    tests: testsMetrics(root, options.testSummary),
    coverage: coverageMetrics(root, options.coverage),
    // Repo-census fields (total_md, total_files) are deliberately NOT emitted:
    // they move on every documentation edit, which made metrics.json a merge
    // conflict magnet (PR #1186 -> PR #1188) while proving nothing about the
    // product. computeLocMetrics still returns them for callers that want a
    // census; only the committed contract is narrowed.
    // See docs/superpowers/specs/2026-08-21-ci-efficiency-consensus-design.md
    loc: {
      production_ts: productionTsLoc(root),
      total_ts: totalTs,
      source: loc.source,
    },
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(`Wrote ${rel(root, outputPath)}`);
}

const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
