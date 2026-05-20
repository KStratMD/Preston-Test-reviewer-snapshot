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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);

const CONNECTOR_STATUS_VALUES = new Set(['production', 'beta', 'demo_only', 'stub']);

function parseArgs(argv) {
  const options = {
    root: REPO_ROOT,
    output: 'metrics.json',
    coverage: 'coverage/coverage-summary.json',
    testSummary: 'test-summary.json',
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
      case '--help':
        console.log(`Usage: node scripts/generate-metrics.mjs [--root <dir> (default: ${REPO_ROOT})] [--output <file> (default: metrics.json)] [--coverage <file> (default: coverage/coverage-summary.json)] [--test-summary <file> (default: test-summary.json)]`);
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
  const counts = { production: 0, beta: 0, demo_only: 0, stub: 0, unknown: 0 };
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

function clocMetrics(root) {
  const json = JSON.parse(run('cloc', ['.', '--json', '--exclude-dir=node_modules,.git,coverage,dist,.worktrees'], root));
  return {
    total_ts: json.TypeScript?.code ?? 0,
    total_md: json.Markdown?.code ?? 0,
    total_files: json.SUM?.nFiles ?? 0,
    source: 'cloc . --json --exclude-dir=node_modules,.git,coverage,dist,.worktrees',
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
  const loc = clocMetrics(root);

  const metrics = {
    generated_at: new Date().toISOString(),
    git_sha: gitSha(root),
    dlp_patterns: countDlpPatterns(root),
    connectors: connectorMetrics(root),
    modules: moduleMetrics(root),
    tests: testsMetrics(root, options.testSummary),
    coverage: coverageMetrics(root, options.coverage),
    loc: {
      production_ts: productionTsLoc(root),
      total_ts: loc.total_ts,
      total_md: loc.total_md,
      total_files: loc.total_files,
      source: loc.source,
    },
  };

  fs.writeFileSync(outputPath, `${JSON.stringify(metrics, null, 2)}\n`);
  console.log(`Wrote ${rel(root, outputPath)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
